//! ============================================================================
//! TWO-PASS STREAMING `.TRAME` CAMPAIGN ARCHIVE EXPORTER (exporter.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements the two-pass streaming PKWARE ZIP exporter (`ArchiveExporter`)
//! that compiles `manifest.json` with SHA-256 digests and exact uncompressed
//! byte sizes before streaming `manifest.json`, `database.jsonl`, `notes/*.md`,
//! and `assets/*.webp` through a bounded 64 KiB duplex window.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Manifest-First PKWARE Entry Ordering`:
//!      - `manifest.json` is unconditionally written as the very first ZIP entry
//!        (`index 0`) so streaming importers can verify digests before unpacking
//!        payload entries.
//!   2. `Zip-Slip Directory Traversal Prevention`:
//!      - `NoteRecord::archive_path` normalizes path separators and strips `.`
//!        and `..` segments through `slugify`, guaranteeing all note entries
//!        remain strictly inside `notes/`.
//!   3. `Deterministic Background Error Propagation & < 16 MiB Heap Ceiling`:
//!      - `export_stream` awaits `err_rx.await` upon reader EOF so any background
//!        storage or ZIP writer failure is reliably surfaced to the consumer
//!        stream while keeping in-flight buffers bounded to `CHUNK_SIZE` (64 KiB).
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `ArchiveExporter::export_stream()`
//!     ├── 1. Pass 1 (`compile_manifest`): compute SHA-256 and byte sizes for all entries.
//!     ├── 2. Spawn background `write_archive` task writing into a bounded duplex stream.
//!     └── 3. Yield 64 KiB `Bytes` chunks to caller and propagate any task error via `err_rx`.
//! ============================================================================

use super::manifest::{ArchiveEntryDescriptor, CampaignManifest, CampaignMetadata, ManifestStats};
use crate::storage::blob::{BlobStore, BlobStoreError, CHUNK_SIZE, Sha256Hasher};
use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use bytes::Bytes;
use futures_lite::io::AsyncWriteExt;
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use tokio::io::{AsyncReadExt, AsyncWrite};
use uuid::Uuid;

/// Error returned during campaign archive export operations.
#[derive(Debug, thiserror::Error)]
pub enum ArchiveExportError {
    #[error("storage error: {0}")]
    Storage(#[from] BlobStoreError),
    #[error("zip packaging error: {0}")]
    Zip(#[from] async_zip::error::ZipError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("campaign not found: {0}")]
    CampaignNotFound(Uuid),
}

/// Record representation of an exported database row in `database.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportEntity {
    pub entity_type: String,
    pub data: serde_json::Value,
}

/// Authoritative note record serialized into CommonMark with YAML frontmatter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteRecord {
    pub id: Uuid,
    pub title: String,
    pub folder: Option<String>,
    pub author_id: Uuid,
    pub created_at: String,
    pub updated_at: String,
    pub content_markdown: String,
}

impl NoteRecord {
    /// Computes the archive path for this note, e.g. `notes/factions/harpers.md` or `notes/overview.md`.
    /// Normalizes path separators and strips `.` and `..` traversal segments to prevent Zip Slip (CWE-22).
    pub fn archive_path(&self) -> String {
        let slug = slugify(&self.title);
        let filename = if slug.is_empty() {
            format!("{}.md", self.id)
        } else {
            format!("{slug}.md")
        };
        let sanitized_segments: Vec<String> = self
            .folder
            .as_deref()
            .unwrap_or("")
            .replace('\\', "/")
            .split('/')
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .map(slugify)
            .filter(|s| !s.is_empty())
            .collect();
        if sanitized_segments.is_empty() {
            format!("notes/{filename}")
        } else {
            format!("notes/{}/{filename}", sanitized_segments.join("/"))
        }
    }

    /// Serializes note metadata into YAML frontmatter followed by CommonMark body.
    pub fn serialize_file(&self) -> String {
        let folder_val = match &self.folder {
            Some(f) => f.as_str(),
            None => "null",
        };
        format!(
            "---\nid: {}\ntitle: {}\nfolder: {}\nauthor_id: {}\ncreated_at: {}\nupdated_at: {}\n---\n\n{}",
            self.id,
            self.title,
            folder_val,
            self.author_id,
            self.created_at,
            self.updated_at,
            self.content_markdown
        )
    }
}

