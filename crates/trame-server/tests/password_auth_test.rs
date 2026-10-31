//! ============================================================================
//! PURPOSE:
//!   Integration and unit test suite for Argon2id password hashing, entropy
//!   validation, and guest-to-permanent account identity binding.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Verifies OWASP Argon2id parameters (m=19456, t=2, p=1, 32-byte digest).
//!   - Verifies campaign memberships and assigned characters persist across
//!     account binding, and duplicate emails return HTTP 409 Conflict.
//!
//! EXECUTION LIFECYCLE:
//!   1. Execute parameterized entropy and Argon2id PHC verification tests.
//!   2. Drive `/api/v1/auth/bind-account` through Axum `oneshot` requests.
//! ============================================================================

use argon2::password_hash::PasswordHash;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::password::{
    ARGON2ID_ITERATIONS, ARGON2ID_MEMORY_KIB, ARGON2ID_OUTPUT_LEN, ARGON2ID_PARALLELISM,
    AuthService, BindAccountRequest, BindAccountResponse, PasswordService,
    calculate_password_entropy, verify_password_entropy,
};
use trame_server::auth::session::{
    AuthState, DEFAULT_SESSION_TTL_SECONDS, InMemorySessionStore, SessionStore, build_auth_router,
    generate_session_token, hash_session_token,
};
use uuid::Uuid;

#[test]
fn test_password_entropy_calculation_and_verification() {
    // Empty password has 0 entropy and fails
    assert_eq!(calculate_password_entropy(""), 0.0);
    assert!(verify_password_entropy("").is_err());

    // Passwords shorter than 8 chars fail
    assert!(verify_password_entropy("short").is_err());
    assert!(verify_password_entropy("1234567").is_err());

    // All digits (8 chars) has ~26.5 bits entropy (< 30.0), fails
    assert!(verify_password_entropy("12345678").is_err());

    // Low entropy passwords fail
    assert!(verify_password_entropy("aaaaaaa1").is_err());

    // Strong passwords pass
    assert!(verify_password_entropy("TrameSec2026!").is_ok());
    assert!(verify_password_entropy("correct-horse-battery-staple").is_ok());
    assert!(calculate_password_entropy("TrameSec2026!") > 50.0);
}

#[test]
fn test_argon2id_hashing_and_verification() {
    let service = PasswordService::new();
    let password = "SuperSecretCampaignPassword2026!";

    let hash = service.hash_password(password).expect("hashing succeeds");
    assert!(hash.starts_with("$argon2id$"), "must use Argon2id variant");

    let parsed = PasswordHash::new(&hash).expect("valid PHC format");
    assert_eq!(parsed.algorithm.as_str(), "argon2id");
    assert_eq!(parsed.version, Some(19));

    // Check OWASP parameters in hash string
    let params = parsed.params;
    assert_eq!(
        params.get("m").and_then(|v| v.decimal().ok()),
        Some(ARGON2ID_MEMORY_KIB)
    );
    assert_eq!(
        params.get("t").and_then(|v| v.decimal().ok()),
        Some(ARGON2ID_ITERATIONS)
    );
    assert_eq!(
        params.get("p").and_then(|v| v.decimal().ok()),
        Some(ARGON2ID_PARALLELISM)
    );

    // Output hash length is 32 bytes
    if let Some(hash_val) = parsed.hash {
        assert_eq!(hash_val.as_bytes().len(), ARGON2ID_OUTPUT_LEN);
    }

    // Salt length is 16 bytes (Base64-encoded to 22 characters)
    if let Some(salt) = parsed.salt {
        assert_eq!(salt.as_str().len(), 22);
    }

    // Criterion 4: Valid password returns true
    assert!(service.verify_password(password, &hash));

    // Criterion 5: Incorrect password returns false
    assert!(!service.verify_password("WrongPassword!123", &hash));
    assert!(!service.verify_password("", &hash));
    assert!(!service.verify_password(password, "invalid-hash-string"));
}

#[tokio::test]
async fn test_bind_account_success_preserves_campaign_and_actor() {
    let store = Arc::new(InMemorySessionStore::new());
    let magic_link_service = Arc::new(MagicLinkService::new(
        b"test-secret-key-12345",
        "trame-test",
    ));
    let state = AuthState {
        magic_link_service,
        session_store: store.clone(),
        totp_service: std::sync::Arc::new(trame_server::auth::totp::TotpService::default()),
    };
    let app = build_auth_router(state);

    // 1. Create a guest user
    let guest = store
        .create_guest_user("PLAYER")
        .await
        .expect("create guest");
    assert!(guest.is_guest);

    // 2. Associate guest with campaign and actor
    let campaign_id = Uuid::new_v4();
    let character_id = Uuid::new_v4();
    store
        .assign_campaign_member(campaign_id, guest.id, Some(character_id), "PLAYER")
        .await
        .expect("assign member");

    // 3. Issue guest session
    let raw_token = generate_session_token();
    let token_hash = hash_session_token(&raw_token);
    store
        .create_session(guest.id, &token_hash, DEFAULT_SESSION_TTL_SECONDS)
        .await
        .expect("create session");

    // Criterion 1: Guest submits email and password to bind-account
    let bind_payload = serde_json::to_vec(&BindAccountRequest {
        email: "player@example.com".to_string(),
        password: "StronGP@ssw0rd2026!".to_string(),
    })
    .unwrap();

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bind-account")
        .header("Content-Type", "application/json")
        .header("Cookie", format!("trame_session={raw_token}"))
        .body(Body::from(bind_payload))
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let bind_resp: BindAccountResponse = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(bind_resp.user_id, guest.id);
    assert_eq!(bind_resp.email, "player@example.com");
    assert!(!bind_resp.is_guest);

    // Verify campaign and character association remain intact
    let member = store
        .get_campaign_member(campaign_id, guest.id)
        .await
        .unwrap()
        .expect("member exists");
    assert_eq!(member.character_id, Some(character_id));
    assert_eq!(member.campaign_id, campaign_id);
}

