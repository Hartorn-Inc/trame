//! ============================================================================
//! SIGNED ASSET DOWNLOADS ARE NEVER CACHED (asset_download_cache_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Proves through the full router that both answers of
//!   `GET /assets/download/{key}?exp=&sig=` carry `Cache-Control: private,
//!   no-store`: the inline `200` (bytes served by the server) and the `307` to
//!   the object store, so no shared cache keeps a signed URL's bytes or
//!   redirect past the signature's expiry.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - The `307` branch uses a wrapper store whose `direct_download_url`
//!     returns a URL; signing and verification stay those of
//!     `InMemoryAssetStore`.
//! ============================================================================

use axum::body::Body;
use axum::http::{Request, StatusCode};
use bytes::Bytes;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tower::ServiceExt;
use trame_server::archive::InMemoryCampaignStore;
use trame_server::assets::store::{AssetStore, AssetStoreError, BoxFuture, InMemoryAssetStore};
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{AuthState, InMemorySessionStore};
use trame_server::auth::totp::TotpService;
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
};
use trame_server::maps::InMemoryMapStorage;
use trame_server::room::RoomLeaseManager;
use trame_server::security::SecurityPolicy;
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

const SECRET: &[u8] = b"asset-cache-test-secret-at-least-32-bytes";
const KEY: &str = "instances/i/campaigns/c/assets/map.webp";
const BUCKET_URL: &str = "https://bucket.example/map.webp?X-Amz-Signature=abc";

/// `InMemoryAssetStore` that, when `redirect` is set, answers downloads with `BUCKET_URL`.
struct Store {
    inner: InMemoryAssetStore,
    redirect: bool,
}

impl AssetStore for Store {
    fn put_asset<'a>(
        &'a self,
        key: &'a str,
        data: Bytes,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), AssetStoreError>> {
        self.inner.put_asset(key, data, content_type)
    }

    fn get_asset<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Bytes>, AssetStoreError>> {
        self.inner.get_asset(key)
    }

    fn mint_presigned_get_url<'a>(
        &'a self,
        key: &'a str,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<String, AssetStoreError>> {
        self.inner.mint_presigned_get_url(key, ttl)
    }

    fn campaign_usage_bytes(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<u64, AssetStoreError>> {
        self.inner.campaign_usage_bytes(campaign_id)
    }

    fn verify_presigned_get(&self, key: &str, exp: u64, sig_hex: &str) -> bool {
        self.inner.verify_presigned_get(key, exp, sig_hex)
    }

    fn direct_download_url<'a>(
        &'a self,
        _key: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, AssetStoreError>> {
        let url = self.redirect.then(|| BUCKET_URL.to_string());
        Box::pin(async move { Ok(url) })
    }
}

fn state(store: Arc<Store>) -> AppState {
    let wal = Arc::new(InMemoryWalStorage::new());
    AppState {
        lease_manager: Arc::new(RoomLeaseManager::new(wal, 25, 900_000)),
        asset_store: store,
        membership: Arc::new(InMemoryMembershipValidator::new()),
        instance_id: Uuid::new_v4(),
        timeline_storage: Arc::new(InMemoryTimelineStorage::new()),
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state: AuthState::with_security(
            Arc::new(MagicLinkService::new(SECRET.to_vec(), "trame-test")),
            Arc::new(InMemorySessionStore::new()),
            Arc::new(TotpService::default()),
            Arc::new(SecurityPolicy::default()),
        ),
        db_healthy: Arc::new(AtomicBool::new(true)),
        map_storage: InMemoryMapStorage::new(),
        postgres_store: None,
        campaign_data: Default::default(),
        static_dir: None,
    }
}

#[tokio::test]
async fn signed_download_answers_are_private_and_uncached() {
    // (case_id, object store redirect, expected status, expected Location)
    let cases = [
        (
            "inline_bytes_200_is_private_no_store",
            false,
            StatusCode::OK,
            None,
        ),
        (
            "object_store_307_is_private_no_store",
            true,
            StatusCode::TEMPORARY_REDIRECT,
            Some(BUCKET_URL),
        ),
    ];
    for (case, redirect, want_status, want_location) in cases {
        let store = Arc::new(Store {
            inner: InMemoryAssetStore::with_base_url_and_secret("/assets/download", SECRET),
            redirect,
        });
        store
            .put_asset(KEY, Bytes::from_static(b"RIFF\0\0\0\0WEBP"), "image/webp")
            .await
            .unwrap();
        let url = store
            .mint_presigned_get_url(KEY, Duration::from_secs(300))
            .await
            .unwrap();
        let resp = build_router_with_state(state(store))
            .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), want_status, "case {case}");
        assert_eq!(
            resp.headers()["cache-control"],
            "private, no-store",
            "case {case}"
        );
        assert_eq!(
            resp.headers().get("location").map(|v| v.to_str().unwrap()),
            want_location,
            "case {case}"
        );
    }
}
