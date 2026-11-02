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
//!   1. `Dual-Key Fixed-Window Rate Limits`:
//!      - Every request to `/auth/login`, `/auth/register`, `/auth/totp/*`, and
//!        `/auth/magic-link*` consumes one attempt from the client IP bucket
//!        (`per_ip`, default 30 per 60 s) and one from the account bucket
//!        (`per_account`, default 10 per 60 s). The account key is the JSON
//!        `email`, else the session token digest, else the invite token digest.
//!      - Exceeding either bucket returns `429 Too Many Requests` with
//!        `Retry-After` before the handler (and Argon2 / TOTP work) runs.
//!      - The bucket map is pruned of expired windows once it exceeds
//!        `MAX_TRACKED_KEYS`, bounding memory under key-spraying.
//!   2. `Client IP Resolution`:
//!      - Uses the socket peer address (`ConnectInfo`) unless
//!        `trust_forwarded_for` is set, in which case the right-most
//!        `X-Forwarded-For` hop (the one appended by the trusted proxy) is used.
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
use axum::http::header::{HeaderName, HeaderValue, RETRY_AFTER};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use std::collections::HashMap;
use std::net::SocketAddr;
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

/// In-memory dual-key (IP + account) fixed-window rate limiter for credential endpoints.
#[derive(Debug)]
pub struct AuthRateLimiter {
    /// Allowance per client IP across all rate-limited auth routes.
    pub per_ip: RateLimit,
    /// Allowance per account key (email, session, or invite token).
    pub per_account: RateLimit,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
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
    /// Creates a limiter with explicit IP and account allowances.
    pub fn new(per_ip: RateLimit, per_account: RateLimit) -> Self {
        Self {
            per_ip,
            per_account,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Consumes one attempt from `key`; returns the remaining wait when the window is exhausted.
    pub fn check(&self, key: &str, limit: RateLimit) -> Result<(), Duration> {
        let now = Instant::now();
        let Ok(mut buckets) = self.buckets.lock() else {
            return Ok(());
        };
        if buckets.len() > MAX_TRACKED_KEYS {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < limit.window);
        }
        let entry = buckets.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= limit.window {
            *entry = (now, 0);
        }
        if entry.1 >= limit.max_attempts {
            return Err(limit.window.saturating_sub(now.duration_since(entry.0)));
        }
        entry.1 += 1;
        Ok(())
    }
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
    /// Key rate limits on the right-most `X-Forwarded-For` hop instead of the peer address.
    pub trust_forwarded_for: bool,
    /// Credential endpoint rate limiter.
    pub rate_limiter: AuthRateLimiter,
    /// Normalized `TRAME_PUBLIC_ORIGIN` prefixed to invite URLs; `None` yields relative URLs.
    pub public_origin: Option<String>,
}

impl Default for SecurityPolicy {
    /// Development policy: secure cookies, Vite dev origins, 1 MiB frames, default limits.
    fn default() -> Self {
        Self {
            cookie_secure: true,
            allowed_origins: DEV_ALLOWED_ORIGINS.map(normalize_origin).to_vec(),
            ws_max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
            trust_forwarded_for: false,
            rate_limiter: AuthRateLimiter::default(),
            public_origin: None,
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

    fn client_ip(&self, request: &Request) -> String {
        if self.trust_forwarded_for
            && let Some(hop) = request
                .headers()
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit(',').next())
                .map(str::trim)
                .filter(|v| !v.is_empty())
        {
            return hop.to_string();
        }
        request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0.ip().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }
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

fn too_many_requests(retry_after: Duration) -> Response {
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

/// Axum middleware enforcing per-IP then per-account limits on credential routes.
pub async fn auth_rate_limit_middleware(
    State(state): State<AuthState>,
    request: Request,
    next: Next,
) -> Response {
    let policy = state.security.clone();
    let limiter = &policy.rate_limiter;
    let ip = policy.client_ip(&request);
    if let Err(wait) = limiter.check(&format!("ip:{ip}"), limiter.per_ip) {
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
    if let Some(key) = account_key(&parts.headers, &bytes)
        && let Err(wait) = limiter.check(&format!("acct:{key}"), limiter.per_account)
    {
        return too_many_requests(wait);
    }

    next.run(Request::from_parts(parts, Body::from(bytes)))
        .await
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
