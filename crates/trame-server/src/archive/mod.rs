//! Campaign archive exporter and importer (.trame) engine.

pub mod exporter;
pub mod manifest;

pub use exporter::{
    ArchiveExportError, ArchiveExporter, CampaignExportSource, ExportEntity, NoteRecord,
};
pub use manifest::{ArchiveEntryDescriptor, CampaignManifest, CampaignMetadata, ManifestStats};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::LocalFsStore;
    use crate::storage::blob::{
        AssetDescriptor, BlobStore, BlobStoreError, BlobStream, Sha256Hasher, slice_to_stream,
    };
    use futures_util::StreamExt;
    use serde_json::json;
    use std::io::Cursor;
    use uuid::Uuid;

    #[derive(Clone)]
    struct MockExportSource {
        campaign: CampaignMetadata,
        entities: Vec<ExportEntity>,
        notes: Vec<NoteRecord>,
        asset_ids: Vec<Uuid>,
    }

    impl CampaignExportSource for MockExportSource {
        fn campaign_metadata(&self) -> CampaignMetadata {
            self.campaign.clone()
        }

        fn stream_entities(&self) -> Vec<ExportEntity> {
            self.entities.clone()
        }

        fn stream_notes(&self) -> Vec<NoteRecord> {
            self.notes.clone()
        }

        fn list_asset_ids(&self) -> Vec<Uuid> {
            self.asset_ids.clone()
        }
    }

    #[derive(Clone)]
    struct FailingBlobStore;

    impl BlobStore for FailingBlobStore {
        async fn put_stream(
            &self,
            _id: &str,
            _stream: BlobStream,
        ) -> Result<AssetDescriptor, BlobStoreError> {
            unimplemented!()
        }

        async fn get_descriptor(&self, id: &str) -> Result<AssetDescriptor, BlobStoreError> {
            Ok(AssetDescriptor {
                id: id.to_string(),
                byte_size: 10,
                sha256_hex: "dummy".to_string(),
                mime_type: "image/webp".to_string(),
            })
        }

        async fn open_read_stream(&self, _id: &str) -> Result<BlobStream, BlobStoreError> {
            Err(BlobStoreError::NotFound("injected failure".to_string()))
        }

        async fn list_descriptors(&self) -> Result<Vec<AssetDescriptor>, BlobStoreError> {
            Ok(Vec::new())
        }

        async fn delete(&self, _id: &str) -> Result<(), BlobStoreError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_archive_export_produces_valid_zip_with_manifest_first() {
        let temp_dir_path = std::env::temp_dir().join(format!("trame_test_{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir_path)
            .await
            .expect("create test temp dir");
        let store = LocalFsStore::new(&temp_dir_path);

        let asset1_id = Uuid::new_v4();
        let asset1_bytes = b"RIFF....WEBPVP8 ...fake webp 1...";
        store
            .put_stream(&asset1_id.to_string(), slice_to_stream(asset1_bytes))
            .await
            .expect("put asset 1");

        let asset2_id = Uuid::new_v4();
        let asset2_bytes = b"RIFF....WEBPVP8 ...fake webp 2...";
        store
            .put_stream(&asset2_id.to_string(), slice_to_stream(asset2_bytes))
            .await
            .expect("put asset 2");

        let campaign_id = Uuid::new_v4();
        let campaign_meta = CampaignMetadata {
            id: campaign_id,
            name: "Curse of the Obsidian Spire".to_string(),
            system: "dnd5e".to_string(),
            description: Some("Campaign export with full scene and actor state.".to_string()),
            created_at: "2025-01-10T18:00:00Z".to_string(),
        };

        let scene_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let entities = vec![
            ExportEntity {
                entity_type: "campaign".to_string(),
                data: json!({
                    "id": campaign_id,
                    "name": "Curse of the Obsidian Spire",
                    "system": "dnd5e",
                    "created_at": "2025-01-10T18:00:00Z"
                }),
            },
            ExportEntity {
                entity_type: "scene".to_string(),
                data: json!({
                    "id": scene_id,
                    "campaign_id": campaign_id,
                    "name": "Cathedral Entrance",
                    "grid_size": 70,
                    "width": 2800,
                    "height": 2100
                }),
            },
            ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": actor_id,
                    "campaign_id": campaign_id,
                    "name": "Gideon Ironheart",
                    "kind": "character",
                    "sheet": {
                        "hp": 28,
                        "ac": 16
                    }
                }),
            },
        ];

        let note1_id = Uuid::new_v4();
        let author_id = Uuid::new_v4();
        let notes = vec![
            NoteRecord {
                id: note1_id,
                title: "Campaign Overview".to_string(),
                folder: None,
                author_id,
                created_at: "2025-02-01T10:00:00Z".to_string(),
                updated_at: "2025-02-05T14:20:00Z".to_string(),
                content_markdown: "# Campaign Overview\n\nWelcome to the Obsidian Spire."
                    .to_string(),
            },
            NoteRecord {
                id: Uuid::new_v4(),
                title: "Harpers Infiltration Plan".to_string(),
                folder: Some("factions".to_string()),
                author_id,
                created_at: "2025-02-02T12:00:00Z".to_string(),
                updated_at: "2025-02-06T15:00:00Z".to_string(),
                content_markdown: "# Harpers Infiltration Plan\n\nContact agent Gideon Ironheart."
                    .to_string(),
            },
        ];

        let source = MockExportSource {
            campaign: campaign_meta,
            entities,
            notes,
            asset_ids: vec![asset1_id, asset2_id],
        };

        let exporter = ArchiveExporter::new(source, store.clone());
        let mut export_stream = exporter.export_stream().await.expect("export stream");

        let mut zip_bytes = Vec::new();
        while let Some(chunk_res) = export_stream.next().await {
            let chunk = chunk_res.expect("chunk ok");
            zip_bytes.extend_from_slice(&chunk);
        }

        assert!(!zip_bytes.is_empty(), "zip bytes must not be empty");
        assert!(
            zip_bytes.starts_with(b"PK\x03\x04"),
            "ZIP archive must start with PK local file header"
        );

        let reader = Cursor::new(zip_bytes);
        let mut zip_reader = async_zip::tokio::read::seek::ZipFileReader::with_tokio(reader)
            .await
            .expect("parse zip");

        let entry_filenames: Vec<String> = zip_reader
            .file()
            .entries()
            .iter()
            .map(|e| e.filename().as_str().expect("utf8 filename").to_string())
            .collect();
        assert!(
            !entry_filenames.is_empty(),
            "Archive must contain at least one entry"
        );
        assert_eq!(
            entry_filenames[0], "manifest.json",
            "First entry must be manifest.json"
        );

        let mut manifest_reader = zip_reader
            .reader_with_entry(0)
            .await
            .expect("entry 0 reader");
        let mut manifest_raw = String::new();
        manifest_reader
            .read_to_string_checked(&mut manifest_raw)
            .await
            .expect("read manifest");

        let manifest: CampaignManifest =
            serde_json::from_str(&manifest_raw).expect("valid manifest json");
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.generator, "trame-server 0.1.0");
        assert_eq!(manifest.campaign.id, campaign_id);
        assert_eq!(manifest.stats.actor_count, 1);
        assert_eq!(manifest.stats.scene_count, 1);
        assert_eq!(manifest.stats.note_count, 2);
        assert_eq!(manifest.stats.asset_count, 2);

        for entry_desc in &manifest.entries {
            let zip_idx = entry_filenames
                .iter()
                .position(|filename| filename == &entry_desc.path)
                .unwrap_or_else(|| panic!("entry {} not found in zip", entry_desc.path));

            let mut entry_reader = zip_reader
                .reader_with_entry(zip_idx)
                .await
                .expect("entry reader");
            let mut content = Vec::new();
            entry_reader
                .read_to_end_checked(&mut content)
                .await
                .expect("read entry content");

            assert_eq!(
                content.len() as u64,
                entry_desc.byte_size,
                "byte_size mismatch for {}",
                entry_desc.path
            );
            let digest = Sha256Hasher::digest(&content);
            assert_eq!(
                digest, entry_desc.sha256,
                "sha256 mismatch for {}",
                entry_desc.path
            );
        }

        let _ = tokio::fs::remove_dir_all(&temp_dir_path).await;
    }

    #[test]
    fn test_note_serialization_commonmark_and_yaml_frontmatter() {
        let id = Uuid::parse_str("7b354366-0ec1-456e-8260-2ff0d4e9c71f").unwrap();
        let author_id = Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap();
        let note = NoteRecord {
            id,
            title: "Harpers Infiltration Plan".to_string(),
            folder: Some("factions".to_string()),
            author_id,
            created_at: "2025-02-01T10:00:00Z".to_string(),
            updated_at: "2025-02-05T14:20:00Z".to_string(),
            content_markdown: "# Harpers Infiltration Plan\n\nSecret instructions.".to_string(),
        };

        let serialized = note.serialize_file();
        assert!(serialized.starts_with("---\n"));
        assert!(serialized.contains("id: 7b354366-0ec1-456e-8260-2ff0d4e9c71f\n"));
        assert!(serialized.contains("title: Harpers Infiltration Plan\n"));
        assert!(serialized.contains("folder: factions\n"));
        assert!(serialized.contains("author_id: 11111111-2222-3333-4444-555555555555\n"));
        assert!(serialized.contains("created_at: 2025-02-01T10:00:00Z\n"));
        assert!(serialized.contains("updated_at: 2025-02-05T14:20:00Z\n"));
        assert!(serialized.contains("---\n\n# Harpers Infiltration Plan"));
        assert_eq!(
            note.archive_path(),
            "notes/factions/harpers-infiltration-plan.md"
        );
    }

    #[test]
    fn test_note_serialization_root_folder() {
        let id = Uuid::new_v4();
        let author_id = Uuid::new_v4();
        let note = NoteRecord {
            id,
            title: "Campaign Overview".to_string(),
            folder: None,
            author_id,
            created_at: "2025-02-01T10:00:00Z".to_string(),
            updated_at: "2025-02-05T14:20:00Z".to_string(),
            content_markdown: "Content".to_string(),
        };
        assert_eq!(note.archive_path(), "notes/campaign-overview.md");
        let serialized = note.serialize_file();
        assert!(serialized.contains("folder: null\n"));
    }

    #[test]
    fn test_note_archive_path_zip_slip_sanitization() {
        let id = Uuid::new_v4();
        let author_id = Uuid::new_v4();

        let note_traversal = NoteRecord {
            id,
            title: "Factions Dossier".to_string(),
            folder: Some("../../factions".to_string()),
            author_id,
            created_at: "2025-02-01T10:00:00Z".to_string(),
            updated_at: "2025-02-05T14:20:00Z".to_string(),
            content_markdown: "Secret notes".to_string(),
        };
        assert_eq!(
            note_traversal.archive_path(),
            "notes/factions/factions-dossier.md"
        );

        let note_windows = NoteRecord {
            id,
            title: "System Config".to_string(),
            folder: Some("..\\..\\system".to_string()),
            author_id,
            created_at: "2025-02-01T10:00:00Z".to_string(),
            updated_at: "2025-02-05T14:20:00Z".to_string(),
            content_markdown: "Secret notes".to_string(),
        };
        assert_eq!(note_windows.archive_path(), "notes/system/system-config.md");

        let note_all_dots = NoteRecord {
            id,
            title: "Dot Note".to_string(),
            folder: Some("../../../.".to_string()),
            author_id,
            created_at: "2025-02-01T10:00:00Z".to_string(),
            updated_at: "2025-02-05T14:20:00Z".to_string(),
            content_markdown: "Secret notes".to_string(),
        };
        assert_eq!(note_all_dots.archive_path(), "notes/dot-note.md");
    }

    #[tokio::test]
    async fn test_export_stream_propagates_write_archive_error() {
        let source = MockExportSource {
            campaign: CampaignMetadata {
                id: Uuid::new_v4(),
                name: "Failing Export".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            entities: Vec::new(),
            notes: Vec::new(),
            asset_ids: vec![Uuid::new_v4()],
        };

        let exporter = ArchiveExporter::new(source, FailingBlobStore);
        let mut stream = exporter
            .export_stream()
            .await
            .expect("export stream starts");

        let mut caught_err = false;
        while let Some(chunk_res) = stream.next().await {
            if let Err(ArchiveExportError::Storage(BlobStoreError::NotFound(_))) = chunk_res {
                caught_err = true;
                break;
            }
        }
        assert!(
            caught_err,
            "Error in write_archive must propagate through export_stream"
        );
    }

    #[tokio::test]
    async fn test_archive_exporter_streams_large_assets_below_16_mib_heap_ceiling() {
        // Stream a 20 MiB asset (> 16 MiB heap ceiling) via 64 KiB chunks while consuming
        // the output stream chunk-by-chunk, verifying that peak in-flight buffer size stays
        // strictly below the 16 MiB (16,777,216 bytes) ceiling.
        const SIXTEEN_MIB: usize = 16 * 1024 * 1024;
        const ASSET_BYTES: usize = 20 * 1024 * 1024;

        let temp_dir_path = std::env::temp_dir().join(format!("trame_mem_test_{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir_path)
            .await
            .expect("create temp dir");
        let store = LocalFsStore::new(&temp_dir_path);

        let asset_id = Uuid::new_v4();
        let chunk_64k = bytes::Bytes::from(vec![0x57u8; 64 * 1024]);
        let num_chunks = ASSET_BYTES / (64 * 1024);
        let input_stream = Box::pin(futures_util::stream::iter(
            (0..num_chunks).map(move |_| Ok(chunk_64k.clone())),
        ));
        store
            .put_stream(&asset_id.to_string(), input_stream)
            .await
            .expect("put 20 MiB streamed asset");

        let campaign_id = Uuid::new_v4();
        let source = MockExportSource {
            campaign: CampaignMetadata {
                id: campaign_id,
                name: "Memory Ceiling Verification".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2026-10-30T00:00:00Z".to_string(),
            },
            entities: Vec::new(),
            notes: Vec::new(),
            asset_ids: vec![asset_id],
        };

        let exporter = ArchiveExporter::new(source, store);
        let mut export_stream = exporter.export_stream().await.expect("start export stream");

        let mut total_streamed_bytes = 0usize;
        let mut max_chunk_bytes = 0usize;
        while let Some(chunk_res) = export_stream.next().await {
            let chunk = chunk_res.expect("stream chunk ok");
            max_chunk_bytes = max_chunk_bytes.max(chunk.len());
            assert!(
                chunk.len() < SIXTEEN_MIB,
                "Single streamed chunk ({}) must stay strictly below 16 MiB ceiling",
                chunk.len()
            );
            total_streamed_bytes += chunk.len();
        }

        assert!(
            total_streamed_bytes >= ASSET_BYTES,
            "Streamed archive total ({total_streamed_bytes}) must include full 20 MiB asset"
        );
        assert!(
            max_chunk_bytes <= 64 * 1024,
            "Max chunk buffer ({max_chunk_bytes}) must remain bounded by 64 KiB duplex window (< 16 MiB)"
        );

        let _ = tokio::fs::remove_dir_all(&temp_dir_path).await;
    }
}
