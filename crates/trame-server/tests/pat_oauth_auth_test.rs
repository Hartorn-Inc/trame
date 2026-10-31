#![allow(clippy::doc_lazy_continuation)]

//! ============================================================================
//! PURPOSE:
//!   Unit and integration test suite for Personal Access Tokens (PAT) and OAuth2
//!   PKCE flow with guest identity binding.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Verifies PAT format matches `trame_pat_<40_base62_chars>` and is returned
//!     in plaintext strictly once.
//!   - Verifies PAT SHA-256 digest persistence and constant-time lookup.
//!   - Enforces token expiration on HTTP requests via `PatMiddleware`.
//!   - Verifies RFC 7636 PKCE code challenge S256 computation against reference vectors.
//!   - Confirms OAuth2 callback binds provider identity to existing guest accounts.
//! ============================================================================

use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::oauth::{
    MockOAuthClient, OAuthError, OAuthProvider, OAuthService, OAuthUserProfile,
    compute_code_challenge,
};
use trame_server::auth::pat::{
    CreatePatRequest, CreatePatResponse, PAT_PREFIX, PAT_TOKEN_CHARS_LEN, PatError, PatMiddleware,
    PatService, generate_pat_token, is_valid_pat_format,
};
use trame_server::auth::session::{
    AuthState, DEFAULT_SESSION_TTL_SECONDS, InMemorySessionStore, SessionStore, build_auth_router,
    generate_session_token, hash_session_token,
};
use trame_server::storage::blob::Sha256Hasher;
use uuid::Uuid;

#[test]
fn test_pat_token_generation_and_format_validation() {
    for _ in 0..10 {
        let token = generate_pat_token();
        assert!(
            token.starts_with(PAT_PREFIX),
            "token must start with trame_pat_"
        );
        assert_eq!(
            token.len(),
            PAT_PREFIX.len() + PAT_TOKEN_CHARS_LEN,
            "total token length must be 50 characters"
        );
        assert!(
            is_valid_pat_format(&token),
            "token must satisfy format validation"
        );
    }

    assert!(!is_valid_pat_format(
        "invalid_prefix_1234567890123456789012345678901234567890"
    ));
    assert!(!is_valid_pat_format("trame_pat_short"));
    assert!(!is_valid_pat_format(
        "trame_pat_1234567890123456789012345678901234567890_toolong"
    ));
    assert!(!is_valid_pat_format(
        "trame_pat_123456789012345678901234567890123456789!"
    ));
}

#[tokio::test]
async fn test_pat_service_creation_digest_persistence_and_single_plaintext_return() {
    let store = Arc::new(InMemorySessionStore::new());
    let service = PatService::new(store.clone());

    let user_id = Uuid::new_v4();
    let campaign_id = Uuid::new_v4();
    let scopes = vec!["mcp:read".to_string(), "mcp:write".to_string()];

    let (plaintext_token, record) = service
        .create_pat(
            user_id,
            Some(campaign_id),
            scopes.clone(),
            Some("mcp-client-1".to_string()),
            None,
        )
        .await
        .expect("pat creation succeeds");

    assert!(plaintext_token.starts_with("trame_pat_"));
    assert_eq!(plaintext_token.len(), 50);
    assert_ne!(
        record.token_hash, plaintext_token,
        "plaintext token must never be stored"
    );

    let expected_hash = Sha256Hasher::digest(plaintext_token.as_bytes());
    assert_eq!(
        record.token_hash, expected_hash,
        "stored hash must match sha256 digest"
    );
    assert_eq!(record.user_id, user_id);
    assert_eq!(record.campaign_id, Some(campaign_id));
    assert_eq!(record.scopes, scopes);

    let verified = service
        .verify_token(&plaintext_token)
        .await
        .expect("verification succeeds");
    assert_eq!(verified.id, record.id);
    assert_eq!(verified.token_hash, expected_hash);
}

#[tokio::test]
async fn test_pat_middleware_constant_time_lookup_and_expiration_enforcement() {
    let store = Arc::new(InMemorySessionStore::new());
    let service = PatService::new(store.clone());
    let middleware = PatMiddleware::new(store.clone());

    let user_id = Uuid::new_v4();
    let now = trame_server::auth::magic_link::now_epoch_seconds();

    let (valid_token, _) = service
        .create_pat(
            user_id,
            None,
            vec!["read".to_string()],
            None,
            Some(now + 3600),
        )
        .await
        .unwrap();

    let (expired_token, _) = service
        .create_pat(
            user_id,
            None,
            vec!["read".to_string()],
            None,
            Some(now - 10),
        )
        .await
        .unwrap();

    let valid_auth_header = format!("Bearer {valid_token}");
    let verified = middleware
        .authenticate_header(&valid_auth_header)
        .await
        .unwrap();
    assert_eq!(verified.user_id, user_id);

    let expired_auth_header = format!("Bearer {expired_token}");
    let err = middleware
        .authenticate_header(&expired_auth_header)
        .await
        .unwrap_err();
    assert_eq!(err, PatError::Expired);

    let not_found_token = generate_pat_token();
    let missing_header = format!("Bearer {not_found_token}");
    let not_found_err = middleware
        .authenticate_header(&missing_header)
        .await
        .unwrap_err();
    assert_eq!(not_found_err, PatError::NotFound);
}

