//! ============================================================================
//! PURPOSE:
//!   Implements OAuth2 authorization code flow with PKCE (RFC 7636) for Discord
//!   and Google identity providers, including active guest identity binding.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - PKCE enforces SHA-256 code challenge computation (`S256` method) per RFC 7636.
//!   - `code_verifier` generates minimum 43 URL-safe Base64 characters.
//!   - Pending authorization states expire deterministically and are purged on use.
//!   - When an OAuth2 callback succeeds with an active guest session, the provider
//!     identity is bound to the existing guest user record (`is_guest` becomes false),
//!     preserving all actor assignments, notes, and session tokens.
//! ============================================================================

use super::magic_link::now_epoch_seconds;
use super::password::IdentityStore;
use super::session::{BoxFuture, SessionError, UserRecord};
use crate::storage::blob::Sha256Hasher;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use uuid::Uuid;

/// Supported OAuth2 identity providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthProvider {
    Discord,
    Google,
}

impl std::fmt::Display for OAuthProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OAuthProvider::Discord => write!(f, "discord"),
            OAuthProvider::Google => write!(f, "google"),
        }
    }
}

impl std::str::FromStr for OAuthProvider {
    type Err = OAuthError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "discord" => Ok(OAuthProvider::Discord),
            "google" => Ok(OAuthProvider::Google),
            _ => Err(OAuthError::UnsupportedProvider(s.to_string())),
        }
    }
}

/// Errors occurring during OAuth2 flows and guest identity binding.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum OAuthError {
    #[error("unsupported oauth provider: {0}")]
    UnsupportedProvider(String),
    #[error("invalid or expired oauth state")]
    InvalidState,
    #[error("oauth code exchange failed: {0}")]
    CodeExchangeFailed(String),
    #[error("email already registered to another user")]
    EmailConflict,
    #[error("user account not found")]
    UserNotFound,
    #[error("user account is already permanent")]
    AlreadyPermanent,
    #[error("provider identity already bound to another user")]
    IdentityAlreadyBound,
    #[error("storage error: {0}")]
    Storage(String),
}

/// RFC 7636 PKCE code challenge and verifier pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PkcePair {
    pub code_verifier: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
}

/// Computes the RFC 7636 code challenge: `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`.
pub fn compute_code_challenge(code_verifier: &str) -> String {
    let mut hasher = Sha256Hasher::new();
    hasher.update(code_verifier.as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(digest)
}

/// Generates an RFC 7636 compliant PKCE pair with a 43-character URL-safe verifier.
pub fn generate_pkce_pair() -> PkcePair {
    let mut random_bytes = [0u8; 32];
    let mut rng = rand::rng();
    rng.fill(&mut random_bytes);
    let code_verifier = URL_SAFE_NO_PAD.encode(random_bytes);
    let code_challenge = compute_code_challenge(&code_verifier);

    PkcePair {
        code_verifier,
        code_challenge,
        code_challenge_method: "S256".to_string(),
    }
}

/// Pending OAuth2 state tracked across redirect and callback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingOAuthState {
    pub state: String,
    pub provider: OAuthProvider,
    pub code_verifier: String,
    pub redirect_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guest_user_id: Option<Uuid>,
    pub created_at: u64,
    pub expires_at: u64,
}

/// Data returned to start an authorization flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthAuthorizationUrl {
    pub provider: OAuthProvider,
    pub auth_url: String,
    pub state: String,
    pub code_verifier: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
}

/// Normalized user profile extracted from OAuth2 provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthUserProfile {
    pub provider_user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

/// Store operations needed for pending OAuth state and provider identity bindings.
pub trait OAuthStore: IdentityStore {
    fn save_pending_oauth<'a>(
        &'a self,
        state: PendingOAuthState,
    ) -> BoxFuture<'a, Result<(), OAuthError>>;
    fn consume_pending_oauth<'a>(
        &'a self,
        state: &'a str,
    ) -> BoxFuture<'a, Result<Option<PendingOAuthState>, OAuthError>>;
    fn find_user_by_oauth_identity<'a>(
        &'a self,
        provider: OAuthProvider,
        provider_user_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>>;
    fn bind_oauth_identity<'a>(
        &'a self,
        user_id: Uuid,
        provider: OAuthProvider,
        provider_user_id: &'a str,
        email: Option<&'a str>,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>>;
}

