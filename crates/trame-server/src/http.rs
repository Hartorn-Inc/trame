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

#[derive(Debug, Deserialize)]
pub struct WsAuthQuery {
    pub user_id: Uuid,
    pub role: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub active_rooms: usize,
}

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
