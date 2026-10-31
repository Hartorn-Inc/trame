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
//!
//! EXECUTION LIFECYCLE:
//!   1. Validate entry 0 (`manifest.json`), parse `CampaignManifest`, and check
//!      `FAIL_IF_EXISTS` against `CampaignImportTarget::campaign_exists`.
//!   2. Verify all archive entries against `manifest.entries`, rejecting any
//!      unlisted or missing entry before mutating persistent state.
//!   3. Stream and verify `database.jsonl` and `notes/<uuid>.md`, optionally
//!      remapping all entity/note/asset UUIDs and rewriting `[[<uuid>]]` /
//!      `[[<uuid>|<label>]]` wikilinks.
//!   4. Stream and verify each `assets/<uuid>.webp` entry into `BlobStore`,
//!      then persist the campaign metadata, entities, and notes.
//! ============================================================================

use super::exporter::{ExportEntity, NoteRecord};
use super::manifest::{CampaignManifest, CampaignMetadata};
use crate::storage::blob::{BlobStore, BlobStoreError, CHUNK_SIZE, Sha256Hasher};
use async_zip::tokio::read::seek::ZipFileReader;
use bytes::Bytes;
use futures_lite::io::AsyncReadExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncBufRead, AsyncRead, AsyncSeek, BufReader};
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

        for (idx, filename) in zip_entry_names.iter().enumerate() {
            if idx == 0 || filename.starts_with("assets/") {
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
                    let entity: ExportEntity = serde_json::from_str(trimmed)?;
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

        // Stream asset entries in bounded 64 KiB chunks
        let mut uploaded_asset_ids: Vec<String> = Vec::new();
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

            let expected_desc = manifest_map.get(filename).expect("descriptor exists");
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
                    hasher.update(&chunk[..read_bytes]);
                    total_bytes += read_bytes as u64;
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
                for aid in &uploaded_asset_ids {
                    let _ = self.blob_store.delete(aid.as_str()).await;
                }
                return Err(err);
            }
            if let Err(err) = put_res {
                for aid in &uploaded_asset_ids {
                    let _ = self.blob_store.delete(aid.as_str()).await;
                }
                return Err(ArchiveError::Storage(err));
            }

            uploaded_asset_ids.push(target_asset_id_str);
            assets_restored += 1;
        }

        // Persist campaign metadata, entities, and notes into target
        let mut final_campaign = manifest.campaign.clone();
        final_campaign.id = new_campaign_id;
        if let Err(err) = self.target.save_campaign(&final_campaign).await {
            for aid in &uploaded_asset_ids {
                let _ = self.blob_store.delete(aid.as_str()).await;
            }
            return Err(err);
        }
        if let Err(err) = self.target.save_entities(&entities).await {
            for aid in &uploaded_asset_ids {
                let _ = self.blob_store.delete(aid.as_str()).await;
            }
            return Err(err);
        }
        if let Err(err) = self.target.save_notes(&notes).await {
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
    let body_start = closing_pos + 4;
    let rest = after_first[body_start..]
        .strip_prefix('\n')
        .unwrap_or(&after_first[body_start..]);
    let body = rest.strip_prefix('\n').unwrap_or(rest);

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
    fn test_markdown_link_remapping_regex() {
        let old_uuid1 = Uuid::new_v4();
        let old_uuid2 = Uuid::new_v4();
        let new_uuid1 = Uuid::new_v4();
        let new_uuid2 = Uuid::new_v4();

        let mut id_map = HashMap::new();
        id_map.insert(old_uuid1, new_uuid1);
        id_map.insert(old_uuid2, new_uuid2);

        let input = format!(
            "Meet [[{old_uuid1}|Gideon Ironheart]] at [[{old_uuid2}]]. Check [[NonUuidLink]] and [[{old_uuid1}|]]."
        );
        let output = rewrite_wikilinks(&input, &id_map);

        assert!(output.contains(&format!("[[{new_uuid1}|Gideon Ironheart]]")));
        assert!(output.contains(&format!("[[{new_uuid2}]]")));
        assert!(output.contains("[[NonUuidLink]]"));
        assert!(output.contains(&format!("[[{old_uuid1}|]]")));
        assert!(!output.contains(&old_uuid1.to_string()));
        assert!(!output.contains(&old_uuid2.to_string()));
    }

    #[test]
    fn test_parse_note_file_frontmatter_permutations() {
        let note_id = Uuid::new_v4();
        let author_id = Uuid::new_v4();

        // 1. Nominal with all fields and quoted title
        let raw = format!(
            "---\nid: {note_id}\ntitle: \"Secret Orders\"\nfolder: factions/harpers\nauthor_id: {author_id}\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-02T00:00:00Z\n---\n\n# Orders\n\nDeliver the message."
        );
        let note = parse_note_file(&raw).expect("parse nominal note");
        assert_eq!(note.id, note_id);
        assert_eq!(note.title, "Secret Orders");
        assert_eq!(note.folder.as_deref(), Some("factions/harpers"));
        assert_eq!(note.author_id, author_id);
        assert_eq!(note.content_markdown, "# Orders\n\nDeliver the message.");

        // 2. Windows CRLF line endings
        let crlf = raw.replace('\n', "\r\n");
        let note_crlf = parse_note_file(&crlf).expect("parse CRLF note");
        assert_eq!(note_crlf.id, note_id);
        assert_eq!(note_crlf.title, "Secret Orders");

        // 3. folder: null
        let null_folder = format!(
            "---\nid: {note_id}\ntitle: Top Note\nfolder: null\nauthor_id: {author_id}\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-02T00:00:00Z\n---\n\nBody"
        );
        let note_null = parse_note_file(&null_folder).expect("parse null folder");
        assert_eq!(note_null.folder, None);

        // 4. Missing opening delimiter
        let err_open = parse_note_file("id: 123\n---\nBody").unwrap_err();
        assert!(matches!(err_open, ArchiveError::InvalidManifest(_)));

        // 5. Missing closing delimiter
        let err_close = parse_note_file("---\nid: 123\ntitle: X\nBody").unwrap_err();
        assert!(matches!(err_close, ArchiveError::InvalidManifest(_)));
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
        store.save_entities(&entities).await.unwrap();
        assert_eq!(store.all_entities().len(), 1);

        let notes = vec![NoteRecord {
            id: Uuid::new_v4(),
            title: "Note".to_string(),
            folder: None,
            author_id: Uuid::new_v4(),
            created_at: "2025-01-01T00:00:00Z".to_string(),
            updated_at: "2025-01-01T00:00:00Z".to_string(),
            content_markdown: "Body".to_string(),
        }];
        store.save_notes(&notes).await.unwrap();
        assert_eq!(store.all_notes().len(), 1);
    }
}