#[tokio::test]
async fn test_bind_account_email_conflict_returns_409() {
    let store = Arc::new(InMemorySessionStore::new());
    let magic_link_service = Arc::new(MagicLinkService::new(
        b"test-secret-key-12345",
        "trame-test",
    ));
    let state = AuthState {
        magic_link_service,
        session_store: store.clone(),
        totp_service: Arc::new(trame_server::auth::totp::TotpService::default()),
    };
    let app = build_auth_router(state);

    // Create guest 1 and bind email
    let guest1 = store.create_guest_user("PLAYER").await.unwrap();
    let raw_token1 = generate_session_token();
    store
        .create_session(
            guest1.id,
            &hash_session_token(&raw_token1),
            DEFAULT_SESSION_TTL_SECONDS,
        )
        .await
        .unwrap();

    let auth_service = AuthService::new(store.clone());
    auth_service
        .bind_account(&raw_token1, "occupied@example.com", "StrongP@ssw0rd123!")
        .await
        .unwrap();

    // Create guest 2 and try binding with same email
    let guest2 = store.create_guest_user("PLAYER").await.unwrap();
    let raw_token2 = generate_session_token();
    store
        .create_session(
            guest2.id,
            &hash_session_token(&raw_token2),
            DEFAULT_SESSION_TTL_SECONDS,
        )
        .await
        .unwrap();

    let bind_payload = serde_json::to_vec(&BindAccountRequest {
        email: "occupied@example.com".to_string(),
        password: "AnotherStrongP@ss2026!".to_string(),
    })
    .unwrap();

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bind-account")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {raw_token2}"))
        .body(Body::from(bind_payload))
        .unwrap();

    // Criterion 2: Returns HTTP 409 Conflict with code EMAIL_ALREADY_EXISTS
    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let err_json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(err_json["code"], "EMAIL_ALREADY_EXISTS");
}

#[tokio::test]
async fn test_bind_account_unauthenticated_or_non_guest_returns_401() {
    let store = Arc::new(InMemorySessionStore::new());
    let magic_link_service = Arc::new(MagicLinkService::new(
        b"test-secret-key-12345",
        "trame-test",
    ));
    let state = AuthState {
        magic_link_service,
        session_store: store.clone(),
        totp_service: Arc::new(trame_server::auth::totp::TotpService::default()),
    };
    let app = build_auth_router(state);

    // 1. Unauthenticated request without token
    let bind_payload = serde_json::to_vec(&BindAccountRequest {
        email: "unauth@example.com".to_string(),
        password: "StrongP@ssw0rd123!".to_string(),
    })
    .unwrap();

    let req1 = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bind-account")
        .header("Content-Type", "application/json")
        .body(Body::from(bind_payload.clone()))
        .unwrap();

    let resp1 = app.clone().oneshot(req1).await.unwrap();
    assert_eq!(resp1.status(), StatusCode::UNAUTHORIZED);

    // 2. Request with invalid/unknown token
    let req2 = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bind-account")
        .header("Content-Type", "application/json")
        .header("Cookie", "trame_session=non_existent_token_value")
        .body(Body::from(bind_payload.clone()))
        .unwrap();

    let resp2 = app.clone().oneshot(req2).await.unwrap();
    assert_eq!(resp2.status(), StatusCode::UNAUTHORIZED);

    // 3. Request with already graduated non-guest user session
    let guest = store.create_guest_user("PLAYER").await.unwrap();
    let raw_token = generate_session_token();
    store
        .create_session(
            guest.id,
            &hash_session_token(&raw_token),
            DEFAULT_SESSION_TTL_SECONDS,
        )
        .await
        .unwrap();

    let auth_service = AuthService::new(store.clone());
    auth_service
        .bind_account(&raw_token, "graduated@example.com", "StrongP@ssw0rd123!")
        .await
        .unwrap();

    // Now attempt to bind again with the same session (now non-guest)
    let req3 = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bind-account")
        .header("Content-Type", "application/json")
        .header("Cookie", format!("trame_session={raw_token}"))
        .body(Body::from(
            serde_json::to_vec(&BindAccountRequest {
                email: "different@example.com".to_string(),
                password: "StrongP@ssw0rd456!".to_string(),
            })
            .unwrap(),
        ))
        .unwrap();

    let resp3 = app.oneshot(req3).await.unwrap();
    assert_eq!(resp3.status(), StatusCode::UNAUTHORIZED);
}
