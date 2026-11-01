//! ============================================================================
//! AXUM HTTP HEALTHCHECK, ARCHIVE, AUTH, ASSET PRESIGN & WEBSOCKET ROUTER (http.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Exposes the authoritative HTTP and WebSocket routing surface for `trame-server`:
//! - Unauthenticated liveness and database connectivity probe (`GET /healthz`, < 5 ms).
//! - Portable `.trame` campaign archive streaming export (`GET /api/v1/campaigns/{campaign_id}/export`).
//! - Portable `.trame` campaign archive streaming import (`POST /api/v1/campaigns/import`), which
//!   always creates a new campaign with remapped IDs owned by the caller (G8).
//! - GM-authorized campaign Magic Link invite minting (`POST /api/v1/campaigns/{campaign_id}/invites`),
//!   the only invite minting route.
//! - Hybrid authentication routes (`/api/v1/auth/magic-link`, `/api/v1/auth/bind-account`,
//!   `/api/v1/auth/pat`, `/api/v1/auth/totp/{setup,enable,verify}`).
//! - Campaign-scoped asset presigned URL endpoint (`GET /api/v1/campaigns/{campaign_id}/assets/{hash}/presign`).
//! - Cursor-paginated session timeline endpoint (`GET /api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline`).
//! - Binary MessagePack WebSocket upgrade endpoint (`GET /ws/campaigns/{campaign_id}`) backed by `RoomLeaseManager`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Credential-Only Identity`:
//!      - Identity comes only from a session cookie, a Bearer session token, or a Bearer PAT
//!        (`resolve_authenticated_user`). No route accepts `?user_id=` or a body `user_id`.
//!      - Campaign roles come only from the authoritative membership store
//!        (`resolve_campaign_role`); the global account role grants nothing (A63).
//!   2. `Campaign Membership & Hash Validation`:
//!      - `presign_asset_handler` validates hexadecimal asset hashes (`_thumb` optional suffix)
//!        and checks membership in the authoritative store before minting presigned GET URLs.
//!      - `export_campaign_handler` verifies membership and exports only entities, notes, and
//!        assets registered to the requested campaign.
//!      - `timeline_handler` requires membership, hides GM-only events from non-GMs, and clamps
//!        `limit` to `1..=MAX_TIMELINE_LIMIT`.
//!   3. `Import Creates, Never Overwrites`:
//!      - `import_campaign_handler` requires a non-guest account, always remaps IDs, and makes
//!        the caller the GM of the new campaign.
//!   4. `WebSocket Hardening`:
//!      - Upgrades require credentials, campaign membership, and an allow-listed `Origin`;
//!        messages and frames are capped at `SecurityPolicy::ws_max_message_bytes`.
//!   5. `Hardening Headers`:
//!      - `security_headers_middleware` wraps the whole router (CSP, `nosniff`, frame denial).
//!   6. `Deterministic Session Cleanup & Sub-5ms Healthz`:
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
//!     ├── 3. `POST /api/v1/campaigns/import` -> non-guest auth -> remapped import -> `201 Created`.
//!     ├── 4. `POST /api/v1/campaigns/{id}/invites` -> verify GM role -> mint JWT & return `201 Created`.
//!     └── 5. `GET /ws/campaigns/{id}` -> auth + Origin + membership -> capped upgrade -> `TableRoomActor`.
//! ============================================================================

