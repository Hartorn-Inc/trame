//! ============================================================================
//! ACCOUNT RECOVERY: OWNER-MINTED RESET LINKS & PASSWORD CHANGE (recovery.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Keeps every account recoverable without email delivery (spec story 15,
//! ADR-0039). The `Owner` mints a one-time password-reset link for any account
//! and hands it over out of band; a signed-in user changes their own password
//! from account settings; an operator who lost the `Owner` password mints the
//! `Owner`'s link from the server CLI (`trame-server owner-reset-link`), the
//! way the bootstrap URL reaches the logs. Without it a forgotten password
//! loses the account and its characters for good.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Hashed, Short-Lived, Single-Use Links`:
//!      - Tokens are 256-bit random hex strings; only their SHA-256 digest is
//!        stored. A link lives `PASSWORD_RESET_TTL_SECONDS` (24 h), is consumed
//!        by its first successful use, and minting a new link for an account
//!        deletes that account's previous unused links.
//!   2. `Reset Revokes Every Session`:
//!      - `redeem_password_reset` consumes the token, stores the new hash and
//!        deletes every session of the account in one critical section, so a
//!        stolen session dies with the old password. TOTP stays enrolled: the
//!        next sign-in still asks for the code.
//!   3. `Change Needs The Current Password (And TOTP)`:
//!      - `POST /auth/password` verifies the current password, then the TOTP
//!        code when the account has TOTP, before hashing the new one. Other
//!        sessions are revoked; the caller's own session is kept.
//!   4. `Rate-Limited Credential Routes`:
//!      - Mint, status, redeem and change sit behind
//!        `auth_rate_limit_middleware` (route families `admin`, `reset`,
//!        `password`), and a rejected TOTP code extends the TOTP lockout.
//!   5. `No Guest Links`:
//!      - Legacy guest accounts have no email to sign in with, so minting a
//!        link for one answers `409 GUEST_ACCOUNT`.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `POST /api/v1/instance/users/{id}/password-reset` (Owner)
//!     └── `mint_password_reset` -> `201 { reset_url, expires_at }`.
//!   `POST /api/v1/auth/password-reset/status` -> `{ status, email? }`.
//!   `POST /api/v1/auth/password-reset`
//!     ├── 1. Status check (`401 INVALID_RESET_TOKEN` / `RESET_TOKEN_EXPIRED`).
//!     ├── 2. Entropy check + Argon2id hash (`400 WEAK_PASSWORD`).
//!     └── 3. `RecoveryStore::redeem_password_reset` (atomic) -> `200`.
//!   `trame-server owner-reset-link`
//!     └── `mint_owner_password_reset` -> one log line `owner_password_reset_url`.
//! ============================================================================

use super::magic_link::now_epoch_seconds;
use super::password::{PasswordError, PasswordService, extract_session_token};
use super::session::{
    AuthErrorResponse, AuthState, BoxFuture, FullAuthStore, InMemorySessionStore, SessionError,
    UserRecord, authenticate_user_from_headers, generate_session_token, hash_session_token,
};
use crate::auth::accounts::InstanceRole;
use crate::security::{auth_rate_limit_middleware, totp_rejected};
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::post;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Lifetime of a password-reset link: 24 hours in seconds (mirrored by a SQL `CHECK`).
pub const PASSWORD_RESET_TTL_SECONDS: u64 = 24 * 3600;

/// SPA route that receives the reset token as `?token=`.
pub const PASSWORD_RESET_PATH: &str = "/reset-password";

/// CLI argument that mints the `Owner`'s reset link and exits.
pub const OWNER_RESET_ARG: &str = "owner-reset-link";

/// Stable `event` field of the log line carrying the `Owner`'s reset URL.
pub const OWNER_RESET_LOG_EVENT: &str = "owner_password_reset_url";

