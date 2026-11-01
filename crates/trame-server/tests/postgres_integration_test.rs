//! ============================================================================
//! POSTGRESQL INTEGRATION SUITE (postgres_integration_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Exercises the real `SqlxPostgresStore` behind the production router:
//!   embedded migrations, actor optimistic concurrency (`409 VERSION_CONFLICT`,
//!   ADR-0037) and a `.trame` export -> import round trip that restores actors
//!   into the `actors` table.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Runs only when `DATABASE_URL` is non-empty (CI provides `postgres:18-alpine`);
//!     otherwise each test returns early so local `cargo test` stays hermetic.
//!   - Every test uses fresh UUIDs, so reruns against the same database never
//!     collide.
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::auth::session::{IdentityStore, SessionStore, UserRecord, hash_session_token};
use trame_server::config::ServerConfig;
use trame_server::http::build_router_with_postgres_store;
use trame_server::room::RoomLeaseManager;
use trame_server::storage::SqlxPostgresStore;
use uuid::Uuid;

async fn harness() -> Option<(Router, Arc<SqlxPostgresStore>)> {
    let Some(url) = std::env::var("DATABASE_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
    else {
        eprintln!("DATABASE_URL not set; skipping PostgreSQL integration test");
        return None;
    };
    let store = Arc::new(
        SqlxPostgresStore::connect_and_migrate(&url, "/assets/download")
            .await
            .expect("connect and migrate"),
    );
    let lease_manager = Arc::new(RoomLeaseManager::new(store.clone(), 25, 900_000));
    let app = build_router_with_postgres_store(
        store.clone(),
        lease_manager,
        Uuid::new_v4(),
        &ServerConfig::dev(),
    );
    Some((app, store))
}

async fn account(store: &SqlxPostgresStore) -> String {
    let user_id = Uuid::new_v4();
    store
        .save_user(UserRecord {
            id: user_id,
            username: format!("pg-{user_id}"),
            role: "PLAYER".to_string(),
            is_guest: false,
            created_at: 0,
            email: Some(format!("{user_id}@example.com")),
            password_hash: None,
            mfa_enabled: false,
            totp_secret: None,
            pending_totp_secret: None,
        })
        .await
        .unwrap();
    let token = format!("pg-session-{user_id}");
    store
        .create_session(user_id, &hash_session_token(&token), 3600)
        .await
        .unwrap();
    format!("trame_session={token}")
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: &str,
    body: Body,
) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie)
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, bytes.to_vec())
}

