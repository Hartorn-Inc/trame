#![allow(clippy::doc_lazy_continuation)]

//! ============================================================================
//! S2 SECURITY & PRIVACY REJECTION SUITE (security_s2_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Proves every S2 rule at the server seam: HTTP rules through the full
//!   Axum router (`build_router_with_state`), WebSocket rules through a real
//!   TCP listener, and table privacy rules through the `TableRoomActor` that
//!   the WebSocket handler feeds.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Each rule is a parametrized table of `(case_id, input, expected)`.
//!   - No test relies on `?user_id=`: identity comes only from session cookies.
//!   - Rate-limit cases use `X-Forwarded-For` with `trusted_proxy_hops = 1` so IP
//!     buckets can be exercised through `oneshot`.
//!
//! COVERAGE:
//!   A22 config, A23 dice caps, A24/A68 damage authority, A60 zip-bomb caps,
//!   A61 export scoping, A62 timeline, A63 identity & roles, A64-A67 player
//!   projection, A69 presign, A70 WebSocket hardening, A71 rate limits,
//!   A72 cookie `Secure`, A73 security headers, A74 import, invite route.
//! ============================================================================

use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use bytes::Bytes;
use futures_lite::io::AsyncWriteExt as _;
use std::collections::BTreeMap;
use std::io::Cursor;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tower::ServiceExt;
use trame_engine::commands::{
    CampaignRole, TableMode, TableState, TokenState, TrameCommand, TrameEvent,
};
use trame_engine::geometry::{CHANNEL_GM_HIDDEN, Point2D, WallKind, WallSegment};
use trame_engine::rules::DamageAffinity;
use trame_server::archive::{
    ArchiveEntryDescriptor, ArchiveImporter, CampaignManifest, CampaignMetadata, ExportEntity,
    InMemoryCampaignStore, ManifestStats, NoteRecord,
};
use trame_server::assets::store::{AssetStore, InMemoryAssetStore};
use trame_server::auth::accounts::InstanceRole;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{
    AuthState, IdentityStore, InMemorySessionStore, SessionStore, UserRecord, build_auth_router,
    hash_session_token,
};
use trame_server::auth::totp::TotpService;
use trame_server::config::{
    ALLOWED_ORIGINS_VAR, BOOTSTRAP_OWNER_EMAIL_VAR, COOKIE_SECURE_VAR, ConfigError,
    DATABASE_URL_ALIAS_VAR, DATABASE_URL_VAR, INSTANCE_ID_VAR, INVITE_JWT_SECRET_VAR,
    JWT_SECRET_VAR, LogFormat, MASTER_ENCRYPTION_KEY_VAR, PUBLIC_ORIGIN_VAR, RuntimeEnv,
    ServerConfig, TRAME_ENV_VAR,
};
use trame_server::dice::RollVisibility;
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
    seed_campaign_for_export,
};
use trame_server::maps::InMemoryMapStorage;
use trame_server::room::{ConnectedClient, OutboundClientFrame, RoomLeaseManager, TableRoomHandle};
use trame_server::security::{AuthRateLimiter, RateLimit, SecurityPolicy};
use trame_server::sync::{BloodiedState, ClientEnvelope, ServerEnvelope};
use trame_server::timeline::{AppendEventInput, InMemoryTimelineStorage, TimelineStorage};
use trame_server::wal::{InMemoryWalStorage, TableStateSnapshot, WalStorage};
use uuid::Uuid;

const STRONG_SECRET: &[u8] = b"s2-test-invite-secret-at-least-32-bytes!";
const ALLOWED_ORIGIN: &str = "https://table.example.com";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    state: AppState,
    membership: Arc<InMemoryMembershipValidator>,
    timeline: Arc<InMemoryTimelineStorage>,
    asset_store: Arc<InMemoryAssetStore>,
    wal: Arc<InMemoryWalStorage>,
}

impl Harness {
    fn new() -> Self {
        Self::with(SecurityPolicy::default(), STRONG_SECRET)
    }

