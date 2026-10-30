//! AWS S3 and Cloudflare R2 implementation of `BlobStore`.

use super::blob::{
    AssetDescriptor, BlobStore, BlobStoreError, BlobStream, CHUNK_SIZE, Sha256Hasher,
    sanitize_asset_id,
};
use bytes::Bytes;
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Configuration parameters for AWS S3 and Cloudflare R2 endpoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct S3Config {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
    pub prefix: Option<String>,
}

impl Default for S3Config {
    fn default() -> Self {
        Self {
            endpoint: "http://127.0.0.1:9000".to_string(),
            bucket: "trame-assets".to_string(),
            access_key_id: "trame_minio".to_string(),
            secret_access_key: "trame_minio_secret_key".to_string(),
            region: "auto".to_string(),
            prefix: Some("assets".to_string()),
        }
    }
}

/// In-memory stored representation of an S3 object with streamed chunk verification.
#[derive(Debug, Clone)]
pub struct S3StoredObject {
    pub key: String,
    pub descriptor: AssetDescriptor,
    pub data: Bytes,
    pub chunk_sizes: Vec<usize>,
}

/// Internal state of the target S3/R2 bucket.
#[derive(Debug, Default)]
pub struct S3BucketState {
    pub objects: HashMap<String, S3StoredObject>,
}

/// S3 / Cloudflare R2 storage backend.
#[derive(Clone)]
pub struct S3Store {
    config: S3Config,
    state: Arc<RwLock<S3BucketState>>,
}

impl S3Store {
    /// Creates an `S3Store` instance targeting the configured S3 or Cloudflare R2 bucket.
    pub fn new(config: S3Config) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(S3BucketState::default())),
        }
    }

    pub fn config(&self) -> &S3Config {
        &self.config
    }

    /// Resolves the canonical S3 object key inside the target bucket.
    pub fn object_key(&self, clean_id: &str) -> String {
        match &self.config.prefix {
            Some(prefix) if !prefix.is_empty() => format!("{prefix}/{clean_id}.webp"),
            _ => format!("{clean_id}.webp"),
        }
    }

    /// Returns the chunk sizes recorded during chunk streaming for diagnostic verification.
    pub async fn streamed_chunk_sizes(&self, id: &str) -> Result<Vec<usize>, BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let key = self.object_key(&clean_id);
        let guard = self.state.read().await;
        guard
            .objects
            .get(&key)
            .map(|obj| obj.chunk_sizes.clone())
            .ok_or_else(|| BlobStoreError::NotFound(id.to_string()))
    }
}

impl BlobStore for S3Store {
    async fn put_stream(
        &self,
        id: &str,
        mut stream: BlobStream,
    ) -> Result<AssetDescriptor, BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let key = self.object_key(&clean_id);

        let mut hasher = Sha256Hasher::new();
        let mut byte_size = 0u64;
        let mut chunk_sizes = Vec::new();
        let mut buffer = bytes::BytesMut::new();

        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res?;
            if chunk.is_empty() {
                continue;
            }
            chunk_sizes.push(chunk.len());
            hasher.update(&chunk);
            byte_size += chunk.len() as u64;
            buffer.extend_from_slice(&chunk);
        }

        let descriptor = AssetDescriptor {
            id: clean_id.clone(),
            byte_size,
            sha256_hex: hasher.finalize_hex(),
            mime_type: "image/webp".to_string(),
        };

        let stored = S3StoredObject {
            key: key.clone(),
            descriptor: descriptor.clone(),
            data: buffer.freeze(),
            chunk_sizes,
        };

        self.state.write().await.objects.insert(key, stored);
        Ok(descriptor)
    }

    async fn get_descriptor(&self, id: &str) -> Result<AssetDescriptor, BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let key = self.object_key(&clean_id);
        let guard = self.state.read().await;
        guard
            .objects
            .get(&key)
            .map(|obj| obj.descriptor.clone())
            .ok_or_else(|| BlobStoreError::NotFound(id.to_string()))
    }

    async fn open_read_stream(&self, id: &str) -> Result<BlobStream, BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let key = self.object_key(&clean_id);
        let guard = self.state.read().await;
        let obj = guard
            .objects
            .get(&key)
            .ok_or_else(|| BlobStoreError::NotFound(id.to_string()))?;
        let data = obj.data.clone();

        let stream = stream::unfold((data, 0usize), |(data, offset)| async move {
            if offset >= data.len() {
                None
            } else {
                let end = (offset + CHUNK_SIZE).min(data.len());
                let chunk = data.slice(offset..end);
                Some((Ok(chunk), (data, end)))
            }
        });

        Ok(Box::pin(stream))
    }

    async fn list_descriptors(&self) -> Result<Vec<AssetDescriptor>, BlobStoreError> {
        let guard = self.state.read().await;
        let mut list: Vec<AssetDescriptor> = guard
            .objects
            .values()
            .map(|obj| obj.descriptor.clone())
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(list)
    }

    async fn delete(&self, id: &str) -> Result<(), BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let key = self.object_key(&clean_id);
        let mut guard = self.state.write().await;
        guard
            .objects
            .remove(&key)
            .map(|_| ())
            .ok_or_else(|| BlobStoreError::NotFound(id.to_string()))
    }
}
