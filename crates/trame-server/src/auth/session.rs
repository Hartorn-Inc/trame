//! ============================================================================
//! USER SESSIONS, REGISTRATION, LOGIN & MFA (session.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Manages authenticated user sessions, development-only account registration,
//! login, TOTP MFA verification during password login, campaign membership
//! records, and `trame_session` cookies.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//! 1. `Opaque Session Digest Storage`:
//!    - Raw 256-bit session tokens are returned only via `HttpOnly; Secure;
//!      SameSite=Lax` cookies; only the SHA-256 hex digest is stored in
//!      `SessionStore`.
//! 2. `Invite-Only Accounts (ADR-0039)`:
//!    - `POST /auth/register` answers `403 REGISTRATION_CLOSED` unless
//!      `SecurityPolicy::registration_open` (only `TRAME_ENV=dev`). Accounts
//!      otherwise come from owner bootstrap (`instance.rs`) or
//!      `InviteRedemption` (`access.rs`); no route issues guest sessions.
//! 3. `Legacy Guests`:
//!    - Existing guest sessions keep working and can bind credentials through
//!      `/auth/bind` (`password.rs`); `/auth/me` reports `is_guest`.
//! 4. `TOTP MFA Enforcement on Password Login`:
//!    - When a user has `mfa_enabled` or a configured `totp_secret`,
//!      `login_handler` verifies the submitted 6-digit RFC 6238 `totp_code`
//!      before creating a session, returning HTTP 401 Unauthorized if missing
//!      or invalid.
//! ============================================================================

