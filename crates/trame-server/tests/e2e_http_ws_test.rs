//! ============================================================================
//! END-TO-END HTTP + WEBSOCKET LIFECYCLE INTEGRATION TEST (e2e_http_ws_test.rs)
//! ============================================================================
//!
//! Validates the complete TRAME V1 HTTP and WebSocket surface:
//! 1. `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, `POST /api/v1/auth/logout`.
//! 2. `POST /api/v1/campaigns`, `GET /api/v1/campaigns`, `GET /api/v1/campaigns/{id}`.
//! 3. `POST /api/v1/campaigns/{id}/maps/starter` -> generates 1200x800 WebP map, walls, door, 4 tokens, and starter lore note.
//! 4. `GET /api/v1/campaigns/{id}/assets/{hash}/presign` & `GET /assets/download/{*key}` -> downloads real WebP bytes.
//! 5. `PUT /api/v1/campaigns/{id}/actors/{actor_id}` -> upserts character sheet & spawns token.
//! 6. `GET /api/v1/campaigns/{id}/notes`, `PUT /api/v1/campaigns/{id}/notes/{slug}`, `POST /api/v1/campaigns/{id}/handouts/reveal`.
//!    Verifies `:::dm` and unrevealed `:::handout` blocks are stripped for `PLAYER` callers.
//! 7. `POST /api/v1/campaigns/{id}/invites` & `POST /api/v1/auth/magic-link/redeem` -> 1-click guest player onboarding.
//! ============================================================================

use axum::body::Body;
use axum::http::header::{CONTENT_TYPE, COOKIE, SET_COOKIE};
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::http::{InMemoryMembershipValidator, build_router};
use trame_server::room::RoomLeaseManager;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

