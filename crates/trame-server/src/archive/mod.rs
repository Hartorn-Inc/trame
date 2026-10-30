//! Campaign archive exporter and importer (.trame) engine.

pub mod exporter;
pub mod manifest;

pub use exporter::{ArchiveExporter, CampaignExportSource, ExportEntity, NoteRecord};
pub use manifest::{ArchiveEntryDescriptor, CampaignManifest, CampaignMetadata, ManifestStats};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::LocalFsStore;
    use crate::storage::blob::{BlobStore, Sha256Hasher, slice_to_stream};
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
}
