//! ============================================================================
//! PURPOSE:
//!   Implements `ArchiveImporter` for streaming extraction, cryptographic
//!   SHA-256 integrity verification, collision handling (`FAIL_IF_EXISTS`), and
//!   referential UUID remapping (`remap_ids: true`) of portable `.trame`
//!   PKWARE ZIP campaign archives.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Entry 0 MUST be `manifest.json`; missing or displaced manifests fail
//!     immediately with `ArchiveError::InvalidManifest`.
//!   - Every archive entry outside `manifest.json` MUST be declared in
//!     `manifest.entries` with a matching byte size and lowercase hex SHA-256
//!     digest; unlisted entries fail with `ArchiveError::UnlistedEntry` and
//!     corrupted entries fail with `ArchiveError::ChecksumMismatch`.
//!   - Archive paths containing `..`, `\`, or leading `/` are rejected to
//!     prevent Zip Slip path traversal.
//!   - Asset entries (`assets/<uuid>.webp`) stream in bounded 64 KiB chunks to
//!     `BlobStore::put_stream` so memory stays strictly below the 16 MiB RAM
//!     ceiling; partial uploads are rolled back on any subsequent error.
//!   - Zip-bomb caps: at most `MAX_ARCHIVE_ENTRIES` entries, a 4 MiB manifest,
//!     declared entry sizes within `MAX_TEXT_ENTRY_BYTES` (32 MiB, buffered) or
//!     `MAX_ASSET_ENTRY_BYTES` (64 MiB, streamed), and a declared total within
//!     `MAX_TOTAL_UNCOMPRESSED_BYTES` (512 MiB). Each read loop aborts with
//!     `ArchiveError::LimitExceeded` the moment an entry decompresses past its
//!     declared size, so the caps bound real bytes rather than zip headers.
//!   - Every persisted entity, note, and asset is attributed to the imported
//!     campaign ID (`CampaignImportTarget` takes an explicit `campaign_id`).
//!   - `stored-assets/<stem>.webp` entries (content-addressed `AssetStore` blobs, see
//!     `stored_assets`) must have a valid stem and WebP magic bytes. With an asset store
//!     configured they are re-stored under the new campaign and every key referencing the
//!     source campaign is rewritten; referenced keys without an embedded blob do not fail
//!     the import but are listed in `ImportResult::missing_asset_keys`.
//!   - `owner_user_id` entity fields are user IDs and are never remapped.
//!
//! EXECUTION LIFECYCLE:
//!   1. Validate entry 0 (`manifest.json`), parse `CampaignManifest`, and check
//!      `FAIL_IF_EXISTS` against `CampaignImportTarget::campaign_exists`.
//!   2. Verify all archive entries against `manifest.entries`, rejecting any
//!      unlisted or missing entry before mutating persistent state.
//!   3. Stream and verify `database.jsonl` and `notes/<uuid>.md`, optionally
//!      remapping all entity/note/asset UUIDs and rewriting `[[<uuid>]]` /
//!      `[[<uuid>|<label>]]` wikilinks.
//!   4. Rewrite content-addressed asset keys and collect missing ones.
//!   5. Stream and verify each `assets/<uuid>.webp` entry into `BlobStore`, put the
//!      `stored-assets/` blobs into the `AssetStore`, then persist the campaign
//!      metadata, entities, and notes.
//! ============================================================================

use super::exporter::{ExportEntity, NoteRecord};
use super::manifest::{CampaignManifest, CampaignMetadata};
use super::stored_assets::{self, STORED_ASSET_PREFIX, is_valid_stem, is_webp};
use crate::assets::store::AssetStore;
use crate::storage::blob::{BlobStore, BlobStoreError, CHUNK_SIZE, Sha256Hasher};
use async_zip::tokio::read::seek::ZipFileReader;
use bytes::Bytes;
use futures_lite::io::AsyncReadExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncBufRead, AsyncSeek};
use uuid::Uuid;

/// Error returned during campaign archive import operations.
#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
    #[error("checksum mismatch for entry '{path}': expected {expected}, actual {actual}")]
    ChecksumMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("unlisted entry in archive: {0}")]
    UnlistedEntry(String),
    #[error("campaign already exists: {0}")]
    CampaignAlreadyExists(Uuid),
    #[error("storage error: {0}")]
    Storage(#[from] BlobStoreError),
    #[error("zip extraction error: {0}")]
    Zip(#[from] async_zip::error::ZipError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("archive limit exceeded: {0}")]
    LimitExceeded(String),
}

/// Entity field carrying the owning user of an actor. User IDs belong to the instance, not
/// the campaign, so this field is exempt from UUID remapping.
pub const OWNER_USER_ID_FIELD: &str = "owner_user_id";

/// Maximum number of entries (including `manifest.json`) accepted in one archive.
pub const MAX_ARCHIVE_ENTRIES: usize = 5_000;

/// Maximum uncompressed size of `manifest.json` in bytes (4 MiB).
pub const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

/// Maximum uncompressed size of a buffered text entry (`database.jsonl`, `notes/*.md`) in
/// bytes (32 MiB); these entries are parsed in memory.
pub const MAX_TEXT_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

/// Maximum uncompressed size of a streamed asset entry in bytes (64 MiB).
pub const MAX_ASSET_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum total uncompressed bytes across all entries of one archive (512 MiB).
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

fn entry_byte_cap(path: &str) -> u64 {
    if path.starts_with("assets/") {
        MAX_ASSET_ENTRY_BYTES
    } else {
        MAX_TEXT_ENTRY_BYTES
    }
}

fn lock_poisoned() -> ArchiveError {
    ArchiveError::Io(std::io::Error::other("lock poisoned"))
}

/// Resulting counts and campaign metadata returned upon successful archive import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportResult {
    pub campaign_id: Uuid,
    pub name: String,
    pub actors_restored: usize,
    pub scenes_restored: usize,
    pub notes_restored: usize,
    pub assets_restored: usize,
    /// Source asset keys referenced by the archive whose blob was not embedded (deleted
    /// before export). Their references are still rewritten to the new campaign, where they
    /// resolve to "not found" exactly as they did at the source.
    #[serde(default)]
    pub missing_asset_keys: Vec<String>,
}

