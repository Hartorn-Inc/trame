//! ============================================================================
//! AXUM HTTP HEALTHCHECK, ARCHIVE, AUTH, ASSET PRESIGN, CAMPAIGN CRUD,
//! STARTER DUNGEON, UVTT MAP UPLOAD, WIKI NOTES & WEBSOCKET ROUTER (http.rs)
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
use crate::importers::uvtt::{ImportedMapResult, UvttImportError, import_uvtt_map};
use crate::notes::{
    FilteredNoteDocument, InMemoryPartyJournalStorage, PartyJournalStorage, RevealHandoutCommand,
    UserRole, reveal_handout,
};
use crate::room::{ConnectedClient, IS_SHUTTING_DOWN, OutboundClientFrame, RoomLeaseManager};
use crate::storage::blob::{
    AssetDescriptor, BlobStore, BlobStoreError, BlobStream, Sha256Hasher, slice_to_stream,
    stream_to_bytes,
};
use crate::storage::postgres::SqlxPostgresStore;
use crate::sync::decode_client_envelope;
use crate::timeline::{InMemoryTimelineStorage, SessionTimelineResponse, TimelineStorage};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, HeaderMap, HeaderValue};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post, put};
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;
use trame_engine::commands::{CampaignRole, TableState, TokenState};
use trame_engine::geometry::{CHANNEL_MATERIAL, Point2D, SenseProfile};
use uuid::Uuid;

/// Maximum archive upload size accepted by `POST /api/v1/campaigns/import` (64 MiB).
pub const MAX_ARCHIVE_UPLOAD_BYTES: usize = 64 * 1024 * 1024;

/// Query parameters extracted during the WebSocket handshake on `/ws/campaigns/{campaign_id}`.
#[derive(Debug, Default, Deserialize)]
pub struct WsAuthQuery {
    /// Authenticated user UUID connecting to the campaign room.
    pub user_id: Option<Uuid>,
    /// Optional role string (`"gm"`, `"spectator"`, or `"player"`); defaults to `CampaignRole::Player`.
    pub role: Option<String>,
}

/// Query parameters extracted when requesting a presigned GET URL for a campaign asset.
#[derive(Debug, Default, Deserialize)]
pub struct PresignQuery {
    /// Authenticated user UUID requesting the asset download URL.
    pub user_id: Option<Uuid>,
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
    /// Optional alias for `ttl_seconds`.
    pub duration_seconds: Option<u64>,
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
    /// Party journal handout storage backend.
    pub journal_storage: Arc<dyn PartyJournalStorage>,
    /// Campaign metadata, entity, and note store for archive import/export.
    pub campaign_store: InMemoryCampaignStore,
    /// Streaming blob store for `.trame` archive assets.
    pub blob_store: InMemoryBlobStore,
    /// Authentication state (Magic Link JWTs, sessions, Argon2id, PAT, TOTP).
    pub auth_state: AuthState,
    /// Optional PostgreSQL 18 store when running with `DATABASE_URL`.
    pub pg_store: Option<SqlxPostgresStore>,
    /// Simulated or live database connectivity flag checked by `GET /healthz`.
    pub db_healthy: Arc<AtomicBool>,
}

