//! Two-pass streaming .trame campaign archive exporter.

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
    pub fn archive_path(&self) -> String {
        let slug = slugify(&self.title);
        let filename = if slug.is_empty() {
            format!("{}.md", self.id)
        } else {
            format!("{slug}.md")
        };
        match &self.folder {
            Some(folder) if !folder.trim().is_empty() => {
                let clean_folder = folder.trim().trim_matches('/');
                format!("notes/{clean_folder}/{filename}")
            }
            _ => format!("notes/{filename}"),
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

        let manifest =
            CampaignManifest::new(campaign, "2025-05-18T14:32:00Z".to_string(), stats, entries);

        Ok((manifest, total_uncompressed_bytes))
    }

    /// Streams the complete .trame ZIP archive into an asynchronous byte stream.
    pub async fn export_stream(
        self,
    ) -> Result<
        Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, ArchiveExportError>> + Send>>,
        ArchiveExportError,
    > {
        let (manifest, _) = self.compile_manifest().await?;
        let (reader, writer) = tokio::io::duplex(CHUNK_SIZE * 2);

        tokio::spawn(async move {
            if let Err(err) =
                Self::write_archive(self.source, self.blob_store, manifest, writer).await
            {
                eprintln!("archive export writer task failed: {err}");
            }
        });

        let stream = stream::unfold(Some(reader), |state| async move {
            let mut reader = state?;
            let mut buffer = vec![0u8; CHUNK_SIZE];
            match reader.read(&mut buffer).await {
                Ok(0) => None,
                Ok(bytes_read) => {
                    buffer.truncate(bytes_read);
                    Some((Ok(Bytes::from(buffer)), Some(reader)))
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