/// Options configuring archive extraction and collision handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportOptions {
    pub remap_ids: bool,
}

/// Database persistence target for imported campaign data. Every write is scoped to an
/// explicit `campaign_id` so exports can later filter strictly by campaign.
pub trait CampaignImportTarget: Send + Sync + 'static {
    async fn campaign_exists(&self, id: Uuid) -> Result<bool, ArchiveError>;
    async fn save_campaign(&self, campaign: &CampaignMetadata) -> Result<(), ArchiveError>;
    async fn save_entities(
        &self,
        campaign_id: Uuid,
        entities: &[ExportEntity],
    ) -> Result<(), ArchiveError>;
    async fn save_notes(&self, campaign_id: Uuid, notes: &[NoteRecord])
    -> Result<(), ArchiveError>;
    /// Records that `asset_ids` belong to `campaign_id` (no-op for stores that key assets
    /// by campaign elsewhere).
    async fn save_asset_ids(
        &self,
        _campaign_id: Uuid,
        _asset_ids: &[Uuid],
    ) -> Result<(), ArchiveError> {
        Ok(())
    }
}

/// Thread-safe in-memory campaign store suitable for testing and single-instance runtimes.
#[derive(Debug, Default, Clone)]
pub struct InMemoryCampaignStore {
    pub campaigns: Arc<RwLock<HashMap<Uuid, CampaignMetadata>>>,
    /// Entities; every non-`campaign` entity carries a `data.campaign_id` set on save.
    pub entities: Arc<RwLock<Vec<ExportEntity>>>,
    pub notes: Arc<RwLock<Vec<NoteRecord>>>,
    /// Owning campaign of each note, keyed by note ID.
    pub note_campaigns: Arc<RwLock<HashMap<Uuid, Uuid>>>,
    /// Owning campaign of each blob asset, keyed by asset ID.
    pub asset_campaigns: Arc<RwLock<HashMap<Uuid, Uuid>>>,
}

