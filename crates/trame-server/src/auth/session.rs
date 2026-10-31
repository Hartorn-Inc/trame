//! Session management, guest user provisioning, and cookie issuance.

use super::magic_link::{MagicLinkClaims, MagicLinkError, MagicLinkService, now_epoch_seconds};
use crate::storage::blob::Sha256Hasher;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header::{HeaderMap, HeaderValue, SET_COOKIE};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::post;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use uuid::Uuid;

/// Pinned future returning `T` for dyn-compatible session storage calls.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Name of the authoritative session cookie.
pub const SESSION_COOKIE_NAME: &str = "trame_session";

/// Default session duration: 7 days in seconds.
pub const DEFAULT_SESSION_TTL_SECONDS: u64 = 7 * 24 * 3600;

/// Error returned during session and onboarding operations.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("session not found")]
    NotFound,
    #[error("storage error: {0}")]
    Storage(String),
}

/// Persistent record for a user (guest or authenticated).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserRecord {
    pub id: Uuid,
    pub username: String,
    pub role: String,
    pub is_guest: bool,
    pub created_at: u64,
}

/// Association of a user to a campaign with optional assigned character.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignMemberRecord {
    pub campaign_id: Uuid,
    pub user_id: Uuid,
    pub character_id: Option<Uuid>,
    pub role: String,
    pub joined_at: u64,
}

/// Active user session indexed by SHA-256 digest of the 256-bit session token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub created_at: u64,
    pub expires_at: u64,
}

/// Storage trait for guest users, campaign memberships, sessions, and revoked invites.
pub trait SessionStore: Send + Sync {
    fn create_guest_user<'a>(
        &'a self,
        role: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>>;
    fn assign_campaign_member<'a>(
        &'a self,
        campaign_id: Uuid,
        user_id: Uuid,
        character_id: Option<Uuid>,
        role: &'a str,
    ) -> BoxFuture<'a, Result<CampaignMemberRecord, SessionError>>;
    fn create_session<'a>(
        &'a self,
        user_id: Uuid,
        token_hash: &'a str,
        ttl_seconds: u64,
    ) -> BoxFuture<'a, Result<SessionRecord, SessionError>>;
    fn get_session_by_token_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<SessionRecord>, SessionError>>;
    fn is_invite_revoked(&self, jti: Uuid) -> BoxFuture<'_, bool>;
    fn revoke_invite(&self, jti: Uuid) -> BoxFuture<'_, Result<(), SessionError>>;
    fn get_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignMemberRecord>, SessionError>>;
}

/// In-memory implementation of `SessionStore`.
#[derive(Default, Clone)]
pub struct InMemorySessionStore {
    users: Arc<RwLock<HashMap<Uuid, UserRecord>>>,
    campaign_members: Arc<RwLock<HashMap<(Uuid, Uuid), CampaignMemberRecord>>>,
    sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    revoked_invites: Arc<RwLock<HashSet<Uuid>>>,
}

impl InMemorySessionStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SessionStore for InMemorySessionStore {
    fn create_guest_user<'a>(
        &'a self,
        role: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        Box::pin(async move {
            let user_id = Uuid::new_v4();
            let user = UserRecord {
                id: user_id,
                username: format!("guest_{}", &user_id.to_string()[..8]),
                role: role.to_string(),
                is_guest: true,
                created_at: now_epoch_seconds(),
            };
            self.users.write().await.insert(user_id, user.clone());
            Ok(user)
        })
    }

    fn assign_campaign_member<'a>(
        &'a self,
        campaign_id: Uuid,
        user_id: Uuid,
        character_id: Option<Uuid>,
        role: &'a str,
    ) -> BoxFuture<'a, Result<CampaignMemberRecord, SessionError>> {
        Box::pin(async move {
            let record = CampaignMemberRecord {
                campaign_id,
                user_id,
                character_id,
                role: role.to_string(),
                joined_at: now_epoch_seconds(),
            };
            self.campaign_members
                .write()
                .await
                .insert((campaign_id, user_id), record.clone());
            Ok(record)
        })
    }

    fn create_session<'a>(
        &'a self,
        user_id: Uuid,
        token_hash: &'a str,
        ttl_seconds: u64,
    ) -> BoxFuture<'a, Result<SessionRecord, SessionError>> {
        Box::pin(async move {
            let now = now_epoch_seconds();
            let record = SessionRecord {
                session_id: Uuid::new_v4(),
                user_id,
                token_hash: token_hash.to_string(),
                created_at: now,
                expires_at: now.saturating_add(ttl_seconds),
            };
            self.sessions
                .write()
                .await
                .insert(token_hash.to_string(), record.clone());
            Ok(record)
        })
    }

    fn get_session_by_token_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<SessionRecord>, SessionError>> {
        Box::pin(async move {
            let map = self.sessions.read().await;
            Ok(map.get(token_hash).cloned())
        })
    }

    fn is_invite_revoked(&self, jti: Uuid) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.revoked_invites.read().await.contains(&jti) })
    }

    fn revoke_invite(&self, jti: Uuid) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            self.revoked_invites.write().await.insert(jti);
            Ok(())
        })
    }

    fn get_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignMemberRecord>, SessionError>> {
        Box::pin(async move {
            let map = self.campaign_members.read().await;
            Ok(map.get(&(campaign_id, user_id)).cloned())
        })
    }
}

