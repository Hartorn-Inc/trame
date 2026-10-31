#![allow(clippy::doc_lazy_continuation)]

//! ============================================================================
//! CLOUD RUN SCALE-TO-ZERO & SIGTERM HIBERNATION LIFECYCLE TESTS (shutdown_lifecycle_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Verifies end-to-end graceful shutdown and Cloud Run lifecycle handling:
//! 1. `IS_SHUTTING_DOWN` atomic flag setting and immediate rejection of new
//!    room connections with `RoomError::ShuttingDown` and HTTP 503 Service Unavailable.
//! 2. `RoomLeaseManager::hibernate_all` commanding all active `TableRoomHandle` actors
//!    to hibernate within a 10-second timeout.
//! 3. `TableRoomHandle::hibernate` broadcasting WebSocket Close frame `1001 Going Away`
//!    to all connected clients.
//! 4. `TableRoomHandle::hibernate` flushing and serializing uncommitted actor state
//!    to `WalStorage` before terminating the actor task.
//! 5. Post-hibernation state rehydration parity verifying zero loss of committed state.
//!
//! ============================================================================

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};
use trame_engine::commands::{CampaignRole, TokenState, TrameCommand};
use trame_engine::geometry::Point2D;
use trame_server::room::{
    ConnectedClient, IS_SHUTTING_DOWN, OutboundClientFrame, RoomError, RoomLeaseManager,
    WS_CLOSE_CODE_GOING_AWAY, WS_CLOSE_REASON_GOING_AWAY,
};
use trame_server::wal::{InMemoryWalStorage, WalStorage, recover_table_state};
use uuid::Uuid;

static TEST_MUTEX: Mutex<()> = Mutex::const_new(());

/// Test fixture for simulating SIGTERM and validating graceful room hibernation.
pub struct ShutdownTestHarness {
    pub wal: Arc<InMemoryWalStorage>,
    pub lease_manager: Arc<RoomLeaseManager>,
}

impl ShutdownTestHarness {
    pub fn new() -> Self {
        let wal = Arc::new(InMemoryWalStorage::new());
        let lease_manager = Arc::new(RoomLeaseManager::new(wal.clone(), 25, 900_000));
        Self { wal, lease_manager }
    }

    /// Simulates SIGTERM arrival by asserting shutdown flag, rejecting new traffic,
    /// and triggering 10s hibernation flush across all active rooms.
    pub async fn simulate_sigterm(&self) -> Vec<Uuid> {
        IS_SHUTTING_DOWN.store(true, Ordering::Release);
        self.lease_manager
            .hibernate_all(Duration::from_secs(10))
            .await
            .expect("scale-to-zero hibernation must succeed")
    }
}

impl Default for ShutdownTestHarness {
    fn default() -> Self {
        Self::new()
    }
}