use super::accounts::{AccountStore, InMemoryAccounts, InstanceRole};
use super::magic_link::{MagicLinkService, now_epoch_seconds};
pub use super::oauth::{OAuthError, OAuthProvider, OAuthStore, PendingOAuthState};
pub use super::password::IdentityStore;
use super::password::{
    PasswordError, PasswordService, bind_account_handler, extract_session_token,
};
pub use super::pat::{
    PatError, PatMiddleware, PatRecord, PatStore, create_pat_handler, list_pats_handler,
};
use super::totp::{TotpService, totp_enable_handler, totp_setup_handler, totp_verify_handler};
use crate::security::{SecurityPolicy, auth_rate_limit_middleware};
use crate::storage::blob::Sha256Hasher;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header::{HeaderMap, HeaderValue, SET_COOKIE};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    #[serde(default)]
    pub mfa_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_totp_secret: Option<String>,
    /// Instance-wide role (ADR-0039); records serialized before it existed read as `Member`.
    #[serde(default)]
    pub instance_role: InstanceRole,
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
    fn delete_session<'a>(
        &'a self,
        _token_hash: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async { Ok(()) })
    }
    fn is_invite_revoked(&self, jti: Uuid) -> BoxFuture<'_, bool>;
    fn revoke_invite(&self, jti: Uuid) -> BoxFuture<'_, Result<(), SessionError>>;
    fn get_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignMemberRecord>, SessionError>>;
    fn get_campaign_members_for_user(
        &self,
        _user_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    /// Lists every member of `campaign_id`.
    fn list_campaign_members(
        &self,
        _campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// Unified trait combining `SessionStore`, `IdentityStore`, `PatStore`, `OAuthStore`, and
/// `AccountStore`.
pub trait FullAuthStore:
    SessionStore + IdentityStore + PatStore + OAuthStore + AccountStore
{
}
impl<T: SessionStore + IdentityStore + PatStore + OAuthStore + AccountStore + ?Sized> FullAuthStore
    for T
{
}

/// In-memory implementation of `SessionStore`, `IdentityStore`, and `AccountStore`.
#[derive(Default, Clone)]
pub struct InMemorySessionStore {
    pub(super) users: Arc<RwLock<HashMap<Uuid, UserRecord>>>,
    pub(super) emails: Arc<RwLock<HashMap<String, Uuid>>>,
    pub(super) campaign_members: Arc<RwLock<HashMap<(Uuid, Uuid), CampaignMemberRecord>>>,
    /// Bootstrap token, instance id, and invites; one mutex serializes claims and redemptions.
    pub(super) accounts: Arc<tokio::sync::Mutex<InMemoryAccounts>>,
    sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    revoked_invites: Arc<RwLock<HashSet<Uuid>>>,
    personal_access_tokens: Arc<RwLock<HashMap<Uuid, PatRecord>>>,
    pending_oauth: Arc<RwLock<HashMap<String, PendingOAuthState>>>,
    oauth_identities: Arc<RwLock<HashMap<(OAuthProvider, String), Uuid>>>,
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
                email: None,
                password_hash: None,
                mfa_enabled: false,
                totp_secret: None,
                pending_totp_secret: None,
                instance_role: InstanceRole::Member,
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

    fn delete_session<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            self.sessions.write().await.remove(token_hash);
            Ok(())
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

    fn get_campaign_members_for_user(
        &self,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        Box::pin(async move {
            let map = self.campaign_members.read().await;
            let list = map
                .values()
                .filter(|m| m.user_id == user_id)
                .cloned()
                .collect();
            Ok(list)
        })
    }

    fn list_campaign_members(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        Box::pin(async move {
            let map = self.campaign_members.read().await;
            let mut list: Vec<CampaignMemberRecord> = map
                .values()
                .filter(|m| m.campaign_id == campaign_id)
                .cloned()
                .collect();
            list.sort_by_key(|m| (m.joined_at, m.user_id));
            Ok(list)
        })
    }
}

impl IdentityStore for InMemorySessionStore {
    fn get_user_by_email<'a>(
        &'a self,
        email: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let normalized = email.trim().to_lowercase();
            let emails = self.emails.read().await;
            if let Some(user_id) = emails.get(&normalized).or_else(|| emails.get(email)) {
                let users = self.users.read().await;
                Ok(users.get(user_id).cloned())
            } else {
                Ok(None)
            }
        })
    }

    fn get_user_by_id(
        &self,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let users = self.users.read().await;
            Ok(users.get(&user_id).cloned())
        })
    }

    fn bind_guest_credentials<'a>(
        &'a self,
        user_id: Uuid,
        email: &'a str,
        password_hash: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        Box::pin(async move {
            let mut users = self.users.write().await;
            let user = users.get_mut(&user_id).ok_or(SessionError::NotFound)?;
            user.is_guest = false;
            user.email = Some(email.to_string());
            user.password_hash = Some(password_hash.to_string());
            let updated = user.clone();
            self.emails
                .write()
                .await
                .insert(email.to_lowercase(), user_id);
            Ok(updated)
        })
    }

    fn save_user<'a>(&'a self, user: UserRecord) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            if let Some(ref email) = user.email {
                self.emails
                    .write()
                    .await
                    .insert(email.to_lowercase(), user.id);
            }
            self.users.write().await.insert(user.id, user);
            Ok(())
        })
    }

    fn save_pending_totp_secret<'a>(
        &'a self,
        user_id: Uuid,
        encrypted_secret: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let mut users = self.users.write().await;
            let user = users.get_mut(&user_id).ok_or(SessionError::NotFound)?;
            user.pending_totp_secret = Some(encrypted_secret.to_string());
            Ok(())
        })
    }

    fn enable_totp_for_user<'a>(
        &'a self,
        user_id: Uuid,
        encrypted_secret: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let mut users = self.users.write().await;
            let user = users.get_mut(&user_id).ok_or(SessionError::NotFound)?;
            user.mfa_enabled = true;
            user.totp_secret = Some(encrypted_secret.to_string());
            user.pending_totp_secret = None;
            Ok(())
        })
    }
}

