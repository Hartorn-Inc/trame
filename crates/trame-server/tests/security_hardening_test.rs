//! ============================================================================
//! S-B SECURITY HARDENING SUITE (security_hardening_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Proves the internet-ready security MUSTs at the highest seams: HTTP rules
//!   through the full Axum router (`build_router_with_state`) and live table
//!   rules through the `TableRoomActor` the WebSocket handler feeds.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Every rule is a `(case_id, input, expected)` table.
//!   - Identity comes only from session cookies; client IPs from
//!     `X-Forwarded-For` under an explicit `trusted_proxy_hops`.
//!   - Oversized inputs are streamed or forged headers, never real large buffers.
//!
//! COVERAGE:
//!   SEC1/SEC6/SEC16 archive import, SEC2 export, SEC3 initiative, SEC4 rate
//!   limits, SEC5 keys, SEC8 secret doors, SEC9 timeline, SEC14 image limits,
//!   SEC15 opaque errors and health, GS15 dice keep bounds.
//! ============================================================================

use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use bytes::Bytes;
use futures_lite::io::AsyncWriteExt as _;
use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::sync::mpsc;
use tower::ServiceExt;
use trame_engine::commands::{CampaignRole, TableState, TokenState, TrameCommand, TrameEvent};
use trame_engine::geometry::{Point2D, WallKind, WallSegment};
use trame_server::archive::importer::{ARCHIVE_IMPORT_PERMITS, MAX_CONCURRENT_IMPORTS};
use trame_server::archive::stored_assets;
use trame_server::archive::{
    ArchiveEntryDescriptor, ArchiveImporter, CampaignManifest, CampaignMetadata, ExportEntity,
    InMemoryCampaignStore, ManifestStats,
};
use trame_server::assets::store::{
    AssetStore, InMemoryAssetStore, PRESIGNED_URL_DEFAULT_TTL, verify_asset_signature,
};
use trame_server::auth::accounts::InstanceRole;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{
    AuthState, IdentityStore, InMemorySessionStore, SessionStore, UserRecord, hash_session_token,
};
use trame_server::auth::totp::TotpService;
use trame_server::campaigns::tactical_sync_from_sheet;
use trame_server::config::{
    DATABASE_URL_VAR, INVITE_JWT_SECRET_VAR, JWT_SECRET_VAR, KNOWN_DEV_SECRETS,
    MASTER_ENCRYPTION_KEY_VAR, PUBLIC_ORIGIN_VAR, REMOVED_TRUST_FORWARDED_FOR_VAR, ServerConfig,
    TRAME_ENV_VAR, TRUSTED_PROXY_HOPS_VAR,
};
use trame_server::dice::RollVisibility;
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
    seed_campaign_for_export,
};
use trame_server::maps::InMemoryMapStorage;
use trame_server::room::{ConnectedClient, OutboundClientFrame, RoomLeaseManager, TableRoomHandle};
use trame_server::security::{
    AuthRateLimiter, GENERIC_SERVER_ERROR, RateLimit, SecurityPolicy, TotpBackoff,
    opaque_server_errors_middleware,
};
use trame_server::storage::SqlxPostgresStore;
use trame_server::storage::blob::Sha256Hasher;
use trame_server::sync::{ClientEnvelope, CommandSubmission, ServerEnvelope};
use trame_server::timeline::{AppendEventInput, InMemoryTimelineStorage, TimelineStorage};
use trame_server::wal::{InMemoryWalStorage, TableStateSnapshot, WalStorage};
use uuid::Uuid;

const STRONG_SECRET: &[u8] = b"sb-test-invite-secret-at-least-32-bytes!";

// ---------------------------------------------------------------------------
// Router harness
// ---------------------------------------------------------------------------

struct Harness {
    state: AppState,
    timeline: Arc<InMemoryTimelineStorage>,
    asset_store: Arc<InMemoryAssetStore>,
}

impl Harness {
    fn new() -> Self {
        Self::with(SecurityPolicy::default())
    }

    fn with(policy: SecurityPolicy) -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let timeline = Arc::new(InMemoryTimelineStorage::new());
        let asset_store = Arc::new(InMemoryAssetStore::with_ephemeral_secret());
        let auth_state = AuthState::with_security(
            Arc::new(MagicLinkService::new(STRONG_SECRET.to_vec(), "trame-test")),
            Arc::new(InMemorySessionStore::new()),
            Arc::new(TotpService::default()),
            Arc::new(policy),
        );
        let state = AppState {
            lease_manager: Arc::new(RoomLeaseManager::new(wal, 25, 900_000)),
            asset_store: asset_store.clone(),
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
            static_dir: None,
        };
        Self {
            state,
            timeline,
            asset_store,
        }
    }

    fn app(&self) -> Router {
        build_router_with_state(self.state.clone())
    }

    /// Creates a registered (or guest) account with a live session; returns `(id, cookie)`.
    async fn account(&self, is_guest: bool) -> (Uuid, String) {
        let user_id = Uuid::new_v4();
        let store = &self.state.auth_state.session_store;
        store
            .save_user(UserRecord {
                id: user_id,
                username: format!("user-{user_id}"),
                role: "PLAYER".to_string(),
                is_guest,
                created_at: 0,
                email: Some(format!("{user_id}@example.com")),
                password_hash: None,
                mfa_enabled: false,
                totp_secret: None,
                pending_totp_secret: None,
                instance_role: if is_guest {
                    InstanceRole::Member
                } else {
                    InstanceRole::Host
                },
            })
            .await
            .unwrap();
        let token = format!("sb-session-{user_id}");
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

    /// Account holding `role` in `campaign_id` (`None` = not a member); returns its cookie.
    async fn member(&self, campaign_id: Uuid, role: Option<&str>) -> String {
        let (user_id, cookie) = self.account(false).await;
        if let Some(role) = role {
            self.join(campaign_id, user_id, role).await;
        }
        cookie
    }
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, Bytes) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, body)
}

fn request(method: &str, uri: &str, cookie: Option<&str>, body: Body) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    builder.body(body).unwrap()
}

fn auth_request(uri: &str, client_chain: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-forwarded-for", client_chain)
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn campaign_meta(id: Uuid, name: &str) -> CampaignMetadata {
    CampaignMetadata {
        id,
        name: name.to_string(),
        system: "dnd5e".to_string(),
        description: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

fn text(body: &Bytes) -> String {
    String::from_utf8_lossy(body).into_owned()
}

// ---------------------------------------------------------------------------
// Room harness
// ---------------------------------------------------------------------------

struct Table {
    room: TableRoomHandle,
    gm: (Uuid, mpsc::Receiver<OutboundClientFrame>),
    player: (Uuid, mpsc::Receiver<OutboundClientFrame>),
}

impl Table {
    async fn open(state: TableState, player_user: Uuid) -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let campaign_id = Uuid::new_v4();
        wal.save_snapshot(TableStateSnapshot::capture(campaign_id, 0, 0, &state))
            .unwrap();
        let room = RoomLeaseManager::new(wal, 25, 900_000)
            .get_or_wake_room(campaign_id)
            .await
            .unwrap();
        let gm = Self::connect(&room, Uuid::new_v4(), CampaignRole::Gm).await;
        let player = Self::connect(&room, player_user, CampaignRole::Player).await;
        let mut table = Self { room, gm, player };
        table.drain_all();
        table
    }

    async fn connect(
        room: &TableRoomHandle,
        user_id: Uuid,
        role: CampaignRole,
    ) -> (Uuid, mpsc::Receiver<OutboundClientFrame>) {
        let (tx, rx) = trame_server::room::client_channel();
        let session_id = Uuid::new_v4();
        room.connect_client(ConnectedClient {
            session_id,
            user_id,
            role,
            tx,
        })
        .await
        .unwrap();
        (session_id, rx)
    }

    async fn submit(&self, as_gm: bool, envelope: ClientEnvelope) {
        let session = if as_gm { self.gm.0 } else { self.player.0 };
        self.room.send_envelope(session, envelope).await.unwrap();
    }

    async fn command(&self, command: TrameCommand) {
        self.submit(
            true,
            ClientEnvelope::SubmitCommand(Box::new(CommandSubmission {
                command,
                correlation_id: None,
            })),
        )
        .await;
    }

    async fn roll(&self, as_gm: bool, expression: &str, reason: &str) {
        self.submit(
            as_gm,
            ClientEnvelope::RollDice {
                expression: expression.to_string(),
                visibility: RollVisibility::Public,
                reason: reason.to_string(),
                correlation_id: None,
            },
        )
        .await;
    }

    fn drain(rx: &mut mpsc::Receiver<OutboundClientFrame>) -> Vec<ServerEnvelope> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            if let OutboundClientFrame::Binary(bytes) = frame {
                out.push(rmp_serde::from_slice(&bytes).unwrap());
            }
        }
        out
    }

    fn drain_all(&mut self) {
        Self::drain(&mut self.gm.1);
        Self::drain(&mut self.player.1);
    }
}

