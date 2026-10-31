//! ============================================================================
//! PURPOSE:
//!   Implements RFC 6238 TOTP Multi-Factor Authentication (HMAC-SHA1, 30-second
//!   time steps, 6 digits, 20-byte Base32 secrets) with AES-256-GCM encryption
//!   at rest using `MASTER_ENCRYPTION_KEY`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - TOTP secrets are never persisted in plaintext; `TotpService::encrypt_secret`
//!     uses AES-256-GCM with a random 12-byte nonce and stores
//!     `<nonce_hex>:<ciphertext_hex>`.
//!   - Candidate TOTP codes are compared in constant time via
//!     `constant_time_eq` and strictly enforce 6-digit numeric formatting on
//!     the current 30-second RFC 6238 step.
//!
//! EXECUTION LIFECYCLE:
//!   1. `totp_setup_handler` generates a 20-byte secret, encrypts it with
//!      AES-256-GCM, stores it as pending, and returns Base32 + `otpauth://` URL.
//!   2. `totp_enable_handler` decrypts the pending secret, verifies the
//!      submitted 6-digit code, and promotes MFA to enabled on the user record.
//!   3. `totp_verify_handler` validates the active TOTP code during login and
//!      issues an `HttpOnly; Secure; SameSite=Lax` session cookie.
//! ============================================================================

use super::password::{IdentityStore, extract_session_token};
use super::session::{
    AuthState, DEFAULT_SESSION_TTL_SECONDS, SessionStore, build_session_cookie_header,
    generate_session_token, hash_session_token,
};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header::{HeaderMap, HeaderValue, SET_COOKIE};
use axum::response::{IntoResponse, Json, Response};
use data_encoding::{BASE32, HEXLOWER};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

/// RFC 6238 time step in seconds.
pub const TOTP_TIME_STEP_SECS: u64 = 30;

/// Default TOTP code length (6 digits).
pub const TOTP_DIGITS: u32 = 6;

/// Environment variable holding the 32-byte hex-encoded master encryption key.
pub const MASTER_ENCRYPTION_KEY_ENV: &str = "MASTER_ENCRYPTION_KEY";

/// Fallback master key for testing and dev environments (32 bytes = 64 hex chars).
const DEFAULT_DEV_MASTER_KEY_HEX: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Errors occurring during TOTP generation, encryption, or verification.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TotpError {
    #[error("invalid master encryption key: {0}")]
    InvalidMasterKey(String),
    #[error("aes-gcm encryption error")]
    EncryptionError,
    #[error("aes-gcm decryption error")]
    DecryptionError,
    #[error("invalid ciphertext payload format: expected <nonce_hex>:<ciphertext_hex>")]
    InvalidPayloadFormat,
    #[error("invalid base32 secret: {0}")]
    InvalidBase32Secret(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("user not found")]
    UserNotFound,
    #[error("mfa not configured or not pending")]
    MfaNotConfigured,
    #[error("invalid or expired totp code")]
    InvalidTotpCode,
    #[error("storage error: {0}")]
    Storage(String),
}

/// Service providing RFC 6238 TOTP generation, validation, and AES-256-GCM secret encryption.
#[derive(Clone)]
pub struct TotpService {
    master_key: [u8; 32],
    issuer: String,
}

impl Default for TotpService {
    fn default() -> Self {
        Self::from_env_or_default()
    }
}

impl TotpService {
    /// Creates a new `TotpService` with the provided 32-byte AES-256 master key and issuer name.
    pub fn new(master_key: [u8; 32], issuer: impl Into<String>) -> Self {
        Self {
            master_key,
            issuer: issuer.into(),
        }
    }

    /// Loads `MASTER_ENCRYPTION_KEY` (64 hex characters) from the environment, falling back to dev key.
    pub fn from_env_or_default() -> Self {
        let hex_str = std::env::var(MASTER_ENCRYPTION_KEY_ENV)
            .unwrap_or_else(|_| DEFAULT_DEV_MASTER_KEY_HEX.to_string());
        let key = Self::parse_master_key(&hex_str)
            .unwrap_or_else(|_| Self::parse_master_key(DEFAULT_DEV_MASTER_KEY_HEX).unwrap());
        Self::new(key, "TRAME")
    }