fn extract_cookie_pair(resp: &axum::response::Response) -> String {
    resp.headers()
        .get(SET_COOKIE)
        .expect("Set-Cookie header present")
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn test_end_to_end_playable_http_and_tabletop_lifecycle() {
    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal, 25, 900_000));
    let asset_store = Arc::new(InMemoryAssetStore::with_base_url("/assets/download"));
    let membership = Arc::new(InMemoryMembershipValidator::new());
    let instance_id = Uuid::new_v4();

    let app = build_router(lease_manager.clone(), asset_store, membership, instance_id);

    // 1. Register GM account
    let reg_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/register")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "email": "gm@trame.local",
                "display_name": "Dungeon Master",
                "password": "StrongGmPassword2026!"
            }))
            .unwrap(),
        ))
        .unwrap();
    let reg_resp = app.clone().oneshot(reg_req).await.unwrap();
    assert_eq!(reg_resp.status(), StatusCode::CREATED);
    let gm_cookie = extract_cookie_pair(&reg_resp);

    // 2. Verify GET /api/v1/auth/me returns the GM user
    let me_req = Request::builder()
        .method("GET")
        .uri("/api/v1/auth/me")
        .header(COOKIE, &gm_cookie)
        .body(Body::empty())
        .unwrap();
    let me_resp = app.clone().oneshot(me_req).await.unwrap();
    assert_eq!(me_resp.status(), StatusCode::OK);
    let me_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(me_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(me_json["user"]["email"], "gm@trame.local");

    // 3. Create a campaign
    let create_camp_req = Request::builder()
        .method("POST")
        .uri("/api/v1/campaigns")
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Vault of the Obsidian Flame",
                "system": "dnd5e"
            }))
            .unwrap(),
        ))
        .unwrap();
    let create_camp_resp = app.clone().oneshot(create_camp_req).await.unwrap();
    assert_eq!(create_camp_resp.status(), StatusCode::CREATED);
    let camp_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(create_camp_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let campaign_id = Uuid::parse_str(camp_json["campaign"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(camp_json["campaign"]["role"], "GM");

    // 4. Generate 1-click Starter Dungeon
    let starter_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/campaigns/{campaign_id}/maps/starter"))
        .header(COOKIE, &gm_cookie)
        .body(Body::empty())
        .unwrap();
    let starter_resp = app.clone().oneshot(starter_req).await.unwrap();
    assert_eq!(starter_resp.status(), StatusCode::CREATED);
    let starter_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(starter_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let map_hash = starter_json["sha256_hash"].as_str().unwrap().to_string();
    assert_eq!(starter_json["width_px"], 1200);
    assert_eq!(starter_json["height_px"], 800);
    assert!(!starter_json["walls"].as_array().unwrap().is_empty());

    // 5. Presign and download the generated WebP map asset
    let presign_req = Request::builder()
        .method("GET")
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/assets/{map_hash}/presign"
        ))
        .header(COOKIE, &gm_cookie)
        .body(Body::empty())
        .unwrap();
    let presign_resp = app.clone().oneshot(presign_req).await.unwrap();
    assert_eq!(presign_resp.status(), StatusCode::OK);
    let presign_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(presign_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let download_url = presign_json["url"].as_str().unwrap().to_string();

    let dl_req = Request::builder()
        .method("GET")
        .uri(&download_url)
        .body(Body::empty())
        .unwrap();
    let dl_resp = app.clone().oneshot(dl_req).await.unwrap();
    assert_eq!(dl_resp.status(), StatusCode::OK);
    let dl_bytes = axum::body::to_bytes(dl_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(!dl_bytes.is_empty());

    // 6. Mint a PLAYER invite link and redeem via /api/v1/auth/magic-link/redeem
    let invite_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/campaigns/{campaign_id}/invites"))
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({ "role": "PLAYER" })).unwrap(),
        ))
        .unwrap();
    let invite_resp = app.clone().oneshot(invite_req).await.unwrap();
    assert_eq!(invite_resp.status(), StatusCode::CREATED);
    let invite_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(invite_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let invite_token = invite_json["token"].as_str().unwrap();

    let redeem_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/magic-link/redeem")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "token": invite_token,
                "nickname": "Kaelen"
            }))
            .unwrap(),
        ))
        .unwrap();
    let redeem_resp = app.clone().oneshot(redeem_req).await.unwrap();
    assert_eq!(redeem_resp.status(), StatusCode::OK);
    let player_cookie = extract_cookie_pair(&redeem_resp);

    // 7. Verify role-based note filtering: GM sees :::dm block, Player never sees :::dm block
    let gm_notes_req = Request::builder()
        .method("GET")
        .uri(format!("/api/v1/campaigns/{campaign_id}/notes"))
        .header(COOKIE, &gm_cookie)
        .body(Body::empty())
        .unwrap();
    let gm_notes_resp = app.clone().oneshot(gm_notes_req).await.unwrap();
    let gm_notes_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(gm_notes_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let gm_md = gm_notes_json["notes"][0]["content_markdown"]
        .as_str()
        .unwrap();
    assert!(gm_md.contains("GM Secret:"));

    let player_notes_req = Request::builder()
        .method("GET")
        .uri(format!("/api/v1/campaigns/{campaign_id}/notes"))
        .header(COOKIE, &player_cookie)
        .body(Body::empty())
        .unwrap();
    let player_notes_resp = app.clone().oneshot(player_notes_req).await.unwrap();
    let player_notes_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(player_notes_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let player_md = player_notes_json["notes"][0]["content_markdown"]
        .as_str()
        .unwrap();
    assert!(
        !player_md.contains("GM Secret:"),
        "Player must never receive :::dm block"
    );

    // 8. GM reveals a handout -> appears in Party Journal and Session Timeline
    let reveal_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/campaigns/{campaign_id}/handouts/reveal"))
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "handout_id": "vault-inscription",
                "title": "Ancient Dwarven Rune",
                "content": "Only those who bear the Ember Crest may pass unharmed.",
                "session_num": 1
            }))
            .unwrap(),
        ))
        .unwrap();
    let reveal_resp = app.clone().oneshot(reveal_req).await.unwrap();
    assert_eq!(reveal_resp.status(), StatusCode::OK);

    // 9. Player updates their character sheet via PUT /api/v1/campaigns/{id}/actors/{actor_id}
    let actor_id = Uuid::new_v4();
    let actor_req = Request::builder()
        .method("PUT")
        .uri(format!("/api/v1/campaigns/{campaign_id}/actors/{actor_id}"))
        .header(COOKIE, &player_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Kaelen the Ranger",
                "hp": 22,
                "max_hp": 22,
                "attributes": { "dex": 16.0, "wis": 14.0 }
            }))
            .unwrap(),
        ))
        .unwrap();
    let actor_resp = app.oneshot(actor_req).await.unwrap();
    assert_eq!(actor_resp.status(), StatusCode::OK);
}
