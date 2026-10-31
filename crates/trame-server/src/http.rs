//! ============================================================================
//! AXUM HTTP HEALTHCHECK, ARCHIVE, AUTH, ASSET PRESIGN & WEBSOCKET ROUTER (http.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Exposes the authoritative HTTP and WebSocket routing surface for `trame-server`:
//! - Unauthenticated liveness and database connectivity probe (`GET /healthz`, < 5 ms).
//! - Portable `.trame` campaign archive streaming export (`GET /api/v1/campaigns/{campaign_id}/export`).
//! - Portable `.trame` campaign archive streaming import (`POST /api/v1/campaigns/import`) with
//!   `FAIL_IF_EXISTS` (`409 Conflict` / `CAMPAIGN_ALREADY_EXISTS`) and `remap_ids=true` support.
//! - GM-authorized campaign Magic Link invite minting (`POST /api/v1/campaigns/{campaign_id}/invites`).
//! - Hybrid authentication routes (`/api/v1/auth/magic-link`, `/api/v1/auth/bind-account`,
//!   `/api/v1/auth/pat`, `/api/v1/auth/totp/{setup,enable,verify}`).
//! - Campaign-scoped asset presigned URL endpoint (`GET /api/v1/campaigns/{campaign_id}/assets/{hash}/presign`).
//! - Cursor-paginated session timeline endpoint (`GET /api/campaigns/{campaign_id}/sessions/{session_num}/timeline`).
//! - Binary MessagePack WebSocket upgrade endpoint (`GET /ws/campaigns/{campaign_id}`) backed by `RoomLeaseManager`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Least-Privilege Role Default & GM Invite Guard`:
//!      - `ws_campaign_handler` defaults unrecognized or omitted roles to `CampaignRole::Player`.
//!      - `create_campaign_invite_handler` enforces that the caller holds a `"GM"` role for the
//!        target campaign (`403 Forbidden` for non-GM members, `401 Unauthorized` when unauthenticated).
//!   2. `Campaign Membership & Hash Validation`:
//!      - `presign_asset_handler` validates hexadecimal asset hashes (`_thumb` optional suffix)
//!        and enforces `CampaignMembershipValidator::is_member` before minting presigned GET URLs.
//!      - `export_campaign_handler` verifies caller authentication and campaign membership before
//!        streaming `application/zip` with `Content-Disposition: attachment; filename="campaign-<id>.trame"`.
//!   3. `Archive Import Collision Policy`:
//!      - `import_campaign_handler` delegates to `ArchiveImporter` and maps
//!        `ArchiveError::CampaignAlreadyExists` to `409 Conflict` with error code `CAMPAIGN_ALREADY_EXISTS`
//!        when `remap_ids` is `false`.
//!   4. `Deterministic Session Cleanup & Sub-5ms Healthz`:
//!      - When a WebSocket disconnects, `disconnect_client(session_id)` and `send_task.abort()` execute
//!        unconditionally so `RoomLeaseManager` tracks active connections accurately.
//!      - `healthz_handler` verifies database/storage connectivity in memory in under 5 ms without
//!        requiring credentials.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `HTTP / WebSocket Request`
//!     ├── 1. `GET /healthz` -> verify database connectivity & return `200 OK` `{"status":"ok"}` (< 5 ms).
//!     ├── 2. `GET /api/v1/campaigns/{id}/export` -> verify member auth -> stream `.trame` ZIP archive.
//!     ├── 3. `POST /api/v1/campaigns/import` -> stream archive via `ArchiveImporter` -> `201 Created` or `409 Conflict`.
//!     ├── 4. `POST /api/v1/campaigns/{id}/invites` -> verify GM role -> mint JWT & return `201 Created`.
//!     └── 5. `GET /ws/campaigns/{id}` -> upgrade WebSocket & attach `ConnectedClient` to `TableRoomActor`.
//! ============================================================================

