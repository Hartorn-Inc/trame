#![allow(
    async_fn_in_trait,
    clippy::collapsible_else_if,
    clippy::collapsible_if,
    clippy::doc_lazy_continuation,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::unnecessary_sort_by
)]

//! ============================================================================
//! TRAME MULTIPLAYER RUNTIME & ROOM ACTOR CRATE ROOT (lib.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Orchestrates the authoritative multiplayer server runtime for `trame`:
//! streaming PKWARE portable campaign archive export/import (`archive`),
//! content-addressed WebP asset storage (`assets`), Universal VTT map importing
//! (`importers`), cryptographically seeded ChaCha20 dice resolution (`dice`),
//! Axum HTTP/WebSocket transport (`http`), isolated per-campaign Tokio actor
//! loops with `Idle-Lease` hibernation (`room`), MessagePack binary wire framing
//! with 2.5D BVH line-of-sight state stripping (`sync`), and Write-Ahead Log
//! (WAL) + write-behind snapshot crash recovery (`wal`).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Information-Theoretic Wire Stripping`:
//!      - Non-GM recipients never receive tokens on `CHANNEL_GM_HIDDEN` or
//!        tokens occluded behind walls outside their owned tokens' 2.5D BVH
//!        line-of-sight (`project_state_for_recipient`). Closed `SecretDoor`
//!        segments are masked as `WallKind::Normal` on player sockets.
//!   2. `Blind GM Roll Privacy`:
//!      - `RollVisibility::BlindGm` reveals full roll totals and terms to the
//!        GM, echoes a masked acknowledgment (`blind_masked: true`, `total: None`,
//!        empty `terms`) to the rolling player, and drops the packet for all
//!        bystanders.
//!   3. `WAL Durability Before Broadcast`:
//!      - Every accepted `TrameCommand` increments `seq_id` and appends a
//!        `WalEntry` prior to broadcasting `ServerEnvelope::CommandAccepted`,
//!        ensuring zero state loss across room hibernation or process restarts.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `Client WebSocket Frame (MessagePack) / HTTP Request`
//!     ├── 1. `http::ws_campaign_handler` upgrades connection & wakes `TableRoomActor`.
//!     ├── 2. `room::TableRoomActor` validates & applies `ClientEnvelope` command/roll.
//!     ├── 3. `wal::WalStorage` persists `WalEntry` & periodic `TableStateSnapshot`.
//!     └── 4. `sync::project_state_for_recipient` strips hidden state per recipient socket.
//! ============================================================================

pub mod archive;
pub mod assets;
pub mod auth;
pub mod dice;
pub mod http;
pub mod importers;
pub mod maps;
pub mod notes;
pub mod room;
pub mod storage;
pub mod sync;
pub mod timeline;
pub mod wal;