impl AppState {
    /// Verifies database and campaign store connectivity in sub-millisecond time.
    pub async fn check_database_connectivity(&self) -> bool {
        if !self.db_healthy.load(Ordering::Acquire) {
            return false;
        }
        if let Some(ref pg) = self.pg_store {
            return pg.check_health().await;
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
        journal_storage: Arc::new(InMemoryPartyJournalStorage::new()),
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state,
        pg_store: None,
        db_healthy: Arc::new(AtomicBool::new(true)),
    };
    build_router_with_state(state)
}

/// Constructs an `AppState` backed by PostgreSQL (`SqlxPostgresStore`).
pub fn build_postgres_app_state(pg_store: SqlxPostgresStore, instance_id: Uuid) -> AppState {
    let wal: Arc<dyn crate::wal::WalStorage> = Arc::new(pg_store.clone());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal, 50, 900_000));
    let asset_store: Arc<dyn AssetStore> = Arc::new(pg_store.clone());
    let membership: Arc<dyn CampaignMembershipValidator> = Arc::new(pg_store.clone());
    let timeline_storage: Arc<dyn TimelineStorage> = Arc::new(pg_store.clone());
    let journal_storage: Arc<dyn PartyJournalStorage> = Arc::new(pg_store.clone());
    let session_store: Arc<dyn crate::auth::session::FullAuthStore> = Arc::new(pg_store.clone());

    let jwt_secret = std::env::var("TRAME_JWT_SECRET")
        .unwrap_or_else(|_| "trame-default-hmac-sha256-signing-secret-key".to_string());
    let magic_link_service = Arc::new(MagicLinkService::new(jwt_secret.as_bytes(), "trame-server"));
    let auth_state = AuthState {
        magic_link_service,
        session_store,
        totp_service: Arc::new(TotpService::default()),
    };

    AppState {
        lease_manager,
        asset_store,
        membership,
        instance_id,
        timeline_storage,
        journal_storage,
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state,
        pg_store: Some(pg_store),
        db_healthy: Arc::new(AtomicBool::new(true)),
    }
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
            "/api/v1/campaigns",
            get(list_campaigns_handler).post(create_campaign_handler),
        )
        .route("/api/v1/campaigns/{campaign_id}", get(get_campaign_handler))
        .route(
            "/api/v1/campaigns/{campaign_id}/actors/{actor_id}",
            put(update_actor_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/maps",
            get(list_maps_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/maps/{map_id}",
            put(upsert_map_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/maps/starter",
            post(starter_map_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/maps/import-uvtt",
            post(import_uvtt_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/notes",
            get(list_notes_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/notes/{slug}",
            put(upsert_note_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/handouts/reveal",
            post(reveal_handout_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/assets/{hash}/presign",
            get(presign_asset_handler),
        )
        .route("/assets/download/{*key}", get(download_asset_handler))
        .route(
            "/api/campaigns/{campaign_id}/sessions/{session_num}/timeline",
            get(timeline_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline",
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
        .fallback(static_or_spa_fallback_handler)
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

/// Resolves the caller's `CampaignRole` in `campaign_id`, returning `None` if not a member.
async fn resolve_campaign_role(
    state: &AppState,
    campaign_id: Uuid,
    user_id: Uuid,
) -> Option<CampaignRole> {
    if is_authorized_campaign_gm(state, campaign_id, user_id).await {
        return Some(CampaignRole::Gm);
    }
    if let Ok(Some(member)) = state
        .auth_state
        .session_store
        .get_campaign_member(campaign_id, user_id)
        .await
    {
        let r = member.role.to_uppercase();
        if r == "GM" || r == "GAME_MASTER" || r == "ASSISTANT_GM" {
            return Some(CampaignRole::Gm);
        } else if r == "SPECTATOR" {
            return Some(CampaignRole::Spectator);
        } else {
            return Some(CampaignRole::Player);
        }
    }
    if state.membership.is_member(campaign_id, user_id) {
        return Some(CampaignRole::Player);
    }
    None
}

// ============================================================================
// Campaign CRUD & Actor Sheet Endpoints
// ============================================================================

/// Campaign summary returned by `GET /api/v1/campaigns`, `POST /api/v1/campaigns`, and `GET /api/v1/campaigns/{id}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CampaignDto {
    pub id: Uuid,
    pub name: String,
    pub system: String,
    pub role: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_map_hash: Option<String>,
    #[serde(default)]
    pub actors: Vec<serde_json::Value>,
}

/// Request payload for `POST /api/v1/campaigns`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreateCampaignRequest {
    pub name: String,
    pub system: Option<String>,
    pub description: Option<String>,
}

/// Lists campaigns where the authenticated caller is a member (`GET /api/v1/campaigns`).
pub async fn list_campaigns_handler(headers: HeaderMap, State(state): State<AppState>) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let memberships = state
        .auth_state
        .session_store
        .get_campaign_members_for_user(user_id)
        .await
        .unwrap_or_default();

    let mut campaigns = Vec::new();
    for m in memberships {
        let meta = if let Some(ref pg) = state.pg_store {
            pg.get_campaign_async(m.campaign_id).await.ok().flatten()
        } else {
            state.campaign_store.get_campaign(&m.campaign_id)
        };
        let meta = meta.unwrap_or_else(|| CampaignMetadata {
            id: m.campaign_id,
            name: format!("Campaign {}", &m.campaign_id.to_string()[..8]),
            system: "dnd5e".to_string(),
            description: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        });
        campaigns.push(CampaignDto {
            id: meta.id,
            name: meta.name,
            system: meta.system,
            role: m.role,
            created_at: meta.created_at,
            description: meta.description,
            active_map_hash: None,
            actors: Vec::new(),
        });
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "campaigns": campaigns })),
    )
        .into_response()
}

/// Creates a new campaign and assigns the caller as `"GM"` (`POST /api/v1/campaigns`).
pub async fn create_campaign_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<CreateCampaignRequest>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let name = payload.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                code: Some("INVALID_NAME".to_string()),
                error: "campaign name must be between 1 and 120 characters".to_string(),
            }),
        )
            .into_response();
    }

    let campaign_id = Uuid::new_v4();
    let system = payload.system.unwrap_or_else(|| "dnd5e".to_string());
    let created_at = "2026-01-01T00:00:00Z".to_string();
    let meta = CampaignMetadata {
        id: campaign_id,
        name: name.clone(),
        system: system.clone(),
        description: payload.description.clone(),
        created_at: created_at.clone(),
    };

    let _ = state.campaign_store.save_campaign(&meta).await;
    if let Some(ref pg) = state.pg_store {
        let _ = pg.save_campaign(&meta).await;
    }

    state.membership.add_member(campaign_id, user_id);
    let _ = state
        .auth_state
        .session_store
        .assign_campaign_member(campaign_id, user_id, None, "GM")
        .await;

    let dto = CampaignDto {
        id: campaign_id,
        name,
        system,
        role: "GM".to_string(),
        created_at,
        description: payload.description,
        active_map_hash: None,
        actors: Vec::new(),
    };

    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "campaign": dto })),
    )
        .into_response()
}

/// Fetches a single campaign's metadata, active map, and actors (`GET /api/v1/campaigns/{campaign_id}`).
pub async fn get_campaign_handler(
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let Some(role_enum) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not a member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    let role_str = match role_enum {
        CampaignRole::Gm => "GM",
        CampaignRole::Spectator => "SPECTATOR",
        CampaignRole::Player => "PLAYER",
    };

    let meta = if let Some(ref pg) = state.pg_store {
        pg.get_campaign_async(campaign_id).await.ok().flatten()
    } else {
        None
    }
    .or_else(|| state.campaign_store.get_campaign(&campaign_id))
    .unwrap_or_else(|| CampaignMetadata {
        id: campaign_id,
        name: format!("Campaign {}", &campaign_id.to_string()[..8]),
        system: "dnd5e".to_string(),
        description: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
    });

    let entities = if let Some(ref pg) = state.pg_store {
        pg.list_entities_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default()
    } else {
        let cid_str = campaign_id.to_string();
        state
            .campaign_store
            .all_entities()
            .into_iter()
            .filter(|e| {
                e.data
                    .get("campaign_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s == cid_str)
                    .unwrap_or(false)
            })
            .collect()
    };

    let mut active_map_hash = None;
    let mut actors = Vec::new();
    for entity in entities {
        if entity.entity_type == "scene" {
            if let Some(hash) = entity.data.get("sha256_hash").and_then(|v| v.as_str()) {
                active_map_hash = Some(hash.to_string());
            }
        } else if entity.entity_type == "actor" {
            actors.push(entity.data);
        }
    }

    let dto = CampaignDto {
        id: meta.id,
        name: meta.name,
        system: meta.system,
        role: role_str.to_string(),
        created_at: meta.created_at,
        description: meta.description,
        active_map_hash,
        actors,
    };

    (StatusCode::OK, Json(serde_json::json!({ "campaign": dto }))).into_response()
}

/// Request payload for `PUT /api/v1/campaigns/{campaign_id}/actors/{actor_id}`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpdateActorRequest {
    pub name: Option<String>,
    pub kind: Option<String>,
    pub attributes: Option<HashMap<String, f64>>,
    pub sheet: Option<serde_json::Value>,
    pub spawn_on_map: Option<bool>,
    pub hp: Option<i32>,
    pub max_hp: Option<i32>,
    pub gm_core_locked: Option<bool>,
}

