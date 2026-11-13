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
//!      - The check and the count are one atomic step (`try_reserve`) taken
//!        before the handler; a response that is not a counted failure returns
//!        the attempt (`release`). Checking first and counting after the
//!        handler would let N parallel failures all pass the same check.
//!      - TOTP attempts (`/auth/totp/*`, or a login carrying `totp_code`) add an
//!        exponential per-account lockout (`TotpBackoff`) cleared by a success.
//!        A failure counts only when the handler marks its response
//!        `TotpCodeRejected`, i.e. after the password or session was verified.
//!      - Bucket maps are pruned once they exceed `MAX_TRACKED_KEYS`; each
//!        bucket expires on its own window, so pruning on a credential route
//!        never resets an hour-long import or upload quota.
//!   2. `Client IP Resolution`:
//!      - Uses the socket peer address (`ConnectInfo`) unless
//!        `trusted_proxy_hops = N > 0`, in which case the `N`-th
//!        `X-Forwarded-For` entry from the right (the one appended by the
//!        outermost trusted proxy) is used. IPv6 clients bucket by /64.
//!      - Emits a structured `tracing::debug!` event (`client_bucket`,
//!        `trusted_proxy_hops`, `source`) without credentials or raw headers so
//!        operators can verify hop extraction with
//!        `RUST_LOG=trame_server::security=debug`.
//!   2b. `No Fallback Keys (SEC5)`:
//!      - Production stores take their keys explicitly from `ServerSecrets`
//!        (`InMemoryAssetStore::with_base_url_and_secret`,
//!        `SqlxPostgresStore::new` / `connect_and_migrate`). Only the
//!        test/dev-router constructor `InMemoryAssetStore::with_ephemeral_secret`
//!        uses `ephemeral_secret()`, a random per-process key, never a
//!        hard-coded or environment value.
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
//!      - When `TRAME_PUBLIC_ORIGIN` is `https://...`, every response also gets
//!        `Strict-Transport-Security: max-age=31536000` (no `preload`, no
//!        `includeSubDomains`). Plain-HTTP origins (local dev, LAN) get none,
//!        since HSTS on an HTTP origin would lock browsers out of it.
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
//!          `blob:` URLs, so neither is allowed. With an object store
//!          configured, `img-src` also lists its public origin
//!          (`SecurityPolicy::asset_origin`): downloads redirect there.
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
use std::sync::{Arc, Mutex};
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
    /// Asset uploads (image decodes) allowed per account, successful or not; default 60 per
    /// 10 minutes.
    pub uploads_per_account: RateLimit,
    buckets: Mutex<HashMap<String, Bucket>>,
    backoffs: Mutex<HashMap<String, (u32, Instant)>>,
}

/// One fixed window: when it started, how many attempts it holds, and its own length, so
/// pruning never drops a live window of a longer-lived limit (an import's hour) early.
#[derive(Debug, Clone, Copy)]
struct Bucket {
    start: Instant,
    count: u32,
    window: Duration,
}

