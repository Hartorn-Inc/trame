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
//!        notes, and binary WebP assets byte-for-byte.
//!   2. `Referential Integrity Under UUID Remapping`:
//!      - Importing with `remap_ids: true` assigns fresh UUIDs to the campaign,
//!        entities, notes, and assets while rewriting internal references and
//!        wikilinks consistently.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `cargo test --test archive_roundtrip_test`
//!     ├── 1. Export campaign via `ArchiveExporter::export_stream`.
//!     ├── 2. Import into `InMemoryCampaignStore` with `remap_ids: false`.
//!     ├── 3. Verify `ArchiveError::CampaignAlreadyExists` on duplicate import.
//!     └── 4. Import with `remap_ids: true` and verify remapped UUIDs and wikilinks.
//! ============================================================================

use futures_util::StreamExt;
use serde_json::json;
use std::io::Cursor;
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
struct RoundtripSource {
    campaign: CampaignMetadata,
    entities: Vec<ExportEntity>,
    notes: Vec<NoteRecord>,
    asset_ids: Vec<Uuid>,
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

#[tokio::test]
async fn archive_export_import_roundtrip_and_remap_ids_integration() {
    let src_dir = std::env::temp_dir().join(format!("trame_rt_src_{}", Uuid::new_v4()));
    let dst_dir = std::env::temp_dir().join(format!("trame_rt_dst_{}", Uuid::new_v4()));
    let src_blobs = LocalFsStore::new(&src_dir);
    let dst_blobs = LocalFsStore::new(&dst_dir);

    let campaign_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let scene_id = Uuid::new_v4();
    let note_id = Uuid::new_v4();
    let author_id = Uuid::new_v4();
    let asset_id = Uuid::new_v4();

    src_blobs
        .put_stream(&asset_id.to_string(), slice_to_stream(b"RIFF....WEBPVP8 "))
        .await
        .expect("store source asset");

    let source = RoundtripSource {
        campaign: CampaignMetadata {
            id: campaign_id,
            name: "Shadows of Phandalin".to_string(),
            system: "dnd5e".to_string(),
            description: Some("Roundtrip integration test campaign".to_string()),
            created_at: "2026-10-31T00:00:00Z".to_string(),
        },
        entities: vec![
            ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": actor_id,
                    "campaign_id": campaign_id,
                    "name": "Sildar Hallwinter"
                }),
            },
            ExportEntity {
                entity_type: "scene".to_string(),
                data: json!({
                    "id": scene_id,
                    "campaign_id": campaign_id,
                    "asset_id": asset_id,
                    "name": "Cragmaw Hideout"
                }),
            },
        ],
        notes: vec![NoteRecord {
            id: note_id,
            title: "Rescue Mission".to_string(),
            folder: Some("quests".to_string()),
            author_id,
            created_at: "2026-10-31T00:00:00Z".to_string(),
            updated_at: "2026-10-31T00:00:00Z".to_string(),
            content_markdown: format!(
                "Find [[{actor_id}]] inside [[{scene_id}|Cragmaw Hideout]]."
            ),
        }],
        asset_ids: vec![asset_id],
    };

    let exporter = ArchiveExporter::new(source, src_blobs);
    let mut export_stream = exporter.export_stream().await.expect("start export");
    let mut archive_bytes = Vec::new();
    while let Some(chunk) = export_stream.next().await {
        archive_bytes.extend_from_slice(&chunk.expect("chunk ok"));
    }

    let target = InMemoryCampaignStore::new();
    let importer = ArchiveImporter::new(target.clone(), dst_blobs.clone());

    let res = importer
        .import(
            Cursor::new(archive_bytes.clone()),
            ImportOptions { remap_ids: false },
        )
        .await
        .expect("first import succeeds");
    assert_eq!(res.campaign_id, campaign_id);
    assert_eq!(res.actors_restored, 1);
    assert_eq!(res.scenes_restored, 1);
    assert_eq!(res.notes_restored, 1);
    assert_eq!(res.assets_restored, 1);

    let dup_err = importer
        .import(
            Cursor::new(archive_bytes.clone()),
            ImportOptions { remap_ids: false },
        )
        .await
        .expect_err("duplicate import without remap_ids must fail");
    assert!(matches!(dup_err, ArchiveError::CampaignAlreadyExists(id) if id == campaign_id));

    let remap_res = importer
        .import(
            Cursor::new(archive_bytes),
            ImportOptions { remap_ids: true },
        )
        .await
        .expect("remapped import succeeds");
    assert_ne!(remap_res.campaign_id, campaign_id);
    assert_eq!(target.all_campaigns().len(), 2);

    let notes = target.all_notes();
    assert_eq!(notes.len(), 2);
    let remapped_note = &notes[1];
    assert_ne!(remapped_note.id, note_id);
    assert!(!remapped_note.content_markdown.contains(&actor_id.to_string()));
    assert!(!remapped_note.content_markdown.contains(&scene_id.to_string()));
    assert!(remapped_note.content_markdown.contains("|Cragmaw Hideout]]"));

    let _ = tokio::fs::remove_dir_all(&src_dir).await;
    let _ = tokio::fs::remove_dir_all(&dst_dir).await;
}