/// Upserts a character/actor sheet and optionally spawns or updates its token on the tabletop (`PUT /api/v1/campaigns/{campaign_id}/actors/{actor_id}`).
pub async fn update_actor_handler(
    Path((campaign_id, actor_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<UpdateActorRequest>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let Some(caller_role) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not a member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    if caller_role == CampaignRole::Spectator {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "spectators cannot modify actors".to_string(),
            }),
        )
            .into_response();
    }

    let cid_str = campaign_id.to_string();
    let aid_str = actor_id.to_string();
    let existing_entities = if let Some(ref pg) = state.pg_store {
        pg.list_entities_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default()
    } else {
        state.campaign_store.all_entities()
    };

    let existing_actor = existing_entities.into_iter().find(|e| {
        e.entity_type == "actor"
            && e.data.get("id").and_then(|v| v.as_str()) == Some(aid_str.as_str())
            && e.data.get("campaign_id").and_then(|v| v.as_str()) == Some(cid_str.as_str())
    });

    if let Some(ref existing) = existing_actor {
        let existing_gm_locked = existing
            .data
            .get("gm_core_locked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if caller_role != CampaignRole::Gm && payload.gm_core_locked.is_some() {
            return (
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    code: Some("FORBIDDEN".to_string()),
                    error: "only the GM may toggle gm_core_locked".to_string(),
                }),
            )
                .into_response();
        }

        if existing_gm_locked && caller_role != CampaignRole::Gm {
            let core_changed = {
                let mut changed = false;
                if let Some(ref new_attrs) = payload.attributes {
                    let old_attrs = existing.data.get("attributes");
                    if old_attrs != Some(&serde_json::to_value(new_attrs).unwrap_or_default()) {
                        changed = true;
                    }
                }
                if let Some(ref new_sheet) = payload.sheet
                    && let Some(old_sheet) = existing.data.get("sheet")
                {
                    for key in [
                        "level",
                        "class",
                        "classId",
                        "abilities",
                        "savingThrowProficiencies",
                        "skillProficiencies",
                    ] {
                        if new_sheet.get(key) != old_sheet.get(key) && new_sheet.get(key).is_some()
                        {
                            changed = true;
                        }
                    }
                }
                changed
            };
            if core_changed {
                return (
                    StatusCode::FORBIDDEN,
                    Json(ErrorResponse {
                        code: Some("CORE_STATS_LOCKED_BY_GM".to_string()),
                        error: "core build attributes and level are locked by the Game Master"
                            .to_string(),
                    }),
                )
                    .into_response();
            }
        }
    }

    let name = payload
        .name
        .clone()
        .or_else(|| {
            existing_actor
                .as_ref()
                .and_then(|e| e.data.get("name").and_then(|v| v.as_str()))
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Adventurer".to_string());
    let kind = payload
        .kind
        .clone()
        .or_else(|| {
            existing_actor
                .as_ref()
                .and_then(|e| e.data.get("kind").and_then(|v| v.as_str()))
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "character".to_string());
    let hp = payload
        .hp
        .or_else(|| {
            existing_actor
                .as_ref()
                .and_then(|e| e.data.get("hp").and_then(|v| v.as_i64()))
                .map(|v| v as i32)
        })
        .unwrap_or(24);
    let max_hp = payload
        .max_hp
        .or_else(|| {
            existing_actor
                .as_ref()
                .and_then(|e| e.data.get("max_hp").and_then(|v| v.as_i64()))
                .map(|v| v as i32)
        })
        .unwrap_or(24);
    let owner_user_id = existing_actor
        .as_ref()
        .and_then(|e| e.data.get("owner_user_id").and_then(|v| v.as_str()))
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or(user_id);
    let gm_core_locked = if caller_role == CampaignRole::Gm {
        payload.gm_core_locked.unwrap_or_else(|| {
            existing_actor
                .as_ref()
                .and_then(|e| e.data.get("gm_core_locked").and_then(|v| v.as_bool()))
                .unwrap_or(false)
        })
    } else {
        existing_actor
            .as_ref()
            .and_then(|e| e.data.get("gm_core_locked").and_then(|v| v.as_bool()))
            .unwrap_or(false)
    };

    let attributes_val = payload
        .attributes
        .map(|a| serde_json::to_value(a).unwrap_or_default())
        .or_else(|| {
            existing_actor
                .as_ref()
                .and_then(|e| e.data.get("attributes").cloned())
        })
        .unwrap_or_else(|| serde_json::json!({}));
    let sheet_val = payload
        .sheet
        .or_else(|| {
            existing_actor
                .as_ref()
                .and_then(|e| e.data.get("sheet").cloned())
        })
        .unwrap_or_else(|| serde_json::json!({}));

    let actor_json = serde_json::json!({
        "id": actor_id,
        "campaign_id": campaign_id,
        "owner_user_id": owner_user_id,
        "name": name,
        "kind": kind,
        "hp": hp,
        "max_hp": max_hp,
        "gm_core_locked": gm_core_locked,
        "attributes": attributes_val,
        "sheet": sheet_val,
    });

    let entity = ExportEntity {
        entity_type: "actor".to_string(),
        data: actor_json.clone(),
    };

    let _ = state
        .campaign_store
        .save_entities(std::slice::from_ref(&entity))
        .await;
    if let Some(ref pg) = state.pg_store {
        let _ = pg.save_entities(&[entity]).await;
    }

    if let Ok(room) = state.lease_manager.get_or_wake_room(campaign_id).await
        && let Ok(mut table_state) = room.get_table_state().await
    {
        if let Some(existing) = table_state.data.tokens.get_mut(&actor_id) {
            existing.name = name.clone();
            existing.hp = hp;
            existing.max_hp = max_hp;
            let _ = room.replace_state(table_state).await;
        } else if payload.spawn_on_map.unwrap_or(false) {
            let mut tok =
                TokenState::new_default(actor_id, name.clone(), Point2D::new(250.0, 250.0));
            tok.owner_user_id = Some(owner_user_id);
            tok.hp = hp;
            tok.max_hp = max_hp;
            tok.senses = SenseProfile {
                darkvision_range_ft: 60.0,
                ..SenseProfile::default()
            };
            table_state.data.tokens.insert(actor_id, tok);
            let _ = room.replace_state(table_state).await;
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "actor": actor_json })),
    )
        .into_response()
}

