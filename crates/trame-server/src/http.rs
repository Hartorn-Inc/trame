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

/// Constructs the Axum `Router` binding `/healthz` and `/ws/campaigns/{campaign_id}`
/// to the shared `RoomLeaseManager` state.
pub fn build_router(lease_manager: Arc<RoomLeaseManager>) -> Router {
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/ws/campaigns/{campaign_id}", get(ws_campaign_handler))
        .with_state(lease_manager)
}

async fn healthz_handler(State(mgr): State<Arc<RoomLeaseManager>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        active_rooms: mgr.active_room_count().await,
    })
}

async fn ws_campaign_handler(
    ws: WebSocketUpgrade,
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<WsAuthQuery>,
    State(mgr): State<Arc<RoomLeaseManager>>,
) -> impl IntoResponse {
    let role = match query.role.as_deref() {
        Some("gm") | Some("GM") => CampaignRole::Gm,
        Some("spectator") | Some("Spectator") => CampaignRole::Spectator,
        _ => CampaignRole::Player,
    };
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
