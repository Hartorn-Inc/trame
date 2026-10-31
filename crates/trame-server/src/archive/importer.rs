//! ============================================================================
//! STREAMING `.TRAME` CAMPAIGN ARCHIVE IMPORTER & UUID REMAPPING (importer.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements `ArchiveImporter` to validate and unpack `.trame` PKWARE ZIP
//! campaign archives with cryptographic SHA-256 verification, unlisted entry
//! rejection, `FAIL_IF_EXISTS` collision protection, and optional UUID
//! remapping (`remap_ids: true`) across JSONL entities, CommonMark note
//! wikilinks (`[[uuid]]`, `[[uuid|label]]`), and WebP assets.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Manifest-First Entry Invariant`:
//!      - Extraction immediately aborts with `ArchiveError::InvalidManifest`
//!        if ZIP entry `0` is not `manifest.json`.
//!   2. `Pre-Commit SHA-256 & Unlisted Entry Verification`:
//!      - Every archive entry outside `manifest.json` must be declared in
//!        `manifest.entries` (otherwise `ArchiveError::UnlistedEntry`) and its
//!        streamed SHA-256 digest and byte count must match the manifest
//!        before any campaign, entity, note, or asset is committed.
//!   3. `Idempotent Collision Policy & Referential Remapping`:
//!      - When `remap_ids == false`, importing an existing campaign UUID halts
//!        with `ArchiveError::CampaignAlreadyExists`. When `remap_ids == true`,
//!        all entity/note/asset UUIDs are remapped consistently across foreign
//!        keys and Markdown wikilinks.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `ArchiveImporter::import(reader, options)`
//!     ├── 1. Verify entry `0 == "manifest.json"` and parse `CampaignManifest`.
//!     ├── 2. Check campaign collision (`remap_ids == false`) and unlisted entries.
//!     ├── 3. Stream entries in 64 KiB chunks, verifying SHA-256 and byte sizes.
//!     └── 4. Apply optional UUID remapping & persist campaign, entities, notes, and assets.
//! ============================================================================

use super::exporter::{ExportEntity, NoteRecord};
use super::manifest::{CampaignManifest, CampaignMetadata};
use crate::storage::blob::{BlobStore, BlobStoreError, CHUNK_SIZE, Sha256Hasher, slice_to_stream};
use async_zip::tokio::read::seek::ZipFileReader;
use bytes::Bytes;
use futures_lite::io::AsyncReadExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncRead, AsyncSeek, BufReader};
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
}

/// Options configuring archive extraction and collision handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportOptions {
    pub remap_ids: bool,
}

/// Database persistence target for imported campaign data.
pub trait CampaignImportTarget: Send + Sync + 'static {
    async fn campaign_exists(&self, id: Uuid) -> Result<bool, ArchiveError>;
    async fn save_campaign(&self, campaign: &CampaignMetadata) -> Result<(), ArchiveError>;
    async fn save_entities(&self, entities: &[ExportEntity]) -> Result<(), ArchiveError>;
    async fn save_notes(&self, notes: &[NoteRecord]) -> Result<(), ArchiveError>;
}

/// Thread-safe in-memory campaign store suitable for testing and single-instance runtimes.
#[derive(Debug, Default, Clone)]
pub struct InMemoryCampaignStore {
    pub campaigns: Arc<RwLock<HashMap<Uuid, CampaignMetadata>>>,
    pub entities: Arc<RwLock<Vec<ExportEntity>>>,
    pub notes: Arc<RwLock<Vec<NoteRecord>>>,
}

impl InMemoryCampaignStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_campaign(campaign: CampaignMetadata) -> Self {
        let store = Self::new();
        store
            .campaigns
            .write()
            .unwrap()
            .insert(campaign.id, campaign);
        store
    }

    pub fn get_campaign(&self, id: &Uuid) -> Option<CampaignMetadata> {
        self.campaigns.read().unwrap().get(id).cloned()
    }

    pub fn all_campaigns(&self) -> Vec<CampaignMetadata> {
        self.campaigns.read().unwrap().values().cloned().collect()
    }

    pub fn all_entities(&self) -> Vec<ExportEntity> {
        self.entities.read().unwrap().clone()
    }

    pub fn all_notes(&self) -> Vec<NoteRecord> {
        self.notes.read().unwrap().clone()
    }
}

impl CampaignImportTarget for InMemoryCampaignStore {
    async fn campaign_exists(&self, id: Uuid) -> Result<bool, ArchiveError> {
        let guard = self
            .campaigns
            .read()
            .map_err(|_| ArchiveError::Io(std::io::Error::other("lock poisoned")))?;
        Ok(guard.contains_key(&id))
    }