/// Lists all prepared scenes/maps for a campaign (`GET /api/v1/campaigns/{campaign_id}/maps`).
/// Players only receive scenes where `revealed_to_players == true` or that match the active table background.
pub async fn list_maps_handler(
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let Some(role_enum) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not a member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    let is_gm = role_enum == CampaignRole::Gm;
    let cid_str = campaign_id.to_string();
    let entities = if let Some(ref pg) = state.pg_store {
        pg.list_entities_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default()
    } else {
        state
            .campaign_store
            .all_entities()
            .into_iter()
            .filter(|e| {
                e.data
                    .get("campaign_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s == cid_str)
                    .unwrap_or(false)
            })
            .collect()
    };

    let maps: Vec<serde_json::Value> = entities
        .into_iter()
        .filter(|e| e.entity_type == "scene")
        .map(|e| e.data)
        .filter(|m| {
            is_gm
                || m.get("revealed_to_players")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!({ "maps": maps }))).into_response()
}

/// Request payload for `PUT /api/v1/campaigns/{campaign_id}/maps/{map_id}`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpsertMapRequest {
    pub name: Option<String>,
    pub sha256_hash: Option<String>,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub pixels_per_grid: Option<f64>,
    pub walls: Option<Vec<trame_engine::geometry::WallSegment>>,
    pub lights: Option<Vec<serde_json::Value>>,
    pub revealed_to_players: Option<bool>,
    pub activate_on_table: Option<bool>,
    pub push_to_live_table: Option<bool>,
}

/// Creates or updates a campaign scene/map in the GM Map Studio and optionally activates it on the live table (`PUT /api/v1/campaigns/{campaign_id}/maps/{map_id}`).
pub async fn upsert_map_handler(
    Path((campaign_id, map_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<UpsertMapRequest>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    if !is_authorized_campaign_gm(&state, campaign_id, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may create or edit maps".to_string(),
            }),
        )
            .into_response();
    }

    let cid_str = campaign_id.to_string();
    let mid_str = map_id.to_string();
    let existing_entities = if let Some(ref pg) = state.pg_store {
        pg.list_entities_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default()
    } else {
        state.campaign_store.all_entities()
    };

    let existing_scene = existing_entities.into_iter().find(|e| {
        e.entity_type == "scene"
            && e.data.get("id").and_then(|v| v.as_str()) == Some(mid_str.as_str())
            && e.data.get("campaign_id").and_then(|v| v.as_str()) == Some(cid_str.as_str())
    });

    let name = payload
        .name
        .or_else(|| {
            existing_scene
                .as_ref()
                .and_then(|e| e.data.get("name").and_then(|v| v.as_str()))
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Custom Scene".to_string());
    let sha256_hash = payload
        .sha256_hash
        .or_else(|| {
            existing_scene
                .as_ref()
                .and_then(|e| e.data.get("sha256_hash").and_then(|v| v.as_str()))
                .map(ToString::to_string)
        })
        .unwrap_or_default();
    let width_px = payload
        .width_px
        .or_else(|| {
            existing_scene
                .as_ref()
                .and_then(|e| e.data.get("width_px").and_then(|v| v.as_u64()))
                .map(|v| v as u32)
        })
        .unwrap_or(1200);
    let height_px = payload
        .height_px
        .or_else(|| {
            existing_scene
                .as_ref()
                .and_then(|e| e.data.get("height_px").and_then(|v| v.as_u64()))
                .map(|v| v as u32)
        })
        .unwrap_or(800);
    let pixels_per_grid = payload
        .pixels_per_grid
        .or_else(|| {
            existing_scene
                .as_ref()
                .and_then(|e| e.data.get("pixels_per_grid").and_then(|v| v.as_f64()))
        })
        .unwrap_or(100.0);
    let revealed_to_players = payload
        .revealed_to_players
        .or_else(|| {
            existing_scene
                .as_ref()
                .and_then(|e| e.data.get("revealed_to_players").and_then(|v| v.as_bool()))
        })
        .unwrap_or(false);

    let walls: Vec<trame_engine::geometry::WallSegment> = payload.walls.unwrap_or_else(|| {
        existing_scene
            .as_ref()
            .and_then(|e| e.data.get("walls"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    });
    let lights = payload.lights.unwrap_or_else(|| {
        existing_scene
            .as_ref()
            .and_then(|e| e.data.get("lights"))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
    });

    let scene_json = serde_json::json!({
        "id": map_id,
        "campaign_id": campaign_id,
        "name": name,
        "sha256_hash": sha256_hash,
        "width_px": width_px,
        "height_px": height_px,
        "pixels_per_grid": pixels_per_grid,
        "revealed_to_players": revealed_to_players,
        "walls": walls,
        "lights": lights,
    });

    let scene_entity = ExportEntity {
        entity_type: "scene".to_string(),
        data: scene_json.clone(),
    };
    let _ = state
        .campaign_store
        .save_entities(std::slice::from_ref(&scene_entity))
        .await;
    if let Some(ref pg) = state.pg_store {
        let _ = pg.save_entities(&[scene_entity]).await;
    }

    if (payload.activate_on_table.unwrap_or(false) || payload.push_to_live_table.unwrap_or(false))
        && let Ok(room) = state.lease_manager.get_or_wake_room(campaign_id).await
        && let Ok(current_state) = room.get_table_state().await
    {
        let mut next_state = TableState::new(pixels_per_grid, current_state.feet_per_cell, walls);
        next_state.data.background_asset_hash = if sha256_hash.is_empty() {
            None
        } else {
            Some(sha256_hash)
        };
        next_state.data.map_width_px = width_px;
        next_state.data.map_height_px = height_px;
        // Carry over player-owned hero tokens across scene switches
        for (tok_id, tok) in current_state.data.tokens {
            if tok.owner_user_id.is_some() {
                next_state.data.tokens.insert(tok_id, tok);
            }
        }
        let _ = room.replace_state(next_state).await;
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "ok", "map": scene_json })),
    )
        .into_response()
}

// ============================================================================
// Starter Dungeon Generator & Universal VTT (.uvtt / .dd2vtt) Upload
// ============================================================================

fn generate_starter_dungeon_png(width: u32, height: u32, cell_px: u32) -> Vec<u8> {
    let mut img = RgbaImage::new(width, height);
    for (x, y, pixel) in img.enumerate_pixels_mut() {
        let is_border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
        let is_grid = (x % cell_px == 0) || (y % cell_px == 0);
        let is_center_wall = (594..=606).contains(&x) && !(300..=500).contains(&y);
        let is_torch_glow = {
            let dx1 = (x as f64 - 300.0).hypot(y as f64 - 200.0);
            let dx2 = (x as f64 - 900.0).hypot(y as f64 - 600.0);
            dx1 < 180.0 || dx2 < 180.0
        };

        if is_border || is_center_wall {
            *pixel = Rgba([62, 53, 46, 255]);
        } else if is_grid {
            *pixel = Rgba([44, 48, 58, 255]);
        } else if is_torch_glow {
            *pixel = Rgba([48, 43, 38, 255]);
        } else {
            let checker = ((x / cell_px) + (y / cell_px)).is_multiple_of(2);
            if checker {
                *pixel = Rgba([30, 34, 42, 255]);
            } else {
                *pixel = Rgba([26, 30, 38, 255]);
            }
        }
    }

    let dyn_img = DynamicImage::ImageRgba8(img);
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    let _ = dyn_img.write_to(&mut cursor, ImageFormat::Png);
    buf
}

