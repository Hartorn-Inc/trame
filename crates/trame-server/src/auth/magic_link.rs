//! Magic link JWT generation and validation using HS256 signatures.

use super::session::SessionStore;
use crate::storage::blob::Sha256Hasher;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

/// Error type for magic link JWT generation and validation operations.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum MagicLinkError {
    #[error("malformed JWT structure")]
    MalformedJwt,
    #[error("invalid base64 encoding")]
    Base64DecodeError,
    #[error("invalid json payload: {0}")]
    JsonError(String),
    #[error("invalid algorithm: expected HS256")]
    InvalidAlgorithm,
    #[error("invalid signature")]
    InvalidSignature,
    #[error("invite token has expired")]
    ExpiredToken,
    #[error("invite token has been revoked")]
    RevokedToken,
}

/// JWT header for HS256 tokens.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct JwtHeader {
    pub alg: String,
    pub typ: String,
}

impl Default for JwtHeader {
    fn default() -> Self {
        Self {
            alg: "HS256".to_string(),
            typ: "JWT".to_string(),
        }
    }
}

/// Claims payload contained within a Magic Link JWT.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MagicLinkClaims {
    pub sub: String,
    pub iss: String,
    pub campaign_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_id: Option<Uuid>,
    pub role: String,
    pub exp: u64,
    pub jti: Uuid,
}

/// Service providing HS256 signing and verification for magic link onboarding.
#[derive(Clone)]
pub struct MagicLinkService {
    jwt_secret: Vec<u8>,
    issuer: String,
}

impl MagicLinkService {
    /// Creates a new `MagicLinkService` with the specified secret and issuer name.
    pub fn new(jwt_secret: impl Into<Vec<u8>>, issuer: impl Into<String>) -> Self {
        Self {
            jwt_secret: jwt_secret.into(),
            issuer: issuer.into(),
        }
    }

    /// Creates a service reading `JWT_SECRET` from environment with a fallback secret.
    pub fn from_env_or_secret(default_secret: &[u8]) -> Self {
        let secret = std::env::var("TRAME_JWT_SECRET")
            .or_else(|_| std::env::var("JWT_SECRET"))
            .map(|s| s.into_bytes())
            .unwrap_or_else(|_| default_secret.to_vec());
        Self::new(secret, "trame-server")
    }

    /// Exposes the server HMAC-SHA256 signing secret for token and URL signature verification.
    pub fn secret(&self) -> &[u8] {
        &self.jwt_secret
    }

    /// Generates a signed HS256 JWT for inviting a player into a campaign.
    pub fn create_invite_token(
        &self,
        creator_user_id: Uuid,
        campaign_id: Uuid,
        character_id: Option<Uuid>,
        role: &str,
        ttl_seconds: u64,
    ) -> Result<(String, MagicLinkClaims), MagicLinkError> {
        let now = now_epoch_seconds();
        let exp = now.saturating_add(ttl_seconds);
        let jti = Uuid::new_v4();

        let claims = MagicLinkClaims {
            sub: creator_user_id.to_string(),
            iss: self.issuer.clone(),
            campaign_id,
            character_id,
            role: role.to_string(),
            exp,
            jti,
        };

        let token = self.sign_claims(&claims)?;
        Ok((token, claims))
    }

    /// Encodes and signs claims with HS256.
    pub fn sign_claims(&self, claims: &MagicLinkClaims) -> Result<String, MagicLinkError> {
        let header = JwtHeader::default();
        let header_json =
            serde_json::to_vec(&header).map_err(|e| MagicLinkError::JsonError(e.to_string()))?;
        let payload_json =
            serde_json::to_vec(claims).map_err(|e| MagicLinkError::JsonError(e.to_string()))?;

        let header_b64 = URL_SAFE_NO_PAD.encode(header_json);
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json);
        let signing_input = format!("{header_b64}.{payload_b64}");

        let signature = hmac_sha256(&self.jwt_secret, signing_input.as_bytes());
        let signature_b64 = URL_SAFE_NO_PAD.encode(signature);

        Ok(format!("{signing_input}.{signature_b64}"))
    }

    /// Validates an invite JWT against signature, expiry, and revocation state.
    pub async fn validate_invite_token(
        &self,
        token: &str,
        session_store: &dyn SessionStore,
    ) -> Result<MagicLinkClaims, MagicLinkError> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return Err(MagicLinkError::MalformedJwt);
        }

        let header_b64 = parts[0];
        let payload_b64 = parts[1];
        let signature_b64 = parts[2];

        let signing_input = format!("{header_b64}.{payload_b64}");
        let expected_signature = hmac_sha256(&self.jwt_secret, signing_input.as_bytes());

        let signature = URL_SAFE_NO_PAD
            .decode(signature_b64)
            .map_err(|_| MagicLinkError::Base64DecodeError)?;

        if !constant_time_eq(&signature, &expected_signature) {
            return Err(MagicLinkError::InvalidSignature);
        }

        let header_bytes = URL_SAFE_NO_PAD
            .decode(header_b64)
            .map_err(|_| MagicLinkError::Base64DecodeError)?;
        let header: JwtHeader = serde_json::from_slice(&header_bytes)
            .map_err(|e| MagicLinkError::JsonError(e.to_string()))?;

        if header.alg != "HS256" {
            return Err(MagicLinkError::InvalidAlgorithm);
        }

        let payload_bytes = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| MagicLinkError::Base64DecodeError)?;
        let claims: MagicLinkClaims = serde_json::from_slice(&payload_bytes)
            .map_err(|e| MagicLinkError::JsonError(e.to_string()))?;

        let now = now_epoch_seconds();
        if claims.exp < now {
            return Err(MagicLinkError::ExpiredToken);
        }

        if session_store.is_invite_revoked(claims.jti).await {
            return Err(MagicLinkError::RevokedToken);
        }

        Ok(claims)
    }
}

/// Computes RFC 2104 HMAC-SHA256 using `Sha256Hasher`.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        let mut h = Sha256Hasher::new();
        h.update(key);
        let digest = h.finalize();
        key_block[..32].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut o_key_pad = [0u8; 64];
    let mut i_key_pad = [0u8; 64];
    for i in 0..64 {
        o_key_pad[i] = key_block[i] ^ 0x5c;
        i_key_pad[i] = key_block[i] ^ 0x36;
    }

    let mut inner_hasher = Sha256Hasher::new();
    inner_hasher.update(&i_key_pad);
    inner_hasher.update(message);
    let inner_digest = inner_hasher.finalize();

    let mut outer_hasher = Sha256Hasher::new();
    outer_hasher.update(&o_key_pad);
    outer_hasher.update(&inner_digest);
    outer_hasher.finalize()
}

/// Constant-time slice equality comparison to prevent timing attacks.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Returns the current system timestamp in seconds since Unix epoch.
pub fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
