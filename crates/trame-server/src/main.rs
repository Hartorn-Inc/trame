//! ============================================================================
//! TRAME DEDICATED SERVER BINARY ENTRYPOINT (main.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Bootstraps the standalone `trame-server` Tokio async runtime, connects to
//! PostgreSQL 18 via `SqlxPostgresStore::connect_and_migrate` when `DATABASE_URL`
//! is configured (or falls back to in-memory stores for local zero-config runs),
//! initializes `RoomLeaseManager` with a 50-command write-behind snapshot interval
//! and 15-minute (`900,000` ms) `Idle-Lease` hibernation threshold, binds the Axum
//! HTTP/WebSocket listener, and coordinates Cloud Run scale-to-zero graceful
//! shutdown upon SIGTERM or SIGINT.
//! ============================================================================

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::http::{
    InMemoryMembershipValidator, build_postgres_app_state, build_router, build_router_with_state,
};
use trame_server::room::{IS_SHUTTING_DOWN, RoomLeaseManager};
use trame_server::storage::postgres::SqlxPostgresStore;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

/// Maximum grace period allowed for room actors to flush state and close client connections.
pub const SHUTDOWN_TIMEOUT_SECONDS: u64 = 10;

/// Coordinates graceful termination upon receiving SIGTERM or SIGINT.
pub async fn shutdown_handler(lease_manager: Arc<RoomLeaseManager>) {
    wait_for_signal().await;

    IS_SHUTTING_DOWN.store(true, Ordering::Release);
    println!("Shutdown signal received: IS_SHUTTING_DOWN set to true");

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
    let instance_id = Uuid::new_v4();
    let database_url = std::env::var("DATABASE_URL")
        .or_else(|_| std::env::var("TRAME_DATABASE_URL"))
        .ok()
        .filter(|s| !s.trim().is_empty());

    let (app, lease_manager) = if let Some(db_url) = database_url {
        let base_url =
            std::env::var("TRAME_PUBLIC_URL").unwrap_or_else(|_| "/assets/download".to_string());
        match SqlxPostgresStore::connect_and_migrate(&db_url, base_url).await {
            Ok(pg_store) => {
                println!("Connected to PostgreSQL 18 and applied sqlx migrations");
                let state = build_postgres_app_state(pg_store, instance_id);
                let lm = state.lease_manager.clone();
                (build_router_with_state(state), lm)
            }
            Err(err) => {
                eprintln!(
                    "Warning: PostgreSQL connection failed ({err}); falling back to in-memory storage"
                );
                let wal = Arc::new(InMemoryWalStorage::new());
                let lm = Arc::new(RoomLeaseManager::new(wal, 50, 900_000));
                let asset_store = Arc::new(InMemoryAssetStore::with_base_url("/assets/download"));
                let membership = Arc::new(InMemoryMembershipValidator::new());
                (
                    build_router(lm.clone(), asset_store, membership, instance_id),
                    lm,
                )
            }
        }
    } else {
        println!("No DATABASE_URL set; running with in-memory storage");
        let wal = Arc::new(InMemoryWalStorage::new());
        let lm = Arc::new(RoomLeaseManager::new(wal, 50, 900_000));
        let asset_store = Arc::new(InMemoryAssetStore::with_base_url("/assets/download"));
        let membership = Arc::new(InMemoryMembershipValidator::new());
        (
            build_router(lm.clone(), asset_store, membership, instance_id),
            lm,
        )
    };

    let port: u16 = std::env::var("TRAME_PORT")
        .or_else(|_| std::env::var("PORT"))
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