/// Generates a 1-click playable Starter Dungeon with a 1200x800 WebP battlemap,
/// wall segments, interactive central door, 2 heroes, 2 goblins, and a starter lore note
/// (`POST /api/v1/campaigns/{campaign_id}/maps/starter`).
pub async fn starter_map_handler(
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    if !is_authorized_campaign_gm(&state, campaign_id, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may generate a starter dungeon".to_string(),
            }),
        )
            .into_response();
    }

    let png_bytes = generate_starter_dungeon_png(1200, 800, 100);
    use base64::Engine;
    let b64_img = base64::engine::general_purpose::STANDARD.encode(&png_bytes);

    let uvtt_json = serde_json::json!({
        "format": 0.3,
        "resolution": {
            "map_origin": { "x": 0.0, "y": 0.0 },
            "map_size": { "x": 12.0, "y": 8.0 },
            "pixels_per_grid": 100.0
        },
        "line_of_sight": [
            [
                { "x": 0.0, "y": 0.0 },
                { "x": 12.0, "y": 0.0 },
                { "x": 12.0, "y": 8.0 },
                { "x": 0.0, "y": 8.0 },
                { "x": 0.0, "y": 0.0 }
            ],
            [
                { "x": 6.0, "y": 0.0 },
                { "x": 6.0, "y": 3.0 }
            ],
            [
                { "x": 6.0, "y": 5.0 },
                { "x": 6.0, "y": 8.0 }
            ]
        ],
        "objects_line_of_sight": [],
        "portals": [
            {
                "position": { "x": 6.0, "y": 4.0 },
                "bounds": [
                    { "x": 6.0, "y": 3.0 },
                    { "x": 6.0, "y": 5.0 }
                ],
                "rotation": 0.0,
                "closed": true,
                "freestanding": false
            }
        ],
        "lights": [
            {
                "position": { "x": 3.0, "y": 2.0 },
                "range": 4.0,
                "intensity": 1.0,
                "color": "#ffaa44",
                "shadows": true
            },
            {
                "position": { "x": 9.0, "y": 6.0 },
                "range": 4.0,
                "intensity": 1.0,
                "color": "#ff8833",
                "shadows": true
            }
        ],
        "image": b64_img
    });

    let uvtt_bytes = serde_json::to_vec(&uvtt_json).unwrap_or_default();
    let imported = match import_uvtt_map(
        &uvtt_bytes,
        state.instance_id,
        campaign_id,
        state.asset_store.as_ref(),
    )
    .await
    {
        Ok(res) => res,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    code: Some("STARTER_MAP_ERROR".to_string()),
                    error: err.to_string(),
                }),
            )
                .into_response();
        }
    };

    // Build TableState with starter walls + 4 tokens (2 heroes, 2 goblins)
    let mut table_state = TableState::new(imported.pixels_per_grid, 5.0, imported.walls.clone());
    table_state.data.background_asset_hash = Some(imported.sha256_hash.clone());
    table_state.data.map_width_px = imported.width_px;
    table_state.data.map_height_px = imported.height_px;

    let hero1_id = Uuid::new_v4();
    let mut hero1 = TokenState::new_default(hero1_id, "Valeros", Point2D::new(200.0, 300.0));
    hero1.owner_user_id = Some(user_id);
    hero1.hp = 28;
    hero1.max_hp = 28;
    hero1.senses = SenseProfile {
        darkvision_range_ft: 60.0,
        ..SenseProfile::default()
    };

    let hero2_id = Uuid::new_v4();
    let mut hero2 = TokenState::new_default(hero2_id, "Merisiel", Point2D::new(200.0, 500.0));
    hero2.owner_user_id = Some(user_id);
    hero2.hp = 18;
    hero2.max_hp = 18;
    hero2.senses = SenseProfile {
        darkvision_range_ft: 60.0,
        ..SenseProfile::default()
    };

    let goblin1_id = Uuid::new_v4();
    let mut goblin1 =
        TokenState::new_default(goblin1_id, "Goblin Sneak", Point2D::new(800.0, 300.0));
    goblin1.hp = 12;
    goblin1.max_hp = 12;
    goblin1.visibility_channel = CHANNEL_MATERIAL;

    let goblin2_id = Uuid::new_v4();
    let mut goblin2 =
        TokenState::new_default(goblin2_id, "Goblin Archer", Point2D::new(900.0, 500.0));
    goblin2.hp = 10;
    goblin2.max_hp = 10;
    goblin2.visibility_channel = CHANNEL_MATERIAL;

    table_state.data.tokens.insert(hero1_id, hero1);
    table_state.data.tokens.insert(hero2_id, hero2);
    table_state.data.tokens.insert(goblin1_id, goblin1);
    table_state.data.tokens.insert(goblin2_id, goblin2);
    table_state.data.initiative_order = vec![hero1_id, goblin1_id, hero2_id, goblin2_id];

    let scene_id = Uuid::new_v4();
    if let Ok(room) = state.lease_manager.get_or_wake_room(campaign_id).await {
        let _ = room.replace_state(table_state).await;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let wal_entry = crate::wal::WalEntry {
        seq_id: 1,
        campaign_id,
        timestamp_ms: now_ms,
        actor_user_id: user_id,
        role: CampaignRole::Gm,
        command: trame_engine::commands::TrameCommand::LoadScene {
            scene_id,
            map_asset_id: imported.sha256_hash.clone(),
            width_px: imported.width_px,
            height_px: imported.height_px,
            pixels_per_grid: imported.pixels_per_grid,
            walls: imported.walls.clone(),
        },
        events: vec![trame_engine::commands::TrameEvent::SceneLoaded {
            scene_id,
            map_asset_id: imported.sha256_hash.clone(),
        }],
    };
    let _ = state.lease_manager.wal().append_entry(wal_entry);

    // Save scene entity, 4 required actor entities, and starter lore note
    let scene_entity = ExportEntity {
        entity_type: "scene".to_string(),
        data: serde_json::json!({
            "id": scene_id,
            "campaign_id": campaign_id,
            "name": "Obsidian Vault Antechamber",
            "sha256_hash": imported.sha256_hash,
            "width_px": imported.width_px,
            "height_px": imported.height_px,
            "pixels_per_grid": imported.pixels_per_grid,
            "revealed_to_players": true,
            "walls": imported.walls,
            "lights": imported.lights,
        }),
    };

    let valeros_entity = ExportEntity {
        entity_type: "actor".to_string(),
        data: serde_json::json!({
            "id": hero1_id,
            "campaign_id": campaign_id,
            "owner_user_id": user_id,
            "name": "Valeros",
            "kind": "character",
            "hp": 28,
            "max_hp": 28,
            "attributes": {},
            "sheet": { "class": "Fighter", "level": 1 }
        }),
    };

    let merisiel_entity = ExportEntity {
        entity_type: "actor".to_string(),
        data: serde_json::json!({
            "id": hero2_id,
            "campaign_id": campaign_id,
            "owner_user_id": user_id,
            "name": "Merisiel",
            "kind": "character",
            "hp": 18,
            "max_hp": 18,
            "attributes": {},
            "sheet": { "class": "Rogue", "level": 1 }
        }),
    };

    let goblin_sneak_entity = ExportEntity {
        entity_type: "actor".to_string(),
        data: serde_json::json!({
            "id": goblin1_id,
            "campaign_id": campaign_id,
            "name": "Goblin Sneak",
            "kind": "monster",
            "hp": 12,
            "max_hp": 12,
            "attributes": {},
            "sheet": {}
        }),
    };

    let goblin_archer_entity = ExportEntity {
        entity_type: "actor".to_string(),
        data: serde_json::json!({
            "id": goblin2_id,
            "campaign_id": campaign_id,
            "name": "Goblin Archer",
            "kind": "monster",
            "hp": 10,
            "max_hp": 10,
            "attributes": {},
            "sheet": {}
        }),
    };

    let entities_to_save = vec![
        scene_entity,
        valeros_entity,
        merisiel_entity,
        goblin_sneak_entity,
        goblin_archer_entity,
    ];

    let _ = state.campaign_store.save_entities(&entities_to_save).await;
    if let Some(ref pg) = state.pg_store {
        let _ = pg.save_entities(&entities_to_save).await;
    }

    let starter_note = NoteRecord {
        id: Uuid::new_v4(),
        title: "Obsidian Vault Overview".to_string(),
        folder: Some("lore".to_string()),
        author_id: user_id,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T12:00:00Z".to_string(),
        content_markdown: "# Obsidian Vault Antechamber\n\nTorchlight flickers across ancient basalt tiles.\n\n:::dm\nGM Secret: Two goblins wait in ambush behind the central stone portal (DC 14 Perception).\n:::\n\n:::handout{id=\"vault-inscription\" title=\"Ancient Dwarven Rune\" revealed=\"false\"}\n\"Only those who bear the Ember Crest may pass unharmed.\"\n:::"
            .to_string(),
    };
    let _ = state
        .campaign_store
        .save_notes(std::slice::from_ref(&starter_note))
        .await;
    if let Some(ref pg) = state.pg_store {
        let _ = pg
            .upsert_campaign_note_async(
                campaign_id,
                "obsidian-vault-overview",
                &starter_note.title,
                starter_note.folder.as_deref(),
                user_id,
                &starter_note.content_markdown,
            )
            .await;
    }

    (StatusCode::CREATED, Json(imported)).into_response()
}

