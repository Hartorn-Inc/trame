//! Unit and integration tests for RFC 6238 TOTP MFA, AES-256-GCM secret encryption, and endpoints.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use data_encoding::BASE32;
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{
    AuthState, DEFAULT_SESSION_TTL_SECONDS, IdentityStore, InMemorySessionStore, SessionStore,
    UserRecord, build_auth_router, generate_session_token, hash_session_token,
};
use trame_server::auth::totp::{
    TotpEnableRequest, TotpEnableResponse, TotpService, TotpSetupResponse, TotpVerifyRequest,
    TotpVerifyResponse, compute_totp_code,
};
use uuid::Uuid;

#[test]
fn test_rfc6238_reference_test_vectors() {
    // RFC 6238 Appendix B test vectors for SHA-1 with 8-digit and 6-digit output
    // Secret: "12345678901234567890" (20 bytes ASCII)
    let secret = b"12345678901234567890";

    // Table of (Unix time, time_step, expected 8-digit, expected 6-digit)
    let vectors: Vec<(u64, &str, &str)> = vec![
        (59, "94287082", "287082"),
        (1111111109, "07081804", "081804"),
        (1111111111, "14050471", "050471"),
        (1234567890, "89005924", "005924"),
        (2000000000, "69279037", "279037"),
    ];

    for (time_sec, exp_8, exp_6) in vectors {
        let time_step = time_sec / 30;
        let code_8 = compute_totp_code(secret, time_step, 8);
        let code_6 = compute_totp_code(secret, time_step, 6);
        assert_eq!(code_8, exp_8, "Failed 8-digit vector at time {time_sec}");
        assert_eq!(code_6, exp_6, "Failed 6-digit vector at time {time_sec}");
    }
}

#[test]
fn test_aes_256_gcm_roundtrip_and_nonce_ciphertext_format() {
    let master_key = [0x42u8; 32];
    let service = TotpService::new(master_key, "TRAME");

    let test_secrets: Vec<&[u8]> = vec![
        b"12345678901234567890",
        b"twenty-byte-secret12",
        &[0u8; 20],
        &[0xff; 20],
    ];

    for secret in test_secrets {
        let encrypted = service.encrypt_secret(secret).expect("encryption succeeds");

        // Format must be <nonce_hex>:<ciphertext_hex>
        assert!(encrypted.contains(':'), "must contain colon delimiter");
        let parts: Vec<&str> = encrypted.split(':').collect();
        assert_eq!(parts.len(), 2, "must have exactly 2 parts");

        // Nonce is 12 bytes = 24 hex characters
        assert_eq!(parts[0].len(), 24, "nonce must be 24 hex characters");
        // Ciphertext includes 16-byte authentication tag = (len + 16) * 2 hex chars
        assert_eq!(
            parts[1].len(),
            (secret.len() + 16) * 2,
            "ciphertext length mismatch"
        );

        // Decryption round-trip
        let decrypted = service
            .decrypt_secret(&encrypted)
            .expect("decryption succeeds");
        assert_eq!(decrypted, secret, "round-trip plaintext mismatch");
    }
}

#[test]
fn test_totp_setup_secret_generation_and_otpauth_url() {
    let service = TotpService::default();
    let (b32_secret, enc_secret, url) = service.setup("player@example.com");

    // 20-byte secret Base32 encoded produces 32 characters
    assert_eq!(b32_secret.len(), 32, "Base32 secret must be 32 characters");
    let decoded = BASE32.decode(b32_secret.as_bytes()).expect("valid base32");
    assert_eq!(decoded.len(), 20, "Base32 secret must decode to 20 bytes");

    // Encrypted secret verifies
    let decrypted = service.decrypt_secret(&enc_secret).expect("decrypt ok");
    assert_eq!(decrypted, decoded);

    // Otpauth URL format
    assert!(url.starts_with("otpauth://totp/TRAME:player@example.com?"));
    assert!(url.contains(&format!("secret={b32_secret}")));
    assert!(url.contains("issuer=TRAME"));
    assert!(url.contains("algorithm=SHA1"));
    assert!(url.contains("digits=6"));
    assert!(url.contains("period=30"));
}

#[test]
fn test_totp_code_verification_windows_and_rejection() {
    let service = TotpService::default();
    let secret = b"12345678901234567890";
    let now = 1000000u64;

    let valid_code = service.generate_code(secret, now);
    assert!(service.verify_code(secret, &valid_code, now));

    // Rejection of expired code from prior step
    let past_code = service.generate_code(secret, now - 60);
    assert!(!service.verify_code(secret, &past_code, now));

    // Rejection of future code
    let future_code = service.generate_code(secret, now + 60);
    assert!(!service.verify_code(secret, &future_code, now));

    // Rejection of invalid format codes
    assert!(!service.verify_code(secret, "12345", now));
    assert!(!service.verify_code(secret, "1234567", now));
    assert!(!service.verify_code(secret, "abcdef", now));
    assert!(!service.verify_code(secret, "", now));
}

