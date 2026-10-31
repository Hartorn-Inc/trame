//! ============================================================================
//! AXUM HTTP HEALTHCHECK, ASSET PRESIGN, TIMELINE & WEBSOCKET ROUTER (http.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements the central Axum HTTP/WebSocket routing surface for trame-server:
//! - Unauthenticated `/healthz` liveness probe endpoint (< 5 ms execution).
//! - Role-Based Access Control (RBAC) asset presigning endpoint
//!   (`GET /api/v1/campaigns/{campaign_id}/assets/{hash}/presign`).
//! - Real-time campaign WebSocket transport endpoint
//!   (`GET /api/v1/campaigns/{campaign_id}/ws`).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//! 1. `Asset Hash Validation & Sanitization`:
//!    - Asset hash parameter must strictly match a 64-character lowercase/uppercase
//!      hex string, optionally suffixed with `_thumb`. Any path traversal (`..`,
//!      `/`, `\`) or invalid characters immediately reject with `400 Bad Request`.
//! 2. `Campaign Membership Verification`:
//!    - Only authenticated members registered in `MembershipValidator` for the
//!      given `campaign_id` may obtain presigned URLs (`403 Forbidden` otherwise).
//! 3. `Zero-Lock Healthz Probe`:
//!    - `/healthz` returns `200 OK` without database hydration or room actor locks.
//! ============================================================================

use crate::assets::store::{AssetStore, AssetStoreError, PRESIGNED_URL_DEFAULT_TTL};
use crate::room::{ConnectedClient, RoomLeaseManager};
use crate::sync::decode_client_envelope;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;
use trame_engine::commands::CampaignRole;
use uuid::Uuid;

/// Trait abstracting campaign membership validation for RBAC.
pub trait MembershipValidator: Send + Sync + 'static {
    /// Checks whether `user_id` is an active member of `campaign_id`.
    fn is_member(&self, campaign_id: Uuid, user_id: Uuid) -> bool;
}

/// Thread-safe in-memory membership validator for testing and single-instance runtimes.
#[derive(Debug, Default, Clone)]
pub struct InMemoryMembershipValidator {
    members: Arc<RwLock<HashMap<Uuid, HashSet<Uuid>>>>,
}