    /// Parses a 32-byte master key from a 64-character lowercase or uppercase hex string.
    pub fn parse_master_key(hex_key: &str) -> Result<[u8; 32], TotpError> {
        let trimmed = hex_key.trim();
        let bytes = HEXLOWER
            .decode(trimmed.to_ascii_lowercase().as_bytes())
            .map_err(|e| TotpError::InvalidMasterKey(e.to_string()))?;
        if bytes.len() != 32 {
            return Err(TotpError::InvalidMasterKey(
                "master key must be exactly 32 bytes (64 hex chars)".to_string(),
            ));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        Ok(key)
    }

    /// Encrypts plaintext bytes using AES-256-GCM, returning `<nonce_hex>:<ciphertext_hex>`.
    pub fn encrypt_secret(&self, secret_bytes: &[u8]) -> Result<String, TotpError> {
        let cipher =
            Aes256Gcm::new_from_slice(&self.master_key).map_err(|_| TotpError::EncryptionError)?;
        let mut nonce_bytes = [0u8; 12];
        rand::rng().fill(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, secret_bytes)
            .map_err(|_| TotpError::EncryptionError)?;

        let nonce_hex = HEXLOWER.encode(&nonce_bytes);
        let ct_hex = HEXLOWER.encode(&ciphertext);
        Ok(format!("{nonce_hex}:{ct_hex}"))
    }

    /// Decrypts a `<nonce_hex>:<ciphertext_hex>` payload using AES-256-GCM, returning plaintext bytes.
    pub fn decrypt_secret(&self, payload: &str) -> Result<Vec<u8>, TotpError> {
        let (nonce_hex, ct_hex) = payload
            .split_once(':')
            .ok_or(TotpError::InvalidPayloadFormat)?;
        let nonce_bytes = HEXLOWER
            .decode(nonce_hex.as_bytes())
            .map_err(|_| TotpError::InvalidPayloadFormat)?;
        if nonce_bytes.len() != 12 {
            return Err(TotpError::InvalidPayloadFormat);
        }
        let ct_bytes = HEXLOWER
            .decode(ct_hex.as_bytes())
            .map_err(|_| TotpError::InvalidPayloadFormat)?;

        let cipher =
            Aes256Gcm::new_from_slice(&self.master_key).map_err(|_| TotpError::DecryptionError)?;
        let nonce = Nonce::from_slice(&nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ct_bytes.as_slice())
            .map_err(|_| TotpError::DecryptionError)?;
        Ok(plaintext)
    }

    /// Generates a 20-byte cryptographically secure random secret and formats it as Base32 and otpauth URL.
    pub fn setup(&self, account_name: &str) -> (String, String, String) {
        let mut secret_bytes = [0u8; 20];
        rand::rng().fill(&mut secret_bytes);
        let base32_secret = BASE32.encode(&secret_bytes);
        let encrypted_secret = self
            .encrypt_secret(&secret_bytes)
            .expect("AES-256-GCM encryption of 20-byte secret succeeds");
        let otpauth_url = format!(
            "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits=6&period=30",
            self.issuer, account_name, base32_secret, self.issuer
        );
        (base32_secret, encrypted_secret, otpauth_url)
    }

    /// Generates an RFC 6238 TOTP code for the given secret bytes and timestamp.
    pub fn generate_code(&self, secret_bytes: &[u8], timestamp_secs: u64) -> String {
        let time_step = timestamp_secs / TOTP_TIME_STEP_SECS;
        compute_totp_code(secret_bytes, time_step, TOTP_DIGITS)
    }

    /// Verifies candidate code against secret bytes for the given timestamp window (0 skew allowed).
    pub fn verify_code(
        &self,
        secret_bytes: &[u8],
        candidate_code: &str,
        timestamp_secs: u64,
    ) -> bool {
        let clean_code = candidate_code.trim();
        if clean_code.len() != 6 || !clean_code.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        let expected = self.generate_code(secret_bytes, timestamp_secs);
        crate::auth::magic_link::constant_time_eq(clean_code.as_bytes(), expected.as_bytes())
    }
}

/// RFC 4226 / RFC 6238 HOTP/TOTP computation using HMAC-SHA1.
pub fn compute_totp_code(secret: &[u8], time_step: u64, digits: u32) -> String {
    let counter_bytes = time_step.to_be_bytes();
    let hmac_result = hmac_sha1(secret, &counter_bytes);

    let offset = (hmac_result[19] & 0x0f) as usize;
    let binary = (((hmac_result[offset] & 0x7f) as u32) << 24)
        | ((hmac_result[offset + 1] as u32) << 16)
        | ((hmac_result[offset + 2] as u32) << 8)
        | (hmac_result[offset + 3] as u32);

    let modulo = 10u32.pow(digits);
    let otp = binary % modulo;
    format!("{:0width$}", otp, width = digits as usize)
}

/// RFC 2104 HMAC-SHA1 implementation.
pub fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        let mut hasher = Sha1::new();
        hasher.update(key);
        let digest = hasher.finalize();
        key_block[..20].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut o_key_pad = [0u8; 64];
    let mut i_key_pad = [0u8; 64];
    for i in 0..64 {
        o_key_pad[i] = key_block[i] ^ 0x5c;
        i_key_pad[i] = key_block[i] ^ 0x36;
    }