/// An attempt counted by `AuthRateLimiter::try_reserve`; hand it to `release` when the
/// attempt turned out not to count (a success), so only failures keep consuming allowance.
#[derive(Debug)]
pub struct Reservation {
    key: String,
    window_start: Instant,
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
            uploads_per_account: RateLimit {
                max_attempts: 60,
                window: Duration::from_secs(600),
            },
            buckets: Mutex::new(HashMap::new()),
            backoffs: Mutex::new(HashMap::new()),
        }
    }

    /// Consumes one archive import from `user_id`'s quota, or returns the remaining wait.
    pub fn take_import(&self, user_id: uuid::Uuid) -> Result<(), Duration> {
        self.try_reserve(&format!("import:{user_id}"), self.imports_per_account)
            .map(drop)
    }

    /// Consumes one asset upload from `user_id`'s quota, or returns the remaining wait.
    pub fn take_upload(&self, user_id: uuid::Uuid) -> Result<(), Duration> {
        self.try_reserve(&format!("upload:{user_id}"), self.uploads_per_account)
            .map(drop)
    }

    /// Atomically checks and counts one attempt against `key`: returns the remaining wait
    /// when the window is full, otherwise counts the attempt before returning. Checking and
    /// counting under one lock is what stops N parallel requests from all passing a check
    /// made before any of them was counted.
    pub fn try_reserve(&self, key: &str, limit: RateLimit) -> Result<Reservation, Duration> {
        let now = Instant::now();
        let Ok(mut buckets) = self.buckets.lock() else {
            return Ok(Reservation {
                key: key.to_string(),
                window_start: now,
            });
        };
        if buckets.len() > MAX_TRACKED_KEYS {
            buckets.retain(|_, b| now.duration_since(b.start) < b.window);
        }
        let bucket = buckets.entry(key.to_string()).or_insert(Bucket {
            start: now,
            count: 0,
            window: limit.window,
        });
        if now.duration_since(bucket.start) >= bucket.window {
            *bucket = Bucket {
                start: now,
                count: 0,
                window: limit.window,
            };
        }
        if bucket.count >= limit.max_attempts {
            return Err(bucket
                .window
                .saturating_sub(now.duration_since(bucket.start)));
        }
        bucket.count += 1;
        Ok(Reservation {
            key: key.to_string(),
            window_start: bucket.start,
        })
    }

    /// Returns a reserved attempt that did not count. Ignored once its window has rolled over,
    /// so it never refunds an attempt of a later window.
    pub fn release(&self, reservation: Reservation) {
        let Ok(mut buckets) = self.buckets.lock() else {
            return;
        };
        if let Some(bucket) = buckets.get_mut(&reservation.key)
            && bucket.start == reservation.window_start
        {
            bucket.count = bucket.count.saturating_sub(1);
        }
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
    /// Interval between the server's WebSocket `Ping` frames on an attached socket
    /// (default `DEFAULT_WS_PING_INTERVAL`, the client's heartbeat interval).
    pub ws_ping_interval: Duration,
    /// Silence allowed after a server `Ping` before the peer counts as gone (default
    /// `DEFAULT_WS_PONG_TIMEOUT`, the client's `Pong` window). A socket that receives no
    /// frame at all for `ws_ping_interval + ws_pong_timeout` is closed.
    pub ws_pong_timeout: Duration,
    /// Origin of the object store asset downloads redirect to (`S3_PUBLIC_ENDPOINT`), added
    /// to the SPA's `img-src`; `None` when assets are served by the server itself.
    pub asset_origin: Option<String>,
}

/// Default `SecurityPolicy::ws_ping_interval` (20 s), matching the web client's `Ping`
/// interval (`HEARTBEAT_INTERVAL_MS`).
pub const DEFAULT_WS_PING_INTERVAL: Duration = Duration::from_secs(20);