/// Persisted password-reset link (the raw token is never stored).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordResetRecord {
    /// SHA-256 hex digest of the raw token.
    pub token_hash: String,
    /// Account whose password the link resets.
    pub user_id: Uuid,
    /// `Owner` who minted it; `None` when minted from the server CLI.
    pub created_by: Option<Uuid>,
    /// Creation time (epoch seconds).
    pub created_at: u64,
    /// Expiry (epoch seconds), `created_at + PASSWORD_RESET_TTL_SECONDS`.
    pub expires_at: u64,
}

/// What a presented reset token currently opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordResetLookup {
    /// Unused and unexpired: resets this account.
    Valid(UserRecord),
    /// Unused but past its expiry.
    Expired,
    /// Unknown, used, or replaced by a newer link.
    Invalid,
}

/// Why a reset token could not be redeemed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PasswordResetError {
    /// Unknown, used, or replaced.
    #[error("reset link is invalid or already used")]
    Invalid,
    /// Past `expires_at`.
    #[error("reset link has expired")]
    Expired,
    /// Storage failure.
    #[error("storage error: {0}")]
    Storage(String),
}

/// Storage contract for password-reset links and password changes.
pub trait RecoveryStore: Send + Sync {
    /// Deletes the account's unused links, then stores `record`.
    fn create_password_reset(
        &self,
        record: PasswordResetRecord,
    ) -> BoxFuture<'_, Result<(), SessionError>>;

    /// Resolves `token_hash` at `now` (invariant 1).
    fn password_reset_lookup<'a>(
        &'a self,
        token_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<PasswordResetLookup, SessionError>>;

    /// Atomically consumes the token, stores `password_hash`, and deletes every session of
    /// the account (invariant 2). Returns the account id.
    fn redeem_password_reset<'a>(
        &'a self,
        token_hash: &'a str,
        password_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<Uuid, PasswordResetError>>;

    /// Stores `password_hash` and deletes every session of `user_id` except `keep_session`
    /// (the caller's own session digest, if any).
    fn change_password<'a>(
        &'a self,
        user_id: Uuid,
        password_hash: &'a str,
        keep_session: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), SessionError>>;
}

/// Freshly minted reset link (the raw token exists only here and in the response or log).
#[derive(Debug, Clone)]
pub struct PasswordResetTicket {
    /// Account the link resets.
    pub user_id: Uuid,
    /// `{TRAME_PUBLIC_ORIGIN}/reset-password?token={token}` (relative without an origin).
    pub reset_url: String,
    /// Expiry (epoch seconds).
    pub expires_at: u64,
}

/// Mints a reset link for `user_id`, replacing its previous unused links.
pub async fn mint_password_reset(
    store: &dyn FullAuthStore,
    user_id: Uuid,
    created_by: Option<Uuid>,
    public_origin: Option<&str>,
    now: u64,
) -> Result<PasswordResetTicket, SessionError> {
    let token = generate_session_token();
    let expires_at = now + PASSWORD_RESET_TTL_SECONDS;
    store
        .create_password_reset(PasswordResetRecord {
            token_hash: hash_session_token(&token),
            user_id,
            created_by,
            created_at: now,
            expires_at,
        })
        .await?;
    Ok(PasswordResetTicket {
        user_id,
        reset_url: format!(
            "{}{PASSWORD_RESET_PATH}?token={token}",
            public_origin.unwrap_or("")
        ),
        expires_at,
    })
}

/// Mints the `Owner`'s reset link for the CLI; `None` while the instance has no `Owner`.
pub async fn mint_owner_password_reset(
    store: &dyn FullAuthStore,
    public_origin: Option<&str>,
    now: u64,
) -> Result<Option<PasswordResetTicket>, SessionError> {
    let Some(owner) = store
        .list_users()
        .await?
        .into_iter()
        .find(|u| u.instance_role == InstanceRole::Owner)
    else {
        return Ok(None);
    };
    mint_password_reset(store, owner.id, None, public_origin, now)
        .await
        .map(Some)
}