#[tokio::test]
async fn test_totp_http_flow_setup_enable_and_verify() {
    let store = Arc::new(InMemorySessionStore::new());
    let magic_link = Arc::new(MagicLinkService::new(b"test-secret", "trame-test"));
    let totp_service = Arc::new(TotpService::default());
    let state = AuthState {
        magic_link_service: magic_link,
        session_store: store.clone(),
        totp_service: totp_service.clone(),
    };
    let app = build_auth_router(state);

    // 1. Create a user
    let user_id = Uuid::new_v4();
    let user = UserRecord {
        id: user_id,
        username: "gandalf".to_string(),
        role: "GM".to_string(),
        is_guest: false,
        created_at: 1000,
        email: Some("gandalf@example.com".to_string()),
        password_hash: None,
        mfa_enabled: false,
        totp_secret: None,
        pending_totp_secret: None,
    };
    store.save_user(user.clone()).await.unwrap();

    // 2. Create active session for setup
    let raw_token = generate_session_token();
    let token_hash = hash_session_token(&raw_token);
    store
        .create_session(user_id, &token_hash, DEFAULT_SESSION_TTL_SECONDS)
        .await
        .unwrap();

    // 3. POST /api/v1/auth/totp/setup with session cookie
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/totp/setup")
        .header("Cookie", format!("trame_session={raw_token}"))
        .body(Body::empty())
        .unwrap();

    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let setup_resp: TotpSetupResponse = serde_json::from_slice(&body).unwrap();
    assert_eq!(setup_resp.secret.len(), 32);

    // 4. Verify user record has pending_totp_secret
    let user_after_setup = store.get_user_by_id(user_id).await.unwrap().unwrap();
    assert!(!user_after_setup.mfa_enabled);
    assert!(user_after_setup.pending_totp_secret.is_some());

    // 5. POST /api/v1/auth/totp/enable with INVALID code fails
    let invalid_enable_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/totp/enable")
        .header("Content-Type", "application/json")
        .header("Cookie", format!("trame_session={raw_token}"))
        .body(Body::from(
            serde_json::to_vec(&TotpEnableRequest {
                code: "000000".to_string(),
            })
            .unwrap(),
        ))
        .unwrap();

    let inv_res = app.clone().oneshot(invalid_enable_req).await.unwrap();
    assert_eq!(inv_res.status(), StatusCode::UNAUTHORIZED);

    // 6. POST /api/v1/auth/totp/enable with VALID current code succeeds
    let secret_bytes = BASE32.decode(setup_resp.secret.as_bytes()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let valid_code = totp_service.generate_code(&secret_bytes, now);

    let enable_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/totp/enable")
        .header("Content-Type", "application/json")
        .header("Cookie", format!("trame_session={raw_token}"))
        .body(Body::from(
            serde_json::to_vec(&TotpEnableRequest {
                code: valid_code.clone(),
            })
            .unwrap(),
        ))
        .unwrap();

    let enable_res = app.clone().oneshot(enable_req).await.unwrap();
    assert_eq!(enable_res.status(), StatusCode::OK);
    let enable_body = axum::body::to_bytes(enable_res.into_body(), usize::MAX)
        .await
        .unwrap();
    let enable_json: TotpEnableResponse = serde_json::from_slice(&enable_body).unwrap();
    assert!(enable_json.mfa_enabled);

    // 7. Verify user record has MFA enabled and secret promoted
    let user_after_enable = store.get_user_by_id(user_id).await.unwrap().unwrap();
    assert!(user_after_enable.mfa_enabled);
    assert!(user_after_enable.totp_secret.is_some());
    assert!(user_after_enable.pending_totp_secret.is_none());

    // 8. POST /api/v1/auth/totp/verify with INVALID code fails
    let bad_verify_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/totp/verify")
        .header("Content-Type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&TotpVerifyRequest {
                user_id,
                code: "999999".to_string(),
            })
            .unwrap(),
        ))
        .unwrap();
    let bad_verify_res = app.clone().oneshot(bad_verify_req).await.unwrap();
    assert_eq!(bad_verify_res.status(), StatusCode::UNAUTHORIZED);

    // 9. POST /api/v1/auth/totp/verify with VALID current code succeeds and issues cookie
    let verify_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/totp/verify")
        .header("Content-Type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&TotpVerifyRequest {
                user_id,
                code: valid_code,
            })
            .unwrap(),
        ))
        .unwrap();
    let verify_res = app.clone().oneshot(verify_req).await.unwrap();
    assert_eq!(verify_res.status(), StatusCode::OK);
    assert!(verify_res.headers().contains_key("set-cookie"));
    let cookie_hdr = verify_res.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie_hdr.contains("trame_session="));
    assert!(cookie_hdr.contains("HttpOnly"));
    assert!(cookie_hdr.contains("SameSite=Lax"));

    let verify_body = axum::body::to_bytes(verify_res.into_body(), usize::MAX)
        .await
        .unwrap();
    let verify_json: TotpVerifyResponse = serde_json::from_slice(&verify_body).unwrap();
    assert_eq!(verify_json.status, "success");
    assert_eq!(verify_json.user_id, user_id);
}