#[tokio::test]
async fn test_graceful_shutdown_room_hibernation() {
    let _guard = TEST_MUTEX.lock().await;
    IS_SHUTTING_DOWN.store(false, Ordering::Release);

    let harness = ShutdownTestHarness::new();
    let campaign_id = Uuid::new_v4();
    let token_id = Uuid::new_v4();
    let gm_user_id = Uuid::new_v4();
    let player_user_id = Uuid::new_v4();

    // 1. Seed table state with token
    let mut state = trame_engine::commands::TableState::default();
    let token = TokenState::new_default(token_id, "Paladin", Point2D::new(50.0, 50.0));
    state.data.tokens.insert(token_id, token);
    harness
        .wal
        .save_snapshot(trame_server::wal::TableStateSnapshot {
            campaign_id,
            snapshot_seq_id: 0,
            captured_at_ms: 1000,
            cell_size_px: 100.0,
            feet_per_cell: 5.0,
            data: state.data,
        })
        .expect("snapshot saved");

    // 2. Wake active room
    let room = harness
        .lease_manager
        .get_or_wake_room(campaign_id)
        .await
        .expect("room woke");

    // 3. Connect GM and Player clients
    let (gm_tx, mut gm_rx) = mpsc::unbounded_channel();
    let (player_tx, mut player_rx) = mpsc::unbounded_channel();
    let gm_session_id = Uuid::new_v4();
    let player_session_id = Uuid::new_v4();

    room.connect_client(ConnectedClient {
        session_id: gm_session_id,
        user_id: gm_user_id,
        role: CampaignRole::Gm,
        tx: gm_tx,
    })
    .await
    .expect("GM connected");

    room.connect_client(ConnectedClient {
        session_id: player_session_id,
        user_id: player_user_id,
        role: CampaignRole::Player,
        tx: player_tx,
    })
    .await
    .expect("Player connected");

    // Consume initial state snapshot frames
    let _ = gm_rx.recv().await;
    let _ = player_rx.recv().await;

    // 4. Submit uncommitted movement mutation: Paladin moves to (350.0, 450.0)
    let target_pos = Point2D::new(350.0, 450.0);
    let move_cmd = TrameCommand::MoveToken {
        token_id,
        to_top_left: target_pos,
        to_elevation_ft: Some(10.0),
        gm_teleport: true,
    };
    room.send_envelope(
        gm_session_id,
        trame_server::sync::ClientEnvelope::SubmitCommand(move_cmd),
    )
    .await
    .expect("command sent");

    // Consume CommandAccepted frames
    let _ = gm_rx.recv().await;
    let _ = player_rx.recv().await;

    // 5. Trigger SIGTERM simulation via TestHarness
    let hibernated = harness.simulate_sigterm().await;
    assert_eq!(hibernated, vec![campaign_id]);
    assert_eq!(harness.lease_manager.active_room_count().await, 0);

    // 6. Verify Close frame 1001 Going Away broadcast to all connected clients
    let gm_close = gm_rx.recv().await.expect("GM receives close frame");
    match gm_close {
        OutboundClientFrame::Close { code, reason } => {
            assert_eq!(code, WS_CLOSE_CODE_GOING_AWAY);
            assert_eq!(reason, WS_CLOSE_REASON_GOING_AWAY);
        }
        other => panic!("expected OutboundClientFrame::Close, got {other:?}"),
    }

    let player_close = player_rx.recv().await.expect("Player receives close frame");
    match player_close {
        OutboundClientFrame::Close { code, reason } => {
            assert_eq!(code, WS_CLOSE_CODE_GOING_AWAY);
            assert_eq!(reason, WS_CLOSE_REASON_GOING_AWAY);
        }
        other => panic!("expected OutboundClientFrame::Close, got {other:?}"),
    }

    // 7. Verify table state persistence in WAL storage upon recovery
    let (recovered_state, recovered_seq) =
        recover_table_state(harness.wal.as_ref(), campaign_id).expect("WAL state recovered");
    assert_eq!(recovered_seq, 1);
    let moved_token = recovered_state
        .data
        .tokens
        .get(&token_id)
        .expect("token present in recovered table");
    assert_eq!(moved_token.top_left.x, target_pos.x);
    assert_eq!(moved_token.top_left.y, target_pos.y);
    assert_eq!(moved_token.elevation_ft, 10.0);

    // 8. Confirm rejection of new connections after shutdown
    let wake_err = harness
        .lease_manager
        .get_or_wake_room(campaign_id)
        .await
        .expect_err("waking room during shutdown must fail");
    assert!(matches!(wake_err, RoomError::ShuttingDown));

    IS_SHUTTING_DOWN.store(false, Ordering::Release);
}