use crate::archive::{
    ArchiveError, ArchiveExporter, ArchiveImporter, CampaignExportSource, CampaignImportTarget,
    CampaignMetadata, ExportEntity, ImportResult, InMemoryCampaignStore, NoteRecord,
};
use crate::assets::store::{
    AssetStore, AssetStoreError, InMemoryAssetStore, PRESIGNED_URL_DEFAULT_TTL,
};
use crate::auth::magic_link::MagicLinkService;
use crate::auth::password::extract_session_token;
use crate::auth::pat::PatMiddleware;
use crate::auth::session::{
    AuthState, DEFAULT_SESSION_TTL_SECONDS, InMemorySessionStore, SessionStore, build_auth_router,
    hash_session_token,
};
use crate::auth::totp::TotpService;
use crate::room::{ConnectedClient, RoomLeaseManager};
use crate::storage::blob::{
    AssetDescriptor, BlobStore, BlobStoreError, BlobStream, Sha256Hasher, slice_to_stream,
    stream_to_bytes,
};
use crate::sync::decode_client_envelope;
use crate::timeline::{InMemoryTimelineStorage, SessionTimelineResponse, TimelineStorage};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, HeaderMap, HeaderValue};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;
use trame_engine::commands::CampaignRole;
use uuid::Uuid;

/// Maximum archive upload size accepted by `POST /api/v1/campaigns/import` (64 MiB).
pub const MAX_ARCHIVE_UPLOAD_BYTES: usize = 64 * 1024 * 1024;

/// Query parameters extracted during the WebSocket handshake on `/ws/campaigns/{campaign_id}`.
#[derive(Debug, Deserialize)]
pub struct WsAuthQuery {
    /// Authenticated user UUID connecting to the campaign room.
    pub user_id: Uuid,
    /// Optional role string (`"gm"`, `"spectator"`, or `"player"`); defaults to `CampaignRole::Player`.
    pub role: Option<String>,
}

/// Query parameters extracted when requesting a presigned GET URL for a campaign asset.
#[derive(Debug, Deserialize)]
pub struct PresignQuery {
    /// Authenticated user UUID requesting the asset download URL.
    pub user_id: Uuid,
}

/// Optional query parameters for `GET /api/v1/campaigns/{campaign_id}/export`.
#[derive(Debug, Default, Deserialize)]
pub struct ExportQuery {
    /// Optional authenticated user UUID when not using session cookie or Bearer token.
    pub user_id: Option<Uuid>,
}

/// Optional query parameters for `POST /api/v1/campaigns/import`.
#[derive(Debug, Default, Deserialize)]
pub struct ImportQuery {
    /// Whether to remap all campaign, entity, note, and asset UUIDs on import (`default: false`).
    pub remap_ids: Option<bool>,
    /// Optional user UUID importing the archive.
    pub user_id: Option<Uuid>,
}

/// Optional query parameters for `POST /api/v1/campaigns/{campaign_id}/invites`.
#[derive(Debug, Default, Deserialize)]
pub struct CampaignInviteQuery {
    /// Optional GM user UUID when not using session cookie or Bearer token.
    pub user_id: Option<Uuid>,
}

/// Request payload submitted to `POST /api/v1/campaigns/{campaign_id}/invites`.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct CreateCampaignInviteRequest {
    /// Optional character UUID to pre-assign to the invited player.
    pub character_id: Option<Uuid>,
    /// Role granted by the invite (`"PLAYER"`, `"SPECTATOR"`, `"ASSISTANT_GM"`); defaults to `"PLAYER"`.
    pub role: Option<String>,
    /// Invite token time-to-live in seconds; defaults to 7 days (`DEFAULT_SESSION_TTL_SECONDS`).
    pub ttl_seconds: Option<u64>,
    /// Optional caller user UUID when not authenticating via session cookie.
    pub user_id: Option<Uuid>,
}

/// Response payload returned by `POST /api/v1/campaigns/{campaign_id}/invites`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CampaignInviteResponse {
    /// Full or relative invite URL containing the signed Magic Link JWT.
    pub invite_url: String,
    /// Signed HMAC-SHA256 Magic Link JWT token string.
    pub token: String,
    /// Expiration timestamp in UNIX epoch seconds.
    pub expires_at: u64,
    /// Target campaign UUID.
    pub campaign_id: Uuid,
    /// Granted campaign role.
    pub role: String,
    /// Optional pre-assigned character UUID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_id: Option<Uuid>,
}

/// JSON payload returned by the `GET /healthz` liveness and database connectivity endpoint.
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    /// Service health status indicator (`"ok"`).
    pub status: String,
    /// Number of campaign rooms currently awake in memory inside `RoomLeaseManager`.
    pub active_rooms: usize,
}

/// Query parameters for cursor-paginated session timeline requests.
#[derive(Debug, Deserialize)]
pub struct TimelineQuery {
    /// Exclusive sequence ID cursor (`seq_id > after`); defaults to `0`.
    pub after: Option<u64>,
    /// Maximum number of timeline entries to return; defaults to `50` (clamped to `1..=200`).
    pub limit: Option<usize>,
}