    async fn save_campaign(&self, campaign: &CampaignMetadata) -> Result<(), ArchiveError> {
        let mut guard = self
            .campaigns
            .write()
            .map_err(|_| ArchiveError::Io(std::io::Error::other("lock poisoned")))?;
        guard.insert(campaign.id, campaign.clone());
        Ok(())
    }

    async fn save_entities(&self, entities: &[ExportEntity]) -> Result<(), ArchiveError> {
        let mut guard = self
            .entities
            .write()
            .map_err(|_| ArchiveError::Io(std::io::Error::other("lock poisoned")))?;
        guard.extend(entities.iter().cloned());
        Ok(())
    }

    async fn save_notes(&self, notes: &[NoteRecord]) -> Result<(), ArchiveError> {
        let mut guard = self
            .notes
            .write()
            .map_err(|_| ArchiveError::Io(std::io::Error::other("lock poisoned")))?;
        guard.extend(notes.iter().cloned());
        Ok(())
    }
}

/// Streaming .trame PKWARE ZIP campaign archive importer enforcing manifest invariants,
/// cryptographic checksums, unlisted entry rejection, and UUID remapping.
pub struct ArchiveImporter<T: CampaignImportTarget, B: BlobStore> {
    target: T,
    blob_store: B,
}

impl<T: CampaignImportTarget, B: BlobStore> ArchiveImporter<T, B> {
    /// Creates a new `ArchiveImporter` bound to a database target and asset blob store.
    pub fn new(target: T, blob_store: B) -> Self {
        Self { target, blob_store }
    }

    /// Imports a campaign archive using structured `ImportOptions`.
    pub async fn import<R: AsyncRead + AsyncSeek + Unpin + Send>(
        &self,
        reader: R,
        options: ImportOptions,
    ) -> Result<ImportResult, ArchiveError> {
        self.execute_import(BufReader::new(reader), options.remap_ids)
            .await
    }

    /// Streams and imports a campaign archive with explicit boolean remapping flag.
    pub async fn import_stream<R: AsyncRead + AsyncSeek + Unpin + Send>(
        &self,
        reader: R,
        remap_ids: bool,
    ) -> Result<ImportResult, ArchiveError> {
        self.execute_import(BufReader::new(reader), remap_ids).await
    }

    async fn execute_import<R: tokio::io::AsyncBufRead + AsyncSeek + Unpin + Send>(
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

        // Invariant 2: Read and parse manifest.json
        let mut manifest_reader = zip_reader.reader_with_entry(0).await?;
        let mut manifest_raw = String::new();
        manifest_reader
            .read_to_string_checked(&mut manifest_raw)
            .await?;
        let manifest: CampaignManifest = serde_json::from_str(&manifest_raw)
            .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?;

        // Invariant 4: Enforce FAIL_IF_EXISTS collision policy when remap_ids is false
        if !remap_ids && self.target.campaign_exists(manifest.campaign.id).await? {
            return Err(ArchiveError::CampaignAlreadyExists(manifest.campaign.id));
        }

        // Build manifest descriptor map
        let mut manifest_map = HashMap::new();
        for entry_desc in &manifest.entries {
            manifest_map.insert(entry_desc.path.clone(), entry_desc.clone());
        }

        // Invariant 3: Reject unlisted entries
        let mut zip_entry_names = Vec::with_capacity(entry_count);
        for (idx, entry) in zip_reader.file().entries().iter().enumerate() {
            let filename = entry
                .filename()
                .as_str()
                .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?
                .to_string();
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

        // Invariant 2: Validate entry byte sizes and SHA-256 digests
        let mut raw_buffers: HashMap<String, Bytes> = HashMap::new();
        for (idx, filename) in zip_entry_names.iter().enumerate() {
            if idx == 0 {
                continue;
            }
            let expected_desc = manifest_map.get(filename).expect("descriptor exists");
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
                hasher.update(&chunk[..read_bytes]);
                content.extend_from_slice(&chunk[..read_bytes]);
                total_bytes += read_bytes as u64;
            }

            let calculated_digest = hasher.finalize_hex();
            if calculated_digest != expected_desc.sha256 {
                return Err(ArchiveError::ChecksumMismatch {
                    path: filename.clone(),
                    expected: expected_desc.sha256.clone(),
                    actual: calculated_digest,
                });
            }
            if total_bytes != expected_desc.byte_size {
                return Err(ArchiveError::ChecksumMismatch {
                    path: filename.clone(),
                    expected: format!("size {}", expected_desc.byte_size),
                    actual: format!("size {total_bytes}"),
                });
            }

            raw_buffers.insert(filename.clone(), Bytes::from(content));
        }

        // Invariant 5: Remapping mode or nominal extraction
        let mut id_map = HashMap::new();
        let new_campaign_id = if remap_ids {
            let new_id = Uuid::new_v4();
            id_map.insert(manifest.campaign.id, new_id);
            new_id
        } else {
            manifest.campaign.id
        };

        // Parse database.jsonl
        let mut entities = Vec::new();
        if let Some(db_bytes) = raw_buffers.get("database.jsonl") {
            let db_str = std::str::from_utf8(db_bytes)
                .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?;
            for line in db_str.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let entity: ExportEntity = serde_json::from_str(trimmed)?;
                entities.push(entity);
            }
        }

