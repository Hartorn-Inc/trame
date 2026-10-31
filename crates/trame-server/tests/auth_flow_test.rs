#![allow(clippy::doc_lazy_continuation)]

//! ============================================================================
//! HYBRID AUTH & MAGIC LINK ONBOARDING INTEGRATION TESTS (auth_flow_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Verifies end-to-end integration across the authentication lifecycle:
//! 1. 1-click magic link onboarding creating a provisional guest user.
//! 2. Automatic binding to an assigned campaign and character ID.
//! 3. Minting of a secure `trame_session` cookie.
//! 4. Seamless account credential binding (`/api/v1/auth/bind-account`) with
//!    OWASP Argon2id password hashing, promoting the guest to a permanent user.
//! 5. Exact preservation of character and campaign associations post-graduation.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   - Guest graduation preserves `user_id`, `campaign_id`, and `character_id`.
//!   - Binding fails closed if the session is expired, missing, or already permanent.
//!   - Passwords must satisfy entropy requirements before hashing.
//!
//! ============================================================================

use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::password::{BindAccountRequest, BindAccountResponse};
use trame_server::auth::session::{
    AuthState, IdentityStore, InMemorySessionStore, MagicLinkLoginRequest, MagicLinkLoginResponse,
    SESSION_COOKIE_NAME, SessionStore, build_auth_router,
};
use trame_server::auth::totp::TotpService;
use uuid::Uuid;

/// Test fixture for orchestrating authentication router tests.
pub struct AuthTestHarness {
    pub session_store: Arc<InMemorySessionStore>,
    pub magic_service: Arc<MagicLinkService>,
    pub router: axum::Router,
}

impl AuthTestHarness {
    pub fn new() -> Self {
        let session_store = Arc::new(InMemorySessionStore::new());
        let magic_service = Arc::new(MagicLinkService::new(
            b"integration-test-secret-key-32b!",
            "trame-auth-test",
        ));
        let auth_state = AuthState {
            magic_link_service: magic_service.clone(),
            session_store: session_store.clone(),
            totp_service: Arc::new(TotpService::default()),
        };
        let router = build_auth_router(auth_state);
        Self {
            session_store,
            magic_service,
            router,
        }
    }

    pub fn create_invite(
        &self,
        campaign_id: Uuid,
        character_id: Option<Uuid>,
        role: &str,
        ttl_seconds: u64,
    ) -> String {
        let creator_id = Uuid::new_v4();
        let (token, _) = self
            .magic_service
            .create_invite_token(creator_id, campaign_id, character_id, role, ttl_seconds)
            .expect("create invite token");
        token
    }
}

impl Default for AuthTestHarness {
    fn default() -> Self {
        Self::new()
    }
}

#[tokio::test]
async fn test_magic_link_guest_to_registered_binding() {
    let harness = AuthTestHarness::new();

    let campaign_id = Uuid::new_v4();
    let character_id = Uuid::new_v4();
    let ttl = 3600u64;

    // 1. GM mints a 1-click magic link with an assigned character
    let invite_token = harness.create_invite(campaign_id, Some(character_id), "PLAYER", ttl);

    // 2. Player follows magic link to execute 1-click onboarding
    let login_payload = serde_json::to_vec(&MagicLinkLoginRequest {
        token: invite_token,
    })
    .unwrap();

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/magic-link")
        .header("Content-Type", "application/json")
        .body(Body::from(login_payload))
        .unwrap();

    let resp = harness.router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Extract session token from Set-Cookie header
    let cookie_header = resp
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .expect("must set trame_session cookie")
        .to_str()
        .unwrap()
        .to_string();
    assert!(cookie_header.contains(SESSION_COOKIE_NAME));

    let session_token = cookie_header
        .split(';')
        .next()
        .and_then(|s| s.strip_prefix(&format!("{SESSION_COOKIE_NAME}=")))
        .expect("extract raw session token")
        .to_string();

    let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let login_resp: MagicLinkLoginResponse = serde_json::from_slice(&body_bytes).unwrap();

    assert_eq!(login_resp.campaign_id, campaign_id);
    assert_eq!(login_resp.character_id, Some(character_id));
    assert_eq!(login_resp.role, "PLAYER");

    // Confirm initial guest state
    let initial_user = harness
        .session_store
        .get_user_by_id(login_resp.user_id)
        .await
        .unwrap()
        .expect("user exists");
    assert!(initial_user.is_guest);
    assert!(initial_user.email.is_none());
    assert!(initial_user.password_hash.is_none());

    // Verify campaign member record is bound to character
    let member = harness
        .session_store
        .get_campaign_member(campaign_id, login_resp.user_id)
        .await
        .unwrap()
        .expect("membership exists");
    assert_eq!(member.user_id, login_resp.user_id);
    assert_eq!(member.campaign_id, campaign_id);
    assert_eq!(member.character_id, Some(character_id));

    // 3. Guest binds account credentials (email and password)
    let permanent_email = "adventurer@example.com";
    let permanent_password = "HighEntropyPassw0rd2026!";

    let bind_payload = serde_json::to_vec(&BindAccountRequest {
        email: permanent_email.to_string(),
        password: permanent_password.to_string(),
    })
    .unwrap();

    let bind_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bind-account")
        .header("Content-Type", "application/json")
        .header("Cookie", format!("{SESSION_COOKIE_NAME}={session_token}"))
        .body(Body::from(bind_payload))
        .unwrap();

    let bind_resp = harness.router.clone().oneshot(bind_req).await.unwrap();
    assert_eq!(bind_resp.status(), StatusCode::OK);

    let bind_body = axum::body::to_bytes(bind_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let bind_result: BindAccountResponse = serde_json::from_slice(&bind_body).unwrap();

    assert_eq!(bind_result.user_id, login_resp.user_id);
    assert_eq!(bind_result.email, permanent_email);
    assert!(!bind_result.is_guest);

    // 4. Confirm retained character and campaign association
    let retained_member = harness
        .session_store
        .get_campaign_member(campaign_id, login_resp.user_id)
        .await
        .unwrap()
        .expect("retained membership exists");
    assert_eq!(retained_member.character_id, Some(character_id));
    assert_eq!(retained_member.campaign_id, campaign_id);
    assert_eq!(retained_member.user_id, login_resp.user_id);

    // Confirm user is now permanent with valid Argon2id hash
    let graduated_user = harness
        .session_store
        .get_user_by_id(login_resp.user_id)
        .await
        .unwrap()
        .expect("graduated user exists");
    assert!(!graduated_user.is_guest);
    assert_eq!(graduated_user.email, Some(permanent_email.to_string()));
    let hash = graduated_user.password_hash.expect("password hash present");
    assert!(hash.starts_with("$argon2id$"));
}