impl PatStore for InMemorySessionStore {
    fn save_pat<'a>(&'a self, record: PatRecord) -> BoxFuture<'a, Result<(), PatError>> {
        Box::pin(async move {
            self.personal_access_tokens
                .write()
                .await
                .insert(record.id, record);
            Ok(())
        })
    }

    fn find_pat_by_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<PatRecord>, PatError>> {
        Box::pin(async move {
            let pats = self.personal_access_tokens.read().await;
            let mut matched = None;
            for record in pats.values() {
                if super::magic_link::constant_time_eq(
                    record.token_hash.as_bytes(),
                    token_hash.as_bytes(),
                ) {
                    matched = Some(record.clone());
                }
            }
            Ok(matched)
        })
    }

    fn list_pats_for_user<'a>(
        &'a self,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<Vec<PatRecord>, PatError>> {
        Box::pin(async move {
            let pats = self.personal_access_tokens.read().await;
            let list = pats
                .values()
                .filter(|p| p.user_id == user_id)
                .cloned()
                .collect();
            Ok(list)
        })
    }

    fn revoke_pat<'a>(
        &'a self,
        pat_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<bool, PatError>> {
        Box::pin(async move {
            let mut pats = self.personal_access_tokens.write().await;
            if let Some(record) = pats.get(&pat_id)
                && record.user_id == user_id
            {
                pats.remove(&pat_id);
                return Ok(true);
            }
            Ok(false)
        })
    }
}

impl OAuthStore for InMemorySessionStore {
    fn save_pending_oauth<'a>(
        &'a self,
        state: PendingOAuthState,
    ) -> BoxFuture<'a, Result<(), OAuthError>> {
        Box::pin(async move {
            self.pending_oauth
                .write()
                .await
                .insert(state.state.clone(), state);
            Ok(())
        })
    }

    fn consume_pending_oauth<'a>(
        &'a self,
        state: &'a str,
    ) -> BoxFuture<'a, Result<Option<PendingOAuthState>, OAuthError>> {
        Box::pin(async move {
            let mut map = self.pending_oauth.write().await;
            Ok(map.remove(state))
        })
    }

    fn find_user_by_oauth_identity<'a>(
        &'a self,
        provider: OAuthProvider,
        provider_user_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let identities = self.oauth_identities.read().await;
            if let Some(user_id) = identities.get(&(provider, provider_user_id.to_string())) {
                let users = self.users.read().await;
                Ok(users.get(user_id).cloned())
            } else {
                Ok(None)
            }
        })
    }

    fn bind_oauth_identity<'a>(
        &'a self,
        user_id: Uuid,
        provider: OAuthProvider,
        provider_user_id: &'a str,
        email: Option<&'a str>,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        Box::pin(async move {
            let mut users = self.users.write().await;
            let user = users.get_mut(&user_id).ok_or(SessionError::NotFound)?;
            user.is_guest = false;
            if user.email.is_none() && email.is_some() {
                user.email = email.map(ToString::to_string);
            }
            let updated = user.clone();
            self.oauth_identities
                .write()
                .await
                .insert((provider, provider_user_id.to_string()), user_id);
            if let Some(ref em) = updated.email {
                self.emails.write().await.insert(em.to_lowercase(), user_id);
            }
            Ok(updated)
        })
    }
}

impl<T: IdentityStore + ?Sized> IdentityStore for Arc<T> {
    fn get_user_by_email<'a>(
        &'a self,
        email: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>> {
        (**self).get_user_by_email(email)
    }

    fn get_user_by_id(
        &self,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<UserRecord>, SessionError>> {
        (**self).get_user_by_id(user_id)
    }

    fn bind_guest_credentials<'a>(
        &'a self,
        user_id: Uuid,
        email: &'a str,
        password_hash: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        (**self).bind_guest_credentials(user_id, email, password_hash)
    }

    fn save_user<'a>(&'a self, user: UserRecord) -> BoxFuture<'a, Result<(), SessionError>> {
        (**self).save_user(user)
    }

    fn save_pending_totp_secret<'a>(
        &'a self,
        user_id: Uuid,
        encrypted_secret: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        (**self).save_pending_totp_secret(user_id, encrypted_secret)
    }

    fn enable_totp_for_user<'a>(
        &'a self,
        user_id: Uuid,
        encrypted_secret: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        (**self).enable_totp_for_user(user_id, encrypted_secret)
    }
}

