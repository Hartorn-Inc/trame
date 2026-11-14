//! ============================================================================
//! S3-COMPATIBLE ASSET STORE & BLOB MIGRATION (s3.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Moves campaign asset bytes (battlemaps, portraits) out of PostgreSQL into an
//! S3-compatible object store (Cloudflare R2, Silo/MinIO), ADR-0041. Without it
//! every asset load is streamed by `trame-server`: billed egress on Cloud Run
//! and `BYTEA` rows that free database tiers cannot hold (SEC20).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `PostgreSQL Keeps The Metadata`:
//!      - `S3Store` writes the object first, then records the
//!        `campaign_assets` row with `payload` NULL. Membership checks, the
//!        HMAC `/assets/download` URLs and the storage quota (SEC14) keep
//!        reading PostgreSQL, so access control is unchanged.
//!      - Object keys are the existing content addresses
//!        (`instances/{instance}/campaigns/{campaign}/assets/{sha256}.webp`).
//!   2. `Signed Direct Downloads`:
//!      - The browser still asks the server for `/assets/download/{key}` with
//!        an HMAC signature minted after the access checks. Only then does
//!        `direct_download_url` answer with a `307` to an AWS SigV4 presigned
//!        GET valid `S3_DOWNLOAD_URL_TTL` (5 minutes), signed for the public
//!        endpoint (`S3_PUBLIC_ENDPOINT`).
//!      - Rows not yet migrated (`payload` set) are still streamed by the
//!        server, so downloads keep working while the migration runs.
//!   3. `Verified, Idempotent Migration`:
//!      - `migrate_inline_assets` walks inline rows in key order, writes each
//!        object, reads it back and compares SHA-256 digests. Only then is the
//!        inline payload cleared, and only if it still hashes to the copied
//!        digest. A failed copy leaves the row inline; a rerun picks it up.
//!      - One payload (plus its read-back copy) is in memory at a time.
//!   4. `Minimal Signing Surface`:
//!      - Every request (server writes and reads, browser redirects) uses
//!        SigV4 query presigning with `UNSIGNED-PAYLOAD` and only `host`
//!        signed. Path-style addressing (`/{bucket}/{key}`) works on R2, MinIO
//!        and S3 without per-bucket DNS.
//!      - The secret key never leaves the process: URLs carry only the
//!        signature and the access key id.
//!   5. `Bounded Calls`:
//!      - Each object-store call is capped at `S3_REQUEST_TIMEOUT` (60 s) so a
//!        stalled bucket fails an upload instead of hanging it.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `main` (S3_* configured)
//!     ├── 1. `S3Store::new(postgres, config)` replaces PostgreSQL as `AssetStore`.
//!     ├── 2. Background `migrate_inline_assets` copies inline blobs once.
//!     └── 3. `GET /assets/download/{key}` -> HMAC check -> `307` presigned GET.
//! ============================================================================

use crate::assets::store::{AssetStore, AssetStoreError, BoxFuture};
use crate::auth::magic_link::hmac_sha256;
use crate::storage::blob::{Sha256Hasher, to_lower_hex};
use crate::storage::postgres::{AssetPayload, SqlxPostgresStore};
use axum::http::{Method, Request, StatusCode, header::CONTENT_TYPE};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use std::fmt::Write;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Lifetime of the presigned GET a browser is redirected to (invariant 2).
pub const S3_DOWNLOAD_URL_TTL: Duration = Duration::from_secs(300);
/// Lifetime of the presigned URLs the server uses for its own calls.
const SERVER_REQUEST_URL_TTL: Duration = Duration::from_secs(300);
/// Upper bound of one object-store call (invariant 5).
pub const S3_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Region signed when `S3_REGION` is unset (what Cloudflare R2 expects).
pub const DEFAULT_S3_REGION: &str = "auto";
/// Inline rows fetched per migration page (keys only; payloads load one at a time).
const MIGRATION_PAGE: i64 = 32;

/// `scheme://host[:port]` of an S3-compatible endpoint, default port stripped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S3Endpoint {
    /// `true` for `https://`, `false` for `http://`.
    pub https: bool,
    /// Lowercase `host[:port]`, exactly as sent in the signed `Host` header.
    pub authority: String,
}