/// JSON payload returned when minting a presigned GET URL for a campaign asset.
#[derive(Debug, Serialize, Deserialize)]
pub struct PresignedUrlResponse {
    /// Presigned download URL.
    pub url: String,
    /// Time-to-live in seconds before the URL expires.
    pub expires_in_secs: u64,
}

/// JSON error envelope returned by HTTP endpoints on validation, conflict, or RBAC rejection.
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// Optional machine-readable error code (e.g. `"CAMPAIGN_ALREADY_EXISTS"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Human-readable error message.
    pub error: String,
}

/// Trait checking whether a user is an active member or Game Master of a campaign.
pub trait CampaignMembershipValidator: Send + Sync {
    /// Returns `true` if `user_id` is an active participant in `campaign_id`.
    fn is_member(&self, campaign_id: Uuid, user_id: Uuid) -> bool;

    /// Returns `true` if `user_id` holds Game Master (`"GM"`) privileges in `campaign_id`.
    fn is_gm(&self, campaign_id: Uuid, user_id: Uuid) -> bool {
        self.is_member(campaign_id, user_id)
    }

    /// Registers `user_id` as an active member of `campaign_id` when supported by the validator.
    fn add_member(&self, _campaign_id: Uuid, _user_id: Uuid) {}
}

/// Alias preserving compatibility with callers referencing `MembershipValidator`.
pub use CampaignMembershipValidator as MembershipValidator;

/// Thread-safe in-memory campaign membership and role validator.
#[derive(Default, Clone, Debug)]
pub struct InMemoryMembershipValidator {
    memberships: Arc<RwLock<HashMap<(Uuid, Uuid), String>>>,
}

impl InMemoryMembershipValidator {
    /// Creates an empty membership validator.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `user_id` as an active member of `campaign_id` with default `"GM"` privilege
    /// unless overridden via `add_player` or `add_member_with_role`.
    pub fn add_member(&self, campaign_id: Uuid, user_id: Uuid) {
        self.add_member_with_role(campaign_id, user_id, "GM");
    }

    /// Registers `user_id` specifically as a Game Master (`"GM"`) of `campaign_id`.
    pub fn add_gm(&self, campaign_id: Uuid, user_id: Uuid) {
        self.add_member_with_role(campaign_id, user_id, "GM");
    }

    /// Registers `user_id` specifically as a `"PLAYER"` (non-GM) member of `campaign_id`.
    pub fn add_player(&self, campaign_id: Uuid, user_id: Uuid) {
        self.add_member_with_role(campaign_id, user_id, "PLAYER");
    }

    /// Registers `user_id` in `campaign_id` with an explicit role string.
    pub fn add_member_with_role(&self, campaign_id: Uuid, user_id: Uuid, role: &str) {
        if let Ok(mut guard) = self.memberships.write() {
            guard.insert((campaign_id, user_id), role.to_uppercase());
        }
    }

    /// Removes `user_id` from `campaign_id`.
    pub fn remove_member(&self, campaign_id: Uuid, user_id: Uuid) {
        if let Ok(mut guard) = self.memberships.write() {
            guard.remove(&(campaign_id, user_id));
        }
    }
}

impl CampaignMembershipValidator for InMemoryMembershipValidator {
    fn is_member(&self, campaign_id: Uuid, user_id: Uuid) -> bool {
        self.memberships
            .read()
            .map(|g| g.contains_key(&(campaign_id, user_id)))
            .unwrap_or(false)
    }

    fn is_gm(&self, campaign_id: Uuid, user_id: Uuid) -> bool {
        self.memberships
            .read()
            .ok()
            .and_then(|g| g.get(&(campaign_id, user_id)).cloned())
            .map(|role| role.eq_ignore_ascii_case("GM"))
            .unwrap_or(false)
    }

    fn add_member(&self, campaign_id: Uuid, user_id: Uuid) {
        self.add_member_with_role(campaign_id, user_id, "GM");
    }
}

/// Thread-safe in-memory `BlobStore` implementation for streaming archive exports and imports.
#[derive(Default, Clone, Debug)]
pub struct InMemoryBlobStore {
    blobs: Arc<RwLock<HashMap<String, (AssetDescriptor, Bytes)>>>,
}

