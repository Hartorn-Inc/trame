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

#[derive(Debug, Deserialize)]
pub struct TimelineQuery {
    pub after: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Clone)]
pub struct ServerAppState {
    pub lease_manager: Arc<RoomLeaseManager>,
    pub timeline_storage: Arc<dyn TimelineStorage>,
}

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
