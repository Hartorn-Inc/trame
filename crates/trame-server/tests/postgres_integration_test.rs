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
//!   - Instance-wide singletons (the `Owner`, `instance_settings`) are shared by
//!     every run, so tests only assert on them relative to the stored value and
//!     never claim the `Owner` (covered in-memory by `accounts_access_test.rs`).
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::assets::store::AssetStore;
use trame_server::auth::accounts::InstanceRole;
use trame_server::auth::session::{IdentityStore, SessionStore, UserRecord, hash_session_token};
use trame_server::campaigns::LIVE_SESSION_NUM;
use trame_server::config::ServerConfig;
use trame_server::http::build_router_with_postgres_store;
use trame_server::instance::resolve_instance_id;
use trame_server::notes::{
    InMemoryPartyJournalStorage, MAX_HANDOUT_TITLE_CHARS, NotesError, PartyJournalEntry,
    PartyJournalStorage,
};
use trame_server::room::RoomLeaseManager;
use trame_server::storage::SqlxPostgresStore;
use trame_server::storage::postgres::journal_row_id;
use trame_server::timeline::{AppendEventInput, TimelineError, TimelineStorage};
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

/// `Host` account (may create campaigns) with a live session.
async fn account_with_id(store: &SqlxPostgresStore) -> (Uuid, String) {
    account_with_role(store, InstanceRole::Host).await
}