impl InMemoryBlobStore {
    /// Creates an empty in-memory blob store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl BlobStore for InMemoryBlobStore {
    async fn put_stream(
        &self,
        id: &str,
        stream: BlobStream,
    ) -> Result<AssetDescriptor, BlobStoreError> {
        let clean_id = crate::storage::blob::sanitize_asset_id(id)?;
        let bytes = stream_to_bytes(stream).await?;
        let sha256_hex = Sha256Hasher::digest(&bytes);
        let desc = AssetDescriptor {
            id: clean_id.clone(),
            byte_size: bytes.len() as u64,
            sha256_hex,
            mime_type: "image/webp".to_string(),
        };
        let mut guard = self
            .blobs
            .write()
            .map_err(|_| BlobStoreError::Io(std::io::Error::other("blob lock poisoned")))?;
        guard.insert(clean_id, (desc.clone(), bytes));
        Ok(desc)
    }

    async fn get_descriptor(&self, id: &str) -> Result<AssetDescriptor, BlobStoreError> {
        let clean_id = crate::storage::blob::sanitize_asset_id(id)?;
        let guard = self
            .blobs
            .read()
            .map_err(|_| BlobStoreError::Io(std::io::Error::other("blob lock poisoned")))?;
        guard
            .get(&clean_id)
            .map(|(desc, _)| desc.clone())
            .ok_or(BlobStoreError::NotFound(clean_id))
    }

    async fn open_read_stream(&self, id: &str) -> Result<BlobStream, BlobStoreError> {
        let clean_id = crate::storage::blob::sanitize_asset_id(id)?;
        let bytes = {
            let guard = self
                .blobs
                .read()
                .map_err(|_| BlobStoreError::Io(std::io::Error::other("blob lock poisoned")))?;
            guard
                .get(&clean_id)
                .map(|(_, b)| b.clone())
                .ok_or(BlobStoreError::NotFound(clean_id))?
        };
        Ok(slice_to_stream(&bytes))
    }

    async fn list_descriptors(&self) -> Result<Vec<AssetDescriptor>, BlobStoreError> {
        let guard = self
            .blobs
            .read()
            .map_err(|_| BlobStoreError::Io(std::io::Error::other("blob lock poisoned")))?;
        let mut list: Vec<AssetDescriptor> = guard.values().map(|(d, _)| d.clone()).collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(list)
    }

    async fn delete(&self, id: &str) -> Result<(), BlobStoreError> {
        let clean_id = crate::storage::blob::sanitize_asset_id(id)?;
        let mut guard = self
            .blobs
            .write()
            .map_err(|_| BlobStoreError::Io(std::io::Error::other("blob lock poisoned")))?;
        guard.remove(&clean_id);
        Ok(())
    }
}

/// Snapshot export source scoped to a single campaign for `ArchiveExporter`.
#[derive(Clone, Debug)]
struct ScopedCampaignExportSource {
    metadata: CampaignMetadata,
    entities: Vec<ExportEntity>,
    notes: Vec<NoteRecord>,
    asset_ids: Vec<Uuid>,
}

impl CampaignExportSource for ScopedCampaignExportSource {
    fn campaign_metadata(&self) -> CampaignMetadata {
        self.metadata.clone()
    }

    fn stream_entities(&self) -> Vec<ExportEntity> {
        self.entities.clone()
    }

    fn stream_notes(&self) -> Vec<NoteRecord> {
        self.notes.clone()
    }

    fn list_asset_ids(&self) -> Vec<Uuid> {
        self.asset_ids.clone()
    }
}

/// Shared application state injected into Axum HTTP and WebSocket handlers.
#[derive(Clone)]
pub struct AppState {
    /// Campaign room lease and hibernation manager.
    pub lease_manager: Arc<RoomLeaseManager>,
    /// Content-addressed WebP asset store for presigned URLs.
    pub asset_store: Arc<dyn AssetStore>,
    /// Campaign membership validator for presigned URL, export, and invite RBAC.
    pub membership: Arc<dyn CampaignMembershipValidator>,
    /// Unique identifier of this TRAME server instance.
    pub instance_id: Uuid,
    /// Session timeline event storage backend.
    pub timeline_storage: Arc<dyn TimelineStorage>,
    /// Campaign metadata, entity, and note store for archive import/export.
    pub campaign_store: InMemoryCampaignStore,
    /// Streaming blob store for `.trame` archive assets.
    pub blob_store: InMemoryBlobStore,
    /// Authentication state (Magic Link JWTs, sessions, Argon2id, PAT, TOTP).
    pub auth_state: AuthState,
    /// Simulated or live database connectivity flag checked by `GET /healthz`.
    pub db_healthy: Arc<AtomicBool>,
}

