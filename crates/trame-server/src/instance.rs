//! ============================================================================
//! OWNER BOOTSTRAP, INSTANCE ID & INSTANCE ADMINISTRATION (instance.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Gives a fresh TRAME instance exactly one administrator without public
//! registration (ADR-0039, D15). On boot with no `Owner`, the server mints a
//! single-use setup token and logs the setup URL once; whoever can read the
//! server logs claims the instance. The `Owner` then promotes trusted accounts
//! to `Host` (the only accounts allowed to create campaigns). Also resolves
//! the persisted instance id so asset keys survive restarts (SEC11).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `One Setup URL Per Boot`:
//!      - `prepare_owner_bootstrap` replaces any previous token, so only the
//!        URL of the latest boot works. The token is valid for
//!        `OWNER_BOOTSTRAP_TTL_SECONDS` (1 h) and only its SHA-256 is stored.
//!      - The URL is logged as one structured line whose `event` field is
//!        `owner_bootstrap_url` (`OWNER_BOOTSTRAP_LOG_EVENT`), so deployment
//!        tooling can extract it from JSON logs.
//!   2. `Locked Email`:
//!      - With `TRAME_BOOTSTRAP_OWNER_EMAIL`, a claim for any other email is
//!        refused (`403 EMAIL_LOCKED`), so a leaked log line cannot hand the
//!        instance to a stranger.
//!   3. `Claiming An Existing Account Needs Its Password`:
//!      - When the email already belongs to an account, the claim promotes it
//!        only after the password verifies; otherwise a new account is created.
//!   4. `Owner Is Immutable Through The API`:
//!      - `PUT /api/v1/instance/users/{id}/role` accepts only `HOST` and
//!        `MEMBER` and refuses to touch the `Owner` (including the caller), so
//!        the instance can never lose or gain an `Owner` here.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `main()` boot
//!     ├── 1. `resolve_instance_id(store, TRAME_INSTANCE_ID)` -> persisted id (warn on mismatch).
//!     └── 2. `prepare_owner_bootstrap(store, origin, now)` -> `log_owner_bootstrap(ticket)`.
//!   `POST /api/v1/instance/bootstrap`
//!     ├── 1. Token status (`401 INVALID_SETUP_TOKEN` / `SETUP_TOKEN_EXPIRED`), `409 OWNER_EXISTS`.
//!     ├── 2. Locked email check, then existing account (password) or new account.
//!     └── 3. `AccountStore::claim_owner` (atomic) -> session cookie -> `201 { user }`.
//! ============================================================================

use crate::auth::accounts::{
    BootstrapTokenStatus, InstanceRole, OwnerClaim, OwnerClaimError, issue_session_cookie,
    new_account, normalize_display_name, normalize_email,
};
use crate::auth::magic_link::now_epoch_seconds;
use crate::auth::password::{PasswordError, PasswordService};
use crate::auth::session::{
    AuthErrorResponse, AuthState, AuthUserDto, AuthUserEnvelope, FullAuthStore, SessionError,
    UserRecord, authenticate_user_from_headers, generate_session_token, hash_session_token,
};
use crate::security::auth_rate_limit_middleware;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post, put};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Lifetime of an owner bootstrap token: 1 hour in seconds.
pub const OWNER_BOOTSTRAP_TTL_SECONDS: u64 = 3600;

/// Stable `event` field of the log line carrying the setup URL.
pub const OWNER_BOOTSTRAP_LOG_EVENT: &str = "owner_bootstrap_url";

/// SPA route that receives the setup token as `?token=`.
pub const OWNER_SETUP_PATH: &str = "/setup";

/// Freshly minted owner bootstrap token (raw value exists only here and in the log line).
#[derive(Debug, Clone)]
pub struct OwnerBootstrapTicket {
    /// Raw 64-hex-character token.
    pub token: String,
    /// `{TRAME_PUBLIC_ORIGIN}/setup?token={token}` (relative when no origin is configured).
    pub setup_url: String,
    /// Expiry (epoch seconds), `now + OWNER_BOOTSTRAP_TTL_SECONDS`.
    pub expires_at: u64,
}

