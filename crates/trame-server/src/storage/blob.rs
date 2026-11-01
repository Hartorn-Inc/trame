//! Blob storage abstractions, chunked stream definitions, and SHA-256 content digests.
//!
//! `Sha256Hasher` wraps the audited RustCrypto `sha2` implementation so archive
//! checksums, session token digests, and content addresses never depend on a
//! hand-rolled compression function.

use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::pin::Pin;

/// Standard stream chunk size: 64 KiB (65,536 bytes).
pub const CHUNK_SIZE: usize = 64 * 1024;

/// Pinned asynchronous stream yielding 64 KiB chunks of bytes.
pub type BlobStream = Pin<Box<dyn Stream<Item = Result<Bytes, BlobStoreError>> + Send>>;

/// Metadata descriptor of a stored asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetDescriptor {
    pub id: String,
    pub byte_size: u64,
    pub sha256_hex: String,
    pub mime_type: String,
}

/// Storage backend errors.
#[derive(Debug, thiserror::Error)]
pub enum BlobStoreError {
    #[error("asset not found: {0}")]
    NotFound(String),
    #[error("storage io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("s3 backend error: {0}")]
    S3(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
}

impl PartialEq for BlobStoreError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::NotFound(a), Self::NotFound(b)) => a == b,
            (Self::S3(a), Self::S3(b)) => a == b,
            (Self::InvalidArgument(a), Self::InvalidArgument(b)) => a == b,
            (Self::Io(a), Self::Io(b)) => a.kind() == b.kind(),
            _ => false,
        }
    }
}

/// Asynchronous streaming storage abstraction for campaigns and assets.
pub trait BlobStore: Send + Sync + 'static {
    /// Atomically stores an incoming stream of bytes under the specified asset ID.
    async fn put_stream(
        &self,
        id: &str,
        stream: BlobStream,
    ) -> Result<AssetDescriptor, BlobStoreError>;

    /// Fetches the metadata descriptor for an existing asset.
    async fn get_descriptor(&self, id: &str) -> Result<AssetDescriptor, BlobStoreError>;

    /// Opens an asynchronous read stream yielding 64 KiB chunks for an existing asset.
    fn open_read_stream(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<BlobStream, BlobStoreError>> + Send;

    /// Lists descriptors for all assets stored in this backend.
    async fn list_descriptors(&self) -> Result<Vec<AssetDescriptor>, BlobStoreError>;

    /// Deletes an asset by ID.
    async fn delete(&self, id: &str) -> Result<(), BlobStoreError>;

    /// Checks whether an asset exists.
    async fn exists(&self, id: &str) -> Result<bool, BlobStoreError> {
        match self.get_descriptor(id).await {
            Ok(_) => Ok(true),
            Err(BlobStoreError::NotFound(_)) => Ok(false),
            Err(err) => Err(err),
        }
    }
}

/// Splits arbitrary byte slices into a 64 KiB chunked stream.
pub fn slice_to_stream(data: &[u8]) -> BlobStream {
    if data.is_empty() {
        return Box::pin(stream::empty());
    }
    let chunks: Vec<Result<Bytes, BlobStoreError>> = data
        .chunks(CHUNK_SIZE)
        .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
        .collect();
    Box::pin(stream::iter(chunks))
}

/// Consumes a chunked stream into a contiguous `Bytes` buffer.
pub async fn stream_to_bytes(mut stream: BlobStream) -> Result<Bytes, BlobStoreError> {
    let mut buffer = bytes::BytesMut::new();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res?;
        buffer.extend_from_slice(&chunk);
    }
    Ok(buffer.freeze())
}

/// Sanitizes and validates an asset ID, ensuring no path traversal or empty names.
pub fn sanitize_asset_id(id: &str) -> Result<String, BlobStoreError> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(BlobStoreError::InvalidArgument(
            "asset id must not be empty".to_string(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(BlobStoreError::InvalidArgument(format!(
            "path traversal detected in asset id: {id}"
        )));
    }
    let clean = trimmed.strip_suffix(".webp").unwrap_or(trimmed);
    if clean.is_empty() {
        return Err(BlobStoreError::InvalidArgument(
            "asset id stem must not be empty".to_string(),
        ));
    }
    Ok(clean.to_string())
}

/// Incremental FIPS 180-4 SHA-256 hasher backed by the RustCrypto `sha2` crate.
#[derive(Debug, Clone, Default)]
pub struct Sha256Hasher {
    inner: Sha256,
}

impl Sha256Hasher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, data: &[u8]) {
        self.inner.update(data);
    }

    pub fn finalize(self) -> [u8; 32] {
        let mut digest = [0u8; 32];
        digest.copy_from_slice(self.inner.finalize().as_slice());
        digest
    }

    pub fn finalize_hex(self) -> String {
        to_lower_hex(&self.finalize())
    }

    pub fn digest(data: &[u8]) -> String {
        let mut hasher = Self::new();
        hasher.update(data);
        hasher.finalize_hex()
    }
}

/// Encodes bytes as lowercase hexadecimal.
pub fn to_lower_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

pub use crate::http::InMemoryBlobStore;

#[cfg(test)]
mod tests {
    use super::Sha256Hasher;

    #[test]
    fn sha256_matches_fips_180_4_reference_vectors() {
        let cases = [
            (
                "empty_input",
                "",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                "abc",
                "abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                "two_block_message",
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            ),
        ];
        for (case_id, input, expected) in cases {
            assert_eq!(
                Sha256Hasher::digest(input.as_bytes()),
                expected,
                "{case_id}"
            );
        }
    }
}