fn slugify(input: &str) -> String {
    input
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c == ' ' || c == '-' || c == '_' {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Campaign data access provider for archive export.
pub trait CampaignExportSource: Send + Sync + 'static {
    fn campaign_metadata(&self) -> CampaignMetadata;
    fn stream_entities(&self) -> Vec<ExportEntity>;
    fn stream_notes(&self) -> Vec<NoteRecord>;
    fn list_asset_ids(&self) -> Vec<Uuid>;
}

/// Streaming exporter generating `.trame` PKWARE ZIP archives in two strict passes.
pub struct ArchiveExporter<S: CampaignExportSource, B: BlobStore> {
    source: S,
    blob_store: B,
}

impl<S: CampaignExportSource, B: BlobStore> ArchiveExporter<S, B> {
    /// Creates a new `ArchiveExporter` with source provider and asset blob store.
    pub fn new(source: S, blob_store: B) -> Self {
        Self { source, blob_store }
    }

    /// Executes Pass 1 to compute entries digest, sizes, and compiles `manifest.json`.
    pub async fn compile_manifest(&self) -> Result<(CampaignManifest, u64), ArchiveExportError> {
        let mut entries = Vec::new();
        let mut total_uncompressed_bytes = 0u64;

        // 1. database.jsonl digest & size
        let entities = self.source.stream_entities();
        let mut db_hasher = Sha256Hasher::new();
        let mut db_size = 0u64;
        let mut actor_count = 0usize;
        let mut scene_count = 0usize;

        for entity in &entities {
            if entity.entity_type == "actor" {
                actor_count += 1;
            } else if entity.entity_type == "scene" {
                scene_count += 1;
            }
            let mut row = serde_json::to_vec(entity)?;
            row.push(b'\n');
            db_hasher.update(&row);
            db_size += row.len() as u64;
        }

        entries.push(ArchiveEntryDescriptor {
            path: "database.jsonl".to_string(),
            byte_size: db_size,
            sha256: db_hasher.finalize_hex(),
        });
        total_uncompressed_bytes += db_size;

        // 2. notes/*.md digests & sizes
        let notes = self.source.stream_notes();
        let note_count = notes.len();
        for note in &notes {
            let file_content = note.serialize_file();
            let bytes = file_content.as_bytes();
            let digest = Sha256Hasher::digest(bytes);
            let size = bytes.len() as u64;
            entries.push(ArchiveEntryDescriptor {
                path: note.archive_path(),
                byte_size: size,
                sha256: digest,
            });
            total_uncompressed_bytes += size;
        }

        // 3. assets/*.webp digests & sizes
        let asset_ids = self.source.list_asset_ids();
        let asset_count = asset_ids.len();
        for asset_id in &asset_ids {
            let asset_id_str = asset_id.to_string();
            let desc = match self.blob_store.get_descriptor(&asset_id_str).await {
                Ok(d) if !d.sha256_hex.is_empty() => d,
                _ => {
                    let mut stream = self.blob_store.open_read_stream(&asset_id_str).await?;
                    let mut hasher = Sha256Hasher::new();
                    let mut byte_size = 0u64;
                    while let Some(chunk_res) = stream.next().await {
                        let chunk = chunk_res?;
                        hasher.update(&chunk);
                        byte_size += chunk.len() as u64;
                    }
                    crate::storage::blob::AssetDescriptor {
                        id: asset_id_str,
                        byte_size,
                        sha256_hex: hasher.finalize_hex(),
                        mime_type: "image/webp".to_string(),
                    }
                }
            };

            entries.push(ArchiveEntryDescriptor {
                path: format!("assets/{}.webp", asset_id),
                byte_size: desc.byte_size,
                sha256: desc.sha256_hex,
            });
            total_uncompressed_bytes += desc.byte_size;
        }

        let campaign = self.source.campaign_metadata();
        let stats = ManifestStats {
            actor_count,
            scene_count,
            note_count,
            asset_count,
            total_uncompressed_bytes,
        };

        let exported_at = format_utc_rfc3339(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        let manifest = CampaignManifest::new(campaign, exported_at, stats, entries);

        Ok((manifest, total_uncompressed_bytes))
    }

    /// Streams the complete `.trame` ZIP archive into an asynchronous byte stream,
    /// propagating any background writer error to the consumer stream.
    pub async fn export_stream(
        self,
    ) -> Result<
        Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, ArchiveExportError>> + Send>>,
        ArchiveExportError,
    > {
        let (manifest, _) = self.compile_manifest().await?;
        let (reader, writer) = tokio::io::duplex(CHUNK_SIZE * 2);
        let (err_tx, err_rx) = tokio::sync::oneshot::channel::<ArchiveExportError>();

        tokio::spawn(async move {
            if let Err(err) =
                Self::write_archive(self.source, self.blob_store, manifest, writer).await
            {
                let _ = err_tx.send(err);
            }
        });

        let stream = stream::unfold(Some((reader, err_rx)), |state| async move {
            let (mut reader, err_rx) = state?;
            let mut buffer = vec![0u8; CHUNK_SIZE];
            match reader.read(&mut buffer).await {
                Ok(0) => match err_rx.await {
                    Ok(err) => Some((Err(err), None)),
                    Err(_) => None,
                },
                Ok(bytes_read) => {
                    buffer.truncate(bytes_read);
                    Some((Ok(Bytes::from(buffer)), Some((reader, err_rx))))
                }
                Err(err) => Some((Err(ArchiveExportError::Io(err)), None)),
            }
        });
        Ok(Box::pin(stream))
    }

    async fn write_archive<W: AsyncWrite + Unpin + Send>(
        source: S,
        blob_store: B,
        manifest: CampaignManifest,
        sink: W,
    ) -> Result<(), ArchiveExportError> {
        let mut zip_writer = ZipFileWriter::with_tokio(sink);

        // Entry 1: manifest.json MUST be the first entry
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
        let manifest_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Deflate);
        let mut manifest_sink = zip_writer.write_entry_stream(manifest_builder).await?;
        manifest_sink.write_all(&manifest_bytes).await?;
        manifest_sink.close().await?;

        // Entry 2: database.jsonl
        let db_builder = ZipEntryBuilder::new("database.jsonl".into(), Compression::Deflate);
        let mut db_sink = zip_writer.write_entry_stream(db_builder).await?;
        let entities = source.stream_entities();
        for entity in entities {
            let mut row = serde_json::to_vec(&entity)?;
            row.push(b'\n');
            db_sink.write_all(&row).await?;
        }
        db_sink.close().await?;

        // Entry 3: notes/*.md
        let notes = source.stream_notes();
        for note in notes {
            let path = note.archive_path();
            let content = note.serialize_file();
            let note_builder = ZipEntryBuilder::new(path.into(), Compression::Deflate);
            let mut note_sink = zip_writer.write_entry_stream(note_builder).await?;
            note_sink.write_all(content.as_bytes()).await?;
            note_sink.close().await?;
        }

        // Entry 4: assets/*.webp streamed in 64 KiB chunks
        let asset_ids = source.list_asset_ids();
        for asset_id in asset_ids {
            let path = format!("assets/{}.webp", asset_id);
            let asset_builder = ZipEntryBuilder::new(path.into(), Compression::Stored);
            let mut asset_sink = zip_writer.write_entry_stream(asset_builder).await?;
            let mut read_stream = blob_store.open_read_stream(&asset_id.to_string()).await?;
            while let Some(chunk_res) = read_stream.next().await {
                let chunk = chunk_res?;
                if !chunk.is_empty() {
                    asset_sink.write_all(&chunk).await?;
                }
            }
            asset_sink.close().await?;
        }

        zip_writer.close().await?;
        Ok(())
    }
}

/// Formats a UNIX epoch timestamp in seconds as an ISO-8601 / RFC 3339 UTC string (`YYYY-MM-DDTHH:MM:SSZ`)
/// using Howard Hinnant's civil-from-days algorithm without external date crates.
fn format_utc_rfc3339(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}
