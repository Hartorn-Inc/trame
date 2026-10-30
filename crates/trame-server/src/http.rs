//! ============================================================================
//! AXUM HTTP HEALTHCHECK & WEBSOCKET UPGRADE ROUTER (http.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Exposes the HTTP liveness probe (`GET /healthz`) and the binary MessagePack
//! WebSocket upgrade endpoint (`GET /ws/campaigns/{campaign_id}`) backed by
//! `RoomLeaseManager`. Manages the full per-connection lifecycle from initial
//! room wake-up and snapshot push to clean session teardown on socket close.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Least-Privilege Role Default`:
//!      - `ws_campaign_handler` parses the `role` query parameter and defaults
//!        any unrecognized or omitted role string to `CampaignRole::Player`,
//!        preventing accidental privilege escalation to `CampaignRole::Gm`.
//!   2. `Binary MessagePack Frame Discipline`:
//!      - `handle_ws_connection` ignores malformed or non-binary WebSocket frames
//!        (`decode_client_envelope`) without crashing the room actor.
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

use crate::room::{ConnectedClient, RoomLeaseManager};
use crate::sync::decode_client_envelope;
use crate::timeline::{InMemoryTimelineStorage, SessionTimelineResponse, TimelineStorage};
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
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

/// Shared application state injected into Axum HTTP and WebSocket handlers.
#[derive(Clone)]
pub struct ServerAppState {
    /// Campaign room lease and hibernation manager.
    pub lease_manager: Arc<RoomLeaseManager>,
    /// Session timeline event storage backend.
    pub timeline_storage: Arc<dyn TimelineStorage>,
}

/// Constructs the Axum `Router` binding `/healthz`, `/ws/campaigns/{campaign_id}`,
/// and `/api/campaigns/{campaign_id}/sessions/{session_num}/timeline`.
pub fn build_router(lease_manager: Arc<RoomLeaseManager>) -> Router {
    let timeline_storage: Arc<dyn TimelineStorage> = Arc::new(InMemoryTimelineStorage::new());
    build_app_router(lease_manager, timeline_storage)
}

pub fn build_app_router(
    lease_manager: Arc<RoomLeaseManager>,
    timeline_storage: Arc<dyn TimelineStorage>,
) -> Router {
    let state = ServerAppState {
        lease_manager,
        timeline_storage,
    };
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/ws/campaigns/{campaign_id}", get(ws_campaign_handler))
        .route(
            "/api/campaigns/{campaign_id}/sessions/{session_num}/timeline",
            get(timeline_handler),
        )
        .with_state(state)
}

async fn healthz_handler(State(state): State<ServerAppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        active_rooms: state.lease_manager.active_room_count().await,
    })
}

async fn timeline_handler(
    Path((campaign_id, session_num)): Path<(String, u32)>,
    Query(query): Query<TimelineQuery>,
    State(state): State<ServerAppState>,
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
    State(state): State<ServerAppState>,
) -> impl IntoResponse {
    let role = match query.role.as_deref() {
        Some("gm") | Some("GM") => CampaignRole::Gm,
        Some("spectator") | Some("Spectator") => CampaignRole::Spectator,
        _ => CampaignRole::Player,
    };
    let mgr = state.lease_manager.clone();
    ws.on_upgrade(move |socket| handle_ws_connection(socket, mgr, campaign_id, query.user_id, role))
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
