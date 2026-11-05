//! ============================================================================
//! CAMPAIGN ACCESS: INVITES, INVITE REDEMPTION & MEMBER REMOVAL (access.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! The only ways into and out of a campaign besides creating it (ADR-0039):
//! - A Game Master mints one bounded `CampaignInvite` link per campaign,
//!   reads it, revokes it, and lists who redeemed it (SEC7, D3).
//! - `InviteRedemption` turns the link into a `PLAYER` membership: a visitor
//!   creates a `Member` account in the same transaction; a logged-in account
//!   only gains the membership (D2). Pure guest sessions are never created.
//! - A Game Master removes a member, which also closes that member's live
//!   table sockets (SEC13).
//! - `require_campaign_creator` gates campaign creation and import on
//!   `InstanceRole::Host` / `Owner` (SEC10).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `GM Gate Through resolve_campaign_role`:
//!      - Every GM route resolves the caller's role from the membership store;
//!        non-members and non-GMs get `403 GM_REQUIRED`.
//!   2. `Bounded Links`:
//!      - `ttl_seconds` is clamped to `1..=MAX_INVITE_TTL_SECONDS` (7 days) and
//!        `max_uses` must be `1..=MAX_INVITE_MAX_USES`; minting revokes the
//!        previous link. The raw token is returned once, at creation; storage
//!        keeps only its SHA-256, so `GET .../invites/active` cannot show it.
//!   3. `Atomic Redemption`:
//!      - `AccountStore::redeem_campaign_invite` re-checks revocation, expiry,
//!        and remaining uses in the same critical section that writes the
//!        account, membership, and redemption.
//!   4. `Removal Disconnects`:
//!      - The membership row is deleted before the room evicts the user, so a
//!        reconnect attempt already fails the WebSocket membership check.
//!      - GM memberships cannot be removed here (`409 CANNOT_REMOVE_GM`), so a
//!        campaign never loses its Game Master through this route.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `POST /api/v1/invites/redeem`
//!     ├── 1. Credentials present? -> `InviteRedeemer::ExistingUser` (membership only).
//!     ├── 2. Otherwise validate email, display name, password -> `NewAccount` (`Member`).
//!     ├── 3. `redeem_campaign_invite` (atomic) -> map errors to `404` / `410` / `409`.
//!     └── 4. New account -> session cookie + `201`; existing account -> `200`.
//! ============================================================================

use crate::auth::accounts::{
    CampaignInviteRecord, DEFAULT_INVITE_MAX_USES, DEFAULT_INVITE_TTL_SECONDS, InstanceRole,
    InviteRedeemError, InviteRedeemer, InviteStatus, MAX_INVITE_MAX_USES, MAX_INVITE_TTL_SECONDS,
    issue_session_cookie, new_account, normalize_display_name, normalize_email,
};
use crate::auth::magic_link::now_epoch_seconds;
use crate::auth::password::{PasswordError, PasswordService};
use crate::auth::session::{
    AuthUserDto, authenticate_user_from_headers, generate_session_token, hash_session_token,
};
use crate::http::{AppState, error_response, resolve_authenticated_user, resolve_campaign_role};
use crate::security::auth_rate_limit_middleware;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use trame_engine::commands::CampaignRole;
use uuid::Uuid;

/// Body of `POST /api/v1/campaigns/{campaign_id}/invites` (empty body = defaults).
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct CreateInviteRequest {
    /// Lifetime in seconds; default and maximum `MAX_INVITE_TTL_SECONDS` (7 days), minimum 1.
    pub ttl_seconds: Option<u64>,
    /// Redemptions allowed; default `DEFAULT_INVITE_MAX_USES` (8), `1..=MAX_INVITE_MAX_USES`.
    pub max_uses: Option<u32>,
}

/// `CampaignInvite` as returned to the Game Master.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CampaignInviteDto {
    /// Invite id.
    pub id: Uuid,
    /// Campaign the invite joins.
    pub campaign_id: Uuid,
    /// `{TRAME_PUBLIC_ORIGIN}/?invite={token}`; only present in the creation response.
    pub invite_url: Option<String>,
    /// Raw token; only present in the creation response.
    pub token: Option<String>,
    /// Creation time (epoch seconds).
    pub created_at: u64,
    /// Expiry (epoch seconds).
    pub expires_at: u64,
    /// Redemptions allowed.
    pub max_uses: u32,
    /// Redemptions consumed.
    pub use_count: u32,
    /// Revocation time (epoch seconds), if revoked.
    pub revoked_at: Option<u64>,
    /// Status now: `active`, `revoked`, `expired`, or `exhausted`.
    pub status: InviteStatus,
}