impl<T: OAuthStore + ?Sized> OAuthStore for Arc<T> {
    fn save_pending_oauth<'a>(
        &'a self,
        state: PendingOAuthState,
    ) -> BoxFuture<'a, Result<(), OAuthError>> {
        (**self).save_pending_oauth(state)
    }
    fn consume_pending_oauth<'a>(
        &'a self,
        state: &'a str,
    ) -> BoxFuture<'a, Result<Option<PendingOAuthState>, OAuthError>> {
        (**self).consume_pending_oauth(state)
    }
    fn find_user_by_oauth_identity<'a>(
        &'a self,
        provider: OAuthProvider,
        provider_user_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>> {
        (**self).find_user_by_oauth_identity(provider, provider_user_id)
    }
    fn bind_oauth_identity<'a>(
        &'a self,
        user_id: Uuid,
        provider: OAuthProvider,
        provider_user_id: &'a str,
        email: Option<&'a str>,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        (**self).bind_oauth_identity(user_id, provider, provider_user_id, email)
    }
}

/// Abstract client for exchanging authorization codes and retrieving provider user profiles.
pub trait OAuthClient: Send + Sync {
    fn exchange_and_fetch_profile<'a>(
        &'a self,
        provider: OAuthProvider,
        code: &'a str,
        code_verifier: &'a str,
        redirect_uri: &'a str,
    ) -> BoxFuture<'a, Result<OAuthUserProfile, OAuthError>>;
}

/// Mock OAuth client enabling zero-network deterministic testing and local development.
#[derive(Default, Clone)]
pub struct MockOAuthClient {
    registered_profiles: Arc<RwLock<HashMap<String, OAuthUserProfile>>>,
}

impl MockOAuthClient {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register_code_profile(&self, code: impl Into<String>, profile: OAuthUserProfile) {
        self.registered_profiles
            .write()
            .await
            .insert(code.into(), profile);
    }
}

impl OAuthClient for MockOAuthClient {
    fn exchange_and_fetch_profile<'a>(
        &'a self,
        provider: OAuthProvider,
        code: &'a str,
        _code_verifier: &'a str,
        _redirect_uri: &'a str,
    ) -> BoxFuture<'a, Result<OAuthUserProfile, OAuthError>> {
        Box::pin(async move {
            let profiles = self.registered_profiles.read().await;
            if let Some(profile) = profiles.get(code) {
                return Ok(profile.clone());
            }
            Ok(OAuthUserProfile {
                provider_user_id: format!("{provider}_id_{code}"),
                email: Some(format!("{provider}_{code}@example.com")),
                username: Some(format!("{provider}_{code}")),
            })
        })
    }
}

/// Configuration for an OAuth provider endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthProviderConfig {
    pub client_id: String,
    pub auth_endpoint: String,
    pub scopes: Vec<String>,
}

/// Service coordinating OAuth2 PKCE authorization flows and guest identity binding.
#[derive(Clone)]
pub struct OAuthService<S: OAuthStore> {
    store: Arc<S>,
    client: Arc<dyn OAuthClient>,
    discord_config: OAuthProviderConfig,
    google_config: OAuthProviderConfig,
}

impl<S: OAuthStore> OAuthService<S> {
    /// Creates an `OAuthService` with a mockable client and default provider configurations.
    pub fn new(store: Arc<S>) -> Self {
        Self::with_client(store, Arc::new(MockOAuthClient::new()))
    }

    /// Creates an `OAuthService` with custom client implementation.
    pub fn with_client(store: Arc<S>, client: Arc<dyn OAuthClient>) -> Self {
        Self {
            store,
            client,
            discord_config: OAuthProviderConfig {
                client_id: "trame-discord-client-id".to_string(),
                auth_endpoint: "https://discord.com/api/oauth2/authorize".to_string(),
                scopes: vec!["identify".to_string(), "email".to_string()],
            },
            google_config: OAuthProviderConfig {
                client_id: "trame-google-client-id".to_string(),
                auth_endpoint: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
                scopes: vec![
                    "openid".to_string(),
                    "email".to_string(),
                    "profile".to_string(),
                ],
            },
        }
    }

    /// Starts an OAuth2 PKCE flow for Discord or Google, generating `code_verifier` and `code_challenge`.
    pub async fn start_authorization(
        &self,
        provider: OAuthProvider,
        redirect_uri: &str,
        guest_user_id: Option<Uuid>,
    ) -> Result<OAuthAuthorizationUrl, OAuthError> {
        let pkce = generate_pkce_pair();
        let mut state_bytes = [0u8; 16];
        let mut rng = rand::rng();
        rng.fill(&mut state_bytes);
        let mut state = String::with_capacity(32);
        for b in state_bytes {
            use std::fmt::Write;
            let _ = write!(&mut state, "{:02x}", b);
        }

        let config = match provider {
            OAuthProvider::Discord => &self.discord_config,
            OAuthProvider::Google => &self.google_config,
        };

        let now = now_epoch_seconds();
        let pending = PendingOAuthState {
            state: state.clone(),
            provider,
            code_verifier: pkce.code_verifier.clone(),
            redirect_uri: redirect_uri.to_string(),
            guest_user_id,
            created_at: now,
            expires_at: now.saturating_add(600),
        };

        self.store.save_pending_oauth(pending).await?;

        let scope_param = config.scopes.join("%20");
        let auth_url = format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method={}",
            config.auth_endpoint,
            config.client_id,
            redirect_uri,
            scope_param,
            state,
            pkce.code_challenge,
            pkce.code_challenge_method,
        );