fn token(id: Uuid, name: &str, owner: Option<Uuid>) -> TokenState {
    let mut t = TokenState::new_default(id, name, Point2D::new(0.0, 0.0));
    t.owner_user_id = owner;
    t
}

fn rolls(frames: &[ServerEnvelope]) -> Vec<(String, String, Option<i32>)> {
    frames
        .iter()
        .filter_map(|e| match e {
            ServerEnvelope::DiceRolled(r) => {
                Some((r.reason.clone(), r.expression.clone(), r.total))
            }
            _ => None,
        })
        .collect()
}

fn rejected(frames: &[ServerEnvelope]) -> bool {
    frames
        .iter()
        .any(|e| matches!(e, ServerEnvelope::CommandRejected { .. }))
}

// ---------------------------------------------------------------------------
// GS15 — dice keep bounds
// ---------------------------------------------------------------------------

#[tokio::test]
async fn gs15_keep_count_must_lie_within_dice_count() {
    // (case_id, expression, accepted)
    let cases = [
        ("kh_one_of_two", "2d20kh1", true),
        ("kh_all_dice", "4d6kh4", true),
        ("kl_one_of_two", "2d20kl1", true),
        ("kh_zero", "2d20kh0", false),
        ("kh_more_than_rolled", "2d20kh3", false),
        ("kl_zero", "4d6kl0", false),
        ("kl_more_than_rolled", "1d20kl2", false),
    ];
    for (case, expression, accepted) in cases {
        let mut table = Table::open(TableState::new(100.0, 5.0, Vec::new()), Uuid::new_v4()).await;
        table.roll(false, expression, "check").await;
        let frames = Table::drain(&mut table.player.1);
        assert_eq!(!rolls(&frames).is_empty(), accepted, "case {case}");
        assert_eq!(rejected(&frames), !accepted, "case {case}");
        table.drain_all();
    }
}

// ---------------------------------------------------------------------------
// SEC3 — server-authoritative initiative
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec3_player_initiative_ignores_the_client_expression() {
    // (case_id, dex_mod, initiative_extra, client expression, expected server expression)
    let cases = [
        ("dex_only", 3, 0, "1d20+100", "1d20+3"),
        ("alert_bonus_added", 2, 3, "1d20", "1d20+5"),
        ("exhaustion_penalty", 0, -4, "1d20+20", "1d20-4"),
        ("zero_modifier", 0, 0, "20", "1d20"),
    ];
    for (case, dex_mod, extra, client_expr, server_expr) in cases {
        let player_user = Uuid::new_v4();
        let hero = Uuid::new_v4();
        let mut t = token(hero, "Hero", Some(player_user));
        t.dex_mod = dex_mod;
        t.initiative_extra = extra;
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        state.data.tokens.insert(hero, t);
        let mut table = Table::open(state, player_user).await;

        table.roll(false, client_expr, "Initiative").await;
        let got = rolls(&Table::drain(&mut table.player.1));
        assert_eq!(got.len(), 1, "case {case}: {got:?}");
        assert_eq!(got[0].0, "Initiative: Hero", "case {case}");
        assert_eq!(got[0].1, server_expr, "case {case}");
    }
}

#[tokio::test]
async fn sec3_only_the_first_player_roll_per_encounter_counts() {
    let player_user = Uuid::new_v4();
    let (hero, npc) = (Uuid::new_v4(), Uuid::new_v4());
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    state
        .data
        .tokens
        .insert(hero, token(hero, "Hero", Some(player_user)));
    state.data.tokens.insert(npc, token(npc, "Bandit", None));
    let mut table = Table::open(state, player_user).await;

    table.roll(false, "1d20", "Initiative").await;
    let first = rolls(&Table::drain(&mut table.player.1));
    let first_total = first[0].2.expect("public roll total");
    table.drain_all();

    // (case_id, player re-roll reason)
    for (case, reason) in [
        ("second_roll_rejected", "Initiative"),
        ("case_insensitive_reason_rejected", "  initiative (retry)"),
    ] {
        table.roll(false, "1d20+30", reason).await;
        let frames = Table::drain(&mut table.player.1);
        assert!(rolls(&frames).is_empty(), "case {case}");
        assert!(rejected(&frames), "case {case}");
        table.drain_all();
    }

    table
        .command(TrameCommand::StartTurnByTurn {
            initiative_order: Vec::new(),
            initiative_totals: Default::default(),
        })
        .await;
    let gm_frames = Table::drain(&mut table.gm.1);
    let reasons: Vec<String> = rolls(&gm_frames).into_iter().map(|r| r.0).collect();
    assert!(reasons.contains(&"Initiative: Bandit".to_string()));
    assert!(
        !reasons.contains(&"Initiative: Hero".to_string()),
        "the player's first roll is reused, not re-rolled"
    );
    let Some(ServerEnvelope::CommandAccepted { state, .. }) = gm_frames
        .iter()
        .find(|e| matches!(e, ServerEnvelope::CommandAccepted { .. }))
    else {
        panic!("expected CommandAccepted");
    };
    assert_eq!(state.initiative_totals.get(&hero), Some(&first_total));
    table.drain_all();

    table.roll(false, "1d20", "Initiative").await;
    let frames = Table::drain(&mut table.player.1);
    assert!(rejected(&frames), "no re-roll once the encounter runs");
}

#[test]
fn sec3_initiative_bonus_derives_from_the_sheet() {
    // (case_id, sheet, expected initiative_extra beyond the Dexterity modifier)
    let alert = serde_json::json!(["srd:feat:alert"]);
    let cases = [
        ("level_1_no_alert", serde_json::json!({}), 0),
        (
            "alert_level_1_adds_proficiency_2",
            serde_json::json!({ "features": alert, "attributes": { "level": 1 } }),
            2,
        ),
        (
            "alert_level_17_adds_proficiency_6",
            serde_json::json!({ "features": alert, "attributes": { "level": 17 } }),
            6,
        ),
        (
            "level_clamped_to_20",
            serde_json::json!({ "features": alert, "attributes": { "level": 99 } }),
            6,
        ),
        (
            "exhaustion_2_subtracts_4",
            serde_json::json!({ "attributes": { "exhaustion": 2 } }),
            -4,
        ),
        (
            "alert_level_5_with_exhaustion_1",
            serde_json::json!({ "features": alert, "attributes": { "level": 5, "exhaustion": 1 } }),
            1,
        ),
    ];
    for (case, mut sheet, expected) in cases {
        sheet["abilities"] = serde_json::json!({ "dex": { "score": 14 } });
        let sync = tactical_sync_from_sheet(Some("Hero"), &sheet);
        assert_eq!(sync.dex_mod, Some(2), "case {case}");
        assert_eq!(sync.initiative_extra, Some(expected), "case {case}");
    }
}

// ---------------------------------------------------------------------------
// SEC8 — live secret-door masking
// ---------------------------------------------------------------------------

fn wall(kind: WallKind) -> WallSegment {
    let mut w = WallSegment::normal_wall(
        Uuid::new_v4(),
        Point2D::new(0.0, 0.0),
        Point2D::new(100.0, 0.0),
    );
    w.kind = kind;
    w
}

/// What a recipient learns from the wall-related event of one command.
#[derive(Debug, PartialEq)]
enum WallNews {
    Nothing,
    Added(WallKind),
    Toggled(bool),
    Configured(WallKind),
}