use crate::archive::{
    ArchiveError, ArchiveExporter, ArchiveImporter, CampaignExportSource, CampaignImportTarget,
    CampaignMetadata, ExportEntity, InMemoryCampaignStore, NoteRecord, stored_assets,
};
use crate::assets::store::{
    AssetStore, AssetStoreError, InMemoryAssetStore, PRESIGNED_URL_DEFAULT_TTL,
};
use crate::auth::magic_link::MagicLinkService;
use crate::auth::password::extract_session_token;
use crate::auth::pat::PatMiddleware;
use crate::auth::session::{
    AuthState, DEFAULT_SESSION_TTL_SECONDS, FullAuthStore, IdentityStore, InMemorySessionStore,
    SessionStore, build_auth_router, hash_session_token,
};
use crate::auth::totp::TotpService;
use crate::config::ServerConfig;
pub use crate::maps::{InMemoryMapStorage, get_campaign_maps_handler, put_campaign_maps_handler};
use crate::room::{ConnectedClient, IS_SHUTTING_DOWN, OutboundClientFrame, RoomLeaseManager};
use crate::security::security_headers_middleware;
use crate::storage::SqlxPostgresStore;
use crate::storage::blob::{
    AssetDescriptor, BlobStore, BlobStoreError, BlobStream, Sha256Hasher, slice_to_stream,
    stream_to_bytes,
};
use crate::sync::{ClientEnvelope, decode_client_envelope};
use crate::timeline::{
    InMemoryTimelineStorage, SessionTimelineEvent, SessionTimelineResponse, TimelineStorage,
};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, HeaderMap, HeaderValue, ORIGIN};
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
use trame_engine::commands::{CampaignRole, TrameCommand};
use uuid::Uuid;

/// Maximum archive upload size accepted by `POST /api/v1/campaigns/import` (64 MiB).
pub const MAX_ARCHIVE_UPLOAD_BYTES: usize = 64 * 1024 * 1024;

/// Upper bound for `TimelineQuery::limit` (entries per page).
pub const MAX_TIMELINE_LIMIT: usize = 200;

/// Request payload submitted to `POST /api/v1/campaigns/{campaign_id}/invites`.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct CreateCampaignInviteRequest {
    /// Optional character UUID to pre-assign to the invited player.
    pub character_id: Option<Uuid>,
    /// Role granted by the invite (`"PLAYER"`, `"SPECTATOR"`, `"ASSISTANT_GM"`); defaults to `"PLAYER"`.
    pub role: Option<String>,
    /// Invite token time-to-live in seconds; defaults to 7 days (`DEFAULT_SESSION_TTL_SECONDS`).
    pub ttl_seconds: Option<u64>,
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
    stored_assets: Vec<(String, Bytes)>,
}

impl CampaignExportSource for ScopedCampaignExportSource {
    fn stored_assets(&self) -> Vec<(String, Bytes)> {
        self.stored_assets.clone()
    }

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
    /// In-memory storage for campaign map scenes.
    pub map_storage: InMemoryMapStorage,
    /// Authoritative PostgreSQL store when `DATABASE_URL` is configured; `None` keeps the
    /// in-memory fallbacks above as the source of truth.
    pub postgres_store: Option<Arc<SqlxPostgresStore>>,
    /// In-memory campaigns, actors, notes, settings, and journal (used without PostgreSQL).
    pub campaign_data: crate::campaigns::InMemoryCampaignData,
    /// `TRAME_STATIC_DIR`: built SPA served as the router fallback; `None` disables it.
    pub static_dir: Option<std::path::PathBuf>,
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

/// Builds the auth state (invite JWT key, TOTP master key, security policy) from `config`.
fn auth_state_from_config(
    session_store: Arc<dyn FullAuthStore>,
    config: &ServerConfig,
) -> AuthState {
    AuthState::with_security(
        Arc::new(MagicLinkService::new(
            config.secrets.invite_jwt_secret.clone(),
            "trame-server",
        )),
        session_store,
        Arc::new(TotpService::new(
            config.secrets.master_encryption_key,
            "TRAME",
        )),
        config.security.clone(),
    )
}

/// Constructs the full Axum `Router` with default in-memory stores and development config.
pub fn build_full_router(
    lease_manager: Arc<RoomLeaseManager>,
    asset_store: Arc<dyn AssetStore>,
    membership: Arc<dyn CampaignMembershipValidator>,
    instance_id: Uuid,
    timeline_storage: Arc<dyn TimelineStorage>,
) -> Router {
    build_in_memory_router_with_config(
        lease_manager,
        asset_store,
        membership,
        instance_id,
        timeline_storage,
        &ServerConfig::dev(),
    )
}

/// Constructs the full in-memory Axum `Router` with secrets and policy from `config`.
pub fn build_in_memory_router_with_config(
    lease_manager: Arc<RoomLeaseManager>,
    asset_store: Arc<dyn AssetStore>,
    membership: Arc<dyn CampaignMembershipValidator>,
    instance_id: Uuid,
    timeline_storage: Arc<dyn TimelineStorage>,
    config: &ServerConfig,
) -> Router {
    let auth_state = auth_state_from_config(Arc::new(InMemorySessionStore::new()), config);
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
        map_storage: InMemoryMapStorage::new(),
        postgres_store: None,
        campaign_data: Default::default(),
        static_dir: config.static_dir.clone(),
    };
    build_router_with_state(state)
}

