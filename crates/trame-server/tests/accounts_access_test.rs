//! ============================================================================
//! ACCOUNTS, INSTANCE ROLES & CAMPAIGN INVITES SUITE (accounts_access_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Exercises invite-only access (ADR-0039) through the production Axum router
//!   and the `TableRoomActor`: owner bootstrap (D15), closed registration and
//!   `InstanceRole` gates (SEC10), bounded `CampaignInvite` links (SEC7, D3),
//!   `InviteRedemption` (D2), member removal closing live sockets (SEC13), the
//!   persisted instance id (SEC11), and the `/auth/me` flags the UI needs (D16).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Every test builds its own in-memory store and router, so the "exactly one
//!     Owner" singleton never leaks between cases.
//!   - Rate limits are raised so repeated credential calls exercise behaviour,
//!     not the limiter.
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tower::ServiceExt;
use trame_engine::commands::CampaignRole;
use trame_server::archive::InMemoryCampaignStore;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::auth::accounts::{CampaignInviteRecord, InstanceRole, MAX_INVITE_TTL_SECONDS};
use trame_server::auth::magic_link::{MagicLinkService, now_epoch_seconds};
use trame_server::auth::password::PasswordService;
use trame_server::auth::session::{
    AuthState, FullAuthStore, IdentityStore, InMemorySessionStore, SessionStore, UserRecord,
    hash_session_token,
};
use trame_server::auth::totp::TotpService;
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
    resolve_campaign_role,
};
use trame_server::instance::{prepare_owner_bootstrap, resolve_instance_id};
use trame_server::maps::InMemoryMapStorage;
use trame_server::room::{
    ConnectedClient, OutboundClientFrame, RoomLeaseManager, WS_CLOSE_CODE_MEMBERSHIP_REVOKED,
};
use trame_server::security::{AuthRateLimiter, RateLimit, SecurityPolicy};
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

const ORIGIN: &str = "https://table.example.com";
const PASSWORD: &str = "correct-horse-battery-staple-42";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    state: AppState,
}

fn policy(registration_open: bool, locked_email: Option<&str>) -> SecurityPolicy {
    let generous = RateLimit {
        max_attempts: 10_000,
        window: Duration::from_secs(60),
    };
    SecurityPolicy {
        rate_limiter: AuthRateLimiter::new(generous, generous),
        public_origin: Some(ORIGIN.to_string()),
        registration_open,
        bootstrap_owner_email: locked_email.map(str::to_string),
        ..SecurityPolicy::default()
    }
}