fn wall_news(frames: &[ServerEnvelope]) -> WallNews {
    frames
        .iter()
        .filter_map(|e| match e {
            ServerEnvelope::CommandAccepted { events, .. } => Some(events),
            _ => None,
        })
        .flatten()
        .find_map(|ev| match ev {
            TrameEvent::WallAdded { wall } => Some(WallNews::Added(wall.kind.clone())),
            TrameEvent::DoorToggled { is_open, .. } => Some(WallNews::Toggled(*is_open)),
            TrameEvent::DoorConfigured { kind, .. } => Some(WallNews::Configured(kind.clone())),
            _ => None,
        })
        .unwrap_or(WallNews::Nothing)
}

#[tokio::test]
async fn sec8_live_secret_door_events_are_masked_for_players() {
    let closed_secret = wall(WallKind::SecretDoor { is_open: false });
    let open_secret = wall(WallKind::SecretDoor { is_open: true });
    let door = wall(WallKind::Door {
        is_open: false,
        is_locked: false,
    });
    let closed = WallKind::SecretDoor { is_open: false };
    let illusion = WallKind::Illusion {
        pierced_by_truesight: true,
    };

    // (case_id, GM command, what the GM learns, what the player learns)
    let cases = [
        (
            "add_closed_secret_door_looks_like_a_wall",
            TrameCommand::AddWall {
                wall: wall(closed.clone()),
            },
            WallNews::Added(closed.clone()),
            WallNews::Added(WallKind::Normal),
        ),
        (
            "add_illusion_looks_like_a_wall",
            TrameCommand::AddWall {
                wall: wall(illusion.clone()),
            },
            WallNews::Added(illusion.clone()),
            WallNews::Added(WallKind::Normal),
        ),
        (
            "add_open_secret_door_is_revealed",
            TrameCommand::AddWall {
                wall: wall(WallKind::SecretDoor { is_open: true }),
            },
            WallNews::Added(WallKind::SecretDoor { is_open: true }),
            WallNews::Added(WallKind::SecretDoor { is_open: true }),
        ),
        (
            "closing_a_secret_door_emits_nothing",
            TrameCommand::ToggleDoor {
                wall_id: open_secret.id,
                is_open: false,
            },
            WallNews::Toggled(false),
            WallNews::Nothing,
        ),
        (
            "opening_a_secret_door_reveals_it",
            TrameCommand::ToggleDoor {
                wall_id: closed_secret.id,
                is_open: true,
            },
            WallNews::Toggled(true),
            WallNews::Toggled(true),
        ),
        (
            "configuring_a_door_as_closed_secret_is_masked",
            TrameCommand::ConfigureDoor {
                wall_id: door.id,
                is_open: Some(false),
                is_locked: None,
                is_secret: Some(true),
            },
            WallNews::Configured(closed.clone()),
            WallNews::Configured(WallKind::Normal),
        ),
        (
            "configuring_a_secret_door_as_door_is_revealed",
            TrameCommand::ConfigureDoor {
                wall_id: closed_secret.id,
                is_open: None,
                is_locked: None,
                is_secret: Some(false),
            },
            WallNews::Configured(WallKind::Door {
                is_open: false,
                is_locked: false,
            }),
            WallNews::Configured(WallKind::Door {
                is_open: false,
                is_locked: false,
            }),
        ),
    ];
    for (case, command, gm_expected, player_expected) in cases {
        let state = TableState::new(
            100.0,
            5.0,
            vec![closed_secret.clone(), open_secret.clone(), door.clone()],
        );
        let mut table = Table::open(state, Uuid::new_v4()).await;
        table.command(command).await;
        let gm_frames = Table::drain(&mut table.gm.1);
        let player_frames = Table::drain(&mut table.player.1);
        assert_eq!(wall_news(&gm_frames), gm_expected, "case {case}");
        assert_eq!(wall_news(&player_frames), player_expected, "case {case}");

        let Some(ServerEnvelope::CommandAccepted { state, .. }) = player_frames
            .iter()
            .find(|e| matches!(e, ServerEnvelope::CommandAccepted { .. }))
        else {
            panic!("case {case}: player gets the accepted state");
        };
        assert!(
            state.walls.iter().all(|w| !matches!(
                w.kind,
                WallKind::SecretDoor { is_open: false } | WallKind::Illusion { .. }
            )),
            "case {case}: projected walls stay masked"
        );
    }
}