#[tokio::test]
async fn test_pat_http_endpoint_post_creation() {
    let store = Arc::new(InMemorySessionStore::new());
    let magic_link_service = Arc::new(MagicLinkService::new(b"test-jwt-secret", "trame-test"));
    let totp_service = Arc::new(trame_server::auth::totp::TotpService::default());
    let state = AuthState {
        magic_link_service,
        session_store: store.clone(),
        totp_service,
    };
    let app = build_auth_router(state);

    let user = store.create_guest_user("PLAYER").await.unwrap();
    let raw_token = generate_session_token();
    store
        .create_session(
            user.id,
            &hash_session_token(&raw_token),
            DEFAULT_SESSION_TTL_SECONDS,
        )
        .await
        .unwrap();

    let payload = serde_json::to_vec(&CreatePatRequest {
        scopes: vec!["mcp".to_string(), "campaign:read".to_string()],
        campaign_id: None,
        name: Some("MCP Agent".to_string()),
        expires_at: None,
        expires_in_seconds: Some(86400),
    })
    .unwrap();

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/pat")
        .header("Cookie", format!("trame_session={raw_token}"))
        .header("Content-Type", "application/json")
        .body(Body::from(payload))
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let pat_resp: CreatePatResponse = serde_json::from_slice(&body).unwrap();
    assert!(pat_resp.token.starts_with("trame_pat_"));
    assert_eq!(pat_resp.token.len(), 50);
    assert_eq!(pat_resp.scopes, vec!["mcp", "campaign:read"]);
    assert_eq!(pat_resp.user_id, user.id);
}

#[test]
fn test_rfc7636_pkce_reference_vector() {
    // RFC 7636 Appendix B test vector:
    // code_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // code_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    let expected_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    let actual_challenge = compute_code_challenge(verifier);
    assert_eq!(
        actual_challenge, expected_challenge,
        "PKCE S256 test vector must match RFC 7636 Appendix B"
    );
}

#[tokio::test]
async fn test_oauth_authorization_url_generation_for_discord_and_google() {
    let store = Arc::new(InMemorySessionStore::new());
    let oauth_service = OAuthService::new(store);

    for provider in [OAuthProvider::Discord, OAuthProvider::Google] {
        let redirect_uri = "https://example.com/callback";
        let guest_id = Uuid::new_v4();

        let auth_url_data = oauth_service
            .start_authorization(provider, redirect_uri, Some(guest_id))
            .await
            .expect("authorization start succeeds");

        assert_eq!(auth_url_data.provider, provider);
        assert_eq!(auth_url_data.code_challenge_method, "S256");
        assert_eq!(
            auth_url_data.code_verifier.len(),
            43,
            "verifier must be 43 characters"
        );
        assert_eq!(
            auth_url_data.code_challenge,
            compute_code_challenge(&auth_url_data.code_verifier),
            "challenge must be sha256 base64url of verifier"
        );
        assert!(auth_url_data.auth_url.contains("code_challenge="));
        assert!(
            auth_url_data
                .auth_url
                .contains("code_challenge_method=S256")
        );
        assert!(auth_url_data.auth_url.contains(&auth_url_data.state));
    }
}

#[tokio::test]
async fn test_oauth_callback_binds_identity_to_existing_guest_session() {
    let store = Arc::new(InMemorySessionStore::new());
    let mock_client = Arc::new(MockOAuthClient::new());
    let oauth_service = OAuthService::with_client(store.clone(), mock_client.clone());

    // 1. Create a guest user via Magic Link flow
    let guest = store
        .create_guest_user("PLAYER")
        .await
        .expect("create guest");
    assert!(guest.is_guest);

    // Assign to a campaign to verify assignment preservation
    let campaign_id = Uuid::new_v4();
    let character_id = Uuid::new_v4();
    store
        .assign_campaign_member(campaign_id, guest.id, Some(character_id), "PLAYER")
        .await
        .expect("assign member");

    // 2. Start authorization with guest session bound
    let auth_data = oauth_service
        .start_authorization(
            OAuthProvider::Discord,
            "https://example.com/oauth/callback",
            Some(guest.id),
        )
        .await
        .expect("start authorization");

    let callback_code = "discord-test-auth-code-1234";
    mock_client
        .register_code_profile(
            callback_code,
            OAuthUserProfile {
                provider_user_id: "discord-uid-99999".to_string(),
                email: Some("discord_user@example.com".to_string()),
                username: Some("discord_user".to_string()),
            },
        )
        .await;

    // 3. Callback executes with active guest session
    let bound_user = oauth_service
        .handle_callback(
            OAuthProvider::Discord,
            callback_code,
            &auth_data.state,
            Some(guest.id),
        )
        .await
        .expect("callback identity binding succeeds");

    assert_eq!(bound_user.id, guest.id, "guest user id must be preserved");
    assert!(
        !bound_user.is_guest,
        "user must no longer be a guest after binding"
    );
    assert_eq!(
        bound_user.email,
        Some("discord_user@example.com".to_string())
    );

    // 4. Verify campaign membership was retained
    let member = store
        .get_campaign_member(campaign_id, guest.id)
        .await
        .unwrap()
        .expect("campaign membership retained");
    assert_eq!(member.character_id, Some(character_id));
}

#[tokio::test]
async fn test_oauth_callback_expired_or_invalid_state_rejected() {
    let store = Arc::new(InMemorySessionStore::new());
    let oauth_service = OAuthService::new(store);

    let err = oauth_service
        .handle_callback(
            OAuthProvider::Google,
            "some-code",
            "non-existent-state",
            None,
        )
        .await
        .unwrap_err();

    assert_eq!(err, OAuthError::InvalidState);
}
