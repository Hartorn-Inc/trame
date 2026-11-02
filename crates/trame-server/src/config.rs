//! ============================================================================
//! FAIL-CLOSED SERVER CONFIGURATION & SECRET LOADING (config.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Resolves every secret and transport-security setting the server needs from
//! the environment exactly once, at boot. Before this module, each subsystem
//! (TOTP, asset presigning, invite JWTs) silently fell back to a hard-coded key
//! when its variable was missing, so a misconfigured production deployment
//! would run with publicly known keys: forgeable invite links, forgeable
//! presigned URLs, and decryptable TOTP secrets.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Fail-Closed Secrets (G7)`:
//!      - Outside `TRAME_ENV=dev`, `ServerConfig::from_lookup` returns
//!        `ConfigError` listing every missing or invalid variable; `main`
//!        refuses to start. No key is ever generated or defaulted.
//!      - `TRAME_ENV=dev` substitutes the public `DEV_*` constants below for
//!        missing values only. Provided values are still validated.
//!   2. `Key Strength`:
//!      - `MASTER_ENCRYPTION_KEY` must be exactly 64 hex characters (AES-256).
//!      - HMAC secrets (`TRAME_JWT_SECRET`, `TRAME_INVITE_JWT_SECRET`) must be at
//!        least `MIN_SECRET_BYTES` (32) bytes. The invite (session bootstrap) key
//!        falls back to `TRAME_SESSION_SECRET`, then the legacy `JWT_SECRET`.
//!   3. `Transport Defaults`:
//!      - Session cookies carry `Secure` unless `TRAME_COOKIE_SECURE` is
//!        explicitly `false`/`0`/`no`/`off` (plain-HTTP LAN tables).
//!      - WebSocket `Origin` allow-list = `TRAME_PUBLIC_ORIGIN` plus the
//!        comma-separated `TRAME_ALLOWED_ORIGINS`; `TRAME_PUBLIC_ORIGIN` is
//!        required outside dev.
//!   4. `Log Format Follows TRAME_ENV`:
//!      - `TRAME_ENV=dev` logs pretty ANSI lines; every other value (including
//!        unset) logs JSON without ANSI escapes, so production log collectors
//!        receive one structured object per line. No separate variable exists.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `ServerConfig::from_env()`
//!     ├── 1. Read `TRAME_ENV` (`dev` enables documented fallbacks).
//!     ├── 2. Resolve each secret (primary name, then legacy alias).
//!     ├── 3. Validate formats; collect missing / invalid names.
//!     └── 4. Return `ServerConfig` or `ConfigError { missing, invalid }`.
//! ============================================================================

use crate::security::{AuthRateLimiter, SecurityPolicy};
use std::sync::Arc;

/// Selects development fallbacks (`dev`) versus fail-closed production behavior.
pub const TRAME_ENV_VAR: &str = "TRAME_ENV";
/// 64-hex-character AES-256-GCM key encrypting TOTP secrets at rest.
pub const MASTER_ENCRYPTION_KEY_VAR: &str = "MASTER_ENCRYPTION_KEY";
/// HMAC-SHA256 key signing presigned asset URLs (legacy alias: `JWT_SECRET`).
pub const JWT_SECRET_VAR: &str = "TRAME_JWT_SECRET";
/// HMAC-SHA256 key signing Magic Link invite JWTs (legacy alias: `JWT_SECRET`).
pub const INVITE_JWT_SECRET_VAR: &str = "TRAME_INVITE_JWT_SECRET";
/// Legacy shared alias accepted for both HMAC secrets.
pub const LEGACY_JWT_SECRET_VAR: &str = "JWT_SECRET";
/// Session bootstrap key: signs Magic Link invite JWTs when `TRAME_INVITE_JWT_SECRET` is unset.
pub const SESSION_SECRET_VAR: &str = "TRAME_SESSION_SECRET";
/// Public browser origin of the web client (e.g. `https://table.example.com`).
pub const PUBLIC_ORIGIN_VAR: &str = "TRAME_PUBLIC_ORIGIN";
/// Directory of the built web client served by the SPA fallback.
pub const STATIC_DIR_VAR: &str = "TRAME_STATIC_DIR";
/// Optional comma-separated extra allowed WebSocket origins.
pub const ALLOWED_ORIGINS_VAR: &str = "TRAME_ALLOWED_ORIGINS";
/// `Secure` cookie attribute toggle (default `true`).
pub const COOKIE_SECURE_VAR: &str = "TRAME_COOKIE_SECURE";
/// When `true`, rate limiting keys on the right-most `X-Forwarded-For` hop
/// (set only behind a trusted reverse proxy such as Cloud Run).
pub const TRUST_FORWARDED_FOR_VAR: &str = "TRAME_TRUST_FORWARDED_FOR";