impl InMemoryCampaignStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_campaign(campaign: CampaignMetadata) -> Self {
        let store = Self::new();
        if let Ok(mut guard) = store.campaigns.write() {
            guard.insert(campaign.id, campaign);
        }
        store
    }

    pub fn get_campaign(&self, id: &Uuid) -> Option<CampaignMetadata> {
        self.campaigns.read().ok()?.get(id).cloned()
    }

    pub fn all_campaigns(&self) -> Vec<CampaignMetadata> {
        self.campaigns
            .read()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn all_entities(&self) -> Vec<ExportEntity> {
        self.entities.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn all_notes(&self) -> Vec<NoteRecord> {
        self.notes.read().map(|g| g.clone()).unwrap_or_default()
    }

    /// Entities whose `data.campaign_id` (or, for the `campaign` entity, `data.id`) equals
    /// `campaign_id`.
    pub fn entities_for_campaign(&self, campaign_id: Uuid) -> Vec<ExportEntity> {
        let cid = campaign_id.to_string();
        self.all_entities()
            .into_iter()
            .filter(|e| {
                let key = if e.entity_type == "campaign" {
                    "id"
                } else {
                    "campaign_id"
                };
                e.data.get(key).and_then(|v| v.as_str()) == Some(cid.as_str())
            })
            .collect()
    }

    /// Notes registered to `campaign_id`.
    pub fn notes_for_campaign(&self, campaign_id: Uuid) -> Vec<NoteRecord> {
        let Ok(owners) = self.note_campaigns.read() else {
            return Vec::new();
        };
        self.all_notes()
            .into_iter()
            .filter(|n| owners.get(&n.id) == Some(&campaign_id))
            .collect()
    }

    /// Blob asset IDs registered to `campaign_id`, sorted for deterministic exports.
    pub fn asset_ids_for_campaign(&self, campaign_id: Uuid) -> Vec<Uuid> {
        let mut ids: Vec<Uuid> = self
            .asset_campaigns
            .read()
            .map(|g| {
                g.iter()
                    .filter(|(_, owner)| **owner == campaign_id)
                    .map(|(id, _)| *id)
                    .collect()
            })
            .unwrap_or_default();
        ids.sort();
        ids
    }
}

impl CampaignImportTarget for InMemoryCampaignStore {
    async fn campaign_exists(&self, id: Uuid) -> Result<bool, ArchiveError> {
        let guard = self.campaigns.read().map_err(|_| lock_poisoned())?;
        Ok(guard.contains_key(&id))
    }

    async fn save_campaign(&self, campaign: &CampaignMetadata) -> Result<(), ArchiveError> {
        let mut guard = self.campaigns.write().map_err(|_| lock_poisoned())?;
        guard.insert(campaign.id, campaign.clone());
        Ok(())
    }

    async fn save_entities(
        &self,
        campaign_id: Uuid,
        entities: &[ExportEntity],
    ) -> Result<(), ArchiveError> {
        let mut guard = self.entities.write().map_err(|_| lock_poisoned())?;
        for entity in entities {
            let mut scoped = entity.clone();
            if scoped.entity_type != "campaign"
                && let Some(obj) = scoped.data.as_object_mut()
            {
                obj.insert(
                    "campaign_id".to_string(),
                    serde_json::Value::String(campaign_id.to_string()),
                );
            }
            guard.push(scoped);
        }
        Ok(())
    }

    async fn save_notes(
        &self,
        campaign_id: Uuid,
        notes: &[NoteRecord],
    ) -> Result<(), ArchiveError> {
        let mut guard = self.notes.write().map_err(|_| lock_poisoned())?;
        let mut owners = self.note_campaigns.write().map_err(|_| lock_poisoned())?;
        for note in notes {
            owners.insert(note.id, campaign_id);
            guard.push(note.clone());
        }
        Ok(())
    }

    async fn save_asset_ids(
        &self,
        campaign_id: Uuid,
        asset_ids: &[Uuid],
    ) -> Result<(), ArchiveError> {
        let mut owners = self.asset_campaigns.write().map_err(|_| lock_poisoned())?;
        for id in asset_ids {
            owners.insert(*id, campaign_id);
        }
        Ok(())
    }
}

/// Streaming .trame PKWARE ZIP campaign archive importer enforcing manifest invariants,
/// cryptographic checksums, unlisted entry rejection, and UUID remapping.
pub struct ArchiveImporter<T: CampaignImportTarget, B: BlobStore> {
    target: T,
    blob_store: B,
    /// Destination for `stored-assets/` entries and the instance their new keys live under;
    /// without it those entries are verified but ignored and keys are left untouched.
    asset_store: Option<(Arc<dyn AssetStore>, Uuid)>,
}

impl<T: CampaignImportTarget, B: BlobStore> ArchiveImporter<T, B> {
    /// Creates a new `ArchiveImporter` bound to a database target and asset blob store.
    pub fn new(target: T, blob_store: B) -> Self {
        Self {
            target,
            blob_store,
            asset_store: None,
        }
    }

    /// Restores embedded content-addressed blobs into `asset_store` under `instance_id` and
    /// rewrites every reference to them to the imported campaign.
    pub fn with_asset_store(mut self, asset_store: Arc<dyn AssetStore>, instance_id: Uuid) -> Self {
        self.asset_store = Some((asset_store, instance_id));
        self
    }

    /// Imports a campaign archive using structured `ImportOptions`.
    pub async fn import<R: AsyncBufRead + AsyncSeek + Unpin + Send>(
        &self,
        reader: R,
        options: ImportOptions,
    ) -> Result<ImportResult, ArchiveError> {
        self.execute_import(reader, options.remap_ids).await
    }

    /// Streams and imports a campaign archive with explicit boolean remapping flag.
    pub async fn import_stream<R: AsyncBufRead + AsyncSeek + Unpin + Send>(
        &self,
        reader: R,
        remap_ids: bool,
    ) -> Result<ImportResult, ArchiveError> {
        self.execute_import(reader, remap_ids).await
    }

    async fn execute_import<R: AsyncBufRead + AsyncSeek + Unpin + Send>(
        &self,
        reader: R,
        remap_ids: bool,
    ) -> Result<ImportResult, ArchiveError> {
        let mut zip_reader = ZipFileReader::with_tokio(reader).await?;
        let entry_count = zip_reader.file().entries().len();
        if entry_count == 0 {
            return Err(ArchiveError::InvalidManifest(
                "archive is empty and contains no manifest.json".to_string(),
            ));
        }
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(ArchiveError::LimitExceeded(format!(
                "archive has {entry_count} entries (max {MAX_ARCHIVE_ENTRIES})"
            )));
        }

        // Invariant 1: First entry MUST be manifest.json
        let first_entry_filename = zip_reader
            .file()
            .entries()
            .first()
            .and_then(|e| e.filename().as_str().ok())
            .unwrap_or_default()
            .to_string();

        if first_entry_filename != "manifest.json" {
            return Err(ArchiveError::InvalidManifest(format!(
                "initial entry must be manifest.json, found '{first_entry_filename}'"
            )));
        }

        // Invariant 2: Read and parse manifest.json, bounded by actual decompressed bytes
        // (the central directory sizes are attacker-controlled and are not trusted).
        let mut manifest_reader = zip_reader.reader_with_entry(0).await?;
        let mut manifest_raw = Vec::new();
        let mut chunk = vec![0u8; CHUNK_SIZE];
        loop {
            let read_bytes = manifest_reader.read(&mut chunk).await?;
            if read_bytes == 0 {
                break;
            }
            manifest_raw.extend_from_slice(&chunk[..read_bytes]);
            if manifest_raw.len() as u64 > MAX_MANIFEST_BYTES {
                return Err(ArchiveError::LimitExceeded(format!(
                    "manifest.json exceeds {MAX_MANIFEST_BYTES} bytes"
                )));
            }
        }
        drop(manifest_reader);
        let manifest: CampaignManifest = serde_json::from_slice(&manifest_raw)
            .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?;

        // Invariant 4: Enforce FAIL_IF_EXISTS collision policy when remap_ids is false
        if !remap_ids && self.target.campaign_exists(manifest.campaign.id).await? {
            return Err(ArchiveError::CampaignAlreadyExists(manifest.campaign.id));
        }

        // Build manifest descriptor map
        // Zip-bomb guard: declared sizes must respect per-entry and total caps. Streaming
        // reads below abort as soon as an entry exceeds its declared size, so these caps
        // bound real decompressed bytes, not just claims.
        let mut manifest_map = HashMap::new();
        let mut declared_total: u64 = 0;
        for entry_desc in &manifest.entries {
            let cap = entry_byte_cap(&entry_desc.path);
            if entry_desc.byte_size > cap {
                return Err(ArchiveError::LimitExceeded(format!(
                    "entry '{}' declares {} bytes (max {cap})",
                    entry_desc.path, entry_desc.byte_size
                )));
            }
            declared_total = declared_total
                .checked_add(entry_desc.byte_size)
                .filter(|total| *total <= MAX_TOTAL_UNCOMPRESSED_BYTES)
                .ok_or_else(|| {
                    ArchiveError::LimitExceeded(format!(
                        "archive declares more than {MAX_TOTAL_UNCOMPRESSED_BYTES} uncompressed bytes"
                    ))
                })?;
            manifest_map.insert(entry_desc.path.clone(), entry_desc.clone());
        }

        // Invariant 3: Reject unlisted entries and path traversal sequences
        let mut zip_entry_names = Vec::with_capacity(entry_count);
        for (idx, entry) in zip_reader.file().entries().iter().enumerate() {
            let filename = entry
                .filename()
                .as_str()
                .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?
                .to_string();
            if filename.contains("..") || filename.contains('\\') || filename.starts_with('/') {
                return Err(ArchiveError::InvalidManifest(format!(
                    "unsafe archive entry path '{filename}'"
                )));
            }
            if idx > 0 && !manifest_map.contains_key(&filename) {
                return Err(ArchiveError::UnlistedEntry(filename));
            }
            zip_entry_names.push(filename);
        }

        // Ensure all declared manifest entries exist in the zip
        for declared_path in manifest_map.keys() {
            if !zip_entry_names.contains(declared_path) {
                return Err(ArchiveError::InvalidManifest(format!(
                    "declared manifest entry '{declared_path}' not present in zip"
                )));
            }
        }

        // Invariant 5: Prepare ID mapping table
        let mut id_map = HashMap::new();
        let new_campaign_id = if remap_ids {
            let new_id = Uuid::new_v4();
            id_map.insert(manifest.campaign.id, new_id);
            new_id
        } else {
            manifest.campaign.id
        };

        if remap_ids {
            for entry_desc in &manifest.entries {
                if let Some(stem) = entry_desc
                    .path
                    .strip_prefix("assets/")
                    .and_then(|s| s.strip_suffix(".webp"))
                    && let Ok(old_uuid) = Uuid::parse_str(stem)
                {
                    id_map.entry(old_uuid).or_insert_with(Uuid::new_v4);
                }
            }
        }

        // Process non-asset entries (database.jsonl and notes/*.md)
        let mut entities = Vec::new();
        let mut notes = Vec::new();
        let mut embedded_assets: Vec<(String, Bytes)> = Vec::new();
        let mut owners: Vec<Option<serde_json::Value>> = Vec::new();

        for (idx, filename) in zip_entry_names.iter().enumerate() {
            if idx == 0 || filename.starts_with("assets/") {
                continue;
            }

            let expected_desc = manifest_map
                .get(filename)
                .ok_or_else(|| ArchiveError::UnlistedEntry(filename.clone()))?;
            let mut entry_reader = zip_reader.reader_with_entry(idx).await?;

            let mut hasher = Sha256Hasher::new();
            let mut content = Vec::new();
            let mut chunk = vec![0u8; CHUNK_SIZE];
            let mut total_bytes = 0u64;

            loop {
                let read_bytes = entry_reader.read(&mut chunk).await?;
                if read_bytes == 0 {
                    break;
                }
                total_bytes += read_bytes as u64;
                if total_bytes > expected_desc.byte_size {
                    return Err(ArchiveError::LimitExceeded(format!(
                        "entry '{filename}' decompresses beyond its declared {} bytes",
                        expected_desc.byte_size
                    )));
                }
                hasher.update(&chunk[..read_bytes]);
                content.extend_from_slice(&chunk[..read_bytes]);
            }

            let calculated_digest = hasher.finalize_hex();
            if calculated_digest != expected_desc.sha256 {
                return Err(ArchiveError::ChecksumMismatch {
                    path: filename.clone(),
                    expected: expected_desc.sha256.clone(),
                    actual: calculated_digest,
                });
            }
            let expected_size = expected_desc.byte_size;
            if total_bytes != expected_size {
                return Err(ArchiveError::ChecksumMismatch {
                    path: filename.clone(),
                    expected: format!("size {expected_size}"),
                    actual: format!("size {total_bytes}"),
                });
            }

            if filename == "database.jsonl" {
                let db_str = std::str::from_utf8(&content)
                    .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?;
                for line in db_str.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let mut entity: ExportEntity = serde_json::from_str(trimmed)?;
                    // A user ID, not campaign data: it must survive remapping verbatim.
                    let owner = entity
                        .data
                        .as_object_mut()
                        .and_then(|o| o.remove(OWNER_USER_ID_FIELD));
                    owners.push(owner);
                    if remap_ids {
                        collect_uuids_from_json(&entity.data, &mut id_map);
                    }
                    entities.push(entity);
                }
            } else if filename.starts_with("notes/") && filename.ends_with(".md") {
                let note_str = std::str::from_utf8(&content)
                    .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?;
                let note = parse_note_file(note_str)?;
                if remap_ids {
                    id_map.entry(note.id).or_insert_with(Uuid::new_v4);
                    id_map.entry(note.author_id).or_insert_with(Uuid::new_v4);
                }
                notes.push(note);
            } else if let Some(stem) = filename
                .strip_prefix(STORED_ASSET_PREFIX)
                .and_then(|s| s.strip_suffix(".webp"))
            {
                if !is_valid_stem(stem) || !is_webp(&content) {
                    return Err(ArchiveError::InvalidManifest(format!(
                        "stored asset '{filename}' is not a content-addressed WebP image"
                    )));
                }
                embedded_assets.push((stem.to_string(), Bytes::from(content)));
            }
        }

        // Apply ID remapping if enabled
        if remap_ids {
            for entity in &mut entities {
                remap_json_value(&mut entity.data, &id_map);
            }
            for note in &mut notes {
                if let Some(new_id) = id_map.get(&note.id) {
                    note.id = *new_id;
                }
                if let Some(new_author) = id_map.get(&note.author_id) {
                    note.author_id = *new_author;
                }
                note.content_markdown = rewrite_wikilinks(&note.content_markdown, &id_map);
            }
        }
        for (entity, owner) in entities.iter_mut().zip(owners) {
            if let (Some(owner), Some(obj)) = (owner, entity.data.as_object_mut()) {
                obj.insert(OWNER_USER_ID_FIELD.to_string(), owner);
            }
        }

        // Content-addressed blobs: rewrite references to the imported campaign, report the
        // ones the archive does not embed, and re-store the embedded ones.
        let mut missing_asset_keys = Vec::new();
        if let Some((_, instance_id)) = &self.asset_store {
            let old_campaign = manifest.campaign.id;
            let mut referenced = Vec::new();
            for entity in &entities {
                stored_assets::referenced_keys_in_json(&entity.data, old_campaign, &mut referenced);
            }
            for note in &notes {
                referenced.extend(stored_assets::referenced_keys(
                    &note.content_markdown,
                    old_campaign,
                ));
            }
            for (key, stem) in referenced {
                if !embedded_assets.iter().any(|(s, _)| *s == stem)
                    && !missing_asset_keys.contains(&key)
                {
                    missing_asset_keys.push(key);
                }
            }
            for entity in &mut entities {
                stored_assets::rewrite_keys_in_json(
                    &mut entity.data,
                    old_campaign,
                    *instance_id,
                    new_campaign_id,
                );
            }
            for note in &mut notes {
                note.content_markdown = stored_assets::rewrite_keys(
                    &note.content_markdown,
                    old_campaign,
                    *instance_id,
                    new_campaign_id,
                );
            }
        }

        // Stream asset entries in bounded 64 KiB chunks
        let mut uploaded_asset_ids: Vec<String> = Vec::new();
        let mut uploaded_asset_uuids: Vec<Uuid> = Vec::new();
        let mut assets_restored = 0usize;

        for (idx, filename) in zip_entry_names.iter().enumerate() {
            if !filename.starts_with("assets/") || !filename.ends_with(".webp") {
                continue;
            }

            let stem = filename
                .strip_prefix("assets/")
                .and_then(|s| s.strip_suffix(".webp"))
                .unwrap_or_default();

            let target_asset_id = if remap_ids {
                if let Ok(old_uuid) = Uuid::parse_str(stem) {
                    *id_map.entry(old_uuid).or_insert_with(Uuid::new_v4)
                } else {
                    Uuid::new_v4()
                }
            } else {
                Uuid::parse_str(stem).unwrap_or_else(|_| Uuid::new_v4())
            };
            let target_asset_id_str = target_asset_id.to_string();

            let expected_desc = manifest_map
                .get(filename)
                .ok_or_else(|| ArchiveError::UnlistedEntry(filename.clone()))?;
            let mut entry_reader = zip_reader.reader_with_entry(idx).await?;

            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, BlobStoreError>>(2);
            let stream = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv().await.map(|item| (item, rx))
            });
            let blob_stream: crate::storage::blob::BlobStream = Box::pin(stream);

            let put_fut = self
                .blob_store
                .put_stream(&target_asset_id_str, blob_stream);

            let send_fut = async {
                let mut chunk = vec![0u8; CHUNK_SIZE];
                let mut total_bytes = 0u64;
                let mut hasher = Sha256Hasher::new();
                loop {
                    let read_bytes = match entry_reader.read(&mut chunk).await {
                        Ok(n) => n,
                        Err(e) => {
                            let _ = tx.send(Err(BlobStoreError::Io(e))).await;
                            return Err(ArchiveError::Io(std::io::Error::other(
                                "failed to read asset zip entry",
                            )));
                        }
                    };
                    if read_bytes == 0 {
                        break;
                    }
                    total_bytes += read_bytes as u64;
                    if total_bytes > expected_desc.byte_size {
                        let _ = tx
                            .send(Err(BlobStoreError::InvalidArgument(
                                "entry exceeds declared size".to_string(),
                            )))
                            .await;
                        return Err(ArchiveError::LimitExceeded(format!(
                            "entry '{filename}' decompresses beyond its declared {} bytes",
                            expected_desc.byte_size
                        )));
                    }
                    hasher.update(&chunk[..read_bytes]);
                    let bytes = Bytes::copy_from_slice(&chunk[..read_bytes]);
                    if tx.send(Ok(bytes)).await.is_err() {
                        return Err(ArchiveError::Storage(BlobStoreError::InvalidArgument(
                            "blob stream consumer terminated".to_string(),
                        )));
                    }
                }

                let calculated_digest = hasher.finalize_hex();
                if calculated_digest != expected_desc.sha256 {
                    let _ = tx
                        .send(Err(BlobStoreError::InvalidArgument(
                            "checksum mismatch".to_string(),
                        )))
                        .await;
                    return Err(ArchiveError::ChecksumMismatch {
                        path: filename.clone(),
                        expected: expected_desc.sha256.clone(),
                        actual: calculated_digest,
                    });
                }
                let expected_size = expected_desc.byte_size;
                if total_bytes != expected_size {
                    let _ = tx
                        .send(Err(BlobStoreError::InvalidArgument(
                            "size mismatch".to_string(),
                        )))
                        .await;
                    return Err(ArchiveError::ChecksumMismatch {
                        path: filename.clone(),
                        expected: format!("size {expected_size}"),
                        actual: format!("size {total_bytes}"),
                    });
                }
                drop(tx);
                Ok(())
            };

            let (put_res, send_res) = tokio::join!(put_fut, send_fut);
            if let Err(err) = send_res {
                let _ = self.blob_store.delete(&target_asset_id_str).await;
                for aid in &uploaded_asset_ids {
                    let _ = self.blob_store.delete(aid.as_str()).await;
                }
                return Err(err);
            }
            if let Err(err) = put_res {
                let _ = self.blob_store.delete(&target_asset_id_str).await;
                for aid in &uploaded_asset_ids {
                    let _ = self.blob_store.delete(aid.as_str()).await;
                }
                return Err(ArchiveError::Storage(err));
            }

            uploaded_asset_ids.push(target_asset_id_str);
            uploaded_asset_uuids.push(target_asset_id);
            assets_restored += 1;
        }

        if let Some((asset_store, instance_id)) = &self.asset_store {
            for (stem, bytes) in embedded_assets {
                let key = stored_assets::asset_key(*instance_id, new_campaign_id, &stem);
                if let Err(err) = asset_store.put_asset(&key, bytes, "image/webp").await {
                    for aid in &uploaded_asset_ids {
                        let _ = self.blob_store.delete(aid.as_str()).await;
                    }
                    return Err(ArchiveError::Io(std::io::Error::other(err.to_string())));
                }
                assets_restored += 1;
            }
        }

        // Persist campaign metadata, entities, notes, and asset ownership into target
        let mut final_campaign = manifest.campaign.clone();
        final_campaign.id = new_campaign_id;
        let persisted = async {
            self.target.save_campaign(&final_campaign).await?;
            self.target
                .save_entities(new_campaign_id, &entities)
                .await?;
            self.target.save_notes(new_campaign_id, &notes).await?;
            self.target
                .save_asset_ids(new_campaign_id, &uploaded_asset_uuids)
                .await
        }
        .await;
        if let Err(err) = persisted {
            for aid in &uploaded_asset_ids {
                let _ = self.blob_store.delete(aid.as_str()).await;
            }
            return Err(err);
        }

        let actors_restored = entities.iter().filter(|e| e.entity_type == "actor").count();
        let scenes_restored = entities.iter().filter(|e| e.entity_type == "scene").count();
        let notes_restored = notes.len();

        Ok(ImportResult {
            campaign_id: new_campaign_id,
            name: final_campaign.name,
            actors_restored,
            scenes_restored,
            notes_restored,
            assets_restored,
            missing_asset_keys,
        })
    }
}

