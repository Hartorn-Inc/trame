//! ============================================================================
//! S1 / S3 / S10 SERVER SEAM SUITE (s1_campaign_api_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Proves the campaign REST surface, the MCP JSON-RPC endpoint, the room
//!   lifecycle (Idle-Lease sweeper, initiative totals) and the SPA fallback
//!   through the full Axum router (`build_router_with_state`) and the
//!   `RoomLeaseManager`, with cookie-authenticated callers only.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Each rule is a parametrized table of `(case_id, input, expected)`.
//!   - Rooms are inspected through `TableRoomHandle::get_table_snapshot`, never
//!     through private actor state.
//!
//! COVERAGE:
//!   A01-A05 campaigns / actors / notes / dice, A16-A18 linked vitals & scene
//!   activation, A25-A27 assets / map import / sweeper, A11 / A13-A15 / A29 MCP,
//!   A31 / A52 static serving & tracing.
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine as _;
use bytes::Bytes;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
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
use trame_server::campaigns::{LIVE_SESSION_NUM, tactical_sync_from_sheet};
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
};
use trame_server::maps::{CampaignMapScene, InMemoryMapStorage};
use trame_server::mcp::TimelineCursor;
use trame_server::notes::MAX_HANDOUT_TITLE_CHARS;
use trame_server::room::{ConnectedClient, OutboundClientFrame, RoomLeaseManager, TableRoomHandle};
use trame_server::security::SecurityPolicy;
use trame_server::sync::{ClientEnvelope, ServerEnvelope};
use trame_server::timeline::{InMemoryTimelineStorage, TimelineStorage};
use trame_server::wal::{InMemoryWalStorage, WalStorage};
use uuid::Uuid;

const SECRET: &[u8] = b"s1-test-invite-secret-at-least-32-bytes!";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    state: AppState,
    timeline: Arc<InMemoryTimelineStorage>,
}

impl Harness {
    fn new() -> Self {
        Self::with_static_dir(None)
    }

    fn with_static_dir(static_dir: Option<std::path::PathBuf>) -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let timeline = Arc::new(InMemoryTimelineStorage::new());
        let auth_state = AuthState::with_security(
            Arc::new(MagicLinkService::new(SECRET.to_vec(), "trame-test")),
            Arc::new(InMemorySessionStore::new()),
            Arc::new(TotpService::default()),
            Arc::new(SecurityPolicy::default()),
        );
        let state = AppState {
            lease_manager: Arc::new(RoomLeaseManager::new(wal.clone(), 25, 900_000)),
            asset_store: Arc::new(InMemoryAssetStore::new()),
            membership: Arc::new(InMemoryMembershipValidator::new()),
            instance_id: Uuid::new_v4(),
            timeline_storage: timeline.clone(),
            campaign_store: InMemoryCampaignStore::new(),
            blob_store: InMemoryBlobStore::new(),
            auth_state,
            db_healthy: Arc::new(AtomicBool::new(true)),
            map_storage: InMemoryMapStorage::new(),
            postgres_store: None,
            campaign_data: Default::default(),
            static_dir,
        };
        Self { state, timeline }
    }

    fn app(&self) -> Router {
        build_router_with_state(self.state.clone())
    }

    /// Registered `Host` account (may create campaigns) with a live session ->
    /// `(user_id, cookie_header)`.
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
        let token = format!("s1-session-{user_id}");
        store
            .create_session(user_id, &hash_session_token(&token), 3600)
            .await
            .unwrap();
        (user_id, format!("trame_session={token}"))
    }

    async fn join(&self, campaign_id: Uuid, user_id: Uuid, role: &str) {
        self.state
            .auth_state
            .session_store
            .assign_campaign_member(campaign_id, user_id, None, role)
            .await
            .unwrap();
    }

    /// GM-created campaign through the REST route -> `(campaign_id, gm_id, gm_cookie)`.
    async fn campaign(&self, app: &Router) -> (Uuid, Uuid, String) {
        let (gm, cookie) = self.account().await;
        let (status, body) = call(
            app,
            "POST",
            "/api/v1/campaigns",
            Some(&cookie),
            json!({ "name": "Lost Mine" }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = Uuid::parse_str(body["campaign"]["id"].as_str().unwrap()).unwrap();
        (id, gm, cookie)
    }

    async fn room(&self, campaign_id: Uuid) -> TableRoomHandle {
        self.state
            .lease_manager
            .get_or_wake_room(campaign_id)
            .await
            .unwrap()
    }
}

async fn send_raw(app: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Bytes) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, headers, body)
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
    let (status, _, bytes) = send_raw(app, builder.body(payload).unwrap()).await;
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

async fn mcp(app: &Router, cookie: &str, method: &str, params: Value) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        "/api/v1/mcp",
        Some(cookie),
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
    )
    .await
}