/// Constructs the full Axum `Router` backed by PostgreSQL for WAL, sessions, identities,
/// PATs, membership, timeline, and assets.
pub fn build_router_with_postgres_store(
    store: Arc<SqlxPostgresStore>,
    lease_manager: Arc<RoomLeaseManager>,
    instance_id: Uuid,
    config: &ServerConfig,
) -> Router {
    let auth_state = auth_state_from_config(store.clone(), config);
    let state = AppState {
        lease_manager,
        asset_store: store.clone(),
        membership: store.clone(),
        instance_id,
        timeline_storage: store.clone(),
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state,
        db_healthy: Arc::new(AtomicBool::new(true)),
        map_storage: InMemoryMapStorage::new(),
        postgres_store: Some(store),
        campaign_data: Default::default(),
        static_dir: config.static_dir.clone(),
    };
    build_router_with_state(state)
}

/// Lists the notes of `campaign_id` from PostgreSQL when configured, otherwise from the
/// in-memory archive store.
pub async fn list_campaign_notes_internal(state: &AppState, campaign_id: Uuid) -> Vec<NoteRecord> {
    if let Some(pg) = &state.postgres_store {
        return pg
            .list_notes_for_campaign_async(campaign_id)
            .await
            .unwrap_or_default();
    }
    state.campaign_store.notes_for_campaign(campaign_id)
}

/// Path prefixes owned by the API; the SPA fallback never answers them (JSON `404` instead).
/// Only `/assets/download` is reserved: the rest of `/assets/` is the Vite bundle.
const RESERVED_PREFIXES: [&str; 4] = ["/api", "/ws", "/assets/download", "/healthz"];

/// Directory where Vite emits the hashed JS/CSS/WASM bundle. A missing file there is a JSON
/// `404`, never `index.html`, so a stale chunk URL cannot be parsed as JavaScript.
const BUNDLE_PREFIX: &str = "/assets/";