/// Rewrites wikilinks matching `[[<uuid>]]` and `[[<uuid>|<label>]]` using the mapping table.
pub fn rewrite_wikilinks(content: &str, id_map: &HashMap<Uuid, Uuid>) -> String {
    let mut result = String::with_capacity(content.len());
    let mut cursor = 0;

    while cursor < content.len() {
        let slice = &content[cursor..];
        if let Some(close_rel) = slice.strip_prefix("[[").and_then(|s| s.find("]]")) {
            let close_idx = cursor + 2 + close_rel;
            let inner = &content[cursor + 2..close_idx];

            let (uuid_part, label_part) = match inner.split_once('|') {
                Some((u, l)) if !l.is_empty() => (u, Some(l)),
                Some(_) => (inner, None),
                None => (inner, None),
            };

            let remapped = if uuid_part.len() == 36
                && let Ok(old_uuid) = Uuid::parse_str(uuid_part)
                && let Some(new_uuid) = id_map.get(&old_uuid)
            {
                Some(match label_part {
                    Some(label) => format!("[[{new_uuid}|{label}]]"),
                    None => format!("[[{new_uuid}]]"),
                })
            } else {
                None
            };

            if let Some(replaced) = remapped {
                result.push_str(&replaced);
            } else {
                result.push_str(&content[cursor..close_idx + 2]);
            }
            cursor = close_idx + 2;
            continue;
        }

        if let Some(ch) = slice.chars().next() {
            result.push(ch);
            cursor += ch.len_utf8();
        } else {
            break;
        }
    }

    result
}

