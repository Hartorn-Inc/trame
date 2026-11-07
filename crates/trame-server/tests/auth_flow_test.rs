#![allow(clippy::doc_lazy_continuation)]

//! ============================================================================
//! LEGACY GUEST SESSION BIND FLOW INTEGRATION TESTS (auth_flow_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Guest sessions are no longer created (`InviteRedemption` replaced them,
//! ADR-0039), but guests created before the change keep playing until they
//! bind credentials. This suite verifies that:
//! 1. `/api/v1/auth/me` flags a legacy guest (`is_guest: true`) so the UI can
//!    show the bind prompt.
//! 2. `/api/v1/auth/bind-account` turns the guest into a permanent `Member`
//!    account with an Argon2id hash, keeping the same `user_id`.
//! 3. Campaign and character associations survive the bind.
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
    AuthState, IdentityStore, InMemorySessionStore, SESSION_COOKIE_NAME, SessionStore,
    build_auth_router, generate_session_token, hash_session_token,
};
use trame_server::auth::totp::TotpService;
use uuid::Uuid;

/// Router over an in-memory store holding one legacy guest session.
struct LegacyGuest {
    store: Arc<InMemorySessionStore>,
    router: axum::Router,
    user_id: Uuid,
    cookie: String,
}

impl LegacyGuest {
    async fn new(campaign_id: Uuid, character_id: Option<Uuid>) -> Self {
        let store = Arc::new(InMemorySessionStore::new());
        let router = build_auth_router(AuthState {
            magic_link_service: Arc::new(MagicLinkService::new(
                b"integration-test-secret-key-32b!",
                "trame-auth-test",
            )),
            session_store: store.clone(),
            totp_service: Arc::new(TotpService::default()),
            security: Default::default(),
        });
        let guest = store.create_guest_user("PLAYER").await.unwrap();
        store
            .assign_campaign_member(campaign_id, guest.id, character_id, "PLAYER")
            .await
            .unwrap();
        let token = generate_session_token();
        store
            .create_session(guest.id, &hash_session_token(&token), 3600)
            .await
            .unwrap();
        Self {
            store,
            router,
            user_id: guest.id,
            cookie: format!("{SESSION_COOKIE_NAME}={token}"),
        }
    }

    async fn me(&self) -> serde_json::Value {
        let req = Request::builder()
            .uri("/api/v1/auth/me")
            .header("Cookie", &self.cookie)
            .body(Body::empty())
            .unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}

#[tokio::test]
async fn legacy_guest_sees_bind_prompt_flag_and_binds_into_member_account() {
    let campaign_id = Uuid::new_v4();
    let character_id = Uuid::new_v4();
    let guest = LegacyGuest::new(campaign_id, Some(character_id)).await;

    let me = guest.me().await;
    assert_eq!(me["user"]["is_guest"], true);
    assert_eq!(me["user"]["instance_role"], "MEMBER");
    assert_eq!(me["user"]["totp_enabled"], false);

    let permanent_email = "adventurer@example.com";
    let bind_payload = serde_json::to_vec(&BindAccountRequest {
        email: permanent_email.to_string(),
        password: "HighEntropyPassw0rd2026!".to_string(),
    })
    .unwrap();
    let bind_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bind-account")
        .header("Content-Type", "application/json")
        .header("Cookie", &guest.cookie)
        .body(Body::from(bind_payload))
        .unwrap();
    let bind_resp = guest.router.clone().oneshot(bind_req).await.unwrap();
    assert_eq!(bind_resp.status(), StatusCode::OK);
    let bind_body = axum::body::to_bytes(bind_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let bind_result: BindAccountResponse = serde_json::from_slice(&bind_body).unwrap();
    assert_eq!(bind_result.user_id, guest.user_id);
    assert_eq!(bind_result.email, permanent_email);
    assert!(!bind_result.is_guest);

    assert_eq!(guest.me().await["user"]["is_guest"], false);

    let retained_member = guest
        .store
        .get_campaign_member(campaign_id, guest.user_id)
        .await
        .unwrap()
        .expect("retained membership exists");
    assert_eq!(retained_member.character_id, Some(character_id));

    let graduated_user = guest
        .store
        .get_user_by_id(guest.user_id)
        .await
        .unwrap()
        .expect("graduated user exists");
    assert!(!graduated_user.is_guest);
    assert_eq!(graduated_user.email, Some(permanent_email.to_string()));
    let hash = graduated_user.password_hash.expect("password hash present");
    assert!(hash.starts_with("$argon2id$"));
}