impl AppState {
    /// Verifies database and campaign store connectivity in sub-millisecond time.
    pub async fn check_database_connectivity(&self) -> bool {
        if !self.db_healthy.load(Ordering::Acquire) {
            return false;
        }
        self.campaign_store.campaigns.read().is_ok()
    }
}

/// Type alias preserving compatibility with callers referencing `ServerAppState`.
pub type ServerAppState = AppState;

/// Constructs the Axum `Router` binding all archive, auth, healthcheck, presign, timeline, and WebSocket routes.
pub fn build_router(
    lease_manager: Arc<RoomLeaseManager>,
    asset_store: Arc<dyn AssetStore>,
    membership: Arc<dyn CampaignMembershipValidator>,
    instance_id: Uuid,
) -> Router {
    let timeline_storage: Arc<dyn TimelineStorage> = Arc::new(InMemoryTimelineStorage::new());
    build_full_router(
        lease_manager,
        asset_store,
        membership,
        instance_id,
        timeline_storage,
    )
}

/// Constructs an Axum `Router` with a custom `TimelineStorage` and default in-memory stores.
pub fn build_app_router(
    lease_manager: Arc<RoomLeaseManager>,
    timeline_storage: Arc<dyn TimelineStorage>,
) -> Router {
    let asset_store: Arc<dyn AssetStore> = Arc::new(InMemoryAssetStore::new());
    let membership: Arc<dyn CampaignMembershipValidator> =
        Arc::new(InMemoryMembershipValidator::new());
    build_full_router(
        lease_manager,
        asset_store,
        membership,
        Uuid::new_v4(),
        timeline_storage,
    )
}

/// Constructs the full Axum `Router` with default archive and authentication stores.
pub fn build_full_router(
    lease_manager: Arc<RoomLeaseManager>,
    asset_store: Arc<dyn AssetStore>,
    membership: Arc<dyn CampaignMembershipValidator>,
    instance_id: Uuid,
    timeline_storage: Arc<dyn TimelineStorage>,
) -> Router {
    let session_store = Arc::new(InMemorySessionStore::new());
    let magic_link_service = Arc::new(MagicLinkService::new(
        b"trame-default-hmac-sha256-signing-secret-key",
        "trame-server",
    ));
    let auth_state = AuthState {
        magic_link_service,
        session_store,
        totp_service: Arc::new(TotpService::default()),
    };
    let state = AppState {
        lease_manager,
        asset_store,
        membership,
        instance_id,
        timeline_storage,
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state,
        db_healthy: Arc::new(AtomicBool::new(true)),
    };
    build_router_with_state(state)
}