/// Default `SecurityPolicy::ws_pong_timeout` (10 s), matching the web client's `Pong`
/// deadline (`PONG_TIMEOUT_MS`).
pub const DEFAULT_WS_PONG_TIMEOUT: Duration = Duration::from_secs(10);

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
            ws_ping_interval: DEFAULT_WS_PING_INTERVAL,
            ws_pong_timeout: DEFAULT_WS_PONG_TIMEOUT,
            asset_origin: None,
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
    ///
    /// Logs the resolved `client_bucket`, `trusted_proxy_hops`, and `source` at `DEBUG` level
    /// (never credentials or raw headers) for `RUST_LOG=trame_server::security=debug` checks.
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
        let (bucket, source) = if let Some(ip) = forwarded {
            (ip_bucket(ip), "x_forwarded_for")
        } else if let Some(ci) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
            (ip_bucket(ci.0.ip()), "connect_info")
        } else {
            ("unknown".to_string(), "unknown")
        };
        tracing::debug!(
            client_bucket = %bucket,
            trusted_proxy_hops = self.trusted_proxy_hops,
            source = %source,
            "resolved rate-limit client bucket"
        );
        bucket
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
    if path.starts_with("/api/v1/instance/users/") {
        return "admin";
    }
    let rest = path.trim_start_matches("/api/v1/auth/");
    if rest.starts_with("password-reset") {
        "reset"
    } else if rest.starts_with("password") {
        "password"
    } else if rest.starts_with("totp") {
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
    let mut reservations = Vec::with_capacity(2);
    match limiter.try_reserve(&ip_key, limiter.per_ip) {
        Ok(r) => reservations.push(r),
        Err(wait) => return too_many_requests(wait),
    }
    let release_all = |reservations: Vec<Reservation>| {
        for r in reservations {
            limiter.release(r);
        }
    };

    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, MAX_AUTH_BODY_BYTES).await else {
        release_all(reservations);
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
    let totp_key = account
        .as_ref()
        .filter(|_| family == "totp" || carries_totp_code(&bytes))
        .map(|key| format!("totp:{key}"));
    if let Some(key) = &account {
        match limiter.try_reserve(&format!("acct:{family}:{key}"), limiter.per_account) {
            Ok(r) => reservations.push(r),
            Err(wait) => {
                release_all(reservations);
                return too_many_requests(wait);
            }
        }
    }
    if let Some(key) = &totp_key
        && let Err(wait) = limiter.totp_locked(key)
    {
        release_all(reservations);
        return too_many_requests(wait);
    }

    let response = next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await;
    if !is_counted_failure(response.status()) {
        release_all(reservations);
    }
    if let Some(key) = &totp_key {
        if response.extensions().get::<TotpCodeRejected>().is_some() {
            limiter.record_totp(key, true);
        } else if response.status().is_success() {
            limiter.record_totp(key, false);
        }
    }
    response
}

/// Response extension a handler sets when it rejected a TOTP code *after* authenticating
/// the caller (password checked, or session resolved). Only these responses extend the
/// TOTP lockout, so a stranger sending wrong passwords with a `totp_code` cannot lock the
/// account owner out.
#[derive(Debug, Clone, Copy)]
pub struct TotpCodeRejected;

