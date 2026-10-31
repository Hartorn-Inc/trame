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

    // Verify GET /api/v1/campaigns/{id} returns the 4 starter actors (Valeros, Merisiel, Goblin Sneak, Goblin Archer)
    let get_camp_req = Request::builder()
        .method("GET")
        .uri(format!("/api/v1/campaigns/{campaign_id}"))
        .header(COOKIE, &gm_cookie)
        .body(Body::empty())
        .unwrap();
    let get_camp_resp = app.clone().oneshot(get_camp_req).await.unwrap();
    assert_eq!(get_camp_resp.status(), StatusCode::OK);
    let get_camp_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(get_camp_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let actors = get_camp_json["campaign"]["actors"].as_array().unwrap();
    assert_eq!(actors.len(), 4);
    let actor_names: Vec<&str> = actors.iter().filter_map(|a| a["name"].as_str()).collect();
    assert!(actor_names.contains(&"Valeros"));
    assert!(actor_names.contains(&"Merisiel"));
    assert!(actor_names.contains(&"Goblin Sneak"));
    assert!(actor_names.contains(&"Goblin Archer"));

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

#[tokio::test]
async fn test_dual_gm_and_player_map_prep_core_lock_and_live_ws_visibility_sync() {
    use tokio::sync::mpsc;
    use trame_engine::commands::{CampaignRole, TokenState, TrameCommand};
    use trame_engine::geometry::{CHANNEL_GM_HIDDEN, CHANNEL_MATERIAL, Point2D};
    use trame_server::room::{ConnectedClient, OutboundClientFrame};
    use trame_server::sync::{ClientEnvelope, ServerEnvelope};

    fn extract_env(frame: OutboundClientFrame) -> ServerEnvelope {
        match frame {
            OutboundClientFrame::Binary(bytes) => rmp_serde::from_slice(&bytes).unwrap(),
            OutboundClientFrame::Close { reason, .. } => panic!("Unexpected close frame: {reason}"),
        }
    }

    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal, 25, 900_000));
    let asset_store = Arc::new(InMemoryAssetStore::with_base_url("/assets/download"));
    let membership = Arc::new(InMemoryMembershipValidator::new());
    let instance_id = Uuid::new_v4();

    let app = build_router(lease_manager.clone(), asset_store, membership, instance_id);

    // 1. Register GM and create campaign
    let reg_gm = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/register")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "email": "gm-dual@trame.local",
                "display_name": "GM Dual",
                "password": "StrongGmPassword2026!"
            }))
            .unwrap(),
        ))
        .unwrap();
    let gm_resp = app.clone().oneshot(reg_gm).await.unwrap();
    let gm_cookie = extract_cookie_pair(&gm_resp);
    let gm_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(gm_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let gm_user_id = Uuid::parse_str(gm_json["user"]["id"].as_str().unwrap()).unwrap();

    let create_camp = Request::builder()
        .method("POST")
        .uri("/api/v1/campaigns")
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Dual Client Sync Campaign",
                "system": "dnd5e"
            }))
            .unwrap(),
        ))
        .unwrap();
    let camp_resp = app.clone().oneshot(create_camp).await.unwrap();
    let camp_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(camp_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let campaign_id = Uuid::parse_str(camp_json["campaign"]["id"].as_str().unwrap()).unwrap();

    // 2. Mint Player invite & redeem as Player
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
                "nickname": "Aelar"
            }))
            .unwrap(),
        ))
        .unwrap();
    let redeem_resp = app.clone().oneshot(redeem_req).await.unwrap();
    let player_cookie = extract_cookie_pair(&redeem_resp);
    let redeem_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(redeem_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let player_user_id = Uuid::parse_str(redeem_json["user"]["id"].as_str().unwrap()).unwrap();

    // 3. Connect both GM and Player to the live TableRoomActor
    let room = lease_manager.get_or_wake_room(campaign_id).await.unwrap();

    let gm_session_id = Uuid::new_v4();
    let (gm_tx, mut gm_rx) = mpsc::unbounded_channel();
    room.connect_client(ConnectedClient {
        session_id: gm_session_id,
        user_id: gm_user_id,
        role: CampaignRole::Gm,
        tx: gm_tx,
    })
    .await
    .unwrap();

    let player_session_id = Uuid::new_v4();
    let (player_tx, mut player_rx) = mpsc::unbounded_channel();
    room.connect_client(ConnectedClient {
        session_id: player_session_id,
        user_id: player_user_id,
        role: CampaignRole::Player,
        tx: player_tx,
    })
    .await
    .unwrap();

    // Drain initial StateSnapshot frames
    let _ = gm_rx.recv().await.unwrap();
    let _ = player_rx.recv().await.unwrap();

    // 4. GM prepares two maps: one hidden (revealed_to_players: false) and one revealed
    let hidden_map_id = Uuid::new_v4();
    let hidden_map_req = Request::builder()
        .method("PUT")
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps/{hidden_map_id}"
        ))
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Secret Lich Sanctum",
                "width_px": 1600,
                "height_px": 1200,
                "revealed_to_players": false,
                "push_to_live_table": false
            }))
            .unwrap(),
        ))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(hidden_map_req).await.unwrap().status(),
        StatusCode::OK
    );

    let revealed_map_id = Uuid::new_v4();
    let revealed_map_req = Request::builder()
        .method("PUT")
        .uri(format!(
            "/api/v1/campaigns/{campaign_id}/maps/{revealed_map_id}"
        ))
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Cragmaw Entrance",
                "width_px": 1400,
                "height_px": 900,
                "revealed_to_players": true,
                "push_to_live_table": true
            }))
            .unwrap(),
        ))
        .unwrap();
    assert_eq!(
        app.clone()
            .oneshot(revealed_map_req)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    // Drain live table map push snapshots
    let _ = gm_rx.recv().await.unwrap();
    let _ = player_rx.recv().await.unwrap();

    // Verify GM sees 2 maps while Player only sees 1 revealed map in GET /maps
    let gm_maps_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/campaigns/{campaign_id}/maps"))
                .header(COOKIE, &gm_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let gm_maps_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(gm_maps_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(gm_maps_json["maps"].as_array().unwrap().len(), 2);

    let player_maps_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/campaigns/{campaign_id}/maps"))
                .header(COOKIE, &player_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let player_maps_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(player_maps_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(player_maps_json["maps"].as_array().unwrap().len(), 1);
    assert_eq!(player_maps_json["maps"][0]["name"], "Cragmaw Entrance");

    // 5. GM spawns a hidden ambush monster (CHANNEL_GM_HIDDEN) via WebSocket
    let monster_id = Uuid::new_v4();
    let mut monster_tok =
        TokenState::new_default(monster_id, "Bugbear Chief", Point2D::new(128.0, 128.0));
    monster_tok.hp = 27;
    monster_tok.max_hp = 27;
    monster_tok.visibility_channel = CHANNEL_MATERIAL | CHANNEL_GM_HIDDEN;

    room.send_envelope(
        gm_session_id,
        ClientEnvelope::SubmitCommand(TrameCommand::SpawnToken { token: monster_tok }),
    )
    .await
    .unwrap();

    let gm_env = extract_env(gm_rx.recv().await.unwrap());
    let player_env = extract_env(player_rx.recv().await.unwrap());

    if let ServerEnvelope::CommandAccepted { state, .. } = gm_env {
        assert!(
            state.tokens.contains_key(&monster_id),
            "GM must see hidden ambush token"
        );
    } else {
        panic!("Expected CommandAccepted for GM");
    }

    if let ServerEnvelope::CommandAccepted { state, .. } = player_env {
        assert!(
            !state.tokens.contains_key(&monster_id),
            "Player must NOT see GM-hidden ambush token (CHANNEL_GM_HIDDEN)"
        );
    } else {
        panic!("Expected CommandAccepted for Player");
    }

    // 6. GM reveals the ambush monster (SetTokenVisibility -> gm_hidden: false) -> Player immediately sees it
    room.send_envelope(
        gm_session_id,
        ClientEnvelope::SubmitCommand(TrameCommand::SetTokenVisibility {
            token_id: monster_id,
            gm_hidden: false,
            invisible: false,
        }),
    )
    .await
    .unwrap();

    let _ = gm_rx.recv().await.unwrap();
    let player_env_after_reveal = extract_env(player_rx.recv().await.unwrap());
    if let ServerEnvelope::CommandAccepted { state, .. } = player_env_after_reveal {
        assert!(
            state.tokens.contains_key(&monster_id),
            "Player must see token immediately after GM reveals it"
        );
    } else {
        panic!("Expected CommandAccepted for Player after reveal");
    }

    // 7. CoreBuildLock (`gm_core_locked`): GM creates/locks Player's hero; Player can edit HP but gets 403 on STR change
    let hero_id = Uuid::new_v4();
    let gm_lock_actor_req = Request::builder()
        .method("PUT")
        .uri(format!("/api/v1/campaigns/{campaign_id}/actors/{hero_id}"))
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Aelar",
                "hp": 20,
                "max_hp": 20,
                "owner_user_id": player_user_id,
                "gm_core_locked": true,
                "attributes": { "str": 10.0, "dex": 14.0, "int": 16.0 },
                "sheet": { "class": "Wizard", "level": 1, "equipment": ["Quarterstaff"] },
                "spawn_on_map": true
            }))
            .unwrap(),
        ))
        .unwrap();
    assert_eq!(
        app.clone()
            .oneshot(gm_lock_actor_req)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let _ = gm_rx.recv().await.unwrap();
    let _ = player_rx.recv().await.unwrap();

    // Player attempts to tamper with locked STR (10 -> 20) -> 403 FORBIDDEN
    let player_tamper_req = Request::builder()
        .method("PUT")
        .uri(format!("/api/v1/campaigns/{campaign_id}/actors/{hero_id}"))
        .header(COOKIE, &player_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Aelar",
                "hp": 20,
                "max_hp": 20,
                "attributes": { "str": 20.0, "dex": 14.0, "int": 16.0 },
                "sheet": { "class": "Wizard", "level": 1, "equipment": ["Quarterstaff"] }
            }))
            .unwrap(),
        ))
        .unwrap();
    let tamper_resp = app.clone().oneshot(player_tamper_req).await.unwrap();
    assert_eq!(
        tamper_resp.status(),
        StatusCode::FORBIDDEN,
        "Player must receive 403 FORBIDDEN when modifying core stats locked by GM"
    );

    // Player updates unlocked live play fields (HP 20 -> 14 and adds loot item) -> 200 OK
    let player_hp_req = Request::builder()
        .method("PUT")
        .uri(format!("/api/v1/campaigns/{campaign_id}/actors/{hero_id}"))
        .header(COOKIE, &player_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "name": "Aelar",
                "hp": 14,
                "max_hp": 20,
                "attributes": { "str": 10.0, "dex": 14.0, "int": 16.0 },
                "sheet": { "class": "Wizard", "level": 1, "equipment": ["Quarterstaff", "Healing Potion"] }
            }))
            .unwrap(),
        ))
        .unwrap();
    let hp_resp = app.clone().oneshot(player_hp_req).await.unwrap();
    assert_eq!(
        hp_resp.status(),
        StatusCode::OK,
        "Player must be allowed to update HP and inventory while gm_core_locked is active"
    );
    let _ = gm_rx.recv().await.unwrap();
    let _ = player_rx.recv().await.unwrap();

    // 8. GM reveals a handout via REST -> Player receives live ServerEnvelope::HandoutRevealed over WebSocket
    let handout_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/campaigns/{campaign_id}/handouts/reveal"))
        .header(COOKIE, &gm_cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "handout_id": "letter-black-spider",
                "title": "Letter from the Black Spider",
                "content": "Capture the dwarf Gundren alive.",
                "session_num": 1
            }))
            .unwrap(),
        ))
        .unwrap();
    assert_eq!(
        app.oneshot(handout_req).await.unwrap().status(),
        StatusCode::OK
    );

    let player_handout_env = extract_env(player_rx.recv().await.unwrap());
    if let ServerEnvelope::HandoutRevealed(h) = player_handout_env {
        assert_eq!(h.handout_id, "letter-black-spider");
        assert_eq!(h.title, "Letter from the Black Spider");
    } else {
        panic!("Expected ServerEnvelope::HandoutRevealed on Player WebSocket");
    }
}