impl CampaignInviteDto {
    fn new(invite: CampaignInviteRecord, raw: Option<(String, String)>, now: u64) -> Self {
        let status = invite.status(now);
        let (invite_url, token) = raw.unzip();
        Self {
            id: invite.id,
            campaign_id: invite.campaign_id,
            invite_url,
            token,
            created_at: invite.created_at,
            expires_at: invite.expires_at,
            max_uses: invite.max_uses,
            use_count: invite.use_count,
            revoked_at: invite.revoked_at,
            status,
        }
    }
}

/// Body of `POST /api/v1/invites/preview`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InvitePreviewRequest {
    /// Raw invite token from the URL.
    pub token: String,
}

/// Body of `POST /api/v1/invites/redeem`. Credentials are required only without a session.
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct RedeemInviteRequest {
    /// Raw invite token from the URL.
    pub token: String,
    /// New account email (unauthenticated redemption).
    #[serde(default)]
    pub email: Option<String>,
    /// New account password (unauthenticated redemption).
    #[serde(default)]
    pub password: Option<String>,
    /// New account display name, 2..=100 characters (unauthenticated redemption).
    #[serde(default)]
    pub display_name: Option<String>,
}

/// Response of `POST /api/v1/invites/redeem`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RedeemInviteResponse {
    /// Campaign joined.
    pub campaign_id: Uuid,
    /// Campaign role held after redemption (`PLAYER`, or the existing role).
    pub role: String,
    /// `true` when the account was already a member (no use consumed).
    pub already_member: bool,
    /// `true` when this redemption created the account (a session cookie is set).
    pub account_created: bool,
    /// The account holding the membership.
    pub user: AuthUserDto,
}

fn storage_error(err: impl std::fmt::Display) -> Response {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "STORAGE_ERROR",
        &err.to_string(),
    )
}

/// `Ok(())` when `user_id` may create campaigns (`InstanceRole::Host` or `Owner`); otherwise
/// `403 HOST_REQUIRED`.
pub async fn require_campaign_creator(
    state: &AppState,
    user_id: Uuid,
) -> Result<(), Box<Response>> {
    match state.auth_state.session_store.get_user_by_id(user_id).await {
        Ok(Some(user)) if user.instance_role.can_create_campaigns() => Ok(()),
        Ok(_) => Err(Box::new(error_response(
            StatusCode::FORBIDDEN,
            "HOST_REQUIRED",
            "only Host or Owner accounts can create campaigns",
        ))),
        Err(err) => Err(Box::new(storage_error(err))),
    }
}

/// Authenticates the caller and requires the `GM` role in `campaign_id`.
async fn require_gm(
    state: &AppState,
    headers: &HeaderMap,
    campaign_id: Uuid,
) -> Result<Uuid, Box<Response>> {
    let user_id = resolve_authenticated_user(state, headers)
        .await
        .map_err(|_| {
            Box::new(error_response(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "valid authentication credentials required",
            ))
        })?;
    match resolve_campaign_role(state, campaign_id, user_id).await {
        Some(CampaignRole::Gm) => Ok(user_id),
        _ => Err(Box::new(error_response(
            StatusCode::FORBIDDEN,
            "GM_REQUIRED",
            "only the campaign Game Master may manage access",
        ))),
    }
}

/// `POST /api/v1/campaigns/{campaign_id}/invites` (GM) -> `201 { invite }` with URL and token.
pub async fn create_invite_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let created_by = match require_gm(&state, &headers, campaign_id).await {
        Ok(id) => id,
        Err(resp) => return *resp,
    };
    let req: CreateInviteRequest = if body.is_empty() {
        CreateInviteRequest::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(req) => req,
            Err(err) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "INVALID_PAYLOAD",
                    &err.to_string(),
                );
            }
        }
    };
    let max_uses = req.max_uses.unwrap_or(DEFAULT_INVITE_MAX_USES);
    if !(1..=MAX_INVITE_MAX_USES).contains(&max_uses) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_MAX_USES",
            &format!("max_uses must be 1..={MAX_INVITE_MAX_USES}"),
        );
    }
    let ttl = req
        .ttl_seconds
        .unwrap_or(DEFAULT_INVITE_TTL_SECONDS)
        .clamp(1, MAX_INVITE_TTL_SECONDS);
    let now = now_epoch_seconds();
    let token = generate_session_token();
    let invite = CampaignInviteRecord {
        id: Uuid::new_v4(),
        campaign_id,
        token_hash: hash_session_token(&token),
        created_by,
        created_at: now,
        expires_at: now + ttl,
        max_uses,
        use_count: 0,
        revoked_at: None,
    };
    match state
        .auth_state
        .session_store
        .create_campaign_invite(invite)
        .await
    {
        Ok(invite) => {
            let origin = state
                .auth_state
                .security
                .public_origin
                .as_deref()
                .unwrap_or("");
            let url = format!("{origin}/?invite={token}");
            (
                StatusCode::CREATED,
                Json(json!({ "invite": CampaignInviteDto::new(invite, Some((url, token)), now) })),
            )
                .into_response()
        }
        Err(err) => storage_error(err),
    }
}

