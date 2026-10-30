//! ============================================================================
//! TRAME DEDICATED SERVER BINARY ENTRYPOINT (main.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Bootstraps the standalone `trame-server` Tokio async runtime, initializes the
//! Write-Ahead Log (`InMemoryWalStorage`) and `RoomLeaseManager` with a
//! 25-command write-behind snapshot interval and 15-minute (`900,000` ms)
//! `Idle-Lease` hibernation threshold, and binds the Axum HTTP/WebSocket listener.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Configurable Port Fallback`:
//!      - Reads `TRAME_PORT` from the process environment and falls back cleanly
//!        to TCP port `4000` on missing or unparseable values.
//!   2. `Bounded Idle-Lease Memory Footprint`:
//!      - Configures `RoomLeaseManager` with `snapshot_interval = 25` commands
//!        and `idle_timeout_ms = 900_000` ms (15 minutes) so inactive campaign
//!        rooms flush their state and release RAM.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `main()`
//!     ├── 1. Initialize `InMemoryWalStorage` & `RoomLeaseManager(wal, 25, 900_000)`.
//!     ├── 2. Construct Axum `Router` via `build_router(lease_manager)`.
//!     ├── 3. Resolve `TRAME_PORT` (default `4000`) & bind `TcpListener` on `0.0.0.0`.
//!     └── 4. Serve HTTP health checks and WebSocket campaign streams via `axum::serve`.
//! ============================================================================

use std::net::SocketAddr;
use std::sync::Arc;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::http::{InMemoryMembershipValidator, build_router};
use trame_server::room::RoomLeaseManager;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

#[tokio::main]
async fn main() {
    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal, 25, 900_000));
    let asset_store = Arc::new(InMemoryAssetStore::new());
    let membership = Arc::new(InMemoryMembershipValidator::new());
    let instance_id = Uuid::new_v4();

    let app = build_router(lease_manager, asset_store, membership, instance_id);

    let port: u16 = std::env::var("TRAME_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("TRAME Server listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind TCP listener");
    axum::serve(listener, app)
        .await
        .expect("axum server failed");
}