impl S3Endpoint {
    /// Parses `http(s)://host[:port]` (one trailing `/` allowed). Paths, queries and user
    /// info are rejected: the signature covers the `Host` header and a path-style key path.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let value = value.strip_suffix('/').unwrap_or(value);
        let (https, rest) = if let Some(rest) = value.strip_prefix("https://") {
            (true, rest)
        } else {
            (false, value.strip_prefix("http://")?)
        };
        if rest.is_empty()
            || rest.starts_with(':')
            || rest.contains(['/', '?', '#', '@', ' ', '\\'])
        {
            return None;
        }
        let default_port = if https { ":443" } else { ":80" };
        let authority = rest.strip_suffix(default_port).unwrap_or(rest);
        Some(Self {
            https,
            authority: authority.to_ascii_lowercase(),
        })
    }

    /// Browser origin of the endpoint (`scheme://authority`), as listed in the CSP.
    pub fn origin(&self) -> String {
        let scheme = if self.https { "https" } else { "http" };
        format!("{scheme}://{}", self.authority)
    }
}

/// Object-store settings read from `S3_*` (see `crate::config`).
#[derive(Clone, PartialEq, Eq)]
pub struct S3Config {
    /// Endpoint the server writes and reads through (`S3_ENDPOINT`).
    pub endpoint: S3Endpoint,
    /// Endpoint signed into browser redirects (`S3_PUBLIC_ENDPOINT`, defaults to `endpoint`).
    pub public_endpoint: S3Endpoint,
    /// Bucket holding every asset of this instance (`S3_BUCKET`).
    pub bucket: String,
    /// SigV4 region (`S3_REGION`, default `DEFAULT_S3_REGION`).
    pub region: String,
    /// Access key id (`S3_ACCESS_KEY_ID`); appears in signed URLs.
    pub access_key_id: String,
    /// Secret access key (`S3_SECRET_ACCESS_KEY`); never leaves the process.
    pub secret_access_key: String,
}

impl std::fmt::Debug for S3Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("public_endpoint", &self.public_endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .finish()
    }
}

/// Percent-encodes `value` as SigV4 requires: RFC 3986 unreserved characters stay, `/`
/// stays only when `encode_slash` is false (object key paths).
fn uri_encode(value: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

/// Proleptic Gregorian `(year, month, day)` of `days` since 1970-01-01
/// (H. Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// SigV4 timestamp (`YYYYMMDDTHHMMSSZ`, UTC) of `secs` since the Unix epoch.
pub fn amz_date(secs: u64) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// One SigV4 query-string presign request (invariant 4).
pub struct PresignRequest<'a> {
    /// HTTP method (`GET`, `PUT`).
    pub method: &'a str,
    /// Endpoint whose authority is signed as `Host`.
    pub endpoint: &'a S3Endpoint,
    /// Already percent-encoded absolute path (`/{bucket}/{key}`).
    pub path: &'a str,
    /// SigV4 region.
    pub region: &'a str,
    /// Access key id.
    pub access_key_id: &'a str,
    /// Secret access key.
    pub secret_access_key: &'a str,
    /// Signing time (`amz_date`).
    pub amz_date: &'a str,
    /// Validity in seconds (`X-Amz-Expires`, at most 604 800).
    pub expires_secs: u64,
}

/// Builds the presigned URL: canonical request -> string to sign -> HMAC chain
/// `AWS4{secret}` / date / region / `s3` / `aws4_request` -> hex signature.
pub fn presign_url(req: &PresignRequest<'_>) -> String {
    let date = &req.amz_date[..8];
    let scope = format!("{date}/{}/s3/aws4_request", req.region);
    let query = format!(
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential={}&X-Amz-Date={}&X-Amz-Expires={}&X-Amz-SignedHeaders=host",
        uri_encode(&format!("{}/{scope}", req.access_key_id), true),
        req.amz_date,
        req.expires_secs
    );
    let canonical_request = format!(
        "{}\n{}\n{query}\nhost:{}\n\nhost\nUNSIGNED-PAYLOAD",
        req.method, req.path, req.endpoint.authority
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        req.amz_date,
        Sha256Hasher::digest(canonical_request.as_bytes())
    );
    let mut key = hmac_sha256(
        format!("AWS4{}", req.secret_access_key).as_bytes(),
        date.as_bytes(),
    );
    for part in [req.region.as_bytes(), b"s3", b"aws4_request"] {
        key = hmac_sha256(&key, part);
    }
    let signature = to_lower_hex(&hmac_sha256(&key, string_to_sign.as_bytes()));
    format!(
        "{}{}?{query}&X-Amz-Signature={signature}",
        req.endpoint.origin(),
        req.path
    )
}

