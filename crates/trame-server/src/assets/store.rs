use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use thiserror::Error;

pub const PRESIGNED_URL_DEFAULT_TTL: Duration = Duration::from_secs(900);

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AssetStoreError {
    #[error("Storage lock poisoned")]
    LockPoisoned,
    #[error("Asset not found: {0}")]
    NotFound(String),
    #[error("Storage IO failure: {0}")]
    Io(String),
    #[error("Presigning failure: {0}")]
    Presign(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAssetMetadata {
    pub key: String,
    pub content_type: String,
    pub size_bytes: usize,
    pub created_at_epoch_ms: u64,
}

#[derive(Debug, Clone)]
struct StoredAssetEntry {
    pub data: Bytes,
    #[allow(dead_code)]
    pub metadata: StoredAssetMetadata,
}

#[derive(Debug, Clone)]
struct PresignedGrant {
    pub expires_at: Instant,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Content-addressable object storage trait for battlemap assets and thumbnails.
pub trait AssetStore: Send + Sync {
    fn put_asset<'a>(
        &'a self,
        key: &'a str,
        data: Bytes,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), AssetStoreError>>;

    fn get_asset<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Bytes>, AssetStoreError>>;

    fn mint_presigned_get_url<'a>(
        &'a self,
        key: &'a str,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<String, AssetStoreError>>;
}

/// Pure in-memory asset store with short-lived presigned token validation for tests and local runtime.
#[derive(Default, Clone)]
pub struct InMemoryAssetStore {
    assets: Arc<RwLock<HashMap<String, StoredAssetEntry>>>,
    grants: Arc<RwLock<HashMap<String, PresignedGrant>>>,
    base_url: String,
    signing_secret: Vec<u8>,
}

impl InMemoryAssetStore {
    pub fn new() -> Self {
        Self::with_base_url_and_secret(
            "http://localhost:8080/assets/download",
            std::env::var("TRAME_JWT_SECRET")
                .or_else(|_| std::env::var("JWT_SECRET"))
                .map(|s| s.into_bytes())
                .unwrap_or_else(|_| b"trame-default-hmac-sha256-signing-secret-key".to_vec()),
        )
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self::with_base_url_and_secret(
            base_url,
            std::env::var("TRAME_JWT_SECRET")
                .or_else(|_| std::env::var("JWT_SECRET"))
                .map(|s| s.into_bytes())
                .unwrap_or_else(|_| b"trame-default-hmac-sha256-signing-secret-key".to_vec()),
        )
    }

    pub fn with_base_url_and_secret(
        base_url: impl Into<String>,
        signing_secret: impl Into<Vec<u8>>,
    ) -> Self {
        Self {
            assets: Arc::new(RwLock::new(HashMap::new())),
            grants: Arc::new(RwLock::new(HashMap::new())),
            base_url: base_url.into(),
            signing_secret: signing_secret.into(),
        }
    }

    pub fn validate_presigned_token(&self, token: &str) -> bool {
        let Ok(guard) = self.grants.read() else {
            return false;
        };
        if let Some(grant) = guard.get(token) {
            Instant::now() <= grant.expires_at
        } else {
            false
        }
    }
}

impl AssetStore for InMemoryAssetStore {
    fn put_asset<'a>(
        &'a self,
        key: &'a str,
        data: Bytes,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), AssetStoreError>> {
        Box::pin(async move {
            let mut guard = self
                .assets
                .write()
                .map_err(|_| AssetStoreError::LockPoisoned)?;
            let size_bytes = data.len();
            let metadata = StoredAssetMetadata {
                key: key.to_string(),
                content_type: content_type.to_string(),
                size_bytes,
                created_at_epoch_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            };
            guard.insert(key.to_string(), StoredAssetEntry { data, metadata });
            Ok(())
        })
    }

    fn get_asset<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Bytes>, AssetStoreError>> {
        Box::pin(async move {
            let guard = self
                .assets
                .read()
                .map_err(|_| AssetStoreError::LockPoisoned)?;
            Ok(guard.get(key).map(|entry| entry.data.clone()))
        })
    }

    fn mint_presigned_get_url<'a>(
        &'a self,
        key: &'a str,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<String, AssetStoreError>> {
        Box::pin(async move {
            {
                let guard = self
                    .assets
                    .read()
                    .map_err(|_| AssetStoreError::LockPoisoned)?;
                if !guard.contains_key(key) {
                    return Err(AssetStoreError::NotFound(key.to_string()));
                }
            }

            let token = uuid::Uuid::new_v4().to_string();
            let expires_at = Instant::now() + ttl;

            let mut guard = self
                .grants
                .write()
                .map_err(|_| AssetStoreError::LockPoisoned)?;
            guard.insert(token.clone(), PresignedGrant { expires_at });

            let sanitized_key = key.trim_start_matches('/');
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let exp = now.saturating_add(ttl.as_secs());
            let signing_input = format!("{sanitized_key}:{exp}");
            let sig = crate::auth::magic_link::hmac_sha256(
                &self.signing_secret,
                signing_input.as_bytes(),
            );
            let mut sig_hex = String::with_capacity(64);
            for b in sig {
                use std::fmt::Write;
                let _ = write!(&mut sig_hex, "{:02x}", b);
            }
            let url = format!(
                "{}/{}?token={}&expires_in={}&exp={}&sig={}",
                self.base_url.trim_end_matches('/'),
                sanitized_key,
                token,
                ttl.as_secs(),
                exp,
                sig_hex
            );
            Ok(url)
        })
    }
}