        // Parse notes
        let mut notes = Vec::new();
        for (path, bytes) in &raw_buffers {
            if path.starts_with("notes/") && path.ends_with(".md") {
                let note_str = std::str::from_utf8(bytes)
                    .map_err(|e| ArchiveError::InvalidManifest(e.to_string()))?;
                let note = parse_note_file(note_str)?;
                notes.push(note);
            }
        }

        // Pre-scan IDs to remap in remap_ids mode
        if remap_ids {
            for entity in &entities {
                if let Some(id_val) = entity.data.get("id").and_then(|v| v.as_str()) {
                    if let Ok(old_uuid) = Uuid::parse_str(id_val) {
                        id_map.entry(old_uuid).or_insert_with(Uuid::new_v4);
                    }
                }
            }

            for note in &notes {
                id_map.entry(note.id).or_insert_with(Uuid::new_v4);
                id_map.entry(note.author_id).or_insert_with(Uuid::new_v4);
            }

            for path in raw_buffers.keys() {
                if path.starts_with("assets/") && path.ends_with(".webp") {
                    let stem = path
                        .strip_prefix("assets/")
                        .and_then(|s| s.strip_suffix(".webp"))
                        .unwrap_or_default();
                    if let Ok(old_uuid) = Uuid::parse_str(stem) {
                        id_map.entry(old_uuid).or_insert_with(Uuid::new_v4);
                    }
                }
            }

            // Remap entities
            for entity in &mut entities {
                remap_json_value(&mut entity.data, &id_map);
            }

            // Remap notes and rewrite wikilinks
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

        // Store assets in BlobStore
        let mut assets_restored = 0usize;
        for (path, bytes) in &raw_buffers {
            if path.starts_with("assets/") && path.ends_with(".webp") {
                let stem = path
                    .strip_prefix("assets/")
                    .and_then(|s| s.strip_suffix(".webp"))
                    .unwrap_or_default();
                let target_asset_id = if remap_ids {
                    if let Ok(old_uuid) = Uuid::parse_str(stem) {
                        id_map.get(&old_uuid).copied().unwrap_or(old_uuid)
                    } else {
                        Uuid::new_v4()
                    }
                } else {
                    Uuid::parse_str(stem).unwrap_or_else(|_| Uuid::new_v4())
                };

                self.blob_store
                    .put_stream(&target_asset_id.to_string(), slice_to_stream(bytes))
                    .await?;
                assets_restored += 1;
            }
        }

        // Persist campaign metadata, entities, and notes into target
        let mut final_campaign = manifest.campaign.clone();
        final_campaign.id = new_campaign_id;
        self.target.save_campaign(&final_campaign).await?;
        self.target.save_entities(&entities).await?;
        self.target.save_notes(&notes).await?;

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
        })
    }
}

/// Rewrites wikilinks matching `[[<uuid>]]` and `[[<uuid>|<label>]]` using the mapping table.
pub fn rewrite_wikilinks(content: &str, id_map: &HashMap<Uuid, Uuid>) -> String {
    let mut result = String::with_capacity(content.len());
    let mut cursor = 0;
    let bytes = content.as_bytes();

    while cursor < bytes.len() {
        if cursor + 1 < bytes.len() && bytes[cursor] == b'[' && bytes[cursor + 1] == b'[' {
            if let Some(close_rel) = content[cursor + 2..].find("]]") {
                let close_idx = cursor + 2 + close_rel;
                let inner = &content[cursor + 2..close_idx];

                let (uuid_part, label_part) = match inner.split_once('|') {
                    Some((u, l)) => (u, Some(l)),
                    None => (inner, None),
                };

                let remapped = if uuid_part.len() == 36 {
                    Uuid::parse_str(uuid_part)
                        .ok()
                        .and_then(|old_uuid| id_map.get(&old_uuid))
                        .map(|new_uuid| match label_part {
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
        }

        if let Some(ch) = content[cursor..].chars().next() {
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
    let trimmed = content.trim_start();
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
    let body_start = closing_pos + 4;
    let body = after_first[body_start..]
        .strip_prefix('\n')
        .unwrap_or(&after_first[body_start..])
        .trim_start_matches('\n');

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
            let val = v.trim();
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

fn remap_json_value(value: &mut serde_json::Value, id_map: &HashMap<Uuid, Uuid>) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() == 36 {
                if let Ok(old_uuid) = Uuid::parse_str(s) {
                    if let Some(new_uuid) = id_map.get(&old_uuid) {
                        *s = new_uuid.to_string();
                    }
                }
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
