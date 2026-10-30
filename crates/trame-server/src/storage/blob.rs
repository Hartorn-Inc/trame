//! Blob storage abstractions, chunked stream definitions, and deterministic SHA-256 calculation.

use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
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
pub trait BlobStore: Send + Sync {
    /// Atomically stores an incoming stream of bytes under the specified asset ID.
    async fn put_stream(
        &self,
        id: &str,
        stream: BlobStream,
    ) -> Result<AssetDescriptor, BlobStoreError>;

    /// Fetches the metadata descriptor for an existing asset.
    async fn get_descriptor(&self, id: &str) -> Result<AssetDescriptor, BlobStoreError>;

    /// Opens an asynchronous read stream yielding 64 KiB chunks for an existing asset.
    async fn open_read_stream(&self, id: &str) -> Result<BlobStream, BlobStoreError>;

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

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H_INIT: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

#[inline]
fn ch(x: u32, y: u32, z: u32) -> u32 {
    (x & y) ^ (!x & z)
}

#[inline]
fn maj(x: u32, y: u32, z: u32) -> u32 {
    (x & y) ^ (x & z) ^ (y & z)
}

#[inline]
fn sigma0(x: u32) -> u32 {
    x.rotate_right(2) ^ x.rotate_right(13) ^ x.rotate_right(22)
}

#[inline]
fn sigma1(x: u32) -> u32 {
    x.rotate_right(6) ^ x.rotate_right(11) ^ x.rotate_right(25)
}

#[inline]
fn gamma0(x: u32) -> u32 {
    x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3)
}

#[inline]
fn gamma1(x: u32) -> u32 {
    x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10)
}

fn process_block(h: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    for i in 0..16 {
        w[i] = u32::from_be_bytes([
            block[i * 4],
            block[i * 4 + 1],
            block[i * 4 + 2],
            block[i * 4 + 3],
        ]);
    }
    for i in 16..64 {
        w[i] = gamma1(w[i - 2])
            .wrapping_add(w[i - 7])
            .wrapping_add(gamma0(w[i - 15]))
            .wrapping_add(w[i - 16]);
    }

    let mut a = h[0];
    let mut b = h[1];
    let mut c = h[2];
    let mut d = h[3];
    let mut e = h[4];
    let mut f = h[5];
    let mut g = h[6];
    let mut h_val = h[7];

    for i in 0..64 {
        let t1 = h_val
            .wrapping_add(sigma1(e))
            .wrapping_add(ch(e, f, g))
            .wrapping_add(K[i])
            .wrapping_add(w[i]);
        let t2 = sigma0(a).wrapping_add(maj(a, b, c));
        h_val = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }

    h[0] = h[0].wrapping_add(a);
    h[1] = h[1].wrapping_add(b);
    h[2] = h[2].wrapping_add(c);
    h[3] = h[3].wrapping_add(d);
    h[4] = h[4].wrapping_add(e);
    h[5] = h[5].wrapping_add(f);
    h[6] = h[6].wrapping_add(g);
    h[7] = h[7].wrapping_add(h_val);
}

/// FIPS 180-4 standard SHA-256 incremental hasher with zero heap allocations during digest updates.
#[derive(Debug, Clone)]
pub struct Sha256Hasher {
    h: [u32; 8],
    buffer: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Default for Sha256Hasher {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256Hasher {
    pub fn new() -> Self {
        Self {
            h: H_INIT,
            buffer: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total_len += data.len() as u64;

        if self.buf_len > 0 {
            let to_fill = 64 - self.buf_len;
            if data.len() >= to_fill {
                self.buffer[self.buf_len..64].copy_from_slice(&data[..to_fill]);
                let block = self.buffer;
                process_block(&mut self.h, &block);
                self.buf_len = 0;
                data = &data[to_fill..];
            } else {
                self.buffer[self.buf_len..self.buf_len + data.len()].copy_from_slice(data);
                self.buf_len += data.len();
                return;
            }
        }

        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            process_block(&mut self.h, &block);
            data = &data[64..];
        }

        if !data.is_empty() {
            self.buffer[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    pub fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_len.wrapping_mul(8);
        self.buffer[self.buf_len] = 0x80;
        self.buf_len += 1;

        if self.buf_len > 56 {
            for byte in &mut self.buffer[self.buf_len..64] {
                *byte = 0;
            }
            let block = self.buffer;
            process_block(&mut self.h, &block);
            self.buf_len = 0;
        }

        for byte in &mut self.buffer[self.buf_len..56] {
            *byte = 0;
        }

        self.buffer[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buffer;
        process_block(&mut self.h, &block);

        let mut digest = [0u8; 32];
        for (i, word) in self.h.iter().enumerate() {
            digest[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        digest
    }

    pub fn finalize_hex(self) -> String {
        let digest = self.finalize();
        let mut hex = String::with_capacity(64);
        for byte in digest {
            use std::fmt::Write;
            let _ = write!(&mut hex, "{:02x}", byte);
        }
        hex
    }

    pub fn digest(data: &[u8]) -> String {
        let mut hasher = Self::new();
        hasher.update(data);
        hasher.finalize_hex()
    }
}
