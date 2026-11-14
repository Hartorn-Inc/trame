//! ============================================================================
//! S3 ASSET STORE INTEGRATION SUITE (s3_integration_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Exercises `S3Store` against a real S3-compatible service (the dev Silo /
//!   MinIO container) behind the production router: uploads land in the
//!   bucket with a metadata-only `campaign_assets` row, signed downloads
//!   redirect to a working presigned GET, access checks are unchanged, and
//!   `migrate_inline_assets` copies PostgreSQL blobs once with hash checks.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Runs only when both `DATABASE_URL` and `TEST_S3_ENDPOINT` are non-empty
//!     (`make test-rust TEST_DATABASE_URL=... TEST_S3_ENDPOINT=http://minio:9000`);
//!     otherwise each test returns early so local `cargo test` stays hermetic.
//!   - Test-only `TEST_S3_*` names keep the server's own `S3_*` variables out
//!     of every other suite.
//!   - Fresh UUIDs per run; the bucket is created on demand and never emptied.
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header::LOCATION};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::assets::store::AssetStore;
use trame_server::auth::accounts::InstanceRole;
use trame_server::auth::session::{IdentityStore, SessionStore, UserRecord, hash_session_token};
use trame_server::config::{DEV_HMAC_SECRET, ServerConfig};
use trame_server::http::build_router_with_postgres_and_asset_store;
use trame_server::room::RoomLeaseManager;
use trame_server::storage::s3::{BlobMigrationReport, S3Endpoint, migrate_inline_assets};
use trame_server::storage::{S3Config, S3Store, Sha256Hasher, SqlxPostgresStore};
use uuid::Uuid;

struct Harness {
    app: Router,
    pg: Arc<SqlxPostgresStore>,
    s3: Arc<S3Store>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

async fn harness() -> Option<Harness> {
    let (Some(url), Some(endpoint)) = (env("DATABASE_URL"), env("TEST_S3_ENDPOINT")) else {
        eprintln!("DATABASE_URL or TEST_S3_ENDPOINT not set; skipping S3 integration test");
        return None;
    };
    let endpoint = S3Endpoint::parse(&endpoint).expect("TEST_S3_ENDPOINT is http(s)://host[:port]");
    let config = S3Config {
        public_endpoint: endpoint.clone(),
        endpoint,
        bucket: env("TEST_S3_BUCKET").unwrap_or_else(|| "trame-test".to_string()),
        region: "us-east-1".to_string(),
        access_key_id: env("TEST_S3_ACCESS_KEY_ID").expect("TEST_S3_ACCESS_KEY_ID"),
        secret_access_key: env("TEST_S3_SECRET_ACCESS_KEY").expect("TEST_S3_SECRET_ACCESS_KEY"),
    };
    let pg = Arc::new(
        SqlxPostgresStore::connect_and_migrate(&url, "/assets/download", DEV_HMAC_SECRET.to_vec())
            .await
            .expect("connect and migrate"),
    );
    let s3 = Arc::new(S3Store::new(pg.clone(), config).expect("S3 client"));
    s3.client().create_bucket().await.expect("create bucket");
    let app = build_router_with_postgres_and_asset_store(
        pg.clone(),
        s3.clone(),
        Arc::new(RoomLeaseManager::new(pg.clone(), 25, 900_000)),
        Uuid::new_v4(),
        &ServerConfig::dev(),
    );
    Some(Harness { app, pg, s3 })
}

async fn account(store: &SqlxPostgresStore) -> String {
    let user_id = Uuid::new_v4();
    store
        .save_user(UserRecord {
            id: user_id,
            username: format!("s3-{user_id}"),
            role: "PLAYER".to_string(),
            is_guest: false,
            created_at: 0,
            email: Some(format!("{user_id}@example.com")),
            password_hash: None,
            mfa_enabled: false,
            totp_secret: None,
            pending_totp_secret: None,
            instance_role: InstanceRole::Host,
        })
        .await
        .unwrap();
    let token = format!("s3-session-{user_id}");
    store
        .create_session(user_id, &hash_session_token(&token), 3600)
        .await
        .unwrap();
    format!("trame_session={token}")
}

/// Sends one request through the router; returns status, `Location` and body.
async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    body: Body,
) -> (StatusCode, Option<String>, Bytes) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        req = req.header("cookie", cookie);
    }
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let location = resp
        .headers()
        .get(LOCATION)
        .map(|v| v.to_str().unwrap().to_string());
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, location, bytes)
}

/// Plain HTTP GET outside the router, as the browser follows the redirect.
async fn fetch(url: &str) -> (StatusCode, Bytes) {
    let client = Client::builder(TokioExecutor::new()).build_http::<Empty<Bytes>>();
    let resp = client.get(url.parse().unwrap()).await.unwrap();
    let status = resp.status();
    (status, resp.into_body().collect().await.unwrap().to_bytes())
}