impl<T: SessionStore + ?Sized> SessionStore for Arc<T> {
    fn create_guest_user<'a>(
        &'a self,
        role: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        (**self).create_guest_user(role)
    }

    fn assign_campaign_member<'a>(
        &'a self,
        campaign_id: Uuid,
        user_id: Uuid,
        character_id: Option<Uuid>,
        role: &'a str,
    ) -> BoxFuture<'a, Result<CampaignMemberRecord, SessionError>> {
        (**self).assign_campaign_member(campaign_id, user_id, character_id, role)
    }

    fn create_session<'a>(
        &'a self,
        user_id: Uuid,
        token_hash: &'a str,
        ttl_seconds: u64,
    ) -> BoxFuture<'a, Result<SessionRecord, SessionError>> {
        (**self).create_session(user_id, token_hash, ttl_seconds)
    }

    fn get_session_by_token_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<SessionRecord>, SessionError>> {
        (**self).get_session_by_token_hash(token_hash)
    }

    fn delete_session<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        (**self).delete_session(token_hash)
    }

    fn is_invite_revoked(&self, jti: Uuid) -> BoxFuture<'_, bool> {
        (**self).is_invite_revoked(jti)
    }

    fn revoke_invite(&self, jti: Uuid) -> BoxFuture<'_, Result<(), SessionError>> {
        (**self).revoke_invite(jti)
    }

    fn get_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignMemberRecord>, SessionError>> {
        (**self).get_campaign_member(campaign_id, user_id)
    }

    fn get_campaign_members_for_user(
        &self,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        (**self).get_campaign_members_for_user(user_id)
    }

    fn list_campaign_members(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        (**self).list_campaign_members(campaign_id)
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

/// Constructs the Set-Cookie header value for `trame_session`. `secure` adds the `Secure`
/// attribute (`TRAME_COOKIE_SECURE`, on by default; disable only for plain-HTTP LAN tables).
pub fn build_session_cookie_header(token: &str, ttl_seconds: u64, secure: bool) -> String {
    let secure_attr = if secure { " Secure;" } else { "" };
    format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={ttl_seconds}; HttpOnly;{secure_attr} SameSite=Lax"
    )
}

/// Shared state for authentication routes.
#[derive(Clone)]
pub struct AuthState {
    pub magic_link_service: Arc<MagicLinkService>,
    pub session_store: Arc<dyn FullAuthStore>,
    pub totp_service: Arc<TotpService>,
    /// Cookie, origin, WebSocket, and rate-limit policy.
    pub security: Arc<SecurityPolicy>,
}

impl AuthState {
    /// Builds auth state with the default (development) `SecurityPolicy`.
    pub fn new(
        magic_link_service: Arc<MagicLinkService>,
        session_store: Arc<dyn FullAuthStore>,
        totp_service: Arc<TotpService>,
    ) -> Self {
        Self::with_security(
            magic_link_service,
            session_store,
            totp_service,
            Arc::new(SecurityPolicy::default()),
        )
    }

    /// Builds auth state with an explicit `SecurityPolicy`.
    pub fn with_security(
        magic_link_service: Arc<MagicLinkService>,
        session_store: Arc<dyn FullAuthStore>,
        totp_service: Arc<TotpService>,
        security: Arc<SecurityPolicy>,
    ) -> Self {
        Self {
            magic_link_service,
            session_store,
            totp_service,
            security,
        }
    }

    /// Session cookie header honoring `security.cookie_secure`.
    pub fn session_cookie(&self, token: &str, ttl_seconds: u64) -> String {
        build_session_cookie_header(token, ttl_seconds, self.security.cookie_secure)
    }
}

/// User summary returned by `/register`, `/login`, `/me`, owner bootstrap, and invite redemption.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUserDto {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub username: String,
    /// `true` for a legacy guest session: the UI shows the bind prompt.
    pub is_guest: bool,
    pub is_ephemeral: bool,
    pub role: String,
    /// Instance-wide role; `HOST` and `OWNER` may create campaigns.
    pub instance_role: InstanceRole,
    /// `true` once TOTP is enabled; the UI nudges accounts where it is `false`.
    pub totp_enabled: bool,
}