fn io_error(context: &str, err: impl std::fmt::Display) -> AssetStoreError {
    AssetStoreError::Io(format!("{context}: {err}"))
}

/// Minimal S3 client: presigned path-style requests over HTTP/1.1 with rustls (ring,
/// Mozilla roots from `webpki-roots`).
#[derive(Clone)]
pub struct S3Client {
    config: Arc<S3Config>,
    http: Client<HttpsConnector<HttpConnector>, Full<Bytes>>,
}

impl S3Client {
    /// Builds the client; fails only if the TLS configuration cannot be assembled.
    pub fn new(config: S3Config) -> Result<Self, AssetStoreError> {
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
            .map_err(|e| io_error("S3 TLS setup", e))?
            .https_or_http()
            .enable_http1()
            .build();
        Ok(Self {
            config: Arc::new(config),
            http: Client::builder(TokioExecutor::new()).build(https),
        })
    }

    /// Configuration this client signs with.
    pub fn config(&self) -> &S3Config {
        &self.config
    }

    /// Presigned URL for `method` on object `key`, valid `ttl` from now, signed for
    /// `endpoint` (the server endpoint or the public one).
    pub fn presigned_object_url(
        &self,
        method: &str,
        key: &str,
        ttl: Duration,
        endpoint: &S3Endpoint,
    ) -> String {
        let path = format!(
            "/{}/{}",
            uri_encode(&self.config.bucket, true),
            uri_encode(key.trim_start_matches('/'), false)
        );
        self.presign(method, &path, ttl, endpoint)
    }

    fn presign(&self, method: &str, path: &str, ttl: Duration, endpoint: &S3Endpoint) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        presign_url(&PresignRequest {
            method,
            endpoint,
            path,
            region: &self.config.region,
            access_key_id: &self.config.access_key_id,
            secret_access_key: &self.config.secret_access_key,
            amz_date: &amz_date(now),
            expires_secs: ttl.as_secs(),
        })
    }

    /// Sends one request and collects the response body, bounded by `S3_REQUEST_TIMEOUT`.
    async fn send(
        &self,
        method: Method,
        url: &str,
        body: Bytes,
        content_type: Option<&str>,
    ) -> Result<(StatusCode, Bytes), AssetStoreError> {
        let mut builder = Request::builder().method(method).uri(url);
        if let Some(content_type) = content_type {
            builder = builder.header(CONTENT_TYPE, content_type);
        }
        let request = builder
            .body(Full::new(body))
            .map_err(|e| io_error("S3 request", e))?;
        let call = async {
            let response = self
                .http
                .request(request)
                .await
                .map_err(|e| io_error("S3 request", e))?;
            let status = response.status();
            let body = response
                .into_body()
                .collect()
                .await
                .map_err(|e| io_error("S3 response", e))?
                .to_bytes();
            Ok((status, body))
        };
        tokio::time::timeout(S3_REQUEST_TIMEOUT, call)
            .await
            .map_err(|_| AssetStoreError::Io("S3 request timed out".to_string()))?
    }

    fn status_error(action: &str, key: &str, status: StatusCode, body: &[u8]) -> AssetStoreError {
        let detail = String::from_utf8_lossy(&body[..body.len().min(300)]);
        AssetStoreError::Io(format!("S3 {action} {key} failed with {status}: {detail}"))
    }

    /// Writes `body` to `key`, replacing any existing object.
    pub async fn put_object(
        &self,
        key: &str,
        body: Bytes,
        content_type: &str,
    ) -> Result<(), AssetStoreError> {
        let url =
            self.presigned_object_url("PUT", key, SERVER_REQUEST_URL_TTL, &self.config.endpoint);
        let (status, response) = self
            .send(Method::PUT, &url, body, Some(content_type))
            .await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(Self::status_error("PUT", key, status, &response))
        }
    }

    /// Reads `key`; `None` when the object does not exist.
    pub async fn get_object(&self, key: &str) -> Result<Option<Bytes>, AssetStoreError> {
        let url =
            self.presigned_object_url("GET", key, SERVER_REQUEST_URL_TTL, &self.config.endpoint);
        let (status, body) = self.send(Method::GET, &url, Bytes::new(), None).await?;
        match status {
            s if s.is_success() => Ok(Some(body)),
            StatusCode::NOT_FOUND => Ok(None),
            s => Err(Self::status_error("GET", key, s, &body)),
        }
    }

    /// Creates the bucket; an existing bucket owned by these credentials is not an error.
    /// Used by development setups and tests (production buckets are provisioned outside).
    pub async fn create_bucket(&self) -> Result<(), AssetStoreError> {
        let path = format!("/{}", uri_encode(&self.config.bucket, true));
        let url = self.presign("PUT", &path, SERVER_REQUEST_URL_TTL, &self.config.endpoint);
        let (status, body) = self.send(Method::PUT, &url, Bytes::new(), None).await?;
        if status.is_success() || status == StatusCode::CONFLICT {
            Ok(())
        } else {
            Err(Self::status_error("create bucket", "", status, &body))
        }
    }
}

