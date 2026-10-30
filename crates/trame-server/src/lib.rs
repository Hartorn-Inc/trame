pub mod assets;
pub mod dice;
pub mod http;
pub mod importers;
pub mod room;
pub mod sync;
pub mod wal;

#[cfg(test)]
mod tests {
    use crate::assets::store::{AssetStore, InMemoryAssetStore};
    use crate::dice::{RollVisibility, SeededDiceRoller, project_roll_for_recipient};
    use crate::http::{InMemoryMembershipValidator, build_router};
    use crate::importers::uvtt::{
        MAX_PAYLOAD_SIZE_BYTES, UvttDocument, UvttImportError, UvttLight, UvttPoint, UvttPortal,
        UvttResolution, import_uvtt_map, parse_hex_color,
    };
    use crate::room::{ConnectedClient, RoomLeaseManager};
    use crate::sync::{
        ClientEnvelope, ServerEnvelope, encode_server_envelope, project_state_for_recipient,
    };
    use crate::wal::{InMemoryWalStorage, TableStateSnapshot, WalStorage, recover_table_state};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use bytes::Bytes;
    use image::{DynamicImage, Rgba, RgbaImage};
    use std::io::Cursor;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tower::ServiceExt;
    use trame_engine::commands::{CampaignRole, TableState, TokenState, TrameCommand};
    use trame_engine::geometry::{Bvh2D, Point2D, WallKind, WallSegment};
    use uuid::Uuid;