        Ok(OAuthAuthorizationUrl {
            provider,
            auth_url,
            state,
            code_verifier: pkce.code_verifier,
            code_challenge: pkce.code_challenge,
            code_challenge_method: pkce.code_challenge_method,
        })
    }

    /// Processes the OAuth2 callback, exchanging the code with the stored PKCE verifier
    /// and binding the provider identity to the active guest user record if present.
    pub async fn handle_callback(
        &self,
        provider: OAuthProvider,
        code: &str,
        state: &str,
        session_guest_user_id: Option<Uuid>,
    ) -> Result<UserRecord, OAuthError> {
        let pending = self
            .store
            .consume_pending_oauth(state)
            .await?
            .ok_or(OAuthError::InvalidState)?;

        if pending.provider != provider {
            return Err(OAuthError::InvalidState);
        }

        let now = now_epoch_seconds();
        if pending.expires_at < now {
            return Err(OAuthError::InvalidState);
        }

        let profile = self
            .client
            .exchange_and_fetch_profile(
                provider,
                code,
                &pending.code_verifier,
                &pending.redirect_uri,
            )
            .await?;

        let existing_provider_user = self
            .store
            .find_user_by_oauth_identity(provider, &profile.provider_user_id)
            .await
            .map_err(|e| OAuthError::Storage(e.to_string()))?;

        let guest_id = session_guest_user_id.or(pending.guest_user_id);
        match guest_id {
            Some(user_id) => {
                let guest_user = self
                    .store
                    .get_user_by_id(user_id)
                    .await
                    .map_err(|e| OAuthError::Storage(e.to_string()))?
                    .ok_or(OAuthError::UserNotFound)?;

                if !guest_user.is_guest {
                    return Err(OAuthError::AlreadyPermanent);
                }

                if let Some(existing) = existing_provider_user
                    && existing.id != user_id
                {
                    return Err(OAuthError::IdentityAlreadyBound);
                }

                if let Some(ref email) = profile.email
                    && let Some(existing_email_user) = self
                        .store
                        .get_user_by_email(email)
                        .await
                        .map_err(|e| OAuthError::Storage(e.to_string()))?
                    && existing_email_user.id != user_id
                {
                    return Err(OAuthError::EmailConflict);
                }

                let bound_user = self
                    .store
                    .bind_oauth_identity(
                        user_id,
                        provider,
                        &profile.provider_user_id,
                        profile.email.as_deref(),
                    )
                    .await
                    .map_err(|e| OAuthError::Storage(e.to_string()))?;

                Ok(bound_user)
            }
            None => {
                if let Some(existing) = existing_provider_user {
                    return Ok(existing);
                }

                if let Some(ref email) = profile.email
                    && self
                        .store
                        .get_user_by_email(email)
                        .await
                        .map_err(|e| OAuthError::Storage(e.to_string()))?
                        .is_some()
                {
                    return Err(OAuthError::EmailConflict);
                }

                let user_id = Uuid::new_v4();
                let username = profile.username.unwrap_or_else(|| {
                    format!(
                        "{}_{}",
                        provider,
                        &profile.provider_user_id[..6.min(profile.provider_user_id.len())]
                    )
                });

                let new_user = UserRecord {
                    id: user_id,
                    username,
                    role: "PLAYER".to_string(),
                    is_guest: false,
                    created_at: now_epoch_seconds(),
                    email: profile.email.clone(),
                    password_hash: None,
                    mfa_enabled: false,
                    totp_secret: None,
                    pending_totp_secret: None,
                };

                self.store
                    .save_user(new_user.clone())
                    .await
                    .map_err(|e| OAuthError::Storage(e.to_string()))?;

                let bound = self
                    .store
                    .bind_oauth_identity(
                        user_id,
                        provider,
                        &profile.provider_user_id,
                        profile.email.as_deref(),
                    )
                    .await
                    .map_err(|e| OAuthError::Storage(e.to_string()))?;

                Ok(bound)
            }
        }
    }
}
