//! ============================================================================
//! AXUM HTTP HEALTHCHECK, ASSET PRESIGN, TIMELINE & WEBSOCKET ROUTER (http.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Exposes the HTTP liveness probe (`GET /healthz`), the campaign-scoped asset
//! presigned URL endpoint (`GET /api/v1/campaigns/{campaign_id}/assets/{hash}/presign`),
//! the cursor-paginated session timeline endpoint
//! (`GET /api/campaigns/{campaign_id}/sessions/{session_num}/timeline`), and the
//! binary MessagePack WebSocket upgrade endpoint (`GET /ws/campaigns/{campaign_id}`)
//! backed by `RoomLeaseManager`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Least-Privilege Role Default`:
//!      - `ws_campaign_handler` parses the `role` query parameter and defaults
//!        any unrecognized or omitted role string to `CampaignRole::Player`,
//!        preventing accidental privilege escalation to `CampaignRole::Gm`.
//!   2. `Campaign Membership & Hash Validation on Presigned URLs`:
//!      - `presign_asset_handler` validates hexadecimal asset hashes (`_thumb`
//!        optional suffix) and enforces `CampaignMembershipValidator::is_member`
//!        before minting short-lived presigned GET URLs (`PRESIGNED_URL_DEFAULT_TTL`).
//!   3. `Deterministic Session Cleanup`:
//!      - When the client WebSocket stream closes or errors, the handler
//!        unconditionally invokes `disconnect_client(session_id)` and aborts the
//!        outbound forwarding task so `RoomLeaseManager` accurately tracks zero
//!        active connections for `Idle-Lease` hibernation.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `GET /ws/campaigns/{campaign_id}?user_id=...&role=...`
//!     ├── 1. Resolve `CampaignRole` (`Gm`, `Spectator`, or default `Player`).
//!     ├── 2. Upgrade HTTP connection to WebSocket & call `mgr.get_or_wake_room(campaign_id)`.
//!     ├── 3. Register `ConnectedClient` (triggers immediate `StateSnapshot` binary frame).
//!     ├── 4. Spawn outbound `send_task` forwarding `rx` bytes & read inbound `Message::Binary` frames.
//!     └── 5. On disconnect, remove client session & abort `send_task`.
//! ============================================================================

use crate::assets::store::{
    AssetStore, AssetStoreError, InMemoryAssetStore, PRESIGNED_URL_DEFAULT_TTL,
};
use crate::room::{ConnectedClient, RoomLeaseManager};
use crate::sync::decode_client_envelope;
use crate::timeline::{InMemoryTimelineStorage, SessionTimelineResponse, TimelineStorage};
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;
use trame_engine::commands::CampaignRole;
use uuid::Uuid;

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

/// JSON payload returned by the `GET /healthz` liveness endpoint.
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    /// Static service health status indicator (`"ok"`).
    pub status: &'static str,
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
#[derive(Debug, Serialize)]
pub struct PresignedUrlResponse {
    /// Presigned download URL.
    pub url: String,
    /// Time-to-live in seconds before the URL expires.
    pub expires_in_secs: u64,
}

/// JSON error envelope returned by HTTP endpoints on validation or RBAC rejection.
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    /// Human-readable error message.
    pub error: String,
}

/// Trait checking whether a user is an active member of a campaign.
pub trait CampaignMembershipValidator: Send + Sync {
    /// Returns `true` if `user_id` is an active participant in `campaign_id`.
    fn is_member(&self, campaign_id: Uuid, user_id: Uuid) -> bool;
}

/// Thread-safe in-memory campaign membership validator.
#[derive(Default, Clone)]
pub struct InMemoryMembershipValidator {
    memberships: Arc<RwLock<HashSet<(Uuid, Uuid)>>>,
}

impl InMemoryMembershipValidator {
    /// Creates an empty membership validator.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `user_id` as an active member of `campaign_id`.
    pub fn add_member(&self, campaign_id: Uuid, user_id: Uuid) {
        if let Ok(mut guard) = self.memberships.write() {
            guard.insert((campaign_id, user_id));
        }
    }
}

impl CampaignMembershipValidator for InMemoryMembershipValidator {
    fn is_member(&self, campaign_id: Uuid, user_id: Uuid) -> bool {
        self.memberships
            .read()
            .map(|g| g.contains(&(campaign_id, user_id)))
            .unwrap_or(false)
    }
}

/// Shared application state injected into Axum HTTP and WebSocket handlers.
#[derive(Clone)]
pub struct AppState {
    /// Campaign room lease and hibernation manager.
    pub lease_manager: Arc<RoomLeaseManager>,
    /// Content-addressed WebP asset store.
    pub asset_store: Arc<dyn AssetStore>,
    /// Campaign membership validator for presigned URL RBAC.
    pub membership: Arc<dyn CampaignMembershipValidator>,
    /// Unique identifier of this TRAME server instance.
    pub instance_id: Uuid,
    /// Session timeline event storage backend.
    pub timeline_storage: Arc<dyn TimelineStorage>,
}

/// Type alias preserving compatibility with callers referencing `ServerAppState`.
pub type ServerAppState = AppState;

/// Constructs the Axum `Router` binding `/healthz`, `/ws/campaigns/{campaign_id}`,
/// `/api/v1/campaigns/{campaign_id}/assets/{hash}/presign`, and
/// `/api/campaigns/{campaign_id}/sessions/{session_num}/timeline`.
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

/// Constructs an Axum `Router` with a custom `TimelineStorage` and default in-memory asset store.
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

/// Constructs the full Axum `Router` with all storage and RBAC dependencies injected.
pub fn build_full_router(
    lease_manager: Arc<RoomLeaseManager>,
    asset_store: Arc<dyn AssetStore>,
    membership: Arc<dyn CampaignMembershipValidator>,
    instance_id: Uuid,
    timeline_storage: Arc<dyn TimelineStorage>,
) -> Router {
    let state = AppState {
        lease_manager,
        asset_store,
        membership,
        instance_id,
        timeline_storage,
    };

    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/ws/campaigns/{campaign_id}", get(ws_campaign_handler))
        .route(
            "/api/v1/campaigns/{campaign_id}/assets/{hash}/presign",
            get(presign_asset_handler),
        )
        .route(
            "/api/campaigns/{campaign_id}/sessions/{session_num}/timeline",
            get(timeline_handler),
        )
        .with_state(state)
}

async fn healthz_handler(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        active_rooms: state.lease_manager.active_room_count().await,
    })
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

async fn ws_campaign_handler(
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

async fn presign_asset_handler(
    Path((campaign_id, hash)): Path<(Uuid, String)>,
    Query(query): Query<PresignQuery>,
    State(state): State<AppState>,
) -> Response {
    if !is_valid_asset_hash(&hash) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid asset hash format".to_string(),
            }),
        )
            .into_response();
    }

    if !state.membership.is_member(campaign_id, query.user_id) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
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
                error: format!("asset with hash '{hash}' not found"),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
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