async fn mcp_tool(app: &Router, cookie: &str, name: &str, arguments: Value) -> Value {
    let (status, body) = mcp(
        app,
        cookie,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn token(name: &str, owner: Option<Uuid>, actor: Option<Uuid>, x: f64) -> TokenState {
    let mut t = TokenState::new_default(Uuid::new_v4(), name, Point2D::new(x, 0.0));
    t.owner_user_id = owner;
    t.actor_id = actor;
    t
}

fn spawn_cmd(t: &TokenState) -> Value {
    serde_json::to_value(TrameCommand::SpawnToken { token: t.clone() }).unwrap()
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

// ---------------------------------------------------------------------------
// A01 — lobby contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a01_lobby_lists_created_campaign_with_role() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm_cookie) = h.campaign(&app).await;
    let (stranger, stranger_cookie) = h.account().await;
    let _ = stranger;

    let cases = [
        ("gm_sees_campaign", gm_cookie.as_str(), Some("GM")),
        ("stranger_sees_nothing", stranger_cookie.as_str(), None),
    ];
    for (case, cookie, expected_role) in cases {
        let (status, body) =
            call(&app, "GET", "/api/v1/campaigns", Some(cookie), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        let campaigns = body["campaigns"].as_array().unwrap();
        let entry = campaigns
            .iter()
            .find(|c| c["id"] == json!(campaign_id.to_string()));
        match expected_role {
            Some(role) => {
                let entry = entry.unwrap_or_else(|| panic!("case {case}: missing campaign"));
                assert_eq!(entry["role"], json!(role), "case {case}");
                for key in ["name", "system", "created_at"] {
                    assert!(entry.get(key).is_some(), "case {case}: missing {key}");
                }
            }
            None => assert!(entry.is_none(), "case {case}"),
        }
    }
    let (status, _) = call(&app, "GET", "/api/v1/campaigns", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// A02 — actor optimistic concurrency (ADR-0037)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a02_actor_put_enforces_expected_version() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;

    let cases: [(&str, Option<i64>, StatusCode, Option<&str>); 4] = [
        ("current_version_accepted", Some(1), StatusCode::OK, None),
        (
            "stale_version_conflicts",
            Some(0),
            StatusCode::CONFLICT,
            Some("VERSION_CONFLICT"),
        ),
        (
            "future_version_conflicts",
            Some(7),
            StatusCode::CONFLICT,
            Some("VERSION_CONFLICT"),
        ),
        (
            "missing_version_rejected",
            None,
            StatusCode::BAD_REQUEST,
            Some("MISSING_EXPECTED_VERSION"),
        ),
    ];
    for (case, expected_version, status_want, code_want) in cases {
        let (status, created) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/actors"),
            Some(&gm),
            json!({ "name": "Sildar", "data": { "attributes": { "hp": { "current": 10, "max": 10 } } } }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {created}");
        let actor_id = created["actor"]["id"].as_str().unwrap().to_string();

        let mut body = json!({ "data": { "attributes": { "hp": { "current": 4, "max": 10 } } } });
        if let Some(v) = expected_version {
            body["expected_version"] = json!(v);
        }
        let (status, resp) = call(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/actors/{actor_id}"),
            Some(&gm),
            body,
        )
        .await;
        assert_eq!(status, status_want, "case {case}: {resp}");
        match code_want {
            None => assert_eq!(resp["actor"]["version"], json!(2), "case {case}"),
            Some(code) => assert_eq!(resp["code"], json!(code), "case {case}"),
        }
        if status_want == StatusCode::CONFLICT {
            assert_eq!(resp["current_version"], json!(1), "case {case}");
        }
    }
}

#[tokio::test]
async fn a02_actor_update_resyncs_only_linked_tokens() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, gm_id, gm) = h.campaign(&app).await;
    let (_, created) = call(
        &app,
        "POST",
        &format!("/api/v1/campaigns/{campaign_id}/actors"),
        Some(&gm),
        json!({ "name": "Goblin Boss", "data": {} }),
    )
    .await;
    let actor_id = Uuid::parse_str(created["actor"]["id"].as_str().unwrap()).unwrap();

    let linked = token("Boss", None, Some(actor_id), 0.0);
    let synthetic = token("Goblin", None, None, 100.0);
    let room = h.room(campaign_id).await;
    for t in [&linked, &synthetic] {
        room.dispatch_direct_command(
            gm_actor(gm_id),
            TrameCommand::SpawnToken { token: t.clone() },
        )
        .await
        .unwrap();
    }

    let (status, _) = call(
        &app,
        "PUT",
        &format!("/api/v1/campaigns/{campaign_id}/actors/{actor_id}"),
        Some(&gm),
        json!({ "expected_version": 1, "data": { "attributes": { "hp": { "current": 3, "max": 33 }, "ac": 17 } } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let state = table(&room).await;
    let cases = [
        ("linked_token_synced", linked.id, 3, 17),
        (
            "synthetic_token_untouched",
            synthetic.id,
            synthetic.hp,
            synthetic.ac,
        ),
    ];
    for (case, id, hp, ac) in cases {
        let t = &state.data.tokens[&id];
        assert_eq!((t.hp, t.ac), (hp, ac), "case {case}");
    }
}

#[tokio::test]
async fn actor_ability_scores_are_bounded_on_save() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    // (case_id, abilities, expected status)
    let cases = [
        ("in_range_accepted", json!({ "dex": { "score": 18 } }), StatusCode::OK),
        ("bounds_accepted", json!({ "str": { "score": 1 }, "dex": { "score": 30 } }), StatusCode::OK),
        ("dex_1000_rejected", json!({ "dex": { "score": 1000 } }), StatusCode::BAD_REQUEST),
        ("zero_rejected", json!({ "con": { "score": 0 } }), StatusCode::BAD_REQUEST),
        ("negative_rejected", json!({ "wis": { "score": -4 } }), StatusCode::BAD_REQUEST),
        ("fraction_rejected", json!({ "dex": { "score": 14.5 } }), StatusCode::BAD_REQUEST),
        ("non_numeric_ignored", json!({ "dex": { "score": "high" } }), StatusCode::OK),
    ];
    for (case, abilities, want) in cases {
        let data = json!({ "abilities": abilities });
        let (status, created) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/actors"),
            Some(&gm),
            json!({ "name": "Rogue", "data": data }),
        )
        .await;
        let create_want = if want == StatusCode::OK {
            StatusCode::CREATED
        } else {
            StatusCode::BAD_REQUEST
        };
        assert_eq!(status, create_want, "case {case}: create {created}");

        let (_, valid) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/actors"),
            Some(&gm),
            json!({ "name": "Rogue", "data": {} }),
        )
        .await;
        let actor_id = valid["actor"]["id"].as_str().unwrap().to_string();
        let (status, resp) = call(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/actors/{actor_id}"),
            Some(&gm),
            json!({ "expected_version": 1, "data": data }),
        )
        .await;
        assert_eq!(status, want, "case {case}: update {resp}");
        if want == StatusCode::BAD_REQUEST {
            assert_eq!(resp["code"], json!("INVALID_ABILITY_SCORE"), "case {case}");
            assert_eq!(created["code"], json!("INVALID_ABILITY_SCORE"), "case {case}");
        }
    }
}

#[test]
fn tactical_sync_clamps_dex_score_before_deriving_initiative() {
    // (case_id, stored dex score, expected dex modifier)
    let cases = [
        ("normal_score", 14, 2),
        ("huge_score_clamped_to_30", 1000, 10),
        ("negative_score_clamped_to_1", -50, -5),
    ];
    for (case, score, want) in cases {
        let sync = tactical_sync_from_sheet(None, &json!({ "abilities": { "dex": { "score": score } } }));
        assert_eq!(sync.dex_mod, Some(want), "case {case}");
    }
}

#[tokio::test]
async fn rest_dice_refuses_player_initiative_reasons() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let (player, player_cookie) = h.account().await;
    h.join(campaign_id, player, "PLAYER").await;
    // (case_id, caller cookie, reason, expected status)
    let cases = [
        ("player_initiative_refused", player_cookie.as_str(), "Initiative", StatusCode::BAD_REQUEST),
        ("player_lowercase_padded_refused", player_cookie.as_str(), "  initiative: Hero", StatusCode::BAD_REQUEST),
        ("player_attack_allowed", player_cookie.as_str(), "Attack", StatusCode::OK),
        ("player_word_inside_allowed", player_cookie.as_str(), "Roll for initiative later", StatusCode::OK),
        ("gm_initiative_allowed", gm.as_str(), "Initiative", StatusCode::OK),
    ];
    for (case, cookie, reason, want) in cases {
        let (status, body) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/dice/roll"),
            Some(cookie),
            json!({ "expression": "1d20+40", "reason": reason }),
        )
        .await;
        assert_eq!(status, want, "case {case}: {body}");
        if want == StatusCode::BAD_REQUEST {
            assert_eq!(body["code"], json!("INITIATIVE_ROLL_REQUIRES_ROOM"), "case {case}");
        }
    }
}

// ---------------------------------------------------------------------------
// A68 — sheet damage mitigations reach the token
// ---------------------------------------------------------------------------

#[test]
fn a68_sheet_mitigations_become_token_affinity_lists() {
    let cases = [
        (
            "resistant",
            json!({ "fire": "RESISTANT" }),
            (vec!["fire"], vec![], vec![]),
        ),
        (
            "immune_lowercase_level",
            json!({ "poison": "immune" }),
            (vec![], vec!["poison"], vec![]),
        ),
        (
            "vulnerable",
            json!({ "cold": "VULNERABLE" }),
            (vec![], vec![], vec!["cold"]),
        ),
        (
            "normal_ignored",
            json!({ "acid": "NORMAL" }),
            (vec![], vec![], vec![]),
        ),
    ];
    for (case, mitigations, (resist, immune, vuln)) in cases {
        let sync = tactical_sync_from_sheet(None, &json!({ "damageMitigations": mitigations }));
        let (r, i, v) = sync.damage_affinities.expect(case);
        let as_strings = |l: Vec<&str>| l.into_iter().map(String::from).collect::<Vec<_>>();
        assert_eq!(
            (r, i, v),
            (as_strings(resist), as_strings(immune), as_strings(vuln)),
            "case {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// A03 — notes: confidential blocks survive player edits
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a03_player_note_edit_preserves_dm_blocks() {
    let cases = [
        (
            "player_rewrites_public_text",
            "Intro, edited by the party.\n",
        ),
        ("player_clears_the_note", ""),
        (
            "player_injects_fake_dm_block",
            "Intro\n\n:::dm\nplayer forgery\n:::\n",
        ),
    ];
    for (case, player_body) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, _, gm) = h.campaign(&app).await;
        let (player_id, player) = h.account().await;
        h.join(campaign_id, player_id, "PLAYER").await;
        let uri = format!("/api/v1/campaigns/{campaign_id}/notes/intro");

        let gm_body = "Intro\n\n:::dm\nThe innkeeper is a spy.\n:::\n";
        let (status, _) = call(
            &app,
            "PUT",
            &uri,
            Some(&gm),
            json!({ "title": "Intro", "content_markdown": gm_body }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");

        let (_, listed) = call(
            &app,
            "GET",
            &format!("/api/v1/campaigns/{campaign_id}/notes"),
            Some(&player),
            Value::Null,
        )
        .await;
        let seen = listed["notes"][0]["content_markdown"].as_str().unwrap();
        assert!(
            !seen.contains("spy"),
            "case {case}: player saw the dm block"
        );

        let (status, _) = call(
            &app,
            "PUT",
            &uri,
            Some(&player),
            json!({ "title": "Intro", "content_markdown": player_body }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");

        let (_, gm_view) = call(
            &app,
            "GET",
            &format!("/api/v1/campaigns/{campaign_id}/notes"),
            Some(&gm),
            Value::Null,
        )
        .await;
        let stored = gm_view["notes"][0]["content_markdown"].as_str().unwrap();
        assert!(
            stored.contains("The innkeeper is a spy."),
            "case {case}: dm block lost: {stored}"
        );
    }
}

#[tokio::test]
async fn a03_handout_reveal_matches_block_id_and_reaches_player() {
    let note = "The crypt smells of old incense.\n\
                :::handout{id=\"ancient-map\" title=\"Ancient Map\"}\n\
                A faded map marks a hidden stair.\n\
                :::\n\
                :::handout{revealed='false' title='Letter: id=decoy' id='sealed-letter'}\n\
                Meet at midnight.\n\
                :::\n";
    // (case_id, handout id in the URL, expected status, expected title)
    let cases = [
        (
            "double_quoted_attrs",
            "ancient-map",
            StatusCode::OK,
            Some("Ancient Map"),
        ),
        (
            "single_quoted_attrs_any_order",
            "sealed-letter",
            StatusCode::OK,
            Some("Letter: id=decoy"),
        ),
        (
            "id_inside_title_is_not_an_id",
            "decoy",
            StatusCode::NOT_FOUND,
            None,
        ),
        ("unknown_handout", "missing", StatusCode::NOT_FOUND, None),
    ];
    for (case, handout_id, expected, title) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, _, gm) = h.campaign(&app).await;
        let (player_id, _) = h.account().await;
        h.join(campaign_id, player_id, "PLAYER").await;
        let (status, _) = call(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/notes/crypt"),
            Some(&gm),
            json!({ "title": "Crypt Lore", "content_markdown": note }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        let (tx, mut rx) = mpsc::unbounded_channel();
        h.room(campaign_id)
            .await
            .connect_client(ConnectedClient {
                session_id: Uuid::new_v4(),
                user_id: player_id,
                role: CampaignRole::Player,
                tx,
            })
            .await
            .unwrap();

        let (status, body) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/handouts/{handout_id}/reveal"),
            Some(&gm),
            Value::Null,
        )
        .await;
        assert_eq!(status, expected, "case {case}: {body}");
        h.room(campaign_id).await.metrics().await.unwrap();
        let broadcast = std::iter::from_fn(|| rx.try_recv().ok()).find_map(|frame| match frame {
            OutboundClientFrame::Binary(bytes) => {
                match rmp_serde::from_slice::<ServerEnvelope>(&bytes).ok()? {
                    ServerEnvelope::HandoutRevealed(revealed) => Some(revealed),
                    _ => None,
                }
            }
            _ => None,
        });
        match title {
            Some(title) => {
                assert_eq!(body["handout"]["title"], json!(title), "case {case}");
                let b = broadcast.unwrap_or_else(|| panic!("case {case}: player got no broadcast"));
                assert_eq!(b.handout_id, handout_id, "case {case}");
                assert_eq!(b.title, title, "case {case}");
                assert!(!b.content.is_empty(), "case {case}");
            }
            None => assert!(broadcast.is_none(), "case {case}: unexpected broadcast"),
        }
    }
}

#[tokio::test]
async fn a03_handout_reveal_records_session_and_bounds_title() {
    let at_limit = "é".repeat(MAX_HANDOUT_TITLE_CHARS);
    let over_limit = "é".repeat(MAX_HANDOUT_TITLE_CHARS + 1);
    // (case_id, handout title, reveal body, expected status, expected journal session)
    let cases = [
        (
            "explicit_session_num_is_recorded",
            "Ancient Map",
            json!({ "session_num": 7 }),
            StatusCode::OK,
            Some(7),
        ),
        (
            "no_session_num_falls_back_to_live_session",
            "Ancient Map",
            Value::Null,
            StatusCode::OK,
            Some(LIVE_SESSION_NUM),
        ),
        (
            "title_at_200_chars_is_accepted",
            at_limit.as_str(),
            Value::Null,
            StatusCode::OK,
            Some(LIVE_SESSION_NUM),
        ),
        (
            "title_at_201_chars_is_rejected",
            over_limit.as_str(),
            Value::Null,
            StatusCode::BAD_REQUEST,
            None,
        ),
    ];
    for (case, title, reveal_body, expected, session) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, _, gm) = h.campaign(&app).await;
        let note = format!(":::handout{{id=\"ancient-map\" title=\"{title}\"}}\nA stair.\n:::\n");
        let (status, _) = call(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/notes/crypt"),
            Some(&gm),
            json!({ "title": "Crypt Lore", "content_markdown": note }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");

        let (status, body) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/handouts/ancient-map/reveal"),
            Some(&gm),
            reveal_body,
        )
        .await;
        assert_eq!(status, expected, "case {case}: {body}");
        let (_, journal) = call(
            &app,
            "GET",
            &format!("/api/v1/campaigns/{campaign_id}/journal"),
            Some(&gm),
            Value::Null,
        )
        .await;
        let entries = journal["entries"].as_array().unwrap();
        let revealed_in = |session_num| {
            h.timeline
                .get_timeline(&campaign_id.to_string(), session_num, 0, 50)
                .unwrap()
                .events
                .iter()
                .any(|e| e.event_type == "handout_revealed")
        };
        match session {
            Some(session_num) => {
                assert_eq!(entries.len(), 1, "case {case}");
                assert_eq!(entries[0]["session_num"], json!(session_num), "case {case}");
                assert!(
                    revealed_in(session_num),
                    "case {case}: timeline session differs"
                );
            }
            None => {
                assert_eq!(body["code"], json!("HANDOUT_TITLE_TOO_LONG"), "case {case}");
                assert!(entries.is_empty(), "case {case}: journal must stay empty");
                assert!(
                    !revealed_in(LIVE_SESSION_NUM),
                    "case {case}: no timeline event"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// A04 — dice route works hibernated, lands in the timeline
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a04_dice_roll_route_rbac_and_timeline() {
    let cases = [
        ("gm_room_hibernated", "GM", false, StatusCode::OK),
        ("player_room_awake", "PLAYER", true, StatusCode::OK),
        (
            "spectator_refused",
            "SPECTATOR",
            false,
            StatusCode::FORBIDDEN,
        ),
        ("stranger_refused", "", false, StatusCode::FORBIDDEN),
    ];
    for (case, role, wake, expected) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, _, _) = h.campaign(&app).await;
        let (user_id, cookie) = h.account().await;
        if !role.is_empty() {
            h.join(campaign_id, user_id, role).await;
        }
        if wake {
            h.room(campaign_id).await;
        }
        let (status, body) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/dice/roll"),
            Some(&cookie),
            json!({ "expression": "1d20+5", "reason": "Perception" }),
        )
        .await;
        assert_eq!(status, expected, "case {case}: {body}");
        let events = h
            .timeline
            .get_timeline(&campaign_id.to_string(), 1, 0, 50)
            .unwrap()
            .events;
        let logged = events
            .iter()
            .filter(|e| e.event_type == "dice_roll")
            .count();
        if expected == StatusCode::OK {
            let total = body["roll"]["total"].as_i64().unwrap();
            assert!((6..=25).contains(&total), "case {case}: total {total}");
            assert_eq!(logged, 1, "case {case}");
            assert_eq!(
                h.state.lease_manager.active_room_count().await,
                usize::from(wake),
                "case {case}: the route must not wake the room"
            );
        } else {
            assert_eq!(logged, 0, "case {case}");
        }
    }
}

// ---------------------------------------------------------------------------
// A13 / A14 — MCP tools/list schemas and staging setting
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a13_tools_list_exposes_trame_command_schema() {
    let h = Harness::new();
    let app = h.app();
    let (_, _, gm) = h.campaign(&app).await;
    let (status, body) = mcp(&app, &gm, "tools/list", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let tools = body["result"]["tools"].as_array().unwrap();
    for name in [
        "trame.dispatch_command",
        "mcp.execute_batch",
        "mcp.stage_encounter",
    ] {
        let tool = tools
            .iter()
            .find(|t| t["name"] == json!(name))
            .unwrap_or_else(|| panic!("missing tool {name}"));
        let schema = &tool["inputSchema"];
        assert!(schema["$defs"]["TrameCommand"].is_object(), "{name}");
        let text = schema.to_string();
        for cmd in [
            "HEAL_ACTOR",
            "ACTIVATE_SCENE",
            "RESOLVE_REACTION",
            "APPLY_DAMAGE",
        ] {
            assert!(text.contains(cmd), "{name}: schema lacks {cmd}");
        }
    }
}

#[tokio::test]
async fn a14_staging_mode_follows_campaign_setting() {
    let cases = [
        (
            "setting_off_executes",
            false,
            "mcp.execute_batch",
            None,
            false,
        ),
        ("setting_on_stages", true, "mcp.execute_batch", None, true),
        (
            "setting_on_stages_single_dispatch",
            true,
            "trame.dispatch_command",
            None,
            true,
        ),
        (
            "argument_requests_staging",
            false,
            "mcp.execute_batch",
            Some(true),
            true,
        ),
        (
            "stage_encounter_always_stages",
            false,
            "mcp.stage_encounter",
            None,
            true,
        ),
    ];
    for (case, setting, tool, arg, staged_want) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, _, gm) = h.campaign(&app).await;
        let (status, _) = call(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/settings"),
            Some(&gm),
            json!({ "mcp_staging_mode": setting }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");

        let goblin = token("Goblin", None, None, 0.0);
        let mut args = json!({ "campaign_id": campaign_id });
        if tool == "trame.dispatch_command" {
            args["command"] = spawn_cmd(&goblin);
        } else {
            args["commands"] = json!([spawn_cmd(&goblin)]);
        }
        if let Some(flag) = arg {
            args["staging"] = json!(flag);
        }
        let body = mcp_tool(&app, &gm, tool, args).await;
        assert_eq!(
            body["result"]["staged"],
            json!(staged_want),
            "case {case}: {body}"
        );
        let state = table(&h.room(campaign_id).await).await;
        assert_eq!(
            state.data.tokens.contains_key(&goblin.id),
            !staged_want,
            "case {case}"
        );
    }
}

#[tokio::test]
async fn a14_mcp_refuses_non_gm_callers() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, _) = h.campaign(&app).await;
    let (player_id, player) = h.account().await;
    h.join(campaign_id, player_id, "PLAYER").await;
    let (stranger_id, stranger) = h.account().await;
    let _ = stranger_id;
    let args = json!({ "campaign_id": campaign_id, "commands": [spawn_cmd(&token("x", None, None, 0.0))] });
    for (case, cookie) in [("player", player.as_str()), ("stranger", stranger.as_str())] {
        let (status, body) = mcp(
            &app,
            cookie,
            "tools/call",
            json!({ "name": "mcp.execute_batch", "arguments": args }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "case {case}: {body}");
    }
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/mcp",
        None,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// A11 — non-staged batch is atomic and undone in one step
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a11_five_command_batch_reverts_with_one_undo() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let goblins: Vec<TokenState> = (0..5)
        .map(|i| token(&format!("Goblin {i}"), None, None, f64::from(i) * 50.0))
        .collect();
    let commands: Vec<Value> = goblins.iter().map(spawn_cmd).collect();
    let body = mcp_tool(
        &app,
        &gm,
        "mcp.execute_batch",
        json!({ "campaign_id": campaign_id, "commands": commands }),
    )
    .await;
    assert_eq!(body["result"]["staged"], json!(false), "{body}");
    let room = h.room(campaign_id).await;
    assert_eq!(table(&room).await.data.tokens.len(), 5);

    mcp_tool(
        &app,
        &gm,
        "trame.dispatch_command",
        json!({ "campaign_id": campaign_id, "command": { "cmd": "UNDO_LAST_ACTION" } }),
    )
    .await;
    assert!(table(&room).await.data.tokens.is_empty());
}

#[tokio::test]
async fn a11_failing_batch_applies_nothing() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let goblin = token("Goblin", None, None, 0.0);
    let commands = json!([
        spawn_cmd(&goblin),
        { "cmd": "REMOVE_TOKEN", "token_id": Uuid::new_v4() },
    ]);
    let body = mcp_tool(
        &app,
        &gm,
        "mcp.execute_batch",
        json!({ "campaign_id": campaign_id, "commands": commands }),
    )
    .await;
    assert!(body["error"].is_object(), "{body}");
    assert!(
        table(&h.room(campaign_id).await)
            .await
            .data
            .tokens
            .is_empty()
    );
}

// ---------------------------------------------------------------------------
// A15 — timeline resource cursor from the URI
// ---------------------------------------------------------------------------

#[test]
fn a15_timeline_cursor_parses_uri_query() {
    let cases = [
        ("defaults", "", (1, 0, 100)),
        ("all_params", "session_num=3&after=12&limit=5", (3, 12, 5)),
        (
            "garbage_falls_back",
            "session_num=x&after=-1&limit=",
            (1, 0, 100),
        ),
        ("unknown_keys_ignored", "foo=bar&after=7", (1, 7, 100)),
    ];
    for (case, query, (session_num, after, limit)) in cases {
        let c = TimelineCursor::parse(query);
        assert_eq!(
            (c.session_num, c.after, c.limit),
            (session_num, after, limit),
            "case {case}"
        );
    }
}

#[tokio::test]
async fn a15_timeline_resource_pages_by_cursor() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    for i in 0..4 {
        h.timeline
            .append_event(
                &campaign_id.to_string(),
                2,
                trame_server::timeline::AppendEventInput {
                    event_type: format!("e{i}"),
                    actor_id: None,
                    payload: json!({}),
                    timestamp: None,
                },
            )
            .unwrap();
    }
    let cases = [
        ("first_page", "session_num=2&limit=2", vec!["e0", "e1"]),
        (
            "after_cursor",
            "session_num=2&after=2&limit=10",
            vec!["e2", "e3"],
        ),
        ("other_session_empty", "session_num=1", vec![]),
    ];
    for (case, query, expected) in cases {
        let (_, body) = mcp(
            &app,
            &gm,
            "resources/read",
            json!({ "uri": format!("trame://campaigns/{campaign_id}/timeline?{query}") }),
        )
        .await;
        let text = body["result"]["contents"][0]["text"].as_str().unwrap();
        let page: Value = serde_json::from_str(text).unwrap();
        let types: Vec<&str> = page["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event_type"].as_str().unwrap())
            .collect();
        assert_eq!(types, expected, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A17 / A18 — ActivateScene from storage: heroes kept, synthetic monsters
// ---------------------------------------------------------------------------

fn stored_scene(campaign_id: Uuid, goblins: &[Uuid]) -> CampaignMapScene {
    serde_json::from_value(json!({
        "id": Uuid::new_v4(),
        "campaign_id": campaign_id,
        "name": "Cragmaw Hideout",
        "grid_size_px": 70,
        "grid_cell_distance_ft": 5.0,
        "width_px": 1400,
        "height_px": 1400,
        "revealed_to_players": false,
        "spawn_points": [{ "id": Uuid::new_v4(), "name": "Entrance", "x": 140.0, "y": 210.0 }],
        "staged_tokens": goblins.iter().map(|id| json!({
            "id": id, "name": "Goblin", "monster_template_id": "srd:goblin", "x": 700.0, "y": 700.0
        })).collect::<Vec<_>>(),
    }))
    .unwrap()
}

#[tokio::test]
async fn a17_activate_scene_keeps_heroes_and_spawns_synthetic_goblins() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, gm_id, gm) = h.campaign(&app).await;
    let player = Uuid::new_v4();
    let hero = token("Hero", Some(player), Some(Uuid::new_v4()), 0.0);
    let old_npc = token("Old NPC", None, None, 300.0);
    let room = h.room(campaign_id).await;
    for t in [&hero, &old_npc] {
        room.dispatch_direct_command(
            gm_actor(gm_id),
            TrameCommand::SpawnToken { token: t.clone() },
        )
        .await
        .unwrap();
    }
    let goblins: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
    let scene = stored_scene(campaign_id, &goblins);
    h.state
        .map_storage
        .save_campaign_maps(campaign_id, vec![scene.clone()]);

    let body = mcp_tool(
        &app,
        &gm,
        "trame.dispatch_command",
        json!({ "campaign_id": campaign_id, "command": { "cmd": "ACTIVATE_SCENE", "scene_id": scene.id } }),
    )
    .await;
    assert!(body["error"].is_null(), "{body}");

    let state = table(&room).await;
    let kept = &state.data.tokens[&hero.id];
    assert_eq!((kept.top_left.x, kept.top_left.y), (140.0, 210.0));
    assert!(!state.data.tokens.contains_key(&old_npc.id));
    assert_eq!(state.data.map_width_px, 1400);

    let cases: Vec<(String, Uuid)> = goblins
        .iter()
        .enumerate()
        .map(|(i, id)| (format!("goblin_{i}_is_synthetic"), *id))
        .collect();
    for (case, id) in &cases {
        let g = &state.data.tokens[id];
        assert_eq!((g.actor_id, g.owner_user_id), (None, None), "case {case}");
    }

    room.dispatch_direct_command(
        gm_actor(gm_id),
        serde_json::from_value(json!({
            "cmd": "APPLY_DAMAGE", "token_id": goblins[0], "raw_damage": 5, "affinity": "NORMAL"
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let state = table(&room).await;
    let hps: Vec<i32> = goblins.iter().map(|id| state.data.tokens[id].hp).collect();
    assert_eq!(hps[0] + 5, hps[1], "only the targeted goblin is hurt");
    assert!(hps[1..].iter().all(|hp| *hp == hps[1]));
}

#[tokio::test]
async fn a17_activate_unknown_scene_is_rejected() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let body = mcp_tool(
        &app,
        &gm,
        "trame.dispatch_command",
        json!({ "campaign_id": campaign_id, "command": { "cmd": "ACTIVATE_SCENE", "scene_id": Uuid::new_v4() } }),
    )
    .await;
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not found"),
        "{body}"
    );
}

// ---------------------------------------------------------------------------
// A16 — linked token damage persists to the actor sheet
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a16_damage_persists_only_for_linked_tokens() {
    let cases = [
        ("linked_token_persists", true, 13),
        ("synthetic_token_does_not", false, 20),
    ];
    for (case, linked, expected_hp) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, gm_id, gm) = h.campaign(&app).await;
        let (_, created) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/actors"),
            Some(&gm),
            json!({ "name": "Sildar", "data": { "attributes": { "hp": { "current": 20, "max": 20, "temp": 0 } } } }),
        )
        .await;
        let actor_id = Uuid::parse_str(created["actor"]["id"].as_str().unwrap()).unwrap();
        let t = token("Sildar", None, linked.then_some(actor_id), 0.0);
        let room = h.room(campaign_id).await;
        room.dispatch_direct_command(
            gm_actor(gm_id),
            TrameCommand::SpawnToken { token: t.clone() },
        )
        .await
        .unwrap();
        room.dispatch_direct_command(
            gm_actor(gm_id),
            serde_json::from_value(json!({
                "cmd": "APPLY_DAMAGE", "token_id": t.id, "raw_damage": 7, "affinity": "NORMAL"
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let mut hp = Value::Null;
        for _ in 0..25 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let (_, body) = call(
                &app,
                "GET",
                &format!("/api/v1/campaigns/{campaign_id}/actors/{actor_id}"),
                Some(&gm),
                Value::Null,
            )
            .await;
            hp = body["actor"]["data"]["attributes"]["hp"]["current"].clone();
            if linked && hp == json!(expected_hp) {
                break;
            }
        }
        assert_eq!(hp, json!(expected_hp), "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A25 / A26 — asset upload + signed download, UVTT import
// ---------------------------------------------------------------------------

fn png_bytes(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(w, h, image::Rgb([40, 90, 160]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

async fn raw_post(app: &Router, uri: &str, cookie: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("cookie", cookie)
        .body(Body::from(body))
        .unwrap();
    let (status, _, bytes) = send_raw(app, req).await;
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn a25_asset_upload_and_signed_download() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let (spectator_id, spectator) = h.account().await;
    h.join(campaign_id, spectator_id, "SPECTATOR").await;
    let uri = format!("/api/v1/campaigns/{campaign_id}/assets");

    let cases = [
        (
            "gm_png_accepted",
            gm.as_str(),
            png_bytes(8, 8),
            StatusCode::CREATED,
        ),
        (
            "not_an_image",
            gm.as_str(),
            b"hello".to_vec(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "spectator_refused",
            spectator.as_str(),
            png_bytes(8, 8),
            StatusCode::FORBIDDEN,
        ),
    ];
    let mut url = String::new();
    for (case, cookie, body, expected) in cases {
        let (status, resp) = raw_post(&app, &uri, cookie, body).await;
        assert_eq!(status, expected, "case {case}: {resp}");
        if expected == StatusCode::CREATED {
            url = resp["url"].as_str().unwrap().to_string();
        }
    }

    let path = url
        .find("/assets/download/")
        .map(|i| url[i..].to_string())
        .unwrap();
    let tampered = path.replace("sig=", "sig=00");
    let cases = [
        ("valid_signature", path.as_str(), StatusCode::OK),
        (
            "tampered_signature",
            tampered.as_str(),
            StatusCode::FORBIDDEN,
        ),
    ];
    for (case, p, expected) in cases {
        let req = Request::builder().uri(p).body(Body::empty()).unwrap();
        let (status, headers, bytes) = send_raw(&app, req).await;
        assert_eq!(status, expected, "case {case}");
        if expected == StatusCode::OK {
            assert_eq!(headers["content-type"], "image/webp", "case {case}");
            assert_eq!(&bytes[8..12], b"WEBP", "case {case}");
        }
    }
}

fn uvtt(image_b64: &str) -> Vec<u8> {
    json!({
        "format": 0.3,
        "resolution": { "map_origin": { "x": 0, "y": 0 }, "map_size": { "x": 2, "y": 2 }, "pixels_per_grid": 32 },
        "image": image_b64,
        "line_of_sight": [[{ "x": 0, "y": 0 }, { "x": 2, "y": 0 }]],
        "portals": [],
        "lights": [{ "position": { "x": 1, "y": 1 }, "range": 4, "color": "ffffaa00", "intensity": 1.0 }]
    })
    .to_string()
    .into_bytes()
}

#[tokio::test]
async fn a26_uvtt_import_is_gm_only_and_creates_hidden_scene() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    let (player_id, player) = h.account().await;
    h.join(campaign_id, player_id, "PLAYER").await;
    let good = base64::engine::general_purpose::STANDARD.encode(png_bytes(64, 64));
    let bad = base64::engine::general_purpose::STANDARD.encode(b"not an image at all");
    let uri = format!("/api/v1/campaigns/{campaign_id}/maps/import?name=Cave");

    let cases = [
        (
            "gm_valid_map",
            gm.as_str(),
            uvtt(&good),
            StatusCode::CREATED,
        ),
        (
            "player_refused",
            player.as_str(),
            uvtt(&good),
            StatusCode::FORBIDDEN,
        ),
        (
            "bad_magic_bytes",
            gm.as_str(),
            uvtt(&bad),
            StatusCode::BAD_REQUEST,
        ),
        (
            "not_json",
            gm.as_str(),
            b"{".to_vec(),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (case, cookie, body, expected) in cases {
        let (status, resp) = raw_post(&app, &uri, cookie, body).await;
        assert_eq!(status, expected, "case {case}: {resp}");
        if expected == StatusCode::CREATED {
            let scene = &resp["scene"];
            assert_eq!(scene["name"], json!("Cave"), "case {case}");
            assert_eq!(scene["revealed_to_players"], json!(false), "case {case}");
            assert_eq!(scene["width_px"], json!(64), "case {case}");
            assert_eq!(resp["version"], json!(1), "case {case}");
            assert_eq!(
                scene["wall_segments"].as_array().unwrap().len(),
                1,
                "case {case}"
            );
        }
    }
    assert_eq!(h.state.map_storage.get_campaign_maps(campaign_id).len(), 1);
}

// ---------------------------------------------------------------------------
// A26b — Scene-set optimistic concurrency (ADR-0037 shape)
// ---------------------------------------------------------------------------

async fn get_scene_set(app: &Router, campaign_id: Uuid, cookie: &str) -> Value {
    let uri = format!("/api/v1/campaigns/{campaign_id}/maps");
    let (status, body) = call(app, "GET", &uri, Some(cookie), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn put_scene_set(
    app: &Router,
    campaign_id: Uuid,
    cookie: &str,
    body: Value,
) -> (StatusCode, Value) {
    let uri = format!("/api/v1/campaigns/{campaign_id}/maps");
    call(app, "PUT", &uri, Some(cookie), body).await
}

/// GM campaign whose scene set has been saved `prior_saves` times (version == prior_saves).
async fn campaign_with_saves(h: &Harness, app: &Router, prior_saves: i64) -> (Uuid, String) {
    let (campaign_id, _, gm) = h.campaign(app).await;
    for v in 0..prior_saves {
        let scene = stored_scene(campaign_id, &[]);
        let (status, body) = put_scene_set(
            app,
            campaign_id,
            &gm,
            json!({ "expected_version": v, "scenes": [scene] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "seed save {v}: {body}");
    }
    (campaign_id, gm)
}

#[tokio::test]
async fn a26b_scene_put_enforces_expected_version() {
    // (case, prior saves, expected_version field, status, error code, version after)
    let cases: [(&str, i64, Option<Value>, StatusCode, Option<&str>, i64); 6] = [
        (
            "first_save_from_version_zero",
            0,
            Some(json!(0)),
            StatusCode::OK,
            None,
            1,
        ),
        (
            "matching_version_after_two_saves",
            2,
            Some(json!(2)),
            StatusCode::OK,
            None,
            3,
        ),
        (
            "missing_expected_version",
            1,
            None,
            StatusCode::BAD_REQUEST,
            Some("MISSING_EXPECTED_VERSION"),
            1,
        ),
        (
            "null_expected_version",
            1,
            Some(Value::Null),
            StatusCode::BAD_REQUEST,
            Some("MISSING_EXPECTED_VERSION"),
            1,
        ),
        (
            "stale_expected_version",
            2,
            Some(json!(1)),
            StatusCode::CONFLICT,
            Some("VERSION_CONFLICT"),
            2,
        ),
        (
            "future_expected_version",
            0,
            Some(json!(5)),
            StatusCode::CONFLICT,
            Some("VERSION_CONFLICT"),
            0,
        ),
    ];
    for (case, prior, expected_version, status, code, version_after) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, gm) = campaign_with_saves(&h, &app, prior).await;
        let scene = stored_scene(campaign_id, &[]);
        let mut body = json!({ "scenes": [scene] });
        if let Some(v) = expected_version {
            body["expected_version"] = v;
        }

        let (got, resp) = put_scene_set(&app, campaign_id, &gm, body).await;

        assert_eq!(got, status, "case {case}: {resp}");
        match code {
            Some(code) => assert_eq!(resp["code"], json!(code), "case {case}"),
            None => {
                assert_eq!(resp["version"], json!(version_after), "case {case}");
                assert_eq!(resp["scenes"][0]["id"], json!(scene.id), "case {case}");
            }
        }
        if status == StatusCode::CONFLICT {
            assert_eq!(resp["current_version"], json!(prior), "case {case}");
        }
        let stored = get_scene_set(&app, campaign_id, &gm).await;
        assert_eq!(stored["version"], json!(version_after), "case {case}");
    }
}

#[tokio::test]
async fn a26b_concurrent_scene_saves_from_same_version_one_wins() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, gm) = campaign_with_saves(&h, &app, 1).await;
    let read = get_scene_set(&app, campaign_id, &gm).await;
    let base = read["version"].as_i64().unwrap();
    let left = stored_scene(campaign_id, &[]);
    let right = stored_scene(campaign_id, &[]);

    let (a, b) = tokio::join!(
        put_scene_set(
            &app,
            campaign_id,
            &gm,
            json!({ "expected_version": base, "scenes": [left] }),
        ),
        put_scene_set(
            &app,
            campaign_id,
            &gm,
            json!({ "expected_version": base, "scenes": [right] }),
        ),
    );

    let statuses = [a.0, b.0];
    assert!(
        statuses.contains(&StatusCode::OK) && statuses.contains(&StatusCode::CONFLICT),
        "exactly one save must win: {a:?} {b:?}"
    );
    let (winner, loser) = if a.0 == StatusCode::OK {
        (a.1, b.1)
    } else {
        (b.1, a.1)
    };
    assert_eq!(winner["version"], json!(base + 1));
    assert_eq!(loser["code"], json!("VERSION_CONFLICT"));
    assert_eq!(loser["current_version"], json!(base + 1));
    let stored = get_scene_set(&app, campaign_id, &gm).await;
    assert_eq!(stored["version"], json!(base + 1));
    assert_eq!(stored["scenes"], winner["scenes"]);
}

#[tokio::test]
async fn a26b_uvtt_import_bumps_scene_set_version() {
    let image = base64::engine::general_purpose::STANDARD.encode(png_bytes(64, 64));
    // (case, prior saves, scenes after import)
    let cases = [
        ("import_into_empty_scene_set", 0_i64, 1_usize),
        ("import_after_two_saves", 2, 2),
    ];
    for (case, prior, scene_count) in cases {
        let h = Harness::new();
        let app = h.app();
        let (campaign_id, gm) = campaign_with_saves(&h, &app, prior).await;
        let uri = format!("/api/v1/campaigns/{campaign_id}/maps/import?name=Cave");

        let (status, resp) = raw_post(&app, &uri, &gm, uvtt(&image)).await;

        assert_eq!(status, StatusCode::CREATED, "case {case}: {resp}");
        assert_eq!(resp["version"], json!(prior + 1), "case {case}");
        let stored = get_scene_set(&app, campaign_id, &gm).await;
        assert_eq!(stored["version"], json!(prior + 1), "case {case}");
        assert_eq!(
            stored["scenes"].as_array().unwrap().len(),
            scene_count,
            "case {case}"
        );
        let (status, resp) = put_scene_set(
            &app,
            campaign_id,
            &gm,
            json!({ "expected_version": prior, "scenes": [] }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "case {case}: stale after import"
        );
        assert_eq!(resp["current_version"], json!(prior + 1), "case {case}");
    }
}

/// Map scene named `name` holding one of each GM secret: a closed secret door, a GM-hidden
/// staged token and a GM-only audio emitter.
fn scene_with_secrets(campaign_id: Uuid, name: &str, revealed: bool) -> Value {
    json!({
        "id": Uuid::new_v4(),
        "campaign_id": campaign_id,
        "name": name,
        "grid_size_px": 70,
        "grid_cell_distance_ft": 5.0,
        "width_px": 1400,
        "height_px": 1400,
        "revealed_to_players": revealed,
        "wall_segments": [{
            "id": Uuid::new_v4(),
            "p1": { "x": 0.0, "y": 0.0 },
            "p2": { "x": 140.0, "y": 0.0 },
            "wall_type": "SecretDoor",
            "door_state": "Closed"
        }],
        "staged_tokens": [{
            "id": Uuid::new_v4(), "name": "Ambush Goblin", "x": 70.0, "y": 70.0,
            "visibility": "GmHidden"
        }],
        "spatial_audio_emitters": [{
            "id": Uuid::new_v4(), "x": 10.0, "y": 10.0, "elevation_ft": 0.0,
            "radius_ft": 30.0, "volume": 1.0, "looping": true, "gm_only": true,
            "audio_clip_url": "secret.ogg"
        }]
    })
}

#[tokio::test]
async fn a26b_archive_round_trip_restores_scenes_with_player_masking() {
    // (case, scenes as (name, revealed_to_players))
    let cases: [(&str, &[(&str, bool)]); 3] = [
        ("no_scenes", &[]),
        ("one_hidden_scene", &[("Cragmaw Hideout", false)]),
        (
            "several_scenes_mixed_visibility",
            &[
                ("Phandalin", true),
                ("Cragmaw Hideout", false),
                ("Wave Echo Cave", true),
            ],
        ),
    ];
    for (case, spec) in cases {
        let h = Harness::new();
        let app = h.app();
        let (source_id, _, gm) = h.campaign(&app).await;
        let scenes: Vec<Value> = spec
            .iter()
            .map(|(name, revealed)| scene_with_secrets(source_id, name, *revealed))
            .collect();
        let (status, body) = put_scene_set(
            &app,
            source_id,
            &gm,
            json!({ "expected_version": 0, "scenes": scenes }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");

        let req = Request::builder()
            .uri(format!("/api/v1/campaigns/{source_id}/export"))
            .header("cookie", &gm)
            .body(Body::empty())
            .unwrap();
        let (status, _, archive) = send_raw(&app, req).await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        let (status, imported) =
            raw_post(&app, "/api/v1/campaigns/import", &gm, archive.to_vec()).await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {imported}");
        assert_eq!(
            imported["scenes_restored"],
            json!(spec.len()),
            "case {case}"
        );
        let new_id = Uuid::parse_str(imported["campaign_id"].as_str().unwrap()).unwrap();

        let gm_view = get_scene_set(&app, new_id, &gm).await;
        assert_eq!(gm_view["version"], json!(0), "case {case}");
        let gm_scenes = gm_view["scenes"].as_array().unwrap();
        let names: Vec<&str> = gm_scenes
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        let want: Vec<&str> = spec.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, want, "case {case}: scene order");
        for (scene, original) in gm_scenes.iter().zip(&scenes) {
            assert_ne!(scene["id"], original["id"], "case {case}: ids remapped");
            assert_eq!(scene["campaign_id"], json!(new_id), "case {case}");
            assert_eq!(
                scene["wall_segments"][0]["wall_type"],
                json!("SecretDoor"),
                "case {case}: GM keeps secrets"
            );
            assert_eq!(scene["staged_tokens"].as_array().unwrap().len(), 1);
            assert_eq!(scene["spatial_audio_emitters"].as_array().unwrap().len(), 1);
        }

        let (player_id, player) = h.account().await;
        h.join(new_id, player_id, "PLAYER").await;
        let player_view = get_scene_set(&app, new_id, &player).await;
        let player_scenes = player_view["scenes"].as_array().unwrap();
        let revealed: Vec<&str> = spec.iter().filter(|s| s.1).map(|s| s.0).collect();
        let player_names: Vec<&str> = player_scenes
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(player_names, revealed, "case {case}: only revealed scenes");
        for scene in player_scenes {
            assert_eq!(
                scene["wall_segments"][0]["wall_type"],
                json!("Normal"),
                "case {case}: secret door masked"
            );
            assert_eq!(scene["staged_tokens"], json!([]), "case {case}");
            assert_eq!(scene["spatial_audio_emitters"], json!([]), "case {case}");
        }

        let (status, body) = put_scene_set(
            &app,
            new_id,
            &gm,
            json!({ "expected_version": 0, "scenes": gm_scenes }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");
        assert_eq!(body["version"], json!(1), "case {case}");

        let req = Request::builder()
            .uri(format!("/api/v1/campaigns/{new_id}/export"))
            .header("cookie", &gm)
            .body(Body::empty())
            .unwrap();
        let (_, _, archive) = send_raw(&app, req).await;
        let (status, reimported) =
            raw_post(&app, "/api/v1/campaigns/import", &gm, archive.to_vec()).await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {reimported}");
        assert_eq!(
            reimported["scenes_restored"],
            json!(spec.len()),
            "case {case}: re-export does not duplicate scenes"
        );
    }
}

// ---------------------------------------------------------------------------
// Archive — REST actors and content-addressed asset keys round trip
// ---------------------------------------------------------------------------

async fn export_and_import(app: &Router, campaign_id: Uuid, cookie: &str) -> Value {
    let req = Request::builder()
        .uri(format!("/api/v1/campaigns/{campaign_id}/export"))
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap();
    let (status, _, archive) = send_raw(app, req).await;
    assert_eq!(status, StatusCode::OK);
    let (status, imported) =
        raw_post(app, "/api/v1/campaigns/import", cookie, archive.to_vec()).await;
    assert_eq!(status, StatusCode::CREATED, "{imported}");
    imported
}

fn imported_id(imported: &Value) -> Uuid {
    Uuid::parse_str(imported["campaign_id"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn archive_round_trip_restores_rest_actors() {
    // (case, actors as (name, owner kind)); owner kind: "none", "player", "unknown_user"
    let cases: [(&str, &[(&str, &str)]); 4] = [
        ("no_actors", &[]),
        ("gm_npc_without_owner", &[("Klarg", "none")]),
        (
            "player_owned_and_npc",
            &[("Sildar", "player"), ("Klarg", "none")],
        ),
        ("unknown_owner_is_dropped", &[("Ghost", "unknown_user")]),
    ];
    for (case, spec) in cases {
        let h = Harness::new();
        let app = h.app();
        let (source_id, _, gm) = h.campaign(&app).await;
        let (player_id, _) = h.account().await;
        h.join(source_id, player_id, "PLAYER").await;
        for (name, owner_kind) in spec {
            let owner = match *owner_kind {
                "player" => json!(player_id),
                "unknown_user" => json!(Uuid::new_v4()),
                _ => Value::Null,
            };
            let (status, body) = call(
                &app,
                "POST",
                &format!("/api/v1/campaigns/{source_id}/actors"),
                Some(&gm),
                json!({ "name": name, "owner_user_id": owner, "data": { "attributes": { "hp": { "current": 7, "max": 10 } } } }),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "case {case}: {body}");
        }

        let imported = export_and_import(&app, source_id, &gm).await;
        assert_eq!(
            imported["actors_restored"],
            json!(spec.len()),
            "case {case}"
        );
        let new_id = imported_id(&imported);
        let (status, body) = call(
            &app,
            "GET",
            &format!("/api/v1/campaigns/{new_id}/actors"),
            Some(&gm),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");
        let mut got: Vec<(String, Value, Value)> = body["actors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| {
                (
                    a["name"].as_str().unwrap().to_string(),
                    a["owner_user_id"].clone(),
                    a["data"]["attributes"]["hp"]["current"].clone(),
                )
            })
            .collect();
        got.sort_by(|a, b| a.0.cmp(&b.0));
        let mut want: Vec<(String, Value, Value)> = spec
            .iter()
            .map(|(name, owner_kind)| {
                let owner = if *owner_kind == "player" {
                    json!(player_id)
                } else {
                    Value::Null
                };
                (name.to_string(), owner, json!(7))
            })
            .collect();
        want.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(got, want, "case {case}");
        for actor in body["actors"].as_array().unwrap() {
            assert!(
                actor["data"].get("owner_user_id").is_none(),
                "case {case}: owner is not sheet data"
            );
        }

        let reimported = export_and_import(&app, new_id, &gm).await;
        assert_eq!(
            reimported["actors_restored"],
            json!(spec.len()),
            "case {case}: re-export does not duplicate actors"
        );
    }
}

#[tokio::test]
async fn archive_round_trip_restores_and_rewrites_asset_keys() {
    // (case, where the key is referenced, whether its blob exists at export)
    let cases = [
        ("scene_background", "scene_background", true),
        ("staged_token_avatar", "token_avatar", true),
        ("actor_portrait", "actor_portrait", true),
        ("deleted_blob_is_reported", "actor_portrait", false),
    ];
    for (case, place, blob_exists) in cases {
        let h = Harness::new();
        let app = h.app();
        let (source_id, _, gm) = h.campaign(&app).await;
        let (status, upload) = raw_post(
            &app,
            &format!("/api/v1/campaigns/{source_id}/assets"),
            &gm,
            png_bytes(8, 8),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {upload}");
        let uploaded = upload["key"].as_str().unwrap().to_string();
        let key = if blob_exists {
            uploaded.clone()
        } else {
            uploaded.replace(upload["hash"].as_str().unwrap(), &"f".repeat(64))
        };

        let mut scene: Value = serde_json::to_value(stored_scene(source_id, &[])).unwrap();
        match place {
            "scene_background" => scene["background_image_url"] = json!(key),
            "token_avatar" => {
                scene["staged_tokens"] = json!([{
                    "id": Uuid::new_v4(), "name": "Goblin", "x": 0.0, "y": 0.0,
                    "token_avatar_url": key
                }]);
            }
            _ => {
                let (status, body) = call(
                    &app,
                    "POST",
                    &format!("/api/v1/campaigns/{source_id}/actors"),
                    Some(&gm),
                    json!({ "name": "Sildar", "data": { "portraitAssetKey": key } }),
                )
                .await;
                assert_eq!(status, StatusCode::CREATED, "case {case}: {body}");
            }
        }
        let (status, body) = put_scene_set(
            &app,
            source_id,
            &gm,
            json!({ "expected_version": 0, "scenes": [scene] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");

        let imported = export_and_import(&app, source_id, &gm).await;
        let new_id = imported_id(&imported);
        let new_key = key.replace(&source_id.to_string(), &new_id.to_string());
        let want_missing = if blob_exists { json!([]) } else { json!([key]) };
        assert_eq!(imported["missing_asset_keys"], want_missing, "case {case}");

        let restored_ref = match place {
            "scene_background" => {
                get_scene_set(&app, new_id, &gm).await["scenes"][0]["background_image_url"].clone()
            }
            "token_avatar" => get_scene_set(&app, new_id, &gm).await["scenes"][0]["staged_tokens"]
                [0]["token_avatar_url"]
                .clone(),
            _ => {
                let (_, body) = call(
                    &app,
                    "GET",
                    &format!("/api/v1/campaigns/{new_id}/actors"),
                    Some(&gm),
                    Value::Null,
                )
                .await;
                body["actors"][0]["data"]["portraitAssetKey"].clone()
            }
        };
        assert_eq!(restored_ref, json!(new_key), "case {case}: key rewritten");
        let restored_blob = h.state.asset_store.get_asset(&new_key).await.unwrap();
        let source_blob = h.state.asset_store.get_asset(&key).await.unwrap();
        assert_eq!(restored_blob, source_blob, "case {case}: blob restored");
        assert_eq!(restored_blob.is_some(), blob_exists, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A27 — Idle-Lease sweeper and Ping
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn a27_sweeper_hibernates_idle_rooms_and_logs() {
    let logs = LogBuffer::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let wal = Arc::new(InMemoryWalStorage::new());
    let mgr = Arc::new(RoomLeaseManager::new(wal.clone(), 25, 40));
    let campaign_id = Uuid::new_v4();
    let room = mgr.get_or_wake_room(campaign_id).await.unwrap();
    room.dispatch_direct_command(
        gm_actor(Uuid::new_v4()),
        TrameCommand::SpawnToken {
            token: token("Goblin", None, None, 0.0),
        },
    )
    .await
    .unwrap();
    let sweeper = mgr.spawn_idle_sweeper(Duration::from_millis(10));

    for _ in 0..100 {
        if mgr.active_room_count().await == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    sweeper.abort();
    assert_eq!(mgr.active_room_count().await, 0);
    let snap = wal.load_latest_snapshot(campaign_id).unwrap().unwrap();
    assert_eq!(snap.data.tokens.len(), 1, "hibernation flushed the table");
    let text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(text.contains("idle-lease sweep hibernated rooms"), "{text}");
}

#[tokio::test]
async fn a27_ping_does_not_renew_the_lease() {
    let wal = Arc::new(InMemoryWalStorage::new());
    let mgr = RoomLeaseManager::new(wal, 25, 900_000);
    let room = mgr.get_or_wake_room(Uuid::new_v4()).await.unwrap();
    let (tx, _rx) = mpsc::unbounded_channel();
    let session_id = Uuid::new_v4();
    room.connect_client(ConnectedClient {
        session_id,
        user_id: Uuid::new_v4(),
        role: CampaignRole::Player,
        tx,
    })
    .await
    .unwrap();
    let before = room.metrics().await.unwrap().last_activity_ms;

    let cases = [
        (
            "ping_keeps_activity",
            ClientEnvelope::Ping { client_time_ms: 1 },
            false,
        ),
        (
            "pointer_ping_renews",
            ClientEnvelope::PointerPing {
                pos: Point2D::new(1.0, 1.0),
                color_hex: "#ffaa00".to_string(),
            },
            true,
        ),
    ];
    for (case, envelope, renews) in cases {
        tokio::time::sleep(Duration::from_millis(5)).await;
        room.send_envelope(session_id, envelope).await.unwrap();
        let after = room.metrics().await.unwrap().last_activity_ms;
        assert_eq!(after > before, renews, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A05 — initiative totals from the authoritative roll
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a05_auto_rolled_initiative_fills_totals() {
    let cases: [(&str, TrameCommand); 2] = [
        (
            "start_turn_by_turn",
            TrameCommand::StartTurnByTurn {
                initiative_order: Vec::new(),
                initiative_totals: BTreeMap::new(),
            },
        ),
        (
            "set_table_mode_turn_by_turn",
            TrameCommand::SetTableMode {
                mode: TableMode::TurnByTurn,
                exploration_paused: false,
                initiative_order: Vec::new(),
                initiative_totals: BTreeMap::new(),
            },
        ),
    ];
    for (case, cmd) in cases {
        let mgr = RoomLeaseManager::new(Arc::new(InMemoryWalStorage::new()), 25, 900_000);
        let room = mgr.get_or_wake_room(Uuid::new_v4()).await.unwrap();
        let gm = gm_actor(Uuid::new_v4());
        for (i, dex) in [-1, 2, 4].into_iter().enumerate() {
            let mut t = token(&format!("T{i}"), None, None, f64::from(i as u32) * 70.0);
            t.dex_mod = dex;
            room.dispatch_direct_command(gm.clone(), TrameCommand::SpawnToken { token: t })
                .await
                .unwrap();
        }
        room.dispatch_direct_command(gm.clone(), cmd).await.unwrap();
        let state = table(&room).await;
        let order = &state.data.initiative_order;
        assert_eq!(order.len(), 3, "case {case}");
        let totals: Vec<i32> = order
            .iter()
            .map(|id| *state.data.initiative_totals.get(id).expect(case))
            .collect();
        assert!(
            totals.windows(2).all(|w| w[0] >= w[1]),
            "case {case}: {totals:?}"
        );
        for (id, total) in order.iter().zip(&totals) {
            let dex = state.data.tokens[id].dex_mod;
            assert!((1 + dex..=20 + dex).contains(total), "case {case}");
        }
    }
}

// ---------------------------------------------------------------------------
// A31 / A52 — SPA static serving never shadows the API
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a52_static_dir_serves_spa_without_shadowing_api() {
    let dir = std::env::temp_dir().join(format!("trame-spa-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::File::create(dir.join("index.html"))
        .unwrap()
        .write_all(b"<html>TRAME SPA</html>")
        .unwrap();
    std::fs::write(dir.join("app.js"), b"console.log('trame')").unwrap();
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(
        dir.join("assets/index-abc123.js"),
        b"export const bundle = 1;",
    )
    .unwrap();

    let served = Harness::with_static_dir(Some(dir.clone())).app();
    let bare = Harness::new().app();
    let cases = [
        (
            "root_serves_index",
            &served,
            "/",
            StatusCode::OK,
            Some("TRAME SPA"),
        ),
        (
            "client_route_falls_back",
            &served,
            "/campaigns/abc/table",
            StatusCode::OK,
            Some("TRAME SPA"),
        ),
        (
            "static_file_served",
            &served,
            "/app.js",
            StatusCode::OK,
            Some("console.log"),
        ),
        (
            "unknown_api_is_json_404",
            &served,
            "/api/v1/nope",
            StatusCode::NOT_FOUND,
            Some("NOT_FOUND"),
        ),
        (
            "unknown_asset_is_json_404",
            &served,
            "/assets/nope",
            StatusCode::NOT_FOUND,
            Some("NOT_FOUND"),
        ),
        (
            "vite_bundle_under_assets_served",
            &served,
            "/assets/index-abc123.js",
            StatusCode::OK,
            Some("export const bundle"),
        ),
        (
            "missing_bundle_chunk_is_json_404_not_index",
            &served,
            "/assets/index-stale.js",
            StatusCode::NOT_FOUND,
            Some("NOT_FOUND"),
        ),
        (
            "signed_download_stays_api_route",
            &served,
            "/assets/download/instances/i/campaigns/c/assets/x.webp?exp=1&sig=00",
            StatusCode::FORBIDDEN,
            Some("invalid or expired"),
        ),
        (
            "bare_download_prefix_is_json_404",
            &served,
            "/assets/download",
            StatusCode::NOT_FOUND,
            Some("NOT_FOUND"),
        ),
        (
            "unknown_ws_is_json_404",
            &served,
            "/ws/nope",
            StatusCode::NOT_FOUND,
            Some("NOT_FOUND"),
        ),
        (
            "healthz_still_api",
            &served,
            "/healthz",
            StatusCode::OK,
            Some("\"status\""),
        ),
        (
            "api_route_still_api",
            &served,
            "/api/v1/campaigns",
            StatusCode::UNAUTHORIZED,
            None,
        ),
        (
            "unset_dir_serves_nothing",
            &bare,
            "/",
            StatusCode::NOT_FOUND,
            None,
        ),
    ];
    for (case, app, uri, expected, needle) in cases {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        let (status, _, body) = send_raw(app, req).await;
        assert_eq!(status, expected, "case {case}");
        if let Some(n) = needle {
            let text = String::from_utf8_lossy(&body);
            assert!(text.contains(n), "case {case}: {text}");
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a52_html_gets_spa_csp_everything_else_strict_csp() {
    let dir = std::env::temp_dir().join(format!("trame-csp-{}", Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), b"<html>TRAME SPA</html>").unwrap();
    std::fs::write(dir.join("assets/index-abc123.js"), b"export {};").unwrap();
    let app = Harness::with_static_dir(Some(dir.clone())).app();
    let spa = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
               img-src 'self'; font-src 'self'; \
               connect-src 'self' ws://table.example.com:8080 wss://table.example.com:8080; \
               form-action 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    let strict = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    let cases = [
        ("index_html", "/", "table.example.com:8080", spa),
        (
            "deep_link_html",
            "/campaigns/abc/table",
            "table.example.com:8080",
            spa,
        ),
        (
            "bundle_js",
            "/assets/index-abc123.js",
            "table.example.com:8080",
            strict,
        ),
        (
            "api_json",
            "/api/v1/campaigns",
            "table.example.com:8080",
            strict,
        ),
        (
            "api_json_404",
            "/api/v1/nope",
            "table.example.com:8080",
            strict,
        ),
        ("healthz_json", "/healthz", "table.example.com:8080", strict),
        (
            "html_with_unsafe_host_omits_ws_sources",
            "/",
            "evil.example;script-src",
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
             img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; \
             object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        ),
    ];
    for (case, uri, host, expected) in cases {
        let req = Request::builder()
            .uri(uri)
            .header("host", host)
            .body(Body::empty())
            .unwrap();
        let (_, headers, _) = send_raw(&app, req).await;
        assert_eq!(headers["content-security-policy"], expected, "case {case}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------------------
// Archive — in-memory export/import round trip through the routes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn archive_export_then_import_round_trips() {
    let h = Harness::new();
    let app = h.app();
    let (campaign_id, _, gm) = h.campaign(&app).await;
    trame_server::http::seed_campaign_for_export(
        &h.state,
        trame_server::archive::CampaignMetadata {
            id: campaign_id,
            name: "Lost Mine".to_string(),
            system: "dnd5e".to_string(),
            description: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        },
        vec![trame_server::archive::ExportEntity {
            entity_type: "actor".to_string(),
            data: json!({ "id": Uuid::new_v4(), "name": "Sildar" }),
        }],
        Vec::new(),
        Vec::new(),
    )
    .await
    .unwrap();
    let req = Request::builder()
        .uri(format!("/api/v1/campaigns/{campaign_id}/export"))
        .header("cookie", &gm)
        .body(Body::empty())
        .unwrap();
    let (status, _, archive) = send_raw(&app, req).await;
    assert_eq!(status, StatusCode::OK);

    let (status, imported) =
        raw_post(&app, "/api/v1/campaigns/import", &gm, archive.to_vec()).await;
    assert_eq!(status, StatusCode::CREATED, "{imported}");
    assert_eq!(imported["actors_restored"], json!(1));
    assert_ne!(
        imported["campaign_id"],
        json!(campaign_id.to_string()),
        "ids are remapped"
    );
}