// ---------------------------------------------------------------------------
// SEC2 — export is GM-only
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec2_export_requires_the_game_master_role() {
    let h = Harness::new();
    let campaign_id = Uuid::new_v4();
    seed_campaign_for_export(
        &h.state,
        campaign_meta(campaign_id, "Secrets"),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )
    .await
    .unwrap();

    // (case_id, membership role, expected status)
    let cases = [
        ("game_master", Some("GM"), StatusCode::OK),
        ("player", Some("PLAYER"), StatusCode::FORBIDDEN),
        ("spectator", Some("SPECTATOR"), StatusCode::FORBIDDEN),
        ("non_member", None, StatusCode::FORBIDDEN),
    ];
    for (case, role, expected) in cases {
        let cookie = h.member(campaign_id, role).await;
        let (status, _) = send(
            &h.app(),
            request(
                "GET",
                &format!("/api/v1/campaigns/{campaign_id}/export"),
                Some(&cookie),
                Body::empty(),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// SEC9 — timeline allow-list per role
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec9_timeline_returns_only_allowed_event_kinds_per_role() {
    let h = Harness::new();
    let campaign_id = Uuid::new_v4();
    let key = campaign_id.to_string();
    let events = [
        ("dice_roll", serde_json::json!({})),
        ("initiative", serde_json::json!({})),
        ("handout_revealed", serde_json::json!({})),
        ("dice_roll", serde_json::json!({ "visibility": "gm_only" })),
        ("token_moved", serde_json::json!({})),
        ("GmNote", serde_json::json!({})),
    ];
    for (i, (kind, payload)) in events.iter().enumerate() {
        h.timeline
            .append_event(
                &key,
                1,
                AppendEventInput {
                    event_type: kind.to_string(),
                    actor_id: None,
                    payload: payload.clone(),
                    timestamp: Some(i as u64 + 1),
                },
            )
            .unwrap();
    }

    let public = ["dice_roll", "handout_revealed", "initiative"];
    // (case_id, membership role, expected sorted kinds)
    let cases: [(&str, &str, Vec<&str>); 3] = [
        (
            "game_master_sees_everything",
            "GM",
            vec![
                "GmNote",
                "dice_roll",
                "dice_roll",
                "handout_revealed",
                "initiative",
                "token_moved",
            ],
        ),
        ("player_sees_public_kinds", "PLAYER", public.to_vec()),
        ("spectator_sees_public_kinds", "SPECTATOR", public.to_vec()),
    ];
    for (case, role, expected) in cases {
        let cookie = h.member(campaign_id, Some(role)).await;
        let (status, body) = send(
            &h.app(),
            request(
                "GET",
                &format!("/api/v1/campaigns/{campaign_id}/sessions/1/timeline"),
                Some(&cookie),
                Body::empty(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let mut kinds: Vec<String> = json["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event_type"].as_str().unwrap().to_string())
            .collect();
        kinds.sort();
        assert_eq!(kinds, expected, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// SEC4 — rate limiter
// ---------------------------------------------------------------------------

fn policy(hops: usize, per_ip: u32, per_account: u32) -> SecurityPolicy {
    let limit = |max_attempts| RateLimit {
        max_attempts,
        window: Duration::from_secs(60),
    };
    SecurityPolicy {
        trusted_proxy_hops: hops,
        rate_limiter: AuthRateLimiter::new(limit(per_ip), limit(per_account)),
        ..SecurityPolicy::default()
    }
}

#[tokio::test]
async fn sec4_only_failed_attempts_consume_the_allowance() {
    let password = "Correct-Horse-Battery-9";
    // (case_id, login password, attempts, last attempt throttled)
    let cases = [
        ("repeated_successes_never_throttled", password, 4, false),
        (
            "failures_throttled_after_allowance",
            "wrong-password",
            3,
            true,
        ),
    ];
    for (case, attempt_password, attempts, throttled) in cases {
        let h = Harness::with(policy(1, 100, 2));
        let app = h.app();
        let email = format!("{}@example.com", Uuid::new_v4());
        let (status, body) = send(
            &app,
            auth_request(
                "/api/v1/auth/register",
                "10.0.0.1",
                serde_json::json!({ "email": email, "password": password, "display_name": "Rate Tester" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {}", text(&body));
        let mut last = StatusCode::OK;
        for _ in 0..attempts {
            (last, _) = send(
                &app,
                auth_request(
                    "/api/v1/auth/login",
                    "10.0.0.1",
                    serde_json::json!({ "email": email, "password": attempt_password }),
                ),
            )
            .await;
        }
        assert_eq!(
            last == StatusCode::TOO_MANY_REQUESTS,
            throttled,
            "case {case}: {last}"
        );
    }
}

#[tokio::test]
async fn sec4_route_families_keep_separate_buckets() {
    // (case_id, follow-up route, follow-up body, throttled)
    let cases = [
        (
            "same_route_throttled",
            "/api/v1/auth/login",
            serde_json::json!({ "email": "z@example.com", "password": "x" }),
            true,
        ),
        (
            "register_unaffected",
            "/api/v1/auth/register",
            serde_json::json!({ "email": "z@example.com", "password": "a" }),
            false,
        ),
        (
            "invite_redemption_unaffected",
            "/api/v1/invites/redeem",
            serde_json::json!({ "token": "bogus" }),
            false,
        ),
        (
            "owner_bootstrap_unaffected",
            "/api/v1/instance/bootstrap",
            serde_json::json!({ "token": "bogus", "email": "z@example.com", "password": "a" }),
            false,
        ),
        (
            "bind_unaffected",
            "/api/v1/auth/bind-account",
            serde_json::json!({ "email": "z@example.com", "password": "a" }),
            false,
        ),
    ];
    for (case, uri, body, throttled) in cases {
        let h = Harness::with(policy(1, 2, 100));
        let app = h.app();
        for i in 0..2 {
            send(
                &app,
                auth_request(
                    "/api/v1/auth/login",
                    "10.9.0.1",
                    serde_json::json!({ "email": format!("u{i}@example.com"), "password": "x" }),
                ),
            )
            .await;
        }
        let (status, _) = send(&app, auth_request(uri, "10.9.0.1", body)).await;
        assert_eq!(
            status == StatusCode::TOO_MANY_REQUESTS,
            throttled,
            "case {case}: {status}"
        );
    }
}

#[tokio::test]
async fn sec4_bind_routes_are_rate_limited() {
    // (case_id, route)
    let cases = [
        ("bind", "/api/v1/auth/bind"),
        ("bind_account", "/api/v1/auth/bind-account"),
    ];
    for (case, uri) in cases {
        let h = Harness::with(policy(1, 2, 100));
        let app = h.app();
        let mut statuses = Vec::new();
        for _ in 0..3 {
            let mut req = auth_request(
                uri,
                "10.4.0.1",
                serde_json::json!({ "email": "b@example.com", "password": "x" }),
            );
            req.headers_mut()
                .insert("cookie", "trame_session=bogus".parse().unwrap());
            statuses.push(send(&app, req).await.0);
        }
        assert!(
            statuses[..2]
                .iter()
                .all(|s| *s != StatusCode::TOO_MANY_REQUESTS),
            "case {case}: {statuses:?}"
        );
        assert_eq!(statuses[2], StatusCode::TOO_MANY_REQUESTS, "case {case}");
    }
}

#[tokio::test]
async fn sec4_totp_failures_add_an_exponential_lockout() {
    let password = "Correct-Horse-Battery-9";
    // (case_id, login password, carries a TOTP code, fifth attempt throttled)
    let cases = [
        (
            "password_only_failures_not_locked",
            "wrong-password",
            false,
            false,
        ),
        (
            "wrong_password_with_totp_code_not_locked",
            "wrong-password",
            true,
            false,
        ),
        (
            "wrong_totp_after_correct_password_locked",
            password,
            true,
            true,
        ),
    ];
    for (case, attempt_password, with_totp, throttled) in cases {
        let h = Harness::with(policy(1, 100, 100));
        let app = h.app();
        let email = format!("{}@example.com", Uuid::new_v4());
        let (status, body) = send(
            &app,
            auth_request(
                "/api/v1/auth/register",
                "10.5.0.1",
                serde_json::json!({ "email": email, "password": password, "display_name": "Mfa" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {}", text(&body));
        let store = &h.state.auth_state.session_store;
        let user = store.get_user_by_email(&email).await.unwrap().unwrap();
        let secret = h
            .state
            .auth_state
            .totp_service
            .encrypt_secret(b"12345678901234567890")
            .unwrap();
        store.enable_totp_for_user(user.id, &secret).await.unwrap();

        let mut body = serde_json::json!({ "email": email, "password": attempt_password });
        if with_totp {
            body["totp_code"] = "XXXXXX".into();
        }
        let mut last = StatusCode::OK;
        for _ in 0..5 {
            (last, _) = send(
                &app,
                auth_request("/api/v1/auth/login", "10.5.0.1", body.clone()),
            )
            .await;
        }
        assert_eq!(
            last == StatusCode::TOO_MANY_REQUESTS,
            throttled,
            "case {case}: {last}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sec4_parallel_failures_cannot_exceed_the_allowance() {
    // (case_id, per-IP allowance, per-account allowance, parallel failing logins, admitted)
    let cases = [
        ("account_limit_holds_under_burst", 100, 3, 12, 3),
        ("ip_limit_holds_under_burst", 2, 100, 12, 2),
    ];
    for (case, per_ip, per_account, racers, admitted) in cases {
        let h = Harness::with(policy(1, per_ip, per_account));
        let app = h.app();
        let password = "Correct-Horse-Battery-9";
        let email = format!("{}@example.com", Uuid::new_v4());
        send(
            &app,
            auth_request(
                "/api/v1/auth/register",
                "10.6.0.9",
                serde_json::json!({ "email": email, "password": password, "display_name": "Racer" }),
            ),
        )
        .await;
        let attempts: Vec<_> = (0..racers)
            .map(|_| {
                let app = app.clone();
                let body = serde_json::json!({ "email": email, "password": "wrong-password" });
                tokio::spawn(async move {
                    send(&app, auth_request("/api/v1/auth/login", "10.6.0.1", body))
                        .await
                        .0
                })
            })
            .collect();
        let mut statuses = Vec::new();
        for attempt in attempts {
            statuses.push(attempt.await.unwrap());
        }
        let passed = statuses
            .iter()
            .filter(|s| **s != StatusCode::TOO_MANY_REQUESTS)
            .count();
        assert_eq!(passed, admitted, "case {case}: {statuses:?}");
    }
}

#[test]
fn sec4_import_quota_survives_auth_bucket_pruning() {
    let limiter = AuthRateLimiter::new(
        RateLimit {
            max_attempts: 1,
            window: Duration::from_millis(1),
        },
        RateLimit {
            max_attempts: 1,
            window: Duration::from_millis(1),
        },
    );
    let user = Uuid::new_v4();
    for _ in 0..limiter.imports_per_account.max_attempts {
        limiter.take_import(user).unwrap();
    }
    std::thread::sleep(Duration::from_millis(5));
    // (case_id, credential keys sprayed past MAX_TRACKED_KEYS before the next import)
    let cases = [("no_pruning", 0usize), ("pruning_triggered", 10_005)];
    for (case, sprayed) in cases {
        for i in 0..sprayed {
            let _ = limiter.try_reserve(&format!("ip:login:{case}-{i}"), limiter.per_ip);
        }
        std::thread::sleep(Duration::from_millis(5));
        let _ = limiter.try_reserve("ip:login:trigger", limiter.per_ip);
        assert!(
            limiter.take_import(user).is_err(),
            "case {case}: import quota keeps its 1 h window"
        );
    }
}

#[test]
fn sec4_totp_backoff_doubles_until_capped() {
    let backoff = TotpBackoff::default();
    // (case_id, consecutive failures, lockout)
    let cases = [
        ("no_failure", 0, Duration::ZERO),
        ("free_typos", 3, Duration::ZERO),
        ("first_lockout", 4, Duration::from_secs(2)),
        ("doubles", 5, Duration::from_secs(4)),
        ("doubles_again", 6, Duration::from_secs(8)),
        ("capped_at_15_minutes", 40, Duration::from_secs(15 * 60)),
    ];
    for (case, failures, expected) in cases {
        assert_eq!(backoff.lockout(failures), expected, "case {case}");
    }
}

#[tokio::test]
async fn sec4_client_ip_honours_trusted_proxy_hops_and_ipv6_prefixes() {
    // (case_id, trusted hops, first chain, second chain, second throttled by the first)
    let cases = [
        (
            "no_proxy_ignores_spoofed_header",
            0,
            "1.1.1.1",
            "2.2.2.2",
            true,
        ),
        (
            "one_hop_uses_rightmost_entry",
            1,
            "9.9.9.9, 1.1.1.1",
            "9.9.9.9, 2.2.2.2",
            false,
        ),
        (
            "two_hops_skip_the_inner_proxy",
            2,
            "1.1.1.1, 10.0.0.1",
            "1.1.1.1, 10.0.0.2",
            true,
        ),
        (
            "short_header_falls_back_to_peer",
            2,
            "1.1.1.1",
            "2.2.2.2",
            true,
        ),
        (
            "ipv6_same_64_shares_a_bucket",
            1,
            "2001:db8:1:2::1",
            "2001:db8:1:2:ffff::9",
            true,
        ),
        (
            "ipv6_other_64_has_its_own_bucket",
            1,
            "2001:db8:1:2::1",
            "2001:db8:1:3::1",
            false,
        ),
    ];
    for (case, hops, first, second, throttled) in cases {
        let h = Harness::with(policy(hops, 1, 100));
        let app = h.app();
        let login = |chain: &str, n: u32| {
            auth_request(
                "/api/v1/auth/login",
                chain,
                serde_json::json!({ "email": format!("ip{n}@example.com"), "password": "x" }),
            )
        };
        send(&app, login(first, 1)).await;
        let (status, _) = send(&app, login(second, 2)).await;
        assert_eq!(
            status == StatusCode::TOO_MANY_REQUESTS,
            throttled,
            "case {case}: {status}"
        );
    }
}

// ---------------------------------------------------------------------------
// SEC5 — no fallback keys, no dev secrets in production
// ---------------------------------------------------------------------------

#[test]
fn sec5_known_dev_secrets_rejected_outside_dev() {
    let master = "cd".repeat(32);
    let strong = "y".repeat(40);
    let base = |env: Option<&str>| -> Vec<(&'static str, String)> {
        let mut vars = vec![
            (MASTER_ENCRYPTION_KEY_VAR, master.clone()),
            (JWT_SECRET_VAR, strong.clone()),
            (INVITE_JWT_SECRET_VAR, strong.clone()),
            (PUBLIC_ORIGIN_VAR, "https://table.example.com".to_string()),
            (DATABASE_URL_VAR, "postgresql://trame@db/trame".to_string()),
        ];
        if let Some(env) = env {
            vars.push((TRAME_ENV_VAR, env.to_string()));
        }
        vars
    };
    let replace = |mut vars: Vec<(&'static str, String)>, key: &'static str, value: &str| {
        vars.retain(|(k, _)| *k != key);
        vars.push((key, value.to_string()));
        vars
    };

    // (case_id, vars, accepted)
    let cases = [
        ("production_strong_secrets", base(None), true),
        (
            "production_dev_master_key",
            replace(base(None), MASTER_ENCRYPTION_KEY_VAR, KNOWN_DEV_SECRETS[0]),
            false,
        ),
        (
            "production_dev_jwt_secret",
            replace(base(None), JWT_SECRET_VAR, KNOWN_DEV_SECRETS[1]),
            false,
        ),
        (
            "production_compose_default_invite_secret",
            replace(base(None), INVITE_JWT_SECRET_VAR, KNOWN_DEV_SECRETS[2]),
            false,
        ),
        (
            "production_former_fallback_key_any_case",
            replace(
                base(None),
                JWT_SECRET_VAR,
                &KNOWN_DEV_SECRETS[3].to_ascii_uppercase(),
            ),
            false,
        ),
        (
            "dev_accepts_dev_secret",
            replace(base(Some("dev")), JWT_SECRET_VAR, KNOWN_DEV_SECRETS[1]),
            true,
        ),
    ];
    for (case, vars, accepted) in cases {
        let result = ServerConfig::from_lookup(|key| {
            vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
        });
        assert_eq!(
            result.is_ok(),
            accepted,
            "case {case}: {:?}",
            result.as_ref().err()
        );
        if let Err(err) = result {
            assert!(
                err.invalid
                    .iter()
                    .any(|m| m.contains("publicly known development value")),
                "case {case}: {err:?}"
            );
        }
    }
}

#[test]
fn sec4_removed_trust_forwarded_for_aborts_startup() {
    let prod = vec![
        (MASTER_ENCRYPTION_KEY_VAR, "cd".repeat(32)),
        (JWT_SECRET_VAR, "y".repeat(40)),
        (INVITE_JWT_SECRET_VAR, "y".repeat(40)),
        (PUBLIC_ORIGIN_VAR, "https://table.example.com".to_string()),
        (DATABASE_URL_VAR, "postgresql://trame@db/trame".to_string()),
    ];
    let dev = vec![(TRAME_ENV_VAR, "dev".to_string())];
    let with_old = |mut vars: Vec<(&'static str, String)>, value: &str| {
        vars.push((REMOVED_TRUST_FORWARDED_FOR_VAR, value.to_string()));
        vars
    };
    // (case_id, vars, accepted)
    let cases = [
        ("production_without_old_variable", prod.clone(), true),
        (
            "production_old_variable_true",
            with_old(prod.clone(), "true"),
            false,
        ),
        (
            "production_old_variable_false",
            with_old(prod, "false"),
            false,
        ),
        ("dev_old_variable_true", with_old(dev, "1"), false),
    ];
    for (case, vars, accepted) in cases {
        let result = ServerConfig::from_lookup(|key| {
            vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
        });
        assert_eq!(
            result.is_ok(),
            accepted,
            "case {case}: {:?}",
            result.as_ref().err()
        );
        if let Err(err) = result {
            let message = err.to_string();
            assert!(
                message.contains(REMOVED_TRUST_FORWARDED_FOR_VAR)
                    && message.contains(TRUSTED_PROXY_HOPS_VAR),
                "case {case}: {message}"
            );
        }
    }
}

#[tokio::test]
async fn sec5_default_constructors_use_per_instance_keys() {
    let key = "instances/i/campaigns/c/assets/a.webp";
    let configured_secret = b"configured-asset-signing-secret-0123456789".to_vec();
    let signed = |store: InMemoryAssetStore| async move {
        store
            .put_asset(key, Bytes::from_static(b"x"), "image/webp")
            .await
            .unwrap();
        let url = store
            .mint_presigned_get_url(key, PRESIGNED_URL_DEFAULT_TTL)
            .await
            .unwrap();
        let param = |name: &str| -> String {
            url.split(['?', '&'])
                .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
                .unwrap()
                .to_string()
        };
        (store, param("exp").parse::<u64>().unwrap(), param("sig"))
    };
    let (signer, exp, sig) = signed(InMemoryAssetStore::with_ephemeral_secret()).await;
    let (_, cfg_exp, cfg_sig) = signed(InMemoryAssetStore::with_base_url_and_secret(
        "/assets/download",
        configured_secret.clone(),
    ))
    .await;
    let ciphertext = TotpService::default().encrypt_secret(b"totp-seed").unwrap();

    // (case_id, verifies with the minting key, verifies with a fresh instance's key)
    let cases = [
        (
            "asset_signature",
            signer.verify_presigned_get(key, exp, &sig),
            InMemoryAssetStore::with_ephemeral_secret().verify_presigned_get(key, exp, &sig),
        ),
        (
            "production_store_signs_with_configured_key",
            verify_asset_signature(&configured_secret, key, cfg_exp, &cfg_sig),
            InMemoryAssetStore::with_ephemeral_secret()
                .verify_presigned_get(key, cfg_exp, &cfg_sig),
        ),
        (
            "totp_secret_encryption",
            true,
            TotpService::default().decrypt_secret(&ciphertext).is_ok(),
        ),
    ];
    for (case, own, foreign) in cases {
        assert!(own, "case {case}: own key verifies");
        assert!(!foreign, "case {case}: another instance's key does not");
    }
}

// ---------------------------------------------------------------------------
// SEC14 — pixel area and per-campaign storage quota
// ---------------------------------------------------------------------------

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// A PNG whose header declares `width` x `height` grayscale pixels, with no pixel data.
fn png_header_only(width: u32, height: u32) -> Vec<u8> {
    let chunk = |kind: &[u8], data: &[u8]| {
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
        out
    };
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &[]));
    png.extend(chunk(b"IEND", &[]));
    png
}

fn small_png() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(8, 8, image::Rgb([40, 90, 160]));
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[tokio::test]
async fn sec14_upload_rejects_pixel_area_before_decoding() {
    // (case_id, uploader role, body, expected status, expected message fragment)
    let cases = [
        (
            "small_image_accepted",
            "GM",
            small_png(),
            StatusCode::CREATED,
            "",
        ),
        (
            "area_over_cap_with_sides_in_range",
            "GM",
            png_header_only(8193, 8193),
            StatusCode::BAD_REQUEST,
            "pixel area",
        ),
        (
            "side_over_limit",
            "GM",
            png_header_only(16_385, 1),
            StatusCode::BAD_REQUEST,
            "16384",
        ),
        (
            "player_small_image_accepted",
            "PLAYER",
            small_png(),
            StatusCode::CREATED,
            "",
        ),
        (
            "player_over_16_mpx_refused_before_decode",
            "PLAYER",
            png_header_only(4097, 4097),
            StatusCode::BAD_REQUEST,
            "16777216 pixel area",
        ),
        (
            "gm_same_canvas_passes_the_area_guard",
            "GM",
            png_header_only(4097, 4097),
            StatusCode::BAD_REQUEST,
            "decode",
        ),
    ];
    for (case, role, body, expected, fragment) in cases {
        let h = Harness::new();
        let campaign_id = Uuid::new_v4();
        let cookie = h.member(campaign_id, Some(role)).await;
        let (status, resp) = send(
            &h.app(),
            request(
                "POST",
                &format!("/api/v1/campaigns/{campaign_id}/assets"),
                Some(&cookie),
                Body::from(body),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}: {}", text(&resp));
        assert!(
            text(&resp).contains(fragment),
            "case {case}: {}",
            text(&resp)
        );
    }
}

#[tokio::test]
async fn sec14_uploads_are_rate_limited_per_account() {
    // (case_id, uploads per window, uploads sent, statuses expected in order)
    let cases = [
        (
            "third_upload_throttled",
            2,
            3,
            vec![
                StatusCode::CREATED,
                StatusCode::CREATED,
                StatusCode::TOO_MANY_REQUESTS,
            ],
        ),
        (
            "failed_decodes_count_too",
            1,
            2,
            vec![StatusCode::BAD_REQUEST, StatusCode::TOO_MANY_REQUESTS],
        ),
    ];
    for (case, allowed, sent, want) in cases {
        let mut limiter = AuthRateLimiter::default();
        limiter.uploads_per_account = RateLimit {
            max_attempts: allowed,
            window: Duration::from_secs(600),
        };
        let h = Harness::with(SecurityPolicy {
            rate_limiter: limiter,
            ..SecurityPolicy::default()
        });
        let campaign_id = Uuid::new_v4();
        let cookie = h.member(campaign_id, Some("PLAYER")).await;
        let body = if want[0] == StatusCode::CREATED {
            small_png()
        } else {
            png_header_only(4097, 4097)
        };
        let mut statuses = Vec::new();
        for _ in 0..sent {
            let (status, _) = send(
                &h.app(),
                request(
                    "POST",
                    &format!("/api/v1/campaigns/{campaign_id}/assets"),
                    Some(&cookie),
                    Body::from(body.clone()),
                ),
            )
            .await;
            statuses.push(status);
        }
        assert_eq!(statuses, want, "case {case}");
    }
}

#[tokio::test]
async fn sec14_campaign_storage_quota_is_checked_before_decoding() {
    const QUOTA: u64 = 4096;
    let png = small_png();
    // (case_id, route, bytes already stored in this campaign, in another campaign, body, status)
    let cases = [
        (
            "upload_under_quota",
            "assets",
            0,
            0,
            png.clone(),
            StatusCode::CREATED,
        ),
        (
            "stored_bytes_fill_the_quota",
            "assets",
            QUOTA - 10,
            0,
            png.clone(),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "oversized_garbage_refused_without_decoding",
            "assets",
            0,
            0,
            vec![0u8; QUOTA as usize + 1],
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "other_campaign_usage_ignored",
            "assets",
            0,
            QUOTA,
            png.clone(),
            StatusCode::CREATED,
        ),
        (
            "map_import_checked_too",
            "maps/import",
            QUOTA - 10,
            0,
            b"{\"format\":1}".to_vec(),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ];
    for (case, route, used_here, used_elsewhere, body, expected) in cases {
        let h = Harness::with(SecurityPolicy {
            campaign_asset_quota_bytes: QUOTA,
            ..SecurityPolicy::default()
        });
        let campaign_id = Uuid::new_v4();
        for (cid, used) in [(campaign_id, used_here), (Uuid::new_v4(), used_elsewhere)] {
            if used > 0 {
                h.asset_store
                    .put_asset(
                        &stored_assets::asset_key(h.state.instance_id, cid, "seed"),
                        Bytes::from(vec![0u8; used as usize]),
                        "image/webp",
                    )
                    .await
                    .unwrap();
            }
        }
        let cookie = h.member(campaign_id, Some("GM")).await;
        let (status, resp) = send(
            &h.app(),
            request(
                "POST",
                &format!("/api/v1/campaigns/{campaign_id}/{route}"),
                Some(&cookie),
                Body::from(body),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}: {}", text(&resp));
        if expected == StatusCode::PAYLOAD_TOO_LARGE {
            assert!(
                text(&resp).contains("STORAGE_QUOTA_EXCEEDED"),
                "case {case}: {}",
                text(&resp)
            );
        }
    }
}

// ---------------------------------------------------------------------------
// SEC15 — opaque server errors, health pings Postgres
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec15_server_error_details_never_reach_clients() {
    let leak = "relation \"users\" does not exist at 10.0.0.5";
    let app = Router::new()
        .route(
            "/plain",
            axum::routing::get(move || async move {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({ "code": "STORAGE_ERROR", "error": leak })),
                )
                    .into_response()
            }),
        )
        .route(
            "/rpc",
            axum::routing::get(move || async move {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({
                        "jsonrpc": "2.0",
                        "error": { "code": -32603, "message": leak, "data": leak }
                    })),
                )
                    .into_response()
            }),
        )
        .route(
            "/client",
            axum::routing::get(move || async move {
                (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({ "code": "INVALID", "error": "bad field" })),
                )
                    .into_response()
            }),
        )
        .layer(axum::middleware::from_fn(opaque_server_errors_middleware));

    // (case_id, path, expected status, expected body fragment)
    let cases = [
        (
            "json_error_message_replaced",
            "/plain",
            StatusCode::INTERNAL_SERVER_ERROR,
            "STORAGE_ERROR",
        ),
        (
            "json_rpc_message_and_data_replaced",
            "/rpc",
            StatusCode::INTERNAL_SERVER_ERROR,
            "-32603",
        ),
        (
            "client_errors_untouched",
            "/client",
            StatusCode::BAD_REQUEST,
            "bad field",
        ),
    ];
    for (case, path, expected, fragment) in cases {
        let (status, body) = send(&app, request("GET", path, None, Body::empty())).await;
        let body = text(&body);
        assert_eq!(status, expected, "case {case}");
        assert!(body.contains(fragment), "case {case}: {body}");
        assert!(!body.contains("relation"), "case {case}: {body}");
        if expected == StatusCode::INTERNAL_SERVER_ERROR {
            assert!(body.contains(GENERIC_SERVER_ERROR), "case {case}: {body}");
        }
    }
}

#[tokio::test]
async fn sec15_healthz_pings_configured_postgres() {
    let unreachable = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(500))
        .connect_lazy("postgresql://trame:x@127.0.0.1:1/trame")
        .unwrap();
    // (case_id, postgres store, expected status)
    let cases = [
        ("in_memory_storage_healthy", None, StatusCode::OK),
        (
            "unreachable_postgres_unavailable",
            Some(Arc::new(SqlxPostgresStore::new(
                unreachable,
                STRONG_SECRET.to_vec(),
            ))),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
    ];
    for (case, postgres_store, expected) in cases {
        let mut h = Harness::new();
        h.state.postgres_store = postgres_store;
        let (status, body) = send(&h.app(), request("GET", "/healthz", None, Body::empty())).await;
        assert_eq!(status, expected, "case {case}: {}", text(&body));
    }
}

// ---------------------------------------------------------------------------
// SEC1 / SEC6 / SEC16 — archive import
// ---------------------------------------------------------------------------

async fn zip_entries(manifest_paths: &[&str], entries: &[(&str, &[u8])]) -> Vec<u8> {
    let manifest = CampaignManifest::new(
        campaign_meta(Uuid::new_v4(), "Dup"),
        "2026-01-01T00:00:00Z".to_string(),
        ManifestStats::default(),
        manifest_paths
            .iter()
            .map(|path| ArchiveEntryDescriptor {
                path: path.to_string(),
                byte_size: 2,
                sha256: Sha256Hasher::digest(b"{}"),
            })
            .collect(),
    );
    let mut bytes = Vec::new();
    let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut bytes));
    let m = serde_json::to_vec(&manifest).unwrap();
    let all = std::iter::once(("manifest.json", m.as_slice())).chain(entries.iter().copied());
    for (name, data) in all {
        let mut sink = writer
            .write_entry_stream(ZipEntryBuilder::new(name.into(), Compression::Stored))
            .await
            .unwrap();
        sink.write_all(data).await.unwrap();
        sink.close().await.unwrap();
    }
    writer.close().await.unwrap();
    bytes
}

#[tokio::test]
async fn sec1_import_rejects_duplicate_entry_names() {
    // (case_id, manifest paths, zip entries)
    let cases: [(&str, Vec<&str>, Vec<(&str, &[u8])>); 2] = [
        (
            "duplicate_manifest_entry",
            vec!["database.jsonl", "database.jsonl"],
            vec![("database.jsonl", b"{}")],
        ),
        (
            "duplicate_zip_entry",
            vec!["database.jsonl"],
            vec![("database.jsonl", b"{}"), ("database.jsonl", b"{}")],
        ),
    ];
    for (case, manifest_paths, entries) in cases {
        let h = Harness::new();
        let (_, cookie) = h.account(false).await;
        let archive = zip_entries(&manifest_paths, &entries).await;
        let (status, body) = send(
            &h.app(),
            request(
                "POST",
                "/api/v1/campaigns/import",
                Some(&cookie),
                Body::from(archive),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "case {case}");
        assert!(
            text(&body).contains("duplicate"),
            "case {case}: {}",
            text(&body)
        );
    }
}

#[tokio::test]
async fn sec6_import_body_is_streamed_with_a_byte_cap() {
    const MIB: usize = 1024 * 1024;
    // (case_id, number of 1 MiB chunks, expected status)
    let cases = [
        (
            "small_garbage_reaches_the_importer",
            1,
            StatusCode::BAD_REQUEST,
        ),
        ("stream_past_64_mib_aborted", 65, StatusCode::BAD_REQUEST),
    ];
    for (case, chunks, expected) in cases {
        let h = Harness::new();
        let (_, cookie) = h.account(false).await;
        let stream = futures_util::stream::iter(
            (0..chunks).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![0u8; MIB]))),
        );
        let (status, body) = send(
            &h.app(),
            request(
                "POST",
                "/api/v1/campaigns/import",
                Some(&cookie),
                Body::from_stream(stream),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}");
        let code = if chunks > 64 {
            "INVALID_ARCHIVE_STREAM"
        } else {
            "INVALID_ARCHIVE"
        };
        assert!(text(&body).contains(code), "case {case}: {}", text(&body));
    }
}

#[tokio::test]
async fn sec6_imports_are_capped_per_account() {
    let h = Harness::new();
    let app = h.app();
    let (_, heavy) = h.account(false).await;
    let (_, other) = h.account(false).await;
    let import = |cookie: &str| {
        request(
            "POST",
            "/api/v1/campaigns/import",
            Some(cookie),
            Body::from("not a zip"),
        )
    };
    for _ in 0..10 {
        let (status, _) = send(&app, import(&heavy)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    // (case_id, account, expected status)
    let cases = [
        (
            "eleventh_import_throttled",
            &heavy,
            StatusCode::TOO_MANY_REQUESTS,
        ),
        ("other_account_unaffected", &other, StatusCode::BAD_REQUEST),
    ];
    for (case, cookie, expected) in cases {
        let (status, _) = send(&app, import(cookie)).await;
        assert_eq!(status, expected, "case {case}");
    }
}

/// Archive whose `assets/` entries are `(bytes, declared digest is correct)`, in order.
async fn legacy_asset_archive(assets: &[(&[u8], bool)]) -> (Vec<u8>, Uuid) {
    let campaign_id = Uuid::new_v4();
    let named: Vec<(String, &[u8], bool)> = assets
        .iter()
        .map(|(bytes, ok)| (format!("assets/{}.webp", Uuid::new_v4()), *bytes, *ok))
        .collect();
    let manifest = CampaignManifest::new(
        campaign_meta(campaign_id, "Legacy"),
        "2026-01-01T00:00:00Z".to_string(),
        ManifestStats::default(),
        named
            .iter()
            .map(|(path, bytes, ok)| ArchiveEntryDescriptor {
                path: path.clone(),
                byte_size: bytes.len() as u64,
                sha256: if *ok {
                    Sha256Hasher::digest(bytes)
                } else {
                    Sha256Hasher::digest(b"tampered")
                },
            })
            .collect(),
    );
    let mut out = Vec::new();
    let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut out));
    let m = serde_json::to_vec(&manifest).unwrap();
    let all = std::iter::once(("manifest.json".to_string(), m.as_slice()))
        .chain(named.iter().map(|(p, b, _)| (p.clone(), *b)));
    for (name, data) in all {
        let mut sink = writer
            .write_entry_stream(ZipEntryBuilder::new(name.into(), Compression::Stored))
            .await
            .unwrap();
        sink.write_all(data).await.unwrap();
        sink.close().await.unwrap();
    }
    writer.close().await.unwrap();
    (out, campaign_id)
}

#[tokio::test]
async fn sec16_each_legacy_asset_is_stored_as_soon_as_it_is_verified() {
    let first: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 first-map";
    let second: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 second-map";
    // (case_id, assets in archive order, import succeeds)
    let cases: [(&str, Vec<(&[u8], bool)>, bool); 2] = [
        ("all_verified", vec![(first, true), (second, true)], true),
        (
            "later_entry_tampered",
            vec![(first, true), (second, false)],
            false,
        ),
    ];
    for (case, assets, succeeds) in cases {
        let (archive, campaign_id) = legacy_asset_archive(&assets).await;
        let asset_store = Arc::new(InMemoryAssetStore::with_ephemeral_secret());
        let instance_id = Uuid::new_v4();
        let importer = ArchiveImporter::new(InMemoryCampaignStore::new(), InMemoryBlobStore::new())
            .with_asset_store(asset_store.clone(), instance_id);
        let result = importer.import_stream(Cursor::new(archive), false).await;
        assert_eq!(result.is_ok(), succeeds, "case {case}: {result:?}");
        // The first asset was written before the second was even read: nothing is held
        // back until the end of the archive.
        let key = stored_assets::asset_key(instance_id, campaign_id, &Sha256Hasher::digest(first));
        assert!(
            asset_store.get_asset(&key).await.unwrap().is_some(),
            "case {case}"
        );
    }
}

#[tokio::test]
async fn sec16_concurrent_imports_wait_for_a_free_slot() {
    let webp: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 gated-map";
    // (case_id, import slots held elsewhere, import finishes within the deadline)
    let cases = [
        ("all_slots_busy_import_waits", MAX_CONCURRENT_IMPORTS, false),
        (
            "one_slot_free_import_runs",
            MAX_CONCURRENT_IMPORTS - 1,
            true,
        ),
    ];
    for (case, held, finishes) in cases {
        let busy = ARCHIVE_IMPORT_PERMITS
            .acquire_many(held as u32)
            .await
            .unwrap();
        let (archive, _) = legacy_asset_archive(&[(webp, true)]).await;
        let importer = ArchiveImporter::new(InMemoryCampaignStore::new(), InMemoryBlobStore::new());
        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            importer.import_stream(Cursor::new(archive), false),
        )
        .await;
        assert_eq!(outcome.is_ok(), finishes, "case {case}");
        drop(busy);
    }
}

#[tokio::test]
async fn sec16_legacy_webp_assets_land_in_the_asset_store() {
    let h = Harness::new();
    let source = Uuid::new_v4();
    let webp: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 legacy-map";
    let not_webp: &[u8] = b"\x89PNG legacy";
    seed_campaign_for_export(
        &h.state,
        campaign_meta(source, "Legacy"),
        vec![ExportEntity {
            entity_type: "actor".to_string(),
            data: serde_json::json!({ "id": Uuid::new_v4(), "campaign_id": source, "name": "Hero" }),
        }],
        Vec::new(),
        vec![(Uuid::new_v4(), webp), (Uuid::new_v4(), not_webp)],
    )
    .await
    .unwrap();
    let gm = h.member(source, Some("GM")).await;
    let (status, archive) = send(
        &h.app(),
        request(
            "GET",
            &format!("/api/v1/campaigns/{source}/export"),
            Some(&gm),
            Body::empty(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let chunks: Vec<Result<Bytes, std::io::Error>> = archive
        .chunks(4096)
        .map(|c| Ok(Bytes::copy_from_slice(c)))
        .collect();
    let (status, body) = send(
        &h.app(),
        request(
            "POST",
            "/api/v1/campaigns/import",
            Some(&gm),
            Body::from_stream(futures_util::stream::iter(chunks)),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{}", text(&body));
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let new_id: Uuid = serde_json::from_value(json["campaign_id"].clone()).unwrap();

    // (case_id, legacy asset bytes, persisted in the asset store)
    let cases = [
        ("webp_persisted", webp, true),
        ("non_webp_skipped", not_webp, false),
    ];
    for (case, bytes, persisted) in cases {
        let key =
            stored_assets::asset_key(h.state.instance_id, new_id, &Sha256Hasher::digest(bytes));
        let stored = h.asset_store.get_asset(&key).await.unwrap();
        assert_eq!(stored.is_some(), persisted, "case {case}");
        if let Some(stored) = stored {
            assert_eq!(stored.as_ref(), bytes, "case {case}");
        }
    }
}

// ---------------------------------------------------------------------------
// UA8 — server-rolled death saving throws; difficult terrain reaches every client
// ---------------------------------------------------------------------------

/// Last `CommandAccepted` state in `frames`.
fn accepted_state(frames: &[ServerEnvelope]) -> &trame_server::sync::ProjectedTableState {
    frames
        .iter()
        .rev()
        .find_map(|e| match e {
            ServerEnvelope::CommandAccepted { state, .. } => Some(state),
            _ => None,
        })
        .expect("expected CommandAccepted")
}

#[tokio::test]
async fn ua8_death_save_d20_is_rolled_by_the_server_for_players() {
    struct Case {
        id: &'static str,
        as_gm: bool,
        submitted_d20: Option<u8>,
        /// `Some(d20)` when the submitted value must be used as-is (GM physical die).
        kept_d20: Option<u8>,
    }
    let cases = [
        Case {
            id: "player_value_is_ignored",
            as_gm: false,
            submitted_d20: Some(20),
            kept_d20: None,
        },
        Case {
            id: "player_without_value_gets_a_roll",
            as_gm: false,
            submitted_d20: None,
            kept_d20: None,
        },
        Case {
            id: "gm_without_value_gets_a_roll",
            as_gm: true,
            submitted_d20: None,
            kept_d20: None,
        },
        Case {
            id: "gm_physical_die_is_kept",
            as_gm: true,
            submitted_d20: Some(7),
            kept_d20: Some(7),
        },
    ];
    for c in cases {
        let player_user = Uuid::new_v4();
        let hero = Uuid::new_v4();
        let mut t = token(hero, "Hero", Some(player_user));
        t.hp = 0;
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        state.data.tokens.insert(hero, t);
        let mut table = Table::open(state, player_user).await;

        table
            .submit(
                c.as_gm,
                ClientEnvelope::SubmitCommand(Box::new(CommandSubmission {
                    command: TrameCommand::RecordDeathSave {
                        token_id: hero,
                        d20: c.submitted_d20,
                    },
                    correlation_id: None,
                })),
            )
            .await;
        let frames = Table::drain(&mut table.player.1);
        assert!(!rejected(&frames), "case {}", c.id);
        let recorded = frames
            .iter()
            .find_map(|e| match e {
                ServerEnvelope::CommandAccepted { events, .. } => {
                    events.iter().find_map(|ev| match ev {
                        TrameEvent::DeathSaveRecorded { d20, outcome, .. } => {
                            Some((*d20, *outcome))
                        }
                        _ => None,
                    })
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("case {}: DeathSaveRecorded", c.id));
        let server_rolls = rolls(&frames);
        match c.kept_d20 {
            Some(d20) => {
                assert_eq!(recorded.0, d20, "case {}", c.id);
                assert!(server_rolls.is_empty(), "case {}: no server roll", c.id);
            }
            None => {
                assert_eq!(server_rolls.len(), 1, "case {}: {server_rolls:?}", c.id);
                let (reason, expression, total) = &server_rolls[0];
                assert_eq!(reason, "Death Saving Throw: Hero", "case {}", c.id);
                assert_eq!(expression, "1d20", "case {}", c.id);
                assert_eq!(*total, Some(i32::from(recorded.0)), "case {}", c.id);
            }
        }
        let projected = &accepted_state(&frames).tokens[&hero];
        let expected = trame_engine::resolve_death_save(0, 0, recorded.0);
        assert_eq!(
            (
                projected.death_save_successes,
                projected.death_save_failures,
                projected.is_stable
            ),
            (expected.successes, expected.failures, expected.stable),
            "case {}",
            c.id
        );
    }
}

#[tokio::test]
async fn gm_rolled_death_save_reaches_the_controller_on_every_path() {
    // (case_id, through `dispatch_batch` (the MCP path), token hidden from its controller so
    // the roll is GM-only)
    let cases = [
        ("single_command_visible_token", false, false),
        ("single_command_hidden_token", false, true),
        ("batch_visible_token", true, false),
        ("batch_hidden_token", true, true),
    ];
    for (case, batched, hidden) in cases {
        let player_user = Uuid::new_v4();
        let hero = Uuid::new_v4();
        let mut t = token(hero, "Hero", Some(player_user));
        t.hp = 0;
        if hidden {
            t.visibility_channel |= trame_engine::geometry::CHANNEL_GM_HIDDEN;
        }
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        state.data.tokens.insert(hero, t);
        let mut table = Table::open(state, player_user).await;
        let command = TrameCommand::RecordDeathSave {
            token_id: hero,
            d20: None,
        };
        if batched {
            let gm = trame_engine::commands::CommandActor {
                user_id: Uuid::new_v4(),
                role: CampaignRole::Gm,
            };
            let result = table
                .room
                .dispatch_batch(gm, vec![command], "MCP death save".to_string())
                .await;
            assert!(result.is_ok(), "case {case}: {result:?}");
        } else {
            table.command(command).await;
        }
        let player_rolls = rolls(&Table::drain(&mut table.player.1));
        let gm_rolls = rolls(&Table::drain(&mut table.gm.1));
        assert_eq!(gm_rolls.len(), 1, "case {case}: GM roll {gm_rolls:?}");
        assert_eq!(player_rolls.len(), 1, "case {case}: controller roll");
        assert_eq!(player_rolls[0].2, gm_rolls[0].2, "case {case}: same total");
        assert_eq!(player_rolls[0].0, "Death Saving Throw: Hero", "case {case}");
    }
}

#[tokio::test]
async fn ua8_difficult_terrain_is_projected_to_players() {
    let player_user = Uuid::new_v4();
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    state.data.map_width_px = 1000;
    state.data.map_height_px = 1000;
    let mut table = Table::open(state, player_user).await;
    let cells = vec![
        trame_engine::aoe::GridCell { col: 1, row: 2 },
        trame_engine::aoe::GridCell { col: 3, row: 4 },
    ];
    table
        .command(TrameCommand::SetDifficultTerrain {
            cells: cells.clone(),
            difficult: true,
        })
        .await;
    let frames = Table::drain(&mut table.player.1);
    assert_eq!(accepted_state(&frames).difficult_terrain, cells);
}