    let mut inner = Sha1::new();
    inner.update(i_key_pad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha1::new();
    outer.update(o_key_pad);
    outer.update(inner_digest);
    let result = outer.finalize();

    let mut output = [0u8; 20];
    output.copy_from_slice(&result);
    output
}

/// Response payload for POST /api/v1/auth/totp/setup.
#[derive(Debug, Serialize, Deserialize)]
pub struct TotpSetupResponse {
    pub secret: String,
    pub secret_base32: String,
    pub otpauth_url: String,
}

/// Request payload for POST /api/v1/auth/totp/enable.
#[derive(Debug, Deserialize, Serialize)]
pub struct TotpEnableRequest {
    pub code: String,
}

/// Response payload for POST /api/v1/auth/totp/enable.
#[derive(Debug, Serialize, Deserialize)]
pub struct TotpEnableResponse {
    pub status: String,
    pub mfa_enabled: bool,
}

/// Request payload for POST /api/v1/auth/totp/verify.
#[derive(Debug, Deserialize, Serialize)]
pub struct TotpVerifyRequest {
    pub user_id: Uuid,
    pub code: String,
}

/// Response payload for POST /api/v1/auth/totp/verify.
#[derive(Debug, Serialize, Deserialize)]
pub struct TotpVerifyResponse {
    pub status: String,
    pub user_id: Uuid,
}

/// Error response format for TOTP endpoints.
#[derive(Debug, Serialize, Deserialize)]
pub struct TotpErrorResponse {
    pub error: String,
}

/// Handler for POST /api/v1/auth/totp/setup.
pub async fn totp_setup_handler(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let session_token = match extract_session_token(&headers) {
        Some(token) => token,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "authentication session required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let token_hash = hash_session_token(&session_token);
    let session = match state
        .session_store
        .get_session_by_token_hash(&token_hash)
        .await
    {
        Ok(Some(s)) => s,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "invalid or expired session".to_string(),
                }),
            )
                .into_response();
        }
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if session.expires_at < now {
        return (
            StatusCode::UNAUTHORIZED,
            Json(TotpErrorResponse {
                error: "session expired".to_string(),
            }),
        )
            .into_response();
    }

    let user = match state.session_store.get_user_by_id(session.user_id).await {
        Ok(Some(u)) => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "user not found".to_string(),
                }),
            )
                .into_response();
        }
    };

    let account_name = user.email.as_deref().unwrap_or(&user.username);
    let (base32_secret, encrypted_secret, otpauth_url) = state.totp_service.setup(account_name);

    if let Err(e) = state
        .session_store
        .save_pending_totp_secret(user.id, &encrypted_secret)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TotpErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        Json(TotpSetupResponse {
            secret: base32_secret.clone(),
            secret_base32: base32_secret,
            otpauth_url,
        }),
    )
        .into_response()
}