impl From<UserRecord> for AuthUserDto {
    fn from(u: UserRecord) -> Self {
        let email = u
            .email
            .unwrap_or_else(|| format!("ephemeral_{}@trame.local", u.id));
        Self {
            id: u.id,
            email,
            display_name: u.username.clone(),
            username: u.username,
            is_guest: u.is_guest,
            is_ephemeral: u.is_guest,
            role: u.role,
            instance_role: u.instance_role,
            totp_enabled: u.mfa_enabled || u.totp_secret.is_some(),
        }
    }
}

/// Request payload submitted to `POST /api/v1/auth/register`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegisterRequest {
    pub email: String,
    #[serde(default, alias = "username")]
    pub display_name: String,
    pub password: String,
}

/// Request payload submitted to `POST /api/v1/auth/login`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    /// Optional 6-digit RFC 6238 TOTP code required when `mfa_enabled` is true on the user account.
    #[serde(default, alias = "code", skip_serializing_if = "Option::is_none")]
    pub totp_code: Option<String>,
}

/// Response payload returned by `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and `GET /api/v1/auth/me`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUserEnvelope {
    pub user: AuthUserDto,
}

/// Response payload returned on authentication error.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthErrorResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub error: String,
}

/// Handler for `POST /api/v1/auth/register`: `403 REGISTRATION_CLOSED` outside `TRAME_ENV=dev`.
pub async fn register_handler(
    State(state): State<AuthState>,
    Json(payload): Json<RegisterRequest>,
) -> Response {
    if !state.security.registration_open {
        return (
            StatusCode::FORBIDDEN,
            Json(AuthErrorResponse {
                code: Some("REGISTRATION_CLOSED".to_string()),
                error: "registration is invite-only on this instance".to_string(),
            }),
        )
            .into_response();
    }
    let email = payload.email.trim().to_lowercase();
    let display_name = payload.display_name.trim().to_string();

    if email.is_empty() || !email.contains('@') {
        return (
            StatusCode::BAD_REQUEST,
            Json(AuthErrorResponse {
                code: Some("INVALID_EMAIL".to_string()),
                error: "valid email address is required".to_string(),
            }),
        )
            .into_response();
    }
    if display_name.chars().count() < 2 || display_name.chars().count() > 100 {
        return (
            StatusCode::BAD_REQUEST,
            Json(AuthErrorResponse {
                code: Some("INVALID_DISPLAY_NAME".to_string()),
                error: "display_name must be between 2 and 100 characters".to_string(),
            }),
        )
            .into_response();
    }

    match state.session_store.get_user_by_email(&email).await {
        Ok(Some(_)) => {
            return (
                StatusCode::CONFLICT,
                Json(AuthErrorResponse {
                    code: Some("EMAIL_ALREADY_EXISTS".to_string()),
                    error: "email already registered".to_string(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(AuthErrorResponse {
                    code: Some("STORAGE_ERROR".to_string()),
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
        Ok(None) => {}
    }

    let pw_service = PasswordService::new();
    let password_hash = match pw_service.hash_password(&payload.password) {
        Ok(h) => h,
        Err(PasswordError::WeakPassword(msg)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(AuthErrorResponse {
                    code: Some("WEAK_PASSWORD".to_string()),
                    error: msg,
                }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(AuthErrorResponse {
                    code: Some("HASHING_ERROR".to_string()),
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    let user = UserRecord {
        id: Uuid::new_v4(),
        username: display_name,
        role: "PLAYER".to_string(),
        is_guest: false,
        created_at: now_epoch_seconds(),
        email: Some(email),
        password_hash: Some(password_hash),
        mfa_enabled: false,
        totp_secret: None,
        pending_totp_secret: None,
        instance_role: InstanceRole::Member,
    };

    if let Err(e) = state.session_store.save_user(user.clone()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(AuthErrorResponse {
                code: Some("STORAGE_ERROR".to_string()),
                error: e.to_string(),
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
            Json(AuthErrorResponse {
                code: Some("STORAGE_ERROR".to_string()),
                error: e.to_string(),
            }),
        )
            .into_response();
    }

    let cookie_val = state.session_cookie(&session_token, DEFAULT_SESSION_TTL_SECONDS);
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&cookie_val) {
        headers.insert(SET_COOKIE, val);
    }

    (
        StatusCode::CREATED,
        headers,
        Json(AuthUserEnvelope {
            user: AuthUserDto::from(user),
        }),
    )
        .into_response()
}

/// Handler for `POST /api/v1/auth/login` enforcing Argon2id verification and TOTP MFA when configured.
pub async fn login_handler(
    State(state): State<AuthState>,
    Json(payload): Json<LoginRequest>,
) -> Response {
    let email = payload.email.trim().to_lowercase();
    let user = match state.session_store.get_user_by_email(&email).await {
        Ok(Some(u)) => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    code: Some("INVALID_CREDENTIALS".to_string()),
                    error: "invalid email or password".to_string(),
                }),
            )
                .into_response();
        }
    };

    let Some(ref stored_hash) = user.password_hash else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(AuthErrorResponse {
                code: Some("INVALID_CREDENTIALS".to_string()),
                error: "invalid email or password".to_string(),
            }),
        )
            .into_response();
    };

    let pw_service = PasswordService::new();
    if !pw_service.verify_password(&payload.password, stored_hash) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(AuthErrorResponse {
                code: Some("INVALID_CREDENTIALS".to_string()),
                error: "invalid email or password".to_string(),
            }),
        )
            .into_response();
    }

    // Security Gate: Enforce TOTP MFA verification if the user has MFA enabled or a configured TOTP secret.
    if user.mfa_enabled || user.totp_secret.is_some() {
        let Some(ref encrypted_secret) = user.totp_secret else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    code: Some("MFA_REQUIRED".to_string()),
                    error: "TOTP secret is missing for MFA-enabled user".to_string(),
                }),
            )
                .into_response();
        };

        let Some(ref provided_code) = payload.totp_code else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    code: Some("MFA_REQUIRED".to_string()),
                    error: "TOTP verification code is required".to_string(),
                }),
            )
                .into_response();
        };

        let Ok(secret_bytes) = state.totp_service.decrypt_secret(encrypted_secret) else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    code: Some("MFA_ERROR".to_string()),
                    error: "failed to decrypt TOTP secret".to_string(),
                }),
            )
                .into_response();
        };

        let now = now_epoch_seconds();
        if !state
            .totp_service
            .verify_code(&secret_bytes, provided_code, now)
        {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthErrorResponse {
                    code: Some("INVALID_TOTP_CODE".to_string()),
                    error: "invalid or expired TOTP code".to_string(),
                }),
            )
                .into_response();
        }
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
            Json(AuthErrorResponse {
                code: Some("STORAGE_ERROR".to_string()),
                error: e.to_string(),
            }),
        )
            .into_response();
    }

    let cookie_val = state.session_cookie(&session_token, DEFAULT_SESSION_TTL_SECONDS);
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&cookie_val) {
        headers.insert(SET_COOKIE, val);
    }

    (
        StatusCode::OK,
        headers,
        Json(AuthUserEnvelope {
            user: AuthUserDto::from(user),
        }),
    )
        .into_response()
}