#[cfg(test)]
mod tests {
    use crate::assets::store::{AssetStore, InMemoryAssetStore};
    use crate::auth::magic_link::{MagicLinkService, now_epoch_seconds};
    use crate::auth::session::{
        AuthState, InMemorySessionStore, MagicLinkLoginRequest, MagicLinkLoginResponse,
        SESSION_COOKIE_NAME, SessionStore, build_auth_router, hash_session_token,
    };
    use crate::auth::totp::TotpService;
    use crate::dice::{RollVisibility, SeededDiceRoller, project_roll_for_recipient};
    use crate::http::{InMemoryMembershipValidator, build_router};
    use crate::importers::uvtt::{
        MAX_PAYLOAD_SIZE_BYTES, UvttDocument, UvttImportError, UvttLight, UvttPoint, UvttPortal,
        UvttResolution, import_uvtt_map, parse_hex_color,
    };
    use crate::notes::{
        FilteredNoteDocument, InMemoryPartyJournalStorage, NoteAccessDecision, NoteVisibility,
        PartyJournalStorage, RevealHandoutCommand, UserRole, evaluate_note_access,
        parse_handout_revealed_attr, reveal_handout,
    };
    use crate::room::{ConnectedClient, OutboundClientFrame, RoomLeaseManager};
    use crate::sync::{
        ClientEnvelope, ServerEnvelope, encode_server_envelope, project_state_for_recipient,
    };
    use crate::timeline::{
        AppendEventInput, InMemoryTimelineStorage, TimelineStorage, format_mcp_timeline,
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
    async fn test_magic_link_jwt_creation_and_onboarding_lifecycle() {
        let session_store = Arc::new(InMemorySessionStore::new());
        let magic_service = Arc::new(MagicLinkService::new(
            b"test_jwt_secret_1234567890",
            "trame-test",
        ));
        let auth_state = AuthState {
            magic_link_service: magic_service.clone(),
            session_store: session_store.clone(),
            totp_service: Arc::new(TotpService::default()),
        };
        let router = build_auth_router(auth_state);

        let gm_id = Uuid::new_v4();
        let campaign_id = Uuid::new_v4();
        let character_id = Uuid::new_v4();

        let (token, claims) = magic_service
            .create_invite_token(gm_id, campaign_id, Some(character_id), "PLAYER", 3600)
            .expect("create invite token");

        assert_eq!(claims.sub, gm_id.to_string());
        assert_eq!(claims.iss, "trame-test");
        assert_eq!(claims.campaign_id, campaign_id);
        assert_eq!(claims.character_id, Some(character_id));
        assert_eq!(claims.role, "PLAYER");
        assert!(claims.exp > now_epoch_seconds());

        let req_body = serde_json::to_vec(&MagicLinkLoginRequest {
            token: token.clone(),
        })
        .unwrap();
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/magic-link")
            .header("content-type", "application/json")
            .body(Body::from(req_body))
            .unwrap();

        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let set_cookie_header = resp
            .headers()
            .get("set-cookie")
            .expect("set-cookie present");
        let set_cookie_str = set_cookie_header.to_str().unwrap();
        assert!(set_cookie_str.contains(&format!("{SESSION_COOKIE_NAME}=")));
        assert!(set_cookie_str.contains("HttpOnly"));
        assert!(set_cookie_str.contains("Secure"));
        assert!(set_cookie_str.contains("SameSite=Lax"));

        let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let login_resp: MagicLinkLoginResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(login_resp.campaign_id, campaign_id);
        assert_eq!(login_resp.character_id, Some(character_id));
        assert_eq!(login_resp.role, "PLAYER");

        let member = session_store
            .get_campaign_member(campaign_id, login_resp.user_id)
            .await
            .unwrap()
            .expect("member record exists");
        assert_eq!(member.user_id, login_resp.user_id);
        assert_eq!(member.character_id, Some(character_id));
        assert_eq!(member.role, "PLAYER");
    }

    #[tokio::test]
    async fn test_magic_link_preserves_custom_roles_such_as_spectator_and_assistant_gm() {
        let session_store = Arc::new(InMemorySessionStore::new());
        let magic_service = Arc::new(MagicLinkService::new(
            b"test_jwt_secret_1234567890",
            "trame-test",
        ));
        let auth_state = AuthState {
            magic_link_service: magic_service.clone(),
            session_store: session_store.clone(),
            totp_service: Arc::new(TotpService::default()),
        };
        let router = build_auth_router(auth_state);

        for custom_role in ["SPECTATOR", "ASSISTANT_GM"] {
            let gm_id = Uuid::new_v4();
            let campaign_id = Uuid::new_v4();

            let (token, claims) = magic_service
                .create_invite_token(gm_id, campaign_id, None, custom_role, 3600)
                .expect("create invite token");
            assert_eq!(claims.role, custom_role);

            let req_body = serde_json::to_vec(&MagicLinkLoginRequest { token }).unwrap();
            let req = Request::builder()
                .method("POST")
                .uri("/api/v1/auth/magic-link")
                .header("content-type", "application/json")
                .body(Body::from(req_body))
                .unwrap();

            let resp = router.clone().oneshot(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);

            let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            let login_resp: MagicLinkLoginResponse = serde_json::from_slice(&body_bytes).unwrap();
            assert_eq!(login_resp.role, custom_role);

            let member = session_store
                .get_campaign_member(campaign_id, login_resp.user_id)
                .await
                .unwrap()
                .expect("member record exists");
            assert_eq!(member.role, custom_role);
        }
    }

    #[tokio::test]
    async fn test_magic_link_revoked_invite_returns_401() {
        let session_store = Arc::new(InMemorySessionStore::new());
        let magic_service = Arc::new(MagicLinkService::new(
            b"test_jwt_secret_1234567890",
            "trame-test",
        ));
        let auth_state = AuthState {
            magic_link_service: magic_service.clone(),
            session_store: session_store.clone(),
            totp_service: Arc::new(TotpService::default()),
        };
        let router = build_auth_router(auth_state);

        let gm_id = Uuid::new_v4();
        let campaign_id = Uuid::new_v4();
        let (token, claims) = magic_service
            .create_invite_token(gm_id, campaign_id, None, "PLAYER", 3600)
            .unwrap();

        session_store.revoke_invite(claims.jti).await.unwrap();

        let req_body = serde_json::to_vec(&MagicLinkLoginRequest { token }).unwrap();
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/magic-link")
            .header("content-type", "application/json")
            .body(Body::from(req_body))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_magic_link_expired_invite_returns_401() {
        let session_store = Arc::new(InMemorySessionStore::new());
        let magic_service = Arc::new(MagicLinkService::new(
            b"test_jwt_secret_1234567890",
            "trame-test",
        ));
        let auth_state = AuthState {
            magic_link_service: magic_service.clone(),
            session_store: session_store.clone(),
            totp_service: Arc::new(TotpService::default()),
        };
        let router = build_auth_router(auth_state);

        let gm_id = Uuid::new_v4();
        let campaign_id = Uuid::new_v4();
        let expired_claims = crate::auth::magic_link::MagicLinkClaims {
            sub: gm_id.to_string(),
            iss: "trame-test".to_string(),
            campaign_id,
            character_id: None,
            role: "PLAYER".to_string(),
            exp: now_epoch_seconds().saturating_sub(60),
            jti: Uuid::new_v4(),
        };
        let token = magic_service.sign_claims(&expired_claims).unwrap();

        let req_body = serde_json::to_vec(&MagicLinkLoginRequest { token }).unwrap();
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/magic-link")
            .header("content-type", "application/json")
            .body(Body::from(req_body))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_session_token_hashing_and_randomness() {
        let token1 = crate::auth::session::generate_session_token();
        let token2 = crate::auth::session::generate_session_token();
        assert_ne!(token1, token2);
        assert_eq!(token1.len(), 64);

        let hash1 = hash_session_token(&token1);
        let hash2 = hash_session_token(&token1);
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64);
    }

    #[tokio::test]
    async fn test_create_invite_link_handler_nominal() {
        let session_store = Arc::new(InMemorySessionStore::new());
        let magic_service = Arc::new(MagicLinkService::new(b"secret", "trame-test"));
        let auth_state = AuthState {
            magic_link_service: magic_service,
            session_store,
            totp_service: Arc::new(TotpService::default()),
        };
        let router = build_auth_router(auth_state);
        let campaign_id = Uuid::new_v4();
        let character_id = Uuid::new_v4();

        let req_body = serde_json::to_vec(&crate::auth::session::CreateInviteLinkRequest {
            campaign_id,
            character_id: Some(character_id),
            role: Some("PLAYER".to_string()),
            ttl_seconds: Some(1800),
        })
        .unwrap();

        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/invites")
            .header("content-type", "application/json")
            .body(Body::from(req_body))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
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
    async fn uvtt_importer_translates_coordinates_by_map_origin() {
        let store = InMemoryAssetStore::new();
        let instance_id = Uuid::new_v4();
        let campaign_id = Uuid::new_v4();

        let png_bytes = create_test_png_bytes(20, 20);
        let b64_img = BASE64.encode(&png_bytes);

        let doc = UvttDocument {
            format: 0.2,
            resolution: UvttResolution {
                map_origin: UvttPoint { x: 2.0, y: 1.0 },
                map_size: UvttPoint { x: 8.0, y: 8.0 },
                pixels_per_grid: 50.0,
            },
            image: b64_img,
            line_of_sight: vec![vec![
                UvttPoint { x: 4.0, y: 3.0 },
                UvttPoint { x: 6.0, y: 3.0 },
            ]],
            objects_line_of_sight: vec![vec![
                UvttPoint { x: 3.0, y: 2.0 },
                UvttPoint { x: 5.0, y: 2.0 },
            ]],
            portals: vec![UvttPortal {
                position: UvttPoint { x: 4.0, y: 2.0 },
                bounds: vec![UvttPoint { x: 4.0, y: 2.0 }, UvttPoint { x: 4.5, y: 2.0 }],
                rotation: 0.0,
                closed: false,
                freestanding: false,
            }],
            lights: vec![UvttLight {
                position: UvttPoint { x: 5.0, y: 4.0 },
                range: 6.0,
                color: "#00ff00".to_string(),
                intensity: 1.0,
                shadows: false,
            }],
        };

        let json_payload = serde_json::to_vec(&doc).unwrap();
        let imported = import_uvtt_map(&json_payload, instance_id, campaign_id, &store)
            .await
            .expect("UVTT import with offset should succeed");

        assert_eq!(imported.pixels_per_grid, 50.0);
        assert_eq!(imported.grid_cols, 8.0);
        assert_eq!(imported.grid_rows, 8.0);

        // Solid wall: (4 - 2) * 50 = 100, (3 - 1) * 50 = 100 -> (6 - 2) * 50 = 200, (3 - 1) * 50 = 100
        assert_eq!(imported.walls[0].a, Point2D::new(100.0, 100.0));
        assert_eq!(imported.walls[0].b, Point2D::new(200.0, 100.0));

        // Terrain: (3 - 2) * 50 = 50, (2 - 1) * 50 = 50 -> (5 - 2) * 50 = 150, (2 - 1) * 50 = 50
        assert_eq!(imported.walls[1].a, Point2D::new(50.0, 50.0));
        assert_eq!(imported.walls[1].b, Point2D::new(150.0, 50.0));

        // Portal: (4 - 2) * 50 = 100, (2 - 1) * 50 = 50 -> (4.5 - 2) * 50 = 125, (2 - 1) * 50 = 50
        assert_eq!(imported.walls[2].a, Point2D::new(100.0, 50.0));
        assert_eq!(imported.walls[2].b, Point2D::new(125.0, 50.0));

        // Light: (5 - 2) * 50 = 150, (4 - 1) * 50 = 150
        assert_eq!(imported.lights[0].position, Point2D::new(150.0, 150.0));
        assert_eq!(imported.lights[0].bright_radius_px, 150.0);
        assert_eq!(imported.lights[0].dim_radius_px, 300.0);
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
            ("#ééé", [1.0, 1.0, 1.0]),
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

        let app = build_router(lease_mgr, store.clone(), membership, instance_id);

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
        let res_missing = app.clone().oneshot(req_missing).await.unwrap();
        assert_eq!(res_missing.status(), StatusCode::NOT_FOUND);

        // 4. Invalid or path traversal hash format -> 400 Bad Request
        let req_traversal = Request::builder()
            .uri(format!(
                "/api/v1/campaigns/{campaign_id}/assets/invalid..traversal/presign?user_id={member_user_id}"
            ))
            .body(Body::empty())
            .unwrap();
        let res_traversal = app.clone().oneshot(req_traversal).await.unwrap();
        assert_eq!(res_traversal.status(), StatusCode::BAD_REQUEST);

        // 5. Valid thumbnail hash suffix -> 200 OK
        let thumb_key =
            format!("instances/{instance_id}/campaigns/{campaign_id}/assets/{hash}_thumb.webp");
        store
            .put_asset(
                &thumb_key,
                Bytes::from_static(b"SAMPLE_THUMB"),
                "image/webp",
            )
            .await
            .unwrap();
        let req_thumb = Request::builder()
            .uri(format!(
                "/api/v1/campaigns/{campaign_id}/assets/{hash}_thumb/presign?user_id={member_user_id}"
            ))
            .body(Body::empty())
            .unwrap();
        let res_thumb = app.oneshot(req_thumb).await.unwrap();
        assert_eq!(res_thumb.status(), StatusCode::OK);
    }

    #[test]
    fn test_filter_for_role_purges_dm_and_unrevealed_handouts() {
        let input = r#"# Adventure Notes
[[Valeros]] discovers a locked chest in [[Cragmaw Castle]].

:::dm
The chest contains 500 GP and a Cursed Ring of Burden.
::: 

:::handout{id="h-secret" title="Encrypted Map" revealed="false"}
Coordinates: 45N 12W. Do not give to players yet!
:::

:::handout{id="h-trap" title="Notice: revealed=true is a trap" revealed="false"}
Top secret GM content that must never be revealed.
:::

:::handout{id="h-single-quote" title='Secret single quote: revealed=true trap' revealed='false'}
Another secret that must stay hidden.
:::

:::handout{id="h-public" title="Notice Board Post" revealed="true"}
Bounty: 50 GP for Goblin leaders.
:::

Party moves forward."#;

        let filtered = FilteredNoteDocument::filter_for_role(input, UserRole::Player);

        assert!(!filtered.contains(":::dm"));
        assert!(!filtered.contains("Cursed Ring of Burden"));
        assert!(!filtered.contains("h-secret"));
        assert!(!filtered.contains("Encrypted Map"));
        assert!(!filtered.contains("45N 12W"));
        assert!(!filtered.contains("h-trap"));
        assert!(!filtered.contains("Notice: revealed=true is a trap"));
        assert!(!filtered.contains("Top secret GM content"));
        assert!(!filtered.contains("h-single-quote"));
        assert!(!filtered.contains("Another secret that must stay hidden"));

        assert!(filtered.contains("# Adventure Notes"));
        assert!(filtered.contains("[[Valeros]] discovers a locked chest"));
        assert!(
            filtered.contains(
                ":::handout{id=\"h-public\" title=\"Notice Board Post\" revealed=\"true\"}"
            )
        );
        assert!(filtered.contains("Bounty: 50 GP for Goblin leaders."));
        assert!(filtered.contains("Party moves forward."));
    }

    #[test]
    fn test_merge_party_note_ast_preserves_gm_secrets_across_player_mutations() {
        let stored_doc = "Texte public\n\n:::dm\nSecret MJ\n:::\n\nFin public";
        let player_view = FilteredNoteDocument::filter_for_role(stored_doc, UserRole::Player);
        assert!(!player_view.contains(":::dm"));
        assert!(!player_view.contains("Secret MJ"));

        let player_mutation = "Texte public modifie\n\nFin public";
        let merged = FilteredNoteDocument::merge_party_note_ast(stored_doc, player_mutation);

        assert!(merged.contains(":::dm"));
        assert!(merged.contains("Secret MJ"));
        assert!(merged.contains("Texte public modifie"));
        assert!(merged.contains("Fin public"));
    }

    #[test]
    fn test_notes_rbac_isolation() {
        // 1. PRIVATE notes: only the owner gets Ok; peers, GMs, and spectators get NotFound (404)
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Private,
                "user-alice",
                "user-alice",
                UserRole::Player,
                false
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Private,
                "user-alice",
                "user-alice",
                UserRole::Player,
                true
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Private,
                "user-alice",
                "user-bob",
                UserRole::Player,
                false
            ),
            NoteAccessDecision::NotFound
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Private,
                "user-alice",
                "user-gm",
                UserRole::GameMaster,
                false
            ),
            NoteAccessDecision::NotFound
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Private,
                "user-alice",
                "user-spec",
                UserRole::Spectator,
                false
            ),
            NoteAccessDecision::NotFound
        );

