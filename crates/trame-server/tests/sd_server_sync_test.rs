//! ============================================================================
//! S-D SERVER SYNC SEAM SUITE (sd_server_sync_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Proves the wave 2 server-sync slice through the full Axum router, a real
//!   WebSocket where the transport matters, and the MCP endpoint:
//!   - GS6: linked tokens follow the sheet's derived AC and speed, including
//!     Speed 0 from conditions.
//!   - UA2 / UA14 / D7: staged and spawned tokens carry a bounds-validated stat
//!     block copy and take every combat number from it, on the WebSocket and
//!     the MCP spawn paths alike.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Each rule is a parametrized table of `(case_id, input, expected)`.
//!   - Rooms are inspected through `TableRoomHandle::get_table_snapshot`, never
//!     through private actor state.
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tower::ServiceExt;
use trame_engine::commands::{
    CampaignRole, CommandActor, TableMode, TableState, TokenState, TrameCommand,
};
use trame_engine::geometry::Point2D;
use trame_server::archive::InMemoryCampaignStore;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::auth::accounts::InstanceRole;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{
    AuthState, InMemorySessionStore, SessionStore, UserRecord, hash_session_token,
};
use trame_server::auth::totp::TotpService;
use trame_server::campaigns::tactical_sync_from_sheet;
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
};
use trame_server::maps::InMemoryMapStorage;
use trame_server::room::{RoomLeaseManager, TableRoomHandle};
use trame_server::security::SecurityPolicy;
use trame_server::statblock::{MAX_STAT_BLOCK_BYTES, resolve_stat_block, srd_stat_block};
use trame_server::sync::{ClientEnvelope, CommandSubmission, ServerEnvelope};
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

const SECRET: &[u8] = b"sd-test-invite-secret-at-least-32-bytes!";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    state: AppState,
}

impl Harness {
    fn new() -> Self {
        Self::with_policy(SecurityPolicy::default())
    }