/// Mints a new owner bootstrap token when no `Owner` exists; `None` once the instance is claimed.
pub async fn prepare_owner_bootstrap(
    store: &dyn FullAuthStore,
    public_origin: Option<&str>,
    now: u64,
) -> Result<Option<OwnerBootstrapTicket>, SessionError> {
    if store.owner_exists().await? {
        return Ok(None);
    }
    let token = generate_session_token();
    let expires_at = now + OWNER_BOOTSTRAP_TTL_SECONDS;
    store
        .replace_owner_bootstrap_token(&hash_session_token(&token), expires_at)
        .await?;
    let origin = public_origin.unwrap_or("");
    Ok(Some(OwnerBootstrapTicket {
        setup_url: format!("{origin}{OWNER_SETUP_PATH}?token={token}"),
        token,
        expires_at,
    }))
}

/// Logs the setup URL once, as one structured line with `event = "owner_bootstrap_url"`.
pub fn log_owner_bootstrap(ticket: &OwnerBootstrapTicket) {
    tracing::warn!(
        event = OWNER_BOOTSTRAP_LOG_EVENT,
        setup_url = %ticket.setup_url,
        expires_at = ticket.expires_at,
        "instance has no Owner: open the setup URL within 1 hour to claim it"
    );
}

/// Returns the instance id: `override_id` (`TRAME_INSTANCE_ID`) when set, else the persisted
/// id (stored on first boot). An override differing from the persisted id is logged.
pub async fn resolve_instance_id(
    store: &dyn FullAuthStore,
    override_id: Option<Uuid>,
) -> Result<Uuid, SessionError> {
    let persisted = store
        .load_or_init_instance_id(override_id.unwrap_or_else(Uuid::new_v4))
        .await?;
    match override_id {
        Some(id) if id != persisted => {
            tracing::warn!(
                %persisted,
                override_id = %id,
                "TRAME_INSTANCE_ID differs from the persisted instance id; using the override"
            );
            Ok(id)
        }
        _ => Ok(persisted),
    }
}

/// Body of `POST /api/v1/instance/bootstrap`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OwnerBootstrapRequest {
    /// Raw setup token from the logged URL.
    pub token: String,
    /// Owner email (must equal `TRAME_BOOTSTRAP_OWNER_EMAIL` when set).
    pub email: String,
    /// Password: verified for an existing account, hashed for a new one.
    pub password: String,
    /// Display name for a new account (2..=100 characters); ignored for an existing account.
    #[serde(default)]
    pub display_name: String,
}

/// Body of `POST /api/v1/instance/bootstrap/status`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BootstrapStatusRequest {
    /// Raw setup token.
    pub token: String,
}

/// Response of `POST /api/v1/instance/bootstrap/status`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BootstrapStatusResponse {
    /// `"valid"`, `"expired"`, or `"invalid"` (unknown, used, or replaced).
    pub status: String,
    /// `TRAME_BOOTSTRAP_OWNER_EMAIL` when the token is valid and an email is locked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_email: Option<String>,
}

/// Public response of `GET /api/v1/instance`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InstanceInfoResponse {
    /// `POST /api/v1/auth/register` is accepted (only `TRAME_ENV=dev`).
    pub registration_open: bool,
    /// An `Owner` has claimed the instance.
    pub owner_claimed: bool,
}

/// One account in the Owner-only user list.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InstanceUserDto {
    /// Account id.
    pub id: Uuid,
    /// Account email.
    pub email: String,
    /// Display name.
    pub display_name: String,
    /// Instance-wide role.
    pub instance_role: InstanceRole,
    /// Legacy guest account (no credentials bound yet).
    pub is_guest: bool,
    /// TOTP enabled on the account.
    pub totp_enabled: bool,
    /// Creation time (epoch seconds).
    pub created_at: u64,
}

impl From<UserRecord> for InstanceUserDto {
    fn from(user: UserRecord) -> Self {
        let dto = AuthUserDto::from(user.clone());
        Self {
            id: dto.id,
            email: dto.email,
            display_name: dto.display_name,
            instance_role: dto.instance_role,
            is_guest: dto.is_guest,
            totp_enabled: dto.totp_enabled,
            created_at: user.created_at,
        }
    }
}

/// Body of `PUT /api/v1/instance/users/{user_id}/role`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SetInstanceRoleRequest {
    /// Target role: `"HOST"` or `"MEMBER"` (anything else is `400 INVALID_INSTANCE_ROLE`).
    pub instance_role: String,
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(AuthErrorResponse {
            code: Some(code.to_string()),
            error: message.to_string(),
        }),
    )
        .into_response()
}

