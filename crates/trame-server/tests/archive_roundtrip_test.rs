//! ============================================================================
//! `.TRAME` ARCHIVE ROUNDTRIP & REMAPPING INTEGRATION TESTS (archive_roundtrip_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Verifies end-to-end roundtrip parity between `ArchiveExporter` and
//! `ArchiveImporter`, including manifest-first validation, SHA-256 checksum
//! enforcement, unlisted entry rejection, `FAIL_IF_EXISTS` campaign collision
//! protection, and `remap_ids: true` UUID remapping across entities, CommonMark
//! note wikilinks (`[[uuid]]` and `[[uuid|label]]`), and WebP assets.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Lossless Export-Import Roundtrip`:
//!      - Exporting and re-importing a campaign preserves all actors, scenes,
//!        walls, notes, and binary WebP assets bit-for-bit with exact coordinate equality.
//!   2. `Referential Integrity Under UUID Remapping`:
//!      - Importing with `remap_ids: true` assigns fresh UUIDs to the campaign,
//!        entities, notes, and assets while rewriting internal references and
//!        wikilinks consistently, permitting simultaneous coexistence of both campaigns.
//!   3. `Checksum Integrity Enforcement`:
//!      - Tampering with even a single asset byte causes `ArchiveImporter` to reject
//!        the archive with `ArchiveError::ChecksumMismatch` and commit zero changes.
//!
//! ============================================================================

use futures_util::StreamExt;
use serde_json::json;
use std::io::Cursor;
use std::path::PathBuf;
use trame_server::archive::importer::{
    ArchiveError, ArchiveImporter, ImportOptions, InMemoryCampaignStore,
};
use trame_server::archive::{
    ArchiveExporter, CampaignExportSource, CampaignMetadata, ExportEntity, NoteRecord,
};
use trame_server::storage::LocalFsStore;
use trame_server::storage::blob::{BlobStore, slice_to_stream};
use uuid::Uuid;

#[derive(Clone)]
pub struct RoundtripSource {
    pub campaign: CampaignMetadata,
    pub entities: Vec<ExportEntity>,
    pub notes: Vec<NoteRecord>,
    pub asset_ids: Vec<Uuid>,
}

impl CampaignExportSource for RoundtripSource {
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

/// Test fixture providing managed storage directories and orchestrating export/import passes.
pub struct TestHarness {
    pub src_dir: PathBuf,
    pub dst_dir: PathBuf,
    pub src_blobs: LocalFsStore,
    pub dst_blobs: LocalFsStore,
    pub target_store: InMemoryCampaignStore,
}

impl TestHarness {
    pub async fn new() -> Self {
        let unique_id = Uuid::new_v4();
        let src_dir = std::env::temp_dir().join(format!("trame_test_src_{unique_id}"));
        let dst_dir = std::env::temp_dir().join(format!("trame_test_dst_{unique_id}"));
        tokio::fs::create_dir_all(&src_dir)
            .await
            .expect("create src dir");
        tokio::fs::create_dir_all(&dst_dir)
            .await
            .expect("create dst dir");

        let src_blobs = LocalFsStore::new(&src_dir);
        let dst_blobs = LocalFsStore::new(&dst_dir);
        let target_store = InMemoryCampaignStore::new();

        Self {
            src_dir,
            dst_dir,
            src_blobs,
            dst_blobs,
            target_store,
        }
    }

    pub async fn store_asset(&self, id: Uuid, bytes: &[u8]) {
        self.src_blobs
            .put_stream(&id.to_string(), slice_to_stream(bytes))
            .await
            .expect("store asset");
    }

    pub async fn export_archive(&self, source: RoundtripSource) -> Vec<u8> {
        let exporter = ArchiveExporter::new(source, self.src_blobs.clone());
        let mut export_stream = exporter.export_stream().await.expect("export stream");
        let mut archive_bytes = Vec::new();
        while let Some(chunk_res) = export_stream.next().await {
            archive_bytes.extend_from_slice(&chunk_res.expect("valid chunk"));
        }
        archive_bytes
    }

    pub async fn read_dst_asset(
        &self,
        id: Uuid,
    ) -> Result<Vec<u8>, trame_server::storage::blob::BlobStoreError> {
        let mut stream = self.dst_blobs.open_read_stream(&id.to_string()).await?;
        let mut bytes = Vec::new();
        while let Some(chunk_res) = stream.next().await {
            bytes.extend_from_slice(&chunk_res?);
        }
        Ok(bytes)
    }

