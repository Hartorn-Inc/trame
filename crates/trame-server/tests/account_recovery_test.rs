//! ============================================================================
//! ACCOUNT RECOVERY SUITE (account_recovery_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Exercises spec story 15 recovery through the production auth router on
//!   the in-memory store: Owner-minted one-time reset links (hashed, 24 h,
//!   single use, replacing older links, revoking sessions), the signed-in
//!   password change (current password, TOTP when enrolled), the CLI helper
//!   that mints the Owner's own link, and the credential rate limit.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Every test builds its own store and router, so the single `Owner`
//!     never leaks between cases.
//!   - Rate limits are generous except in the test that asserts the limit.
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;
use trame_server::auth::accounts::InstanceRole;
use trame_server::auth::magic_link::{MagicLinkService, now_epoch_seconds};
use trame_server::auth::password::PasswordService;
use trame_server::auth::recovery::{
    PASSWORD_RESET_TTL_SECONDS, PasswordResetLookup, PasswordResetRecord, mint_owner_password_reset,
};
use trame_server::auth::session::{
    AuthState, FullAuthStore, IdentityStore, InMemorySessionStore, SessionStore, UserRecord,
    build_auth_router, hash_session_token,
};
use trame_server::auth::totp::TotpService;
use trame_server::security::{AuthRateLimiter, RateLimit, SecurityPolicy};
use uuid::Uuid;

const ORIGIN: &str = "https://table.example.com";
const OLD_PASSWORD: &str = "correct-horse-battery-staple-42";
const NEW_PASSWORD: &str = "new-lantern-over-phandalin-77";

struct Harness {
    state: AuthState,
}

impl Harness {
    fn new(max_attempts: u32) -> Self {
        let limit = RateLimit {
            max_attempts,
            window: Duration::from_secs(60),
        };
        let policy = SecurityPolicy {
            rate_limiter: AuthRateLimiter::new(limit, limit),
            public_origin: Some(ORIGIN.to_string()),
            ..SecurityPolicy::default()
        };
        Self {
            state: AuthState::with_security(
                Arc::new(MagicLinkService::new(
                    b"recovery-test-secret-at-least-32-bytes".to_vec(),
                    "trame-test",
                )),
                Arc::new(InMemorySessionStore::new()),
                Arc::new(TotpService::default()),
                Arc::new(policy),
            ),
        }
    }

    fn generous() -> Self {
        Self::new(10_000)
    }

    fn app(&self) -> Router {
        build_auth_router(self.state.clone())
    }

    fn store(&self) -> &Arc<dyn FullAuthStore> {
        &self.state.session_store
    }

    /// Saves an account with `OLD_PASSWORD`; returns `(user_id, email)`.
    async fn account(&self, role: InstanceRole, is_guest: bool) -> (Uuid, String) {
        let user_id = Uuid::new_v4();
        let email = format!("{user_id}@example.com");
        self.store()
            .save_user(UserRecord {
                id: user_id,
                username: format!("user-{}", &user_id.to_string()[..8]),
                role: "PLAYER".to_string(),
                is_guest,
                created_at: 0,
                email: (!is_guest).then(|| email.clone()),
                password_hash: Some(PasswordService::new().hash_password(OLD_PASSWORD).unwrap()),
                mfa_enabled: false,
                totp_secret: None,
                pending_totp_secret: None,
                instance_role: role,
            })
            .await
            .unwrap();
        (user_id, email)
    }

    /// Opens a session for `user_id`; returns its cookie header.
    async fn session(&self, user_id: Uuid) -> String {
        let token = format!("recovery-session-{}", Uuid::new_v4());
        self.store()
            .create_session(user_id, &hash_session_token(&token), 3600)
            .await
            .unwrap();
        format!("trame_session={token}")
    }

    /// Enrolls TOTP on `user_id`; returns the raw secret.
    async fn enroll_totp(&self, user_id: Uuid) -> Vec<u8> {
        let secret = b"recovery-totp-secret".to_vec();
        let mut user = self.store().get_user_by_id(user_id).await.unwrap().unwrap();
        user.mfa_enabled = true;
        user.totp_secret = Some(self.state.totp_service.encrypt_secret(&secret).unwrap());
        self.store().save_user(user).await.unwrap();
        secret
    }