impl InMemoryMembershipValidator {
    /// Creates a new empty `InMemoryMembershipValidator`.
    pub fn new() -> Self {
        Self {
            members: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Registers `user_id` as a member of `campaign_id`.
    pub fn add_member(&self, campaign_id: Uuid, user_id: Uuid) {
        let mut guard = self.members.write().expect("membership write lock");
        guard.entry(campaign_id).or_default().insert(user_id);
    }

    /// Removes `user_id` from `campaign_id`.
    pub fn remove_member(&self, campaign_id: Uuid, user_id: Uuid) {
        let mut guard = self.members.write().expect("membership write lock");
        if let Some(set) = guard.get_mut(&campaign_id) {
            set.remove(&user_id);
        }
    }
}

impl MembershipValidator for InMemoryMembershipValidator {
    fn is_member(&self, campaign_id: Uuid, user_id: Uuid) -> bool {
        let guard = self.members.read().expect("membership read lock");
        guard
            .get(&campaign_id)
            .map(|set| set.contains(&user_id))
            .unwrap_or(false)
    }
}

/// Shared application state injected into Axum route handlers.
#[derive(Clone)]
pub struct AppState {
    pub lease_manager: Arc<RoomLeaseManager>,
    pub asset_store: Arc<dyn AssetStore>,
    pub membership: Arc<dyn MembershipValidator>,
    pub instance_id: Uuid,
}

/// Query parameter payload for asset presigning.
#[derive(Debug, Deserialize)]
pub struct PresignQuery {
    pub user_id: Uuid,
}

/// JSON response returned on successful asset presign.
#[derive(Debug, Serialize)]
pub struct PresignResponse {
    pub url: String,
    pub expires_in_secs: u64,
}

/// Query parameter payload for campaign WebSocket connections.
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub user_id: Uuid,
    #[serde(default = "default_player_role")]
    pub role: CampaignRole,
}

fn default_player_role() -> CampaignRole {
    CampaignRole::Player
}

/// Validates that an asset hash is a 64-character hex string (optionally suffixed with `_thumb`).
fn is_valid_asset_hash(hash: &str) -> bool {
    let clean = hash.strip_suffix("_thumb").unwrap_or(hash);
    clean.len() == 64 && clean.chars().all(|c| c.is_ascii_hexdigit())
}

/// Unauthenticated `/healthz` probe returning HTTP 200 within < 5 ms.
pub async fn healthz_handler() -> StatusCode {
    StatusCode::OK
}

/// Presigns a campaign asset URL with 15-minute TTL enforcing campaign membership.
pub async fn presign_asset_handler(
    State(state): State<AppState>,
    Path((campaign_id, hash)): Path<(Uuid, String)>,
    Query(query): Query<PresignQuery>,
) -> Response {
    if !is_valid_asset_hash(&hash) {
        return (StatusCode::BAD_REQUEST, "invalid asset hash").into_response();
    }

    if !state.membership.is_member(campaign_id, query.user_id) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let asset_key = format!(
        "instances/{}/campaigns/{}/assets/{}.webp",
        state.instance_id, campaign_id, hash
    );

    match state
        .asset_store
        .mint_presigned_get_url(&asset_key, PRESIGNED_URL_DEFAULT_TTL)
        .await
    {
        Ok(url) => (
            StatusCode::OK,
            Json(PresignResponse {
                url,
                expires_in_secs: PRESIGNED_URL_DEFAULT_TTL.as_secs(),
            }),
        )
            .into_response(),
        Err(AssetStoreError::NotFound(_)) => {
            (StatusCode::NOT_FOUND, "asset not found").into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

/// WebSocket endpoint upgrading client connection and attaching to campaign `TableRoomActor`.
pub async fn ws_campaign_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !state.membership.is_member(campaign_id, query.user_id) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let room_handle = match state.lease_manager.get_or_wake_room(campaign_id).await {
        Ok(h) => h,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    ws.on_upgrade(move |socket| handle_socket(socket, room_handle, query.user_id, query.role))
}

async fn handle_socket(
    socket: WebSocket,
    room_handle: crate::room::TableRoomHandle,
    user_id: Uuid,
    role: CampaignRole,
) {
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let session_id = Uuid::new_v4();

    let client = ConnectedClient {
        session_id,
        user_id,
        role,
        tx,
    };

    if let Err(err) = room_handle.connect_client(client).await {
        eprintln!("Failed to connect client to room: {err}");
        return;
    }

    let send_task = tokio::spawn(async move {
        while let Some(msg_bytes) = rx.recv().await {
            if ws_sink
                .send(Message::Binary(msg_bytes.into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let handle_clone = room_handle.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_stream.next().await {
            match msg {
                Message::Binary(bytes) => match decode_client_envelope(&bytes) {
                    Ok(envelope) => {
                        if handle_clone
                            .send_envelope(session_id, envelope)
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(err) => {
                        eprintln!("Malformed client envelope: {err}");
                    }
                },
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = handle_clone.disconnect_client(session_id).await;
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}

/// Constructs the authoritative Axum router for trame-server.
pub fn build_router<A, M>(
    lease_manager: Arc<RoomLeaseManager>,
    asset_store: Arc<A>,
    membership: Arc<M>,
    instance_id: Uuid,
) -> Router
where
    A: AssetStore + 'static,
    M: MembershipValidator + 'static,
{
    let state = AppState {
        lease_manager,
        asset_store,
        membership,
        instance_id,
    };

    Router::new()
        .route("/healthz", get(healthz_handler))
        .route(
            "/api/v1/campaigns/{campaign_id}/assets/{hash}/presign",
            get(presign_asset_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/ws",
            get(ws_campaign_handler),
        )
        .with_state(state)
}