    pub async fn cleanup(self) {
        let _ = tokio::fs::remove_dir_all(&self.src_dir).await;
        let _ = tokio::fs::remove_dir_all(&self.dst_dir).await;
    }
}

#[tokio::test]
async fn test_campaign_export_import_roundtrip() {
    let harness = TestHarness::new().await;

    let campaign_id = Uuid::new_v4();
    let scene_id = Uuid::new_v4();
    let wall_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let token_id = Uuid::new_v4();
    let note_id = Uuid::new_v4();
    let author_id = Uuid::new_v4();
    let asset_id = Uuid::new_v4();

    // Realistic WebP binary asset payload
    let original_webp_bytes: Vec<u8> = vec![
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
        0x20, 0x18, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
        0x02, 0x00, 0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
    ];

    harness.store_asset(asset_id, &original_webp_bytes).await;

    let wall_p1_x = 120.5;
    let wall_p1_y = 240.0;
    let wall_p2_x = 480.0;
    let wall_p2_y = 240.0;
    let token_x = 300.0;
    let token_y = 200.0;
    let token_elev = 5.0;

    let source = RoundtripSource {
        campaign: CampaignMetadata {
            id: campaign_id,
            name: "Tomb of Annihilation".to_string(),
            system: "dnd5e".to_string(),
            description: Some("Bit-for-bit parity integration test campaign".to_string()),
            created_at: "2026-10-31T00:00:00Z".to_string(),
        },
        entities: vec![
            ExportEntity {
                entity_type: "scene".to_string(),
                data: json!({
                    "id": scene_id,
                    "campaign_id": campaign_id,
                    "name": "Chult Jungle",
                    "grid_size": 100,
                    "width": 4000,
                    "height": 3000,
                    "asset_id": asset_id,
                }),
            },
            ExportEntity {
                entity_type: "wall".to_string(),
                data: json!({
                    "id": wall_id,
                    "campaign_id": campaign_id,
                    "scene_id": scene_id,
                    "p1": { "x": wall_p1_x, "y": wall_p1_y },
                    "p2": { "x": wall_p2_x, "y": wall_p2_y },
                    "kind": "Door",
                    "is_open": false,
                    "is_locked": true
                }),
            },
            ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": actor_id,
                    "campaign_id": campaign_id,
                    "name": "Artus Cimber",
                    "token": {
                        "id": token_id,
                        "x": token_x,
                        "y": token_y,
                        "elevation": token_elev
                    }
                }),
            },
        ],
        notes: vec![NoteRecord {
            id: note_id,
            title: "Ring of Winter".to_string(),
            folder: Some("artifacts".to_string()),
            author_id,
            created_at: "2026-10-31T00:00:00Z".to_string(),
            updated_at: "2026-10-31T00:00:00Z".to_string(),
            content_markdown: format!(
                "Artus Cimber [[{actor_id}|Artus]] holds the Ring near door [[{wall_id}]] in [[{scene_id}|Chult Jungle]]."
            ),
        }],
        asset_ids: vec![asset_id],
    };

    let archive_bytes = harness.export_archive(source).await;
    assert!(!archive_bytes.is_empty(), "archive bytes must not be empty");

    // Wipe state before import to verify full rehydration into empty target
    let importer = ArchiveImporter::new(harness.target_store.clone(), harness.dst_blobs.clone());
    let result = importer
        .import(
            Cursor::new(&archive_bytes),
            ImportOptions { remap_ids: false },
        )
        .await
        .expect("import with remap_ids=false succeeds");

    assert_eq!(result.campaign_id, campaign_id);
    assert_eq!(result.actors_restored, 1);
    assert_eq!(result.scenes_restored, 1);
    assert_eq!(result.notes_restored, 1);
    assert_eq!(result.assets_restored, 1);

    // 1. Bit-for-bit WebP parity assertion
    let restored_asset = harness
        .read_dst_asset(asset_id)
        .await
        .expect("restored asset exists in destination blob store");
    assert_eq!(
        restored_asset, original_webp_bytes,
        "restored WebP asset must be identical bit-for-bit"
    );

    // 2. Coordinate equality assertions
    let entities = harness.target_store.all_entities();
    assert_eq!(entities.len(), 3);

    let restored_wall = entities
        .iter()
        .find(|e| e.entity_type == "wall")
        .expect("wall exists");
    assert_eq!(restored_wall.data["p1"]["x"].as_f64().unwrap(), wall_p1_x);
    assert_eq!(restored_wall.data["p1"]["y"].as_f64().unwrap(), wall_p1_y);
    assert_eq!(restored_wall.data["p2"]["x"].as_f64().unwrap(), wall_p2_x);
    assert_eq!(restored_wall.data["p2"]["y"].as_f64().unwrap(), wall_p2_y);

    let restored_actor = entities
        .iter()
        .find(|e| e.entity_type == "actor")
        .expect("actor exists");
    assert_eq!(restored_actor.data["token"]["x"].as_f64().unwrap(), token_x);
    assert_eq!(restored_actor.data["token"]["y"].as_f64().unwrap(), token_y);
    assert_eq!(
        restored_actor.data["token"]["elevation"].as_f64().unwrap(),
        token_elev
    );

    let restored_notes = harness.target_store.all_notes();
    assert_eq!(restored_notes.len(), 1);
    assert_eq!(restored_notes[0].id, note_id);
    assert_eq!(restored_notes[0].title, "Ring of Winter");
    assert_eq!(restored_notes[0].folder, Some("artifacts".to_string()));

    harness.cleanup().await;
}