/// Parses CommonMark file with YAML frontmatter into a `NoteRecord`.
pub fn parse_note_file(content: &str) -> Result<NoteRecord, ArchiveError> {
    let normalized = if content.contains('\r') {
        Some(content.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        None
    };
    let text = normalized.as_deref().unwrap_or(content);

    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return Err(ArchiveError::InvalidManifest(
            "note file missing YAML frontmatter opening delimiter".to_string(),
        ));
    }
    let after_first = &trimmed[3..];
    let after_first = after_first.strip_prefix('\n').unwrap_or(after_first);
    let closing_pos = after_first.find("\n---").ok_or_else(|| {
        ArchiveError::InvalidManifest(
            "note file missing YAML frontmatter closing delimiter".to_string(),
        )
    })?;

    let frontmatter = &after_first[..closing_pos];
    let after_closing = &after_first[closing_pos + 4..];
    let body = match after_closing.find('\n') {
        Some(newline_pos) => {
            let after_nl = &after_closing[newline_pos + 1..];
            after_nl.strip_prefix('\n').unwrap_or(after_nl)
        }
        None => "",
    };

    let mut id = None;
    let mut title = None;
    let mut folder = None;
    let mut author_id = None;
    let mut created_at = None;
    let mut updated_at = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'');
            match key {
                "id" => {
                    id = Some(Uuid::parse_str(val).map_err(|e| {
                        ArchiveError::InvalidManifest(format!("invalid note id: {e}"))
                    })?);
                }
                "title" => {
                    title = Some(val.to_string());
                }
                "folder" => {
                    if val == "null" || val.is_empty() {
                        folder = None;
                    } else {
                        folder = Some(val.to_string());
                    }
                }
                "author_id" => {
                    author_id = Some(Uuid::parse_str(val).map_err(|e| {
                        ArchiveError::InvalidManifest(format!("invalid note author_id: {e}"))
                    })?);
                }
                "created_at" => {
                    created_at = Some(val.to_string());
                }
                "updated_at" => {
                    updated_at = Some(val.to_string());
                }
                _ => {}
            }
        }
    }

    Ok(NoteRecord {
        id: id.unwrap_or_else(Uuid::new_v4),
        title: title.unwrap_or_default(),
        folder,
        author_id: author_id.unwrap_or_else(Uuid::new_v4),
        created_at: created_at.unwrap_or_default(),
        updated_at: updated_at.unwrap_or_default(),
        content_markdown: body.to_string(),
    })
}