fn storage_error(err: impl std::fmt::Display) -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "STORAGE_ERROR",
        &err.to_string(),
    )
}

/// `GET /api/v1/instance` (public): registration mode and whether an `Owner` exists.
pub async fn instance_info_handler(State(state): State<AuthState>) -> Response {
    match state.session_store.owner_exists().await {
        Ok(owner_claimed) => Json(InstanceInfoResponse {
            registration_open: state.security.registration_open,
            owner_claimed,
        })
        .into_response(),
        Err(err) => storage_error(err),
    }
}

/// `POST /api/v1/instance/bootstrap/status`: lets the setup page validate its token.
pub async fn bootstrap_status_handler(
    State(state): State<AuthState>,
    Json(req): Json<BootstrapStatusRequest>,
) -> Response {
    let status = match state
        .session_store
        .owner_bootstrap_token_status(&hash_session_token(req.token.trim()), now_epoch_seconds())
        .await
    {
        Ok(s) => s,
        Err(err) => return storage_error(err),
    };
    let (label, locked_email) = match status {
        BootstrapTokenStatus::Valid => ("valid", state.security.bootstrap_owner_email.clone()),
        BootstrapTokenStatus::Expired => ("expired", None),
        BootstrapTokenStatus::Invalid => ("invalid", None),
    };
    Json(BootstrapStatusResponse {
        status: label.to_string(),
        locked_email,
    })
    .into_response()
}

/// `POST /api/v1/instance/bootstrap`: claims the instance (see the module lifecycle).
pub async fn owner_bootstrap_handler(
    State(state): State<AuthState>,
    Json(req): Json<OwnerBootstrapRequest>,
) -> Response {
    let token_hash = hash_session_token(req.token.trim());
    let now = now_epoch_seconds();
    match state
        .session_store
        .owner_bootstrap_token_status(&token_hash, now)
        .await
    {
        Ok(BootstrapTokenStatus::Valid) => {}
        Ok(BootstrapTokenStatus::Expired) => {
            return error(
                StatusCode::UNAUTHORIZED,
                "SETUP_TOKEN_EXPIRED",
                "setup token has expired; restart the server to get a new setup URL",
            );
        }
        Ok(BootstrapTokenStatus::Invalid) => {
            return error(
                StatusCode::UNAUTHORIZED,
                "INVALID_SETUP_TOKEN",
                "setup token is invalid or already used",
            );
        }
        Err(err) => return storage_error(err),
    }

    let Some(email) = normalize_email(&req.email) else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_EMAIL",
            "valid email address is required",
        );
    };
    if let Some(locked) = &state.security.bootstrap_owner_email
        && *locked != email
    {
        return error(
            StatusCode::FORBIDDEN,
            "EMAIL_LOCKED",
            "this instance can only be claimed by the configured owner email",
        );
    }

    let passwords = PasswordService::new();
    let claim = match state.session_store.get_user_by_email(&email).await {
        Ok(Some(existing)) => {
            let verified = existing
                .password_hash
                .as_deref()
                .is_some_and(|hash| passwords.verify_password(&req.password, hash));
            if !verified {
                return error(
                    StatusCode::UNAUTHORIZED,
                    "INVALID_CREDENTIALS",
                    "email already registered: enter that account's password to claim it",
                );
            }
            OwnerClaim::ExistingUser(existing.id)
        }
        Ok(None) => {
            let Some(display_name) = normalize_display_name(&req.display_name) else {
                return error(
                    StatusCode::BAD_REQUEST,
                    "INVALID_DISPLAY_NAME",
                    "display_name must be between 2 and 100 characters",
                );
            };
            let password_hash = match passwords.hash_password(&req.password) {
                Ok(h) => h,
                Err(PasswordError::WeakPassword(msg)) => {
                    return error(StatusCode::BAD_REQUEST, "WEAK_PASSWORD", &msg);
                }
                Err(err) => {
                    return error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "HASHING_ERROR",
                        &err.to_string(),
                    );
                }
            };
            OwnerClaim::NewAccount(new_account(
                email,
                display_name,
                password_hash,
                InstanceRole::Owner,
            ))
        }
        Err(err) => return storage_error(err),
    };

    let owner = match state
        .session_store
        .claim_owner(&token_hash, claim, now)
        .await
    {
        Ok(owner) => owner,
        Err(OwnerClaimError::InvalidToken) => {
            return error(
                StatusCode::UNAUTHORIZED,
                "INVALID_SETUP_TOKEN",
                "setup token is invalid or already used",
            );
        }
        Err(OwnerClaimError::OwnerExists) => {
            return error(
                StatusCode::CONFLICT,
                "OWNER_EXISTS",
                "instance already has an owner",
            );
        }
        Err(OwnerClaimError::EmailTaken) => {
            return error(
                StatusCode::CONFLICT,
                "EMAIL_ALREADY_EXISTS",
                "email already registered",
            );
        }
        Err(err) => return storage_error(err),
    };
    tracing::info!(owner_id = %owner.id, "instance claimed by its Owner");

    match issue_session_cookie(&state, owner.id).await {
        Ok(headers) => (
            StatusCode::CREATED,
            headers,
            Json(AuthUserEnvelope {
                user: AuthUserDto::from(owner),
            }),
        )
            .into_response(),
        Err(err) => storage_error(err),
    }
}

