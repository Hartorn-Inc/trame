//! ============================================================================
//! TRAME SERVER BINARY ENTRYPOINT (main.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Boots the authoritative TRAME HTTP + WebSocket runtime. When `DATABASE_URL`
//! (or `TRAME_DATABASE_URL`) is configured, connects to PostgreSQL 18 via
//! `SqlxPostgresStore`, executes embedded SQL migrations (`./migrations`), and
//! binds the unified Axum router; otherwise falls back to in-memory stores for
//! zero-dependency local testing. Coordinates Cloud Run scale-to-zero graceful
//! shutdown upon SIGTERM or SIGINT (ADR-0005).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//! 1. `Automatic Schema Migration`:
//!    - `SqlxPostgresStore::connect_and_migrate` runs `sqlx::migrate!("./migrations")`
//!      before accepting client connections.
//! 2. `Configurable Port Resolution`:
//!    - Checks `TRAME_PORT`, then `PORT`, and defaults to `8080`.
//! 3. `SIGTERM / SIGINT Lifecycle`:
//!    - Sets `IS_SHUTTING_DOWN` so new HTTP/WebSocket connections are rejected.
//!    - Invokes `RoomLeaseManager::hibernate_all` within a 10-second timeout so
//!      every active room flushes its WAL before the process exits.
//!
//! 4. `Fail-Closed Secrets (G7)`:
//!    - `ServerConfig::from_env` must succeed before anything binds; outside
//!      `TRAME_ENV=dev` a missing or weak secret prints the offending variable
//!      names and exits with status 1.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `main()`
//!     ├── 0. Resolve `ServerConfig` (exit 1 on `ConfigError`).
//!     ├── 1. Resolve port, instance id, and optional `DATABASE_URL`.
//!     ├── 2. Build `RoomLeaseManager` over the PostgreSQL or in-memory WAL.
//!     ├── 3. Construct the Axum `Router` and bind `0.0.0.0:{port}`.
//!     ├── 4. Spawn the `Idle-Lease` sweeper (`tokio::time::interval`, 1 min).
//!     └── 5. Serve with `with_graceful_shutdown(shutdown_handler)`.
//! ============================================================================

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::config::{RuntimeEnv, ServerConfig};
use trame_server::http::{
    InMemoryMembershipValidator, build_in_memory_router_with_config,
    build_router_with_postgres_store,
};
use trame_server::room::{IS_SHUTTING_DOWN, RoomLeaseManager};
use trame_server::storage::SqlxPostgresStore;
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

/// Maximum grace period allowed for room actors to flush state and close client connections.
pub const SHUTDOWN_TIMEOUT_SECONDS: u64 = 10;

/// Number of committed commands between WAL snapshots.
const SNAPSHOT_INTERVAL_COMMANDS: u64 = 50;

/// `Idle-Lease` hibernation threshold in milliseconds (15 minutes).
const IDLE_LEASE_MS: u64 = 900_000;

/// Period of the `Idle-Lease` sweeper tick in milliseconds (1 minute), so a room
/// hibernates at most one tick after its 15-minute lease lapses.
const IDLE_SWEEP_PERIOD_MS: u64 = 60_000;

/// Installs the global `tracing` subscriber. `RUST_LOG` selects levels
/// (e.g. `RUST_LOG=trame_server=debug`); unset defaults to `info`.
fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

/// Coordinates graceful termination upon receiving SIGTERM or SIGINT.
pub async fn shutdown_handler(lease_manager: Arc<RoomLeaseManager>) {
    wait_for_signal().await;

    IS_SHUTTING_DOWN.store(true, Ordering::Release);
    tracing::info!("shutdown signal received: rejecting new connections");

    let timeout = Duration::from_secs(SHUTDOWN_TIMEOUT_SECONDS);
    match lease_manager.hibernate_all(timeout).await {
        Ok(hibernated) => {
            tracing::info!(
                rooms = hibernated.len(),
                "scale-to-zero hibernation completed"
            );
        }
        Err(err) => {
            tracing::warn!(error = %err, "hibernation completed with error");
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
            _ = sigterm.recv() => tracing::info!("received SIGTERM"),
            _ = sigint.recv() => tracing::info!("received SIGINT"),
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for ctrl_c");
        tracing::info!("received Ctrl+C interrupt");
    }
}

#[tokio::main]
async fn main() {
    init_tracing();
    let config = match ServerConfig::from_env() {
        Ok(config) => config,
        Err(err) => {
            tracing::error!("{err}");
            std::process::exit(1);
        }
    };
    if config.env == RuntimeEnv::Dev {
        tracing::warn!("TRAME_ENV=dev: missing secrets use public development defaults");
    }

    let port: u16 = std::env::var("TRAME_PORT")
        .or_else(|_| std::env::var("PORT"))
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);

    let instance_id = std::env::var("TRAME_INSTANCE_ID")
        .ok()
        .and_then(|s| Uuid::parse_str(&s).ok())
        .unwrap_or_else(Uuid::new_v4);

    let database_url = std::env::var("DATABASE_URL")
        .or_else(|_| std::env::var("TRAME_DATABASE_URL"))
        .ok()
        .filter(|s| !s.trim().is_empty());

    let (app, lease_manager) = if let Some(db_url) = database_url {
        let store = Arc::new(
            SqlxPostgresStore::connect_and_migrate(&db_url, "/assets/download")
                .await
                .expect("Failed to connect and migrate PostgreSQL store")
                .with_signing_secret(config.secrets.asset_signing_secret.clone()),
        );
        tracing::info!("connected to PostgreSQL and applied migrations");
        let lease_manager = Arc::new(RoomLeaseManager::new(
            store.clone(),
            SNAPSHOT_INTERVAL_COMMANDS,
            IDLE_LEASE_MS,
        ));
        let app =
            build_router_with_postgres_store(store, lease_manager.clone(), instance_id, &config);
        (app, lease_manager)
    } else {
        tracing::warn!("DATABASE_URL not set; using in-memory fallback persistence");
        let wal = Arc::new(InMemoryWalStorage::new());
        let lease_manager = Arc::new(RoomLeaseManager::new(
            wal,
            SNAPSHOT_INTERVAL_COMMANDS,
            IDLE_LEASE_MS,
        ));
        let asset_store = Arc::new(InMemoryAssetStore::with_base_url_and_secret(
            "/assets/download",
            config.secrets.asset_signing_secret.clone(),
        ));
        let membership = Arc::new(InMemoryMembershipValidator::new());
        let app = build_in_memory_router_with_config(
            lease_manager.clone(),
            asset_store,
            membership,
            instance_id,
            Arc::new(InMemoryTimelineStorage::new()),
            &config,
        );
        (app, lease_manager)
    };

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    let _sweeper = lease_manager.spawn_idle_sweeper(Duration::from_millis(IDLE_SWEEP_PERIOD_MS));
    tracing::info!(%addr, "TRAME server listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_handler(lease_manager))
    .await
    .expect("Axum server error");
    tracing::info!("TRAME server cleanly terminated");
}