fn collect_uuids_from_json(value: &serde_json::Value, id_map: &mut HashMap<Uuid, Uuid>) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() == 36
                && let Ok(uuid) = Uuid::parse_str(s)
            {
                id_map.entry(uuid).or_insert_with(Uuid::new_v4);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_uuids_from_json(v, id_map);
            }
        }
        serde_json::Value::Object(map) => {
            for v in map.values() {
                collect_uuids_from_json(v, id_map);
            }
        }
        _ => {}
    }
}

fn remap_json_value(value: &mut serde_json::Value, id_map: &HashMap<Uuid, Uuid>) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() == 36
                && let Ok(old_uuid) = Uuid::parse_str(s)
                && let Some(new_uuid) = id_map.get(&old_uuid)
            {
                *s = new_uuid.to_string();
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                remap_json_value(item, id_map);
            }
        }
        serde_json::Value::Object(map) => {
            for val in map.values_mut() {
                remap_json_value(val, id_map);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parameterized_markdown_link_remapping() {
        let u1 = Uuid::new_v4();
        let u2 = Uuid::new_v4();
        let new_u1 = Uuid::new_v4();
        let new_u2 = Uuid::new_v4();
        let unmapped = Uuid::new_v4();

        let mut id_map = HashMap::new();
        id_map.insert(u1, new_u1);
        id_map.insert(u2, new_u2);

        let cases = vec![
            (format!("[[{u1}]]"), format!("[[{new_u1}]]")),
            (
                format!("[[{u1}|Gideon Ironheart]]"),
                format!("[[{new_u1}|Gideon Ironheart]]"),
            ),
            (
                format!("[[{u2}|Cathedral Entrance (Main Gate)]]"),
                format!("[[{new_u2}|Cathedral Entrance (Main Gate)]]"),
            ),
            (format!("[[{unmapped}]]"), format!("[[{unmapped}]]")),
            (
                format!("[[{unmapped}|Unmapped Label]]"),
                format!("[[{unmapped}|Unmapped Label]]"),
            ),
            ("[[NonUuidLink]]".to_string(), "[[NonUuidLink]]".to_string()),
            (
                "[[NonUuidLink|Custom Label]]".to_string(),
                "[[NonUuidLink|Custom Label]]".to_string(),
            ),
            (format!("[[{u1}|]]"), format!("[[{u1}|]]")),
            (
                format!("Hero [[{u1}|Hero]] meets scout [[{u2}]] near [[{unmapped}]]."),
                format!("Hero [[{new_u1}|Hero]] meets scout [[{new_u2}]] near [[{unmapped}]]."),
            ),
            (
                "Plain text without any wikilinks.".to_string(),
                "Plain text without any wikilinks.".to_string(),
            ),
            (String::new(), String::new()),
        ];

        for (input, expected) in cases {
            let actual = rewrite_wikilinks(&input, &id_map);
            assert_eq!(actual, expected, "Failed for input: {input}");
        }
    }

    #[test]
    fn test_parameterized_parse_note_file() {
        let note_id = Uuid::new_v4();
        let author_id = Uuid::new_v4();

        struct Case {
            raw: String,
            expect_ok: bool,
            expected_folder: Option<String>,
            expected_body: String,
        }

        let cases = vec![
            Case {
                raw: format!(
                    "---\nid: {note_id}\ntitle: \"Secret Orders\"\nfolder: factions/harpers\nauthor_id: {author_id}\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-02T00:00:00Z\n---\n\n# Orders\n\nDeliver the message."
                ),
                expect_ok: true,
                expected_folder: Some("factions/harpers".to_string()),
                expected_body: "# Orders\n\nDeliver the message.".to_string(),
            },
            Case {
                raw: format!(
                    "---\r\nid: {note_id}\r\ntitle: CRLF Note\r\nfolder: quests\r\nauthor_id: {author_id}\r\n---\r\n\r\n# CRLF Content"
                ),
                expect_ok: true,
                expected_folder: Some("quests".to_string()),
                expected_body: "# CRLF Content".to_string(),
            },
            Case {
                raw: format!(
                    "---\nid: {note_id}\ntitle: Top Note\nfolder: null\nauthor_id: {author_id}\n---\n\nBody"
                ),
                expect_ok: true,
                expected_folder: None,
                expected_body: "Body".to_string(),
            },
            Case {
                raw: format!(
                    "---\nid: {note_id}\ntitle: Empty Folder Note\nfolder: \"\"\nauthor_id: {author_id}\n---\n\nBody"
                ),
                expect_ok: true,
                expected_folder: None,
                expected_body: "Body".to_string(),
            },
            Case {
                raw: format!(
                    "---\nid: {note_id}\ntitle: Whitespace Delimiter\nauthor_id: {author_id}\n---   \n\nBody"
                ),
                expect_ok: true,
                expected_folder: None,
                expected_body: "Body".to_string(),
            },
            Case {
                raw: format!("id: {note_id}\n---\nBody"),
                expect_ok: false,
                expected_folder: None,
                expected_body: String::new(),
            },
            Case {
                raw: format!("---\nid: {note_id}\nBody without closing delimiter"),
                expect_ok: false,
                expected_folder: None,
                expected_body: String::new(),
            },
            Case {
                raw: format!("---\nid: not-a-uuid\nauthor_id: {author_id}\n---\nBody"),
                expect_ok: false,
                expected_folder: None,
                expected_body: String::new(),
            },
        ];

        for case in cases {
            let res = parse_note_file(&case.raw);
            if case.expect_ok {
                let note = res.expect("note must parse successfully");
                assert_eq!(note.id, note_id);
                assert_eq!(note.folder, case.expected_folder);
                assert_eq!(note.content_markdown, case.expected_body);
            } else {
                assert!(res.is_err(), "expected error for: {}", case.raw);
            }
        }
    }

    #[test]
    fn test_collect_and_remap_json_values() {
        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();
        let mut data = json!({
            "id": id1.to_string(),
            "target_id": id2.to_string(),
            "nested": {
                "parent_id": id1.to_string(),
                "numbers": [1, 2, 3],
                "plain_string": "regular text"
            },
            "array": [
                { "item_id": id2.to_string() }
            ]
        });

        let mut id_map = HashMap::new();
        collect_uuids_from_json(&data, &mut id_map);
        assert!(id_map.contains_key(&id1));
        assert!(id_map.contains_key(&id2));

        let new_id1 = id_map[&id1];
        let new_id2 = id_map[&id2];
        assert_ne!(new_id1, id1);
        assert_ne!(new_id2, id2);

        remap_json_value(&mut data, &id_map);
        assert_eq!(data["id"], new_id1.to_string());
        assert_eq!(data["target_id"], new_id2.to_string());
        assert_eq!(data["nested"]["parent_id"], new_id1.to_string());
        assert_eq!(data["nested"]["plain_string"], "regular text");
        assert_eq!(data["array"][0]["item_id"], new_id2.to_string());
    }

    #[tokio::test]
    async fn test_in_memory_campaign_store_crud() {
        let store = InMemoryCampaignStore::new();
        let cid = Uuid::new_v4();
        assert!(!store.campaign_exists(cid).await.unwrap());

        let meta = CampaignMetadata {
            id: cid,
            name: "Test Campaign".to_string(),
            system: "dnd5e".to_string(),
            description: None,
            created_at: "2025-01-01T00:00:00Z".to_string(),
        };
        store.save_campaign(&meta).await.unwrap();
        assert!(store.campaign_exists(cid).await.unwrap());

        let entities = vec![ExportEntity {
            entity_type: "actor".to_string(),
            data: json!({ "id": Uuid::new_v4().to_string() }),
        }];
        store.save_entities(cid, &entities).await.unwrap();
        assert_eq!(store.all_entities().len(), 1);
        assert_eq!(store.entities_for_campaign(cid).len(), 1);
        assert!(store.entities_for_campaign(Uuid::new_v4()).is_empty());

        let notes = vec![NoteRecord {
            id: Uuid::new_v4(),
            title: "Note".to_string(),
            folder: None,
            author_id: Uuid::new_v4(),
            created_at: "2025-01-01T00:00:00Z".to_string(),
            updated_at: "2025-01-01T00:00:00Z".to_string(),
            content_markdown: "Body".to_string(),
        }];
        store.save_notes(cid, &notes).await.unwrap();
        assert_eq!(store.all_notes().len(), 1);
        assert_eq!(store.notes_for_campaign(cid).len(), 1);
        assert!(store.notes_for_campaign(Uuid::new_v4()).is_empty());
    }
}