async fn account_with_role(
    store: &SqlxPostgresStore,
    instance_role: InstanceRole,
) -> (Uuid, String) {
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
            instance_role,
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
    let (gm_id, gm) = account_with_id(&store).await;
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
    let owner: Uuid = sqlx::query_scalar("SELECT gm_user_id FROM campaigns WHERE id = $1")
        .bind(Uuid::parse_str(new_id).unwrap())
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(owner, gm_id, "the importer owns the imported campaign");

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

// ---------------------------------------------------------------------------
// Party journal: author, idempotent reveal, storage errors
// ---------------------------------------------------------------------------

fn journal_entry(campaign_id: Uuid, handout_id: &str, title: &str, by: Uuid) -> PartyJournalEntry {
    PartyJournalEntry {
        handout_id: handout_id.to_string(),
        campaign_id: campaign_id.to_string(),
        title: title.to_string(),
        session_num: 1,
        content: "A faded map.".to_string(),
        revealed_at: 0,
        revealed_by: by.to_string(),
    }
}

/// Shared scenario: a repeat reveal replaces the campaign's entry (latest title and revealer)
/// and the same handout id in another campaign stays a separate entry.
fn assert_repeat_reveal_keeps_one_entry(
    journal: &dyn PartyJournalStorage,
    (campaign_a, campaign_b): (Uuid, Uuid),
    (gm_1, gm_2): (Uuid, Uuid),
    handout_id: &str,
) {
    journal
        .insert_entry(journal_entry(campaign_a, handout_id, "Map v1", gm_1))
        .unwrap();
    journal
        .insert_entry(journal_entry(campaign_a, handout_id, "Map v2", gm_2))
        .unwrap();
    journal
        .insert_entry(journal_entry(campaign_b, handout_id, "Other map", gm_1))
        .unwrap();
    let a = journal.list_entries(&campaign_a.to_string()).unwrap();
    assert_eq!(a.len(), 1, "{handout_id}: one entry per campaign handout");
    assert_eq!(a[0].title, "Map v2", "{handout_id}");
    assert_eq!(a[0].revealed_by, gm_2.to_string(), "{handout_id}");
    let b = journal.list_entries(&campaign_b.to_string()).unwrap();
    assert_eq!(b.len(), 1, "{handout_id}: other campaign untouched");
    assert_eq!(b[0].title, "Other map", "{handout_id}");
}

const HANDOUT_ID_CASES: [&str; 2] = ["ancient-map", "7d3c9a52-3f0e-4c1b-9a8e-2b6f4d1e5a90"];

#[test]
fn in_memory_repeat_reveal_keeps_one_entry() {
    for handout_id in HANDOUT_ID_CASES {
        let journal = InMemoryPartyJournalStorage::new();
        assert_repeat_reveal_keeps_one_entry(
            &journal,
            (Uuid::new_v4(), Uuid::new_v4()),
            (Uuid::new_v4(), Uuid::new_v4()),
            handout_id,
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_repeat_reveal_keeps_one_row_with_latest_author() {
    let Some((_, store)) = harness().await else {
        return;
    };
    for handout_id in HANDOUT_ID_CASES {
        let (gm_1, _) = account_with_id(&store).await;
        let (gm_2, _) = account_with_id(&store).await;
        let campaigns = (Uuid::new_v4(), Uuid::new_v4());
        assert_repeat_reveal_keeps_one_entry(store.as_ref(), campaigns, (gm_1, gm_2), handout_id);
        let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT id, author_user_id FROM party_journal_entries WHERE campaign_id = $1",
        )
        .bind(campaigns.0)
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![(journal_row_id(campaigns.0, handout_id), gm_2)],
            "{handout_id}: one deterministic row authored by the latest revealer"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_handout_reveal_route_records_gm_as_author_once() {
    let Some((app, store)) = harness().await else {
        return;
    };
    // (case_id, handout id written in the note)
    let cases = [
        ("slug_handout_id", "ancient-map"),
        ("uuid_handout_id", "1b4e28ba-2fa1-41d2-883f-0016d3cca427"),
    ];
    for (case, handout_id) in cases {
        let (gm_id, gm) = account_with_id(&store).await;
        let (status, body) = call_json(
            &app,
            "POST",
            "/api/v1/campaigns",
            &gm,
            json!({ "name": "PG Handouts" }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {body}");
        let campaign_id = Uuid::parse_str(body["campaign"]["id"].as_str().unwrap()).unwrap();
        let note = format!(
            ":::handout{{id=\"{handout_id}\" title=\"Ancient Map\"}}\nA hidden stair.\n:::\n"
        );
        let (status, body) = call_json(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/notes/crypt"),
            &gm,
            json!({ "title": "Crypt Lore", "content_markdown": note }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");

        for attempt in ["first_reveal", "repeat_reveal"] {
            let (status, body) = call_json(
                &app,
                "POST",
                &format!("/api/v1/campaigns/{campaign_id}/handouts/{handout_id}/reveal"),
                &gm,
                json!({}),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "case {case} {attempt}: {body}");
            assert_eq!(
                body["handout"]["title"],
                json!("Ancient Map"),
                "case {case}"
            );
        }
        let authors: Vec<Uuid> = sqlx::query_scalar(
            "SELECT author_user_id FROM party_journal_entries WHERE campaign_id = $1",
        )
        .bind(campaign_id)
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(
            authors,
            vec![gm_id],
            "case {case}: one row authored by the GM"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_handout_reveal_records_session_and_bounds_title() {
    let Some((app, store)) = harness().await else {
        return;
    };
    let at_limit = "é".repeat(MAX_HANDOUT_TITLE_CHARS);
    let over_limit = "é".repeat(MAX_HANDOUT_TITLE_CHARS + 1);
    // (case_id, handout title, reveal body, expected status, expected row session)
    let cases = [
        (
            "explicit_session_num_is_recorded",
            "Ancient Map",
            json!({ "session_num": 7 }),
            StatusCode::OK,
            Some(7),
        ),
        (
            "no_session_num_falls_back_to_live_session",
            "Ancient Map",
            json!({}),
            StatusCode::OK,
            Some(LIVE_SESSION_NUM as i32),
        ),
        (
            "title_at_200_chars_is_accepted",
            at_limit.as_str(),
            json!({}),
            StatusCode::OK,
            Some(LIVE_SESSION_NUM as i32),
        ),
        (
            "title_at_201_chars_is_rejected",
            over_limit.as_str(),
            json!({}),
            StatusCode::BAD_REQUEST,
            None,
        ),
    ];
    for (case, title, reveal_body, expected, session) in cases {
        let gm = account(&store).await;
        let (status, body) = call_json(
            &app,
            "POST",
            "/api/v1/campaigns",
            &gm,
            json!({ "name": "PG Sessions" }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "case {case}: {body}");
        let campaign_id = Uuid::parse_str(body["campaign"]["id"].as_str().unwrap()).unwrap();
        let note = format!(":::handout{{id=\"ancient-map\" title=\"{title}\"}}\nA stair.\n:::\n");
        let (status, body) = call_json(
            &app,
            "PUT",
            &format!("/api/v1/campaigns/{campaign_id}/notes/crypt"),
            &gm,
            json!({ "title": "Crypt Lore", "content_markdown": note }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "case {case}: {body}");

        let (status, body) = call_json(
            &app,
            "POST",
            &format!("/api/v1/campaigns/{campaign_id}/handouts/ancient-map/reveal"),
            &gm,
            reveal_body,
        )
        .await;
        assert_eq!(status, expected, "case {case}: {body}");
        if session.is_none() {
            assert_eq!(body["code"], json!("HANDOUT_TITLE_TOO_LONG"), "case {case}");
        }
        let sessions: Vec<i32> = sqlx::query_scalar(
            "SELECT session_num FROM party_journal_entries WHERE campaign_id = $1",
        )
        .bind(campaign_id)
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(
            sessions,
            session.into_iter().collect::<Vec<_>>(),
            "case {case}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_journal_and_timeline_failures_are_storage_errors() {
    let Some((_, store)) = harness().await else {
        return;
    };
    let campaign = Uuid::new_v4();
    let unknown_user = Uuid::new_v4();
    // (case_id, entry, expected text in the logged cause)
    let journal_cases = [
        (
            "author_not_in_users_violates_fk",
            journal_entry(campaign, "ancient-map", "Map", unknown_user),
            "foreign key",
        ),
        (
            "non_uuid_author",
            PartyJournalEntry {
                revealed_by: "gm".to_string(),
                ..journal_entry(campaign, "ancient-map", "Map", unknown_user)
            },
            "invalid",
        ),
        (
            "non_uuid_campaign",
            PartyJournalEntry {
                campaign_id: "camp-alpha".to_string(),
                ..journal_entry(campaign, "ancient-map", "Map", unknown_user)
            },
            "invalid",
        ),
    ];
    for (case, entry, cause_needle) in journal_cases {
        match store.insert_entry(entry) {
            Err(err @ NotesError::Storage(_)) => {
                assert_eq!(err.to_string(), "storage backend error", "case {case}");
                let NotesError::Storage(cause) = err else {
                    unreachable!()
                };
                assert!(cause.contains(cause_needle), "case {case}: {cause}");
            }
            other => panic!("case {case}: expected NotesError::Storage, got {other:?}"),
        }
    }

    let input = AppendEventInput {
        event_type: "handout_revealed".to_string(),
        actor_id: None,
        payload: json!({}),
        timestamp: None,
    };
    let timeline_cases = [
        (
            "append_non_uuid_campaign",
            store.append_event("camp-alpha", 1, input).err(),
        ),
        (
            "read_non_uuid_campaign",
            store.get_timeline("camp-alpha", 1, 0, 10).err(),
        ),
    ];
    for (case, err) in timeline_cases {
        assert!(
            matches!(err, Some(TimelineError::Storage(_))),
            "case {case}: expected TimelineError::Storage, got {err:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Accounts: persisted instance id, invite redemption, campaign creation gate
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn pg_instance_id_survives_restart() {
    let Some((_, store)) = harness().await else {
        return;
    };
    let persisted = resolve_instance_id(store.as_ref(), None).await.unwrap();
    let url = std::env::var("DATABASE_URL").unwrap();
    let override_id = Uuid::new_v4();
    // (case_id, TRAME_INSTANCE_ID override, expected id)
    let cases = [
        ("restart_reuses_persisted_id", None, persisted),
        ("override_wins", Some(override_id), override_id),
        ("override_does_not_rewrite_persisted_id", None, persisted),
    ];
    for (case, override_id, want) in cases {
        let restarted = SqlxPostgresStore::connect_and_migrate(&url, "/assets/download")
            .await
            .expect("reconnect");
        let got = resolve_instance_id(&restarted, override_id).await.unwrap();
        assert_eq!(got, want, "case {case}");
    }
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM instance_settings")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(rows, 1, "single settings row");
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_member_cannot_create_campaign() {
    let Some((app, store)) = harness().await else {
        return;
    };
    // (case_id, instance role, expected status)
    let cases = [
        (
            "member_forbidden",
            InstanceRole::Member,
            StatusCode::FORBIDDEN,
        ),
        ("host_allowed", InstanceRole::Host, StatusCode::CREATED),
    ];
    for (case, role, want) in cases {
        let (_, cookie) = account_with_role(&store, role).await;
        let (status, body) = call_json(
            &app,
            "POST",
            "/api/v1/campaigns",
            &cookie,
            json!({ "name": "PG Gate" }),
        )
        .await;
        assert_eq!(status, want, "case {case}: {body}");
    }
}

async fn mint_invite(app: &Router, gm: &str, campaign_id: &str, body: Value) -> String {
    let (status, body) = call_json(
        app,
        "POST",
        &format!("/api/v1/campaigns/{campaign_id}/invites"),
        gm,
        body,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["invite"]["token"].as_str().unwrap().to_string()
}

fn pg_visitor(token: &str) -> Value {
    json!({
        "token": token,
        "email": format!("{}@example.com", Uuid::new_v4()),
        "password": "correct-horse-battery-staple-42",
        "display_name": "Sildar",
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_invite_redemption_is_bounded_and_listed() {
    let Some((app, store)) = harness().await else {
        return;
    };
    let gm = account(&store).await;
    let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;
    let token = mint_invite(&app, &gm, &campaign_id, json!({ "max_uses": 2 })).await;
    let (member_id, member) = account_with_role(&store, InstanceRole::Member).await;

    // (case_id, cookie of the redeemer ("" = visitor), expected status, expected code)
    let cases = [
        ("visitor_creates_account", "", StatusCode::CREATED, None),
        (
            "logged_in_member_joins",
            member.as_str(),
            StatusCode::OK,
            None,
        ),
        (
            "repeat_member_is_idempotent",
            member.as_str(),
            StatusCode::OK,
            None,
        ),
        (
            "third_account_exhausts_invite",
            "",
            StatusCode::GONE,
            Some("INVITE_EXHAUSTED"),
        ),
    ];
    for (case, cookie, want_status, want_code) in cases {
        let body = if cookie.is_empty() {
            pg_visitor(&token)
        } else {
            json!({ "token": token })
        };
        let (status, resp) = call_json(&app, "POST", "/api/v1/invites/redeem", cookie, body).await;
        assert_eq!(status, want_status, "case {case}: {resp}");
        assert_eq!(resp["code"].as_str(), want_code, "case {case}");
    }
    let role = store
        .get_campaign_member(Uuid::parse_str(&campaign_id).unwrap(), member_id)
        .await
        .unwrap()
        .map(|m| m.role);
    assert_eq!(role.as_deref(), Some("PLAYER"));

    let (status, body) = call_json(
        &app,
        "GET",
        &format!("/api/v1/campaigns/{campaign_id}/invites/redemptions"),
        &gm,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["redemptions"].as_array().unwrap().len(), 2, "{body}");

    let (status, body) = call_json(
        &app,
        "DELETE",
        &format!("/api/v1/campaigns/{campaign_id}/invites/active"),
        &gm,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["invite"]["status"], json!("revoked"));
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_concurrent_redemptions_respect_max_uses() {
    let Some((app, store)) = harness().await else {
        return;
    };
    let gm = account(&store).await;
    let (campaign_id, _) = create_campaign_with_actor(&app, &gm).await;
    // (case_id, max_uses, concurrent visitors)
    let cases = [
        ("single_use_two_racers", 1, 2),
        ("two_uses_four_racers", 2, 4),
    ];
    for (case, max_uses, racers) in cases {
        let token = mint_invite(&app, &gm, &campaign_id, json!({ "max_uses": max_uses })).await;
        let attempts = (0..racers).map(|_| {
            let app = app.clone();
            let body = pg_visitor(&token);
            tokio::spawn(async move {
                call_json(&app, "POST", "/api/v1/invites/redeem", "", body)
                    .await
                    .0
            })
        });
        let mut statuses = Vec::new();
        for attempt in attempts.collect::<Vec<_>>() {
            statuses.push(attempt.await.unwrap());
        }
        let created = statuses
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count();
        let gone = statuses.iter().filter(|s| **s == StatusCode::GONE).count();
        assert_eq!(created, max_uses, "case {case}: {statuses:?}");
        assert_eq!(gone, racers - max_uses, "case {case}: {statuses:?}");
        let use_count: i32 =
            sqlx::query_scalar("SELECT use_count FROM campaign_invites WHERE token_hash = $1")
                .bind(hash_session_token(&token))
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(use_count as usize, max_uses, "case {case}");
    }
}