#[tokio::test]
async fn test_shutdown_sets_flag_and_rejects_new_connections() {
    let _guard = TEST_MUTEX.lock().await;
    IS_SHUTTING_DOWN.store(false, Ordering::Release);

    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal.clone(), 25, 900_000));
    let campaign_id = Uuid::new_v4();

    let room = lease_manager
        .get_or_wake_room(campaign_id)
        .await
        .expect("room wakes normally");
    assert_eq!(room.campaign_id, campaign_id);

    IS_SHUTTING_DOWN.store(true, Ordering::Release);
    assert!(IS_SHUTTING_DOWN.load(Ordering::Acquire));

    let new_campaign_id = Uuid::new_v4();
    let wake_err = lease_manager
        .get_or_wake_room(new_campaign_id)
        .await
        .expect_err("must reject new room wake when shutting down");
    assert!(matches!(wake_err, RoomError::ShuttingDown));

    let (tx, _rx) = mpsc::unbounded_channel();
    let client = ConnectedClient {
        session_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        role: CampaignRole::Player,
        tx,
    };
    let conn_err = room
        .connect_client(client)
        .await
        .expect_err("must reject new connection when shutting down");
    assert!(matches!(conn_err, RoomError::ShuttingDown));

    IS_SHUTTING_DOWN.store(false, Ordering::Release);
}

#[tokio::test]
async fn test_hibernate_broadcasts_ws_close_1001_and_flushes_state() {
    let _guard = TEST_MUTEX.lock().await;
    IS_SHUTTING_DOWN.store(false, Ordering::Release);

    let wal = Arc::new(InMemoryWalStorage::new());
    let campaign_id = Uuid::new_v4();
    let token_id = Uuid::new_v4();
    let gm_user_id = Uuid::new_v4();

    let mut state = trame_engine::commands::TableState::default();
    let token = TokenState::new_default(token_id, "Test Fighter", Point2D::new(100.0, 100.0));
    state.data.tokens.insert(token_id, token);
    wal.save_snapshot(trame_server::wal::TableStateSnapshot {
        campaign_id,
        snapshot_seq_id: 0,
        captured_at_ms: 1000,
        cell_size_px: 100.0,
        feet_per_cell: 5.0,
        data: state.data,
    })
    .expect("snapshot saved");

    let lease_manager = Arc::new(RoomLeaseManager::new(wal.clone(), 25, 900_000));
    let room = lease_manager
        .get_or_wake_room(campaign_id)
        .await
        .expect("room woke");

    let (client1_tx, mut client1_rx) = mpsc::unbounded_channel();
    let (client2_tx, mut client2_rx) = mpsc::unbounded_channel();

    let client1_session_id = Uuid::new_v4();
    let client1 = ConnectedClient {
        session_id: client1_session_id,
        user_id: gm_user_id,
        role: CampaignRole::Gm,
        tx: client1_tx,
    };
    let client2 = ConnectedClient {
        session_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        role: CampaignRole::Player,
        tx: client2_tx,
    };

    room.connect_client(client1)
        .await
        .expect("client 1 attached");
    room.connect_client(client2)
        .await
        .expect("client 2 attached");

    let _ = client1_rx.recv().await;
    let _ = client2_rx.recv().await;

    let move_cmd = TrameCommand::MoveToken {
        token_id,
        to_top_left: Point2D::new(200.0, 200.0),
        to_elevation_ft: None,
        gm_teleport: true,
    };
    room.send_envelope(
        client1_session_id,
        trame_server::sync::ClientEnvelope::SubmitCommand(move_cmd),
    )
    .await
    .expect("envelope sent");

    let _ = client1_rx.recv().await;
    let _ = client2_rx.recv().await;

    let final_seq = room.hibernate().await.expect("hibernate succeeds");
    assert_eq!(final_seq, 1);

    let frame1 = client1_rx
        .recv()
        .await
        .expect("client 1 receives close frame");
    match frame1 {
        OutboundClientFrame::Close { code, reason } => {
            assert_eq!(code, WS_CLOSE_CODE_GOING_AWAY);
            assert_eq!(reason, WS_CLOSE_REASON_GOING_AWAY);
        }
        _ => panic!("expected OutboundClientFrame::Close"),
    }

    let frame2 = client2_rx
        .recv()
        .await
        .expect("client 2 receives close frame");
    match frame2 {
        OutboundClientFrame::Close { code, reason } => {
            assert_eq!(code, WS_CLOSE_CODE_GOING_AWAY);
            assert_eq!(reason, WS_CLOSE_REASON_GOING_AWAY);
        }
        _ => panic!("expected OutboundClientFrame::Close"),
    }

    let (recovered_state, recovered_seq) =
        recover_table_state(wal.as_ref(), campaign_id).expect("recovery from storage succeeds");
    assert_eq!(recovered_seq, 1);
    let moved_token = recovered_state
        .data
        .tokens
        .get(&token_id)
        .expect("token exists in recovered state");
    assert_eq!(moved_token.top_left.x, 200.0);
    assert_eq!(moved_token.top_left.y, 200.0);
    IS_SHUTTING_DOWN.store(false, Ordering::Release);
}

