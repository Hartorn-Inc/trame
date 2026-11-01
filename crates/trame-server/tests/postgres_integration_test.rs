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
use trame_server::assets::store::AssetStore;
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
    account_with_id(store).await.1
}

async fn account_with_id(store: &SqlxPostgresStore) -> (Uuid, String) {
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
    (user_id, format!("trame_session={token}"))
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

fn scene_with_secrets(name: &str, revealed: bool) -> Value {
    json!({
        "id": Uuid::new_v4(),
        "campaign_id": Uuid::nil(),
        "name": name,
        "grid_size_px": 70,
        "grid_cell_distance_ft": 5.0,
        "width_px": 1400,
        "height_px": 1400,
        "revealed_to_players": revealed,
        "wall_segments": [{
            "id": Uuid::new_v4(),
            "p1": { "x": 0.0, "y": 0.0 },
            "p2": { "x": 140.0, "y": 0.0 },
            "wall_type": "SecretDoor",
            "door_state": "Closed"
        }],
        "staged_tokens": [{
            "id": Uuid::new_v4(), "name": "Ambush Goblin", "x": 70.0, "y": 70.0,
            "visibility": "GmHidden"
        }],
        "spatial_audio_emitters": [{
            "id": Uuid::new_v4(), "x": 10.0, "y": 10.0, "elevation_ft": 0.0,
            "radius_ft": 30.0, "volume": 1.0, "looping": true, "gm_only": true,
            "audio_clip_url": "secret.ogg"
        }]
    })
}

async fn export_then_import(app: &Router, gm: &str, campaign_id: &str) -> Value {
    let (status, archive) = call(
        app,
        "GET",
        &format!("/api/v1/campaigns/{campaign_id}/export"),
        gm,
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, bytes) = call(
        app,
        "POST",
        "/api/v1/campaigns/import",
        gm,
        Body::from(archive),
    )
    .await;
    let imported: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::CREATED, "{imported}");
    imported
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_archive_round_trip_restores_scenes_with_player_masking() {
    let Some((app, store)) = harness().await else {
        return;
    };
    // (case, scenes as (name, revealed_to_players))
    let cases: [(&str, &[(&str, bool)]); 3] = [
        ("no_scenes", &[]),
        ("one_hidden_scene", &[("Cragmaw Hideout", false)]),
        (
            "several_scenes_mixed_visibility",
            &[
                ("Phandalin", true),
                ("Cragmaw Hideout", false),
                ("Wave Echo Cave", true),
            ],
        ),
    ];
    for (case, spec) in cases {
        let gm = account(&store).await;
        let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;
        let scenes: Vec<Value> = spec
            .iter()
            .map(|(name, revealed)| scene_with_secrets(name, *revealed))
            .collect();
        let maps = format!("/api/v1/campaigns/{campaign_id}/maps");
        let body = json!({ "expected_version": 0, "scenes": scenes });
        let (status, body) = call_json(&app, "PUT", &maps, &gm, body).await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");

        let imported = export_then_import(&app, &gm, &campaign_id).await;
        assert_eq!(
            imported["scenes_restored"],
            json!(spec.len()),
            "case {case}"
        );
        let new_id = imported["campaign_id"].as_str().unwrap().to_string();
        let new_maps = format!("/api/v1/campaigns/{new_id}/maps");

        let (status, gm_view) = call_json(&app, "GET", &new_maps, &gm, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "case {case}: {gm_view}");
        assert_eq!(gm_view["version"], json!(0), "case {case}");
        let gm_scenes = gm_view["scenes"].as_array().unwrap().clone();
        let names: Vec<&str> = gm_scenes
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        let want: Vec<&str> = spec.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, want, "case {case}: scene order");
        for scene in &gm_scenes {
            assert_eq!(scene["campaign_id"], json!(new_id), "case {case}");
            assert_eq!(
                scene["wall_segments"][0]["wall_type"],
                json!("SecretDoor"),
                "case {case}"
            );
        }

        let (player_id, player) = account_with_id(&store).await;
        let new_uuid = Uuid::parse_str(&new_id).unwrap();
        store
            .assign_campaign_member(new_uuid, player_id, None, "PLAYER")
            .await
            .unwrap();
        let (status, player_view) = call_json(&app, "GET", &new_maps, &player, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "case {case}: {player_view}");
        let revealed: Vec<&str> = spec.iter().filter(|s| s.1).map(|s| s.0).collect();
        let player_scenes = player_view["scenes"].as_array().unwrap();
        let player_names: Vec<&str> = player_scenes
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(player_names, revealed, "case {case}: only revealed scenes");
        for scene in player_scenes {
            assert_eq!(scene["wall_segments"][0]["wall_type"], json!("Normal"));
            assert_eq!(scene["staged_tokens"], json!([]), "case {case}");
            assert_eq!(scene["spatial_audio_emitters"], json!([]), "case {case}");
        }

        let body = json!({ "expected_version": 0, "scenes": gm_scenes });
        let (status, body) = call_json(&app, "PUT", &new_maps, &gm, body).await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");
        assert_eq!(body["version"], json!(1), "case {case}");

        let reimported = export_then_import(&app, &gm, &new_id).await;
        assert_eq!(
            reimported["scenes_restored"],
            json!(spec.len()),
            "case {case}: re-export does not duplicate scenes"
        );
    }
}

