//! ============================================================================
//! PURPOSE:
//!   Implements Personal Access Tokens (PAT) for Model Context Protocol (MCP)
//!   and programmatic HTTP clients. Generates tokens with prefix `trame_pat_`
//!   and 40 Base62 random characters, persisting only SHA-256 digests in
//!   `personal_access_tokens` and enforcing token expiration with constant-time
//!   digest lookups.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Raw PAT tokens are returned strictly ONCE in plaintext at creation time.
//!   - Tokens are stored exclusively as lowercase hex SHA-256 digests.
//!   - Token verification compares candidate hashes in constant time to prevent
//!     timing side-channel attacks.
//!   - Expired tokens fail immediately with HTTP 401 Unauthorized.
//! ============================================================================

use super::magic_link::now_epoch_seconds;
use super::password::extract_session_token;
use super::session::{AuthState, BoxFuture, SessionStore, hash_session_token};
use crate::storage::blob::Sha256Hasher;
use axum::extract::State;
use axum::http::header::HeaderMap;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;

/// Standard prefix for all TRAME personal access tokens.
pub const PAT_PREFIX: &str = "trame_pat_";

/// Number of cryptographically random Base62 characters following the prefix.
pub const PAT_TOKEN_CHARS_LEN: usize = 40;

/// Base62 character pool: digits, uppercase, lowercase.
const BASE62_CHARSET: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Errors occurring during PAT creation, persistence, or validation.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PatError {
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("invalid scopes: {0}")]
    InvalidScopes(String),
    #[error("malformed personal access token")]
    MalformedToken,
    #[error("personal access token not found or invalid")]
    NotFound,
    #[error("personal access token has expired")]
    Expired,
    #[error("invalid authorization header")]
    InvalidHeader,
    #[error("bearer token is not a personal access token")]
    NotPat,
    #[error("storage error: {0}")]
    Storage(String),
}

/// Persistent record stored in the `personal_access_tokens` collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign_id: Option<Uuid>,
    pub token_hash: String,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

/// Data access trait for persisting and querying `personal_access_tokens`.
pub trait PatStore: Send + Sync {
    fn save_pat<'a>(&'a self, record: PatRecord) -> BoxFuture<'a, Result<(), PatError>>;
    fn find_pat_by_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<PatRecord>, PatError>>;
    fn list_pats_for_user<'a>(
        &'a self,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<Vec<PatRecord>, PatError>>;
    fn revoke_pat<'a>(
        &'a self,
        pat_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<bool, PatError>>;
}

impl<T: PatStore + ?Sized> PatStore for Arc<T> {
    fn save_pat<'a>(&'a self, record: PatRecord) -> BoxFuture<'a, Result<(), PatError>> {
        (**self).save_pat(record)
    }
    fn find_pat_by_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<PatRecord>, PatError>> {
        (**self).find_pat_by_hash(token_hash)
    }
    fn list_pats_for_user<'a>(
        &'a self,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<Vec<PatRecord>, PatError>> {
        (**self).list_pats_for_user(user_id)
    }
    fn revoke_pat<'a>(
        &'a self,
        pat_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<bool, PatError>> {
        (**self).revoke_pat(pat_id, user_id)
    }
}

/// Generates a new PAT matching `trame_pat_<40_base62_chars>`.
pub fn generate_pat_token() -> String {
    let mut rng = rand::rng();
    let mut token = String::with_capacity(PAT_PREFIX.len() + PAT_TOKEN_CHARS_LEN);
    token.push_str(PAT_PREFIX);
    for _ in 0..PAT_TOKEN_CHARS_LEN {
        let idx = rng.random_range(0..BASE62_CHARSET.len());
        token.push(BASE62_CHARSET[idx] as char);
    }
    token
}