impl Harness {
    fn new(policy: SecurityPolicy) -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let auth_state = AuthState::with_security(
            Arc::new(MagicLinkService::new(
                b"accounts-test-secret-at-least-32-bytes".to_vec(),
                "trame-test",
            )),
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

    fn dev() -> Self {
        Self::new(policy(true, None))
    }

    fn app(&self) -> Router {
        build_router_with_state(self.state.clone())
    }

    fn store(&self) -> &Arc<dyn FullAuthStore> {
        &self.state.auth_state.session_store
    }

    /// Saves an account with `role` (optionally with `password`) and a live session;
    /// returns `(user_id, cookie_header)`.
    async fn account_with(
        &self,
        role: InstanceRole,
        email: &str,
        password: Option<&str>,
    ) -> (Uuid, String) {
        let user_id = Uuid::new_v4();
        self.store()
            .save_user(UserRecord {
                id: user_id,
                username: format!("user-{}", &user_id.to_string()[..8]),
                role: "PLAYER".to_string(),
                is_guest: false,
                created_at: 0,
                email: Some(email.to_string()),
                password_hash: password
                    .map(|p| PasswordService::new().hash_password(p).expect("hash")),
                mfa_enabled: false,
                totp_secret: None,
                pending_totp_secret: None,
                instance_role: role,
            })
            .await
            .unwrap();
        let token = format!("accounts-session-{user_id}");
        self.store()
            .create_session(user_id, &hash_session_token(&token), 3600)
            .await
            .unwrap();
        (user_id, format!("trame_session={token}"))
    }

    async fn account(&self, role: InstanceRole) -> (Uuid, String) {
        let email = format!("{}@example.com", Uuid::new_v4());
        self.account_with(role, &email, None).await
    }

    /// Creates a campaign through the router as a `Host`; returns `(campaign_id, gm_id, gm_cookie)`.
    async fn campaign(&self) -> (Uuid, Uuid, String) {
        let (gm_id, gm) = self.account(InstanceRole::Host).await;
        let (status, _, body) = call(
            &self.app(),
            "POST",
            "/api/v1/campaigns",
            Some(&gm),
            json!({ "name": "Lost Mine" }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = Uuid::parse_str(body["campaign"]["id"].as_str().unwrap()).unwrap();
        (id, gm_id, gm)
    }

    /// Mints an invite as the GM; returns the creation body's `invite` object.
    async fn mint(&self, campaign_id: Uuid, gm: &str, body: Value) -> Value {
        let (status, _, body) = call(
            &self.app(),
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/invites"),
            Some(gm),
            body,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["invite"].clone()
    }

    async fn member_role(&self, campaign_id: Uuid, user_id: Uuid) -> Option<String> {
        self.store()
            .get_campaign_member(campaign_id, user_id)
            .await
            .unwrap()
            .map(|m| m.role)
    }
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    body: Value,
) -> (StatusCode, HeaderMap, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let resp = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// `trame_session=...` pair from a `Set-Cookie` response header.
fn session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with("trame_session="))
        .map(|v| v.split(';').next().unwrap().to_string())
}

fn visitor(token: &str, email: &str) -> Value {
    json!({ "token": token, "email": email, "password": PASSWORD, "display_name": "Sildar" })
}

// ---------------------------------------------------------------------------
// D15 — owner bootstrap
// ---------------------------------------------------------------------------

/// Which token the claim presents.
#[derive(Debug, Clone, Copy)]
enum SetupToken {
    /// The token minted by the latest boot.
    Current,
    /// A token minted by an earlier boot (replaced on restart).
    PreviousBoot,
    /// The current token, stored with an expiry in the past.
    Expired,
    /// A random token never minted.
    Unknown,
}

#[tokio::test]
async fn d15_owner_bootstrap_claims_instance_once() {
    // (case_id, locked email, token, claimed email, existing account (email, password),
    //  submitted password, expected status, expected code)
    type Case = (
        &'static str,
        Option<&'static str>,
        SetupToken,
        &'static str,
        Option<(&'static str, &'static str)>,
        &'static str,
        StatusCode,
        Option<&'static str>,
    );
    let cases: Vec<Case> = vec![
        (
            "fresh_token_creates_owner_account",
            None,
            SetupToken::Current,
            "owner@example.com",
            None,
            PASSWORD,
            StatusCode::CREATED,
            None,
        ),
        (
            "locked_email_creates_owner_account",
            Some("owner@example.com"),
            SetupToken::Current,
            " Owner@Example.com ",
            None,
            PASSWORD,
            StatusCode::CREATED,
            None,
        ),
        (
            "locked_email_rejects_other_email",
            Some("owner@example.com"),
            SetupToken::Current,
            "intruder@example.com",
            None,
            PASSWORD,
            StatusCode::FORBIDDEN,
            Some("EMAIL_LOCKED"),
        ),
        (
            "locked_email_claims_existing_account_with_its_password",
            Some("owner@example.com"),
            SetupToken::Current,
            "owner@example.com",
            Some(("owner@example.com", PASSWORD)),
            PASSWORD,
            StatusCode::CREATED,
            None,
        ),
        (
            "existing_account_wrong_password_rejected",
            None,
            SetupToken::Current,
            "owner@example.com",
            Some(("owner@example.com", PASSWORD)),
            "wrong-password-but-long-enough",
            StatusCode::UNAUTHORIZED,
            Some("INVALID_CREDENTIALS"),
        ),
        (
            "expired_token_rejected",
            None,
            SetupToken::Expired,
            "owner@example.com",
            None,
            PASSWORD,
            StatusCode::UNAUTHORIZED,
            Some("SETUP_TOKEN_EXPIRED"),
        ),
        (
            "previous_boot_token_rejected_after_restart",
            None,
            SetupToken::PreviousBoot,
            "owner@example.com",
            None,
            PASSWORD,
            StatusCode::UNAUTHORIZED,
            Some("INVALID_SETUP_TOKEN"),
        ),
        (
            "unknown_token_rejected",
            None,
            SetupToken::Unknown,
            "owner@example.com",
            None,
            PASSWORD,
            StatusCode::UNAUTHORIZED,
            Some("INVALID_SETUP_TOKEN"),
        ),
    ];
    for (case, locked, token_kind, email, existing, password, want_status, want_code) in cases {
        let h = Harness::new(policy(false, locked));
        let existing_id = match existing {
            Some((email, pw)) => Some(
                h.account_with(InstanceRole::Member, email, Some(pw))
                    .await
                    .0,
            ),
            None => None,
        };
        let now = now_epoch_seconds();
        let first = prepare_owner_bootstrap(h.store().as_ref(), Some(ORIGIN), now)
            .await
            .unwrap()
            .expect("no owner yet: ticket minted");
        assert_eq!(
            first.setup_url,
            format!("{ORIGIN}/setup?token={}", first.token),
            "case {case}"
        );
        assert_eq!(first.expires_at, now + 3600, "case {case}: 1 h validity");
        let current = prepare_owner_bootstrap(h.store().as_ref(), Some(ORIGIN), now)
            .await
            .unwrap()
            .expect("restart without owner mints a fresh ticket");
        let token = match token_kind {
            SetupToken::Current => current.token.clone(),
            SetupToken::PreviousBoot => first.token.clone(),
            SetupToken::Expired => {
                h.store()
                    .replace_owner_bootstrap_token(&hash_session_token(&current.token), now - 1)
                    .await
                    .unwrap();
                current.token.clone()
            }
            SetupToken::Unknown => "f".repeat(64),
        };
        let (status, headers, body) = call(
            &h.app(),
            "POST",
            "/api/v1/instance/bootstrap",
            None,
            json!({ "token": token, "email": email, "password": password, "display_name": "Ada Owner" }),
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        assert_eq!(body["code"].as_str(), want_code, "case {case}");
        let claimed = status == StatusCode::CREATED;
        assert_eq!(
            h.store().owner_exists().await.unwrap(),
            claimed,
            "case {case}"
        );
        if !claimed {
            continue;
        }
        assert_eq!(body["user"]["instance_role"], json!("OWNER"), "case {case}");
        if let Some(id) = existing_id {
            assert_eq!(
                body["user"]["id"],
                json!(id),
                "case {case}: account promoted"
            );
        }
        let cookie = session_cookie(&headers).expect("owner session cookie");
        let (status, _, me) = call(
            &h.app(),
            "GET",
            "/api/v1/auth/me",
            Some(&cookie),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        assert_eq!(me["user"]["instance_role"], json!("OWNER"), "case {case}");

        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/instance/bootstrap",
            None,
            json!({ "token": token, "email": "second@example.com", "password": PASSWORD, "display_name": "Second" }),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "case {case}: single use");
        assert_eq!(body["code"], json!("INVALID_SETUP_TOKEN"), "case {case}");
        assert!(
            prepare_owner_bootstrap(h.store().as_ref(), Some(ORIGIN), now)
                .await
                .unwrap()
                .is_none(),
            "case {case}: claimed instance mints no ticket"
        );
    }
}

#[tokio::test]
async fn d15_bootstrap_status_reports_token_state() {
    // (case_id, locked email, token, expected status label, expected locked_email)
    let cases = [
        ("valid_token", None, SetupToken::Current, "valid", None),
        (
            "valid_token_reports_locked_email",
            Some("owner@example.com"),
            SetupToken::Current,
            "valid",
            Some("owner@example.com"),
        ),
        ("expired_token", None, SetupToken::Expired, "expired", None),
        ("unknown_token", None, SetupToken::Unknown, "invalid", None),
    ];
    for (case, locked, token_kind, want_label, want_locked) in cases {
        let h = Harness::new(policy(false, locked));
        let now = now_epoch_seconds();
        let ticket = prepare_owner_bootstrap(h.store().as_ref(), None, now)
            .await
            .unwrap()
            .unwrap();
        assert!(ticket.setup_url.starts_with("/setup?token="), "case {case}");
        let token = match token_kind {
            SetupToken::Expired => {
                h.store()
                    .replace_owner_bootstrap_token(&hash_session_token(&ticket.token), now - 1)
                    .await
                    .unwrap();
                ticket.token
            }
            SetupToken::Unknown => "0".repeat(64),
            SetupToken::Current | SetupToken::PreviousBoot => ticket.token,
        };
        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/instance/bootstrap/status",
            None,
            json!({ "token": token }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        assert_eq!(body["status"], json!(want_label), "case {case}");
        assert_eq!(body["locked_email"].as_str(), want_locked, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// SEC10 — registration, campaign creation, instance administration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec10_public_registration_only_in_dev() {
    // (case_id, registration open, expected status, expected code)
    let cases = [
        (
            "dev_registration_creates_member",
            true,
            StatusCode::CREATED,
            None,
        ),
        (
            "invite_only_instance_refuses_registration",
            false,
            StatusCode::FORBIDDEN,
            Some("REGISTRATION_CLOSED"),
        ),
    ];
    for (case, open, want_status, want_code) in cases {
        let h = Harness::new(policy(open, None));
        let (status, _, info) = call(&h.app(), "GET", "/api/v1/instance", None, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        assert_eq!(
            info,
            json!({ "registration_open": open, "owner_claimed": false }),
            "case {case}"
        );
        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/auth/register",
            None,
            json!({ "email": "new@example.com", "password": PASSWORD, "display_name": "Newcomer" }),
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        assert_eq!(body["code"].as_str(), want_code, "case {case}");
        if status == StatusCode::CREATED {
            assert_eq!(
                body["user"]["instance_role"],
                json!("MEMBER"),
                "case {case}"
            );
        }
    }
}

#[tokio::test]
async fn sec10_campaign_creation_requires_host_or_owner() {
    // (case_id, instance role, expected status, expected code)
    let cases = [
        (
            "member_cannot_create",
            InstanceRole::Member,
            StatusCode::FORBIDDEN,
            Some("HOST_REQUIRED"),
        ),
        (
            "host_creates",
            InstanceRole::Host,
            StatusCode::CREATED,
            None,
        ),
        (
            "owner_creates",
            InstanceRole::Owner,
            StatusCode::CREATED,
            None,
        ),
    ];
    for (case, role, want_status, want_code) in cases {
        let h = Harness::dev();
        let (_, cookie) = h.account(role).await;
        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/campaigns",
            Some(&cookie),
            json!({ "name": "Curse of Strahd" }),
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        assert_eq!(body["code"].as_str(), want_code, "case {case}");
    }
}

#[tokio::test]
async fn sec10_owner_administers_instance_roles() {
    /// Whose role the request changes.
    #[derive(Clone, Copy)]
    enum Target {
        Member,
        Host,
        CallerSelf,
        Unknown,
    }
    // (case_id, caller role, target, requested role, expected status, expected code,
    //  target may create campaigns afterwards)
    let cases = [
        (
            "owner_promotes_member_to_host",
            InstanceRole::Owner,
            Target::Member,
            "HOST",
            StatusCode::OK,
            None,
            Some(true),
        ),
        (
            "owner_demotes_host_to_member",
            InstanceRole::Owner,
            Target::Host,
            "member",
            StatusCode::OK,
            None,
            Some(false),
        ),
        (
            "owner_cannot_demote_self",
            InstanceRole::Owner,
            Target::CallerSelf,
            "MEMBER",
            StatusCode::CONFLICT,
            Some("CANNOT_CHANGE_OWNER"),
            None,
        ),
        (
            "owner_role_cannot_be_granted",
            InstanceRole::Owner,
            Target::Member,
            "OWNER",
            StatusCode::BAD_REQUEST,
            Some("INVALID_INSTANCE_ROLE"),
            Some(false),
        ),
        (
            "unknown_user_not_found",
            InstanceRole::Owner,
            Target::Unknown,
            "HOST",
            StatusCode::NOT_FOUND,
            Some("USER_NOT_FOUND"),
            None,
        ),
        (
            "host_cannot_promote",
            InstanceRole::Host,
            Target::Member,
            "HOST",
            StatusCode::FORBIDDEN,
            Some("OWNER_REQUIRED"),
            Some(false),
        ),
    ];
    for (case, caller_role, target, requested, want_status, want_code, can_create) in cases {
        let h = Harness::dev();
        let (caller_id, caller) = h.account(caller_role).await;
        let (member_id, member) = h.account(InstanceRole::Member).await;
        let (host_id, host) = h.account(InstanceRole::Host).await;
        let (target_id, target_cookie) = match target {
            Target::Member => (member_id, member),
            Target::Host => (host_id, host),
            Target::CallerSelf => (caller_id, caller.clone()),
            Target::Unknown => (Uuid::new_v4(), String::new()),
        };
        let (status, _, body) = call(
            &h.app(),
            "PUT",
            &format!("/api/v1/instance/users/{target_id}/role"),
            Some(&caller),
            json!({ "instance_role": requested }),
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        assert_eq!(body["code"].as_str(), want_code, "case {case}");
        if status == StatusCode::OK {
            assert_eq!(
                body["user"]["instance_role"],
                json!(requested.to_uppercase()),
                "case {case}"
            );
        }
        if let Some(can_create) = can_create {
            let (status, _, body) = call(
                &h.app(),
                "POST",
                "/api/v1/campaigns",
                Some(&target_cookie),
                json!({ "name": "After role change" }),
            )
            .await;
            assert_eq!(
                status == StatusCode::CREATED,
                can_create,
                "case {case}: {body}"
            );
        }
    }
}

#[tokio::test]
async fn sec10_only_owner_lists_users() {
    // (case_id, caller role, expected status)
    let cases = [
        ("owner_lists_all_users", InstanceRole::Owner, StatusCode::OK),
        ("host_forbidden", InstanceRole::Host, StatusCode::FORBIDDEN),
        (
            "member_forbidden",
            InstanceRole::Member,
            StatusCode::FORBIDDEN,
        ),
    ];
    for (case, role, want_status) in cases {
        let h = Harness::dev();
        let (_, caller) = h.account(role).await;
        let (member_id, _) = h.account(InstanceRole::Member).await;
        let (status, _, body) = call(
            &h.app(),
            "GET",
            "/api/v1/instance/users",
            Some(&caller),
            Value::Null,
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        if status != StatusCode::OK {
            assert_eq!(body["code"], json!("OWNER_REQUIRED"), "case {case}");
            continue;
        }
        let users = body["users"].as_array().unwrap();
        assert_eq!(users.len(), 2, "case {case}: {body}");
        let member = users.iter().find(|u| u["id"] == json!(member_id)).unwrap();
        assert_eq!(member["instance_role"], json!("MEMBER"), "case {case}");
        assert_eq!(member["totp_enabled"], json!(false), "case {case}");
    }
}

// ---------------------------------------------------------------------------
// SEC7 / D3 — campaign invite limits
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec7_invite_creation_is_bounded_and_gm_only() {
    let week = MAX_INVITE_TTL_SECONDS;
    // (case_id, minted by the GM, body, expected status, expected code, (ttl, max_uses))
    type Case = (
        &'static str,
        bool,
        Value,
        StatusCode,
        Option<&'static str>,
        Option<(u64, u64)>,
    );
    let cases: Vec<Case> = vec![
        (
            "empty_body_defaults_to_seven_days_and_eight_uses",
            true,
            Value::Null,
            StatusCode::CREATED,
            None,
            Some((week, 8)),
        ),
        (
            "ttl_above_seven_days_is_clamped",
            true,
            json!({ "ttl_seconds": 30 * 24 * 3600, "max_uses": 3 }),
            StatusCode::CREATED,
            None,
            Some((week, 3)),
        ),
        (
            "short_ttl_is_kept",
            true,
            json!({ "ttl_seconds": 3600 }),
            StatusCode::CREATED,
            None,
            Some((3600, 8)),
        ),
        (
            "zero_max_uses_rejected",
            true,
            json!({ "max_uses": 0 }),
            StatusCode::BAD_REQUEST,
            Some("INVALID_MAX_USES"),
            None,
        ),
        (
            "max_uses_above_cap_rejected",
            true,
            json!({ "max_uses": 101 }),
            StatusCode::BAD_REQUEST,
            Some("INVALID_MAX_USES"),
            None,
        ),
        (
            "player_cannot_mint",
            false,
            Value::Null,
            StatusCode::FORBIDDEN,
            Some("GM_REQUIRED"),
            None,
        ),
    ];
    for (case, as_gm, body, want_status, want_code, want_limits) in cases {
        let h = Harness::dev();
        let (campaign_id, _, gm) = h.campaign().await;
        let (player_id, player) = h.account(InstanceRole::Member).await;
        h.store()
            .assign_campaign_member(campaign_id, player_id, None, "PLAYER")
            .await
            .unwrap();
        let caller = if as_gm { gm } else { player };
        let (status, _, resp) = call(
            &h.app(),
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/invites"),
            Some(&caller),
            body,
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {resp}");
        assert_eq!(resp["code"].as_str(), want_code, "case {case}");
        let Some((ttl, max_uses)) = want_limits else {
            continue;
        };
        let invite = &resp["invite"];
        let token = invite["token"].as_str().unwrap();
        assert_eq!(
            invite["invite_url"],
            json!(format!("{ORIGIN}/?invite={token}")),
            "case {case}"
        );
        assert_eq!(
            invite["expires_at"].as_u64().unwrap() - invite["created_at"].as_u64().unwrap(),
            ttl,
            "case {case}"
        );
        assert_eq!(invite["max_uses"], json!(max_uses), "case {case}");
        assert_eq!(invite["use_count"], json!(0), "case {case}");
        assert_eq!(invite["status"], json!("active"), "case {case}");
    }
}

#[tokio::test]
async fn sec7_minting_replaces_the_active_invite() {
    let h = Harness::dev();
    let (campaign_id, _, gm) = h.campaign().await;
    let first = h.mint(campaign_id, &gm, Value::Null).await;
    let second = h.mint(campaign_id, &gm, json!({ "max_uses": 2 })).await;

    let (status, _, body) = call(
        &h.app(),
        "GET",
        &format!("/api/v1/campaigns/{campaign_id}/invites/active"),
        Some(&gm),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["invite"]["id"], second["id"]);
    assert_eq!(body["invite"]["token"], Value::Null, "raw token shown once");
    assert_eq!(body["invite"]["invite_url"], Value::Null);

    let (status, _, body) = call(
        &h.app(),
        "POST",
        "/api/v1/invites/redeem",
        None,
        visitor(first["token"].as_str().unwrap(), "late@example.com"),
    )
    .await;
    assert_eq!(status, StatusCode::GONE, "{body}");
    assert_eq!(body["code"], json!("INVITE_REVOKED"));
}

#[tokio::test]
async fn sec7_redemption_enforces_expiry_revocation_and_max_uses() {
    /// How the invite reaches its tested state before the redemption under test.
    #[derive(Clone, Copy)]
    enum Setup {
        Active,
        Expired,
        RevokedByGm,
        ExhaustedAfterOneUse,
        UnknownToken,
    }
    // (case_id, setup, expected status, expected code)
    let cases = [
        (
            "active_invite_redeems",
            Setup::Active,
            StatusCode::CREATED,
            None,
        ),
        (
            "expired_invite_refused",
            Setup::Expired,
            StatusCode::GONE,
            Some("INVITE_EXPIRED"),
        ),
        (
            "revoked_invite_refused",
            Setup::RevokedByGm,
            StatusCode::GONE,
            Some("INVITE_REVOKED"),
        ),
        (
            "exhausted_invite_refused",
            Setup::ExhaustedAfterOneUse,
            StatusCode::GONE,
            Some("INVITE_EXHAUSTED"),
        ),
        (
            "unknown_token_not_found",
            Setup::UnknownToken,
            StatusCode::NOT_FOUND,
            Some("INVITE_NOT_FOUND"),
        ),
    ];
    for (case, setup, want_status, want_code) in cases {
        let h = Harness::dev();
        let (campaign_id, gm_id, gm) = h.campaign().await;
        let token = match setup {
            Setup::Active | Setup::RevokedByGm => {
                h.mint(campaign_id, &gm, Value::Null).await["token"]
                    .as_str()
                    .unwrap()
                    .to_string()
            }
            Setup::ExhaustedAfterOneUse => {
                let token = h.mint(campaign_id, &gm, json!({ "max_uses": 1 })).await["token"]
                    .as_str()
                    .unwrap()
                    .to_string();
                let (status, _, body) = call(
                    &h.app(),
                    "POST",
                    "/api/v1/invites/redeem",
                    None,
                    visitor(&token, "first@example.com"),
                )
                .await;
                assert_eq!(status, StatusCode::CREATED, "case {case}: {body}");
                token
            }
            Setup::Expired => {
                let token = "e".repeat(64);
                let now = now_epoch_seconds();
                h.store()
                    .create_campaign_invite(CampaignInviteRecord {
                        id: Uuid::new_v4(),
                        campaign_id,
                        token_hash: hash_session_token(&token),
                        created_by: gm_id,
                        created_at: now - 7200,
                        expires_at: now - 1,
                        max_uses: 8,
                        use_count: 0,
                        revoked_at: None,
                    })
                    .await
                    .unwrap();
                token
            }
            Setup::UnknownToken => "a".repeat(64),
        };
        if matches!(setup, Setup::RevokedByGm) {
            let (status, _, body) = call(
                &h.app(),
                "DELETE",
                &format!("/api/v1/campaigns/{campaign_id}/invites/active"),
                Some(&gm),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "case {case}");
            assert_eq!(body["invite"]["status"], json!("revoked"), "case {case}");
        }
        let users_before = h.store().list_users().await.unwrap().len();
        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/invites/redeem",
            None,
            visitor(&token, "visitor@example.com"),
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        assert_eq!(body["code"].as_str(), want_code, "case {case}");
        let users_after = h.store().list_users().await.unwrap().len();
        let created = status == StatusCode::CREATED;
        assert_eq!(
            users_after,
            users_before + usize::from(created),
            "case {case}: refused redemptions create no account"
        );
    }
}

#[tokio::test]
async fn sec7_revoking_without_invite_is_not_found() {
    let h = Harness::dev();
    let (campaign_id, _, gm) = h.campaign().await;
    let (status, _, body) = call(
        &h.app(),
        "DELETE",
        &format!("/api/v1/campaigns/{campaign_id}/invites/active"),
        Some(&gm),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], json!("NO_ACTIVE_INVITE"));
    let (status, _, body) = call(
        &h.app(),
        "GET",
        &format!("/api/v1/campaigns/{campaign_id}/invites/active"),
        Some(&gm),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "invite": null }));
}

// ---------------------------------------------------------------------------
// D2 — InviteRedemption
// ---------------------------------------------------------------------------

#[tokio::test]
async fn d2_invite_redemption_creates_account_or_only_membership() {
    /// Who presents the invite.
    #[derive(Clone, Copy)]
    enum Redeemer {
        Visitor,
        LoggedInAccount,
        ExistingPlayer,
        VisitorWithTakenEmail,
    }
    // (case_id, redeemer, expected status, expected code, account created, already member,
    //  use_count after)
    let cases = [
        (
            "visitor_creates_member_account_and_player_membership",
            Redeemer::Visitor,
            StatusCode::CREATED,
            None,
            true,
            false,
            1,
        ),
        (
            "logged_in_account_only_gains_membership",
            Redeemer::LoggedInAccount,
            StatusCode::OK,
            None,
            false,
            false,
            1,
        ),
        (
            "existing_player_consumes_no_use",
            Redeemer::ExistingPlayer,
            StatusCode::OK,
            None,
            false,
            true,
            0,
        ),
        (
            "visitor_with_taken_email_conflicts",
            Redeemer::VisitorWithTakenEmail,
            StatusCode::CONFLICT,
            Some("EMAIL_ALREADY_EXISTS"),
            false,
            false,
            0,
        ),
    ];
    for (case, redeemer, want_status, want_code, want_created, want_already, want_uses) in cases {
        let h = Harness::dev();
        let (campaign_id, _, gm) = h.campaign().await;
        let token = h.mint(campaign_id, &gm, Value::Null).await["token"]
            .as_str()
            .unwrap()
            .to_string();
        let (account_id, account_cookie) = h
            .account_with(InstanceRole::Member, "taken@example.com", None)
            .await;
        if matches!(redeemer, Redeemer::ExistingPlayer) {
            h.store()
                .assign_campaign_member(campaign_id, account_id, None, "PLAYER")
                .await
                .unwrap();
        }
        let (cookie, body) = match redeemer {
            Redeemer::Visitor => (None, visitor(&token, "new@example.com")),
            Redeemer::VisitorWithTakenEmail => (None, visitor(&token, "taken@example.com")),
            Redeemer::LoggedInAccount | Redeemer::ExistingPlayer => {
                (Some(account_cookie.as_str()), json!({ "token": token }))
            }
        };
        let users_before = h.store().list_users().await.unwrap().len();
        let (status, headers, resp) =
            call(&h.app(), "POST", "/api/v1/invites/redeem", cookie, body).await;
        assert_eq!(status, want_status, "case {case}: {resp}");
        assert_eq!(resp["code"].as_str(), want_code, "case {case}");
        let users_after = h.store().list_users().await.unwrap().len();
        assert_eq!(
            users_after,
            users_before + usize::from(want_created),
            "case {case}: account count"
        );

        let (_, _, active) = call(
            &h.app(),
            "GET",
            &format!("/api/v1/campaigns/{campaign_id}/invites/active"),
            Some(&gm),
            Value::Null,
        )
        .await;
        assert_eq!(
            active["invite"]["use_count"],
            json!(want_uses),
            "case {case}"
        );
        if resp["code"].is_string() {
            assert_eq!(
                h.member_role(campaign_id, account_id).await,
                None,
                "case {case}"
            );
            continue;
        }

        assert_eq!(resp["campaign_id"], json!(campaign_id), "case {case}");
        assert_eq!(resp["role"], json!("PLAYER"), "case {case}");
        assert_eq!(resp["account_created"], json!(want_created), "case {case}");
        assert_eq!(resp["already_member"], json!(want_already), "case {case}");
        assert_eq!(
            resp["user"]["instance_role"],
            json!("MEMBER"),
            "case {case}"
        );
        let user_id = Uuid::parse_str(resp["user"]["id"].as_str().unwrap()).unwrap();
        assert_eq!(
            h.member_role(campaign_id, user_id).await.as_deref(),
            Some("PLAYER"),
            "case {case}"
        );
        if want_created {
            let new_cookie = session_cookie(&headers).expect("new account session cookie");
            let (status, _, me) = call(
                &h.app(),
                "GET",
                "/api/v1/auth/me",
                Some(&new_cookie),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "case {case}");
            assert_eq!(me["user"]["is_guest"], json!(false), "case {case}");
            assert_eq!(me["user"]["display_name"], json!("Sildar"), "case {case}");
        } else {
            assert_eq!(user_id, account_id, "case {case}: same account");
            assert!(session_cookie(&headers).is_none(), "case {case}");
        }
    }
}

#[tokio::test]
async fn d2_gm_lists_redemptions_and_previews_invite() {
    let h = Harness::dev();
    let (campaign_id, _, gm) = h.campaign().await;
    let token = h.mint(campaign_id, &gm, Value::Null).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, _, preview) = call(
        &h.app(),
        "POST",
        "/api/v1/invites/preview",
        None,
        json!({ "token": token }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["campaign_id"], json!(campaign_id));
    assert_eq!(preview["campaign_name"], json!("Lost Mine"));
    assert_eq!(preview["status"], json!("active"));

    for email in ["one@example.com", "two@example.com"] {
        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/invites/redeem",
            None,
            visitor(&token, email),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{email}: {body}");
    }

    // (case_id, caller is the GM, expected status, expected redemption count)
    let (_, player) = h.account(InstanceRole::Member).await;
    let cases = [
        (
            "gm_lists_both_redemptions",
            Some(gm.as_str()),
            StatusCode::OK,
            2,
        ),
        (
            "non_member_forbidden",
            Some(player.as_str()),
            StatusCode::FORBIDDEN,
            0,
        ),
        ("anonymous_unauthorized", None, StatusCode::UNAUTHORIZED, 0),
    ];
    for (case, cookie, want_status, want_count) in cases {
        let (status, _, body) = call(
            &h.app(),
            "GET",
            &format!("/api/v1/campaigns/{campaign_id}/invites/redemptions"),
            cookie,
            Value::Null,
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        if status == StatusCode::OK {
            let redemptions = body["redemptions"].as_array().unwrap();
            assert_eq!(redemptions.len(), want_count, "case {case}");
            assert!(
                redemptions
                    .iter()
                    .all(|r| r["display_name"] == json!("Sildar")
                        && r["campaign_id"] == json!(campaign_id)),
                "case {case}: {body}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// SEC13 — member removal closes live sockets
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec13_removing_member_closes_their_sockets() {
    /// Membership of the user the GM removes.
    #[derive(Clone, Copy)]
    enum Target {
        ConnectedPlayer,
        OfflinePlayer,
        Gm,
        NonMember,
    }
    // (case_id, target, expected status, expected code, sessions closed)
    let cases = [
        (
            "connected_player_is_disconnected",
            Target::ConnectedPlayer,
            StatusCode::OK,
            None,
            2,
        ),
        (
            "offline_player_removed_without_sockets",
            Target::OfflinePlayer,
            StatusCode::OK,
            None,
            0,
        ),
        (
            "gm_cannot_be_removed",
            Target::Gm,
            StatusCode::CONFLICT,
            Some("CANNOT_REMOVE_GM"),
            0,
        ),
        (
            "non_member_not_found",
            Target::NonMember,
            StatusCode::NOT_FOUND,
            Some("MEMBER_NOT_FOUND"),
            0,
        ),
    ];
    for (case, target, want_status, want_code, want_closed) in cases {
        let h = Harness::dev();
        let (campaign_id, gm_id, gm) = h.campaign().await;
        let (player_id, _) = h.account(InstanceRole::Member).await;
        if !matches!(target, Target::NonMember) {
            h.store()
                .assign_campaign_member(campaign_id, player_id, None, "PLAYER")
                .await
                .unwrap();
        }
        let room = h
            .state
            .lease_manager
            .get_or_wake_room(campaign_id)
            .await
            .unwrap();
        let (gm_tx, mut gm_rx) = trame_server::room::client_channel();
        room.connect_client(ConnectedClient {
            session_id: Uuid::new_v4(),
            user_id: gm_id,
            role: CampaignRole::Gm,
            tx: gm_tx,
        })
        .await
        .unwrap();
        let mut player_rxs = Vec::new();
        if matches!(target, Target::ConnectedPlayer) {
            for _ in 0..2 {
                let (tx, mut rx) = trame_server::room::client_channel();
                room.connect_client(ConnectedClient {
                    session_id: Uuid::new_v4(),
                    user_id: player_id,
                    role: CampaignRole::Player,
                    tx,
                })
                .await
                .unwrap();
                let _snapshot = rx.recv().await;
                player_rxs.push(rx);
            }
        }
        let _gm_snapshot = gm_rx.recv().await;

        let target_id = if matches!(target, Target::Gm) {
            gm_id
        } else {
            player_id
        };
        let (status, _, body) = call(
            &h.app(),
            "DELETE",
            &format!("/api/v1/campaigns/{campaign_id}/members/{target_id}"),
            Some(&gm),
            Value::Null,
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        assert_eq!(body["code"].as_str(), want_code, "case {case}");
        if status == StatusCode::OK {
            assert_eq!(
                body,
                json!({ "removed": true, "disconnected_sessions": want_closed }),
                "case {case}"
            );
            assert!(
                resolve_campaign_role(&h.state, campaign_id, player_id)
                    .await
                    .is_none(),
                "case {case}: reconnect refused"
            );
        }
        for rx in &mut player_rxs {
            match rx.recv().await {
                Some(OutboundClientFrame::Close { code, .. }) => {
                    assert_eq!(code, WS_CLOSE_CODE_MEMBERSHIP_REVOKED, "case {case}");
                }
                other => panic!("case {case}: expected Close 4403, got {other:?}"),
            }
        }
        assert!(
            gm_rx.try_recv().is_err(),
            "case {case}: GM socket untouched"
        );
        let metrics = room.metrics().await.unwrap();
        assert_eq!(
            metrics.active_connections, 1,
            "case {case}: only the GM remains"
        );
    }
}

#[tokio::test]
async fn sec13_removed_member_cannot_replay_the_invite_they_redeemed() {
    // (case_id, GM mints a fresh invite after the removal, expected status, expected code)
    let cases = [
        (
            "same_invite_rejected",
            false,
            StatusCode::FORBIDDEN,
            Some("MEMBER_REMOVED"),
        ),
        ("new_invite_readmits", true, StatusCode::OK, None),
    ];
    for (case, fresh_invite, want_status, want_code) in cases {
        let h = Harness::dev();
        let (campaign_id, _, gm) = h.campaign().await;
        let (player_id, player) = h.account(InstanceRole::Member).await;
        let mint_body = json!({ "max_uses": 5 });
        let token = h.mint(campaign_id, &gm, mint_body.clone()).await["token"].clone();
        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/invites/redeem",
            Some(&player),
            json!({ "token": token }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");
        let (status, _, _) = call(
            &h.app(),
            "DELETE",
            &format!("/api/v1/campaigns/{campaign_id}/members/{player_id}"),
            Some(&gm),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");

        let token = if fresh_invite {
            h.mint(campaign_id, &gm, mint_body).await["token"].clone()
        } else {
            token
        };
        let (status, _, body) = call(
            &h.app(),
            "POST",
            "/api/v1/invites/redeem",
            Some(&player),
            json!({ "token": token }),
        )
        .await;
        assert_eq!(status, want_status, "case {case}: {body}");
        assert_eq!(body["code"].as_str(), want_code, "case {case}");
        assert_eq!(
            h.member_role(campaign_id, player_id).await.is_some(),
            fresh_invite,
            "case {case}: membership"
        );
    }
}

// ---------------------------------------------------------------------------
// In-memory store lock order
// ---------------------------------------------------------------------------

/// One store operation that nests the `users`, `emails`, or `oauth_identities` locks.
#[derive(Clone, Copy, Debug)]
enum LockingOp {
    LookupByEmail,
    BindGuestEmail,
    LookupByOAuth,
    BindOAuth,
    RedeemAsNewAccount,
}

async fn run_locking_op(store: &InMemorySessionStore, op: LockingOp, token_hash: &str) {
    use trame_server::auth::accounts::{AccountStore, InviteRedeemer, new_account};
    use trame_server::auth::session::{OAuthProvider, OAuthStore};
    let email = format!("{}@example.com", Uuid::new_v4());
    match op {
        LockingOp::LookupByEmail => {
            store.get_user_by_email("racer@example.com").await.unwrap();
        }
        LockingOp::LookupByOAuth => {
            store
                .find_user_by_oauth_identity(OAuthProvider::Discord, "racer")
                .await
                .unwrap();
        }
        LockingOp::BindGuestEmail | LockingOp::BindOAuth => {
            let guest = store.create_guest_user("PLAYER").await.unwrap();
            if matches!(op, LockingOp::BindGuestEmail) {
                store
                    .bind_guest_credentials(guest.id, &email, "hash")
                    .await
                    .unwrap();
            } else {
                store
                    .bind_oauth_identity(guest.id, OAuthProvider::Discord, "racer", Some(&email))
                    .await
                    .unwrap();
            }
        }
        LockingOp::RedeemAsNewAccount => {
            let user = new_account(email, "Racer".into(), "hash".into(), InstanceRole::Member);
            let _ = store
                .redeem_campaign_invite(token_hash, InviteRedeemer::NewAccount(user), 0)
                .await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn in_memory_store_operations_never_deadlock_each_other() {
    use trame_server::auth::accounts::AccountStore;
    // (case_id, operation racing against the other, the other)
    let cases = [
        (
            "email_lookup_vs_guest_bind",
            LockingOp::LookupByEmail,
            LockingOp::BindGuestEmail,
        ),
        (
            "email_lookup_vs_invite_signup",
            LockingOp::LookupByEmail,
            LockingOp::RedeemAsNewAccount,
        ),
        (
            "invite_signup_vs_guest_bind",
            LockingOp::RedeemAsNewAccount,
            LockingOp::BindGuestEmail,
        ),
        (
            "oauth_lookup_vs_oauth_bind",
            LockingOp::LookupByOAuth,
            LockingOp::BindOAuth,
        ),
    ];
    for (case, a, b) in cases {
        let store = Arc::new(InMemorySessionStore::new());
        let token_hash = hash_session_token("race-invite");
        store
            .create_campaign_invite(CampaignInviteRecord {
                id: Uuid::new_v4(),
                campaign_id: Uuid::new_v4(),
                token_hash: token_hash.clone(),
                created_by: Uuid::new_v4(),
                created_at: 0,
                expires_at: u64::MAX,
                max_uses: u32::MAX,
                use_count: 0,
                revoked_at: None,
            })
            .await
            .unwrap();
        let racers = [a, b, a, b].map(|op| {
            let store = store.clone();
            let token_hash = token_hash.clone();
            tokio::spawn(async move {
                for _ in 0..300 {
                    run_locking_op(&store, op, &token_hash).await;
                }
            })
        });
        let all = futures_util::future::join_all(racers);
        let finished = tokio::time::timeout(Duration::from_secs(20), all).await;
        assert!(finished.is_ok(), "case {case}: store operations deadlocked");
    }
}

// ---------------------------------------------------------------------------
// SEC11 — persisted instance id
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sec11_instance_id_persists_and_override_wins() {
    let store: Arc<dyn FullAuthStore> = Arc::new(InMemorySessionStore::new());
    let persisted = resolve_instance_id(store.as_ref(), None).await.unwrap();
    let override_id = Uuid::new_v4();
    // (case_id, TRAME_INSTANCE_ID override, expected id)
    let cases = [
        (
            "restart_without_override_reuses_persisted_id",
            None,
            persisted,
        ),
        (
            "override_wins_without_rewriting_persisted_id",
            Some(override_id),
            override_id,
        ),
        (
            "override_removed_falls_back_to_persisted_id",
            None,
            persisted,
        ),
        ("override_equal_to_persisted_id", Some(persisted), persisted),
    ];
    for (case, override_id, want) in cases {
        let got = resolve_instance_id(store.as_ref(), override_id)
            .await
            .unwrap();
        assert_eq!(got, want, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// D2 / D16 — /auth/me flags
// ---------------------------------------------------------------------------

#[tokio::test]
async fn d16_auth_me_exposes_guest_totp_and_instance_role() {
    // (case_id, is_guest, totp secret enabled, instance role)
    let cases = [
        ("member_without_totp", false, false, InstanceRole::Member),
        ("host_with_totp", false, true, InstanceRole::Host),
        ("legacy_guest_needs_bind", true, false, InstanceRole::Member),
    ];
    for (case, is_guest, totp, role) in cases {
        let h = Harness::dev();
        let user_id = Uuid::new_v4();
        h.store()
            .save_user(UserRecord {
                id: user_id,
                username: "Gundren".to_string(),
                role: "PLAYER".to_string(),
                is_guest,
                created_at: 0,
                email: (!is_guest).then(|| format!("{user_id}@example.com")),
                password_hash: None,
                mfa_enabled: totp,
                totp_secret: totp.then(|| "JBSWY3DPEHPK3PXP".to_string()),
                pending_totp_secret: None,
                instance_role: role,
            })
            .await
            .unwrap();
        let token = format!("me-{user_id}");
        h.store()
            .create_session(user_id, &hash_session_token(&token), 3600)
            .await
            .unwrap();
        let cookie = format!("trame_session={token}");
        let (status, _, body) = call(
            &h.app(),
            "GET",
            "/api/v1/auth/me",
            Some(&cookie),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}");
        let user = &body["user"];
        assert_eq!(user["is_guest"], json!(is_guest), "case {case}");
        assert_eq!(user["totp_enabled"], json!(totp), "case {case}");
        assert_eq!(user["instance_role"], json!(role.as_str()), "case {case}");
    }
}