/// Marks `response` as a TOTP rejection for `auth_rate_limit_middleware`.
pub fn totp_rejected(mut response: Response) -> Response {
    response.extensions_mut().insert(TotpCodeRejected);
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
/// CSP3 WebSocket matching. `asset_origin` (a validated `scheme://host[:port]`) is added to
/// `img-src`.
pub fn spa_csp(host: Option<&str>, asset_origin: Option<&str>) -> String {
    let ws = host
        .filter(|h| {
            !h.is_empty()
                && h.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
        })
        .map(|h| format!(" ws://{h} wss://{h}"))
        .unwrap_or_default();
    let img = asset_origin.map(|o| format!(" {o}")).unwrap_or_default();
    format!(
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
         img-src 'self'{img}; font-src 'self'; connect-src 'self'{ws}; form-action 'self'; \
         object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    )
}

/// `Strict-Transport-Security` sent on every response of an HTTPS deployment: one year,
/// no `includeSubDomains` and no `preload`, so a self-hoster's other subdomains and the
/// browser preload list are never committed on their behalf.
pub const HSTS_VALUE: &str = "max-age=31536000";

/// Adds CSP, `nosniff`, `X-Frame-Options`, and `Referrer-Policy` headers to every response,
/// plus `Strict-Transport-Security` (`HSTS_VALUE`) when `TRAME_PUBLIC_ORIGIN` is `https://`.
/// HTML documents get `spa_csp`; everything else gets `API_CSP`.
pub async fn security_headers_middleware(
    State(policy): State<Arc<SecurityPolicy>>,
    request: Request,
    next: Next,
) -> Response {
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
            HeaderValue::from_str(&spa_csp(host.as_deref(), policy.asset_origin.as_deref()))
                .unwrap_or_else(|_| HeaderValue::from_static(API_CSP))
        } else {
            HeaderValue::from_static(API_CSP)
        };
        headers.insert(csp_name, csp);
    }
    if policy
        .public_origin
        .as_deref()
        .is_some_and(|o| o.starts_with("https://"))
    {
        headers.insert(
            HeaderName::from_static("strict-transport-security"),
            HeaderValue::from_static(HSTS_VALUE),
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::{AUTHORIZATION, COOKIE};

    #[derive(Default)]
    struct FieldRecorder(Vec<(String, String)>);

    impl tracing::field::Visit for FieldRecorder {
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            self.0.push((field.name().to_string(), value.to_string()));
        }

        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            self.0
                .push((field.name().to_string(), format!("{value:?}")));
        }
    }

    type CapturedEvent = (tracing::Level, String, Vec<(String, String)>);

    #[derive(Clone, Default)]
    struct DebugCapture(Arc<Mutex<Vec<CapturedEvent>>>);

    impl tracing::Subscriber for DebugCapture {
        fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
            metadata.level() <= &tracing::Level::DEBUG
        }

        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }

        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            let mut recorder = FieldRecorder::default();
            event.record(&mut recorder);
            self.0.lock().expect("capture mutex").push((
                *event.metadata().level(),
                event.metadata().target().to_string(),
                recorder.0,
            ));
        }

        fn enter(&self, _: &tracing::span::Id) {}

        fn exit(&self, _: &tracing::span::Id) {}
    }

    struct ClientIpCase {
        id: &'static str,
        trusted_proxy_hops: usize,
        xff: Option<&'static str>,
        peer: Option<&'static str>,
        expected_bucket: &'static str,
        expected_source: &'static str,
    }

    #[test]
    fn client_ip_resolves_trusted_proxy_hops_and_logs_safe_debug_fields() {
        let cases = [
            ClientIpCase {
                id: "hops_0_ignores_xff_and_uses_socket_peer",
                trusted_proxy_hops: 0,
                xff: Some("198.51.100.99"),
                peer: Some("10.0.0.5:4321"),
                expected_bucket: "10.0.0.5",
                expected_source: "connect_info",
            },
            ClientIpCase {
                id: "hops_1_uses_rightmost_xff_ignoring_spoofed_prefix",
                trusted_proxy_hops: 1,
                xff: Some("198.51.100.77, 203.0.113.42"),
                peer: Some("169.254.1.1:8080"),
                expected_bucket: "203.0.113.42",
                expected_source: "x_forwarded_for",
            },
            ClientIpCase {
                id: "hops_2_selects_second_entry_from_right",
                trusted_proxy_hops: 2,
                xff: Some("198.51.100.77, 203.0.113.42, 10.10.0.1"),
                peer: Some("127.0.0.1:8080"),
                expected_bucket: "203.0.113.42",
                expected_source: "x_forwarded_for",
            },
            ClientIpCase {
                id: "hops_exceeding_xff_length_falls_back_to_peer",
                trusted_proxy_hops: 2,
                xff: Some("203.0.113.42"),
                peer: Some("10.0.0.5:4321"),
                expected_bucket: "10.0.0.5",
                expected_source: "connect_info",
            },
            ClientIpCase {
                id: "malformed_xff_hop_falls_back_to_peer",
                trusted_proxy_hops: 1,
                xff: Some("203.0.113.42, not-an-ip"),
                peer: Some("10.0.0.5:4321"),
                expected_bucket: "10.0.0.5",
                expected_source: "connect_info",
            },
            ClientIpCase {
                id: "ipv6_xff_buckets_by_64_prefix",
                trusted_proxy_hops: 1,
                xff: Some("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
                peer: Some("10.0.0.5:4321"),
                expected_bucket: "2001:db8:1:2::/64",
                expected_source: "x_forwarded_for",
            },
            ClientIpCase {
                id: "missing_xff_and_missing_peer_returns_unknown",
                trusted_proxy_hops: 1,
                xff: None,
                peer: None,
                expected_bucket: "unknown",
                expected_source: "unknown",
            },
        ];

        for case in cases {
            let policy = SecurityPolicy {
                trusted_proxy_hops: case.trusted_proxy_hops,
                ..SecurityPolicy::default()
            };
            let mut builder = Request::builder()
                .uri("/api/v1/auth/login")
                .header(AUTHORIZATION, "Bearer secret-bearer-token")
                .header(COOKIE, "trame_session=secret-cookie-token");
            if let Some(xff) = case.xff {
                builder = builder.header("x-forwarded-for", xff);
            }
            let mut request = builder.body(Body::empty()).expect("valid test request");
            if let Some(peer) = case.peer {
                let addr: SocketAddr = peer.parse().expect("valid peer socket addr");
                request.extensions_mut().insert(ConnectInfo(addr));
            }

            let capture = DebugCapture::default();
            let resolved =
                tracing::subscriber::with_default(capture.clone(), || policy.client_ip(&request));
            assert_eq!(resolved, case.expected_bucket, "case {}", case.id);

            let events = capture.0.lock().expect("capture mutex");
            assert_eq!(events.len(), 1, "case {}", case.id);
            let (level, target, fields) = &events[0];
            assert_eq!(*level, tracing::Level::DEBUG, "case {}", case.id);
            assert_eq!(target, "trame_server::security", "case {}", case.id);

            let find_field = |name: &str| {
                fields
                    .iter()
                    .find(|(k, _)| k == name)
                    .map(|(_, v)| v.as_str())
            };
            let expected_hops = case.trusted_proxy_hops.to_string();
            assert_eq!(
                find_field("client_bucket"),
                Some(case.expected_bucket),
                "case {}",
                case.id
            );
            assert_eq!(
                find_field("trusted_proxy_hops"),
                Some(expected_hops.as_str()),
                "case {}",
                case.id
            );
            assert_eq!(
                find_field("source"),
                Some(case.expected_source),
                "case {}",
                case.id
            );
            for (_, value) in fields {
                assert!(
                    !value.contains("secret-bearer-token")
                        && !value.contains("secret-cookie-token")
                        && !value.contains("198.51.100."),
                    "case {} leaked untrusted or credential header into debug log: {value}",
                    case.id
                );
            }
        }
    }

    #[test]
    fn rotating_spoofed_xff_hits_per_ip_limit_while_second_real_ip_stays_unblocked() {
        let policy = SecurityPolicy {
            trusted_proxy_hops: 1,
            ..SecurityPolicy::default()
        };
        let limiter = &policy.rate_limiter;
        let max_per_ip = limiter.per_ip.max_attempts;

        for attempt in 1..=max_per_ip {
            let req = Request::builder()
                .uri("/api/v1/auth/login")
                .header(
                    "x-forwarded-for",
                    format!("198.51.100.{attempt}, 203.0.113.10"),
                )
                .body(Body::empty())
                .expect("valid request");
            let key = format!("ip:login:{}", policy.client_ip(&req));
            assert!(
                limiter.try_reserve(&key, limiter.per_ip).is_ok(),
                "attempt {attempt} within per_ip should pass"
            );
        }

        let blocked_req = Request::builder()
            .uri("/api/v1/auth/login")
            .header("x-forwarded-for", "198.51.100.250, 203.0.113.10")
            .body(Body::empty())
            .expect("valid request");
        let blocked_key = format!("ip:login:{}", policy.client_ip(&blocked_req));
        assert!(
            limiter.try_reserve(&blocked_key, limiter.per_ip).is_err(),
            "attempt above per_ip from first real IP must be rate-limited despite spoofed XFF"
        );

        let second_ip_req = Request::builder()
            .uri("/api/v1/auth/login")
            .header("x-forwarded-for", "198.51.100.250, 203.0.113.99")
            .body(Body::empty())
            .expect("valid request");
        let second_key = format!("ip:login:{}", policy.client_ip(&second_ip_req));
        assert!(
            limiter.try_reserve(&second_key, limiter.per_ip).is_ok(),
            "second real client IP must remain unblocked"
        );
    }
}