/// Verifies whether a string structurally matches `trame_pat_<40_base62_chars>`.
pub fn is_valid_pat_format(token: &str) -> bool {
    if !token.starts_with(PAT_PREFIX) {
        return false;
    }
    let suffix = &token[PAT_PREFIX.len()..];
    suffix.len() == PAT_TOKEN_CHARS_LEN && suffix.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Service managing Personal Access Token creation, validation, and revocation.
#[derive(Clone)]
pub struct PatService<S: PatStore> {
    store: Arc<S>,
}

impl<S: PatStore> PatService<S> {
    /// Creates a new `PatService` bound to a backing `PatStore`.
    pub fn new(store: Arc<S>) -> Self {
        Self { store }
    }

    /// Generates a PAT token, persists its SHA-256 digest, and returns the plaintext token once.
    pub async fn create_pat(
        &self,
        user_id: Uuid,
        campaign_id: Option<Uuid>,
        scopes: Vec<String>,
        name: Option<String>,
        expires_at: Option<u64>,
    ) -> Result<(String, PatRecord), PatError> {
        if scopes.is_empty() {
            return Err(PatError::InvalidScopes(
                "scopes must not be empty".to_string(),
            ));
        }

        let plaintext_token = generate_pat_token();
        let token_hash = Sha256Hasher::digest(plaintext_token.as_bytes());
        let now = now_epoch_seconds();
        let resolved_expires_at = expires_at.or(Some(now.saturating_add(30 * 24 * 3600)));

        let record = PatRecord {
            id: Uuid::new_v4(),
            user_id,
            campaign_id,
            token_hash,
            scopes,
            name,
            created_at: now,
            expires_at: resolved_expires_at,
        };

        self.store.save_pat(record.clone()).await?;
        Ok((plaintext_token, record))
    }

    /// Validates a raw PAT string by computing its SHA-256 digest, looking it up in constant time,
    /// and enforcing expiration.
    pub async fn verify_token(&self, token: &str) -> Result<PatRecord, PatError> {
        if !is_valid_pat_format(token) {
            return Err(PatError::MalformedToken);
        }

        let computed_hash = Sha256Hasher::digest(token.as_bytes());
        let record = self
            .store
            .find_pat_by_hash(&computed_hash)
            .await?
            .ok_or(PatError::NotFound)?;

        if let Some(exp) = record.expires_at {
            let now = now_epoch_seconds();
            if now >= exp {
                return Err(PatError::Expired);
            }
        }

        Ok(record)
    }

    /// Lists all active PAT records for a given user.
    pub async fn list_pats(&self, user_id: Uuid) -> Result<Vec<PatRecord>, PatError> {
        self.store.list_pats_for_user(user_id).await
    }

    /// Revokes a PAT belonging to a specific user.
    pub async fn revoke_pat(&self, pat_id: Uuid, user_id: Uuid) -> Result<(), PatError> {
        let deleted = self.store.revoke_pat(pat_id, user_id).await?;
        if !deleted {
            return Err(PatError::NotFound);
        }
        Ok(())
    }
}

/// Middleware helper for authenticating Bearer `trame_pat_...` requests with constant-time lookup.
#[derive(Clone)]
pub struct PatMiddleware<S: PatStore> {
    service: PatService<S>,
}

impl<S: PatStore> PatMiddleware<S> {
    /// Creates a new `PatMiddleware` with the provided `PatStore`.
    pub fn new(store: Arc<S>) -> Self {
        Self {
            service: PatService::new(store),
        }
    }

    /// Authenticates an Authorization header string, returning the associated `PatRecord`.
    pub async fn authenticate_header(&self, auth_header: &str) -> Result<PatRecord, PatError> {
        let token = auth_header
            .strip_prefix("Bearer ")
            .map(str::trim)
            .ok_or(PatError::InvalidHeader)?;

        if !token.starts_with(PAT_PREFIX) {
            return Err(PatError::NotPat);
        }

        self.service.verify_token(token).await
    }

    /// Extracts and authenticates a PAT from an Axum/HTTP request if present.
    pub async fn authenticate_request<B>(
        &self,
        req: &Request<B>,
    ) -> Result<Option<PatRecord>, PatError> {
        let auth_hdr = match req.headers().get(axum::http::header::AUTHORIZATION) {
            Some(hdr) => hdr.to_str().map_err(|_| PatError::InvalidHeader)?,
            None => return Ok(None),
        };

        let trimmed = auth_hdr.trim();
        if let Some(token) = trimmed.strip_prefix("Bearer ") {
            let token = token.trim();
            if token.starts_with(PAT_PREFIX) {
                return self.service.verify_token(token).await.map(Some);
            }
        }

        Ok(None)
    }
}

/// Request payload submitted to `POST /api/v1/auth/pat`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreatePatRequest {
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_seconds: Option<u64>,
}