/// Logs the `Owner`'s reset URL once, as one structured line with
/// `event = "owner_password_reset_url"`.
pub fn log_owner_password_reset(ticket: &PasswordResetTicket) {
    tracing::warn!(
        event = OWNER_RESET_LOG_EVENT,
        reset_url = %ticket.reset_url,
        expires_at = ticket.expires_at,
        "Owner password reset link minted: open it within 24 hours; it works once"
    );
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(AuthErrorResponse {
            code: Some(code.to_string()),
            error: message.to_string(),
        }),
    )
        .into_response()
}

fn storage_error(err: impl std::fmt::Display) -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "STORAGE_ERROR",
        &err.to_string(),
    )
}

/// Hashes `password` or answers `400 WEAK_PASSWORD` / `500 HASHING_ERROR`.
async fn hash_new_password(password: String) -> Result<String, Response> {
    match PasswordService::new()
        .hash_password_blocking(password)
        .await
    {
        Ok(hash) => Ok(hash),
        Err(PasswordError::WeakPassword(msg)) => {
            Err(error(StatusCode::BAD_REQUEST, "WEAK_PASSWORD", &msg))
        }
        Err(err) => Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "HASHING_ERROR",
            &err.to_string(),
        )),
    }
}

/// Response of `POST /api/v1/instance/users/{user_id}/password-reset`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PasswordResetLinkResponse {
    /// One-time link to hand to the account holder.
    pub reset_url: String,
    /// Expiry (epoch seconds).
    pub expires_at: u64,
}

/// `POST /api/v1/instance/users/{user_id}/password-reset` (Owner only).
pub async fn mint_password_reset_handler(
    State(state): State<AuthState>,
    Path(user_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let owner = match authenticate_user_from_headers(&state, &headers).await {
        Ok(user) if user.instance_role == InstanceRole::Owner => user,
        Ok(_) => {
            return error(
                StatusCode::FORBIDDEN,
                "OWNER_REQUIRED",
                "only the instance Owner may mint password reset links",
            );
        }
        Err((status, err)) => return (status, Json(err)).into_response(),
    };
    match state.session_store.get_user_by_id(user_id).await {
        Ok(Some(target)) if target.is_guest || target.email.is_none() => {
            return error(
                StatusCode::CONFLICT,
                "GUEST_ACCOUNT",
                "a guest account has no email to sign in with",
            );
        }
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "USER_NOT_FOUND", "user not found"),
        Err(err) => return storage_error(err),
    }
    match mint_password_reset(
        state.session_store.as_ref(),
        user_id,
        Some(owner.id),
        state.security.public_origin.as_deref(),
        now_epoch_seconds(),
    )
    .await
    {
        Ok(ticket) => {
            tracing::info!(%user_id, owner_id = %owner.id, "password reset link minted by the Owner");
            (
                StatusCode::CREATED,
                Json(PasswordResetLinkResponse {
                    reset_url: ticket.reset_url,
                    expires_at: ticket.expires_at,
                }),
            )
                .into_response()
        }
        Err(err) => storage_error(err),
    }
}

/// Body of `POST /api/v1/auth/password-reset/status`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PasswordResetStatusRequest {
    /// Raw reset token.
    pub token: String,
}

/// Response of `POST /api/v1/auth/password-reset/status`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PasswordResetStatusResponse {
    /// `"valid"`, `"expired"`, or `"invalid"` (unknown, used, or replaced).
    pub status: String,
    /// Email of the account the link resets, only while `valid`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// `POST /api/v1/auth/password-reset/status`: lets the reset page validate its token.