async fn call_json(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: &str,
    body: Value,
) -> (StatusCode, Value) {
    let (status, bytes) = call(app, method, uri, cookie, Body::from(body.to_string())).await;
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn create_campaign_with_actor(app: &Router, gm: &str) -> (String, String) {
    let (status, body) = call_json(
        app,
        "POST",
        "/api/v1/campaigns",
        gm,
        json!({ "name": "PG Campaign" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let campaign_id = body["campaign"]["id"].as_str().unwrap().to_string();
    let (status, body) = call_json(
        app,
        "POST",
        &format!("/api/v1/campaigns/{campaign_id}/actors"),
        gm,
        json!({ "name": "Sildar", "data": { "attributes": { "hp": { "current": 10, "max": 10 } } } }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    (
        campaign_id,
        body["actor"]["id"].as_str().unwrap().to_string(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_actor_put_returns_409_on_stale_version() {
    let Some((app, store)) = harness().await else {
        return;
    };
    let gm = account(&store).await;
    let (campaign_id, actor_id) = create_campaign_with_actor(&app, &gm).await;
    let uri = format!("/api/v1/campaigns/{campaign_id}/actors/{actor_id}");

    let cases = [
        ("current_version_accepted", 1, StatusCode::OK),
        ("replayed_version_conflicts", 1, StatusCode::CONFLICT),
        ("next_version_accepted", 2, StatusCode::OK),
    ];
    for (case, expected_version, status_want) in cases {
        let (status, body) = call_json(
            &app,
            "PUT",
            &uri,
            &gm,
            json!({ "expected_version": expected_version, "data": { "attributes": { "hp": { "current": 5, "max": 10 } } } }),
        )
        .await;
        assert_eq!(status, status_want, "case {case}: {body}");
        if status_want == StatusCode::CONFLICT {
            assert_eq!(body["code"], json!("VERSION_CONFLICT"), "case {case}");
        }
    }
}

fn scene_set(expected_version: i64) -> Value {
    json!({
        "expected_version": expected_version,
        "scenes": [{
            "id": Uuid::new_v4(),
            "campaign_id": Uuid::nil(),
            "name": "Cragmaw Hideout",
            "grid_size_px": 70,
            "grid_cell_distance_ft": 5.0,
            "width_px": 1400,
            "height_px": 1400,
            "revealed_to_players": false
        }]
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_scene_put_enforces_expected_version() {
    let Some((app, store)) = harness().await else {
        return;
    };
    let gm = account(&store).await;
    let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;
    let uri = format!("/api/v1/campaigns/{campaign_id}/maps");

    let (status, body) = call_json(&app, "GET", &uri, &gm, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], json!(0));

    // (case, expected_version, status, version after)
    let cases = [
        ("version_zero_accepted", 0, StatusCode::OK, 1),
        ("replayed_version_conflicts", 0, StatusCode::CONFLICT, 1),
        ("next_version_accepted", 1, StatusCode::OK, 2),
    ];
    for (case, expected_version, status_want, version_after) in cases {
        let (status, body) = call_json(&app, "PUT", &uri, &gm, scene_set(expected_version)).await;
        assert_eq!(status, status_want, "case {case}: {body}");
        if status_want == StatusCode::CONFLICT {
            assert_eq!(body["code"], json!("VERSION_CONFLICT"), "case {case}");
            assert_eq!(body["current_version"], json!(version_after), "case {case}");
        } else {
            assert_eq!(body["version"], json!(version_after), "case {case}");
        }
    }

    let (a, b) = tokio::join!(
        call_json(&app, "PUT", &uri, &gm, scene_set(2)),
        call_json(&app, "PUT", &uri, &gm, scene_set(2)),
    );
    let statuses = [a.0, b.0];
    assert!(
        statuses.contains(&StatusCode::OK) && statuses.contains(&StatusCode::CONFLICT),
        "concurrent saves: {a:?} {b:?}"
    );
    let (_, body) = call_json(&app, "GET", &uri, &gm, Value::Null).await;
    assert_eq!(body["version"], json!(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_archive_import_starts_scene_set_at_version_zero() {
    let Some((app, store)) = harness().await else {
        return;
    };
    let gm = account(&store).await;
    let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;
    let maps = format!("/api/v1/campaigns/{campaign_id}/maps");
    let (status, body) = call_json(&app, "PUT", &maps, &gm, scene_set(0)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, archive) = call(
        &app,
        "GET",
        &format!("/api/v1/campaigns/{campaign_id}/export"),
        &gm,
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, bytes) = call(
        &app,
        "POST",
        "/api/v1/campaigns/import",
        &gm,
        Body::from(archive),
    )
    .await;
    let imported: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::CREATED, "{imported}");
    let new_maps = format!(
        "/api/v1/campaigns/{}/maps",
        imported["campaign_id"].as_str().unwrap()
    );

    let (status, body) = call_json(&app, "GET", &new_maps, &gm, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], json!(0));
    let (status, body) = call_json(&app, "PUT", &new_maps, &gm, scene_set(0)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], json!(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_archive_round_trip_restores_actors() {
    let Some((app, store)) = harness().await else {
        return;
    };
    let gm = account(&store).await;
    let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;

    let (status, archive) = call(
        &app,
        "GET",
        &format!("/api/v1/campaigns/{campaign_id}/export"),
        &gm,
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, bytes) = call(
        &app,
        "POST",
        "/api/v1/campaigns/import",
        &gm,
        Body::from(archive),
    )
    .await;
    let imported: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::CREATED, "{imported}");
    assert_eq!(imported["actors_restored"], json!(1));
    let new_id = imported["campaign_id"].as_str().unwrap();
    assert_ne!(new_id, campaign_id);

    let (status, body) = call_json(
        &app,
        "GET",
        &format!("/api/v1/campaigns/{new_id}/actors"),
        &gm,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let names: Vec<&str> = body["actors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Sildar"]);
}