/// Response payload returned on successful PAT creation, exposing plaintext token strictly once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePatResponse {
    pub id: Uuid,
    pub token: String,
    pub user_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign_id: Option<Uuid>,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

/// Read-only PAT metadata returned when listing user tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatMetadataResponse {
    pub id: Uuid,
    pub user_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign_id: Option<Uuid>,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

/// HTTP handler for `POST /api/v1/auth/pat`.
pub async fn create_pat_handler(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(payload): Json<CreatePatRequest>,
) -> Response {
    let session_token = match extract_session_token(&headers) {
        Some(token) => token,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "code": "UNAUTHORIZED",
                    "error": "active session required to create personal access token"
                })),
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
                Json(serde_json::json!({
                    "code": "UNAUTHORIZED",
                    "error": "invalid or expired session"
                })),
            )
                .into_response();
        }
    };

    let now = now_epoch_seconds();
    if session.expires_at < now {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "UNAUTHORIZED",
                "error": "session has expired"
            })),
        )
            .into_response();
    }

    if payload.scopes.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "code": "INVALID_SCOPES",
                "error": "at least one scope is required"
            })),
        )
            .into_response();
    }

    let expires_at = payload.expires_at.or_else(|| {
        payload
            .expires_in_seconds
            .map(|secs| now.saturating_add(secs))
    });

    let pat_service = PatService::new(state.session_store.clone());
    match pat_service
        .create_pat(
            session.user_id,
            payload.campaign_id,
            payload.scopes,
            payload.name,
            expires_at,
        )
        .await
    {
        Ok((plaintext_token, record)) => {
            let resp = CreatePatResponse {
                id: record.id,
                token: plaintext_token,
                user_id: record.user_id,
                campaign_id: record.campaign_id,
                scopes: record.scopes,
                name: record.name,
                created_at: record.created_at,
                expires_at: record.expires_at,
            };
            (StatusCode::CREATED, Json(resp)).into_response()
        }
        Err(PatError::InvalidScopes(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "code": "INVALID_SCOPES",
                "error": msg
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "code": "INTERNAL_ERROR",
                "error": err.to_string()
            })),
        )
            .into_response(),
    }
}

/// HTTP handler for `GET /api/v1/auth/pat`.
pub async fn list_pats_handler(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let session_token = match extract_session_token(&headers) {
        Some(token) => token,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "code": "UNAUTHORIZED",
                    "error": "active session required"
                })),
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
                Json(serde_json::json!({
                    "code": "UNAUTHORIZED",
                    "error": "invalid or expired session"
                })),
            )
                .into_response();
        }
    };

    let pat_service = PatService::new(state.session_store.clone());
    match pat_service.list_pats(session.user_id).await {
        Ok(pats) => {
            let items: Vec<PatMetadataResponse> = pats
                .into_iter()
                .map(|r| PatMetadataResponse {
                    id: r.id,
                    user_id: r.user_id,
                    campaign_id: r.campaign_id,
                    scopes: r.scopes,
                    name: r.name,
                    created_at: r.created_at,
                    expires_at: r.expires_at,
                })
                .collect();
            (StatusCode::OK, Json(items)).into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "code": "INTERNAL_ERROR",
                "error": err.to_string()
            })),
        )
            .into_response(),
    }
}

/// Axum middleware function evaluating `Authorization: Bearer trame_pat_...` headers.
pub async fn pat_auth_middleware(
    State(store): State<Arc<super::session::InMemorySessionStore>>,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let middleware = PatMiddleware::new(store);
    match middleware.authenticate_request(&request).await {
        Ok(Some(pat)) => {
            request.extensions_mut().insert(pat);
            next.run(request).await
        }
        Ok(None) => next.run(request).await,
        Err(PatError::Expired) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "TOKEN_EXPIRED",
                "error": "personal access token has expired"
            })),
        )
            .into_response(),
        Err(PatError::MalformedToken) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "MALFORMED_TOKEN",
                "error": "malformed personal access token"
            })),
        )
            .into_response(),
        Err(PatError::NotFound) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "INVALID_TOKEN",
                "error": "personal access token not found or invalid"
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "UNAUTHORIZED",
                "error": err.to_string()
            })),
        )
            .into_response(),
    }
}