/// `AssetStore` keeping bytes in the object store and metadata in PostgreSQL (invariant 1).
#[derive(Clone)]
pub struct S3Store {
    metadata: Arc<SqlxPostgresStore>,
    client: S3Client,
}

impl S3Store {
    /// Object-store asset backend over `metadata` (the `campaign_assets` rows).
    pub fn new(
        metadata: Arc<SqlxPostgresStore>,
        config: S3Config,
    ) -> Result<Self, AssetStoreError> {
        Ok(Self {
            metadata,
            client: S3Client::new(config)?,
        })
    }

    /// Client used for object reads and writes.
    pub fn client(&self) -> &S3Client {
        &self.client
    }
}

impl AssetStore for S3Store {
    fn put_asset<'a>(
        &'a self,
        key: &'a str,
        data: Bytes,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), AssetStoreError>> {
        Box::pin(async move {
            let byte_size = data.len();
            self.client.put_object(key, data, content_type).await?;
            self.metadata
                .record_external_asset(key, content_type, byte_size)
                .await
        })
    }

    fn get_asset<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Bytes>, AssetStoreError>> {
        Box::pin(async move {
            match self.metadata.asset_payload(key).await? {
                None => Ok(None),
                Some(AssetPayload::Inline(bytes)) => Ok(Some(bytes)),
                Some(AssetPayload::External) => self.client.get_object(key).await,
            }
        })
    }

    fn mint_presigned_get_url<'a>(
        &'a self,
        key: &'a str,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<String, AssetStoreError>> {
        self.metadata.mint_presigned_get_url(key, ttl)
    }

    fn campaign_usage_bytes(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<u64, AssetStoreError>> {
        self.metadata.campaign_usage_bytes(campaign_id)
    }

    fn verify_presigned_get(&self, key: &str, exp: u64, sig_hex: &str) -> bool {
        self.metadata.verify_presigned_get(key, exp, sig_hex)
    }

    fn direct_download_url<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, AssetStoreError>> {
        Box::pin(async move {
            Ok(match self.metadata.asset_is_external(key).await? {
                Some(true) => Some(self.client.presigned_object_url(
                    "GET",
                    key,
                    S3_DOWNLOAD_URL_TTL,
                    &self.client.config.public_endpoint,
                )),
                _ => None,
            })
        })
    }
}

/// Outcome of one `migrate_inline_assets` pass.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BlobMigrationReport {
    /// Rows copied, verified and released from PostgreSQL.
    pub copied: usize,
    /// Rows left inline because a copy or its verification failed.
    pub failed: usize,
}

/// Copies every inline `campaign_assets` payload to the object store (invariant 3).
/// Errors listing rows abort the pass; per-row failures are logged and counted.
pub async fn migrate_inline_assets(
    metadata: &SqlxPostgresStore,
    client: &S3Client,
) -> Result<BlobMigrationReport, AssetStoreError> {
    let mut report = BlobMigrationReport::default();
    let mut after = String::new();
    loop {
        let page = metadata
            .inline_asset_keys_after(&after, MIGRATION_PAGE)
            .await?;
        let Some((last, _)) = page.last() else {
            return Ok(report);
        };
        after = last.clone();
        for (key, content_type) in page {
            match copy_inline_asset(metadata, client, &key, &content_type).await {
                Ok(true) => report.copied += 1,
                Ok(false) => {}
                Err(err) => {
                    tracing::warn!(%key, error = %err, "asset left in PostgreSQL; copy failed");
                    report.failed += 1;
                }
            }
        }
    }
}