/// Alias for `login_handler` enforcing password + TOTP MFA verification.
pub use login_handler as login_password_handler;

/// Handler for `POST /api/v1/auth/logout`.
pub async fn logout_handler(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    if let Some(session_token) = extract_session_token(&headers) {
        let token_hash = hash_session_token(&session_token);
        let _ = state.session_store.delete_session(&token_hash).await;
    }

    let cookie_val = state.session_cookie("", 0);
    let mut resp_headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&cookie_val) {
        resp_headers.insert(SET_COOKIE, val);
    }

    (
        StatusCode::OK,
        resp_headers,
        Json(serde_json::json!({ "status": "logged_out" })),
    )
        .into_response()
}

/// Resolves an authenticated `UserRecord` from either a `Bearer trame_pat_*` token or `trame_session` cookie.
pub async fn authenticate_user_from_headers(
    state: &AuthState,
    headers: &HeaderMap,
) -> Result<UserRecord, (StatusCode, AuthErrorResponse)> {
    if let Some(auth_hdr) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = auth_hdr.trim();
        if let Some(token) = trimmed.strip_prefix("Bearer ") {
            let token = token.trim();
            if token.starts_with(crate::auth::pat::PAT_PREFIX) {
                let pat_mw = PatMiddleware::new(state.session_store.clone());
                if let Ok(pat_record) = pat_mw.authenticate_header(trimmed).await
                    && let Ok(Some(user)) =
                        state.session_store.get_user_by_id(pat_record.user_id).await
                {
                    return Ok(user);
                }
                return Err((
                    StatusCode::UNAUTHORIZED,
                    AuthErrorResponse {
                        code: Some("UNAUTHORIZED".to_string()),
                        error: "invalid personal access token".to_string(),
                    },
                ));
            }
        }
    }

    let Some(session_token) = extract_session_token(headers) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            AuthErrorResponse {
                code: Some("UNAUTHORIZED".to_string()),
                error: "authentication session required".to_string(),
            },
        ));
    };

    let token_hash = hash_session_token(&session_token);
    let session = match state
        .session_store
        .get_session_by_token_hash(&token_hash)
        .await
    {
        Ok(Some(s)) => s,
        _ => {
            return Err((
                StatusCode::UNAUTHORIZED,
                AuthErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "invalid or expired session".to_string(),
                },
            ));
        }
    };

    let now = now_epoch_seconds();
    if session.expires_at < now {
        return Err((
            StatusCode::UNAUTHORIZED,
            AuthErrorResponse {
                code: Some("UNAUTHORIZED".to_string()),
                error: "session expired".to_string(),
            },
        ));
    }

    match state.session_store.get_user_by_id(session.user_id).await {
        Ok(Some(user)) => Ok(user),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            AuthErrorResponse {
                code: Some("UNAUTHORIZED".to_string()),
                error: "user not found".to_string(),
            },
        )),
    }
}