/// Authenticates the caller and requires `InstanceRole::Owner`.
async fn require_owner(
    state: &AuthState,
    headers: &HeaderMap,
) -> Result<UserRecord, Box<Response>> {
    let user = authenticate_user_from_headers(state, headers)
        .await
        .map_err(|(status, err)| Box::new((status, Json(err)).into_response()))?;
    if user.instance_role != InstanceRole::Owner {
        return Err(Box::new(error(
            StatusCode::FORBIDDEN,
            "OWNER_REQUIRED",
            "only the instance Owner may administer accounts",
        )));
    }
    Ok(user)
}

/// `GET /api/v1/instance/users` (Owner only) -> `{ users: [InstanceUserDto] }`, oldest first.
pub async fn list_users_handler(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_owner(&state, &headers).await {
        return *resp;
    }
    match state.session_store.list_users().await {
        Ok(users) => Json(serde_json::json!({
            "users": users.into_iter().map(InstanceUserDto::from).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(err) => storage_error(err),
    }
}

/// `PUT /api/v1/instance/users/{user_id}/role` (Owner only) -> `{ user: InstanceUserDto }`.
pub async fn set_instance_role_handler(
    State(state): State<AuthState>,
    Path(user_id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<SetInstanceRoleRequest>,
) -> Response {
    let owner = match require_owner(&state, &headers).await {
        Ok(owner) => owner,
        Err(resp) => return *resp,
    };
    let role = match InstanceRole::parse(&req.instance_role) {
        Some(role @ (InstanceRole::Host | InstanceRole::Member)) => role,
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "INVALID_INSTANCE_ROLE",
                "instance_role must be HOST or MEMBER",
            );
        }
    };
    if user_id == owner.id {
        return error(
            StatusCode::CONFLICT,
            "CANNOT_CHANGE_OWNER",
            "the Owner's instance role cannot be changed",
        );
    }
    match state.session_store.get_user_by_id(user_id).await {
        Ok(Some(target)) if target.instance_role == InstanceRole::Owner => {
            return error(
                StatusCode::CONFLICT,
                "CANNOT_CHANGE_OWNER",
                "the Owner's instance role cannot be changed",
            );
        }
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "USER_NOT_FOUND", "user not found"),
        Err(err) => return storage_error(err),
    }
    match state.session_store.set_instance_role(user_id, role).await {
        Ok(Some(user)) => {
            tracing::info!(%user_id, role = role.as_str(), "instance role changed by the Owner");
            Json(serde_json::json!({ "user": InstanceUserDto::from(user) })).into_response()
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "USER_NOT_FOUND", "user not found"),
        Err(err) => storage_error(err),
    }
}

/// Instance routes: public info, rate-limited bootstrap, Owner-only account administration.
pub fn instance_router(state: AuthState) -> Router {
    let rate_limited = Router::new()
        .route("/api/v1/instance/bootstrap", post(owner_bootstrap_handler))
        .route(
            "/api/v1/instance/bootstrap/status",
            post(bootstrap_status_handler),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_rate_limit_middleware,
        ));
    Router::new()
        .route("/api/v1/instance", get(instance_info_handler))
        .route("/api/v1/instance/users", get(list_users_handler))
        .route(
            "/api/v1/instance/users/{user_id}/role",
            put(set_instance_role_handler),
        )
        .merge(rate_limited)
        .with_state(state)
}
