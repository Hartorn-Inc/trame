//! Argon2id password hashing, entropy verification, and identity binding.

use super::session::{AuthState, BoxFuture, SessionError, SessionStore, UserRecord};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header::HeaderMap;
use axum::response::{IntoResponse, Json, Response};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

/// Memory cost for Argon2id per OWASP specification (19 MiB = 19,456 KiB).
pub const ARGON2ID_MEMORY_KIB: u32 = 19_456;

/// Iteration count for Argon2id per OWASP specification.
pub const ARGON2ID_ITERATIONS: u32 = 2;

/// Parallelism threads for Argon2id per OWASP specification.
pub const ARGON2ID_PARALLELISM: u32 = 1;

/// Output key material length in bytes (32-byte digest).
pub const ARGON2ID_OUTPUT_LEN: usize = 32;

/// Minimum Shannon/pool entropy required for passwords (in bits).
pub const MIN_PASSWORD_ENTROPY_BITS: f64 = 30.0;

/// Error returned during password operations.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PasswordError {
    #[error("password hashing error: {0}")]
    HashingError(String),
    #[error("weak password: {0}")]
    WeakPassword(String),
    #[error("email already exists")]
    EmailAlreadyExists,
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("user not found")]
    UserNotFound,
    #[error("storage error: {0}")]
    Storage(String),
}

/// Computes estimated entropy of a password string in bits.
pub fn calculate_password_entropy(password: &str) -> f64 {
    if password.is_empty() {
        return 0.0;
    }
    let mut has_lower = false;
    let mut has_upper = false;
    let mut has_digit = false;
    let mut has_symbol = false;

    let mut char_counts = HashMap::new();
    for ch in password.chars() {
        *char_counts.entry(ch).or_insert(0usize) += 1;
        if ch.is_ascii_lowercase() {
            has_lower = true;
        } else if ch.is_ascii_uppercase() {
            has_upper = true;
        } else if ch.is_ascii_digit() {
            has_digit = true;
        } else {
            has_symbol = true;
        }
    }

    let mut pool_size: f64 = 0.0;
    if has_lower {
        pool_size += 26.0;
    }
    if has_upper {
        pool_size += 26.0;
    }
    if has_digit {
        pool_size += 10.0;
    }
    if has_symbol {
        pool_size += 32.0;
    }

    if pool_size == 0.0 {
        return 0.0;
    }
    let length = password.chars().count() as f64;
    let pool_entropy = length * pool_size.log2();

    if length <= 1.0 {
        return pool_entropy;
    }

    let mut shannon_entropy = 0.0;
    for &count in char_counts.values() {
        let p = count as f64 / length;
        shannon_entropy -= p * p.log2();
    }

    let max_shannon = length.log2();
    if max_shannon > 0.0 {
        (shannon_entropy / max_shannon) * pool_entropy
    } else {
        pool_entropy
    }
}

/// Verifies that a password meets minimum length and entropy thresholds.
pub fn verify_password_entropy(password: &str) -> Result<(), PasswordError> {
    if password.chars().count() < 8 {
        return Err(PasswordError::WeakPassword(
            "password must be at least 8 characters long".to_string(),
        ));
    }
    let entropy = calculate_password_entropy(password);
    if entropy < MIN_PASSWORD_ENTROPY_BITS {
        return Err(PasswordError::WeakPassword(
            "password entropy is insufficient".to_string(),
        ));
    }
    Ok(())
}

/// Service providing Argon2id password hashing and constant-time verification.
#[derive(Clone, Default)]
pub struct PasswordService;

impl PasswordService {
    /// Creates a new `PasswordService`.
    pub fn new() -> Self {
        Self
    }

    /// Builds OWASP-compliant Argon2id parameters (19 MiB memory, 2 iterations, 1 parallelism thread, 32-byte hash).
    fn build_argon2id_params() -> Result<Params, PasswordError> {
        Params::new(
            ARGON2ID_MEMORY_KIB,
            ARGON2ID_ITERATIONS,
            ARGON2ID_PARALLELISM,
            Some(ARGON2ID_OUTPUT_LEN),
        )
        .map_err(|e| PasswordError::HashingError(e.to_string()))
    }

    /// Hashes a plaintext password using Argon2id with OWASP parameters and a 16-byte random salt.
    pub fn hash_password(&self, password: &str) -> Result<String, PasswordError> {
        verify_password_entropy(password)?;
        let params = Self::build_argon2id_params()?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut salt_bytes = [0u8; 16];
        let mut rng = rand::rng();
        rng.fill(&mut salt_bytes);
        let salt = SaltString::encode_b64(&salt_bytes)
            .map_err(|e| PasswordError::HashingError(e.to_string()))?;
        let hash = argon2
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| PasswordError::HashingError(e.to_string()))?
            .to_string();
        Ok(hash)
    }

    /// Verifies a plaintext password against a stored PHC-encoded Argon2id hash.
    pub fn verify_password(&self, password: &str, stored_hash: &str) -> bool {
        let parsed_hash = match PasswordHash::new(stored_hash) {
            Ok(h) => h,
            Err(_) => return false,
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed_hash)
            .is_ok()
    }
}