fn png_bytes() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(8, 8, image::Rgb([40, 90, 160]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

async fn create_campaign(app: &Router, gm: &str) -> String {
    let (status, _, body) = call(
        app,
        "POST",
        "/api/v1/campaigns",
        Some(gm),
        Body::from(json!({ "name": "S3 Campaign" }).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let body: Value = serde_json::from_slice(&body).unwrap();
    body["campaign"]["id"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_upload_redirects_signed_downloads_and_keeps_access_checks() {
    let Some(h) = harness().await else {
        return;
    };
    let gm = account(&h.pg).await;
    let outsider = account(&h.pg).await;
    let campaign_id = create_campaign(&h.app, &gm).await;
    let (status, _, body) = call(
        &h.app,
        "POST",
        &format!("/api/v1/campaigns/{campaign_id}/assets"),
        Some(&gm),
        Body::from(png_bytes()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let upload: Value = serde_json::from_slice(&body).unwrap();
    let key = upload["key"].as_str().unwrap();
    let hash = upload["hash"].as_str().unwrap();
    let signed = upload["url"].as_str().unwrap();

    assert_eq!(h.pg.asset_is_external(key).await.unwrap(), Some(true));
    let object =
        h.s3.client()
            .get_object(key)
            .await
            .unwrap()
            .expect("object");
    assert_eq!(Sha256Hasher::digest(&object), hash, "content-addressed key");
    assert_eq!(h.s3.get_asset(key).await.unwrap(), Some(object.clone()));

    let bucket_path = format!("/{}/{key}", h.s3.client().config().bucket);
    let tampered = format!("{}{}", &signed[..signed.len() - 4], "0000");
    let presign = format!("/api/v1/campaigns/{campaign_id}/assets/{hash}/presign");
    // (case_id, uri, cookie, expected status, expect a redirect to the object)
    let cases = [
        (
            "valid_signature_redirects",
            signed,
            None,
            StatusCode::TEMPORARY_REDIRECT,
            true,
        ),
        (
            "tampered_signature_refused",
            tampered.as_str(),
            None,
            StatusCode::FORBIDDEN,
            false,
        ),
        (
            "outsider_cannot_presign",
            presign.as_str(),
            Some(outsider.as_str()),
            StatusCode::FORBIDDEN,
            false,
        ),
        (
            "member_presign_succeeds",
            presign.as_str(),
            Some(gm.as_str()),
            StatusCode::OK,
            false,
        ),
    ];
    for (case, uri, cookie, expected, redirects) in cases {
        let (status, location, _) = call(&h.app, "GET", uri, cookie, Body::empty()).await;
        assert_eq!(status, expected, "case {case}");
        assert_eq!(location.is_some(), redirects, "case {case}");
        if let Some(location) = location {
            let origin = h.s3.client().config().public_endpoint.origin();
            assert!(
                location.starts_with(&format!("{origin}{bucket_path}?")),
                "case {case}: {location}"
            );
            assert!(location.contains("X-Amz-Expires=300"), "case {case}");
            let (status, bytes) = fetch(&location).await;
            assert_eq!(status, StatusCode::OK, "case {case}");
            assert_eq!(bytes, object, "case {case}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_migration_copies_inline_blobs_once_and_verifies_hashes() {
    let Some(h) = harness().await else {
        return;
    };
    let payload = Bytes::from(png_bytes());
    let key = format!(
        "instances/{}/campaigns/{}/assets/{}.webp",
        Uuid::new_v4(),
        Uuid::new_v4(),
        Sha256Hasher::digest(&payload)
    );
    h.pg.put_asset(&key, payload.clone(), "image/webp")
        .await
        .unwrap();
    assert_eq!(h.pg.asset_is_external(&key).await.unwrap(), Some(false));
    assert_eq!(h.s3.client().get_object(&key).await.unwrap(), None);
    assert!(
        !h.pg.release_inline_payload(&key, &[0u8; 32]).await.unwrap(),
        "a digest that does not match the payload never releases it"
    );
    assert_eq!(h.s3.get_asset(&key).await.unwrap(), Some(payload.clone()));

    let first = migrate_inline_assets(&h.pg, h.s3.client()).await.unwrap();
    assert_eq!(first.failed, 0);
    assert!(first.copied >= 1, "{first:?}");
    assert_eq!(h.pg.asset_is_external(&key).await.unwrap(), Some(true));
    assert_eq!(
        h.s3.client().get_object(&key).await.unwrap(),
        Some(payload.clone())
    );
    assert_eq!(h.s3.get_asset(&key).await.unwrap(), Some(payload));

    let second = migrate_inline_assets(&h.pg, h.s3.client()).await.unwrap();
    assert_eq!(second, BlobMigrationReport::default(), "rerun is a no-op");
}
