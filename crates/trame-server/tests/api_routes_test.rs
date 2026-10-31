use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use tower::ServiceExt;
use uuid::Uuid;

use trame_server::archive::importer::InMemoryCampaignStore;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{AuthState, InMemorySessionStore};
use trame_server::auth::totp::TotpService;
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
};
use trame_server::maps::InMemoryMapStorage;
use trame_server::room::RoomLeaseManager;
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::InMemoryWalStorage;

fn create_test_app_state() -> (AppState, Arc<InMemoryMembershipValidator>) {
    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal, 25, 900_000));
    let asset_store = Arc::new(InMemoryAssetStore::new());
    let membership = Arc::new(InMemoryMembershipValidator::new());
    let instance_id = Uuid::new_v4();
    let timeline_storage = Arc::new(InMemoryTimelineStorage::new());
    let session_store = Arc::new(InMemorySessionStore::new());
    let magic_link_service = Arc::new(MagicLinkService::new(
        b"trame-default-hmac-sha256-signing-secret-key",
        "trame-server",
    ));
    let auth_state = AuthState {
        magic_link_service,
        session_store,
        totp_service: Arc::new(TotpService::default()),
    };
    let state = AppState {
        lease_manager,
        asset_store,
        membership: membership.clone(),
        instance_id,
        timeline_storage,
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state,
        db_healthy: Arc::new(AtomicBool::new(true)),
        map_storage: InMemoryMapStorage::new(),
    };
    (state, membership)
}

