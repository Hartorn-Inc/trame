//! ============================================================================
//! TRANSPORT SECURITY POLICY, AUTH RATE LIMITING & RESPONSE HEADERS (security.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Centralizes the transport-level defenses shared by the HTTP and WebSocket
//! routers: per-IP and per-account rate limiting on credential endpoints,
//! WebSocket `Origin` allow-listing and frame size caps, the `Secure` cookie
//! toggle, and browser hardening headers. Without them, credential stuffing
//! and TOTP brute force run unthrottled, any web page can open an
//! authenticated WebSocket with the victim's cookie (cross-site WebSocket
//! hijacking), and a single oversized frame can exhaust server memory.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Per-Route, Failure-Only Rate Limits (SEC4)`:
//!      - `/auth/login`, `/auth/register`, `/auth/totp/*`, `/auth/bind*`,
//!        `/invites/*` and `/instance/bootstrap*` keep separate buckets per
//!        route family, keyed by client IP (`per_ip`, default 30 failures per
//!        60 s) and by account
//!        (`per_account`, default 10 failures per 60 s). The account key is the
//!        JSON `email`, else the session token digest, else the invite token
//!        digest.
//!      - Only client failures (4xx other than `429`/`413`) are counted, so
//!        normal use is never blocked; a key over its allowance gets
//!        `429 Too Many Requests` with `Retry-After` before the handler (and
//!        Argon2 / TOTP work) runs.
//!      - TOTP attempts (`/auth/totp/*`, or a login carrying `totp_code`) add an
//!        exponential per-account lockout (`TotpBackoff`) cleared by a success.
//!      - Bucket maps are pruned once they exceed `MAX_TRACKED_KEYS`, bounding
//!        memory under key-spraying.
//!   2. `Client IP Resolution`:
//!      - Uses the socket peer address (`ConnectInfo`) unless
//!        `trusted_proxy_hops = N > 0`, in which case the `N`-th
//!        `X-Forwarded-For` entry from the right (the one appended by the
//!        outermost trusted proxy) is used. IPv6 clients bucket by /64.
//!   2b. `No Fallback Keys (SEC5)`:
//!      - Constructors without a configured secret use `ephemeral_secret()`, a
//!        random per-instance key, never a hard-coded or environment value.
//!   2c. `Opaque Server Errors (SEC15)`:
//!      - `opaque_server_errors_middleware` logs and replaces the message of
//!        every `500` JSON body with `GENERIC_SERVER_ERROR`.
//!   3. `WebSocket Origin Allow-List`:
//!      - Browsers always send `Origin` on WebSocket upgrades; a present
//!        `Origin` must exactly match `allowed_origins`. Absent `Origin`
//!        (CLI / MCP clients, which carry no ambient cookies) is accepted.
//!   4. `Hardening Headers`:
//!      - Every response gets `X-Content-Type-Options: nosniff`,
//!        `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a
//!        `Content-Security-Policy` unless a handler already set them.
//!   5. `Two Content Security Policies`:
//!      - Non-HTML responses (JSON API, bundle files, asset downloads) get
//!        `API_CSP` = `default-src 'none'; frame-ancestors 'none'; base-uri
//!        'none'`: such a body opened as a document can load nothing.
//!      - `text/html` responses (the SPA `index.html` and its deep-link
//!        fallback) get `spa_csp`, derived from what the built
//!        `packages/web` bundle actually loads:
//!        - `script-src 'self' 'wasm-unsafe-eval'`: the hashed module bundle
//!          under `/assets/`, plus `WebAssembly.instantiateStreaming` of the
//!          `trame-engine` WASM. No `eval`/`new Function`, no inline script.
//!        - `style-src 'self'`: the extracted `/assets/*.css`. No
//!          `'unsafe-inline'` and no `style-src-attr`: Preact applies `style`
//!          props through the CSSOM (`el.style.x = ...`, `cssText`,
//!          `setProperty`), which CSP does not govern, and the bundle sets no
//!          `style="..."` markup.
//!        - `img-src 'self'` / `font-src 'self'`: `/brand/*`, self-hosted
//!          `/fonts/*.woff2`, and battlemaps through relative presigned
//!          `/assets/download/...` URLs. The bundle builds no `data:` or
//!          `blob:` URLs, so neither is allowed.
//!        - `connect-src 'self' ws://{host} wss://{host}`: REST, the WASM
//!          fetch, and the same-origin table WebSocket. The explicit WebSocket
//!          sources come from a validated `Host` and cover browsers that do not
//!          yet match `ws:` against `'self'`.
//!        - `form-action 'self'`, `object-src 'none'`, `frame-ancestors
//!          'none'`, `base-uri 'none'`; everything else falls to
//!          `default-src 'none'` (no workers, frames, or manifests are used).
//! ============================================================================