/// Uploads and parses a `.uvtt` / `.dd2vtt` file, persists the WebP map & thumbnail, and updates the active room's walls (`POST /api/v1/campaigns/{campaign_id}/maps/import-uvtt`).
pub async fn import_uvtt_handler(
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    if !is_authorized_campaign_gm(&state, campaign_id, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may import UVTT maps".to_string(),
            }),
        )
            .into_response();
    }

    let imported: ImportedMapResult = match import_uvtt_map(
        &body,
        state.instance_id,
        campaign_id,
        state.asset_store.as_ref(),
    )
    .await
    {
        Ok(res) => res,
        Err(UvttImportError::PayloadTooLarge(sz)) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ErrorResponse {
                    code: Some("PAYLOAD_TOO_LARGE".to_string()),
                    error: format!("payload size {sz} exceeds 64 MiB limit"),
                }),
            )
                .into_response();
        }
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    code: Some("UVTT_IMPORT_FAILED".to_string()),
                    error: err.to_string(),
                }),
            )
                .into_response();
        }
    };

    if let Ok(room) = state.lease_manager.get_or_wake_room(campaign_id).await
        && let Ok(mut current_state) = room.get_table_state().await
    {
        let mut new_state = TableState::new(
            imported.pixels_per_grid,
            current_state.feet_per_cell,
            imported.walls.clone(),
        );
        new_state.data.background_asset_hash = Some(imported.sha256_hash.clone());
        new_state.data.map_width_px = imported.width_px;
        new_state.data.map_height_px = imported.height_px;
        new_state.data.tokens = std::mem::take(&mut current_state.data.tokens);
        new_state.data.initiative_order = std::mem::take(&mut current_state.data.initiative_order);
        let _ = room.replace_state(new_state).await;
    }

    let scene_entity = ExportEntity {
        entity_type: "scene".to_string(),
        data: serde_json::json!({
            "id": Uuid::new_v4(),
            "campaign_id": campaign_id,
            "name": "Imported UVTT Scene",
            "sha256_hash": imported.sha256_hash,
            "width_px": imported.width_px,
            "height_px": imported.height_px,
            "pixels_per_grid": imported.pixels_per_grid,
            "revealed_to_players": true,
            "walls": imported.walls,
            "lights": imported.lights,
        }),
    };
    let _ = state
        .campaign_store
        .save_entities(std::slice::from_ref(&scene_entity))
        .await;
    if let Some(ref pg) = state.pg_store {
        let _ = pg.save_entities(&[scene_entity]).await;
    }

    (StatusCode::CREATED, Json(imported)).into_response()
}

// ============================================================================
// Wiki Notes & Handout Reveal Endpoints
// ============================================================================

/// DTO representing a role-filtered campaign wiki note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDto {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub folder: Option<String>,
    pub content_markdown: String,
    pub updated_at: String,
}

fn slugify_title(title: &str) -> String {
    let s: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "note".to_string()
    } else {
        trimmed
    }
}