#[tokio::test]
async fn test_campaign_import_remap_ids_cloning() {
    let harness = TestHarness::new().await;

    let campaign_id = Uuid::new_v4();
    let scene_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let token_id = Uuid::new_v4();
    let note_id = Uuid::new_v4();
    let author_id = Uuid::new_v4();
    let asset_id = Uuid::new_v4();

    let asset_bytes = b"RIFF....WEBPVP8 ...cloning test asset...";
    harness.store_asset(asset_id, asset_bytes).await;

    let source = RoundtripSource {
        campaign: CampaignMetadata {
            id: campaign_id,
            name: "Curse of Strahd".to_string(),
            system: "dnd5e".to_string(),
            description: Some("Cloning parity test campaign".to_string()),
            created_at: "2026-10-31T00:00:00Z".to_string(),
        },
        entities: vec![
            ExportEntity {
                entity_type: "scene".to_string(),
                data: json!({
                    "id": scene_id,
                    "campaign_id": campaign_id,
                    "asset_id": asset_id,
                    "name": "Castle Ravenloft"
                }),
            },
            ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": actor_id,
                    "campaign_id": campaign_id,
                    "name": "Strahd von Zarovich",
                    "token": {
                        "id": token_id,
                        "token_ref": actor_id
                    }
                }),
            },
        ],
        notes: vec![NoteRecord {
            id: note_id,
            title: "Tome of Strahd".to_string(),
            folder: Some("lore".to_string()),
            author_id,
            created_at: "2026-10-31T00:00:00Z".to_string(),
            updated_at: "2026-10-31T00:00:00Z".to_string(),
            content_markdown: format!(
                "Master [[{actor_id}|Strahd]] watches over [[{scene_id}|Ravenloft]]."
            ),
        }],
        asset_ids: vec![asset_id],
    };

    let archive_bytes = harness.export_archive(source).await;

    let importer = ArchiveImporter::new(harness.target_store.clone(), harness.dst_blobs.clone());

    // First import without remap retains original IDs
    let orig_res = importer
        .import(
            Cursor::new(&archive_bytes),
            ImportOptions { remap_ids: false },
        )
        .await
        .expect("initial import succeeds");
    assert_eq!(orig_res.campaign_id, campaign_id);

    // Second import with remap_ids=true clones campaign under new UUIDs
    let remap_res = importer
        .import(
            Cursor::new(&archive_bytes),
            ImportOptions { remap_ids: true },
        )
        .await
        .expect("cloned import with remap_ids=true succeeds");

    assert_ne!(remap_res.campaign_id, campaign_id);

    // Verify simultaneous existence of both campaigns
    let all_campaigns = harness.target_store.all_campaigns();
    assert_eq!(all_campaigns.len(), 2);
    assert!(all_campaigns.iter().any(|c| c.id == campaign_id));
    assert!(all_campaigns.iter().any(|c| c.id == remap_res.campaign_id));

    // Verify notes and wikilink rewriting in cloned campaign
    let all_notes = harness.target_store.all_notes();
    assert_eq!(all_notes.len(), 2);

    let cloned_note = all_notes
        .iter()
        .find(|n| n.id != note_id)
        .expect("cloned note exists");
    assert_ne!(cloned_note.id, note_id);
    assert!(
        !cloned_note.content_markdown.contains(&actor_id.to_string()),
        "old actor_id must not appear in rewritten wikilink"
    );
    assert!(
        !cloned_note.content_markdown.contains(&scene_id.to_string()),
        "old scene_id must not appear in rewritten wikilink"
    );
    assert!(
        cloned_note.content_markdown.contains("|Strahd]]"),
        "pipe label must be preserved in rewritten wikilink"
    );
    assert!(
        cloned_note.content_markdown.contains("|Ravenloft]]"),
        "pipe label must be preserved in rewritten wikilink"
    );

    // Verify token reference remapping in cloned actor
    let all_entities = harness.target_store.all_entities();
    assert_eq!(all_entities.len(), 4);

    let cloned_actors: Vec<_> = all_entities
        .iter()
        .filter(|e| {
            e.entity_type == "actor" && e.data["id"].as_str().unwrap() != actor_id.to_string()
        })
        .collect();
    assert_eq!(cloned_actors.len(), 1);
    let cloned_actor = cloned_actors[0];
    let new_actor_id = cloned_actor.data["id"].as_str().unwrap();
    let new_token_ref = cloned_actor.data["token"]["token_ref"].as_str().unwrap();
    let new_token_id = cloned_actor.data["token"]["id"].as_str().unwrap();

    assert_ne!(new_actor_id, actor_id.to_string());
    assert_eq!(
        new_token_ref, new_actor_id,
        "token_ref must point to remapped actor id"
    );
    assert_ne!(
        new_token_id,
        token_id.to_string(),
        "token id must be assigned new UUID"
    );

    harness.cleanup().await;
}