/// Constructs the authoritative Axum `Router` from a pre-configured `AppState`.
pub fn build_router_with_state(state: AppState) -> Router {
    let auth_router = build_auth_router(state.auth_state.clone());

    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/ws/campaigns/{campaign_id}", get(ws_campaign_handler))
        .route(
            "/api/v1/campaigns/{campaign_id}/ws",
            get(ws_campaign_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/assets/{hash}/presign",
            get(presign_asset_handler),
        )
        .route(
            "/api/campaigns/{campaign_id}/sessions/{session_num}/timeline",
            get(timeline_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/export",
            get(export_campaign_handler),
        )
        .route("/api/v1/campaigns/import", post(import_campaign_handler))
        .route(
            "/api/v1/campaigns/{campaign_id}/invites",
            post(create_campaign_invite_handler),
        )
        .with_state(state)
        .merge(auth_router)
}

/// Resolves an authenticated user ID from session cookie, Bearer session token, Bearer PAT, or explicit `fallback_user_id`.
async fn resolve_authenticated_user(
    state: &AppState,
    headers: &HeaderMap,
    fallback_user_id: Option<Uuid>,
) -> Result<Uuid, StatusCode> {
    if let Some(auth_hdr) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = auth_hdr.trim();
        if let Some(token) = trimmed.strip_prefix("Bearer ") {
            let token = token.trim();
            if token.starts_with(crate::auth::pat::PAT_PREFIX) {
                let pat_mw = PatMiddleware::new(state.auth_state.session_store.clone());
                let pat_record = pat_mw
                    .authenticate_header(trimmed)
                    .await
                    .map_err(|_| StatusCode::UNAUTHORIZED)?;
                return Ok(pat_record.user_id);
            }
        }
    }

    if let Some(session_token) = extract_session_token(headers) {
        let token_hash = hash_session_token(&session_token);
        let session = state
            .auth_state
            .session_store
            .get_session_by_token_hash(&token_hash)
            .await
            .map_err(|_| StatusCode::UNAUTHORIZED)?
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let now = crate::auth::magic_link::now_epoch_seconds();
        if session.expires_at < now {
            return Err(StatusCode::UNAUTHORIZED);
        }
        return Ok(session.user_id);
    }

    fallback_user_id.ok_or(StatusCode::UNAUTHORIZED)
}

/// Checks whether `user_id` is an authorized member of `campaign_id` via `membership` or `session_store`.
async fn is_authorized_campaign_member(state: &AppState, campaign_id: Uuid, user_id: Uuid) -> bool {
    if state.membership.is_member(campaign_id, user_id) {
        return true;
    }
    state
        .auth_state
        .session_store
        .get_campaign_member(campaign_id, user_id)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Checks whether `user_id` holds Game Master (`"GM"`) privileges for `campaign_id`.
async fn is_authorized_campaign_gm(state: &AppState, campaign_id: Uuid, user_id: Uuid) -> bool {
    if state.membership.is_gm(campaign_id, user_id) {
        return true;
    }
    if let Ok(Some(member)) = state
        .auth_state
        .session_store
        .get_campaign_member(campaign_id, user_id)
        .await
    {
        return member.role.eq_ignore_ascii_case("GM");
    }
    false
}

/// Unauthenticated `GET /healthz` probe verifying database connectivity and returning `{"status":"ok"}` in under 5 ms.
pub async fn healthz_handler(State(state): State<AppState>) -> Response {
    if !state.check_database_connectivity().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                code: Some("DATABASE_UNAVAILABLE".to_string()),
                error: "database connectivity check failed".to_string(),
            }),
        )
            .into_response();
    }

    let active_rooms = state.lease_manager.active_room_count().await;
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok".to_string(),
            active_rooms,
        }),
    )
        .into_response()
}

/// Streams a portable `.trame` ZIP archive for `GET /api/v1/campaigns/{campaign_id}/export`.
pub async fn export_campaign_handler(
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, query.user_id).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "valid authentication credentials required".to_string(),
                }),
            )
                .into_response();
        }
    };

    if !is_authorized_campaign_member(&state, campaign_id, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not an active member of this campaign".to_string(),
            }),
        )
            .into_response();
    }

    let metadata = state
        .campaign_store
        .get_campaign(&campaign_id)
        .unwrap_or_else(|| CampaignMetadata {
            id: campaign_id,
            name: format!("Campaign {campaign_id}"),
            system: "dnd5e".to_string(),
            description: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        });

    let cid_str = campaign_id.to_string();
    let entities: Vec<ExportEntity> = state
        .campaign_store
        .all_entities()
        .into_iter()
        .filter(|e| {
            let matches_campaign_id = e
                .data
                .get("campaign_id")
                .and_then(|v| v.as_str())
                .map(|s| s == cid_str)
                .unwrap_or(false);
            let matches_self = e.entity_type == "campaign"
                && e.data
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s == cid_str)
                    .unwrap_or(false);
            matches_campaign_id || matches_self
        })
        .collect();

    let notes = state.campaign_store.all_notes();
    let asset_ids: Vec<Uuid> = state
        .blob_store
        .list_descriptors()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|d| Uuid::parse_str(&d.id).ok())
        .collect();

    let source = ScopedCampaignExportSource {
        metadata,
        entities,
        notes,
        asset_ids,
    };

    let exporter = ArchiveExporter::new(source, state.blob_store.clone());
    let stream = match exporter.export_stream().await {
        Ok(s) => s,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    code: Some("EXPORT_ERROR".to_string()),
                    error: err.to_string(),
                }),
            )
                .into_response();
        }
    };

    let body_stream = stream.map_err(|e| std::io::Error::other(e.to_string()));
    let body = Body::from_stream(body_stream);

    let disposition = format!("attachment; filename=\"campaign-{campaign_id}.trame\"");
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    if let Ok(val) = HeaderValue::from_str(&disposition) {
        resp_headers.insert(CONTENT_DISPOSITION, val);
    }

    (StatusCode::OK, resp_headers, body).into_response()
}