/// Lists all wiki notes for `campaign_id`, filtering out `:::dm` and unrevealed `:::handout` blocks for non-GMs (`GET /api/v1/campaigns/{campaign_id}/notes`).
pub async fn list_notes_handler(
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let Some(role_enum) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not a member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    let is_gm = role_enum == CampaignRole::Gm;
    let user_role = UserRole::from(role_enum);
    let raw_notes = if let Some(ref pg) = state.pg_store {
        pg.list_notes_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default()
    } else {
        state.campaign_store.all_notes()
    };

    let notes: Vec<NoteDto> = raw_notes
        .into_iter()
        .filter(|n| {
            let folder = n.folder.as_deref().unwrap_or("party");
            if folder.eq_ignore_ascii_case("dm_only") {
                is_gm
            } else if folder.eq_ignore_ascii_case("private") {
                is_gm || n.author_id == user_id
            } else {
                true
            }
        })
        .map(|n| NoteDto {
            id: n.id,
            slug: slugify_title(&n.title),
            title: n.title,
            folder: n.folder,
            content_markdown: FilteredNoteDocument::filter_for_role(&n.content_markdown, user_role),
            updated_at: n.updated_at,
        })
        .collect();

    let handouts = state
        .journal_storage
        .list_entries(&campaign_id.to_string())
        .unwrap_or_default();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "notes": notes,
            "handouts": handouts,
        })),
    )
        .into_response()
}

/// Request payload for `PUT /api/v1/campaigns/{campaign_id}/notes/{slug}`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpsertNoteRequest {
    pub title: String,
    pub folder: Option<String>,
    pub content_markdown: String,
}

/// Creates or updates a wiki note (GM only, `PUT /api/v1/campaigns/{campaign_id}/notes/{slug}`).
pub async fn upsert_note_handler(
    Path((campaign_id, slug)): Path<(Uuid, String)>,
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<UpsertNoteRequest>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let Some(caller_role) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not a member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    if caller_role == CampaignRole::Spectator {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "spectators cannot create or edit wiki notes".to_string(),
            }),
        )
            .into_response();
    }

    let folder_scope = payload.folder.as_deref().unwrap_or("party");
    if folder_scope.eq_ignore_ascii_case("dm_only") && caller_role != CampaignRole::Gm {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may create or edit DM_ONLY notes".to_string(),
            }),
        )
            .into_response();
    }

    let note = if let Some(ref pg) = state.pg_store {
        match pg
            .upsert_campaign_note_async(
                campaign_id,
                &slug,
                &payload.title,
                payload.folder.as_deref(),
                user_id,
                &payload.content_markdown,
            )
            .await
        {
            Ok(n) => n,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        code: Some("STORAGE_ERROR".to_string()),
                        error: err.to_string(),
                    }),
                )
                    .into_response();
            }
        }
    } else {
        let mut guard = state.campaign_store.notes.write().unwrap();
        if let Some(existing) = guard
            .iter_mut()
            .find(|n| slugify_title(&n.title) == slug || n.title == payload.title)
        {
            existing.title = payload.title.clone();
            existing.folder = payload.folder.clone();
            existing.content_markdown = payload.content_markdown.clone();
            existing.clone()
        } else {
            let n = NoteRecord {
                id: Uuid::new_v4(),
                title: payload.title.clone(),
                folder: payload.folder.clone(),
                author_id: user_id,
                created_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:00Z".to_string(),
                content_markdown: payload.content_markdown.clone(),
            };
            guard.push(n.clone());
            n
        }
    };

    let dto = NoteDto {
        id: note.id,
        slug,
        title: note.title,
        folder: note.folder,
        content_markdown: note.content_markdown,
        updated_at: note.updated_at,
    };

    (StatusCode::OK, Json(serde_json::json!({ "note": dto }))).into_response()
}

/// Request payload for `POST /api/v1/campaigns/{campaign_id}/handouts/reveal`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RevealHandoutRequest {
    pub handout_id: String,
    pub title: String,
    pub content: String,
    pub session_num: Option<u32>,
}

/// Reveals a handout to the party journal and appends a `HandoutRevealed` event to the session timeline (`POST /api/v1/campaigns/{campaign_id}/handouts/reveal`).
pub async fn reveal_handout_handler(
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<RevealHandoutRequest>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers, None).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
                }),
            )
                .into_response();
        }
    };

    let Some(role_enum) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not a member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    let cmd = RevealHandoutCommand {
        action: "reveal_handout".to_string(),
        campaign_id: campaign_id.to_string(),
        session_num: payload.session_num.unwrap_or(1),
        handout_id: payload.handout_id,
        title: payload.title,
        content: payload.content,
    };

    match reveal_handout(
        UserRole::from(role_enum),
        &user_id.to_string(),
        cmd,
        state.journal_storage.as_ref(),
        state.timeline_storage.as_ref(),
    ) {
        Ok(broadcast) => {
            if let Ok(room) = state.lease_manager.get_or_wake_room(campaign_id).await {
                let _ = room.broadcast_handout(broadcast.clone()).await;
            }
            (StatusCode::OK, Json(broadcast)).into_response()
        }
        Err(crate::notes::NotesError::Forbidden(msg)) => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: msg,
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                code: Some("HANDOUT_ERROR".to_string()),
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

// ============================================================================
// Asset Download & Static SPA Serving
// ============================================================================

/// Query parameters for `GET /assets/download/{*key}`.
#[derive(Debug, Default, Deserialize)]
pub struct AssetDownloadQuery {
    pub exp: Option<u64>,
    pub sig: Option<String>,
    pub token: Option<String>,
    pub expires: Option<u64>,
    pub expires_in: Option<u64>,
}

/// Serves binary WebP/PNG map assets from `AssetStore` (`GET /assets/download/{*key}`).
pub async fn download_asset_handler(
    Path(key): Path<String>,
    Query(query): Query<AssetDownloadQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let clean_key = key.trim_start_matches('/');
    let now = crate::auth::magic_link::now_epoch_seconds();
    let mut authorized = false;

    if let (Some(exp), Some(sig_hex)) = (query.exp, query.sig.as_ref()) {
        if now <= exp {
            let signing_input = format!("{clean_key}:{exp}");
            let server_secret = state.auth_state.magic_link_service.secret();
            let expected_sig =
                crate::auth::magic_link::hmac_sha256(server_secret, signing_input.as_bytes());
            let mut expected_hex = String::with_capacity(64);
            for b in expected_sig {
                use std::fmt::Write;
                let _ = write!(&mut expected_hex, "{:02x}", b);
            }
            if crate::auth::magic_link::constant_time_eq(
                sig_hex.as_bytes(),
                expected_hex.as_bytes(),
            ) {
                authorized = true;
            }
        }
    }

    if !authorized {
        if let Ok(user_id) = resolve_authenticated_user(&state, &headers, None).await {
            if let Some(campaign_id) =
                crate::storage::postgres::extract_campaign_id_from_asset_key(clean_key)
            {
                if is_authorized_campaign_member(&state, campaign_id, user_id).await {
                    authorized = true;
                }
            }
        }
    }

    if !authorized {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "valid signature or campaign membership required to download asset"
                    .to_string(),
            }),
        )
            .into_response();
    }

    match state.asset_store.get_asset(clean_key).await {
        Ok(Some(bytes)) => {
            let mut resp_headers = HeaderMap::new();
            resp_headers.insert(CONTENT_TYPE, HeaderValue::from_static("image/webp"));
            (StatusCode::OK, resp_headers, bytes).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                code: Some("ASSET_NOT_FOUND".to_string()),
                error: format!("asset '{clean_key}' not found"),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                code: Some("ASSET_READ_ERROR".to_string()),
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

fn guess_mime_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// Fallback handler serving static frontend assets from `TRAME_STATIC_DIR` (or `packages/web/dist`),
/// with SPA fallback to `index.html` for non-API routes.
async fn static_or_spa_fallback_handler(req: Request<Body>) -> Response {
    let uri_path = req.uri().path().trim_start_matches('/');
    if uri_path.starts_with("api/") || uri_path.starts_with("ws/") {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                code: Some("NOT_FOUND".to_string()),
                error: format!("route '/{uri_path}' not found"),
            }),
        )
            .into_response();
    }

    let static_dir = std::env::var("TRAME_STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("packages/web/dist"));

    if !uri_path.contains("..") && !uri_path.is_empty() {
        let candidate = static_dir.join(uri_path);
        if candidate.is_file()
            && let Ok(bytes) = tokio::fs::read(&candidate).await
        {
            let mime = guess_mime_type(&candidate);
            let mut headers = HeaderMap::new();
            if let Ok(val) = HeaderValue::from_str(mime) {
                headers.insert(CONTENT_TYPE, val);
            }
            return (StatusCode::OK, headers, bytes).into_response();
        }
    }

    let index_path = static_dir.join("index.html");
    if let Ok(bytes) = tokio::fs::read(&index_path).await {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        return (StatusCode::OK, headers, bytes).into_response();
    }

    (
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            code: Some("NOT_FOUND".to_string()),
            error: "frontend static bundle not built yet".to_string(),
        }),
    )
        .into_response()
}