    fn create_test_png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut img = RgbaImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = Rgba([180, 100, 50, 255]);
        }
        let dynamic = DynamicImage::ImageRgba8(img);
        let mut bytes = Vec::new();
        let mut cursor = Cursor::new(&mut bytes);
        dynamic
            .write_to(&mut cursor, image::ImageFormat::Png)
            .expect("PNG encode failed");
        bytes
    }

    #[tokio::test]
    async fn asset_store_put_get_and_mint_presigned_url_with_ttl() {
        let store = InMemoryAssetStore::new();
        let key = "instances/test-inst/campaigns/c1/assets/abc.webp";
        let data = Bytes::from_static(b"FAKE_WEBP_IMAGE_BYTES");

        assert_eq!(store.get_asset(key).await.unwrap(), None);

        store
            .put_asset(key, data.clone(), "image/webp")
            .await
            .unwrap();
        assert_eq!(store.get_asset(key).await.unwrap(), Some(data));

        let presigned = store
            .mint_presigned_get_url(key, Duration::from_secs(900))
            .await
            .unwrap();
        assert!(presigned.contains("abc.webp"));
        assert!(presigned.contains("expires_in=900"));

        let missing_err = store
            .mint_presigned_get_url("instances/c1/missing.webp", Duration::from_secs(900))
            .await
            .unwrap_err();
        assert!(matches!(
            missing_err,
            crate::assets::store::AssetStoreError::NotFound(_)
        ));
    }

    #[tokio::test]
    async fn uvtt_importer_parses_walls_doors_lights_and_scales_coordinates() {
        let store = InMemoryAssetStore::new();
        let instance_id = Uuid::new_v4();
        let campaign_id = Uuid::new_v4();

        let png_bytes = create_test_png_bytes(20, 20);
        let b64_img = BASE64.encode(&png_bytes);

        let doc = UvttDocument {
            format: 0.2,
            resolution: UvttResolution {
                map_origin: UvttPoint { x: 0.0, y: 0.0 },
                map_size: UvttPoint { x: 10.0, y: 10.0 },
                pixels_per_grid: 100.0,
            },
            image: b64_img,
            line_of_sight: vec![vec![
                UvttPoint { x: 1.0, y: 1.0 },
                UvttPoint { x: 3.0, y: 1.0 },
                UvttPoint { x: 3.0, y: 4.0 },
            ]],
            objects_line_of_sight: vec![vec![
                UvttPoint { x: 5.0, y: 5.0 },
                UvttPoint { x: 6.0, y: 5.0 },
            ]],
            portals: vec![
                UvttPortal {
                    position: UvttPoint { x: 2.0, y: 1.0 },
                    bounds: vec![UvttPoint { x: 2.0, y: 1.0 }, UvttPoint { x: 2.5, y: 1.0 }],
                    rotation: 0.0,
                    closed: true,
                    freestanding: false,
                },
                UvttPortal {
                    position: UvttPoint { x: 7.0, y: 2.0 },
                    bounds: vec![UvttPoint { x: 7.0, y: 2.0 }, UvttPoint { x: 7.5, y: 2.0 }],
                    rotation: 0.0,
                    closed: false,
                    freestanding: false,
                },
            ],
            lights: vec![UvttLight {
                position: UvttPoint { x: 4.0, y: 4.0 },
                range: 10.0,
                color: "#ff8800".to_string(),
                intensity: 1.0,
                shadows: true,
            }],
        };

        let json_payload = serde_json::to_vec(&doc).unwrap();
        let imported = import_uvtt_map(&json_payload, instance_id, campaign_id, &store)
            .await
            .expect("UVTT import should succeed");

        assert_eq!(imported.pixels_per_grid, 100.0);
        assert_eq!(imported.grid_cols, 10.0);
        assert_eq!(imported.grid_rows, 10.0);
        assert_eq!(imported.width_px, 20);
        assert_eq!(imported.height_px, 20);

        // Walls: 2 solid segments + 1 terrain segment + 2 door segments = 5 total
        assert_eq!(imported.walls.len(), 5);

        // Solid wall segment 1: (100, 100) -> (300, 100)
        assert_eq!(imported.walls[0].a, Point2D::new(100.0, 100.0));
        assert_eq!(imported.walls[0].b, Point2D::new(300.0, 100.0));
        assert_eq!(imported.walls[0].kind, WallKind::Normal);

        // Terrain segment: (500, 500) -> (600, 500), elevation 0..4 ft
        assert_eq!(imported.walls[2].a, Point2D::new(500.0, 500.0));
        assert_eq!(imported.walls[2].b, Point2D::new(600.0, 500.0));
        assert_eq!(imported.walls[2].kind, WallKind::Terrain);
        assert_eq!(imported.walls[2].bottom_elevation_ft, 0.0);
        assert_eq!(imported.walls[2].top_elevation_ft, 4.0);

        // Door 1 (closed) and Door 2 (open)
        assert_eq!(
            imported.walls[3].kind,
            WallKind::Door {
                is_open: false,
                is_locked: false
            }
        );
        assert!(imported.walls[3].blocks_vision);
        assert!(matches!(
            imported.walls[4].kind,
            WallKind::Door {
                is_open: true,
                is_locked: false
            }
        ));
        assert!(!imported.walls[4].blocks_vision);

        // Light: range 10 cells -> bright 500px, dim 1000px
        assert_eq!(imported.lights.len(), 1);
        let light = &imported.lights[0];
        assert_eq!(light.position, Point2D::new(400.0, 400.0));
        assert_eq!(light.bright_radius_px, 500.0);
        assert_eq!(light.dim_radius_px, 1000.0);
        assert_eq!(light.intensity, 1.0);
        assert!(light.shadows);

        // Verify assets persisted in store
        let stored_main = store.get_asset(&imported.image_asset_key).await.unwrap();
        assert!(stored_main.is_some());
        let stored_thumb = store
            .get_asset(&imported.thumbnail_asset_key)
            .await
            .unwrap();
        assert!(stored_thumb.is_some());
    }

    #[tokio::test]
    async fn uvtt_importer_enforces_magic_bytes_payload_limits_and_dimension_guards() {
        let store = InMemoryAssetStore::new();
        let inst = Uuid::new_v4();
        let camp = Uuid::new_v4();

        // 1. Payload > 64 MiB rejected
        let oversized = vec![0u8; MAX_PAYLOAD_SIZE_BYTES + 1];
        let err = import_uvtt_map(&oversized, inst, camp, &store)
            .await
            .unwrap_err();
        assert!(matches!(err, UvttImportError::PayloadTooLarge(_)));

        // 2. Corrupt magic bytes
        let corrupt_doc = UvttDocument {
            format: 0.2,
            resolution: UvttResolution {
                map_origin: UvttPoint { x: 0.0, y: 0.0 },
                map_size: UvttPoint { x: 1.0, y: 1.0 },
                pixels_per_grid: 50.0,
            },
            image: BASE64.encode(b"NOT_AN_IMAGE_FILE_BUFFER"),
            line_of_sight: Vec::new(),
            objects_line_of_sight: Vec::new(),
            portals: Vec::new(),
            lights: Vec::new(),
        };
        let payload = serde_json::to_vec(&corrupt_doc).unwrap();
        let err = import_uvtt_map(&payload, inst, camp, &store)
            .await
            .unwrap_err();
        assert_eq!(err, UvttImportError::InvalidMagicBytes);
    }

    #[test]
    fn hex_color_parsing_handles_rgb_and_argb_formats() {
        let cases = [
            ("#ff8800", [1.0, 136.0 / 255.0, 0.0]),
            ("00ff00", [0.0, 1.0, 0.0]),
            ("#ffff8800", [1.0, 136.0 / 255.0, 0.0]),
            ("#fff", [1.0, 1.0, 1.0]),
        ];
        for (hex, expected) in cases {
            let parsed = parse_hex_color(hex);
            assert!((parsed[0] - expected[0]).abs() < 1e-4);
            assert!((parsed[1] - expected[1]).abs() < 1e-4);
            assert!((parsed[2] - expected[2]).abs() < 1e-4);
        }
    }

    #[tokio::test]
    async fn rbac_presigned_asset_endpoint_enforces_membership_and_not_found() {
        let wal = Arc::new(InMemoryWalStorage::new());
        let lease_mgr = Arc::new(RoomLeaseManager::new(wal, 25, 900_000));
        let store = Arc::new(InMemoryAssetStore::new());
        let membership = Arc::new(InMemoryMembershipValidator::new());
        let instance_id = Uuid::new_v4();
        let campaign_id = Uuid::new_v4();

        let member_user_id = Uuid::new_v4();
        let non_member_user_id = Uuid::new_v4();
        membership.add_member(campaign_id, member_user_id);

        let hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let asset_key =
            format!("instances/{instance_id}/campaigns/{campaign_id}/assets/{hash}.webp");
        store
            .put_asset(&asset_key, Bytes::from_static(b"SAMPLE_DATA"), "image/webp")
            .await
            .unwrap();

        let app = build_router(lease_mgr, store, membership, instance_id);

        // 1. Non-member user -> 403 Forbidden
        let req_forbidden = Request::builder()
            .uri(format!(
                "/api/v1/campaigns/{campaign_id}/assets/{hash}/presign?user_id={non_member_user_id}"
            ))
            .body(Body::empty())
            .unwrap();
        let res_forbidden = app.clone().oneshot(req_forbidden).await.unwrap();
        assert_eq!(res_forbidden.status(), StatusCode::FORBIDDEN);

        // 2. Active member user with existing asset -> 200 OK + presigned URL
        let req_ok = Request::builder()
            .uri(format!(
                "/api/v1/campaigns/{campaign_id}/assets/{hash}/presign?user_id={member_user_id}"
            ))
            .body(Body::empty())
            .unwrap();
        let res_ok = app.clone().oneshot(req_ok).await.unwrap();
        assert_eq!(res_ok.status(), StatusCode::OK);
        let body_bytes = axum::body::to_bytes(res_ok.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
        assert!(json["url"].as_str().unwrap().contains(hash));
        assert_eq!(json["expires_in_secs"], 900);

        // 3. Active member user with missing asset hash -> 404 Not Found
        let missing_hash = "0000000000000000000000000000000000000000000000000000000000000000";
        let req_missing = Request::builder()
            .uri(format!(
                "/api/v1/campaigns/{campaign_id}/assets/{missing_hash}/presign?user_id={member_user_id}"
            ))
            .body(Body::empty())
            .unwrap();
        let res_missing = app.oneshot(req_missing).await.unwrap();
        assert_eq!(res_missing.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn chacha20_dice_roller_supports_advantage_disadvantage_and_blind_gm_filtering() {
        let mut roller = SeededDiceRoller::from_seed([42u8; 32]);
        let gm_id = Uuid::new_v4();
        let player_id = Uuid::new_v4();
        let bystander_id = Uuid::new_v4();

        let cases = [
            ("1d20+5", RollVisibility::Public, "attack_roll"),
            ("2d20kh1+7", RollVisibility::GmOnly, "advantage_stealth"),
            ("2d20kl1-1", RollVisibility::BlindGm, "blind_death_save"),
            ("8d6", RollVisibility::Public, "fireball_damage"),
        ];

        for (expr, vis, label) in cases {
            let outcome = roller
                .roll(player_id, expr, vis, label)
                .expect("valid dice expression");
            assert!(!outcome.terms.is_empty(), "case {label}");

            let gm_view = project_roll_for_recipient(&outcome, gm_id, CampaignRole::Gm)
                .expect("GM always sees every roll");
            assert!(!gm_view.blind_masked, "GM sees unmasked roll for {label}");
            assert_eq!(gm_view.total, Some(outcome.total));

            let player_view = project_roll_for_recipient(&outcome, player_id, CampaignRole::Player)
                .expect("Roller always gets an acknowledgment");
            let bystander_view =
                project_roll_for_recipient(&outcome, bystander_id, CampaignRole::Player);

            match vis {
                RollVisibility::Public => {
                    assert_eq!(player_view.total, Some(outcome.total));
                    assert!(bystander_view.is_some());
                }
                RollVisibility::GmOnly => {
                    assert_eq!(player_view.total, Some(outcome.total));
                    assert!(bystander_view.is_none());
                }
                RollVisibility::BlindGm => {
                    assert!(player_view.blind_masked);
                    assert_eq!(player_view.total, None);
                    assert!(player_view.terms.is_empty());
                    assert!(bystander_view.is_none());
                }
            }
        }
    }

    #[test]
    fn server_side_projection_strips_hidden_tokens_and_masks_secret_doors() {
        let campaign_id = Uuid::new_v4();
        let gm_id = Uuid::new_v4();
        let player_id = Uuid::new_v4();

        let mut secret_wall = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(200.0, 0.0),
            Point2D::new(200.0, 400.0),
        );
        secret_wall.kind = WallKind::SecretDoor { is_open: false };

        let mut state = TableState::new(100.0, 5.0, vec![secret_wall]);
        state.bvh = Bvh2D::build(state.data.walls.clone());

        let player_token_id = Uuid::new_v4();
        let mut player_tok =
            TokenState::new_default(player_token_id, "Player Paladin", Point2D::new(0.0, 0.0));
        player_tok.owner_user_id = Some(player_id);
        state.data.tokens.insert(player_token_id, player_tok);

        let visible_goblin_id = Uuid::new_v4();
        let goblin_tok = TokenState::new_default(
            visible_goblin_id,
            "Visible Goblin",
            Point2D::new(0.0, 100.0),
        );
        state.data.tokens.insert(visible_goblin_id, goblin_tok);

        let occluded_lich_id = Uuid::new_v4();
        let lich_tok = TokenState::new_default(
            occluded_lich_id,
            "Occluded Lich Behind Secret Door",
            Point2D::new(300.0, 0.0),
        );
        state.data.tokens.insert(occluded_lich_id, lich_tok);

        let player_proj =
            project_state_for_recipient(campaign_id, &state, player_id, CampaignRole::Player);
        assert!(player_proj.tokens.contains_key(&player_token_id));
        assert!(player_proj.tokens.contains_key(&visible_goblin_id));
        assert!(
            !player_proj.tokens.contains_key(&occluded_lich_id),
            "Occluded token behind wall must never be sent to player socket"
        );
        assert_eq!(
            player_proj.walls[0].kind,
            WallKind::Normal,
            "Closed SecretDoor must be masked as Normal wall on player wire payload"
        );

        let gm_proj = project_state_for_recipient(campaign_id, &state, gm_id, CampaignRole::Gm);
        assert_eq!(gm_proj.tokens.len(), 3);
        assert_eq!(
            gm_proj.walls[0].kind,
            WallKind::SecretDoor { is_open: false }
        );
    }

    #[tokio::test]
    async fn room_actor_wal_recovery_and_idle_lease_hibernation() {
        let wal = Arc::new(InMemoryWalStorage::new());
        let campaign_id = Uuid::new_v4();
        let player_id = Uuid::new_v4();
        let token_id = Uuid::new_v4();

        let mut initial = TableState::new(100.0, 5.0, Vec::new());
        let mut ranger = TokenState::new_default(token_id, "Ranger", Point2D::new(0.0, 0.0));
        ranger.owner_user_id = Some(player_id);
        initial.data.tokens.insert(token_id, ranger);

        wal.save_snapshot(TableStateSnapshot {
            campaign_id,
            snapshot_seq_id: 0,
            captured_at_ms: 1000,
            cell_size_px: initial.cell_size_px,
            feet_per_cell: initial.feet_per_cell,
            data: initial.data,
        })
        .unwrap();

        let lease_mgr = RoomLeaseManager::new(wal.clone(), 10, 900_000);
        let handle = lease_mgr.get_or_wake_room(campaign_id).await.unwrap();
        assert_eq!(lease_mgr.active_room_count().await, 1);

        let (tx, mut rx) = mpsc::unbounded_channel();
        let session_id = Uuid::new_v4();
        handle
            .connect_client(ConnectedClient {
                session_id,
                user_id: player_id,
                role: CampaignRole::Player,
                tx,
            })
            .await
            .unwrap();

        let first_frame = rx.recv().await.unwrap();
        let decoded: ServerEnvelope = rmp_serde::from_slice(&first_frame).unwrap();
        assert!(matches!(
            decoded,
            ServerEnvelope::StateSnapshot { seq_id: 0, .. }
        ));

        handle
            .send_envelope(
                session_id,
                ClientEnvelope::SubmitCommand(TrameCommand::MoveToken {
                    token_id,
                    to_top_left: Point2D::new(200.0, 0.0),
                    to_elevation_ft: None,
                    gm_teleport: false,
                }),
            )
            .await
            .unwrap();

        let second_frame = rx.recv().await.unwrap();
        let decoded_move: ServerEnvelope = rmp_serde::from_slice(&second_frame).unwrap();
        match decoded_move {
            ServerEnvelope::CommandAccepted {
                seq_id, ref state, ..
            } => {
                assert_eq!(seq_id, 1);
                assert_eq!(state.tokens[&token_id].top_left, Point2D::new(200.0, 0.0));
                assert!(encode_server_envelope(&decoded_move).is_ok());
            }
            other => panic!("Expected CommandAccepted, got {other:?}"),
        }

        let (recovered_state, recovered_seq) =
            recover_table_state(wal.as_ref(), campaign_id).unwrap();
        assert_eq!(recovered_seq, 1);
        assert_eq!(
            recovered_state.data.tokens[&token_id].top_left,
            Point2D::new(200.0, 0.0)
        );

        handle.disconnect_client(session_id).await.unwrap();
        let metrics = handle.metrics().await.unwrap();
        assert_eq!(metrics.active_connections, 0);

        let hibernated = lease_mgr
            .sweep_idle_rooms(metrics.last_activity_ms + 900_001)
            .await;
        assert_eq!(hibernated, vec![campaign_id]);
        assert_eq!(lease_mgr.active_room_count().await, 0);

        let woken = lease_mgr.get_or_wake_room(campaign_id).await.unwrap();
        let woken_metrics = woken.metrics().await.unwrap();
        assert_eq!(woken_metrics.seq_id, 1);
    }
}