fn is_client_archive_error(err: &ArchiveError) -> bool {
    matches!(
        err,
        ArchiveError::InvalidManifest(_)
            | ArchiveError::ChecksumMismatch { .. }
            | ArchiveError::UnlistedEntry(_)
            | ArchiveError::Zip(_)
            | ArchiveError::Json(_)
    )
}

/// Imports a `.trame` archive stream at `POST /api/v1/campaigns/import`, returning `201 Created`
/// with restoration counters or `409 Conflict` (`CAMPAIGN_ALREADY_EXISTS`) on collision.
pub async fn import_campaign_handler(
    Query(query): Query<ImportQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
    request: Request<Body>,
) -> Response {
    let caller_user_id = resolve_authenticated_user(&state, &headers, query.user_id)
        .await
        .ok();

    let body = request.into_body();
    let body_bytes = match axum::body::to_bytes(body, MAX_ARCHIVE_UPLOAD_BYTES).await {
        Ok(b) => b,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    code: Some("INVALID_ARCHIVE_STREAM".to_string()),
                    error: err.to_string(),
                }),
            )
                .into_response();
        }
    };

    let remap_ids = query.remap_ids.unwrap_or(false);
    let importer = ArchiveImporter::new(state.campaign_store.clone(), state.blob_store.clone());

    match importer
        .import_stream(Cursor::new(body_bytes.to_vec()), remap_ids)
        .await
    {
        Ok(ImportResult {
            campaign_id,
            name,
            actors_restored,
            scenes_restored,
            notes_restored,
            assets_restored,
        }) => {
            if let Some(uid) = caller_user_id {
                state.membership.add_member(campaign_id, uid);
                let _ = state
                    .auth_state
                    .session_store
                    .assign_campaign_member(campaign_id, uid, None, "GM")
                    .await;
            }
            (
                StatusCode::CREATED,
                Json(ImportResult {
                    campaign_id,
                    name,
                    actors_restored,
                    scenes_restored,
                    notes_restored,
                    assets_restored,
                }),
            )
                .into_response()
        }
        Err(ArchiveError::CampaignAlreadyExists(existing_id)) => (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                code: Some("CAMPAIGN_ALREADY_EXISTS".to_string()),
                error: format!("campaign {existing_id} already exists"),
            }),
        )
            .into_response(),
        Err(err) if is_client_archive_error(&err) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                code: Some("INVALID_ARCHIVE".to_string()),
                error: err.to_string(),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                code: Some("IMPORT_ERROR".to_string()),
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Mints a signed campaign Magic Link invite token at `POST /api/v1/campaigns/{campaign_id}/invites`
/// when called by an authorized Game Master (`201 Created`).
pub async fn create_campaign_invite_handler(
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<CampaignInviteQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    let payload: CreateCampaignInviteRequest = if body.is_empty() {
        CreateCampaignInviteRequest::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(p) => p,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        code: Some("INVALID_PAYLOAD".to_string()),
                        error: err.to_string(),
                    }),
                )
                    .into_response();
            }
        }
    };

    let fallback_uid = query.user_id.or(payload.user_id);
    let caller_id = match resolve_authenticated_user(&state, &headers, fallback_uid).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required to create campaign invites".to_string(),
                }),
            )
                .into_response();
        }
    };

    if !is_authorized_campaign_gm(&state, campaign_id, caller_id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may create invite links".to_string(),
            }),
        )
            .into_response();
    }

    let role = payload.role.unwrap_or_else(|| "PLAYER".to_string());
    let ttl = payload.ttl_seconds.unwrap_or(DEFAULT_SESSION_TTL_SECONDS);

    match state.auth_state.magic_link_service.create_invite_token(
        caller_id,
        campaign_id,
        payload.character_id,
        &role,
        ttl,
    ) {
        Ok((token, claims)) => {
            let invite_url = format!("https://trame.app/join?token={token}");
            (
                StatusCode::CREATED,
                Json(CampaignInviteResponse {
                    invite_url,
                    token,
                    expires_at: claims.exp,
                    campaign_id,
                    role: claims.role,
                    character_id: claims.character_id,
                }),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                code: Some("INVITE_CREATION_FAILED".to_string()),
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn timeline_handler(
    Path((campaign_id, session_num)): Path<(String, u32)>,
    Query(query): Query<TimelineQuery>,
    State(state): State<AppState>,
) -> Json<SessionTimelineResponse> {
    let after_seq = query.after.unwrap_or(0);
    let limit = query.limit.unwrap_or(50);
    let resp = state
        .timeline_storage
        .get_timeline(&campaign_id, session_num, after_seq, limit)
        .unwrap_or_else(|_| SessionTimelineResponse {
            campaign_id: campaign_id.clone(),
            session_num,
            session_id: format!("{campaign_id}:{session_num}"),
            events: Vec::new(),
            has_more: false,
        });
    Json(resp)
}

/// WebSocket endpoint upgrading client connection and attaching to campaign `TableRoomActor`.
pub async fn ws_campaign_handler(
    ws: WebSocketUpgrade,
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<WsAuthQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let role = match query.role.as_deref() {
        Some("gm") | Some("GM") => CampaignRole::Gm,
        Some("spectator") | Some("Spectator") => CampaignRole::Spectator,
        _ => CampaignRole::Player,
    };
    ws.on_upgrade(move |socket| {
        handle_ws_connection(
            socket,
            state.lease_manager,
            campaign_id,
            query.user_id,
            role,
        )
    })
}

fn is_valid_asset_hash(hash: &str) -> bool {
    let base = hash.strip_suffix("_thumb").unwrap_or(hash);
    !base.is_empty() && base.chars().all(|c| c.is_ascii_hexdigit())
}

/// Presigns a campaign asset URL with 15-minute TTL enforcing campaign membership.
pub async fn presign_asset_handler(
    Path((campaign_id, hash)): Path<(Uuid, String)>,
    Query(query): Query<PresignQuery>,
    State(state): State<AppState>,
) -> Response {
    if !is_valid_asset_hash(&hash) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                code: Some("INVALID_ASSET_HASH".to_string()),
                error: "invalid asset hash format".to_string(),
            }),
        )
            .into_response();
    }

    if !state.membership.is_member(campaign_id, query.user_id) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not an active member of this campaign".to_string(),
            }),
        )
            .into_response();
    }

    let key = format!(
        "instances/{}/campaigns/{}/assets/{}.webp",
        state.instance_id, campaign_id, hash
    );

    match state
        .asset_store
        .mint_presigned_get_url(&key, PRESIGNED_URL_DEFAULT_TTL)
        .await
    {
        Ok(url) => (
            StatusCode::OK,
            Json(PresignedUrlResponse {
                url,
                expires_in_secs: PRESIGNED_URL_DEFAULT_TTL.as_secs(),
            }),
        )
            .into_response(),
        Err(AssetStoreError::NotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                code: Some("NOT_FOUND".to_string()),
                error: format!("asset with hash '{hash}' not found"),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                code: Some("INTERNAL_ERROR".to_string()),
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn handle_ws_connection(
    socket: WebSocket,
    mgr: Arc<RoomLeaseManager>,
    campaign_id: Uuid,
    user_id: Uuid,
    role: CampaignRole,
) {
    let Ok(room_handle) = mgr.get_or_wake_room(campaign_id).await else {
        return;
    };

    let session_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let client = ConnectedClient {
        session_id,
        user_id,
        role,
        tx,
    };

    if room_handle.connect_client(client).await.is_err() {
        return;
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();

    let send_task = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if ws_sender.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        if let Message::Binary(bin) = msg
            && let Ok(envelope) = decode_client_envelope(&bin)
        {
            let _ = room_handle.send_envelope(session_id, envelope).await;
        }
    }

    let _ = room_handle.disconnect_client(session_id).await;
    send_task.abort();
}

/// Seeds a campaign with sample entities, notes, and assets in `AppState` for testing or bootstrapping.
pub async fn seed_campaign_for_export(
    state: &AppState,
    campaign: CampaignMetadata,
    entities: Vec<ExportEntity>,
    notes: Vec<NoteRecord>,
    assets: Vec<(Uuid, &[u8])>,
) -> Result<(), ArchiveError> {
    state.campaign_store.save_campaign(&campaign).await?;
    state.campaign_store.save_entities(&entities).await?;
    state.campaign_store.save_notes(&notes).await?;
    for (asset_id, data) in assets {
        state
            .blob_store
            .put_stream(&asset_id.to_string(), slice_to_stream(data))
            .await?;
    }
    Ok(())
}