    /// Owner mints a link for `target`; returns the raw token.
    async fn mint(&self, owner_cookie: &str, target: Uuid) -> String {
        let (status, body) = call(
            &self.app(),
            &format!("/api/v1/instance/users/{target}/password-reset"),
            Some(owner_cookie),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let url = body["reset_url"].as_str().unwrap();
        let prefix = format!("{ORIGIN}/reset-password?token=");
        assert!(url.starts_with(&prefix), "{url}");
        let expires_at = body["expires_at"].as_u64().unwrap();
        assert!(expires_at <= now_epoch_seconds() + PASSWORD_RESET_TTL_SECONDS);
        url[prefix.len()..].to_string()
    }

    async fn reset_status(&self, token: &str) -> Value {
        let (status, body) = call(
            &self.app(),
            "/api/v1/auth/password-reset/status",
            None,
            json!({ "token": token }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn reset(&self, token: &str, password: &str) -> (StatusCode, Value) {
        call(
            &self.app(),
            "/api/v1/auth/password-reset",
            None,
            json!({ "token": token, "new_password": password }),
        )
        .await
    }

    async fn login(&self, email: &str, password: &str) -> StatusCode {
        call(
            &self.app(),
            "/api/v1/auth/login",
            None,
            json!({ "email": email, "password": password }),
        )
        .await
        .0
    }

    async fn me(&self, cookie: &str) -> StatusCode {
        let resp = self
            .app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/auth/me")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        resp.status()
    }
}

/// `POST uri` with an optional cookie; returns `(status, json body)`.
async fn call(app: &Router, uri: &str, cookie: Option<&str>, body: Value) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn owner_reset_link_sets_a_new_password_once_and_revokes_sessions() {
    let h = Harness::generous();
    let (owner_id, _) = h.account(InstanceRole::Owner, false).await;
    let owner = h.session(owner_id).await;
    let (member_id, email) = h.account(InstanceRole::Member, false).await;
    let stolen = h.session(member_id).await;

    let token = h.mint(&owner, member_id).await;
    let status = h.reset_status(&token).await;
    assert_eq!(status["status"], "valid");
    assert_eq!(status["email"], email.as_str());

    let (code, body) = h.reset(&token, NEW_PASSWORD).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(
        h.me(&stolen).await,
        StatusCode::UNAUTHORIZED,
        "old sessions are revoked"
    );
    assert_eq!(
        h.me(&owner).await,
        StatusCode::OK,
        "other accounts keep their sessions"
    );
    assert_eq!(
        h.login(&email, OLD_PASSWORD).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(h.login(&email, NEW_PASSWORD).await, StatusCode::OK);

    let (replay, body) = h.reset(&token, "another-strong-passphrase-99").await;
    assert_eq!(replay, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "INVALID_RESET_TOKEN", "a link works once");
    assert_eq!(h.reset_status(&token).await["status"], "invalid");
    assert!(h.reset_status(&token).await.get("email").is_none());
}

#[tokio::test]
async fn minting_a_new_link_replaces_the_previous_one() {
    let h = Harness::generous();
    let (owner_id, _) = h.account(InstanceRole::Owner, false).await;
    let owner = h.session(owner_id).await;
    let (member_id, _) = h.account(InstanceRole::Member, false).await;
    let first = h.mint(&owner, member_id).await;
    let second = h.mint(&owner, member_id).await;
    assert_eq!(h.reset_status(&first).await["status"], "invalid");
    assert_eq!(h.reset_status(&second).await["status"], "valid");
}

/// Who asks to mint a link, for whom.
#[derive(Debug, Clone, Copy)]
enum MintCase {
    MemberCaller,
    HostCaller,
    NoSession,
    UnknownTarget,
    GuestTarget,
    OwnerForThemself,
}

#[tokio::test]
async fn only_the_owner_mints_links_for_real_accounts() {
    // (case_id, case, expected status, expected code)
    let cases = [
        (
            "member_caller_is_refused",
            MintCase::MemberCaller,
            StatusCode::FORBIDDEN,
            Some("OWNER_REQUIRED"),
        ),
        (
            "host_caller_is_refused",
            MintCase::HostCaller,
            StatusCode::FORBIDDEN,
            Some("OWNER_REQUIRED"),
        ),
        (
            "anonymous_caller_must_sign_in",
            MintCase::NoSession,
            StatusCode::UNAUTHORIZED,
            Some("UNAUTHORIZED"),
        ),
        (
            "unknown_account_is_not_found",
            MintCase::UnknownTarget,
            StatusCode::NOT_FOUND,
            Some("USER_NOT_FOUND"),
        ),
        (
            "guest_account_has_no_email",
            MintCase::GuestTarget,
            StatusCode::CONFLICT,
            Some("GUEST_ACCOUNT"),
        ),
        (
            "owner_may_reset_their_own_password",
            MintCase::OwnerForThemself,
            StatusCode::CREATED,
            None,
        ),
    ];
    for (case_id, case, expected, code) in cases {
        let h = Harness::generous();
        let (owner_id, _) = h.account(InstanceRole::Owner, false).await;
        let owner = h.session(owner_id).await;
        let (member_id, _) = h.account(InstanceRole::Member, false).await;
        let (caller, target) = match case {
            MintCase::MemberCaller => (Some(h.session(member_id).await), member_id),
            MintCase::HostCaller => {
                let (host_id, _) = h.account(InstanceRole::Host, false).await;
                (Some(h.session(host_id).await), member_id)
            }
            MintCase::NoSession => (None, member_id),
            MintCase::UnknownTarget => (Some(owner.clone()), Uuid::new_v4()),
            MintCase::GuestTarget => (
                Some(owner.clone()),
                h.account(InstanceRole::Member, true).await.0,
            ),
            MintCase::OwnerForThemself => (Some(owner.clone()), owner_id),
        };
        let (status, body) = call(
            &h.app(),
            &format!("/api/v1/instance/users/{target}/password-reset"),
            caller.as_deref(),
            Value::Null,
        )
        .await;
        assert_eq!(status, expected, "case {case_id}: {body}");
        assert_eq!(body["code"].as_str(), code, "case {case_id}");
    }
}

#[tokio::test]
async fn expired_and_unknown_links_are_refused() {
    let h = Harness::generous();
    let (member_id, _) = h.account(InstanceRole::Member, false).await;
    let now = now_epoch_seconds();
    let expired = "e".repeat(64);
    h.store()
        .create_password_reset(PasswordResetRecord {
            token_hash: hash_session_token(&expired),
            user_id: member_id,
            created_by: None,
            created_at: now - 100,
            expires_at: now - 1,
        })
        .await
        .unwrap();
    // (case_id, token, expected status label, expected error code)
    let cases = [
        (
            "expired_link",
            expired.clone(),
            "expired",
            "RESET_TOKEN_EXPIRED",
        ),
        (
            "unknown_link",
            "f".repeat(64),
            "invalid",
            "INVALID_RESET_TOKEN",
        ),
    ];
    for (case_id, token, label, code) in cases {
        assert_eq!(
            h.reset_status(&token).await["status"],
            label,
            "case {case_id}"
        );
        let (status, body) = h.reset(&token, NEW_PASSWORD).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "case {case_id}");
        assert_eq!(body["code"], code, "case {case_id}");
    }
}

#[tokio::test]
async fn a_weak_password_keeps_the_link_usable() {
    let h = Harness::generous();
    let (owner_id, _) = h.account(InstanceRole::Owner, false).await;
    let owner = h.session(owner_id).await;
    let (member_id, _) = h.account(InstanceRole::Member, false).await;
    let token = h.mint(&owner, member_id).await;
    let (status, body) = h.reset(&token, "short").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "WEAK_PASSWORD");
    assert_eq!(h.reset_status(&token).await["status"], "valid");
}

/// TOTP code sent with a password change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TotpInput {
    NotEnrolled,
    Missing,
    Wrong,
    Valid,
}

#[tokio::test]
async fn signed_in_password_change_checks_password_and_totp() {
    // (case_id, current password, new password, totp, expected status, expected code)
    let cases = [
        (
            "correct_password_without_totp_changes_it",
            OLD_PASSWORD,
            NEW_PASSWORD,
            TotpInput::NotEnrolled,
            StatusCode::OK,
            None,
        ),
        (
            "wrong_current_password_is_refused",
            "not-my-password-123",
            NEW_PASSWORD,
            TotpInput::NotEnrolled,
            StatusCode::UNAUTHORIZED,
            Some("INVALID_CREDENTIALS"),
        ),
        (
            "weak_new_password_is_refused",
            OLD_PASSWORD,
            "short",
            TotpInput::NotEnrolled,
            StatusCode::BAD_REQUEST,
            Some("WEAK_PASSWORD"),
        ),
        (
            "enrolled_totp_requires_a_code",
            OLD_PASSWORD,
            NEW_PASSWORD,
            TotpInput::Missing,
            StatusCode::UNAUTHORIZED,
            Some("MFA_REQUIRED"),
        ),
        (
            "enrolled_totp_refuses_a_wrong_code",
            OLD_PASSWORD,
            NEW_PASSWORD,
            TotpInput::Wrong,
            StatusCode::UNAUTHORIZED,
            Some("INVALID_TOTP_CODE"),
        ),
        (
            "enrolled_totp_with_a_valid_code_changes_it",
            OLD_PASSWORD,
            NEW_PASSWORD,
            TotpInput::Valid,
            StatusCode::OK,
            None,
        ),
    ];
    for (case_id, current, new, totp, expected, code) in cases {
        let h = Harness::generous();
        let (user_id, email) = h.account(InstanceRole::Member, false).await;
        let mine = h.session(user_id).await;
        let other_device = h.session(user_id).await;
        let totp_code = match totp {
            TotpInput::NotEnrolled => None,
            TotpInput::Missing => {
                h.enroll_totp(user_id).await;
                None
            }
            TotpInput::Wrong => {
                h.enroll_totp(user_id).await;
                Some("000000".to_string())
            }
            TotpInput::Valid => {
                let secret = h.enroll_totp(user_id).await;
                Some(
                    h.state
                        .totp_service
                        .generate_code(&secret, now_epoch_seconds()),
                )
            }
        };
        let (status, body) = call(
            &h.app(),
            "/api/v1/auth/password",
            Some(&mine),
            json!({ "current_password": current, "new_password": new, "totp_code": totp_code }),
        )
        .await;
        assert_eq!(status, expected, "case {case_id}: {body}");
        assert_eq!(body["code"].as_str(), code, "case {case_id}");
        let changed = expected == StatusCode::OK;
        assert_eq!(
            h.me(&mine).await,
            StatusCode::OK,
            "case {case_id}: the caller stays signed in"
        );
        assert_eq!(
            h.me(&other_device).await,
            if changed {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::OK
            },
            "case {case_id}: other sessions are revoked only on success"
        );
        let (current_pw, stale_pw) = if changed {
            (new, OLD_PASSWORD)
        } else {
            (OLD_PASSWORD, new)
        };
        assert_eq!(
            h.login(&email, stale_pw).await,
            StatusCode::UNAUTHORIZED,
            "case {case_id}"
        );
        if totp == TotpInput::NotEnrolled {
            assert_eq!(
                h.login(&email, current_pw).await,
                StatusCode::OK,
                "case {case_id}"
            );
        }
    }
}

#[tokio::test]
async fn password_change_requires_a_session() {
    let h = Harness::generous();
    let (status, body) = call(
        &h.app(),
        "/api/v1/auth/password",
        None,
        json!({ "current_password": OLD_PASSWORD, "new_password": NEW_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "UNAUTHORIZED");
}

#[tokio::test]
async fn cli_helper_mints_the_owners_link_only_once_claimed() {
    let h = Harness::generous();
    let now = now_epoch_seconds();
    assert!(
        mint_owner_password_reset(h.store().as_ref(), Some(ORIGIN), now)
            .await
            .unwrap()
            .is_none(),
        "no Owner yet: nothing to recover"
    );
    let (owner_id, _) = h.account(InstanceRole::Owner, false).await;
    h.account(InstanceRole::Host, false).await;
    let ticket = mint_owner_password_reset(h.store().as_ref(), Some(ORIGIN), now)
        .await
        .unwrap()
        .expect("ticket");
    assert_eq!(ticket.user_id, owner_id);
    assert_eq!(ticket.expires_at, now + PASSWORD_RESET_TTL_SECONDS);
    let token = ticket
        .reset_url
        .strip_prefix(&format!("{ORIGIN}/reset-password?token="))
        .expect("public reset URL");
    let lookup = h
        .store()
        .password_reset_lookup(&hash_session_token(token), now)
        .await
        .unwrap();
    assert!(matches!(lookup, PasswordResetLookup::Valid(user) if user.id == owner_id));
}

#[tokio::test]
async fn repeated_failed_resets_are_rate_limited() {
    let h = Harness::new(3);
    let mut statuses = Vec::new();
    for _ in 0..4 {
        statuses.push(h.reset(&"a".repeat(64), NEW_PASSWORD).await.0);
    }
    assert_eq!(
        statuses,
        vec![
            StatusCode::UNAUTHORIZED,
            StatusCode::UNAUTHORIZED,
            StatusCode::UNAUTHORIZED,
            StatusCode::TOO_MANY_REQUESTS
        ]
    );
}