        // 2. DM_ONLY notes: only GameMaster gets Ok; players and spectators get Forbidden (403)
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::DmOnly,
                "user-gm",
                "user-gm",
                UserRole::GameMaster,
                false
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::DmOnly,
                "user-gm",
                "user-gm",
                UserRole::GameMaster,
                true
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::DmOnly,
                "user-gm",
                "user-alice",
                UserRole::Player,
                false
            ),
            NoteAccessDecision::Forbidden
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::DmOnly,
                "user-gm",
                "user-spec",
                UserRole::Spectator,
                false
            ),
            NoteAccessDecision::Forbidden
        );

        // 3. PARTY notes: readable by all roles; writable by GM & Player, Forbidden for Spectator writes
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Party,
                "user-alice",
                "user-bob",
                UserRole::Player,
                false
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Party,
                "user-alice",
                "user-bob",
                UserRole::Player,
                true
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Party,
                "user-alice",
                "user-gm",
                UserRole::GameMaster,
                true
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Party,
                "user-alice",
                "user-spec",
                UserRole::Spectator,
                false
            ),
            NoteAccessDecision::Ok
        );
        assert_eq!(
            evaluate_note_access(
                NoteVisibility::Party,
                "user-alice",
                "user-spec",
                UserRole::Spectator,
                true
            ),
            NoteAccessDecision::Forbidden
        );
    }

    #[test]
    fn test_filter_for_role_preserves_everything_for_gamemaster() {
        let input = r#"# Adventure Notes
:::dm
Super Secret GM Note
:::
:::handout{id="h-1" title="Secret" revealed="false"}
Hidden Text
:::
"#;

        let filtered = FilteredNoteDocument::filter_for_role(input, UserRole::GameMaster);
        assert_eq!(filtered, input);
    }

    #[test]
    fn test_parse_handout_revealed_attr_quote_awareness() {
        assert!(parse_handout_revealed_attr(
            r#":::handout{id="h1" title="Parchment" revealed="true"}"#
        ));
        assert!(!parse_handout_revealed_attr(
            r#":::handout{id="h1" title="Parchment" revealed="false"}"#
        ));
        assert!(!parse_handout_revealed_attr(
            r#":::handout{id="h-trap" title="Notice: revealed=true is a trap" revealed="false"}"#
        ));
        assert!(parse_handout_revealed_attr(
            r#":::handout{id="h-trap" title="Notice: revealed=false is safe" revealed="true"}"#
        ));
        assert!(!parse_handout_revealed_attr(
            r#":::handout{id="h-trap" title='Notice: revealed=true is a trap' revealed='false'}"#
        ));
        assert!(parse_handout_revealed_attr(
            r#":::handout{id="h-trap" title='Notice: revealed=false is safe' revealed='true'}"#
        ));
        assert!(!parse_handout_revealed_attr(
            r#":::handout{id="h-trap" title="Notice: revealed=true is a trap"}"#
        ));
        assert!(!parse_handout_revealed_attr(
            r#":::handout{revealed="false" title="Trap: revealed=true"}"#
        ));
        assert!(parse_handout_revealed_attr(
            r#":::handout{revealed="true" title="Trap: revealed=false"}"#
        ));
    }

    #[test]
    fn test_reveal_handout_inserts_journal_and_session_event() {
        let journal = Arc::new(InMemoryPartyJournalStorage::new());
        let timeline = Arc::new(InMemoryTimelineStorage::new());

        let cmd = RevealHandoutCommand {
            action: "notes.reveal_handout".to_string(),
            campaign_id: "camp-alpha".to_string(),
            session_num: 1,
            handout_id: "h-456".to_string(),
            title: "Lettre interceptée".to_string(),
            content: "Rendez-vous à minuit au vieux moulin.".to_string(),
        };

        let broadcast = reveal_handout(
            UserRole::GameMaster,
            "user-gm-1",
            cmd.clone(),
            journal.as_ref(),
            timeline.as_ref(),
        )
        .expect("reveal handout succeeds for GM");

        assert_eq!(broadcast.event, "handout.revealed");
        assert_eq!(broadcast.handout_id, "h-456");
        assert_eq!(broadcast.revealed_by, "user-gm-1");

        let stored_entry = journal
            .get_entry("h-456")
            .expect("journal query succeeds")
            .expect("entry exists in party journal");
        assert_eq!(stored_entry.title, "Lettre interceptée");
        assert_eq!(
            stored_entry.content,
            "Rendez-vous à minuit au vieux moulin."
        );
        assert_eq!(stored_entry.revealed_by, "user-gm-1");

        let listed_entries = journal
            .list_entries("camp-alpha")
            .expect("list entries succeeds");
        assert_eq!(listed_entries.len(), 1);
        assert_eq!(listed_entries[0].handout_id, "h-456");

        let timeline_resp = timeline
            .get_timeline("camp-alpha", 1, 0, 10)
            .expect("timeline query succeeds");
        assert_eq!(timeline_resp.events.len(), 1);
        let ev = &timeline_resp.events[0];
        assert_eq!(ev.seq_id, 1);
        assert_eq!(ev.event_type, "handout_revealed");
        assert_eq!(ev.actor_id.as_deref(), Some("user-gm-1"));
        assert_eq!(ev.payload["handout_id"], "h-456");
        assert_eq!(ev.payload["title"], "Lettre interceptée");

        // Non-GM rejection
        let unauthorized_res = reveal_handout(
            UserRole::Player,
            "player-1",
            cmd,
            journal.as_ref(),
            timeline.as_ref(),
        );
        assert!(unauthorized_res.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn test_session_timeline_sequential_ordering_under_concurrency() {
        let timeline = Arc::new(InMemoryTimelineStorage::new());
        let campaign_id = "camp-concurrent";
        let session_num = 1;
        let mut handles = Vec::new();

        for i in 0..50 {
            let tl = timeline.clone();
            let h = tokio::spawn(async move {
                tl.append_event(
                    campaign_id,
                    session_num,
                    AppendEventInput {
                        event_type: "DiceRolled".to_string(),
                        actor_id: Some(format!("actor-{i}")),
                        payload: serde_json::json!({ "thread": i, "roll": 20 }),
                        timestamp: None,
                    },
                )
                .expect("append succeeds");
            });
            handles.push(h);
        }

        for h in handles {
            h.await.unwrap();
        }

        let resp = timeline
            .get_timeline(campaign_id, session_num, 0, 100)
            .expect("query timeline");

        assert_eq!(resp.events.len(), 50);
        for (expected_idx, event) in resp.events.iter().enumerate() {
            let expected_seq = (expected_idx as u64) + 1;
            assert_eq!(
                event.seq_id, expected_seq,
                "seq_id must be strictly sequential and contiguous"
            );
        }

        let (uri, md) = format_mcp_timeline(campaign_id, session_num, &resp.events);
        assert_eq!(uri, "campaign://camp-concurrent/sessions/1/timeline");
        assert!(md.contains("# Session Timeline: Campaign camp-concurrent, Session 1"));
        assert!(md.contains("[seq 1] [DiceRolled]"));
        assert!(md.contains("[seq 50] [DiceRolled]"));
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
                    let bystander = bystander_view.expect("Public roll visible to bystander");
                    assert_eq!(bystander.total, Some(outcome.total));
                }
                RollVisibility::GmOnly => {
                    assert_eq!(player_view.total, Some(outcome.total));
                    assert!(bystander_view.is_none(), "GmOnly hidden from other players");
                }
                RollVisibility::BlindGm => {
                    assert!(player_view.blind_masked);
                    assert_eq!(player_view.total, None);
                    assert!(player_view.terms.is_empty());
                    assert!(bystander_view.is_none(), "BlindGm hidden from bystanders");
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

        let first_frame = match rx.recv().await.unwrap() {
            OutboundClientFrame::Binary(bytes) => bytes,
            other => panic!("Expected binary frame, got {other:?}"),
        };
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

        let second_frame = match rx.recv().await.unwrap() {
            OutboundClientFrame::Binary(bytes) => bytes,
            other => panic!("Expected binary frame, got {other:?}"),
        };
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