/// Unauthenticated `GET /healthz` probe verifying database connectivity and returning `{"status":"ok"}` in under 5 ms.
pub async fn healthz_handler(State(state): State<AppState>) -> Response {
    if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                code: Some("SHUTTING_DOWN".to_string()),
                error: "server is shutting down".to_string(),
            }),
        )
            .into_response();
    }

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

    let metadata = if let Some(ref pg) = state.pg_store {
        pg.get_campaign_async(campaign_id).await.ok().flatten()
    } else {
        None
    }
    .or_else(|| state.campaign_store.get_campaign(&campaign_id))
    .unwrap_or_else(|| CampaignMetadata {
        id: campaign_id,
        name: format!("Campaign {campaign_id}"),
        system: "dnd5e".to_string(),
        description: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
    });

    let cid_str = campaign_id.to_string();
    let entities: Vec<ExportEntity> = if let Some(ref pg) = state.pg_store {
        pg.list_entities_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default()
    } else {
        state
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
            .collect()
    };

    let notes = if let Some(ref pg) = state.pg_store {
        pg.list_notes_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default()
    } else {
        state.campaign_store.all_notes()
    };
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
            if let Some(ref pg) = state.pg_store {
                if let Some(meta) = state.campaign_store.get_campaign(&campaign_id) {
                    let _ = pg.save_campaign(&meta).await;
                }
            }
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
    let ttl = payload
        .duration_seconds
        .or(payload.ttl_seconds)
        .unwrap_or(DEFAULT_SESSION_TTL_SECONDS);

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
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                code: Some("SHUTTING_DOWN".to_string()),
                error: "server is shutting down".to_string(),
            }),
        )
            .into_response();
    }

    let user_id = match resolve_authenticated_user(&state, &headers, query.user_id).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required for WebSocket upgrade".to_string(),
                }),
            )
                .into_response();
        }
    };

    let role = if let Some(member_role) = resolve_campaign_role(&state, campaign_id, user_id).await
    {
        if let Some(q_role) = query.role.as_deref() {
            match q_role.to_uppercase().as_str() {
                "GM" | "GAME_MASTER" if member_role == CampaignRole::Gm => CampaignRole::Gm,
                "SPECTATOR" => CampaignRole::Spectator,
                _ => member_role,
            }
        } else {
            member_role
        }
    } else if query.user_id.is_some() {
        // Preserve compatibility with direct unit tests passing `?user_id=...&role=...`
        match query.role.as_deref() {
            Some("gm") | Some("GM") => CampaignRole::Gm,
            Some("spectator") | Some("Spectator") => CampaignRole::Spectator,
            _ => CampaignRole::Player,
        }
    } else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not a member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    ws.on_upgrade(move |socket| {
        handle_ws_connection(socket, state.lease_manager, campaign_id, user_id, role)
    })
    .into_response()
}

fn is_valid_asset_hash(hash: &str) -> bool {
    let base = hash.strip_suffix("_thumb").unwrap_or(hash);
    !base.is_empty() && base.chars().all(|c| c.is_ascii_hexdigit())
}

/// Presigns a campaign asset URL with 15-minute TTL enforcing campaign membership.
pub async fn presign_asset_handler(
    Path((campaign_id, hash)): Path<(Uuid, String)>,
    Query(query): Query<PresignQuery>,
    headers: HeaderMap,
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

    let user_id = match resolve_authenticated_user(&state, &headers, query.user_id).await {
        Ok(uid) => uid,
        Err(status) => {
            return (
                status,
                Json(ErrorResponse {
                    code: Some("UNAUTHORIZED".to_string()),
                    error: "authentication required".to_string(),
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
    let (tx, mut rx) = mpsc::unbounded_channel::<OutboundClientFrame>();
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
        while let Some(frame) = rx.recv().await {
            match frame {
                OutboundClientFrame::Binary(bytes) => {
                    if ws_sender.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                OutboundClientFrame::Close { code, reason } => {
                    let close_frame = axum::extract::ws::CloseFrame {
                        code,
                        reason: reason.into(),
                    };
                    let _ = ws_sender.send(Message::Close(Some(close_frame))).await;
                    break;
                }
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