/// Handler for `GET /api/v1/auth/me`.
pub async fn me_handler(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    match authenticate_user_from_headers(&state, &headers).await {
        Ok(user) => (
            StatusCode::OK,
            Json(AuthUserEnvelope {
                user: AuthUserDto::from(user),
            }),
        )
            .into_response(),
        Err((status, err)) => (status, Json(err)).into_response(),
    }
}

/// Builds the Axum router for authentication endpoints plus owner bootstrap and instance
/// administration (`instance.rs`). Credential endpoints (`login`, `register`, `totp/*`,
/// bootstrap) sit behind `auth_rate_limit_middleware`. Invites live in `access.rs`.
pub fn build_auth_router(state: AuthState) -> Router {
    let rate_limited = Router::new()
        .route("/api/v1/auth/register", post(register_handler))
        .route("/api/v1/auth/login", post(login_handler))
        .route("/api/v1/auth/totp/setup", post(totp_setup_handler))
        .route("/api/v1/auth/totp/enable", post(totp_enable_handler))
        .route("/api/v1/auth/totp/verify", post(totp_verify_handler))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_rate_limit_middleware,
        ));

    Router::new()
        .route("/api/v1/auth/logout", post(logout_handler))
        .route("/api/v1/auth/me", get(me_handler))
        .route("/api/v1/auth/bind", post(bind_account_handler))
        .route("/api/v1/auth/bind-account", post(bind_account_handler))
        .route(
            "/api/v1/auth/pat",
            post(create_pat_handler).get(list_pats_handler),
        )
        .route(
            "/api/v1/auth/pats",
            post(create_pat_handler).get(list_pats_handler),
        )
        .merge(rate_limited)
        .with_state(state.clone())
        .merge(crate::instance::instance_router(state))
}