use crate::auth::password::extract_session_token;
use crate::auth::session::{AuthState, hash_session_token};
use crate::config::{DEV_ALLOWED_ORIGINS, normalize_origin};
use crate::storage::blob::Sha256Hasher;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE, HeaderName, HeaderValue, RETRY_AFTER};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Default WebSocket message and frame size cap in bytes (1 MiB).
pub const DEFAULT_WS_MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Maximum buffered JSON body for rate-limited auth routes in bytes (64 KiB).
pub const MAX_AUTH_BODY_BYTES: usize = 64 * 1024;

/// Bucket count above which expired windows are pruned.
pub const MAX_TRACKED_KEYS: usize = 10_000;

/// Fixed-window allowance: `max_attempts` requests per `window`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    /// Attempts allowed per window (`>= 1`).
    pub max_attempts: u32,
    /// Window length.
    pub window: Duration,
}

/// Exponential lockout applied to TOTP failures per account (SEC4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TotpBackoff {
    /// Consecutive failures tolerated before the first lockout (typos).
    pub free_failures: u32,
    /// Lockout after the first failure beyond `free_failures`; doubles with each further one.
    pub base: Duration,
    /// Longest lockout.
    pub max: Duration,
}

impl Default for TotpBackoff {
    /// 3 free failures, then 2 s, 4 s, 8 s, ... capped at 15 minutes.
    fn default() -> Self {
        Self {
            free_failures: 3,
            base: Duration::from_secs(2),
            max: Duration::from_secs(15 * 60),
        }
    }
}

impl TotpBackoff {
    /// Lockout after `failures` consecutive failures (`Duration::ZERO` while still free).
    pub fn lockout(&self, failures: u32) -> Duration {
        let Some(over) = failures.checked_sub(self.free_failures).filter(|n| *n > 0) else {
            return Duration::ZERO;
        };
        self.base
            .checked_mul(1u32 << (over - 1).min(20))
            .map_or(self.max, |d| d.min(self.max))
    }
}

/// In-memory dual-key (IP + account) fixed-window rate limiter for credential endpoints.
/// Only failed attempts consume allowance; successful requests are never throttled by it.
#[derive(Debug)]
pub struct AuthRateLimiter {
    /// Failed attempts allowed per client IP (IPv6 grouped by /64) per route.
    pub per_ip: RateLimit,
    /// Failed attempts allowed per account key (email, session, or invite token) per route.
    pub per_account: RateLimit,
    /// Extra exponential lockout for TOTP failures per account.
    pub totp_backoff: TotpBackoff,
    /// Archive imports allowed per account, successful or not (SEC6); default 10 per hour.
    pub imports_per_account: RateLimit,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
    backoffs: Mutex<HashMap<String, (u32, Instant)>>,
}

impl Default for AuthRateLimiter {
    fn default() -> Self {
        Self::new(
            RateLimit {
                max_attempts: 30,
                window: Duration::from_secs(60),
            },
            RateLimit {
                max_attempts: 10,
                window: Duration::from_secs(60),
            },
        )
    }
}

impl AuthRateLimiter {
    /// Creates a limiter with explicit IP and account allowances and the default TOTP backoff.
    pub fn new(per_ip: RateLimit, per_account: RateLimit) -> Self {
        Self {
            per_ip,
            per_account,
            totp_backoff: TotpBackoff::default(),
            imports_per_account: RateLimit {
                max_attempts: 10,
                window: Duration::from_secs(3600),
            },
            buckets: Mutex::new(HashMap::new()),
            backoffs: Mutex::new(HashMap::new()),
        }
    }

    /// Consumes one archive import from `user_id`'s quota, or returns the remaining wait.
    pub fn take_import(&self, user_id: uuid::Uuid) -> Result<(), Duration> {
        let key = format!("import:{user_id}");
        self.blocked(&key, self.imports_per_account)?;
        self.record(&key, self.imports_per_account);
        Ok(())
    }

    /// Returns the remaining wait when `key` already used up its failure allowance.
    pub fn blocked(&self, key: &str, limit: RateLimit) -> Result<(), Duration> {
        let now = Instant::now();
        let Ok(buckets) = self.buckets.lock() else {
            return Ok(());
        };
        match buckets.get(key) {
            Some((start, count))
                if now.duration_since(*start) < limit.window && *count >= limit.max_attempts =>
            {
                Err(limit.window.saturating_sub(now.duration_since(*start)))
            }
            _ => Ok(()),
        }
    }