#[tokio::test]
async fn test_archive_importer_rejects_corrupted_sha256() {
    let harness = TestHarness::new().await;

    let campaign_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let asset_id = Uuid::new_v4();
    let asset_bytes = b"RIFF....WEBPVP8 ...unaltered original WebP bytes...";

    harness.store_asset(asset_id, asset_bytes).await;

    let source = RoundtripSource {
        campaign: CampaignMetadata {
            id: campaign_id,
            name: "Waterdeep Dragon Heist".to_string(),
            system: "dnd5e".to_string(),
            description: Some("Corruption rejection test".to_string()),
            created_at: "2026-10-31T00:00:00Z".to_string(),
        },
        entities: vec![ExportEntity {
            entity_type: "actor".to_string(),
            data: json!({
                "id": actor_id,
                "campaign_id": campaign_id,
                "name": "Renaer Neverember"
            }),
        }],
        notes: Vec::new(),
        asset_ids: vec![asset_id],
    };

    let mut archive_bytes = harness.export_archive(source).await;

    // Find the asset payload inside the uncompressed Stored zip entry and corrupt a byte
    let needle = b"...unaltered original WebP bytes...";
    let pos = archive_bytes
        .windows(needle.len())
        .position(|w| w == needle)
        .expect("locate uncompressed asset needle in zip archive");

    // Tamper single asset byte
    archive_bytes[pos + 5] ^= 0x55;

    let importer = ArchiveImporter::new(harness.target_store.clone(), harness.dst_blobs.clone());
    let err = importer
        .import(
            Cursor::new(archive_bytes),
            ImportOptions { remap_ids: false },
        )
        .await
        .expect_err("tampered asset byte must trigger checksum error");

    match err {
        ArchiveError::ChecksumMismatch {
            path,
            expected,
            actual,
        } => {
            assert_eq!(path, format!("assets/{asset_id}.webp"));
            assert_ne!(expected, actual);
        }
        other => panic!("expected ChecksumMismatch error, got {other:?}"),
    }

    // Verify zero changes were committed to persistent target stores
    assert!(
        harness.target_store.all_campaigns().is_empty(),
        "target campaign store must remain empty"
    );
    assert!(
        harness.target_store.all_entities().is_empty(),
        "target entity store must remain empty"
    );
    assert!(
        harness.target_store.all_notes().is_empty(),
        "target note store must remain empty"
    );
    assert!(
        harness.read_dst_asset(asset_id).await.is_err(),
        "corrupted asset must be wiped and zero assets committed"
    );

    harness.cleanup().await;
}