fn png_bytes() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(8, 8, image::Rgb([40, 90, 160]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_archive_round_trip_keeps_actor_owner_and_data() {
    let Some((app, store)) = harness().await else {
        return;
    };
    // (case, owned by a player)
    let cases = [
        ("gm_npc_without_owner", false),
        ("player_owned_sheet", true),
    ];
    for (case, owner_kept) in cases {
        let gm = account(&store).await;
        let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;
        let (player_id, _) = account_with_id(&store).await;
        let owner = if owner_kept {
            json!(player_id)
        } else {
            Value::Null
        };
        let (status, body) = call_json(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/actors"),
            &gm,
            json!({ "name": "Zz Owned", "owner_user_id": owner, "data": { "attributes": { "hp": { "current": 3, "max": 9 } } } }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {body}");

        let imported = export_then_import(&app, &gm, &campaign_id).await;
        assert_eq!(imported["actors_restored"], json!(2), "case {case}");
        let new_id = imported["campaign_id"].as_str().unwrap();
        let (_, body) = call_json(
            &app,
            "GET",
            &format!("/api/v1/campaigns/{new_id}/actors"),
            &gm,
            Value::Null,
        )
        .await;
        let owned = body["actors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == json!("Zz Owned"))
            .unwrap_or_else(|| panic!("case {case}: actor restored: {body}"));
        let want_owner = if owner_kept {
            json!(player_id)
        } else {
            Value::Null
        };
        assert_eq!(owned["owner_user_id"], want_owner, "case {case}");
        assert_eq!(
            owned["data"]["attributes"]["hp"]["current"],
            json!(3),
            "case {case}"
        );
        assert!(owned["data"].get("owner_user_id").is_none(), "case {case}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_archive_round_trip_restores_and_rewrites_asset_keys() {
    let Some((app, store)) = harness().await else {
        return;
    };
    // (case, where the key is referenced, whether its blob exists at export)
    let cases = [
        ("scene_background", "scene_background", true),
        ("actor_portrait", "actor_portrait", true),
        ("deleted_blob_is_reported", "actor_portrait", false),
    ];
    for (case, place, blob_exists) in cases {
        let gm = account(&store).await;
        let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;
        let (status, bytes) = call(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/assets"),
            &gm,
            Body::from(png_bytes()),
        )
        .await;
        let upload: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status, StatusCode::CREATED, "case {case}: {upload}");
        let uploaded = upload["key"].as_str().unwrap().to_string();
        let key = if blob_exists {
            uploaded
        } else {
            uploaded.replace(upload["hash"].as_str().unwrap(), &"f".repeat(64))
        };
        if place == "scene_background" {
            let mut body = scene_set(0);
            body["scenes"][0]["background_image_url"] = json!(key);
            let maps = format!("/api/v1/campaigns/{campaign_id}/maps");
            let (status, body) = call_json(&app, "PUT", &maps, &gm, body).await;
            assert_eq!(status, StatusCode::OK, "case {case}: {body}");
        } else {
            let (status, body) = call_json(
                &app,
                "POST",
                &format!("/api/v1/campaigns/{campaign_id}/actors"),
                &gm,
                json!({ "name": "Zz Portrait", "data": { "portraitAssetKey": key } }),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "case {case}: {body}");
        }

        let imported = export_then_import(&app, &gm, &campaign_id).await;
        let new_id = imported["campaign_id"].as_str().unwrap().to_string();
        let new_key = key.replace(&campaign_id, &new_id);
        let want_missing = if blob_exists { json!([]) } else { json!([key]) };
        assert_eq!(imported["missing_asset_keys"], want_missing, "case {case}");

        let restored_ref = if place == "scene_background" {
            let maps = format!("/api/v1/campaigns/{new_id}/maps");
            let (_, body) = call_json(&app, "GET", &maps, &gm, Value::Null).await;
            body["scenes"][0]["background_image_url"].clone()
        } else {
            let actors = format!("/api/v1/campaigns/{new_id}/actors");
            let (_, body) = call_json(&app, "GET", &actors, &gm, Value::Null).await;
            body["actors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == json!("Zz Portrait"))
                .map(|a| a["data"]["portraitAssetKey"].clone())
                .unwrap_or(Value::Null)
        };
        assert_eq!(restored_ref, json!(new_key), "case {case}: key rewritten");
        let restored = store.get_asset(&new_key).await.unwrap();
        assert_eq!(
            restored,
            store.get_asset(&key).await.unwrap(),
            "case {case}"
        );
        assert_eq!(restored.is_some(), blob_exists, "case {case}");
    }
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