    fn with(policy: SecurityPolicy, invite_secret: &[u8]) -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let membership = Arc::new(InMemoryMembershipValidator::new());
        let timeline = Arc::new(InMemoryTimelineStorage::new());
        let asset_store = Arc::new(InMemoryAssetStore::with_ephemeral_secret());
        let auth_state = AuthState::with_security(
            Arc::new(MagicLinkService::new(invite_secret.to_vec(), "trame-test")),
            Arc::new(InMemorySessionStore::new()),
            Arc::new(TotpService::default()),
            Arc::new(policy),
        );
        let state = AppState {
            lease_manager: Arc::new(RoomLeaseManager::new(wal.clone(), 25, 900_000)),
            asset_store: asset_store.clone(),
            membership: membership.clone(),
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
            membership,
            timeline,
            asset_store,
            wal,
        }
    }

    fn app(&self) -> Router {
        build_router_with_state(self.state.clone())
    }

    /// Creates an account (`role` is the global role, which must grant nothing) with a live
    /// session and returns `(user_id, cookie_header)`. Non-guests are `Host` (may create
    /// campaigns); guests are `Member`.
    async fn account(&self, is_guest: bool, global_role: &str) -> (Uuid, String) {
        let user_id = Uuid::new_v4();
        let store = &self.state.auth_state.session_store;
        store
            .save_user(UserRecord {
                id: user_id,
                username: format!("user-{user_id}"),
                role: global_role.to_string(),
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
        let token = format!("s2-session-{user_id}");
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
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Bytes) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, headers, body)
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

fn campaign_meta(id: Uuid, name: &str) -> CampaignMetadata {
    CampaignMetadata {
        id,
        name: name.to_string(),
        system: "dnd5e".to_string(),
        description: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

fn note(title: &str) -> NoteRecord {
    NoteRecord {
        id: Uuid::new_v4(),
        title: title.to_string(),
        folder: None,
        author_id: Uuid::new_v4(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        content_markdown: format!("{title} body"),
    }
}

fn actor_entity(campaign_id: Uuid, name: &str) -> ExportEntity {
    ExportEntity {
        entity_type: "actor".to_string(),
        data: serde_json::json!({ "id": Uuid::new_v4(), "campaign_id": campaign_id, "name": name }),
    }
}

// ---------------------------------------------------------------------------
// A22 — fail-closed secrets
// ---------------------------------------------------------------------------

#[test]
fn a22_log_format_follows_trame_env() {
    // (case_id, TRAME_ENV value, expected env, expected log format)
    let cases = [
        (
            "dev_is_pretty",
            Some("dev"),
            RuntimeEnv::Dev,
            LogFormat::Pretty,
        ),
        (
            "dev_any_case_padded",
            Some("  DEV "),
            RuntimeEnv::Dev,
            LogFormat::Pretty,
        ),
        (
            "unset_is_production_json",
            None,
            RuntimeEnv::Production,
            LogFormat::Json,
        ),
        (
            "empty_is_production_json",
            Some(""),
            RuntimeEnv::Production,
            LogFormat::Json,
        ),
        (
            "production_is_json",
            Some("production"),
            RuntimeEnv::Production,
            LogFormat::Json,
        ),
        (
            "other_value_is_json",
            Some("staging"),
            RuntimeEnv::Production,
            LogFormat::Json,
        ),
    ];
    for (case, value, env, format) in cases {
        let resolved = RuntimeEnv::from_value(value);
        assert_eq!(resolved, env, "case {case}");
        assert_eq!(resolved.log_format(), format, "case {case}");
    }
}

#[test]
fn a22_config_fails_closed_outside_dev() {
    let master = "ab".repeat(32);
    let strong = "x".repeat(32);
    let full: Vec<(&'static str, String)> = vec![
        (MASTER_ENCRYPTION_KEY_VAR, master.clone()),
        (JWT_SECRET_VAR, strong.clone()),
        (INVITE_JWT_SECRET_VAR, strong.clone()),
        (PUBLIC_ORIGIN_VAR, ALLOWED_ORIGIN.to_string()),
        (DATABASE_URL_VAR, "postgresql://trame@db/trame".to_string()),
    ];
    let without = |skip: &'static str| -> Vec<(&'static str, String)> {
        full.iter().filter(|(k, _)| *k != skip).cloned().collect()
    };
    let with = |key: &'static str, value: &'static str| -> Vec<(&'static str, String)> {
        let mut vars: Vec<(&'static str, String)> =
            full.iter().filter(|(k, _)| *k != key).cloned().collect();
        vars.push((key, value.to_string()));
        vars
    };

    // (case_id, vars, expected missing, expected invalid count)
    let cases: Vec<(&str, Vec<(&str, String)>, Vec<&str>, usize)> = vec![
        (
            "prod_nothing_set_lists_every_missing_var",
            vec![],
            vec![
                MASTER_ENCRYPTION_KEY_VAR,
                JWT_SECRET_VAR,
                INVITE_JWT_SECRET_VAR,
                PUBLIC_ORIGIN_VAR,
                DATABASE_URL_VAR,
            ],
            0,
        ),
        (
            "prod_missing_database_url_refuses_in_memory_store",
            without(DATABASE_URL_VAR),
            vec![DATABASE_URL_VAR],
            0,
        ),
        (
            "prod_malformed_instance_id",
            with(INSTANCE_ID_VAR, "not-a-uuid"),
            vec![],
            1,
        ),
        (
            "prod_malformed_bootstrap_owner_email",
            with(BOOTSTRAP_OWNER_EMAIL_VAR, "nobody"),
            vec![],
            1,
        ),
        (
            "prod_missing_master_key",
            without(MASTER_ENCRYPTION_KEY_VAR),
            vec![MASTER_ENCRYPTION_KEY_VAR],
            0,
        ),
        (
            "prod_missing_invite_secret",
            without(INVITE_JWT_SECRET_VAR),
            vec![INVITE_JWT_SECRET_VAR],
            0,
        ),
        (
            "prod_missing_public_origin",
            without(PUBLIC_ORIGIN_VAR),
            vec![PUBLIC_ORIGIN_VAR],
            0,
        ),
        (
            "prod_short_jwt_secret",
            with(JWT_SECRET_VAR, "too-short"),
            vec![],
            1,
        ),
        (
            "prod_malformed_master_key",
            with(MASTER_ENCRYPTION_KEY_VAR, "not-hex"),
            vec![],
            1,
        ),
        (
            "dev_still_validates_provided_secret",
            vec![
                (TRAME_ENV_VAR, "dev".to_string()),
                (INVITE_JWT_SECRET_VAR, "short".to_string()),
            ],
            vec![],
            1,
        ),
    ];

    for (case, vars, missing, invalid) in cases {
        let lookup = |key: &str| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone());
        let Err(ConfigError {
            missing: got_missing,
            invalid: got_invalid,
        }) = ServerConfig::from_lookup(lookup)
        else {
            panic!("case {case}: expected ConfigError");
        };
        assert_eq!(got_missing, missing, "case {case}");
        assert_eq!(got_invalid.len(), invalid, "case {case}");
    }
}

#[test]
fn a22_a72_config_accepts_dev_and_complete_production() {
    let master = "ab".repeat(32);
    let strong = "x".repeat(32);
    // (case_id, vars, env, cookie_secure, origin allowed)
    let cases: Vec<(&str, Vec<(&str, String)>, RuntimeEnv, bool, &str)> = vec![
        (
            "dev_defaults_secure_cookie_and_vite_origin",
            vec![(TRAME_ENV_VAR, "dev".to_string())],
            RuntimeEnv::Dev,
            true,
            "http://localhost:5173",
        ),
        (
            "prod_complete_with_extra_origin_and_plain_http_toggle",
            vec![
                (MASTER_ENCRYPTION_KEY_VAR, master.clone()),
                (JWT_SECRET_VAR, strong.clone()),
                (INVITE_JWT_SECRET_VAR, strong.clone()),
                (PUBLIC_ORIGIN_VAR, ALLOWED_ORIGIN.to_string()),
                (ALLOWED_ORIGINS_VAR, "http://192.168.1.10:8080".to_string()),
                (COOKIE_SECURE_VAR, "false".to_string()),
                (DATABASE_URL_VAR, "postgresql://trame@db/trame".to_string()),
            ],
            RuntimeEnv::Production,
            false,
            "http://192.168.1.10:8080",
        ),
    ];
    for (case, vars, env, cookie_secure, origin) in cases {
        let config = ServerConfig::from_lookup(|key| {
            vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
        })
        .unwrap_or_else(|e| panic!("case {case}: {e}"));
        assert_eq!(config.env, env, "case {case}");
        assert_eq!(config.security.cookie_secure, cookie_secure, "case {case}");
        assert!(
            config.security.is_origin_allowed(Some(origin)),
            "case {case}"
        );
        assert!(
            !config
                .security
                .is_origin_allowed(Some("https://evil.example")),
            "case {case}"
        );
    }
}

#[test]
fn sec10_sec11_sec12_config_resolves_accounts_settings() {
    let instance_id = Uuid::new_v4();
    let prod = |extra: Vec<(&'static str, String)>| -> Vec<(&'static str, String)> {
        let mut vars = vec![
            (MASTER_ENCRYPTION_KEY_VAR, "ab".repeat(32)),
            (JWT_SECRET_VAR, "x".repeat(32)),
            (INVITE_JWT_SECRET_VAR, "x".repeat(32)),
            (PUBLIC_ORIGIN_VAR, ALLOWED_ORIGIN.to_string()),
        ];
        vars.extend(extra);
        vars
    };
    // (case_id, vars, registration_open, database_url, instance_id_override, locked email)
    type Case = (
        &'static str,
        Vec<(&'static str, String)>,
        bool,
        Option<&'static str>,
        Option<Uuid>,
        Option<&'static str>,
    );
    let cases: Vec<Case> = vec![
        (
            "dev_without_database_keeps_registration_open",
            vec![(TRAME_ENV_VAR, "dev".to_string())],
            true,
            None,
            None,
            None,
        ),
        (
            "prod_closes_registration",
            prod(vec![(DATABASE_URL_VAR, "postgresql://a/b".to_string())]),
            false,
            Some("postgresql://a/b"),
            None,
            None,
        ),
        (
            "prod_accepts_database_url_alias",
            prod(vec![(
                DATABASE_URL_ALIAS_VAR,
                "postgresql://c/d".to_string(),
            )]),
            false,
            Some("postgresql://c/d"),
            None,
            None,
        ),
        (
            "prod_instance_id_override_and_normalized_locked_email",
            prod(vec![
                (DATABASE_URL_VAR, "postgresql://a/b".to_string()),
                (INSTANCE_ID_VAR, instance_id.to_string()),
                (
                    BOOTSTRAP_OWNER_EMAIL_VAR,
                    "  Owner@Example.COM ".to_string(),
                ),
            ]),
            false,
            Some("postgresql://a/b"),
            Some(instance_id),
            Some("owner@example.com"),
        ),
    ];
    for (case, vars, registration_open, database_url, override_id, locked) in cases {
        let config = ServerConfig::from_lookup(|key| {
            vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
        })
        .unwrap_or_else(|e| panic!("case {case}: {e}"));
        assert_eq!(
            config.security.registration_open, registration_open,
            "case {case}"
        );
        assert_eq!(config.database_url.as_deref(), database_url, "case {case}");
        assert_eq!(config.instance_id_override, override_id, "case {case}");
        assert_eq!(
            config.security.bootstrap_owner_email.as_deref(),
            locked,
            "case {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// A63 — query identity removed, global role grants nothing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a63_query_parameter_identity_is_ignored() {
    let h = Harness::new();
    let app = h.app();
    let campaign_id = Uuid::new_v4();
    let (gm_id, _) = h.account(false, "PLAYER").await;
    h.join(campaign_id, gm_id, "GM").await;
    h.membership.add_gm(campaign_id, gm_id);
    let hash = "ab".repeat(32);

    let cases = [
        (
            "presign_user_id_query",
            "GET",
            format!("/api/v1/campaigns/{campaign_id}/assets/{hash}/presign?user_id={gm_id}"),
            String::new(),
        ),
        (
            "export_user_id_query",
            "GET",
            format!("/api/v1/campaigns/{campaign_id}/export?user_id={gm_id}"),
            String::new(),
        ),
        (
            "timeline_user_id_query",
            "GET",
            format!("/api/v1/campaigns/{campaign_id}/sessions/1/timeline?user_id={gm_id}"),
            String::new(),
        ),
        (
            "invite_user_id_query_and_body",
            "POST",
            format!("/api/v1/campaigns/{campaign_id}/invites?user_id={gm_id}"),
            serde_json::json!({ "user_id": gm_id }).to_string(),
        ),
        (
            "import_user_id_query",
            "POST",
            format!("/api/v1/campaigns/import?user_id={gm_id}&remap_ids=false"),
            String::new(),
        ),
        (
            "maps_user_id_query",
            "GET",
            format!("/api/v1/campaigns/{campaign_id}/maps?user_id={gm_id}"),
            String::new(),
        ),
    ];
    for (case, method, uri, body) in cases {
        let (status, _, _) = send(&app, request(method, &uri, None, Body::from(body))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "case {case}");
    }
}

#[tokio::test]
async fn a63_global_role_grants_no_campaign_privilege() {
    let h = Harness::new();
    let app = h.app();
    let campaign_id = Uuid::new_v4();
    let (_, global_gm_cookie) = h.account(false, "GM").await;

    let cases = [
        (
            "invite_mint",
            "POST",
            format!("/api/v1/campaigns/{campaign_id}/invites"),
        ),
        (
            "export",
            "GET",
            format!("/api/v1/campaigns/{campaign_id}/export"),
        ),
        (
            "timeline",
            "GET",
            format!("/api/v1/campaigns/{campaign_id}/sessions/1/timeline"),
        ),
    ];
    for (case, method, uri) in cases {
        let (status, _, _) = send(
            &app,
            request(method, &uri, Some(&global_gm_cookie), Body::empty()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "case {case}");
    }
}

#[tokio::test]
async fn a63_registration_defaults_global_role_to_player() {
    let h = Harness::new();
    let body = serde_json::json!({
        "email": "new-gm@example.com",
        "display_name": "New GM",
        "password": "correct-horse-battery-staple-42",
    });
    let (status, _, bytes) = send(
        &h.app(),
        request(
            "POST",
            "/api/v1/auth/register",
            None,
            Body::from(body.to_string()),
        ),
    )
    .await;
    assert!(status.is_success(), "register failed: {status}");
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["user"]["role"], "PLAYER");
    assert_eq!(json["user"]["instance_role"], "MEMBER");
}

// ---------------------------------------------------------------------------
// Single invite minting route
// ---------------------------------------------------------------------------

#[tokio::test]
async fn invite_route_requires_campaign_gm() {
    let h = Harness::new();
    let campaign_id = Uuid::new_v4();

    // (case_id, role in campaign (None = outsider / unauthenticated), authenticated, expected)
    let cases: Vec<(&str, Option<&str>, bool, StatusCode)> = vec![
        ("unauthenticated", None, false, StatusCode::UNAUTHORIZED),
        ("outsider", None, true, StatusCode::FORBIDDEN),
        ("player_member", Some("PLAYER"), true, StatusCode::FORBIDDEN),
        (
            "spectator_member",
            Some("SPECTATOR"),
            true,
            StatusCode::FORBIDDEN,
        ),
        ("gm_success", Some("GM"), true, StatusCode::CREATED),
    ];
    for (case, role, authenticated, expected) in cases {
        let (user_id, cookie) = h.account(false, "PLAYER").await;
        if let Some(role) = role {
            h.join(campaign_id, user_id, role).await;
        }
        let (status, _, _) = send(
            &h.app(),
            request(
                "POST",
                &format!("/api/v1/campaigns/{campaign_id}/invites"),
                authenticated.then_some(cookie.as_str()),
                Body::from(r#"{"max_uses":4}"#),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}");
    }
}

#[tokio::test]
async fn invite_legacy_routes_are_gone_from_full_router() {
    let h = Harness::new();
    let (gm_id, cookie) = h.account(false, "GM").await;
    let campaign_id = Uuid::new_v4();
    h.join(campaign_id, gm_id, "GM").await;
    let body = serde_json::json!({ "campaign_id": campaign_id }).to_string();
    for (case, uri) in [
        ("auth_invites", "/api/v1/auth/invites"),
        ("magic_link_mint", "/api/v1/auth/magic-link/mint"),
        ("magic_link_guest_session", "/api/v1/auth/magic-link"),
        (
            "magic_link_redeem_guest_session",
            "/api/v1/auth/magic-link/redeem",
        ),
    ] {
        let (status, _, _) = send(
            &h.app(),
            request("POST", uri, Some(&cookie), Body::from(body.clone())),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A69 — presign checks the authoritative store
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a69_presign_requires_session_and_authoritative_membership() {
    let h = Harness::new();
    let app = h.app();
    let campaign_id = Uuid::new_v4();
    let hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let missing = "0".repeat(64);
    for suffix in ["", "_thumb"] {
        let key = format!(
            "instances/{}/campaigns/{campaign_id}/assets/{hash}{suffix}.webp",
            h.state.instance_id
        );
        h.asset_store
            .put_asset(&key, Bytes::from_static(b"WEBP"), "image/webp")
            .await
            .unwrap();
    }
    let (member_id, member_cookie) = h.account(false, "PLAYER").await;
    h.join(campaign_id, member_id, "PLAYER").await;
    let (_, outsider_cookie) = h.account(false, "GM").await;

    let cases = [
        (
            "unauthenticated",
            None,
            hash.to_string(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "outsider_with_global_gm_role",
            Some(outsider_cookie.as_str()),
            hash.to_string(),
            StatusCode::FORBIDDEN,
        ),
        (
            "member_from_session_store_only",
            Some(member_cookie.as_str()),
            hash.to_string(),
            StatusCode::OK,
        ),
        (
            "member_thumbnail",
            Some(member_cookie.as_str()),
            format!("{hash}_thumb"),
            StatusCode::OK,
        ),
        (
            "member_missing_asset",
            Some(member_cookie.as_str()),
            missing,
            StatusCode::NOT_FOUND,
        ),
        (
            "member_traversal_hash",
            Some(member_cookie.as_str()),
            "invalid..traversal".to_string(),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (case, cookie, asset, expected) in cases {
        let (status, _, _) = send(
            &app,
            request(
                "GET",
                &format!("/api/v1/campaigns/{campaign_id}/assets/{asset}/presign"),
                cookie,
                Body::empty(),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A62 — timeline
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a62_timeline_requires_membership_filters_gm_events_and_caps_limit() {
    let h = Harness::new();
    let app = h.app();
    let campaign_id = Uuid::new_v4();
    let key = campaign_id.to_string();
    h.timeline
        .append_event(
            &key,
            1,
            AppendEventInput {
                event_type: "GmNote".to_string(),
                actor_id: None,
                payload: serde_json::json!({ "visibility": "gm_only", "text": "ambush" }),
                timestamp: Some(1),
            },
        )
        .unwrap();
    for i in 0..250 {
        h.timeline
            .append_event(
                &key,
                1,
                AppendEventInput {
                    event_type: "dice_roll".to_string(),
                    actor_id: None,
                    payload: serde_json::json!({ "n": i }),
                    timestamp: Some(2 + i),
                },
            )
            .unwrap();
    }
    let (gm_id, gm_cookie) = h.account(false, "PLAYER").await;
    h.join(campaign_id, gm_id, "GM").await;
    let (player_id, player_cookie) = h.account(false, "PLAYER").await;
    h.join(campaign_id, player_id, "PLAYER").await;
    let (_, outsider_cookie) = h.account(false, "GM").await;

    // (case_id, cookie, query, expected status, expected event count, gm event visible)
    let cases = [
        (
            "unauthenticated",
            None,
            "",
            StatusCode::UNAUTHORIZED,
            0,
            false,
        ),
        (
            "outsider",
            Some(outsider_cookie.as_str()),
            "",
            StatusCode::FORBIDDEN,
            0,
            false,
        ),
        (
            "gm_limit_clamped_to_200",
            Some(gm_cookie.as_str()),
            "?limit=100000",
            StatusCode::OK,
            200,
            true,
        ),
        (
            "player_gm_only_event_hidden",
            Some(player_cookie.as_str()),
            "?limit=10",
            StatusCode::OK,
            9,
            false,
        ),
    ];
    for (case, cookie, query, expected, count, gm_visible) in cases {
        let (status, _, body) = send(
            &app,
            request(
                "GET",
                &format!("/api/v1/campaigns/{campaign_id}/sessions/1/timeline{query}"),
                cookie,
                Body::empty(),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}");
        if status != StatusCode::OK {
            continue;
        }
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let events = json["events"].as_array().unwrap();
        assert_eq!(events.len(), count, "case {case}");
        let has_gm = events.iter().any(|e| e["event_type"] == "GmNote");
        assert_eq!(has_gm, gm_visible, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A61 / A74 / A60 — archive export, import, zip-bomb caps
// ---------------------------------------------------------------------------

async fn export_bytes(h: &Harness, campaign_id: Uuid, cookie: &str) -> (StatusCode, Bytes) {
    let (status, _, body) = send(
        &h.app(),
        request(
            "GET",
            &format!("/api/v1/campaigns/{campaign_id}/export"),
            Some(cookie),
            Body::empty(),
        ),
    )
    .await;
    (status, body)
}

#[tokio::test]
async fn a61_export_contains_only_the_requested_campaign() {
    let h = Harness::new();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    let (asset_a, asset_b) = (Uuid::new_v4(), Uuid::new_v4());
    seed_campaign_for_export(
        &h.state,
        campaign_meta(a, "Alpha"),
        vec![actor_entity(a, "Alpha Hero")],
        vec![note("Alpha Secret")],
        vec![(asset_a, b"alpha-asset".as_slice())],
    )
    .await
    .unwrap();
    seed_campaign_for_export(
        &h.state,
        campaign_meta(b, "Bravo"),
        vec![actor_entity(b, "Bravo Villain")],
        vec![note("Bravo Secret")],
        vec![(asset_b, b"bravo-asset".as_slice())],
    )
    .await
    .unwrap();
    let (gm_id, cookie) = h.account(false, "PLAYER").await;
    h.join(a, gm_id, "GM").await;

    let (status, archive) = export_bytes(&h, a, &cookie).await;
    assert_eq!(status, StatusCode::OK);

    let target = InMemoryCampaignStore::new();
    let result = ArchiveImporter::new(target.clone(), InMemoryBlobStore::new())
        .import_stream(Cursor::new(archive.to_vec()), true)
        .await
        .unwrap();
    assert_eq!(result.assets_restored, 1);
    let notes: Vec<String> = target.all_notes().into_iter().map(|n| n.title).collect();
    assert_eq!(notes, vec!["Alpha Secret".to_string()]);
    let names: Vec<String> = target
        .all_entities()
        .iter()
        .filter_map(|e| e.data["name"].as_str().map(str::to_string))
        .collect();
    assert!(names.contains(&"Alpha Hero".to_string()));
    assert!(!names.contains(&"Bravo Villain".to_string()));

    let (status, _) = export_bytes(&h, b, &cookie).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "GM of A cannot export B");
}

#[tokio::test]
async fn a74_import_creates_new_campaign_owned_by_non_guest_caller() {
    let h = Harness::new();
    let source = Uuid::new_v4();
    seed_campaign_for_export(
        &h.state,
        campaign_meta(source, "Source"),
        vec![actor_entity(source, "Hero")],
        vec![],
        vec![],
    )
    .await
    .unwrap();
    let (gm_id, gm_cookie) = h.account(false, "PLAYER").await;
    h.join(source, gm_id, "GM").await;
    let (_, archive) = export_bytes(&h, source, &gm_cookie).await;
    let (_, guest_cookie) = h.account(true, "PLAYER").await;
    let (importer_id, importer_cookie) = h.account(false, "PLAYER").await;

    let rejections = [
        ("unauthenticated", None, StatusCode::UNAUTHORIZED),
        (
            "guest_account",
            Some(guest_cookie.as_str()),
            StatusCode::FORBIDDEN,
        ),
    ];
    for (case, cookie, expected) in rejections {
        let (status, _, _) = send(
            &h.app(),
            request(
                "POST",
                "/api/v1/campaigns/import",
                cookie,
                Body::from(archive.clone()),
            ),
        )
        .await;
        assert_eq!(status, expected, "case {case}");
    }

    // `remap_ids=false` is ignored: the same archive never overwrites the source campaign.
    let (status, _, body) = send(
        &h.app(),
        request(
            "POST",
            "/api/v1/campaigns/import?remap_ids=false",
            Some(&importer_cookie),
            Body::from(archive.clone()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let new_id: Uuid = serde_json::from_value(json["campaign_id"].clone()).unwrap();
    assert_ne!(new_id, source);
    assert!(h.state.campaign_store.get_campaign(&source).is_some());

    let member = h
        .state
        .auth_state
        .session_store
        .get_campaign_member(new_id, importer_id)
        .await
        .unwrap()
        .expect("caller is a member of the imported campaign");
    assert_eq!(member.role, "GM");
    assert!(
        h.state
            .auth_state
            .session_store
            .get_campaign_member(new_id, gm_id)
            .await
            .unwrap()
            .is_none(),
        "the source GM gains nothing on the imported copy"
    );
}

async fn zip_with_database(declared_size: u64, actual: &[u8]) -> Vec<u8> {
    let manifest = CampaignManifest::new(
        campaign_meta(Uuid::new_v4(), "Bomb"),
        "2026-01-01T00:00:00Z".to_string(),
        ManifestStats::default(),
        vec![ArchiveEntryDescriptor {
            path: "database.jsonl".to_string(),
            byte_size: declared_size,
            sha256: "0".repeat(64),
        }],
    );
    let mut bytes = Vec::new();
    let mut writer = ZipFileWriter::with_tokio(Cursor::new(&mut bytes));
    let m = serde_json::to_vec(&manifest).unwrap();
    let mut sink = writer
        .write_entry_stream(ZipEntryBuilder::new(
            "manifest.json".into(),
            Compression::Stored,
        ))
        .await
        .unwrap();
    sink.write_all(&m).await.unwrap();
    sink.close().await.unwrap();
    let mut sink = writer
        .write_entry_stream(ZipEntryBuilder::new(
            "database.jsonl".into(),
            Compression::Deflate,
        ))
        .await
        .unwrap();
    sink.write_all(actual).await.unwrap();
    sink.close().await.unwrap();
    writer.close().await.unwrap();
    bytes
}

#[tokio::test]
async fn a60_import_rejects_zip_bombs_with_400() {
    let h = Harness::new();
    let (_, cookie) = h.account(false, "PLAYER").await;
    let zeros = vec![0u8; 4 * 1024 * 1024];
    let cases = [
        (
            "entry_inflates_past_declared_size",
            zip_with_database(16, &zeros).await,
        ),
        (
            "declared_size_above_text_entry_cap",
            zip_with_database(u64::MAX / 2, b"{}").await,
        ),
    ];
    for (case, archive) in cases {
        let (status, _, body) = send(
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
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("INVALID_ARCHIVE"), "case {case}: {text}");
    }
}

// ---------------------------------------------------------------------------
// A71 / A72 / A73 — auth rate limits, cookie flag, headers
// ---------------------------------------------------------------------------

fn limited_policy() -> SecurityPolicy {
    SecurityPolicy {
        trusted_proxy_hops: 1,
        rate_limiter: AuthRateLimiter::new(
            RateLimit {
                max_attempts: 3,
                window: Duration::from_secs(60),
            },
            RateLimit {
                max_attempts: 2,
                window: Duration::from_secs(60),
            },
        ),
        ..SecurityPolicy::default()
    }
}

#[tokio::test]
async fn a71_auth_routes_are_rate_limited_per_ip_and_per_account() {
    // (case_id, uri, per-attempt (ip, body) list; the last attempt must be 429)
    type Attempt = (&'static str, serde_json::Value);
    let cases: Vec<(&str, &str, Vec<Attempt>)> = vec![
        (
            "login_per_account_across_ips",
            "/api/v1/auth/login",
            (0..3)
                .map(|i| {
                    (
                        ["10.0.0.1", "10.0.0.2", "10.0.0.3"][i],
                        serde_json::json!({ "email": "victim@example.com", "password": "nope" }),
                    )
                })
                .collect(),
        ),
        (
            "login_per_ip_across_accounts",
            "/api/v1/auth/login",
            (0..4)
                .map(|i| {
                    (
                        "10.0.0.9",
                        serde_json::json!({ "email": format!("u{i}@example.com"), "password": "x" }),
                    )
                })
                .collect(),
        ),
        (
            "register_per_account",
            "/api/v1/auth/register",
            (0..3)
                .map(|i| {
                    (
                        ["10.1.0.1", "10.1.0.2", "10.1.0.3"][i],
                        serde_json::json!({ "email": "dup@example.com", "password": "a" }),
                    )
                })
                .collect(),
        ),
        (
            "totp_verify_per_ip",
            "/api/v1/auth/totp/verify",
            (0..4)
                .map(|_| {
                    (
                        "10.2.0.1",
                        serde_json::json!({ "user_id": Uuid::new_v4(), "code": "000000" }),
                    )
                })
                .collect(),
        ),
        (
            "invite_redeem_per_ip",
            "/api/v1/invites/redeem",
            (0..4)
                .map(|i| ("10.3.0.1", serde_json::json!({ "token": format!("bogus-{i}") })))
                .collect(),
        ),
        (
            "owner_bootstrap_per_ip",
            "/api/v1/instance/bootstrap",
            (0..4)
                .map(|i| {
                    (
                        "10.4.0.1",
                        serde_json::json!({
                            "token": format!("bogus-{i}"),
                            "email": format!("o{i}@example.com"),
                            "password": "x",
                        }),
                    )
                })
                .collect(),
        ),
    ];

    for (case, uri, attempts) in cases {
        let h = Harness::with(limited_policy(), STRONG_SECRET);
        let app = h.app();
        let last = attempts.len() - 1;
        for (i, (ip, body)) in attempts.into_iter().enumerate() {
            let req = Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .header("x-forwarded-for", format!("203.0.113.7, {ip}"))
                .body(Body::from(body.to_string()))
                .unwrap();
            let (status, headers, _) = send(&app, req).await;
            if i == last {
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "case {case}");
                assert!(headers.contains_key("retry-after"), "case {case}");
            } else {
                assert_ne!(
                    status,
                    StatusCode::TOO_MANY_REQUESTS,
                    "case {case} attempt {i}"
                );
            }
        }
    }
}

#[tokio::test]
async fn a72_session_cookie_secure_flag_follows_policy() {
    for (case, cookie_secure) in [("secure_default", true), ("plain_http_lan", false)] {
        let router = build_auth_router(AuthState::with_security(
            Arc::new(MagicLinkService::new(STRONG_SECRET.to_vec(), "trame-test")),
            Arc::new(InMemorySessionStore::new()),
            Arc::new(TotpService::default()),
            Arc::new(SecurityPolicy {
                cookie_secure,
                ..SecurityPolicy::default()
            }),
        ));
        let body = serde_json::json!({
            "email": "cookie@example.com",
            "display_name": "Cookie",
            "password": "correct-horse-battery-staple-42",
        });
        let (status, headers, _) = send(
            &router,
            request(
                "POST",
                "/api/v1/auth/register",
                None,
                Body::from(body.to_string()),
            ),
        )
        .await;
        assert!(status.is_success(), "case {case}: {status}");
        let cookie = headers["set-cookie"].to_str().unwrap();
        assert!(cookie.contains("HttpOnly"), "case {case}");
        assert_eq!(cookie.contains("Secure"), cookie_secure, "case {case}");
    }
}

#[tokio::test]
async fn a73_every_response_carries_hardening_headers() {
    let h = Harness::new();
    let app = h.app();
    let cases = [
        ("healthz", "GET", "/healthz"),
        ("auth_me_unauthenticated", "GET", "/api/v1/auth/me"),
        ("unknown_route", "GET", "/definitely/not/a/route"),
    ];
    for (case, method, uri) in cases {
        let (_, headers, _) = send(&app, request(method, uri, None, Body::empty())).await;
        let csp = headers
            .get("content-security-policy")
            .unwrap_or_else(|| panic!("case {case}: missing CSP"))
            .to_str()
            .unwrap();
        assert!(csp.contains("frame-ancestors 'none'"), "case {case}");
        assert_eq!(headers["x-content-type-options"], "nosniff", "case {case}");
        assert_eq!(headers["x-frame-options"], "DENY", "case {case}");
        assert_eq!(headers["referrer-policy"], "no-referrer", "case {case}");
    }
}

// ---------------------------------------------------------------------------
// A70 / A63 — WebSocket hardening over a real socket
// ---------------------------------------------------------------------------

async fn serve(h: &Harness) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = h.app();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

/// Sends a raw RFC 6455 upgrade request and returns the HTTP status plus the open stream.
async fn ws_handshake(addr: SocketAddr, path: &str, extra: &[(&str, &str)]) -> (u16, TcpStream) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut req = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    );
    for (k, v) in extra {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();

    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head)
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap();
    (status, stream)
}

/// Reads one unmasked server WebSocket frame payload.
async fn read_ws_frame(stream: &mut TcpStream) -> Vec<u8> {
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
    payload
}

/// Returns `true` when the server closes the TCP stream within `wait`.
async fn closed_within(stream: &mut TcpStream, wait: Duration) -> bool {
    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) => return true,
            Ok(Ok(_)) => continue,
            Err(_) => return false,
        }
    }
}

#[tokio::test]
async fn a70_a63_websocket_upgrade_requires_origin_credentials_and_membership() {
    let h = Harness::with(
        SecurityPolicy {
            allowed_origins: vec![ALLOWED_ORIGIN.to_string()],
            ..SecurityPolicy::default()
        },
        STRONG_SECRET,
    );
    let campaign_id = Uuid::new_v4();
    let (member_id, member_cookie) = h.account(false, "PLAYER").await;
    h.join(campaign_id, member_id, "PLAYER").await;
    let (_, outsider_cookie) = h.account(false, "GM").await;
    let addr = serve(&h).await;
    let ws = format!("/ws/campaigns/{campaign_id}");
    let spoof = format!("/ws/campaigns/{campaign_id}?user_id={member_id}&role=gm");

    let (ws, member, outsider) = (
        ws.as_str(),
        member_cookie.as_str(),
        outsider_cookie.as_str(),
    );

    let cases: Vec<(&str, &str, Vec<(&str, &str)>, u16)> = vec![
        ("no_credentials", ws, vec![("Origin", ALLOWED_ORIGIN)], 401),
        ("query_identity_spoof", spoof.as_str(), vec![], 401),
        (
            "foreign_origin_with_valid_session",
            ws,
            vec![("Origin", "https://evil.example"), ("Cookie", member)],
            403,
        ),
        (
            "non_member",
            ws,
            vec![("Origin", ALLOWED_ORIGIN), ("Cookie", outsider)],
            403,
        ),
        (
            "member_allowed_origin",
            ws,
            vec![("Origin", ALLOWED_ORIGIN), ("Cookie", member)],
            101,
        ),
        (
            "member_without_origin_cli_client",
            ws,
            vec![("Cookie", member)],
            101,
        ),
    ];
    for (case, path, headers, expected) in cases {
        let (status, _) = ws_handshake(addr, path, &headers).await;
        assert_eq!(status, expected, "case {case}");
    }
}

#[tokio::test]
async fn a63_websocket_role_comes_from_membership_not_query() {
    let h = Harness::new();
    let campaign_id = Uuid::new_v4();
    let hidden_id = Uuid::new_v4();
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    let mut hidden = TokenState::new_default(hidden_id, "Hidden Lich", Point2D::new(0.0, 100.0));
    hidden.visibility_channel |= CHANNEL_GM_HIDDEN;
    state.data.tokens.insert(hidden_id, hidden);
    save_snapshot(&h.wal, campaign_id, state);

    let (player_id, cookie) = h.account(false, "GM").await;
    h.join(campaign_id, player_id, "PLAYER").await;
    let addr = serve(&h).await;
    let (status, mut stream) = ws_handshake(
        addr,
        &format!("/ws/campaigns/{campaign_id}?role=gm&user_id={player_id}"),
        &[("Cookie", &cookie)],
    )
    .await;
    assert_eq!(status, 101);
    let snapshot: ServerEnvelope =
        rmp_serde::from_slice(&read_ws_frame(&mut stream).await).unwrap();
    let ServerEnvelope::StateSnapshot { state, .. } = snapshot else {
        panic!("expected StateSnapshot");
    };
    assert!(!state.tokens.contains_key(&hidden_id));
    assert!(!state.public_tokens.contains_key(&hidden_id));
}

#[tokio::test]
async fn a70_websocket_frames_above_cap_close_the_connection() {
    let h = Harness::with(
        SecurityPolicy {
            ws_max_message_bytes: 1024,
            ..SecurityPolicy::default()
        },
        STRONG_SECRET,
    );
    let campaign_id = Uuid::new_v4();
    let (member_id, cookie) = h.account(false, "PLAYER").await;
    h.join(campaign_id, member_id, "PLAYER").await;
    let addr = serve(&h).await;

    // (case_id, declared payload length, expect close)
    let cases = [
        ("small_frame_kept", 16u64, false),
        ("oversized_frame", 64 * 1024, true),
    ];
    for (case, len, expect_close) in cases {
        let (status, mut stream) = ws_handshake(
            addr,
            &format!("/ws/campaigns/{campaign_id}"),
            &[("Cookie", &cookie)],
        )
        .await;
        assert_eq!(status, 101, "case {case}");
        let mut frame = vec![0x82u8, 0x80 | 127];
        frame.extend_from_slice(&len.to_be_bytes());
        frame.extend_from_slice(&[0, 0, 0, 0]);
        if len <= 1024 {
            frame.extend(std::iter::repeat_n(0u8, len as usize));
        }
        stream.write_all(&frame).await.unwrap();
        assert_eq!(
            closed_within(&mut stream, Duration::from_millis(1500)).await,
            expect_close,
            "case {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// Room actor seam: A23, A24/A68, A64-A67
// ---------------------------------------------------------------------------

fn save_snapshot(wal: &InMemoryWalStorage, campaign_id: Uuid, state: TableState) {
    wal.save_snapshot(TableStateSnapshot {
        campaign_id,
        snapshot_seq_id: 0,
        captured_at_ms: 0,
        cell_size_px: state.cell_size_px,
        feet_per_cell: state.feet_per_cell,
        data: state.data,
    })
    .unwrap();
}

async fn connect(
    room: &TableRoomHandle,
    user_id: Uuid,
    role: CampaignRole,
) -> (Uuid, mpsc::UnboundedReceiver<OutboundClientFrame>) {
    let (tx, rx) = mpsc::unbounded_channel();
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

struct Table {
    room: TableRoomHandle,
    gm: (Uuid, mpsc::UnboundedReceiver<OutboundClientFrame>),
    player: (Uuid, mpsc::UnboundedReceiver<OutboundClientFrame>),
}

impl Table {
    async fn open(state: TableState, player_user: Uuid) -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let campaign_id = Uuid::new_v4();
        save_snapshot(&wal, campaign_id, state);
        let mgr = RoomLeaseManager::new(wal, 25, 900_000);
        let room = mgr.get_or_wake_room(campaign_id).await.unwrap();
        let gm = connect(&room, Uuid::new_v4(), CampaignRole::Gm).await;
        let player = connect(&room, player_user, CampaignRole::Player).await;
        Self { room, gm, player }
    }

    async fn submit(&mut self, as_gm: bool, envelope: ClientEnvelope) {
        let session = if as_gm { self.gm.0 } else { self.player.0 };
        self.room.send_envelope(session, envelope).await.unwrap();
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<OutboundClientFrame>) -> Vec<ServerEnvelope> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            if let OutboundClientFrame::Binary(bytes) = frame {
                out.push(rmp_serde::from_slice(&bytes).unwrap());
            }
        }
        out
    }
}

fn token(id: Uuid, name: &str, owner: Option<Uuid>, x: f64) -> TokenState {
    let mut t = TokenState::new_default(id, name, Point2D::new(x, 0.0));
    t.owner_user_id = owner;
    t
}

#[tokio::test]
async fn a24_a68_damage_authority_and_bounds() {
    let player_user = Uuid::new_v4();
    let (own, other, npc) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());

    // (case_id, as_gm, target, raw_damage, affinity, accepted)
    let cases = [
        (
            "player_own_token_normal",
            false,
            own,
            5,
            DamageAffinity::Normal,
            true,
        ),
        (
            "player_other_players_token",
            false,
            other,
            5,
            DamageAffinity::Normal,
            false,
        ),
        (
            "player_npc_token",
            false,
            npc,
            5,
            DamageAffinity::Normal,
            false,
        ),
        (
            "player_own_token_claims_immune",
            false,
            own,
            5,
            DamageAffinity::Immune,
            false,
        ),
        (
            "player_own_token_claims_resistant",
            false,
            own,
            5,
            DamageAffinity::Resistant,
            false,
        ),
        (
            "gm_npc_vulnerable",
            true,
            npc,
            10,
            DamageAffinity::Vulnerable,
            true,
        ),
        (
            "gm_other_players_token",
            true,
            other,
            3,
            DamageAffinity::Normal,
            true,
        ),
        (
            "gm_negative_damage",
            true,
            npc,
            -1,
            DamageAffinity::Normal,
            false,
        ),
        (
            "gm_above_cap",
            true,
            npc,
            10_001,
            DamageAffinity::Normal,
            false,
        ),
        (
            "gm_i32_max_vulnerable_overflow",
            true,
            npc,
            i32::MAX,
            DamageAffinity::Vulnerable,
            false,
        ),
    ];
    for (case, as_gm, target, raw_damage, affinity, accepted) in cases {
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        state
            .data
            .tokens
            .insert(own, token(own, "Own", Some(player_user), 0.0));
        state
            .data
            .tokens
            .insert(other, token(other, "Other", Some(Uuid::new_v4()), 100.0));
        state
            .data
            .tokens
            .insert(npc, token(npc, "Npc", None, 200.0));
        let mut table = Table::open(state, player_user).await;
        Table::drain(&mut table.gm.1);
        Table::drain(&mut table.player.1);

        table
            .submit(
                as_gm,
                ClientEnvelope::SubmitCommand(Box::new(
                    TrameCommand::ApplyDamage {
                        token_id: target,
                        raw_damage,
                        affinity,
                        is_critical: false,
                        damage_type: None,
                    }
                    .into(),
                )),
            )
            .await;
        let sender = if as_gm {
            Table::drain(&mut table.gm.1)
        } else {
            Table::drain(&mut table.player.1)
        };
        let was_accepted = sender
            .iter()
            .any(|e| matches!(e, ServerEnvelope::CommandAccepted { .. }));
        let was_rejected = sender
            .iter()
            .any(|e| matches!(e, ServerEnvelope::CommandRejected { .. }));
        assert_eq!(was_accepted, accepted, "case {case}");
        assert_eq!(was_rejected, !accepted, "case {case}");
    }
}

#[tokio::test]
async fn a23_dice_expression_caps_and_checked_math() {
    let player_user = Uuid::new_v4();
    let cases = [
        (
            "valid_roll",
            "1d20+5".to_string(),
            "attack".to_string(),
            true,
        ),
        (
            "expression_over_128_bytes",
            format!("1d20+{}", "1".repeat(130)),
            "x".to_string(),
            false,
        ),
        (
            "more_than_20_terms",
            vec!["1d4"; 21].join("+"),
            "x".to_string(),
            false,
        ),
        (
            "reason_over_200_bytes",
            "1d20".to_string(),
            "r".repeat(201),
            false,
        ),
        (
            "total_overflows_i32",
            "1d20+2147483647".to_string(),
            "x".to_string(),
            false,
        ),
    ];
    for (case, expression, reason, accepted) in cases {
        let mut table = Table::open(TableState::new(100.0, 5.0, Vec::new()), player_user).await;
        Table::drain(&mut table.player.1);
        table
            .submit(
                false,
                ClientEnvelope::RollDice {
                    expression,
                    visibility: RollVisibility::Public,
                    reason,
                    correlation_id: None,
                },
            )
            .await;
        let frames = Table::drain(&mut table.player.1);
        let rolled = frames
            .iter()
            .any(|e| matches!(e, ServerEnvelope::DiceRolled(_)));
        let rejected = frames
            .iter()
            .any(|e| matches!(e, ServerEnvelope::CommandRejected { .. }));
        assert_eq!(rolled, accepted, "case {case}");
        assert_eq!(rejected, !accepted, "case {case}");
    }
}

fn privacy_table(player_user: Uuid, active_index: usize) -> (TableState, [Uuid; 3], [Uuid; 2]) {
    let mut secret = WallSegment::normal_wall(
        Uuid::new_v4(),
        Point2D::new(0.0, 500.0),
        Point2D::new(400.0, 500.0),
    );
    secret.kind = WallKind::SecretDoor { is_open: false };
    let mut illusion = secret.clone();
    illusion.id = Uuid::new_v4();
    illusion.a = Point2D::new(0.0, 600.0);
    illusion.b = Point2D::new(400.0, 600.0);
    illusion.kind = WallKind::Illusion {
        pierced_by_truesight: true,
    };
    let wall_ids = [secret.id, illusion.id];
    let mut state = TableState::new(100.0, 5.0, vec![secret, illusion]);

    let (hero, goblin, lich) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    state
        .data
        .tokens
        .insert(hero, token(hero, "Hero", Some(player_user), 0.0));
    let mut gob = token(goblin, "Goblin", None, 100.0);
    gob.hp = 5;
    state.data.tokens.insert(goblin, gob);
    let mut li = token(lich, "Lich", None, 200.0);
    li.visibility_channel |= CHANNEL_GM_HIDDEN;
    state.data.tokens.insert(lich, li);
    state.data.mode = TableMode::TurnByTurn;
    state.data.initiative_order = vec![lich, hero, goblin];
    state.data.active_turn_index = active_index;
    (state, [hero, goblin, lich], wall_ids)
}

#[tokio::test]
async fn a64_a66_player_snapshot_projection() {
    let player_user = Uuid::new_v4();
    // (case_id, authoritative active index, expected player active_turn_index)
    let cases = [
        ("hidden_combatant_active_yields_none", 0usize, None),
        ("visible_goblin_active_reindexed", 2usize, Some(1usize)),
    ];
    for (case, active, expected_index) in cases {
        let (state, [hero, goblin, lich], wall_ids) = privacy_table(player_user, active);
        let mut table = Table::open(state, player_user).await;
        let frames = Table::drain(&mut table.player.1);
        let Some(ServerEnvelope::StateSnapshot { state: proj, .. }) = frames.first() else {
            panic!("case {case}: expected snapshot");
        };
        assert!(
            proj.tokens.contains_key(&hero),
            "case {case}: own token full"
        );
        assert_eq!(
            proj.tokens.len(),
            1,
            "case {case}: only controlled tokens are full"
        );
        let gob = proj
            .public_tokens
            .get(&goblin)
            .unwrap_or_else(|| panic!("case {case}: goblin public view"));
        assert_eq!(gob.bloodied, BloodiedState::Bloodied, "case {case}");
        assert!(!proj.public_tokens.contains_key(&lich), "case {case}");
        assert_eq!(proj.initiative_order, vec![hero, goblin], "case {case}");
        assert_eq!(proj.active_turn_index, expected_index, "case {case}");
        for wall in proj.walls.iter().filter(|w| wall_ids.contains(&w.id)) {
            if matches!(
                wall.kind,
                WallKind::SecretDoor { .. } | WallKind::Illusion { .. }
            ) {
                panic!("case {case}: secret geometry leaked: {:?}", wall.kind);
            }
        }

        let gm_frames = Table::drain(&mut table.gm.1);
        let Some(ServerEnvelope::StateSnapshot { state: gm_proj, .. }) = gm_frames.first() else {
            panic!("case {case}: expected GM snapshot");
        };
        assert_eq!(gm_proj.tokens.len(), 3, "case {case}");
        assert_eq!(gm_proj.active_turn_index, Some(active), "case {case}");
    }
}

#[tokio::test]
async fn a64_initiative_totals_shared_except_hidden_combatants() {
    let player_user = Uuid::new_v4();
    // (case_id, recipient is GM, expected order as [hero, goblin, lich] indices)
    let cases = [
        (
            "player_sees_visible_combatants_only",
            false,
            vec![1usize, 0],
        ),
        ("gm_sees_hidden_combatant_too", true, vec![2usize, 1, 0]),
    ];
    for (case, as_gm, expected_idx) in cases {
        let (mut state, ids, _) = privacy_table(player_user, 1);
        let [hero, goblin, lich] = ids;
        state.data.initiative_totals = BTreeMap::from([(lich, 18), (hero, 12), (goblin, 9)]);
        let expected_order: Vec<Uuid> = expected_idx.iter().map(|i| ids[*i]).collect();
        let expected_totals: BTreeMap<Uuid, i32> =
            BTreeMap::from([(lich, 18), (hero, 12), (goblin, 15)])
                .into_iter()
                .filter(|(id, _)| expected_order.contains(id))
                .collect();

        let mut table = Table::open(state, player_user).await;
        Table::drain(&mut table.gm.1);
        Table::drain(&mut table.player.1);
        table
            .submit(
                true,
                ClientEnvelope::SubmitCommand(Box::new(
                    TrameCommand::SetInitiativeTotal {
                        token_id: goblin,
                        total: 15,
                    }
                    .into(),
                )),
            )
            .await;
        let rx = if as_gm {
            &mut table.gm.1
        } else {
            &mut table.player.1
        };
        let frames = Table::drain(rx);
        let Some((events, projected)) = frames.iter().find_map(|f| match f {
            ServerEnvelope::CommandAccepted { events, state, .. } => Some((events, state)),
            _ => None,
        }) else {
            panic!("case {case}: expected CommandAccepted");
        };
        let Some(TrameEvent::InitiativeUpdated {
            initiative_order,
            initiative_totals,
            ..
        }) = events
            .iter()
            .find(|e| matches!(e, TrameEvent::InitiativeUpdated { .. }))
        else {
            panic!("case {case}: InitiativeUpdated withheld: {events:?}");
        };
        assert_eq!(
            initiative_order, &expected_order,
            "case {case}: event order"
        );
        assert_eq!(
            initiative_totals, &expected_totals,
            "case {case}: event totals"
        );
        assert_eq!(
            projected.initiative_totals, expected_totals,
            "case {case}: state totals"
        );

        let role = if as_gm {
            CampaignRole::Gm
        } else {
            CampaignRole::Player
        };
        let user = if as_gm { Uuid::new_v4() } else { player_user };
        let (_, mut rejoined) = connect(&table.room, user, role).await;
        let Some(ServerEnvelope::StateSnapshot { state: snap, .. }) =
            Table::drain(&mut rejoined).into_iter().next()
        else {
            panic!("case {case}: expected reconnect snapshot");
        };
        assert_eq!(
            snap.initiative_order, expected_order,
            "case {case}: reconnect order"
        );
        assert_eq!(
            snap.initiative_totals, expected_totals,
            "case {case}: reconnect totals"
        );
    }
}

#[tokio::test]
async fn a65_vitality_events_reach_only_the_controller() {
    let player_user = Uuid::new_v4();
    let (state, [hero, goblin, _], _) = privacy_table(player_user, 1);
    let mut table = Table::open(state, player_user).await;
    Table::drain(&mut table.gm.1);
    Table::drain(&mut table.player.1);

    // (case_id, damaged token, player sees DamageApplied)
    let cases = [
        ("npc_damage_hidden", goblin, false),
        ("own_token_damage", hero, true),
    ];
    for (case, target, visible) in cases {
        table
            .submit(
                true,
                ClientEnvelope::SubmitCommand(Box::new(
                    TrameCommand::ApplyDamage {
                        token_id: target,
                        raw_damage: 1,
                        affinity: DamageAffinity::Normal,
                        is_critical: false,
                        damage_type: None,
                    }
                    .into(),
                )),
            )
            .await;
        let frames = Table::drain(&mut table.player.1);
        let Some(ServerEnvelope::CommandAccepted { events, state, .. }) = frames.first() else {
            panic!("case {case}: expected CommandAccepted");
        };
        let saw = events
            .iter()
            .any(|e| matches!(e, trame_engine::commands::TrameEvent::DamageApplied { .. }));
        assert_eq!(saw, visible, "case {case}");
        if !visible {
            let view = &state.public_tokens[&target];
            assert_eq!(view.bloodied, BloodiedState::Bloodied, "case {case}");
        }
        Table::drain(&mut table.gm.1);
    }
}

#[tokio::test]
async fn a67_initiative_hides_hidden_tokens_and_keeps_player_self_rolls() {
    let player_user = Uuid::new_v4();
    let (hero, lich, npc) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    state
        .data
        .tokens
        .insert(hero, token(hero, "Hero Paladin", Some(player_user), 0.0));
    let mut li = token(lich, "Secret Lich", None, 100.0);
    li.visibility_channel |= CHANNEL_GM_HIDDEN;
    state.data.tokens.insert(lich, li);
    state
        .data
        .tokens
        .insert(npc, token(npc, "Bandit", None, 200.0));
    let mut table = Table::open(state, player_user).await;
    Table::drain(&mut table.gm.1);
    Table::drain(&mut table.player.1);

    table
        .submit(
            false,
            ClientEnvelope::RollDice {
                expression: "1d20+2".to_string(),
                visibility: RollVisibility::Public,
                reason: "Initiative".to_string(),
                correlation_id: None,
            },
        )
        .await;
    Table::drain(&mut table.gm.1);
    Table::drain(&mut table.player.1);

    table
        .submit(
            true,
            ClientEnvelope::SubmitCommand(Box::new(
                TrameCommand::StartTurnByTurn {
                    initiative_order: Vec::new(),
                    initiative_totals: Default::default(),
                }
                .into(),
            )),
        )
        .await;

    let reasons = |frames: &[ServerEnvelope]| -> Vec<String> {
        frames
            .iter()
            .filter_map(|e| match e {
                ServerEnvelope::DiceRolled(r) => Some(r.reason.clone()),
                _ => None,
            })
            .collect()
    };
    let gm_frames = Table::drain(&mut table.gm.1);
    let player_frames = Table::drain(&mut table.player.1);
    let gm_reasons = reasons(&gm_frames);
    let player_reasons = reasons(&player_frames);

    // (case_id, reason, gm sees, player sees)
    let cases = [
        (
            "public_npc_rolled_publicly",
            "Initiative: Bandit",
            true,
            true,
        ),
        (
            "hidden_token_rolled_gm_only",
            "Initiative: Secret Lich",
            true,
            false,
        ),
        (
            "player_token_not_auto_rolled",
            "Initiative: Hero Paladin",
            false,
            false,
        ),
    ];
    for (case, reason, gm_sees, player_sees) in cases {
        assert_eq!(
            gm_reasons.iter().any(|r| r == reason),
            gm_sees,
            "case {case}"
        );
        assert_eq!(
            player_reasons.iter().any(|r| r == reason),
            player_sees,
            "case {case}"
        );
    }

    let Some(ServerEnvelope::CommandAccepted { state, .. }) = player_frames
        .iter()
        .find(|e| matches!(e, ServerEnvelope::CommandAccepted { .. }))
    else {
        panic!("expected CommandAccepted for player");
    };
    assert!(state.initiative_order.contains(&hero));
    assert!(!state.initiative_order.contains(&lich));
}