/// Extended user store methods required for identity binding.
pub trait IdentityStore: SessionStore {
    /// Retrieves a user record by email.
    fn get_user_by_email<'a>(
        &'a self,
        email: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>>;
    /// Retrieves a user record by user ID.
    fn get_user_by_id(
        &self,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<UserRecord>, SessionError>>;
    /// Updates guest user credentials to permanent email and Argon2id password hash, setting is_guest to false.
    fn bind_guest_credentials<'a>(
        &'a self,
        user_id: Uuid,
        email: &'a str,
        password_hash: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>>;
}

/// Service coordinating account identity binding and credential graduation.
#[derive(Clone)]
pub struct AuthService<S: IdentityStore> {
    pub store: S,
    pub password_service: PasswordService,
}

impl<S: IdentityStore> AuthService<S> {
    /// Creates a new `AuthService` bound to an identity store.
    pub fn new(store: S) -> Self {
        Self {
            store,
            password_service: PasswordService::new(),
        }
    }

    /// Binds permanent credentials (email and password) to an existing guest user account.
    pub async fn bind_account(
        &self,
        session_token: &str,
        email: &str,
        password: &str,
    ) -> Result<UserRecord, PasswordError> {
        let normalized_email = email.trim().to_lowercase();
        if normalized_email.is_empty() || !normalized_email.contains('@') {
            return Err(PasswordError::WeakPassword(
                "invalid email format".to_string(),
            ));
        }

        let token_hash = crate::auth::session::hash_session_token(session_token);
        let session = self
            .store
            .get_session_by_token_hash(&token_hash)
            .await
            .map_err(|e| PasswordError::Storage(e.to_string()))?
            .ok_or_else(|| PasswordError::Unauthorized("invalid or expired session".to_string()))?;

        let now = crate::auth::magic_link::now_epoch_seconds();
        if session.expires_at < now {
            return Err(PasswordError::Unauthorized("session expired".to_string()));
        }

        let user = self
            .store
            .get_user_by_id(session.user_id)
            .await
            .map_err(|e| PasswordError::Storage(e.to_string()))?
            .ok_or(PasswordError::UserNotFound)?;

        if !user.is_guest {
            return Err(PasswordError::Unauthorized(
                "session is already a permanent account".to_string(),
            ));
        }

        let existing_user = self
            .store
            .get_user_by_email(&normalized_email)
            .await
            .map_err(|e| PasswordError::Storage(e.to_string()))?;

        if existing_user.is_some() {
            return Err(PasswordError::EmailAlreadyExists);
        }

        let password_hash = self.password_service.hash_password(password)?;

        let updated_user = self
            .store
            .bind_guest_credentials(user.id, &normalized_email, &password_hash)
            .await
            .map_err(|e| PasswordError::Storage(e.to_string()))?;

        Ok(updated_user)
    }
}

/// Request payload submitted to POST /api/v1/auth/bind-account.
#[derive(Debug, Deserialize, Serialize)]
pub struct BindAccountRequest {
    pub email: String,
    pub password: String,
}

/// Successful response payload returned by POST /api/v1/auth/bind-account.
#[derive(Debug, Serialize, Deserialize)]
pub struct BindAccountResponse {
    pub user_id: Uuid,
    pub username: String,
    pub email: String,
    pub is_guest: bool,
}

/// Error payload returned on failed identity binding requests.
#[derive(Debug, Serialize, Deserialize)]
pub struct BindAccountErrorResponse {
    pub code: String,
    pub error: String,
}

/// Extracts session token from Cookie header (trame_session) or Authorization: Bearer <token>.
pub fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    if let Some(cookie_hdr) = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
    {
        for part in cookie_hdr.split(';') {
            let trimmed = part.trim();
            if let Some(token) = trimmed.strip_prefix("trame_session=")
                && !token.is_empty()
            {
                return Some(token.to_string());
            }
        }
    }

    if let Some(auth_hdr) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = auth_hdr.trim();
        if let Some(token) = trimmed.strip_prefix("Bearer ")
            && !token.is_empty()
        {
            return Some(token.trim().to_string());
        }
    }

    None
}

/// HTTP handler for POST /api/v1/auth/bind-account.
pub async fn bind_account_handler(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(payload): Json<BindAccountRequest>,
) -> Response {
    let session_token = match extract_session_token(&headers) {
        Some(token) => token,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(BindAccountErrorResponse {
                    code: "UNAUTHORIZED".to_string(),
                    error: "authentication session required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let auth_service = AuthService::new(state.session_store.clone());
    match auth_service
        .bind_account(&session_token, &payload.email, &payload.password)
        .await
    {
        Ok(updated_user) => {
            let resp = BindAccountResponse {
                user_id: updated_user.id,
                username: updated_user.username,
                email: updated_user.email.unwrap_or(payload.email),
                is_guest: updated_user.is_guest,
            };
            (StatusCode::OK, Json(resp)).into_response()
        }
        Err(PasswordError::EmailAlreadyExists) => (
            StatusCode::CONFLICT,
            Json(BindAccountErrorResponse {
                code: "EMAIL_ALREADY_EXISTS".to_string(),
                error: "email already registered in the users table".to_string(),
            }),
        )
            .into_response(),
        Err(PasswordError::Unauthorized(msg)) => (
            StatusCode::UNAUTHORIZED,
            Json(BindAccountErrorResponse {
                code: "UNAUTHORIZED".to_string(),
                error: msg,
            }),
        )
            .into_response(),
        Err(PasswordError::WeakPassword(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(BindAccountErrorResponse {
                code: "WEAK_PASSWORD".to_string(),
                error: msg,
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(BindAccountErrorResponse {
                code: "INTERNAL_ERROR".to_string(),
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}