/// `GET /api/v1/campaigns/{campaign_id}/invites/active` (GM) -> `{ invite: CampaignInviteDto | null }`.
pub async fn active_invite_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_gm(&state, &headers, campaign_id).await {
        return *resp;
    }
    let now = now_epoch_seconds();
    match state
        .auth_state
        .session_store
        .unrevoked_campaign_invite(campaign_id)
        .await
    {
        Ok(invite) => {
            Json(json!({ "invite": invite.map(|i| CampaignInviteDto::new(i, None, now)) }))
                .into_response()
        }
        Err(err) => storage_error(err),
    }
}

/// `DELETE /api/v1/campaigns/{campaign_id}/invites/active` (GM) -> `{ invite }` (now revoked).
pub async fn revoke_invite_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_gm(&state, &headers, campaign_id).await {
        return *resp;
    }
    let now = now_epoch_seconds();
    match state
        .auth_state
        .session_store
        .revoke_campaign_invite(campaign_id, now)
        .await
    {
        Ok(Some(invite)) => {
            Json(json!({ "invite": CampaignInviteDto::new(invite, None, now) })).into_response()
        }
        Ok(None) => error_response(
            StatusCode::NOT_FOUND,
            "NO_ACTIVE_INVITE",
            "campaign has no unrevoked invite",
        ),
        Err(err) => storage_error(err),
    }
}

/// `GET /api/v1/campaigns/{campaign_id}/invites/redemptions` (GM) -> `{ redemptions: [...] }`.
pub async fn list_redemptions_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_gm(&state, &headers, campaign_id).await {
        return *resp;
    }
    match state
        .auth_state
        .session_store
        .list_invite_redemptions(campaign_id)
        .await
    {
        Ok(redemptions) => Json(json!({ "redemptions": redemptions })).into_response(),
        Err(err) => storage_error(err),
    }
}

/// `DELETE /api/v1/campaigns/{campaign_id}/members/{user_id}` (GM) ->
/// `{ removed: true, disconnected_sessions }`; closes the member's live sockets.
pub async fn remove_member_handler(
    State(state): State<AppState>,
    Path((campaign_id, user_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_gm(&state, &headers, campaign_id).await {
        return *resp;
    }
    let store = &state.auth_state.session_store;
    match store.get_campaign_member(campaign_id, user_id).await {
        Ok(Some(member)) if member.role.eq_ignore_ascii_case("GM") => {
            return error_response(
                StatusCode::CONFLICT,
                "CANNOT_REMOVE_GM",
                "the campaign Game Master cannot be removed",
            );
        }
        Ok(Some(_)) => {}
        Ok(None) => {
            return error_response(
                StatusCode::NOT_FOUND,
                "MEMBER_NOT_FOUND",
                "user is not a member of this campaign",
            );
        }
        Err(err) => return storage_error(err),
    }
    if let Err(err) = store.remove_campaign_member(campaign_id, user_id).await {
        return storage_error(err);
    }
    let disconnected_sessions = match state.lease_manager.get_active_room(campaign_id).await {
        Some(room) => room.evict_user(user_id).await.unwrap_or(0),
        None => 0,
    };
    tracing::info!(%campaign_id, %user_id, disconnected_sessions, "campaign member removed");
    Json(json!({ "removed": true, "disconnected_sessions": disconnected_sessions })).into_response()
}

/// `POST /api/v1/invites/preview` -> `{ campaign_id, campaign_name, status, expires_at }`
/// so the join page can show where the link leads before asking for credentials.
pub async fn preview_invite_handler(
    State(state): State<AppState>,
    Json(req): Json<InvitePreviewRequest>,
) -> Response {
    let invite = match state
        .auth_state
        .session_store
        .find_campaign_invite(&hash_session_token(req.token.trim()))
        .await
    {
        Ok(Some(invite)) => invite,
        Ok(None) => {
            return error_response(
                StatusCode::NOT_FOUND,
                "INVITE_NOT_FOUND",
                "invite not found",
            );
        }
        Err(err) => return storage_error(err),
    };
    let campaign_name = crate::campaigns::load_campaign(&state, invite.campaign_id)
        .await
        .ok()
        .flatten()
        .map(|c| c.name);
    Json(json!({
        "campaign_id": invite.campaign_id,
        "campaign_name": campaign_name,
        "status": invite.status(now_epoch_seconds()),
        "expires_at": invite.expires_at,
    }))
    .into_response()
}

fn redeem_error(err: InviteRedeemError) -> Response {
    let (status, code) = match &err {
        InviteRedeemError::NotFound => (StatusCode::NOT_FOUND, "INVITE_NOT_FOUND"),
        InviteRedeemError::Revoked => (StatusCode::GONE, "INVITE_REVOKED"),
        InviteRedeemError::Expired => (StatusCode::GONE, "INVITE_EXPIRED"),
        InviteRedeemError::Exhausted => (StatusCode::GONE, "INVITE_EXHAUSTED"),
        InviteRedeemError::EmailTaken => (StatusCode::CONFLICT, "EMAIL_ALREADY_EXISTS"),
        InviteRedeemError::MemberRemoved => (StatusCode::FORBIDDEN, "MEMBER_REMOVED"),
        InviteRedeemError::Storage(_) => (StatusCode::INTERNAL_SERVER_ERROR, "STORAGE_ERROR"),
    };
    error_response(status, code, &err.to_string())
}

/// Validates the credentials of an unauthenticated redemption into a `Member` account;
/// errors are `(status, code, message)`.
async fn new_member_redeemer(
    req: &RedeemInviteRequest,
) -> Result<InviteRedeemer, (StatusCode, &'static str, String)> {
    let email = req
        .email
        .as_deref()
        .and_then(normalize_email)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "INVALID_EMAIL",
                "valid email address is required".to_string(),
            )
        })?;
    let display_name = req
        .display_name
        .as_deref()
        .and_then(normalize_display_name)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "INVALID_DISPLAY_NAME",
                "display_name must be between 2 and 100 characters".to_string(),
            )
        })?;
    let password_hash = PasswordService::new()
        .hash_password_blocking(req.password.clone().unwrap_or_default())
        .await
        .map_err(|err| match err {
            PasswordError::WeakPassword(msg) => (StatusCode::BAD_REQUEST, "WEAK_PASSWORD", msg),
            other => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "HASHING_ERROR",
                other.to_string(),
            ),
        })?;
    Ok(InviteRedeemer::NewAccount(new_account(
        email,
        display_name,
        password_hash,
        InstanceRole::Member,
    )))
}