    fn with_policy(policy: SecurityPolicy) -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let auth_state = AuthState::with_security(
            Arc::new(MagicLinkService::new(SECRET.to_vec(), "trame-test")),
            Arc::new(InMemorySessionStore::new()),
            Arc::new(TotpService::default()),
            Arc::new(policy),
        );
        let state = AppState {
            lease_manager: Arc::new(RoomLeaseManager::new(wal, 25, 900_000)),
            asset_store: Arc::new(InMemoryAssetStore::with_ephemeral_secret()),
            membership: Arc::new(InMemoryMembershipValidator::new()),
            instance_id: Uuid::new_v4(),
            timeline_storage: Arc::new(InMemoryTimelineStorage::new()),
            campaign_store: InMemoryCampaignStore::new(),
            blob_store: InMemoryBlobStore::new(),
            auth_state,
            db_healthy: Arc::new(AtomicBool::new(true)),
            map_storage: InMemoryMapStorage::new(),
            postgres_store: None,
            campaign_data: Default::default(),
            static_dir: None,
        };
        Self { state }
    }

    fn app(&self) -> Router {
        build_router_with_state(self.state.clone())
    }

    /// `Host` account with a live session -> `(user_id, cookie_header)`.
    async fn account(&self) -> (Uuid, String) {
        let user_id = Uuid::new_v4();
        let store = &self.state.auth_state.session_store;
        store
            .save_user(UserRecord {
                id: user_id,
                username: format!("user-{user_id}"),
                role: "PLAYER".to_string(),
                is_guest: false,
                created_at: 0,
                email: Some(format!("{user_id}@example.com")),
                password_hash: None,
                mfa_enabled: false,
                totp_secret: None,
                pending_totp_secret: None,
                instance_role: InstanceRole::Host,
            })
            .await
            .unwrap();
        let token = format!("sd-session-{user_id}");
        store
            .create_session(user_id, &hash_session_token(&token), 3600)
            .await
            .unwrap();
        (user_id, format!("trame_session={token}"))
    }

    /// GM-created campaign -> `(campaign_id, gm_id, gm_cookie)`.
    async fn campaign(&self, app: &Router) -> (Uuid, Uuid, String) {
        let (gm, cookie) = self.account().await;
        let (status, body) = call(
            app,
            "POST",
            "/api/v1/campaigns",
            Some(&cookie),
            json!({ "name": "Phandelver" }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = Uuid::parse_str(body["campaign"]["id"].as_str().unwrap()).unwrap();
        (id, gm, cookie)
    }

    /// Player member of `campaign_id` -> `(user_id, cookie_header)`.
    async fn player(&self, campaign_id: Uuid) -> (Uuid, String) {
        let (user_id, cookie) = self.account().await;
        self.state
            .auth_state
            .session_store
            .assign_campaign_member(campaign_id, user_id, None, "PLAYER")
            .await
            .unwrap();
        (user_id, cookie)
    }

    async fn room(&self, campaign_id: Uuid) -> TableRoomHandle {
        self.state
            .lease_manager
            .get_or_wake_room(campaign_id)
            .await
            .unwrap()
    }

    /// Creates an actor through the REST route and returns its id.
    async fn actor(&self, app: &Router, campaign_id: Uuid, cookie: &str, data: Value) -> Uuid {
        let (status, created) = call(
            app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/actors"),
            Some(cookie),
            json!({ "name": "Template", "data": data }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        Uuid::parse_str(created["actor"]["id"].as_str().unwrap()).unwrap()
    }
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    let payload = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let resp = app
        .clone()
        .oneshot(builder.body(payload).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn mcp_dispatch(app: &Router, cookie: &str, campaign_id: Uuid, command: Value) -> Value {
    let (status, body) = call(
        app,
        "POST",
        "/api/v1/mcp",
        Some(cookie),
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "trame.dispatch_command",
                        "arguments": { "campaign_id": campaign_id, "command": command } }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn table(room: &TableRoomHandle) -> TableState {
    room.get_table_snapshot().await.unwrap().1
}

fn gm_actor(user_id: Uuid) -> CommandActor {
    CommandActor {
        user_id,
        role: CampaignRole::Gm,
    }
}

/// A token whose client-side numbers are deliberately absurd, so the test can tell that the
/// server replaced them.
fn lying_token(stat_block: Option<Value>) -> TokenState {
    let mut t = TokenState::new_default(Uuid::new_v4(), "Goblin 1", Point2D::new(0.0, 0.0));
    t.hp = 999;
    t.max_hp = 999;
    t.ac = 30;
    t.speed_max_ft = 120.0;
    t.speed_remaining_ft = 120.0;
    t.reach_ft = 60.0;
    t.senses.darkvision_range_ft = 500.0;
    t.grid_w = 4;
    t.grid_h = 4;
    t.stat_block = stat_block;
    t
}

fn spawn_value(t: &TokenState) -> Value {
    serde_json::to_value(TrameCommand::SpawnToken {
        token: Box::new(t.clone()),
    })
    .unwrap()
}

/// `(hp, max_hp, ac, speed_max_ft, darkvision_ft, reach_ft, grid_w, resistances)` of a token.
type Combat = (i32, i32, i32, f64, f64, f64, u8, Vec<String>);

fn combat(t: &TokenState) -> Combat {
    (
        t.hp,
        t.max_hp,
        t.ac,
        t.speed_max_ft,
        t.senses.darkvision_range_ft,
        t.reach_ft,
        t.grid_w,
        t.damage_resistances.clone(),
    )
}

/// SRD Goblin Warrior: 10 HP, AC 15, 30 ft, darkvision 60 ft, 5 ft reach, Small.
fn goblin_combat() -> Combat {
    (10, 10, 15, 30.0, 60.0, 5.0, 1, vec![])
}

/// A homebrew Large ogre-like block with a 10 ft reach attack and fire resistance.
fn homebrew_block() -> Value {
    json!({
        "name": "Bog Brute", "size": "large", "creatureType": "giant", "alignment": "unaligned",
        "armorClass": { "value": 13 }, "hitPoints": { "average": 59, "formula": "7d10 + 21" },
        "speed": { "walk": 40 }, "abilities": { "str": 19, "dex": 8, "con": 16, "int": 5, "wis": 7, "cha": 7 },
        "savingThrows": {}, "skills": {}, "initiativeBonus": -1,
        "senses": { "darkvision": 30, "passivePerception": 8 }, "languages": "",
        "challengeRating": 2, "xp": 450, "proficiencyBonus": 2,
        "damageVulnerabilities": [], "damageResistances": ["fire"], "damageImmunities": [],
        "conditionImmunities": [], "traits": [],
        "actions": [
            { "id": "club", "name": "Club", "description": "", "automation": "full",
              "attack": { "kind": "melee", "toHit": 6, "reachFt": 10 } },
            { "id": "rock", "name": "Rock", "description": "", "automation": "full",
              "attack": { "kind": "ranged", "toHit": 6, "rangeFt": 60 } }
        ],
        "bonusActions": [], "reactions": [], "source": "homebrew"
    })
}

fn homebrew_combat() -> Combat {
    (59, 59, 13, 40.0, 30.0, 10.0, 2, vec!["fire".to_string()])
}

fn with(mut block: Value, pointer: &str, value: Value) -> Value {
    *block.pointer_mut(pointer).unwrap() = value;
    block
}

// ---------------------------------------------------------------------------
// GS6 — linked tokens follow the sheet's derived AC and speed
// ---------------------------------------------------------------------------

#[test]
fn sheet_derives_armor_class_and_speed() {
    // (case_id, sheet, expected (ac, speed_ft))
    let cases = [
        ("bare_sheet_keeps_token_values", json!({}), (None, None)),
        (
            "derived_armor_class_wins_over_flat_ac",
            json!({ "derived": { "armorClass": 16 }, "attributes": { "ac": 12, "speedFt": 30 } }),
            (Some(16), Some(30.0)),
        ),
        (
            "legacy_flat_ac_still_syncs",
            json!({ "attributes": { "ac": 17 } }),
            (Some(17), None),
        ),
        (
            "stat_block_actor_uses_armor_class_and_walk_speed",
            json!({ "armorClass": { "value": 13 }, "speed": { "walk": 40 } }),
            (Some(13), Some(40.0)),
        ),
        (
            "exhaustion_two_slows_by_10_ft",
            json!({ "attributes": { "speedFt": 30, "exhaustion": 2 } }),
            (None, Some(20.0)),
        ),
        (
            "exhaustion_never_drives_speed_negative",
            json!({ "attributes": { "speedFt": 10, "exhaustion": 6 } }),
            (None, Some(0.0)),
        ),
        (
            "legacy_speed_key_still_syncs",
            json!({ "attributes": { "speed": 25 } }),
            (None, Some(25.0)),
        ),
        (
            "monk_level_2_unarmored_movement_from_derived_speed",
            json!({ "derived": { "armorClass": 15, "speed": 40 },
                    "attributes": { "speedFt": 30 } }),
            (Some(15), Some(40.0)),
        ),
        (
            "barbarian_fast_movement_with_exhaustion_from_derived_speed",
            json!({ "derived": { "speed": 35 },
                    "attributes": { "speedFt": 30, "exhaustion": 1 } }),
            (None, Some(35.0)),
        ),
    ];
    for (case, sheet, expected) in cases {
        let sync = tactical_sync_from_sheet(None, &sheet);
        assert_eq!((sync.ac, sync.speed_ft), expected, "case {case}");
    }
}

#[test]
fn sheet_values_get_stat_block_bounds_on_the_token() {
    let many: Vec<Value> = (0..40).map(|i| json!({ "id": format!("c{i}") })).collect();
    let capped: Vec<String> = (0..32).map(|i| format!("c{i}")).collect();
    // (case_id, sheet, expected (ac, speed_max_ft, conditions))
    let cases = [
        (
            "derived_ac_above_30_is_clamped",
            json!({ "derived": { "armorClass": 99 } }),
            (30, 30.0, vec![]),
        ),
        (
            "derived_ac_below_1_is_clamped",
            json!({ "derived": { "armorClass": -4 } }),
            (1, 30.0, vec![]),
        ),
        (
            "derived_speed_above_200_is_clamped",
            json!({ "derived": { "speed": 5000 } }),
            (10, 200.0, vec![]),
        ),
        (
            "negative_derived_speed_is_floored",
            json!({ "derived": { "speed": -30 } }),
            (10, 0.0, vec![]),
        ),
        (
            "conditions_are_trimmed_lowercased_and_deduplicated",
            json!({ "conditions": [{ "id": " Prone " }, { "id": "prone" }, "POISONED", { "id": "" }] }),
            (10, 30.0, vec!["prone".to_string(), "poisoned".to_string()]),
        ),
        (
            "oversized_condition_id_is_dropped",
            json!({ "conditions": [{ "id": "x".repeat(65) }, { "id": "prone" }] }),
            (10, 30.0, vec!["prone".to_string()]),
        ),
        (
            "conditions_are_capped_at_32",
            json!({ "conditions": many }),
            (10, 30.0, capped),
        ),
    ];
    for (case, sheet, (ac, speed, conditions)) in cases {
        let mut token = TokenState::new_default(Uuid::new_v4(), "Hero", Point2D::new(0.0, 0.0));
        tactical_sync_from_sheet(None, &sheet).apply_to_token(&mut token, TableMode::Exploration);
        assert_eq!(
            (token.ac, token.speed_max_ft, token.conditions),
            (ac, speed, conditions),
            "case {case}"
        );
    }
}

#[tokio::test]
async fn linked_token_follows_sheet_ac_speed_and_speed_zero_conditions() {
    // (case_id, sheet saved after spawn, expected (ac, speed_max_ft, speed_remaining_ft))
    let cases = [
        (
            "derived_ac_and_species_speed",
            json!({ "derived": { "armorClass": 16 }, "attributes": { "speedFt": 30 } }),
            (16, 30.0, 30.0),
        ),
        (
            "grappled_has_no_movement_left_but_keeps_its_speed",
            json!({ "derived": { "armorClass": 16 }, "attributes": { "speedFt": 30 },
                    "conditions": [{ "id": "grappled" }] }),
            (16, 30.0, 0.0),
        ),
        (
            "exhausted_and_prone_moves_at_reduced_speed",
            json!({ "derived": { "armorClass": 14 }, "attributes": { "speedFt": 30, "exhaustion": 1 },
                    "conditions": [{ "id": "prone" }] }),
            (14, 25.0, 25.0),
        ),
    ];
    for (case, sheet, expected) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, gm_id, gm) = h.campaign(&app).await;
        let actor_id = h.actor(&app, campaign_id, &gm, json!({})).await;
        let mut t = TokenState::new_default(Uuid::new_v4(), "Hero", Point2D::new(0.0, 0.0));
        t.actor_id = Some(actor_id);
        let room = h.room(campaign_id).await;
        room.dispatch_direct_command(
            gm_actor(gm_id),
            TrameCommand::SpawnToken {
                token: Box::new(t.clone()),
            },
        )
        .await
        .unwrap();
        let (status, body) = call(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/actors/{actor_id}"),
            Some(&gm),
            json!({ "expected_version": 1, "data": sheet }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");
        let synced = table(&room).await.data.tokens[&t.id].clone();
        assert_eq!(
            (synced.ac, synced.speed_max_ft, synced.speed_remaining_ft),
            expected,
            "case {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// D7 — stat block bounds
// ---------------------------------------------------------------------------

#[test]
fn stat_block_sources_and_bounds() {
    let oversized = with(
        homebrew_block(),
        "/traits",
        json!([{ "id": "lore", "name": "Lore", "description": "x".repeat(MAX_STAT_BLOCK_BYTES) }]),
    );
    // (case_id, stat block source, expected Ok(armor class) or Err(message fragment))
    let cases: Vec<(&str, Value, Result<i64, &str>)> = vec![
        (
            "srd_reference_copies_the_pack",
            json!("srd:monster:goblin"),
            Ok(15),
        ),
        ("bare_srd_slug_copies_the_pack", json!("goblin"), Ok(15)),
        ("valid_homebrew_is_kept", homebrew_block(), Ok(13)),
        (
            "unknown_srd_reference",
            json!("srd:monster:tarrasque_jr"),
            Err("unknown monster"),
        ),
        ("non_object_source", json!(42), Err("expected an object")),
        (
            "armor_class_zero",
            with(homebrew_block(), "/armorClass/value", json!(0)),
            Err("armorClass"),
        ),
        (
            "armor_class_above_30",
            with(homebrew_block(), "/armorClass/value", json!(31)),
            Err("armorClass"),
        ),
        (
            "hit_points_above_1000",
            with(homebrew_block(), "/hitPoints/average", json!(1001)),
            Err("hitPoints"),
        ),
        (
            "walk_speed_above_200",
            with(homebrew_block(), "/speed/walk", json!(205)),
            Err("speed/walk"),
        ),
        (
            "fly_speed_negative",
            with(homebrew_block(), "/speed", json!({ "walk": 30, "fly": -5 })),
            Err("speed/fly"),
        ),
        (
            "darkvision_above_500",
            with(homebrew_block(), "/senses/darkvision", json!(600)),
            Err("darkvision"),
        ),
        (
            "ability_score_above_30",
            with(homebrew_block(), "/abilities/str", json!(31)),
            Err("abilities/str"),
        ),
        (
            "melee_reach_above_100",
            with(homebrew_block(), "/actions/0/attack/reachFt", json!(150)),
            Err("reachFt"),
        ),
        (
            "unknown_damage_type",
            with(homebrew_block(), "/damageResistances", json!(["sonic"])),
            Err("damageResistances"),
        ),
        (
            "unknown_size",
            with(homebrew_block(), "/size", json!("colossal")),
            Err("size"),
        ),
        (
            "missing_name",
            with(homebrew_block(), "/name", json!("")),
            Err("name"),
        ),
        ("oversized_block", oversized, Err("larger than")),
    ];
    for (case, source, expected) in cases {
        let got = resolve_stat_block(&source).map(|b| b["armorClass"]["value"].as_i64().unwrap());
        match expected {
            Ok(ac) => assert_eq!(got, Ok(ac), "case {case}"),
            Err(fragment) => {
                let err = got.expect_err(case);
                assert!(err.contains(fragment), "case {case}: {err}");
            }
        }
    }
}

#[test]
fn every_srd_monster_passes_the_server_bounds() {
    let raw = include_str!("../../../packages/game-systems/dnd5e/packs/monsters.json");
    let pack: Vec<Value> = serde_json::from_str(raw).unwrap();
    let rejected: Vec<String> = pack
        .iter()
        .filter_map(|entry| {
            let id = entry["id"].as_str().unwrap();
            let block = srd_stat_block(id).unwrap_or(Value::Null);
            resolve_stat_block(&block)
                .err()
                .map(|e| format!("{id}: {e}"))
        })
        .collect();
    assert!(rejected.is_empty(), "{rejected:#?}");
}

// ---------------------------------------------------------------------------
// UA2 / UA14 — spawned tokens take their numbers from the stat block (MCP)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mcp_spawn_derives_combat_numbers_from_the_stat_block() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let template = h
        .actor(
            &app,
            campaign_id,
            &gm,
            json!({ "statBlock": homebrew_block() }),
        )
        .await;
    let room = h.room(campaign_id).await;
    // (case_id, stat block source, expected combat numbers)
    let cases = [
        (
            "srd_reference",
            json!("srd:monster:goblin"),
            goblin_combat(),
        ),
        ("homebrew_copy", homebrew_block(), homebrew_combat()),
        (
            "actor_template",
            json!(template.to_string()),
            homebrew_combat(),
        ),
    ];
    for (case, source, expected) in cases {
        let t = lying_token(Some(source));
        let body = mcp_dispatch(&app, &gm, campaign_id, spawn_value(&t)).await;
        assert!(body["error"].is_null(), "case {case}: {body}");
        let spawned = table(&room).await.data.tokens[&t.id].clone();
        assert_eq!(combat(&spawned), expected, "case {case}");
        assert!(
            spawned.stat_block.as_ref().is_some_and(Value::is_object),
            "case {case}: the token keeps its stat block copy"
        );
    }

    // (case_id, invalid source, expected error fragment)
    let rejected = [
        (
            "out_of_bounds_homebrew",
            with(homebrew_block(), "/armorClass/value", json!(0)),
            "armorClass",
        ),
        (
            "unknown_actor_template",
            json!(Uuid::new_v4().to_string()),
            "no stat block",
        ),
    ];
    for (case, source, fragment) in rejected {
        let t = lying_token(Some(source));
        let body = mcp_dispatch(&app, &gm, campaign_id, spawn_value(&t)).await;
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains(fragment), "case {case}: {body}");
        assert!(
            !table(&room).await.data.tokens.contains_key(&t.id),
            "case {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// UA2 / UA14 — the same rule on the WebSocket spawn path
// ---------------------------------------------------------------------------

async fn serve(app: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

async fn ws_open(addr: SocketAddr, path: &str, cookie: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Cookie: {cookie}\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    assert!(String::from_utf8_lossy(&head).contains(" 101 "));
    stream
}

/// Reads one unmasked server frame and returns `(opcode, payload)`.
async fn ws_read_frame(stream: &mut TcpStream) -> (u8, Vec<u8>) {
    let mut hdr = [0u8; 2];
    stream.read_exact(&mut hdr).await.unwrap();
    let len = match hdr[1] & 0x7f {
        126 => {
            let mut ext = [0u8; 2];
            stream.read_exact(&mut ext).await.unwrap();
            u16::from_be_bytes(ext) as usize
        }
        127 => {
            let mut ext = [0u8; 8];
            stream.read_exact(&mut ext).await.unwrap();
            u64::from_be_bytes(ext) as usize
        }
        n => n as usize,
    };
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).await.unwrap();
    (hdr[0] & 0x0f, payload)
}

/// Reads binary frames (skipping control frames) and decodes the next `ServerEnvelope`.
async fn ws_read(stream: &mut TcpStream) -> ServerEnvelope {
    loop {
        let (opcode, payload) = ws_read_frame(stream).await;
        if opcode == 0x2 {
            return rmp_serde::from_slice(&payload).unwrap();
        }
    }
}

/// Writes one masked frame with `opcode` (zero mask key, so the payload is sent as is).
async fn ws_write_op(stream: &mut TcpStream, opcode: u8, payload: &[u8]) {
    let mut frame = vec![0x80 | opcode];
    if payload.len() <= 125 {
        frame.push(0x80 | payload.len() as u8);
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(&[0, 0, 0, 0]);
    frame.extend_from_slice(payload);
    stream.write_all(&frame).await.unwrap();
}

async fn ws_write(stream: &mut TcpStream, payload: &[u8]) {
    ws_write_op(stream, 0x2, payload).await;
}

fn submit_frame(command: TrameCommand, correlation_id: &str) -> Vec<u8> {
    rmp_serde::to_vec_named(&ClientEnvelope::SubmitCommand(Box::new(
        CommandSubmission {
            command,
            correlation_id: Some(correlation_id.to_string()),
        },
    )))
    .unwrap()
}

#[tokio::test]
async fn websocket_spawn_derives_combat_numbers_and_rejects_bad_blocks() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let template = h
        .actor(
            &app,
            campaign_id,
            &gm,
            json!({ "statBlock": homebrew_block() }),
        )
        .await;
    let room = h.room(campaign_id).await;
    let addr = serve(app).await;
    let mut ws = ws_open(addr, &format!("/ws/campaigns/{campaign_id}"), &gm).await;
    assert!(matches!(
        ws_read(&mut ws).await,
        ServerEnvelope::StateSnapshot { .. }
    ));

    // (case_id, stat block source, expected Ok(combat numbers) or Err(reason fragment))
    let cases: Vec<(&str, Value, Result<Combat, &str>)> = vec![
        (
            "srd_reference",
            json!("srd:monster:goblin"),
            Ok(goblin_combat()),
        ),
        ("homebrew_copy", homebrew_block(), Ok(homebrew_combat())),
        (
            "actor_template",
            json!(template.to_string()),
            Ok(homebrew_combat()),
        ),
        (
            "out_of_bounds_homebrew",
            with(homebrew_block(), "/hitPoints/average", json!(0)),
            Err("hitPoints"),
        ),
        (
            "unknown_srd_reference",
            json!("srd:monster:nope"),
            Err("unknown monster"),
        ),
        (
            "unknown_actor_template",
            json!(Uuid::new_v4().to_string()),
            Err("no stat block"),
        ),
    ];
    for (case, source, expected) in cases {
        let t = lying_token(Some(source));
        let spawn = TrameCommand::SpawnToken {
            token: Box::new(t.clone()),
        };
        ws_write(&mut ws, &submit_frame(spawn, case)).await;
        let reply = ws_read(&mut ws).await;
        match expected {
            Ok(numbers) => {
                assert!(
                    matches!(reply, ServerEnvelope::CommandAccepted { .. }),
                    "case {case}: {reply:?}"
                );
                let spawned = table(&room).await.data.tokens[&t.id].clone();
                assert_eq!(combat(&spawned), numbers, "case {case}");
            }
            Err(fragment) => {
                let ServerEnvelope::CommandRejected {
                    reason,
                    correlation_id,
                } = reply
                else {
                    panic!("case {case}: expected CommandRejected, got {reply:?}");
                };
                assert!(reason.contains(fragment), "case {case}: {reason}");
                assert_eq!(correlation_id.as_deref(), Some(case), "case {case}");
                assert!(
                    !table(&room).await.data.tokens.contains_key(&t.id),
                    "case {case}"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// RT2 — server-initiated heartbeat
// ---------------------------------------------------------------------------

#[tokio::test]
async fn websocket_heartbeat_pings_and_closes_silent_peers() {
    const WS_OP_CLOSE: u8 = 0x8;
    const WS_OP_PING: u8 = 0x9;
    const WS_OP_PONG: u8 = 0xA;
    let ping = std::time::Duration::from_millis(150);
    let h = Harness::with_policy(SecurityPolicy {
        ws_ping_interval: ping,
        ws_pong_timeout: std::time::Duration::from_millis(100),
        ..SecurityPolicy::default()
    });
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let addr = serve(app).await;

    // (case_id, answer each server Ping with a Pong, expected close code or None if still open)
    let cases = [
        ("answering_peer_stays_open", true, None),
        ("silent_peer_is_closed_going_away", false, Some(1001u16)),
    ];
    for (case, answer, close_code) in cases {
        let mut ws = ws_open(addr, &format!("/ws/campaigns/{campaign_id}"), &gm).await;
        let deadline = tokio::time::Instant::now() + ping * 4;
        let mut pings = 0;
        let mut closed = None;
        while tokio::time::Instant::now() < deadline && closed.is_none() {
            let Ok((opcode, payload)) =
                tokio::time::timeout_at(deadline, ws_read_frame(&mut ws)).await
            else {
                break;
            };
            match opcode {
                WS_OP_PING => {
                    pings += 1;
                    if answer {
                        ws_write_op(&mut ws, WS_OP_PONG, &payload).await;
                    }
                }
                WS_OP_CLOSE => closed = Some(u16::from_be_bytes([payload[0], payload[1]])),
                _ => {}
            }
        }
        assert!(pings >= 1, "case {case}: the server pings first");
        assert_eq!(closed, close_code, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// D7 — staged tokens copy their stat block when staged and apply it on activation
// ---------------------------------------------------------------------------

fn scene_with(campaign_id: Uuid, staged: Value) -> Value {
    json!({
        "id": Uuid::new_v4(), "campaign_id": campaign_id, "name": "Cragmaw Hideout",
        "grid_size_px": 70, "grid_cell_distance_ft": 5.0, "width_px": 1400, "height_px": 1400,
        "revealed_to_players": true, "staged_tokens": [staged]
    })
}

#[tokio::test]
async fn staged_tokens_copy_validated_stat_blocks_and_activate_with_them() {
    // (case_id, staged token fields, expected Ok(combat numbers) or Err(())
    let cases: Vec<(&str, Value, Result<Combat, ()>)> = vec![
        (
            "srd_template_is_copied_on_save",
            json!({ "monster_template_id": "srd:monster:goblin" }),
            Ok(goblin_combat()),
        ),
        (
            "homebrew_copy_is_kept",
            json!({ "stat_block": homebrew_block() }),
            Ok(homebrew_combat()),
        ),
        (
            "out_of_bounds_homebrew_is_rejected",
            json!({ "stat_block": with(homebrew_block(), "/speed/walk", json!(999)) }),
            Err(()),
        ),
        (
            "unknown_srd_template_is_rejected",
            json!({ "monster_template_id": "srd:monster:nope" }),
            Err(()),
        ),
    ];
    for (case, fields, expected) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, gm_id, gm) = h.campaign(&app).await;
        let (_, player) = h.player(campaign_id).await;
        let token_id = Uuid::new_v4();
        let mut staged =
            json!({ "id": token_id, "name": "Ambusher", "x": 70.0, "y": 70.0, "size_cells": 1 });
        staged
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let scene = scene_with(campaign_id, staged);
        let (status, body) = call(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/maps"),
            Some(&gm),
            json!({ "scenes": [scene], "expected_version": 0 }),
        )
        .await;
        let Ok(numbers) = expected else {
            assert_eq!(status, StatusCode::BAD_REQUEST, "case {case}: {body}");
            assert_eq!(body["code"], json!("INVALID_STAT_BLOCK"), "case {case}");
            continue;
        };
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");

        // (viewer, cookie, expected stat block presence in GET .../maps)
        for (viewer, cookie, has_block) in [("gm", &gm, true), ("player", &player, false)] {
            let (_, maps) = call(
                &app,
                "GET",
                &format!("/api/v1/campaigns/{campaign_id}/maps"),
                Some(cookie),
                Value::Null,
            )
            .await;
            let block = &maps["scenes"][0]["staged_tokens"][0]["stat_block"];
            assert_eq!(block.is_object(), has_block, "case {case}: {viewer} view");
        }

        let room = h.room(campaign_id).await;
        room.dispatch_direct_command(
            gm_actor(gm_id),
            trame_server::maps::resolve_scene_command(
                &h.state,
                campaign_id,
                TrameCommand::ActivateScene {
                    scene_id: Uuid::parse_str(scene["id"].as_str().unwrap()).unwrap(),
                    scene: None,
                },
            )
            .await
            .unwrap(),
        )
        .await
        .unwrap();
        let activated = table(&room).await.data.tokens[&token_id].clone();
        assert_eq!(combat(&activated), numbers, "case {case}");
        assert_eq!(
            activated.actor_id, None,
            "case {case}: stays a SyntheticToken"
        );
    }
}
