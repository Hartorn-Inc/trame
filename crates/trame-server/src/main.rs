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
