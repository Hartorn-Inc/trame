//! ============================================================================
//! WEBSOCKET FRAME COMPRESSION ON REAL SNAPSHOTS (ws_frame_compression_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Checks D24's application-level codec on the frame that matters most: the
//!   full `StateSnapshot` a client receives on connect and after every
//!   reconnect. The frame must inflate back byte for byte and shrink enough to
//!   justify the CPU spent on it.
//! ============================================================================

use std::io::Read;
use std::sync::Arc;

use flate2::read::ZlibDecoder;
use trame_engine::commands::{CampaignRole, TableState, TokenState};
use trame_engine::geometry::{Point2D, WallSegment};
use trame_server::room::{ConnectedClient, OutboundClientFrame, TableRoomActor, client_channel};
use trame_server::wal::{InMemoryWalStorage, TableStateSnapshot, WalStorage};
use trame_server::ws_compression::FrameEncoding;
use uuid::Uuid;

/// Snapshot frame a GM receives on connect for a scene with `walls` walls and `tokens` tokens.
async fn snapshot_frame(walls: usize, tokens: usize) -> Vec<u8> {
    let walls = (0..walls)
        .map(|i| {
            let x = (i % 40) as f64 * 100.0;
            let y = (i / 40) as f64 * 100.0;
            WallSegment::normal_wall(
                Uuid::new_v4(),
                Point2D::new(x, y),
                Point2D::new(x + 100.0, y),
            )
        })
        .collect();
    let mut state = TableState::new(100.0, 5.0, walls);
    for i in 0..tokens {
        let id = Uuid::new_v4();
        let at = Point2D::new((i % 20) as f64 * 100.0, (i / 20) as f64 * 100.0);
        state
            .data
            .tokens
            .insert(id, TokenState::new_default(id, format!("Goblin {i}"), at));
    }
    let campaign_id = Uuid::new_v4();
    let wal = Arc::new(InMemoryWalStorage::new());
    wal.save_snapshot(TableStateSnapshot::capture(campaign_id, 0, 0, &state))
        .unwrap();
    let room = TableRoomActor::spawn(campaign_id, wal, 25).unwrap();
    let (tx, mut rx) = client_channel();
    room.connect_client(ConnectedClient {
        session_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        role: CampaignRole::Gm,
        tx,
    })
    .await
    .unwrap();
    match rx.recv().await {
        Some(OutboundClientFrame::Binary(bytes)) => bytes,
        other => panic!("expected the snapshot frame, got {other:?}"),
    }
}

#[tokio::test]
async fn snapshot_frames_round_trip_and_shrink_under_deflate() {
    // (case_id, walls, tokens, largest accepted compressed/raw ratio)
    let cases = [
        ("empty_scene", 0, 0, 1.0),
        ("small_skirmish", 40, 8, 0.5),
        ("dungeon_level", 600, 40, 0.5),
    ];
    for (case, walls, tokens, max_ratio) in cases {
        let raw = snapshot_frame(walls, tokens).await;
        let compressed = FrameEncoding::Deflate.encode(raw.clone());
        let mut inflated = Vec::new();
        ZlibDecoder::new(compressed.as_slice())
            .read_to_end(&mut inflated)
            .unwrap();
        assert_eq!(inflated, raw, "case {case}: round trip");
        let ratio = compressed.len() as f64 / raw.len() as f64;
        assert!(
            ratio <= max_ratio,
            "case {case}: {} -> {} bytes",
            raw.len(),
            compressed.len()
        );
    }
}