/// Handler for POST /api/v1/auth/totp/enable.
pub async fn totp_enable_handler(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(payload): Json<TotpEnableRequest>,
) -> Response {
    let session_token = match extract_session_token(&headers) {
        Some(token) => token,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "authentication session required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let token_hash = hash_session_token(&session_token);
    let session = match state
        .session_store
        .get_session_by_token_hash(&token_hash)
        .await
    {
        Ok(Some(s)) => s,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "invalid or expired session".to_string(),
                }),
            )
                .into_response();
        }
    };

    let user = match state.session_store.get_user_by_id(session.user_id).await {
        Ok(Some(u)) => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "user not found".to_string(),
                }),
            )
                .into_response();
        }
    };

    let pending_secret_encrypted = match &user.pending_totp_secret {
        Some(s) => s.as_str(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(TotpErrorResponse {
                    error: "no pending totp setup found for user".to_string(),
                }),
            )
                .into_response();
        }
    };

    let secret_bytes = match state.totp_service.decrypt_secret(pending_secret_encrypted) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(TotpErrorResponse {
                    error: "failed to decrypt pending totp secret".to_string(),
                }),
            )
                .into_response();
        }
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if !state
        .totp_service
        .verify_code(&secret_bytes, &payload.code, now)
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(TotpErrorResponse {
                error: "invalid totp verification code".to_string(),
            }),
        )
            .into_response();
    }

    if let Err(e) = state
        .session_store
        .enable_totp_for_user(user.id, pending_secret_encrypted)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TotpErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        Json(TotpEnableResponse {
            status: "enabled".to_string(),
            mfa_enabled: true,
        }),
    )
        .into_response()
}

/// Handler for POST /api/v1/auth/totp/verify.
pub async fn totp_verify_handler(
    State(state): State<AuthState>,
    Json(payload): Json<TotpVerifyRequest>,
) -> Response {
    let user = match state.session_store.get_user_by_id(payload.user_id).await {
        Ok(Some(u)) => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "user not found or mfa not configured".to_string(),
                }),
            )
                .into_response();
        }
    };

    if !user.mfa_enabled {
        return (
            StatusCode::UNAUTHORIZED,
            Json(TotpErrorResponse {
                error: "mfa is not enabled for this user".to_string(),
            }),
        )
            .into_response();
    }

    let encrypted_secret = match &user.totp_secret {
        Some(s) => s.as_str(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(TotpErrorResponse {
                    error: "totp secret missing".to_string(),
                }),
            )
                .into_response();
        }
    };

    let secret_bytes = match state.totp_service.decrypt_secret(encrypted_secret) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(TotpErrorResponse {
                    error: "decryption failed".to_string(),
                }),
            )
                .into_response();
        }
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if !state
        .totp_service
        .verify_code(&secret_bytes, &payload.code, now)
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(TotpErrorResponse {
                error: "invalid or expired totp code".to_string(),
            }),
        )
            .into_response();
    }

    let session_token = generate_session_token();
    let token_hash = hash_session_token(&session_token);
    if let Err(e) = state
        .session_store
        .create_session(user.id, &token_hash, DEFAULT_SESSION_TTL_SECONDS)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(TotpErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response();
    }

    let cookie_val = build_session_cookie_header(&session_token, DEFAULT_SESSION_TTL_SECONDS);
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&cookie_val) {
        headers.insert(SET_COOKIE, val);
    }

    (
        StatusCode::OK,
        headers,
        Json(TotpVerifyResponse {
            status: "success".to_string(),
            user_id: user.id,
        }),
    )
        .into_response()
}
