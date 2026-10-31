//! ============================================================================
//! TRAME DEDICATED SERVER BINARY ENTRYPOINT (main.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Bootstraps the standalone `trame-server` Tokio async runtime, initializes the
//! Write-Ahead Log (`InMemoryWalStorage`) and `RoomLeaseManager` with a
//! 25-command write-behind snapshot interval and 15-minute (`900,000` ms)
//! `Idle-Lease` hibernation threshold, binds the Axum HTTP/WebSocket listener,
//! and coordinates Cloud Run scale-to-zero graceful shutdown upon SIGTERM or SIGINT.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Configurable Port Fallback`:
//!      - Reads `TRAME_PORT` from the process environment and falls back cleanly
//!        to TCP port `4000` on missing or unparseable values.
//!   2. `Cloud Run SIGTERM / SIGINT Lifecycle`:
//!      - Registers Unix signal handlers for SIGTERM and SIGINT.
//!      - Sets `IS_SHUTTING_DOWN` to reject incoming HTTP/WebSocket connections.
//!      - Invokes `RoomLeaseManager::hibernate_all` with a 10-second timeout.
//!      - Flushes uncommitted state and sends WebSocket Close frame 1001 Going Away.
//!      - Terminates cleanly with exit code 0.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `main()`
//!     ├── 1. Initialize `InMemoryWalStorage` & `RoomLeaseManager(wal, 25, 900_000)`.
//!     ├── 2. Construct Axum `Router` via `build_router(lease_manager)`.
//!     ├── 3. Resolve `TRAME_PORT` (default `4000`) & bind `TcpListener` on `0.0.0.0`.
//!     ├── 4. Serve HTTP and WebSocket requests with `with_graceful_shutdown`.
//!     └── 5. On signal, execute `shutdown_handler` and terminate with exit code 0.
//! ============================================================================

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::http::{InMemoryMembershipValidator, build_router};
use trame_server::room::{IS_SHUTTING_DOWN, RoomLeaseManager};
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

/// Maximum grace period allowed for room actors to flush state and close client connections.
pub const SHUTDOWN_TIMEOUT_SECONDS: u64 = 10;

/// Coordinates graceful termination upon receiving SIGTERM or SIGINT.
pub async fn shutdown_handler(lease_manager: Arc<RoomLeaseManager>) {
    // 1. Wait for termination signal
    wait_for_signal().await;

    // 2. Set IS_SHUTTING_DOWN flag to reject new incoming connections
    IS_SHUTTING_DOWN.store(true, Ordering::Release);
    println!("Shutdown signal received: IS_SHUTTING_DOWN set to true");

    // 3. Command all active rooms to hibernate within the 10-second timeout
    let timeout = Duration::from_secs(SHUTDOWN_TIMEOUT_SECONDS);
    match lease_manager.hibernate_all(timeout).await {
        Ok(hibernated) => {
            println!(
                "Scale-to-zero hibernation completed: {} room(s) cleanly saved",
                hibernated.len()
            );
        }
        Err(err) => {
            eprintln!("Warning: hibernation completed with error: {err}");
        }
    }
}

/// Awaits either SIGTERM (Cloud Run scale-to-zero / container stop) or SIGINT (Ctrl+C).
async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm =
            signal(SignalKind::terminate()).expect("failed to register SIGTERM handler");
        let mut sigint =
            signal(SignalKind::interrupt()).expect("failed to register SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => {
                println!("Received SIGTERM (Cloud Run scale-to-zero / instance termination)");
            }
            _ = sigint.recv() => {
                println!("Received SIGINT (keyboard interrupt)");
            }
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for ctrl_c");
        println!("Received Ctrl+C interrupt");
    }
}

#[tokio::main]
async fn main() {
    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal, 25, 900_000));
    let asset_store = Arc::new(InMemoryAssetStore::new());
    let membership = Arc::new(InMemoryMembershipValidator::new());
    let instance_id = Uuid::new_v4();

    let app = build_router(lease_manager.clone(), asset_store, membership, instance_id);

    let port: u16 = std::env::var("TRAME_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("TRAME Server listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind TCP listener");

    let shutdown_lease_mgr = lease_manager.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_handler(shutdown_lease_mgr))
        .await
        .expect("axum server failed");

    println!("TRAME Server cleanly terminated with exit code 0");
    std::process::exit(0);
}
