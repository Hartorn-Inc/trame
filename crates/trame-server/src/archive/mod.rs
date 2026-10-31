//! ============================================================================
//! PURPOSE:
//!   Exposes the portable `.trame` campaign archive subsystem (`manifest`,
//!   `exporter`, and `importer`) for streaming export and import of campaign
//!   state, CommonMark wiki notes, and WebP assets.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Every `.trame` archive starts with `manifest.json` at entry 0 and
//!     enforces per-entry SHA-256 checksums and byte sizes.
//!   - Export and import operations stream in bounded 64 KiB chunks to stay
//!     within the 16 MiB RAM budget.
//!
//! EXECUTION LIFECYCLE:
//!   1. `ArchiveExporter` streams `manifest.json`, `database.jsonl`,
//!      `notes/*.md`, and `assets/*.webp` into a PKWARE ZIP byte stream.
//!   2. `ArchiveImporter` validates `manifest.json`, verifies entry digests,
//!      optionally remaps UUIDs and wikilinks, and persists restored data.
//! ============================================================================

pub mod exporter;
pub mod importer;
pub mod manifest;

pub use exporter::{
    ArchiveExportError, ArchiveExporter, CampaignExportSource, ExportEntity, NoteRecord,
};
pub use importer::{
    ArchiveError, ArchiveImporter, CampaignImportTarget, ImportOptions, ImportResult,
    InMemoryCampaignStore, parse_note_file, rewrite_wikilinks,
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

    #[tokio::test]
    async fn test_archive_importer_halts_with_invalid_manifest_when_initial_entry_not_manifest() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let mut zip_bytes = Vec::new();
        {
            let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
            let builder = ZipEntryBuilder::new("database.jsonl".into(), Compression::Stored);
            let mut sink = writer.write_entry_stream(builder).await.unwrap();
            sink.write_all(b"{}").await.unwrap();
            sink.close().await.unwrap();
            writer.close().await.unwrap();
        }

        let target = InMemoryCampaignStore::new();
        let temp_dir = std::env::temp_dir().join(format!("trame_imp_test_{}", Uuid::new_v4()));
        let blob_store = LocalFsStore::new(&temp_dir);
        let importer = ArchiveImporter::new(target, blob_store);

        let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
        match result {
            Err(ArchiveError::InvalidManifest(msg)) => {
                assert!(msg.contains("initial entry must be manifest.json"));
            }
            other => panic!("Expected ArchiveError::InvalidManifest, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_archive_importer_validates_checksum_and_rejects_checksum_mismatch() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let campaign_id = Uuid::new_v4();
        let manifest = CampaignManifest::new(
            CampaignMetadata {
                id: campaign_id,
                name: "Corrupted Archive".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            "2025-01-01T00:00:00Z".to_string(),
            ManifestStats::default(),
            vec![ArchiveEntryDescriptor {
                path: "database.jsonl".to_string(),
                byte_size: 10,
                sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                    .to_string(),
            }],
        );

        let mut zip_bytes = Vec::new();
        {
            let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
            let m_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            let m_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Stored);
            let mut m_sink = writer.write_entry_stream(m_builder).await.unwrap();
            m_sink.write_all(&m_bytes).await.unwrap();
            m_sink.close().await.unwrap();

            let db_builder = ZipEntryBuilder::new("database.jsonl".into(), Compression::Stored);
            let mut db_sink = writer.write_entry_stream(db_builder).await.unwrap();
            db_sink.write_all(b"0123456789").await.unwrap();
            db_sink.close().await.unwrap();
            writer.close().await.unwrap();
        }

        let target = InMemoryCampaignStore::new();
        let temp_dir = std::env::temp_dir().join(format!("trame_imp_test_{}", Uuid::new_v4()));
        let blob_store = LocalFsStore::new(&temp_dir);
        let importer = ArchiveImporter::new(target, blob_store);

        let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
        match result {
            Err(ArchiveError::ChecksumMismatch { path, .. }) => {
                assert_eq!(path, "database.jsonl");
            }
            other => panic!("Expected ArchiveError::ChecksumMismatch, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_archive_importer_rejects_unlisted_entries() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let campaign_id = Uuid::new_v4();
        let manifest = CampaignManifest::new(
            CampaignMetadata {
                id: campaign_id,
                name: "Unlisted Entry Test".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            "2025-01-01T00:00:00Z".to_string(),
            ManifestStats::default(),
            Vec::new(),
        );

        let mut zip_bytes = Vec::new();
        {
            let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
            let m_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            let m_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Stored);
            let mut m_sink = writer.write_entry_stream(m_builder).await.unwrap();
            m_sink.write_all(&m_bytes).await.unwrap();
            m_sink.close().await.unwrap();

            let rogue_builder =
                ZipEntryBuilder::new("rogue_payload.sh".into(), Compression::Stored);
            let mut rogue_sink = writer.write_entry_stream(rogue_builder).await.unwrap();
            rogue_sink.write_all(b"echo rogue").await.unwrap();
            rogue_sink.close().await.unwrap();
            writer.close().await.unwrap();
        }

        let target = InMemoryCampaignStore::new();
        let temp_dir = std::env::temp_dir().join(format!("trame_imp_test_{}", Uuid::new_v4()));
        let blob_store = LocalFsStore::new(&temp_dir);
        let importer = ArchiveImporter::new(target, blob_store);

        let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
        match result {
            Err(ArchiveError::UnlistedEntry(path)) => {
                assert_eq!(path, "rogue_payload.sh");
            }
            other => panic!("Expected ArchiveError::UnlistedEntry, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_archive_importer_enforces_fail_if_exists_collision_policy() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let campaign_id = Uuid::new_v4();
        let manifest = CampaignManifest::new(
            CampaignMetadata {
                id: campaign_id,
                name: "Existing Campaign".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            "2025-01-01T00:00:00Z".to_string(),
            ManifestStats::default(),
            Vec::new(),
        );

        let mut zip_bytes = Vec::new();
        {
            let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
            let m_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            let m_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Stored);
            let mut m_sink = writer.write_entry_stream(m_builder).await.unwrap();
            m_sink.write_all(&m_bytes).await.unwrap();
            m_sink.close().await.unwrap();
            writer.close().await.unwrap();
        }

        let target = InMemoryCampaignStore::with_campaign(manifest.campaign.clone());
        let temp_dir = std::env::temp_dir().join(format!("trame_imp_test_{}", Uuid::new_v4()));
        let blob_store = LocalFsStore::new(&temp_dir);
        let importer = ArchiveImporter::new(target, blob_store);

        let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
        match result {
            Err(ArchiveError::CampaignAlreadyExists(id)) => {
                assert_eq!(id, campaign_id);
            }
            other => panic!("Expected ArchiveError::CampaignAlreadyExists, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_archive_importer_remapping_mode_rewrites_uuids_wikilinks_and_assets() {
        let temp_dir_export = std::env::temp_dir().join(format!("trame_exp_{}", Uuid::new_v4()));
        let temp_dir_import = std::env::temp_dir().join(format!("trame_imp_{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir_export).await.unwrap();
        tokio::fs::create_dir_all(&temp_dir_import).await.unwrap();

        let export_store = LocalFsStore::new(&temp_dir_export);
        let import_store = LocalFsStore::new(&temp_dir_import);

        let asset_id = Uuid::new_v4();
        let asset_bytes = b"RIFF....WEBPVP8 ...remap test asset...";
        export_store
            .put_stream(&asset_id.to_string(), slice_to_stream(asset_bytes))
            .await
            .unwrap();

        let campaign_id = Uuid::new_v4();
        let scene_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let note_id = Uuid::new_v4();
        let author_id = Uuid::new_v4();

        let entities = vec![
            ExportEntity {
                entity_type: "scene".to_string(),
                data: json!({
                    "id": scene_id,
                    "campaign_id": campaign_id,
                    "name": "Cathedral Entrance"
                }),
            },
            ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": actor_id,
                    "campaign_id": campaign_id,
                    "name": "Gideon Ironheart"
                }),
            },
        ];

        let raw_note_markdown = format!(
            "# Notes\n\nContact agent [[{actor_id}|Gideon Ironheart]] at the front gate.\nCheck scene [[{scene_id}]] for sentinels."
        );

        let notes = vec![NoteRecord {
            id: note_id,
            title: "Infiltration Plan".to_string(),
            folder: Some("tactics".to_string()),
            author_id,
            created_at: "2025-02-01T10:00:00Z".to_string(),
            updated_at: "2025-02-05T14:20:00Z".to_string(),
            content_markdown: raw_note_markdown,
        }];

        let source = MockExportSource {
            campaign: CampaignMetadata {
                id: campaign_id,
                name: "Remap Source Campaign".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            entities,
            notes,
            asset_ids: vec![asset_id],
        };

        let exporter = ArchiveExporter::new(source, export_store);
        let mut export_stream = exporter.export_stream().await.unwrap();
        let mut zip_bytes = Vec::new();
        while let Some(chunk_res) = export_stream.next().await {
            zip_bytes.extend_from_slice(&chunk_res.unwrap());
        }

        let target = InMemoryCampaignStore::new();
        let importer = ArchiveImporter::new(target.clone(), import_store.clone());
        let result = importer
            .import_stream(Cursor::new(zip_bytes), true)
            .await
            .expect("remapping import succeeds");

        assert_ne!(
            result.campaign_id, campaign_id,
            "Campaign ID must be remapped"
        );
        assert_eq!(result.actors_restored, 1);
        assert_eq!(result.scenes_restored, 1);
        assert_eq!(result.notes_restored, 1);
        assert_eq!(result.assets_restored, 1);

        let saved_entities = target.all_entities();
        assert_eq!(saved_entities.len(), 2);
        let saved_scene = saved_entities
            .iter()
            .find(|e| e.entity_type == "scene")
            .unwrap();
        let new_scene_id = Uuid::parse_str(saved_scene.data["id"].as_str().unwrap()).unwrap();
        assert_ne!(new_scene_id, scene_id);
        assert_eq!(
            saved_scene.data["campaign_id"].as_str().unwrap(),
            result.campaign_id.to_string()
        );

        let saved_actor = saved_entities
            .iter()
            .find(|e| e.entity_type == "actor")
            .unwrap();
        let new_actor_id = Uuid::parse_str(saved_actor.data["id"].as_str().unwrap()).unwrap();
        assert_ne!(new_actor_id, actor_id);
        assert_eq!(
            saved_actor.data["campaign_id"].as_str().unwrap(),
            result.campaign_id.to_string()
        );

        let saved_notes = target.all_notes();
        assert_eq!(saved_notes.len(), 1);
        let saved_note = &saved_notes[0];
        assert_ne!(saved_note.id, note_id);
        assert_ne!(saved_note.author_id, author_id);
        assert!(
            saved_note
                .content_markdown
                .contains(&format!("[[{new_actor_id}|Gideon Ironheart]]")),
            "Aliased wikilink must be rewritten to new actor UUID with preserved label"
        );
        assert!(
            saved_note
                .content_markdown
                .contains(&format!("[[{new_scene_id}]]")),
            "Unlabeled wikilink must be rewritten to new scene UUID"
        );
        assert!(!saved_note.content_markdown.contains(&actor_id.to_string()));
        assert!(!saved_note.content_markdown.contains(&scene_id.to_string()));

        let stored_descriptors = import_store.list_descriptors().await.unwrap();
        assert_eq!(stored_descriptors.len(), 1);
        let new_asset_id_str = &stored_descriptors[0].id;
        assert_ne!(new_asset_id_str, &asset_id.to_string());
        assert!(Uuid::parse_str(new_asset_id_str).is_ok());

        let _ = tokio::fs::remove_dir_all(&temp_dir_export).await;
        let _ = tokio::fs::remove_dir_all(&temp_dir_import).await;
    }

    #[tokio::test]
    async fn test_archive_importer_nominal_import_without_remapping() {
        let temp_dir_export =
            std::env::temp_dir().join(format!("trame_exp_nom_{}", Uuid::new_v4()));
        let temp_dir_import =
            std::env::temp_dir().join(format!("trame_imp_nom_{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir_export).await.unwrap();
        tokio::fs::create_dir_all(&temp_dir_import).await.unwrap();

        let export_store = LocalFsStore::new(&temp_dir_export);
        let import_store = LocalFsStore::new(&temp_dir_import);

        let asset_id = Uuid::new_v4();
        let asset_bytes = b"RIFF....WEBPVP8 ...nominal test asset...";
        export_store
            .put_stream(&asset_id.to_string(), slice_to_stream(asset_bytes))
            .await
            .unwrap();

        let campaign_id = Uuid::new_v4();
        let scene_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let note_id = Uuid::new_v4();
        let author_id = Uuid::new_v4();

        let entities = vec![
            ExportEntity {
                entity_type: "scene".to_string(),
                data: json!({
                    "id": scene_id,
                    "campaign_id": campaign_id,
                    "name": "Courtyard"
                }),
            },
            ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": actor_id,
                    "campaign_id": campaign_id,
                    "name": "Astarion"
                }),
            },
        ];

        let notes = vec![NoteRecord {
            id: note_id,
            title: "Camp Notes".to_string(),
            folder: None,
            author_id,
            created_at: "2025-02-01T10:00:00Z".to_string(),
            updated_at: "2025-02-05T14:20:00Z".to_string(),
            content_markdown: format!("# Camp\n\nMeet [[{actor_id}|Astarion]]."),
        }];

        let source = MockExportSource {
            campaign: CampaignMetadata {
                id: campaign_id,
                name: "Nominal Campaign".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            entities,
            notes,
            asset_ids: vec![asset_id],
        };

        let exporter = ArchiveExporter::new(source, export_store);
        let mut export_stream = exporter.export_stream().await.unwrap();
        let mut zip_bytes = Vec::new();
        while let Some(chunk_res) = export_stream.next().await {
            zip_bytes.extend_from_slice(&chunk_res.unwrap());
        }

        let target = InMemoryCampaignStore::new();
        let importer = ArchiveImporter::new(target.clone(), import_store.clone());
        let result = importer
            .import(Cursor::new(zip_bytes), ImportOptions { remap_ids: false })
            .await
            .expect("nominal import succeeds");

        assert_eq!(
            result.campaign_id, campaign_id,
            "Campaign ID must be preserved"
        );
        assert_eq!(result.actors_restored, 1);
        assert_eq!(result.scenes_restored, 1);
        assert_eq!(result.notes_restored, 1);
        assert_eq!(result.assets_restored, 1);

        let saved_campaign = target.get_campaign(&campaign_id).expect("campaign saved");
        assert_eq!(saved_campaign.name, "Nominal Campaign");

        let saved_entities = target.all_entities();
        assert_eq!(saved_entities.len(), 2);
        let saved_actor = saved_entities
            .iter()
            .find(|e| e.entity_type == "actor")
            .unwrap();
        assert_eq!(saved_actor.data["id"], actor_id.to_string());

        let saved_notes = target.all_notes();
        assert_eq!(saved_notes.len(), 1);
        assert_eq!(saved_notes[0].id, note_id);
        assert!(
            saved_notes[0]
                .content_markdown
                .contains(&actor_id.to_string())
        );

        let desc = import_store
            .get_descriptor(&asset_id.to_string())
            .await
            .unwrap();
        assert_eq!(desc.id, asset_id.to_string());

        let _ = tokio::fs::remove_dir_all(&temp_dir_export).await;
        let _ = tokio::fs::remove_dir_all(&temp_dir_import).await;
    }

    #[tokio::test]
    async fn test_archive_importer_validates_asset_checksum_mismatch() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let campaign_id = Uuid::new_v4();
        let asset_id = Uuid::new_v4();
        let manifest = CampaignManifest::new(
            CampaignMetadata {
                id: campaign_id,
                name: "Corrupted Asset Archive".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            "2025-01-01T00:00:00Z".to_string(),
            ManifestStats::default(),
            vec![ArchiveEntryDescriptor {
                path: format!("assets/{asset_id}.webp"),
                byte_size: 10,
                sha256: "0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
            }],
        );

        let mut zip_bytes = Vec::new();
        {
            let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
            let m_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            let m_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Stored);
            let mut m_sink = writer.write_entry_stream(m_builder).await.unwrap();
            m_sink.write_all(&m_bytes).await.unwrap();
            m_sink.close().await.unwrap();

            let a_builder = ZipEntryBuilder::new(
                format!("assets/{asset_id}.webp").into(),
                Compression::Stored,
            );
            let mut a_sink = writer.write_entry_stream(a_builder).await.unwrap();
            a_sink.write_all(b"0123456789").await.unwrap();
            a_sink.close().await.unwrap();
            writer.close().await.unwrap();
        }

        let target = InMemoryCampaignStore::new();
        let temp_dir =
            std::env::temp_dir().join(format!("trame_imp_corrupt_asset_{}", Uuid::new_v4()));
        let blob_store = LocalFsStore::new(&temp_dir);
        let importer = ArchiveImporter::new(target, blob_store.clone());

        let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
        match result {
            Err(ArchiveError::ChecksumMismatch { path, .. }) => {
                assert_eq!(path, format!("assets/{asset_id}.webp"));
            }
            other => panic!("Expected ArchiveError::ChecksumMismatch, got: {other:?}"),
        }

        let descriptors = blob_store.list_descriptors().await.unwrap();
        assert!(
            descriptors.is_empty(),
            "No asset should be stored on checksum failure"
        );

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_archive_importer_halts_on_empty_archive() {
        use async_zip::tokio::write::ZipFileWriter;

        let mut zip_bytes = Vec::new();
        {
            let writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
            writer.close().await.unwrap();
        }

        let target = InMemoryCampaignStore::new();
        let temp_dir = std::env::temp_dir().join(format!("trame_imp_empty_{}", Uuid::new_v4()));
        let blob_store = LocalFsStore::new(&temp_dir);
        let importer = ArchiveImporter::new(target, blob_store);

        let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
        match result {
            Err(ArchiveError::InvalidManifest(msg)) => {
                assert!(msg.contains("archive is empty"));
            }
            other => panic!("Expected ArchiveError::InvalidManifest, got: {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_archive_importer_streams_large_asset_below_16_mib_heap_ceiling() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        const ASSET_BYTES: usize = 2 * 1024 * 1024;
        let campaign_id = Uuid::new_v4();
        let asset_id = Uuid::new_v4();
        let chunk_64k = vec![0x7au8; 64 * 1024];
        let num_chunks = ASSET_BYTES / (64 * 1024);

        let mut hasher = Sha256Hasher::new();
        for _ in 0..num_chunks {
            hasher.update(&chunk_64k);
        }
        let expected_sha256 = hasher.finalize_hex();

        let manifest = CampaignManifest::new(
            CampaignMetadata {
                id: campaign_id,
                name: "Large Asset Import Test".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2025-01-01T00:00:00Z".to_string(),
            },
            "2025-01-01T00:00:00Z".to_string(),
            ManifestStats::default(),
            vec![ArchiveEntryDescriptor {
                path: format!("assets/{asset_id}.webp"),
                byte_size: ASSET_BYTES as u64,
                sha256: expected_sha256,
            }],
        );

        let mut zip_bytes = Vec::new();
        {
            let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
            let m_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            let m_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Stored);
            let mut m_sink = writer.write_entry_stream(m_builder).await.unwrap();
            m_sink.write_all(&m_bytes).await.unwrap();
            m_sink.close().await.unwrap();

            let a_builder = ZipEntryBuilder::new(
                format!("assets/{asset_id}.webp").into(),
                Compression::Stored,
            );
            let mut a_sink = writer.write_entry_stream(a_builder).await.unwrap();
            for _ in 0..num_chunks {
                a_sink.write_all(&chunk_64k).await.unwrap();
            }
            a_sink.close().await.unwrap();
            writer.close().await.unwrap();
        }

        let target = InMemoryCampaignStore::new();
        let temp_dir = std::env::temp_dir().join(format!("trame_imp_large_{}", Uuid::new_v4()));
        let blob_store = LocalFsStore::new(&temp_dir);
        let importer = ArchiveImporter::new(target, blob_store.clone());

        let result = importer
            .import_stream(Cursor::new(zip_bytes), false)
            .await
            .expect("large asset import succeeds");

        assert_eq!(result.assets_restored, 1);
        let desc = blob_store
            .get_descriptor(&asset_id.to_string())
            .await
            .unwrap();
        assert_eq!(desc.byte_size, ASSET_BYTES as u64);

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_archive_importer_parameterized_manifest_first_entry_violations() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let invalid_initial_entries = [
            "database.jsonl",
            "notes/campaign-overview.md",
            "assets/preview.webp",
            "unknown_file.txt",
        ];

        for initial_entry in invalid_initial_entries {
            let mut zip_bytes = Vec::new();
            {
                let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
                let builder = ZipEntryBuilder::new(initial_entry.into(), Compression::Stored);
                let mut sink = writer.write_entry_stream(builder).await.unwrap();
                sink.write_all(b"sample payload").await.unwrap();
                sink.close().await.unwrap();
                writer.close().await.unwrap();
            }

            let target = InMemoryCampaignStore::new();
            let temp_dir =
                std::env::temp_dir().join(format!("trame_imp_param_init_{}", Uuid::new_v4()));
            let blob_store = LocalFsStore::new(&temp_dir);
            let importer = ArchiveImporter::new(target, blob_store);

            let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
            match result {
                Err(ArchiveError::InvalidManifest(msg)) => {
                    assert!(
                        msg.contains("initial entry must be manifest.json"),
                        "Expected initial entry error for {initial_entry}, got {msg}"
                    );
                }
                other => panic!(
                    "Expected ArchiveError::InvalidManifest for {initial_entry}, got: {other:?}"
                ),
            }

            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        }
    }

    #[tokio::test]
    async fn test_archive_importer_parameterized_unlisted_entry_rejection() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let unlisted_paths = [
            "rogue_script.sh",
            "notes/unlisted.md",
            "assets/unlisted.webp",
            "extra/database_backup.sql",
        ];

        for unlisted_path in unlisted_paths {
            let campaign_id = Uuid::new_v4();
            let manifest = CampaignManifest::new(
                CampaignMetadata {
                    id: campaign_id,
                    name: "Unlisted Path Test".to_string(),
                    system: "dnd5e".to_string(),
                    description: None,
                    created_at: "2025-01-01T00:00:00Z".to_string(),
                },
                "2025-01-01T00:00:00Z".to_string(),
                ManifestStats::default(),
                Vec::new(),
            );

            let mut zip_bytes = Vec::new();
            {
                let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
                let m_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
                let m_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Stored);
                let mut m_sink = writer.write_entry_stream(m_builder).await.unwrap();
                m_sink.write_all(&m_bytes).await.unwrap();
                m_sink.close().await.unwrap();

                let rogue_builder = ZipEntryBuilder::new(unlisted_path.into(), Compression::Stored);
                let mut rogue_sink = writer.write_entry_stream(rogue_builder).await.unwrap();
                rogue_sink.write_all(b"rogue data").await.unwrap();
                rogue_sink.close().await.unwrap();
                writer.close().await.unwrap();
            }

            let target = InMemoryCampaignStore::new();
            let temp_dir =
                std::env::temp_dir().join(format!("trame_imp_param_unlisted_{}", Uuid::new_v4()));
            let blob_store = LocalFsStore::new(&temp_dir);
            let importer = ArchiveImporter::new(target, blob_store);

            let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
            match result {
                Err(ArchiveError::UnlistedEntry(path)) => {
                    assert_eq!(path, unlisted_path);
                }
                other => panic!(
                    "Expected ArchiveError::UnlistedEntry for {unlisted_path}, got: {other:?}"
                ),
            }

            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        }
    }

    #[tokio::test]
    async fn test_archive_importer_parameterized_checksum_mismatches() {
        use async_zip::tokio::write::ZipFileWriter;
        use async_zip::{Compression, ZipEntryBuilder};
        use futures_lite::io::AsyncWriteExt;

        let asset_id = Uuid::new_v4();
        let asset_path = format!("assets/{asset_id}.webp");
        let test_cases = [
            (
                "database.jsonl",
                "{\"entity_type\":\"scene\",\"data\":{}}\n",
            ),
            (
                "notes/overview.md",
                "---\nid: 00000000-0000-0000-0000-000000000001\ntitle: T\nauthor_id: 00000000-0000-0000-0000-000000000002\n---\n\n# Note",
            ),
            (asset_path.as_str(), "RIFFFAKEWEBP"),
        ];

        for (entry_path, content) in test_cases {
            let campaign_id = Uuid::new_v4();
            let manifest = CampaignManifest::new(
                CampaignMetadata {
                    id: campaign_id,
                    name: "Corrupt Entry Test".to_string(),
                    system: "dnd5e".to_string(),
                    description: None,
                    created_at: "2025-01-01T00:00:00Z".to_string(),
                },
                "2025-01-01T00:00:00Z".to_string(),
                ManifestStats::default(),
                vec![ArchiveEntryDescriptor {
                    path: entry_path.to_string(),
                    byte_size: content.len() as u64,
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000"
                        .to_string(),
                }],
            );

            let mut zip_bytes = Vec::new();
            {
                let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut zip_bytes));
                let m_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
                let m_builder = ZipEntryBuilder::new("manifest.json".into(), Compression::Stored);
                let mut m_sink = writer.write_entry_stream(m_builder).await.unwrap();
                m_sink.write_all(&m_bytes).await.unwrap();
                m_sink.close().await.unwrap();

                let e_builder = ZipEntryBuilder::new(entry_path.into(), Compression::Stored);
                let mut e_sink = writer.write_entry_stream(e_builder).await.unwrap();
                e_sink.write_all(content.as_bytes()).await.unwrap();
                e_sink.close().await.unwrap();
                writer.close().await.unwrap();
            }

            let target = InMemoryCampaignStore::new();
            let temp_dir =
                std::env::temp_dir().join(format!("trame_imp_param_chk_{}", Uuid::new_v4()));
            let blob_store = LocalFsStore::new(&temp_dir);
            let importer = ArchiveImporter::new(target, blob_store);

            let result = importer.import_stream(Cursor::new(zip_bytes), false).await;
            match result {
                Err(ArchiveError::ChecksumMismatch { path, .. }) => {
                    assert_eq!(path, entry_path);
                }
                other => panic!(
                    "Expected ArchiveError::ChecksumMismatch for {entry_path}, got: {other:?}"
                ),
            }

            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        }
    }
}