pub async fn password_reset_status_handler(
    State(state): State<AuthState>,
    Json(req): Json<PasswordResetStatusRequest>,
) -> Response {
    let lookup = match state
        .session_store
        .password_reset_lookup(&hash_session_token(req.token.trim()), now_epoch_seconds())
        .await
    {
        Ok(lookup) => lookup,
        Err(err) => return storage_error(err),
    };
    let (status, email) = match lookup {
        PasswordResetLookup::Valid(user) => ("valid", user.email),
        PasswordResetLookup::Expired => ("expired", None),
        PasswordResetLookup::Invalid => ("invalid", None),
    };
    Json(PasswordResetStatusResponse {
        status: status.to_string(),
        email,
    })
    .into_response()
}

/// Body of `POST /api/v1/auth/password-reset`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PasswordResetRequest {
    /// Raw reset token from the link.
    pub token: String,
    /// New password (entropy-checked, Argon2id-hashed).
    pub new_password: String,
}

fn invalid_reset_token() -> Response {
    error(
        StatusCode::UNAUTHORIZED,
        "INVALID_RESET_TOKEN",
        "reset link is invalid or already used",
    )
}

fn expired_reset_token() -> Response {
    error(
        StatusCode::UNAUTHORIZED,
        "RESET_TOKEN_EXPIRED",
        "reset link has expired; ask the Owner for a new one",
    )
}

/// `POST /api/v1/auth/password-reset`: sets a new password from a reset link (see the
/// module lifecycle). The caller signs in afterwards; no session is issued here.
pub async fn password_reset_handler(
    State(state): State<AuthState>,
    Json(req): Json<PasswordResetRequest>,
) -> Response {
    let token_hash = hash_session_token(req.token.trim());
    let now = now_epoch_seconds();
    match state
        .session_store
        .password_reset_lookup(&token_hash, now)
        .await
    {
        Ok(PasswordResetLookup::Valid(_)) => {}
        Ok(PasswordResetLookup::Expired) => return expired_reset_token(),
        Ok(PasswordResetLookup::Invalid) => return invalid_reset_token(),
        Err(err) => return storage_error(err),
    }
    let password_hash = match hash_new_password(req.new_password).await {
        Ok(hash) => hash,
        Err(resp) => return resp,
    };
    match state
        .session_store
        .redeem_password_reset(&token_hash, &password_hash, now)
        .await
    {
        Ok(user_id) => {
            tracing::info!(%user_id, "password reset through a one-time link; sessions revoked");
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(PasswordResetError::Invalid) => invalid_reset_token(),
        Err(PasswordResetError::Expired) => expired_reset_token(),
        Err(err) => storage_error(err),
    }
}

/// Body of `POST /api/v1/auth/password`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChangePasswordRequest {
    /// Current password (always required).
    pub current_password: String,
    /// New password (entropy-checked, Argon2id-hashed).
    pub new_password: String,
    /// 6-digit TOTP code, required when the account has TOTP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_code: Option<String>,
}