/// Generates a cryptographically random 256-bit session token encoded as hex.
pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    let mut rng = rand::rng();
    rng.fill(&mut bytes);
    let mut hex = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{:02x}", b);
    }
    hex
}

/// Computes the SHA-256 hex digest of a raw session token string.
pub fn hash_session_token(token: &str) -> String {
    Sha256Hasher::digest(token.as_bytes())
}

/// Constructs the Set-Cookie header value for `trame_session`.
pub fn build_session_cookie_header(token: &str, ttl_seconds: u64) -> String {
    format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={ttl_seconds}; HttpOnly; Secure; SameSite=Lax"
    )
}

/// Shared state for authentication routes.
#[derive(Clone)]
pub struct AuthState {
    pub magic_link_service: Arc<MagicLinkService>,
    pub session_store: Arc<dyn SessionStore>,
}

/// Request payload submitted to POST /api/v1/auth/magic-link.
#[derive(Debug, Deserialize, Serialize)]
pub struct MagicLinkLoginRequest {
    pub token: String,
}

/// Response payload returned on successful magic link onboarding.
#[derive(Debug, Serialize, Deserialize)]
pub struct MagicLinkLoginResponse {
    pub user_id: Uuid,
    pub username: String,
    pub campaign_id: Uuid,
    pub character_id: Option<Uuid>,
    pub role: String,
    pub session_id: Uuid,
}

/// Response payload returned on authentication error.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthErrorResponse {
    pub error: String,
}

/// Axum handler consuming magic link JWTs at POST /api/v1/auth/magic-link.
pub async fn magic_link_login_handler(
    State(state): State<AuthState>,
    Json(payload): Json<MagicLinkLoginRequest>,
) -> Response {
    let claims = match state
        .magic_link_service
        .validate_invite_token(&payload.token, state.session_store.as_ref())
        .await
    {
        Ok(c) => c,
        Err(MagicLinkError::ExpiredToken) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    error: "invite token has expired".to_string(),
                }),
            )
                .into_response();
        }
        Err(MagicLinkError::RevokedToken) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    error: "invite token has been revoked".to_string(),
                }),
            )
                .into_response();
        }
        Err(err) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    error: err.to_string(),
                }),
            )
                .into_response();
        }
    };

    let guest_user = match state.session_store.create_guest_user(&claims.role).await {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(AuthErrorResponse {
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    if let Err(e) = state
        .session_store
        .assign_campaign_member(
            claims.campaign_id,
            guest_user.id,
            claims.character_id,
            &claims.role,
        )
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(AuthErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response();
    }

    let session_token = generate_session_token();
    let token_hash = hash_session_token(&session_token);
    let session_record = match state
        .session_store
        .create_session(guest_user.id, &token_hash, DEFAULT_SESSION_TTL_SECONDS)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(AuthErrorResponse {
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    let cookie_val = build_session_cookie_header(&session_token, DEFAULT_SESSION_TTL_SECONDS);
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&cookie_val) {
        headers.insert(SET_COOKIE, val);
    }

    let resp = MagicLinkLoginResponse {
        user_id: guest_user.id,
        username: guest_user.username,
        campaign_id: claims.campaign_id,
        character_id: claims.character_id,
        role: guest_user.role,
        session_id: session_record.session_id,
    };

    (StatusCode::OK, headers, Json(resp)).into_response()
}

/// Request payload for GM/Admin creating an invite link.
#[derive(Debug, Deserialize, Serialize)]
pub struct CreateInviteLinkRequest {
    pub campaign_id: Uuid,
    pub character_id: Option<Uuid>,
    pub role: Option<String>,
    pub ttl_seconds: Option<u64>,
}

/// Response payload returning the minted JWT invite token.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateInviteLinkResponse {
    pub token: String,
    pub claims: MagicLinkClaims,
}

/// Handler for creating invite links (GM/Admin role).
pub async fn create_invite_link_handler(
    State(state): State<AuthState>,
    Json(payload): Json<CreateInviteLinkRequest>,
) -> Response {
    let role = payload.role.unwrap_or_else(|| "PLAYER".to_string());
    let ttl = payload.ttl_seconds.unwrap_or(DEFAULT_SESSION_TTL_SECONDS);
    let creator_id = Uuid::new_v4();

    match state.magic_link_service.create_invite_token(
        creator_id,
        payload.campaign_id,
        payload.character_id,
        &role,
        ttl,
    ) {
        Ok((token, claims)) => (
            StatusCode::OK,
            Json(CreateInviteLinkResponse { token, claims }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(AuthErrorResponse {
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Builds the Axum router for authentication endpoints.
pub fn build_auth_router(state: AuthState) -> Router {
    Router::new()
        .route("/api/v1/auth/magic-link", post(magic_link_login_handler))
        .route("/api/v1/auth/invites", post(create_invite_link_handler))
        .with_state(state)
}