    /// Counts one attempt against `key` (a failure for credential routes, any import for the
    /// import quota).
    pub fn record(&self, key: &str, limit: RateLimit) {
        let now = Instant::now();
        let Ok(mut buckets) = self.buckets.lock() else {
            return;
        };
        if buckets.len() > MAX_TRACKED_KEYS {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < limit.window);
        }
        let entry = buckets.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= limit.window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
    }

    /// Returns the remaining TOTP lockout for `key`, if any.
    pub fn totp_locked(&self, key: &str) -> Result<(), Duration> {
        let now = Instant::now();
        let Ok(backoffs) = self.backoffs.lock() else {
            return Ok(());
        };
        match backoffs.get(key) {
            Some((_, until)) if *until > now => Err(*until - now),
            _ => Ok(()),
        }
    }

    /// Records a TOTP outcome for `key`: a failure extends the lockout, a success clears it.
    pub fn record_totp(&self, key: &str, failed: bool) {
        let now = Instant::now();
        let Ok(mut backoffs) = self.backoffs.lock() else {
            return;
        };
        if !failed {
            backoffs.remove(key);
            return;
        }
        if backoffs.len() > MAX_TRACKED_KEYS {
            backoffs.retain(|_, (_, until)| *until > now);
        }
        let entry = backoffs.entry(key.to_string()).or_insert((0, now));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = now + self.totp_backoff.lockout(entry.0);
    }
}

/// Random 32-byte key for constructors that have no configured secret (SEC5): unknown to
/// anyone, valid only for the lifetime of the instance that generated it.
pub fn ephemeral_secret() -> [u8; 32] {
    use rand::RngExt;
    let mut key = [0u8; 32];
    rand::rng().fill(&mut key);
    key
}

/// Transport security settings shared by HTTP and WebSocket handlers.
#[derive(Debug)]
pub struct SecurityPolicy {
    /// Emit the `Secure` attribute on session cookies (`TRAME_COOKIE_SECURE`, default `true`).
    pub cookie_secure: bool,
    /// Normalized browser origins allowed to open WebSockets.
    pub allowed_origins: Vec<String>,
    /// WebSocket message and frame size cap in bytes.
    pub ws_max_message_bytes: usize,
    /// Trusted reverse proxies in front of the server (`TRAME_TRUSTED_PROXY_HOPS`, default `0`).
    /// `0` keys rate limits on the socket peer; `N` on the `N`-th `X-Forwarded-For` entry
    /// from the right.
    pub trusted_proxy_hops: usize,
    /// Credential endpoint rate limiter.
    pub rate_limiter: AuthRateLimiter,
    /// Normalized `TRAME_PUBLIC_ORIGIN` prefixed to invite URLs; `None` yields relative URLs.
    pub public_origin: Option<String>,
    /// `POST /api/v1/auth/register` accepts new accounts (only `TRAME_ENV=dev`, SEC10).
    pub registration_open: bool,
    /// `TRAME_BOOTSTRAP_OWNER_EMAIL` (normalized): the only email the owner bootstrap accepts.
    pub bootstrap_owner_email: Option<String>,
    /// Per-campaign asset storage quota in bytes (default 1 GiB). Uploads and map imports are
    /// refused with `413 STORAGE_QUOTA_EXCEEDED` before decoding once stored + incoming bytes
    /// would exceed it (SEC14).
    pub campaign_asset_quota_bytes: u64,
    /// Longest a WebSocket waits for its room actor to attach it or accept one frame
    /// (default `DEFAULT_WS_ROOM_CALL_TIMEOUT`). On expiry the socket is closed with `1011`,
    /// so a stalled actor cannot hold connections and their reconnect storm forever.
    pub ws_room_call_timeout: Duration,
}

/// Default `SecurityPolicy::campaign_asset_quota_bytes` (1 GiB).
pub const DEFAULT_CAMPAIGN_ASSET_QUOTA_BYTES: u64 = 1024 * 1024 * 1024;

/// Default `SecurityPolicy::ws_room_call_timeout` (10 s): above the 6 s Postgres WAL call
/// bound, so a single slow append is not enough to drop a socket.
pub const DEFAULT_WS_ROOM_CALL_TIMEOUT: Duration = Duration::from_secs(10);