fn is_reserved_path(path: &str) -> bool {
    RESERVED_PREFIXES.iter().any(|prefix| {
        path == *prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Fallback serving the built SPA from `dir` (`ServeDir`, unknown paths -> `index.html`) for
/// client-side routes. Reserved API prefixes get a JSON `404` so they are never shadowed;
/// bundle files under `/assets/` are served without the `index.html` fallback.
fn spa_fallback(
    dir: std::path::PathBuf,
) -> impl Fn(Request<Body>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Response> + Send>>
+ Clone
+ Send
+ Sync
+ 'static {
    use tower::ServiceExt;
    let bundle = tower_http::services::ServeDir::new(&dir);
    let serve = bundle
        .clone()
        .fallback(tower_http::services::ServeFile::new(dir.join("index.html")));
    move |req: Request<Body>| {
        let serve = serve.clone();
        let bundle = bundle.clone();
        Box::pin(async move {
            let not_found =
                || error_response(StatusCode::NOT_FOUND, "NOT_FOUND", "route not found");
            let path = req.uri().path();
            if is_reserved_path(path) {
                return not_found();
            }
            if path.starts_with(BUNDLE_PREFIX) {
                return match bundle.oneshot(req).await {
                    Ok(resp) if resp.status() == StatusCode::NOT_FOUND => not_found(),
                    Ok(resp) => resp.into_response(),
                    Err(never) => match never {},
                };
            }
            match serve.oneshot(req).await {
                Ok(resp) => resp.into_response(),
                Err(never) => match never {},
            }
        })
    }
}

/// Constructs the authoritative Axum `Router` from a pre-configured `AppState`, wrapped in
/// `security_headers_middleware`. Also connects the rooms' storage sinks (linked vitals,
/// timeline) and, when `static_dir` is set, serves the SPA as the last-resort fallback.
pub fn build_router_with_state(state: AppState) -> Router {
    let auth_router = build_auth_router(state.auth_state.clone());
    crate::campaigns::install_room_sinks(&state);
    let static_dir = state.static_dir.clone();

    let router = Router::new()
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
        .route(
            "/api/v1/campaigns/{campaign_id}/maps",
            get(get_campaign_maps_handler).put(put_campaign_maps_handler),
        )
        .route("/api/v1/mcp", post(crate::mcp::mcp_jsonrpc_handler))
        .merge(crate::campaigns::campaign_routes())
        .with_state(state)
        .merge(auth_router);
    let router = match static_dir {
        Some(dir) => router.fallback(spa_fallback(dir)),
        None => router,
    };
    router.layer(axum::middleware::from_fn(security_headers_middleware))
}

/// Resolves an authenticated user ID from a session cookie, Bearer session token, or Bearer PAT.
/// Returns `401` when no valid credential is present.
pub async fn resolve_authenticated_user(
    state: &AppState,
    headers: &HeaderMap,
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

    Err(StatusCode::UNAUTHORIZED)
}

/// Resolves the caller's campaign role from the authoritative membership stores, or `None`
/// for non-members. `GM` maps to `Gm`, `SPECTATOR` to `Spectator`, anything else to `Player`.
pub async fn resolve_campaign_role(
    state: &AppState,
    campaign_id: Uuid,
    user_id: Uuid,
) -> Option<CampaignRole> {
    if let Ok(Some(member)) = state
        .auth_state
        .session_store
        .get_campaign_member(campaign_id, user_id)
        .await
    {
        return Some(match member.role.to_ascii_uppercase().as_str() {
            "GM" => CampaignRole::Gm,
            "SPECTATOR" => CampaignRole::Spectator,
            _ => CampaignRole::Player,
        });
    }
    if state.membership.is_gm(campaign_id, user_id) {
        Some(CampaignRole::Gm)
    } else if state.membership.is_member(campaign_id, user_id) {
        Some(CampaignRole::Player)
    } else {
        None
    }
}

pub(crate) fn error_response(status: StatusCode, code: &str, error: &str) -> Response {
    (
        status,
        Json(ErrorResponse {
            code: Some(code.to_string()),
            error: error.to_string(),
        }),
    )
        .into_response()
}

/// Checks whether `user_id` is an authorized member of `campaign_id` via `membership` or `session_store`.
pub async fn is_authorized_campaign_member(
    state: &AppState,
    campaign_id: Uuid,
    user_id: Uuid,
) -> bool {
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
pub async fn is_authorized_campaign_gm(state: &AppState, campaign_id: Uuid, user_id: Uuid) -> bool {
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
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let user_id = match resolve_authenticated_user(&state, &headers).await {
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

    let fallback_metadata = || CampaignMetadata {
        id: campaign_id,
        name: format!("Campaign {campaign_id}"),
        system: "dnd5e".to_string(),
        description: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
    };
    let mut source = if let Some(pg) = &state.postgres_store {
        let loaded = async {
            Ok::<_, String>(ScopedCampaignExportSource {
                metadata: pg
                    .get_campaign_async(campaign_id)
                    .await?
                    .unwrap_or_else(fallback_metadata),
                entities: pg.list_entities_for_campaign_async(campaign_id).await?,
                notes: pg.list_notes_for_campaign_async(campaign_id).await?,
                asset_ids: state.campaign_store.asset_ids_for_campaign(campaign_id),
                stored_assets: Vec::new(),
            })
        }
        .await;
        match loaded {
            Ok(source) => source,
            Err(err) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, "EXPORT_ERROR", &err);
            }
        }
    } else {
        ScopedCampaignExportSource {
            metadata: state
                .campaign_store
                .get_campaign(&campaign_id)
                .unwrap_or_else(fallback_metadata),
            entities: state.campaign_store.entities_for_campaign(campaign_id),
            notes: state.campaign_store.notes_for_campaign(campaign_id),
            asset_ids: state.campaign_store.asset_ids_for_campaign(campaign_id),
            stored_assets: Vec::new(),
        }
    };
    let entities = std::mem::take(&mut source.entities);
    let completed = async {
        let entities =
            crate::maps::export_entities_with_scenes(&state, campaign_id, entities).await?;
        let entities =
            crate::campaigns::export_entities_with_actors(&state, campaign_id, entities).await?;
        let stored_assets =
            referenced_stored_assets(&state, campaign_id, &entities, &source.notes).await?;
        Ok::<_, String>((entities, stored_assets))
    }
    .await;
    match completed {
        Ok((entities, stored_assets)) => {
            source.entities = entities;
            source.stored_assets = stored_assets;
        }
        Err(err) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "EXPORT_ERROR", &err);
        }
    }

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

/// Loads every content-addressed blob of `campaign_id` referenced by `entities` or `notes`,
/// once per stem. Blobs absent from the store are skipped: import reports them as
/// `missing_asset_keys` instead of the whole export failing.
async fn referenced_stored_assets(
    state: &AppState,
    campaign_id: Uuid,
    entities: &[ExportEntity],
    notes: &[NoteRecord],
) -> Result<Vec<(String, Bytes)>, String> {
    let mut referenced = Vec::new();
    for entity in entities {
        stored_assets::referenced_keys_in_json(&entity.data, campaign_id, &mut referenced);
    }
    for note in notes {
        referenced.extend(stored_assets::referenced_keys(
            &note.content_markdown,
            campaign_id,
        ));
    }
    let mut out: Vec<(String, Bytes)> = Vec::new();
    for (key, stem) in referenced {
        if out.iter().any(|(s, _)| *s == stem) {
            continue;
        }
        match state.asset_store.get_asset(&key).await {
            Ok(Some(bytes)) => out.push((stem, bytes)),
            Ok(None) | Err(AssetStoreError::NotFound(_)) => {
                tracing::warn!(%campaign_id, %key, "referenced asset missing; not exported");
            }
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(out)
}

fn is_client_archive_error(err: &ArchiveError) -> bool {
    matches!(
        err,
        ArchiveError::InvalidManifest(_)
            | ArchiveError::ChecksumMismatch { .. }
            | ArchiveError::UnlistedEntry(_)
            | ArchiveError::LimitExceeded(_)
            | ArchiveError::Zip(_)
            | ArchiveError::Json(_)
    )
}

/// Imports a `.trame` archive stream at `POST /api/v1/campaigns/import` as a brand-new campaign
/// (IDs always remapped, G8) whose GM is the caller. Requires a non-guest account (`401` when
/// unauthenticated, `403` for guests); returns `201 Created` with restoration counters.
pub async fn import_campaign_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    request: Request<Body>,
) -> Response {
    let Ok(caller_user_id) = resolve_authenticated_user(&state, &headers).await else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "valid authentication credentials required",
        );
    };
    match state
        .auth_state
        .session_store
        .get_user_by_id(caller_user_id)
        .await
    {
        Ok(Some(user)) if !user.is_guest => {}
        _ => {
            return error_response(
                StatusCode::FORBIDDEN,
                "GUEST_FORBIDDEN",
                "only registered (non-guest) accounts can create campaigns",
            );
        }
    }

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

    let reader = Cursor::new(body_bytes.to_vec());
    let imported = match &state.postgres_store {
        Some(pg) => {
            ArchiveImporter::new((**pg).clone(), state.blob_store.clone())
                .with_asset_store(state.asset_store.clone(), state.instance_id)
                .import_stream(reader, true)
                .await
        }
        None => {
            ArchiveImporter::new(state.campaign_store.clone(), state.blob_store.clone())
                .with_asset_store(state.asset_store.clone(), state.instance_id)
                .import_stream(reader, true)
                .await
        }
    };

    match imported {
        Ok(result) => {
            let campaign_id = result.campaign_id;
            if state.postgres_store.is_none() {
                let entities = state.campaign_store.entities_for_campaign(campaign_id);
                let scenes = entities
                    .iter()
                    .filter_map(|e| crate::maps::restorable_scene(campaign_id, e))
                    .collect();
                state.map_storage.restore_campaign_maps(campaign_id, scenes);
                if let Err(err) =
                    crate::campaigns::restore_imported_actors(&state, campaign_id, &entities).await
                {
                    return error_response(StatusCode::INTERNAL_SERVER_ERROR, "IMPORT_ERROR", &err);
                }
            }
            state.membership.add_member(campaign_id, caller_user_id);
            if let Err(err) = state
                .auth_state
                .session_store
                .assign_campaign_member(campaign_id, caller_user_id, None, "GM")
                .await
            {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "IMPORT_ERROR",
                    &err.to_string(),
                );
            }
            (StatusCode::CREATED, Json(result)).into_response()
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
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    if let Err(err) = state.auth_state.magic_link_service.validate_secret() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "WEAK_JWT_SECRET",
            &err.to_string(),
        );
    }

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

    let caller_id = match resolve_authenticated_user(&state, &headers).await {
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

    let role = payload
        .role
        .map(|r| r.trim().to_ascii_uppercase())
        .unwrap_or_else(|| "PLAYER".to_string());
    let ttl = payload.ttl_seconds.unwrap_or(DEFAULT_SESSION_TTL_SECONDS);

    match state.auth_state.magic_link_service.create_invite_token(
        caller_id,
        campaign_id,
        payload.character_id,
        &role,
        ttl,
    ) {
        Ok((token, claims)) => {
            let origin = state
                .auth_state
                .security
                .public_origin
                .as_deref()
                .unwrap_or("");
            let invite_url = format!("{origin}/?invite={token}");
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

/// Returns `true` for timeline events only the GM may read: `payload.visibility` of `gm`,
/// `gm_only`, or `gmonly` (case-insensitive), or `payload.gm_only == true`.
pub fn is_gm_only_timeline_event(event: &SessionTimelineEvent) -> bool {
    let visibility_gm = event
        .payload
        .get("visibility")
        .and_then(|v| v.as_str())
        .map(|v| {
            matches!(
                v.to_ascii_lowercase().replace(['_', '-'], "").as_str(),
                "gm" | "gmonly"
            )
        })
        .unwrap_or(false);
    let flag_gm = event
        .payload
        .get("gm_only")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    visibility_gm || flag_gm
}

/// Cursor-paginated session timeline. Requires campaign membership; non-GM members never see
/// GM-only events; `limit` defaults to 50 and is clamped to `1..=MAX_TIMELINE_LIMIT`.
async fn timeline_handler(
    Path((campaign_id, session_num)): Path<(Uuid, u32)>,
    Query(query): Query<TimelineQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let Ok(user_id) = resolve_authenticated_user(&state, &headers).await else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "valid authentication credentials required",
        );
    };
    let Some(role) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return error_response(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "user is not an active member of this campaign",
        );
    };

    let campaign_key = campaign_id.to_string();
    let after_seq = query.after.unwrap_or(0);
    let limit = query.limit.unwrap_or(50).clamp(1, MAX_TIMELINE_LIMIT);
    let mut resp = state
        .timeline_storage
        .get_timeline(&campaign_key, session_num, after_seq, limit)
        .unwrap_or_else(|_| SessionTimelineResponse {
            campaign_id: campaign_key.clone(),
            session_num,
            session_id: format!("{campaign_key}:{session_num}"),
            events: Vec::new(),
            has_more: false,
        });
    resp.events.truncate(limit);
    if role != CampaignRole::Gm {
        resp.events.retain(|e| !is_gm_only_timeline_event(e));
    }
    Json(resp).into_response()
}

/// WebSocket endpoint attaching an authenticated campaign member to the `TableRoomActor`.
///
/// Check order (each fails before the upgrade): shutdown (`503`), `Origin` allow-list (`403`),
/// credentials (`401`), membership (`403`). The role comes from the membership store, never
/// from the client. Messages and frames are capped at `SecurityPolicy::ws_max_message_bytes`.
pub async fn ws_campaign_handler(
    ws: WebSocketUpgrade,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "SHUTTING_DOWN",
            "server is shutting down",
        );
    }

    let policy = state.auth_state.security.clone();
    let origin = headers.get(ORIGIN).map(|v| v.to_str().unwrap_or("\u{0}"));
    if !policy.is_origin_allowed(origin) {
        return error_response(
            StatusCode::FORBIDDEN,
            "ORIGIN_FORBIDDEN",
            "WebSocket origin is not allowed",
        );
    }

    let Ok(user_id) = resolve_authenticated_user(&state, &headers).await else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "valid authentication credentials required",
        );
    };
    let Some(role) = resolve_campaign_role(&state, campaign_id, user_id).await else {
        return error_response(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "user is not an active member of this campaign",
        );
    };

    ws.max_message_size(policy.ws_max_message_bytes)
        .max_frame_size(policy.ws_max_message_bytes)
        .on_upgrade(move |socket| handle_ws_connection(socket, state, campaign_id, user_id, role))
        .into_response()
}