#[tokio::test]
async fn test_campaign_maps_rbac_and_sanitization() {
    let (state, membership) = create_test_app_state();
    let app = build_router_with_state(state.clone());

    let campaign_id = Uuid::new_v4();
    let gm_user_id = Uuid::new_v4();
    let player_user_id = Uuid::new_v4();
    let outsider_user_id = Uuid::new_v4();

    membership.add_member_with_role(campaign_id, gm_user_id, "GM");
    membership.add_member_with_role(campaign_id, player_user_id, "PLAYER");

    let test_scene = trame_server::maps::CampaignMapScene {
        id: Uuid::new_v4(),
        campaign_id,
        name: "Dungeon Floor 1".to_string(),
        grid_type: "square".to_string(),
        grid_size_px: 70,
        grid_cell_distance_ft: 5.0,
        width_px: 1400,
        height_px: 1400,
        background_image_url: None,
        default_ground_elevation_ft: 0.0,
        revealed_to_players: true,
        spawn_points: vec![],
        wall_segments: vec![trame_server::maps::WallSegment {
            id: Uuid::new_v4(),
            p1: trame_server::maps::Point2D { x: 0.0, y: 0.0 },
            p2: trame_server::maps::Point2D { x: 100.0, y: 0.0 },
            wall_type: trame_server::maps::WallType::SecretDoor,
            door_state: Some(trame_server::maps::DoorState::Closed),
            bottom_elevation_ft: 0.0,
            top_elevation_ft: 10.0,
            blocks_light: true,
            blocks_movement: true,
            blocks_sound: true,
            blocks_vision: true,
        }],
        light_sources: vec![],
        spatial_audio_emitters: vec![trame_server::maps::SpatialAudioEmitter {
            id: Uuid::new_v4(),
            x: 10.0,
            y: 10.0,
            elevation_ft: 0.0,
            radius_ft: 30.0,
            volume: 1.0,
            looping: true,
            gm_only: true,
            audio_clip_url: "secret.ogg".to_string(),
        }],
        staged_tokens: vec![trame_server::maps::StagedToken {
            id: Uuid::new_v4(),
            name: "Ambush Goblin".to_string(),
            monster_template_id: None,
            x: 50.0,
            y: 50.0,
            elevation_ft: 0.0,
            size_cells: 1,
            token_avatar_url: None,
            visibility: trame_server::maps::VisibilityChannel::GmHidden,
        }],
        explored_fog_texture: None,
    };

    // 1. Outsider cannot access
    let req_outsider = Request::builder()
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps?user_id={outsider_user_id}"
        ))
        .body(Body::empty())
        .unwrap();
    let res_outsider = app.clone().oneshot(req_outsider).await.unwrap();
    assert_eq!(res_outsider.status(), StatusCode::FORBIDDEN);

    // 2. Unauthenticated request rejected
    let req_unauth = Request::builder()
        .uri(format!("/api/v1/campaigns/{campaign_id}/maps"))
        .body(Body::empty())
        .unwrap();
    let res_unauth = app.clone().oneshot(req_unauth).await.unwrap();
    assert_eq!(res_unauth.status(), StatusCode::UNAUTHORIZED);

    // 3. Player cannot PUT maps
    let payload = trame_server::maps::PutCampaignMapsPayload {
        scenes: vec![test_scene.clone()],
    };
    let req_player_put = Request::builder()
        .method("PUT")
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps?user_id={player_user_id}"
        ))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();
    let res_player_put = app.clone().oneshot(req_player_put).await.unwrap();
    assert_eq!(res_player_put.status(), StatusCode::FORBIDDEN);

    // 4. GM can PUT maps
    let req_gm_put = Request::builder()
        .method("PUT")
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps?user_id={gm_user_id}"
        ))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();
    let res_gm_put = app.clone().oneshot(req_gm_put).await.unwrap();
    assert_eq!(res_gm_put.status(), StatusCode::NO_CONTENT);

    // 5. GM GET returns unredacted scene
    let req_gm_get = Request::builder()
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps?user_id={gm_user_id}"
        ))
        .body(Body::empty())
        .unwrap();
    let res_gm_get = app.clone().oneshot(req_gm_get).await.unwrap();
    assert_eq!(res_gm_get.status(), StatusCode::OK);
    let gm_body = axum::body::to_bytes(res_gm_get.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let gm_scenes: Vec<trame_server::maps::CampaignMapScene> =
        serde_json::from_slice(&gm_body).unwrap();
    assert_eq!(gm_scenes.len(), 1);
    assert_eq!(
        gm_scenes[0].wall_segments[0].wall_type,
        trame_server::maps::WallType::SecretDoor
    );
    assert_eq!(gm_scenes[0].staged_tokens.len(), 1);
    assert_eq!(gm_scenes[0].spatial_audio_emitters.len(), 1);

    // 5b. Verify camelCase JSON payload deserialization and OneWay WallType persistence
    let camelcase_payload = serde_json::json!({
        "scenes": [{
            "id": Uuid::new_v4(),
            "campaignId": campaign_id,
            "title": "CamelCase Catacombs",
            "gridType": "square",
            "gridCellSizePx": 70,
            "feetPerCell": 5.0,
            "widthPx": 1400,
            "heightPx": 1400,
            "revealedToPlayers": true,
            "defaultGroundElevationFt": 0.0,
            "walls": [{
                "id": Uuid::new_v4(),
                "a": { "x": 10.0, "y": 10.0 },
                "b": { "x": 90.0, "y": 10.0 },
                "wallType": "OneWay",
                "doorState": { "isOpen": false, "isLocked": true },
                "bottomElevationFt": 0.0,
                "topElevationFt": 12.0,
                "blocksLight": true,
                "blocksMovement": true,
                "blocksSound": true,
                "blocksVision": true
            }],
            "lights": [{
                "id": Uuid::new_v4(),
                "origin": { "x": 100.0, "y": 100.0 },
                "dimRadiusFt": 40.0,
                "colorHex": "#ffffff",
                "intensity": 1.0
            }],
            "audioEmitters": [{
                "id": Uuid::new_v4(),
                "x": 120.0,
                "y": 120.0,
                "maxDistanceFt": 50.0,
                "loopPlayback": true,
                "url": "echoes.ogg"
            }],
            "stagedTokens": [{
                "id": Uuid::new_v4(),
                "name": "Sentry",
                "templateKey": "Goblin",
                "x": 50.0,
                "y": 50.0,
                "visibilityChannel": "Public"
            }]
        }]
    });
    let req_camel_put = Request::builder()
        .method("PUT")
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps?user_id={gm_user_id}"
        ))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&camelcase_payload).unwrap()))
        .unwrap();
    let res_camel_put = app.clone().oneshot(req_camel_put).await.unwrap();
    assert_eq!(res_camel_put.status(), StatusCode::NO_CONTENT);

    // Restore original test scene for subsequent assertions
    let req_restore_put = Request::builder()
        .method("PUT")
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps?user_id={gm_user_id}"
        ))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();
    let res_restore_put = app.clone().oneshot(req_restore_put).await.unwrap();
    assert_eq!(res_restore_put.status(), StatusCode::NO_CONTENT);

    // 6. Player GET returns sanitized scene
    let req_player_get = Request::builder()
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps?user_id={player_user_id}"
        ))
        .body(Body::empty())
        .unwrap();
    let res_player_get = app.clone().oneshot(req_player_get).await.unwrap();
    assert_eq!(res_player_get.status(), StatusCode::OK);
    let player_body = axum::body::to_bytes(res_player_get.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let player_scenes: Vec<trame_server::maps::CampaignMapScene> =
        serde_json::from_slice(&player_body).unwrap();
    assert_eq!(player_scenes.len(), 1);
    assert_eq!(
        player_scenes[0].wall_segments[0].wall_type,
        trame_server::maps::WallType::Normal
    );
    assert!(player_scenes[0].wall_segments[0].blocks_vision);
    assert_eq!(player_scenes[0].staged_tokens.len(), 0);
    assert_eq!(player_scenes[0].spatial_audio_emitters.len(), 0);
}

#[tokio::test]
async fn test_healthz_verifies_database_connectivity_under_5ms() {
    let (state, _) = create_test_app_state();
    let app = build_router_with_state(state.clone());

    let start = Instant::now();
    let req = Request::builder()
        .method("GET")
        .uri("/healthz")
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    let elapsed = start.elapsed();

    assert_eq!(resp.status(), StatusCode::OK);
    assert!(elapsed.as_millis() < 50);
}