/// `POST /api/v1/auth/password`: the signed-in user changes their password (invariant 3).
pub async fn change_password_handler(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Response {
    let user = match authenticate_user_from_headers(&state, &headers).await {
        Ok(user) => user,
        Err((status, err)) => return (status, Json(err)).into_response(),
    };
    let verified = match user.password_hash.clone() {
        Some(hash) => {
            PasswordService::new()
                .verify_password_blocking(req.current_password.clone(), hash)
                .await
        }
        None => false,
    };
    if !verified {
        return error(
            StatusCode::UNAUTHORIZED,
            "INVALID_CREDENTIALS",
            "current password is incorrect",
        );
    }
    if user.mfa_enabled || user.totp_secret.is_some() {
        let Some(code) = req.totp_code.as_deref().filter(|c| !c.trim().is_empty()) else {
            return error(
                StatusCode::UNAUTHORIZED,
                "MFA_REQUIRED",
                "TOTP verification code is required",
            );
        };
        let valid = user
            .totp_secret
            .as_deref()
            .and_then(|secret| state.totp_service.decrypt_secret(secret).ok())
            .is_some_and(|secret| {
                state
                    .totp_service
                    .verify_code(&secret, code, now_epoch_seconds())
            });
        if !valid {
            return totp_rejected(error(
                StatusCode::UNAUTHORIZED,
                "INVALID_TOTP_CODE",
                "invalid or expired TOTP code",
            ));
        }
    }
    let password_hash = match hash_new_password(req.new_password).await {
        Ok(hash) => hash,
        Err(resp) => return resp,
    };
    let keep = extract_session_token(&headers).map(|t| hash_session_token(&t));
    match state
        .session_store
        .change_password(user.id, &password_hash, keep.as_deref())
        .await
    {
        Ok(()) => {
            tracing::info!(user_id = %user.id, "password changed; other sessions revoked");
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(err) => storage_error(err),
    }
}

/// Rate-limited recovery routes (invariant 4).
pub fn recovery_router(state: AuthState) -> Router {
    Router::new()
        .route(
            "/api/v1/instance/users/{user_id}/password-reset",
            post(mint_password_reset_handler),
        )
        .route(
            "/api/v1/auth/password-reset/status",
            post(password_reset_status_handler),
        )
        .route("/api/v1/auth/password-reset", post(password_reset_handler))
        .route("/api/v1/auth/password", post(change_password_handler))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_rate_limit_middleware,
        ))
        .with_state(state)
}

/// In-memory links: `(record, used)`. Lock order: `password_resets` -> `users` -> `sessions`.
pub type InMemoryPasswordResets = Vec<(PasswordResetRecord, bool)>;

impl RecoveryStore for InMemorySessionStore {
    fn create_password_reset(
        &self,
        record: PasswordResetRecord,
    ) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            let mut resets = self.password_resets.lock().await;
            resets.retain(|(r, used)| *used || r.user_id != record.user_id);
            resets.push((record, false));
            Ok(())
        })
    }

    fn password_reset_lookup<'a>(
        &'a self,
        token_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<PasswordResetLookup, SessionError>> {
        Box::pin(async move {
            let resets = self.password_resets.lock().await;
            let Some((record, false)) = resets.iter().find(|(r, _)| r.token_hash == token_hash)
            else {
                return Ok(PasswordResetLookup::Invalid);
            };
            if now >= record.expires_at {
                return Ok(PasswordResetLookup::Expired);
            }
            Ok(match self.users.read().await.get(&record.user_id) {
                Some(user) => PasswordResetLookup::Valid(user.clone()),
                None => PasswordResetLookup::Invalid,
            })
        })
    }

    fn redeem_password_reset<'a>(
        &'a self,
        token_hash: &'a str,
        password_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<Uuid, PasswordResetError>> {
        Box::pin(async move {
            let mut resets = self.password_resets.lock().await;
            let Some((record, used)) = resets
                .iter_mut()
                .find(|(r, used)| r.token_hash == token_hash && !*used)
            else {
                return Err(PasswordResetError::Invalid);
            };
            if now >= record.expires_at {
                return Err(PasswordResetError::Expired);
            }
            let user_id = record.user_id;
            let mut users = self.users.write().await;
            let Some(user) = users.get_mut(&user_id) else {
                return Err(PasswordResetError::Invalid);
            };
            user.password_hash = Some(password_hash.to_string());
            *used = true;
            self.sessions
                .write()
                .await
                .retain(|_, s| s.user_id != user_id);
            Ok(user_id)
        })
    }

    fn change_password<'a>(
        &'a self,
        user_id: Uuid,
        password_hash: &'a str,
        keep_session: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let mut users = self.users.write().await;
            let user = users.get_mut(&user_id).ok_or(SessionError::NotFound)?;
            user.password_hash = Some(password_hash.to_string());
            self.sessions
                .write()
                .await
                .retain(|hash, s| s.user_id != user_id || Some(hash.as_str()) == keep_session);
            Ok(())
        })
    }
}