#[tokio::test]
async fn test_room_lease_manager_hibernate_all_lifecycle() {
    let _guard = TEST_MUTEX.lock().await;
    IS_SHUTTING_DOWN.store(false, Ordering::Release);

    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal.clone(), 25, 900_000));

    let c1 = Uuid::new_v4();
    let c2 = Uuid::new_v4();
    let c3 = Uuid::new_v4();

    let r1 = lease_manager.get_or_wake_room(c1).await.unwrap();
    let r2 = lease_manager.get_or_wake_room(c2).await.unwrap();
    let _r3 = lease_manager.get_or_wake_room(c3).await.unwrap();

    assert_eq!(lease_manager.active_room_count().await, 3);

    let (c1_tx, mut c1_rx) = mpsc::unbounded_channel();
    r1.connect_client(ConnectedClient {
        session_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        role: CampaignRole::Player,
        tx: c1_tx,
    })
    .await
    .unwrap();
    let _ = c1_rx.recv().await;

    let (c2_tx, mut c2_rx) = mpsc::unbounded_channel();
    r2.connect_client(ConnectedClient {
        session_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        role: CampaignRole::Player,
        tx: c2_tx,
    })
    .await
    .unwrap();
    let _ = c2_rx.recv().await;

    let timeout = Duration::from_secs(10);
    let hibernated = lease_manager
        .hibernate_all(timeout)
        .await
        .expect("hibernate_all completes");

    assert_eq!(hibernated.len(), 3);
    assert!(hibernated.contains(&c1));
    assert!(hibernated.contains(&c2));
    assert!(hibernated.contains(&c3));
    assert_eq!(lease_manager.active_room_count().await, 0);

    match c1_rx.recv().await.unwrap() {
        OutboundClientFrame::Close { code, reason } => {
            assert_eq!(code, WS_CLOSE_CODE_GOING_AWAY);
            assert_eq!(reason, WS_CLOSE_REASON_GOING_AWAY);
        }
        _ => panic!("expected close frame for client 1"),
    }

    match c2_rx.recv().await.unwrap() {
        OutboundClientFrame::Close { code, reason } => {
            assert_eq!(code, WS_CLOSE_CODE_GOING_AWAY);
            assert_eq!(reason, WS_CLOSE_REASON_GOING_AWAY);
        }
        _ => panic!("expected close frame for client 2"),
    }
    IS_SHUTTING_DOWN.store(false, Ordering::Release);
}

#[tokio::test]
async fn test_http_endpoint_rejects_connections_during_shutdown() {
    let _guard = TEST_MUTEX.lock().await;
    IS_SHUTTING_DOWN.store(false, Ordering::Release);

    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal.clone(), 25, 900_000));
    let asset_store = Arc::new(trame_server::assets::store::InMemoryAssetStore::new());
    let membership = Arc::new(trame_server::http::InMemoryMembershipValidator::new());
    let instance_id = Uuid::new_v4();

    let app = trame_server::http::build_router(
        lease_manager.clone(),
        asset_store,
        membership,
        instance_id,
    );

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let req = Request::builder()
        .uri("/healthz")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    IS_SHUTTING_DOWN.store(true, Ordering::Release);

    let req = Request::builder()
        .uri("/healthz")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    IS_SHUTTING_DOWN.store(false, Ordering::Release);
}