impl Default for SecurityPolicy {
    /// Development policy: secure cookies, Vite dev origins, 1 MiB frames, default limits.
    fn default() -> Self {
        Self {
            cookie_secure: true,
            allowed_origins: DEV_ALLOWED_ORIGINS.map(normalize_origin).to_vec(),
            ws_max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
            trusted_proxy_hops: 0,
            rate_limiter: AuthRateLimiter::default(),
            public_origin: None,
            registration_open: true,
            bootstrap_owner_email: None,
            campaign_asset_quota_bytes: DEFAULT_CAMPAIGN_ASSET_QUOTA_BYTES,
            ws_room_call_timeout: DEFAULT_WS_ROOM_CALL_TIMEOUT,
        }
    }
}

impl SecurityPolicy {
    /// Accepts a missing `Origin` (non-browser client) or an exact allow-list match.
    pub fn is_origin_allowed(&self, origin: Option<&str>) -> bool {
        match origin {
            None => true,
            Some(o) => self.allowed_origins.contains(&normalize_origin(o)),
        }
    }

    /// Rate-limit bucket of the client address: the socket peer, or the `X-Forwarded-For` entry
    /// appended by the outermost trusted proxy. A header shorter than the hop count, or an
    /// entry that is not an IP, falls back to the peer so spoofed headers cannot pick a bucket.
    fn client_ip(&self, request: &Request) -> String {
        let forwarded = (self.trusted_proxy_hops > 0)
            .then(|| request.headers().get("x-forwarded-for"))
            .flatten()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.rsplit(',')
                    .nth(self.trusted_proxy_hops - 1)
                    .and_then(|hop| hop.trim().parse::<IpAddr>().ok())
            });
        forwarded
            .or_else(|| {
                request
                    .extensions()
                    .get::<ConnectInfo<SocketAddr>>()
                    .map(|ci| ci.0.ip())
            })
            .map_or_else(|| "unknown".to_string(), ip_bucket)
    }
}

/// IPv4 addresses bucket individually; IPv6 addresses bucket by their /64 prefix, the
/// smallest block a single subscriber is usually assigned.
pub fn ip_bucket(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
    }
}

/// Route family sharing one set of buckets, so limits on one credential route never
/// throttle another.
fn route_family(path: &str) -> &'static str {
    if path.starts_with("/api/v1/invites/") {
        return "invite";
    }
    if path.starts_with("/api/v1/instance/bootstrap") {
        return "bootstrap";
    }
    let rest = path.trim_start_matches("/api/v1/auth/");
    if rest.starts_with("totp") {
        "totp"
    } else if rest.starts_with("bind") {
        "bind"
    } else if rest.starts_with("register") {
        "register"
    } else {
        "login"
    }
}

/// Client-attributable failures (bad credentials, invalid input, unknown account) count
/// against the limits; `429` and `413` do not, nor do successes or server errors.
fn is_counted_failure(status: StatusCode) -> bool {
    status.is_client_error()
        && status != StatusCode::TOO_MANY_REQUESTS
        && status != StatusCode::PAYLOAD_TOO_LARGE
}

fn account_key(headers: &HeaderMap, body: &[u8]) -> Option<String> {
    let json: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let field = |name: &str| {
        json.as_ref()
            .and_then(|j| j.get(name))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    if let Some(email) = field("email") {
        return Some(format!("email:{}", email.to_lowercase()));
    }
    if let Some(token) = extract_session_token(headers) {
        return Some(format!("session:{}", hash_session_token(&token)));
    }
    field("token").map(|t| format!("invite:{}", Sha256Hasher::digest(t.as_bytes())))
}

/// `429 RATE_LIMITED` with a `Retry-After` header (whole seconds, at least 1).
pub fn too_many_requests(retry_after: Duration) -> Response {
    let secs = retry_after.as_secs().max(1);
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({
            "code": "RATE_LIMITED",
            "error": "too many attempts, retry later",
        })),
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&secs.to_string()) {
        resp.headers_mut().insert(RETRY_AFTER, v);
    }
    resp
}