/// `POST /api/v1/invites/redeem`: see the module lifecycle.
pub async fn redeem_invite_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RedeemInviteRequest>,
) -> Response {
    let token_hash = hash_session_token(req.token.trim());
    let store = &state.auth_state.session_store;
    let redeemer = match authenticate_user_from_headers(&state.auth_state, &headers).await {
        Ok(user) => InviteRedeemer::ExistingUser(user.id),
        Err(_) => {
            match store.find_campaign_invite(&token_hash).await {
                Ok(Some(invite)) => {
                    let status = invite.status(now_epoch_seconds());
                    if status != InviteStatus::Active {
                        return redeem_error(status.into());
                    }
                }
                Ok(None) => return redeem_error(InviteRedeemError::NotFound),
                Err(err) => return storage_error(err),
            }
            match new_member_redeemer(&req).await {
                Ok(redeemer) => redeemer,
                Err((status, code, message)) => return error_response(status, code, &message),
            }
        }
    };
    let outcome = match store
        .redeem_campaign_invite(&token_hash, redeemer.clone(), now_epoch_seconds())
        .await
    {
        Ok(outcome) => outcome,
        Err(err) => return redeem_error(err),
    };
    let user = match store.get_user_by_id(outcome.user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => return storage_error("user not found after redemption"),
        Err(err) => return storage_error(err),
    };
    let account_created = matches!(redeemer, InviteRedeemer::NewAccount(_));
    let body = RedeemInviteResponse {
        campaign_id: outcome.member.campaign_id,
        role: outcome.member.role,
        already_member: outcome.already_member,
        account_created,
        user: AuthUserDto::from(user),
    };
    if !account_created {
        return (StatusCode::OK, Json(body)).into_response();
    }
    match issue_session_cookie(&state.auth_state, outcome.user_id).await {
        Ok(cookie) => (StatusCode::CREATED, cookie, Json(body)).into_response(),
        Err(err) => storage_error(err),
    }
}

/// GM access routes under `/api/v1/campaigns/{campaign_id}` (merged before `with_state`).
pub fn campaign_access_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/campaigns/{campaign_id}/invites",
            post(create_invite_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/invites/active",
            get(active_invite_handler).delete(revoke_invite_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/invites/redemptions",
            get(list_redemptions_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/members/{user_id}",
            delete(remove_member_handler),
        )
}

/// Rate-limited public invite routes (`preview`, `redeem`).
pub fn invite_redemption_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/invites/preview", post(preview_invite_handler))
        .route("/api/v1/invites/redeem", post(redeem_invite_handler))
        .route_layer(axum::middleware::from_fn_with_state(
            state.auth_state.clone(),
            auth_rate_limit_middleware,
        ))
        .with_state(state)
}