/// Minimum HMAC secret length in bytes (256 bits).
pub const MIN_SECRET_BYTES: usize = 32;

/// Public development-only AES-256 key (64 hex chars). Never valid outside `TRAME_ENV=dev`.
pub const DEV_MASTER_ENCRYPTION_KEY_HEX: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
/// Public development-only HMAC secret (>= 32 bytes). Never valid outside `TRAME_ENV=dev`.
pub const DEV_HMAC_SECRET: &[u8] = b"trame-dev-only-hmac-sha256-secret-key-0001";
/// Development browser origins of the Vite web client.
pub const DEV_ALLOWED_ORIGINS: [&str; 4] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
];

/// Runtime environment selected by `TRAME_ENV`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEnv {
    /// `TRAME_ENV=dev`: missing secrets fall back to the public `DEV_*` constants.
    Dev,
    /// Any other value (or unset): missing secrets abort startup.
    Production,
}

/// Log line format selected by the runtime environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    /// Human-readable, ANSI-coloured lines for local development.
    Pretty,
    /// One JSON object per line, no ANSI escapes, for log collectors.
    Json,
}

impl RuntimeEnv {
    /// `dev` (case-insensitive, surrounding whitespace ignored) is `Dev`; any other value,
    /// empty or unset, is `Production`.
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some(v) if v.eq_ignore_ascii_case("dev") => RuntimeEnv::Dev,
            _ => RuntimeEnv::Production,
        }
    }

    /// Pretty logs in `Dev`, JSON logs everywhere else.
    pub fn log_format(self) -> LogFormat {
        match self {
            RuntimeEnv::Dev => LogFormat::Pretty,
            RuntimeEnv::Production => LogFormat::Json,
        }
    }
}

/// Validated cryptographic material shared by the auth, TOTP, and asset subsystems.
#[derive(Clone)]
pub struct ServerSecrets {
    /// AES-256-GCM key (32 bytes) encrypting TOTP secrets at rest.
    pub master_encryption_key: [u8; 32],
    /// HMAC-SHA256 key (>= 32 bytes) signing presigned asset URLs.
    pub asset_signing_secret: Vec<u8>,
    /// HMAC-SHA256 key (>= 32 bytes) signing Magic Link invite JWTs.
    pub invite_jwt_secret: Vec<u8>,
}

impl ServerSecrets {
    /// Public development secrets; used by `TRAME_ENV=dev` fallbacks and test routers.
    pub fn dev() -> Self {
        Self {
            master_encryption_key: parse_master_key(DEV_MASTER_ENCRYPTION_KEY_HEX)
                .unwrap_or([0u8; 32]),
            asset_signing_secret: DEV_HMAC_SECRET.to_vec(),
            invite_jwt_secret: DEV_HMAC_SECRET.to_vec(),
        }
    }
}

/// Fully resolved server configuration.
#[derive(Clone)]
pub struct ServerConfig {
    /// Environment the configuration was resolved for.
    pub env: RuntimeEnv,
    /// Validated secrets.
    pub secrets: ServerSecrets,
    /// Transport security policy (cookies, origins, WebSocket limits, rate limits).
    pub security: Arc<SecurityPolicy>,
    /// Normalized `TRAME_PUBLIC_ORIGIN` used to build absolute invite URLs (`None` = relative).
    pub public_origin: Option<String>,
    /// `TRAME_STATIC_DIR`: directory of the built SPA served as fallback (`None` = no static).
    pub static_dir: Option<std::path::PathBuf>,
}

/// Startup configuration failure listing every offending variable at once.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("refusing to start: missing [{}], invalid [{}] (set TRAME_ENV=dev for local development)", missing.join(", "), invalid.join(", "))]
pub struct ConfigError {
    /// Required variables that are unset or empty.
    pub missing: Vec<String>,
    /// Variables that are set but malformed or too weak (with a reason).
    pub invalid: Vec<String>,
}