fn is_valid_asset_hash(hash: &str) -> bool {
    let base = hash.strip_suffix("_thumb").unwrap_or(hash);
    !base.is_empty() && base.chars().all(|c| c.is_ascii_hexdigit())
}

/// Presigns a campaign asset URL with 15-minute TTL. The caller must be authenticated and a
/// member of `campaign_id` in the authoritative membership store.
pub async fn presign_asset_handler(
    Path((campaign_id, hash)): Path<(Uuid, String)>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let Ok(user_id) = resolve_authenticated_user(&state, &headers).await else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "valid authentication credentials required",
        );
    };

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

/// Replaces a client `ActivateScene` payload with the stored scene. A failed lookup becomes a
/// command without payload, which the room rejects back to the sender.
async fn resolve_client_envelope(
    state: &AppState,
    campaign_id: Uuid,
    envelope: ClientEnvelope,
) -> ClientEnvelope {
    let ClientEnvelope::SubmitCommand(cmd) = envelope else {
        return envelope;
    };
    let TrameCommand::ActivateScene { scene_id, .. } = *cmd else {
        return ClientEnvelope::SubmitCommand(cmd);
    };
    let resolved = crate::maps::resolve_scene_command(
        state,
        campaign_id,
        TrameCommand::ActivateScene {
            scene_id,
            scene: None,
        },
    )
    .await
    .unwrap_or(TrameCommand::ActivateScene {
        scene_id,
        scene: None,
    });
    ClientEnvelope::SubmitCommand(Box::new(resolved))
}

async fn handle_ws_connection(
    socket: WebSocket,
    state: AppState,
    campaign_id: Uuid,
    user_id: Uuid,
    role: CampaignRole,
) {
    let Ok(room_handle) = state.lease_manager.get_or_wake_room(campaign_id).await else {
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
            let envelope = resolve_client_envelope(&state, campaign_id, envelope).await;
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
    state
        .campaign_store
        .save_entities(campaign.id, &entities)
        .await?;
    state.campaign_store.save_notes(campaign.id, &notes).await?;
    let mut asset_ids = Vec::with_capacity(assets.len());
    for (asset_id, data) in assets {
        state
            .blob_store
            .put_stream(&asset_id.to_string(), slice_to_stream(data))
            .await?;
        asset_ids.push(asset_id);
    }
    state
        .campaign_store
        .save_asset_ids(campaign.id, &asset_ids)
        .await
}