/// Copies one inline row; `Ok(false)` when it was no longer inline or changed meanwhile.
async fn copy_inline_asset(
    metadata: &SqlxPostgresStore,
    client: &S3Client,
    key: &str,
    content_type: &str,
) -> Result<bool, AssetStoreError> {
    let Some(AssetPayload::Inline(bytes)) = metadata.asset_payload(key).await? else {
        return Ok(false);
    };
    let digest = sha256(&bytes);
    client.put_object(key, bytes, content_type).await?;
    let stored = client
        .get_object(key)
        .await?
        .ok_or_else(|| AssetStoreError::Io(format!("{key} missing right after its upload")))?;
    if sha256(&stored) != digest {
        return Err(AssetStoreError::Io(format!(
            "{key}: object-store copy does not match the PostgreSQL payload"
        )));
    }
    metadata.release_inline_payload(key, &digest).await
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256Hasher::new();
    hasher.update(bytes);
    hasher.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presign_matches_the_aws_sigv4_query_auth_example() {
        // AWS S3 API reference, "Authenticating Requests: Using Query Parameters".
        let endpoint = S3Endpoint::parse("https://examplebucket.s3.amazonaws.com").unwrap();
        let url = presign_url(&PresignRequest {
            method: "GET",
            endpoint: &endpoint,
            path: "/test.txt",
            region: "us-east-1",
            access_key_id: "AKIAIOSFODNN7EXAMPLE",
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            amz_date: "20130524T000000Z",
            expires_secs: 86_400,
        });
        assert_eq!(
            url,
            "https://examplebucket.s3.amazonaws.com/test.txt\
             ?X-Amz-Algorithm=AWS4-HMAC-SHA256\
             &X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request\
             &X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host\
             &X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        );
    }

    #[test]
    fn amz_date_formats_utc_calendar_time() {
        // (case_id, seconds since the Unix epoch, expected timestamp)
        let cases = [
            ("unix_epoch", 0, "19700101T000000Z"),
            ("aws_example_day", 1_369_353_600, "20130524T000000Z"),
            ("leap_day", 951_782_400, "20000229T000000Z"),
            ("last_second_of_2026", 1_798_761_599, "20261231T235959Z"),
        ];
        for (case, secs, expected) in cases {
            assert_eq!(amz_date(secs), expected, "case {case}");
        }
    }

    #[test]
    fn endpoint_parsing_keeps_only_scheme_and_authority() {
        // (case_id, input, expected (https, authority))
        let cases = [
            (
                "r2_https",
                "https://acc.r2.cloudflarestorage.com",
                Some((true, "acc.r2.cloudflarestorage.com")),
            ),
            (
                "dev_minio_with_port",
                "http://minio:9000",
                Some((false, "minio:9000")),
            ),
            (
                "trailing_slash",
                "http://localhost:9000/",
                Some((false, "localhost:9000")),
            ),
            (
                "default_https_port_stripped",
                "https://S3.Example.com:443",
                Some((true, "s3.example.com")),
            ),
            ("path_rejected", "https://example.com/bucket", None),
            ("missing_scheme", "minio:9000", None),
            ("unsupported_scheme", "ftp://minio:9000", None),
            ("user_info_rejected", "https://user@example.com", None),
            ("empty_host", "https://", None),
        ];
        for (case, input, expected) in cases {
            let parsed = S3Endpoint::parse(input);
            assert_eq!(
                parsed.as_ref().map(|e| (e.https, e.authority.as_str())),
                expected,
                "case {case}"
            );
        }
    }

    #[test]
    fn object_keys_are_encoded_per_segment() {
        // (case_id, raw key, expected canonical path)
        let cases = [
            (
                "content_address",
                "instances/a/campaigns/b/assets/0f.webp",
                "instances/a/campaigns/b/assets/0f.webp",
            ),
            ("space_and_plus", "a b+c", "a%20b%2Bc"),
            ("unicode", "é", "%C3%A9"),
        ];
        for (case, key, expected) in cases {
            assert_eq!(uri_encode(key, false), expected, "case {case}");
        }
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
    }
}