/// Axum middleware enforcing per-route IP and account failure limits on credential routes,
/// plus the TOTP backoff. Blocked keys get `429` before the handler (and Argon2 / TOTP work)
/// runs; the handler's response then decides whether the attempt counts as a failure.
pub async fn auth_rate_limit_middleware(
    State(state): State<AuthState>,
    request: Request,
    next: Next,
) -> Response {
    let policy = state.security.clone();
    let limiter = &policy.rate_limiter;
    let family = route_family(request.uri().path());
    let ip_key = format!("ip:{family}:{}", policy.client_ip(&request));
    if let Err(wait) = limiter.blocked(&ip_key, limiter.per_ip) {
        return too_many_requests(wait);
    }

    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, MAX_AUTH_BODY_BYTES).await else {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "code": "PAYLOAD_TOO_LARGE",
                "error": "request body too large",
            })),
        )
            .into_response();
    };
    let account = account_key(&parts.headers, &bytes);
    let acct_key = account.as_ref().map(|key| format!("acct:{family}:{key}"));
    let totp_key = account
        .as_ref()
        .filter(|_| family == "totp" || carries_totp_code(&bytes))
        .map(|key| format!("totp:{key}"));
    if let Some(key) = &acct_key
        && let Err(wait) = limiter.blocked(key, limiter.per_account)
    {
        return too_many_requests(wait);
    }
    if let Some(key) = &totp_key
        && let Err(wait) = limiter.totp_locked(key)
    {
        return too_many_requests(wait);
    }

    let response = next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await;
    let failed = is_counted_failure(response.status());
    if failed {
        limiter.record(&ip_key, limiter.per_ip);
        if let Some(key) = &acct_key {
            limiter.record(key, limiter.per_account);
        }
    }
    if let Some(key) = &totp_key
        && (failed || response.status().is_success())
    {
        limiter.record_totp(key, failed);
    }
    response
}

fn carries_totp_code(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|j| {
            j.get("totp_code")
                .and_then(|v| v.as_str())
                .map(|v| !v.trim().is_empty())
        })
        .unwrap_or(false)
}

/// Generic message replacing the detail of every `500` JSON response (SEC15).
pub const GENERIC_SERVER_ERROR: &str = "internal server error";

/// Largest `500` body inspected by `opaque_server_errors_middleware`; larger bodies are
/// replaced wholesale.
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Logs the detail of every `500 Internal Server Error` JSON response and replaces its
/// message (`error` string, or JSON-RPC `error.message`) with `GENERIC_SERVER_ERROR`, keeping
/// the machine-readable `code`. Database and storage text therefore never reaches clients.
pub async fn opaque_server_errors_middleware(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;
    let is_json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.trim_start().starts_with("application/json"));
    if response.status() != StatusCode::INTERNAL_SERVER_ERROR || !is_json {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let detail = to_bytes(body, MAX_ERROR_BODY_BYTES)
        .await
        .unwrap_or_default();
    tracing::error!(%method, %path, detail = %String::from_utf8_lossy(&detail), "internal server error");
    let mut value = serde_json::from_slice::<serde_json::Value>(&detail)
        .unwrap_or_else(|_| serde_json::json!({ "error": GENERIC_SERVER_ERROR }));
    match value.get_mut("error") {
        Some(serde_json::Value::Object(rpc)) => {
            rpc.insert("message".to_string(), GENERIC_SERVER_ERROR.into());
            rpc.remove("data");
        }
        Some(message) => *message = GENERIC_SERVER_ERROR.into(),
        None => {
            value = serde_json::json!({ "error": GENERIC_SERVER_ERROR });
        }
    }
    parts.headers.remove(CONTENT_LENGTH);
    Response::from_parts(
        parts,
        Body::from(serde_json::to_vec(&value).unwrap_or_default()),
    )
}

/// CSP for every non-HTML response (JSON API, bundle files, signed asset downloads):
/// nothing may load or execute if such a response is ever rendered as a document.
pub const API_CSP: &str = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/// CSP for `text/html` responses (the SPA shell). See the module banner for why each
/// source is allowed. `host` is the request `Host`; when it is a plain `host[:port]`, the
/// same-origin `ws://` / `wss://` sources are added for browsers whose `'self'` predates
/// CSP3 WebSocket matching.
pub fn spa_csp(host: Option<&str>) -> String {
    let ws = host
        .filter(|h| {
            !h.is_empty()
                && h.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
        })
        .map(|h| format!(" ws://{h} wss://{h}"))
        .unwrap_or_default();
    format!(
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
         img-src 'self'; font-src 'self'; connect-src 'self'{ws}; form-action 'self'; \
         object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    )
}

/// Adds CSP, `nosniff`, `X-Frame-Options`, and `Referrer-Policy` headers to every response.
/// HTML documents get `spa_csp`; everything else gets `API_CSP`.
pub async fn security_headers_middleware(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    let is_html = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.trim_start().starts_with("text/html"));
    let csp_name = HeaderName::from_static("content-security-policy");
    if !headers.contains_key(&csp_name) {
        let csp = if is_html {
            HeaderValue::from_str(&spa_csp(host.as_deref()))
                .unwrap_or_else(|_| HeaderValue::from_static(API_CSP))
        } else {
            HeaderValue::from_static(API_CSP)
        };
        headers.insert(csp_name, csp);
    }
    let defaults: [(&str, &str); 3] = [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
    ];
    for (name, value) in defaults {
        let name = HeaderName::from_static(name);
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    response
}