impl ServerConfig {
    /// Development configuration with public secrets; used by test routers.
    pub fn dev() -> Self {
        Self {
            env: RuntimeEnv::Dev,
            secrets: ServerSecrets::dev(),
            security: Arc::new(SecurityPolicy::default()),
            public_origin: None,
            static_dir: None,
        }
    }

    /// Resolves configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Resolves configuration from an arbitrary variable lookup (empty values count as unset).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |key: &str| lookup(key).filter(|v| !v.trim().is_empty());
        let env = RuntimeEnv::from_value(get(TRAME_ENV_VAR).as_deref());
        let dev = env == RuntimeEnv::Dev;
        let mut missing = Vec::new();
        let mut invalid = Vec::new();

        let master_encryption_key = match get(MASTER_ENCRYPTION_KEY_VAR) {
            Some(hex) => parse_master_key(&hex).unwrap_or_else(|| {
                invalid.push(format!(
                    "{MASTER_ENCRYPTION_KEY_VAR} (expected 64 hex characters)"
                ));
                [0u8; 32]
            }),
            None if dev => ServerSecrets::dev().master_encryption_key,
            None => {
                missing.push(MASTER_ENCRYPTION_KEY_VAR.to_string());
                [0u8; 32]
            }
        };

        let mut hmac_secret = |primary: &str, alias: Option<&str>| -> Vec<u8> {
            let value = get(primary)
                .or_else(|| alias.and_then(get))
                .or_else(|| get(LEGACY_JWT_SECRET_VAR));
            match value {
                Some(secret) if secret.len() >= MIN_SECRET_BYTES => secret.into_bytes(),
                Some(_) => {
                    invalid.push(format!(
                        "{primary} (must be at least {MIN_SECRET_BYTES} bytes)"
                    ));
                    Vec::new()
                }
                None if dev => DEV_HMAC_SECRET.to_vec(),
                None => {
                    missing.push(primary.to_string());
                    Vec::new()
                }
            }
        };
        let asset_signing_secret = hmac_secret(JWT_SECRET_VAR, None);
        let invite_jwt_secret = hmac_secret(INVITE_JWT_SECRET_VAR, Some(SESSION_SECRET_VAR));

        let mut allowed_origins: Vec<String> = Vec::new();
        let public_origin = get(PUBLIC_ORIGIN_VAR).map(|o| normalize_origin(&o));
        match &public_origin {
            Some(origin) => allowed_origins.push(origin.clone()),
            None if dev => allowed_origins.extend(DEV_ALLOWED_ORIGINS.map(normalize_origin)),
            None => missing.push(PUBLIC_ORIGIN_VAR.to_string()),
        }
        if let Some(extra) = get(ALLOWED_ORIGINS_VAR) {
            allowed_origins.extend(
                extra
                    .split(',')
                    .map(str::trim)
                    .filter(|o| !o.is_empty())
                    .map(normalize_origin),
            );
        }

        let cookie_secure = !get(COOKIE_SECURE_VAR).is_some_and(|v| is_falsy(&v));
        let trust_forwarded_for = get(TRUST_FORWARDED_FOR_VAR).is_some_and(|v| !is_falsy(&v));

        if !missing.is_empty() || !invalid.is_empty() {
            return Err(ConfigError { missing, invalid });
        }

        Ok(Self {
            env,
            secrets: ServerSecrets {
                master_encryption_key,
                asset_signing_secret,
                invite_jwt_secret,
            },
            security: Arc::new(SecurityPolicy {
                cookie_secure,
                allowed_origins,
                trust_forwarded_for,
                rate_limiter: AuthRateLimiter::default(),
                public_origin: public_origin.clone(),
                ..SecurityPolicy::default()
            }),
            public_origin,
            static_dir: get(STATIC_DIR_VAR).map(|d| std::path::PathBuf::from(d.trim())),
        })
    }
}

/// Parses a 64-character hex string into a 32-byte AES-256 key.
pub fn parse_master_key(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(key)
}

/// Lowercases an origin and strips a trailing `/` so header comparison is exact.
pub fn normalize_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn is_falsy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "false" | "0" | "no" | "off"
    )
}
