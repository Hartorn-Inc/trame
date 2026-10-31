#![allow(clippy::doc_lazy_continuation)]
//! ============================================================================
//! ARCHIVE & AUTH REST API ROUTES INTEGRATION TEST SUITE (api_routes_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Verifies end-to-end HTTP routing, status codes, headers, streaming archive
//! export/import, GM invite minting, hybrid authentication integration, and
//! sub-5ms database connectivity healthcheck probes in `trame-server::http`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `GET /api/v1/campaigns/:id/export` streams `application/zip` with
//!      `Content-Disposition: attachment; filename="campaign-<id>.trame"` for
//!      authorized campaign members and rejects unauthenticated (`401`) or
//!      non-member (`403`) requests.
//!   2. `POST /api/v1/campaigns/import` restores all campaign entities, notes,
//!      and assets returning `201 Created` with restoration counters, or returns
//!      `409 Conflict` with `"code": "CAMPAIGN_ALREADY_EXISTS"` when importing
//!      an existing campaign without `remap_ids=true`.
//!   3. `POST /api/v1/campaigns/:id/invites` enforces GM authorization (`403`
//!      for non-GM members) and returns `201 Created` with `invite_url`,
//!      `token`, and `expires_at`.
//!   4. `GET /healthz` verifies database connectivity without credentials and
//!      returns `200 OK` with `{"status": "ok"}` in under 5 milliseconds.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   1. Construct `AppState` and `Router` via `build_router_with_state`.
//!   2. Exercise nominal, boundary, and error paths across all REST routes.
//!   3. Assert HTTP status codes, response headers, and deserialized payloads.
//! ============================================================================

use axum::body::Body;
use axum::http::header::{AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_TYPE, COOKIE};
use axum::http::{Request, StatusCode};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tower::ServiceExt;
use trame_server::archive::{
    CampaignMetadata, ExportEntity, ImportResult, InMemoryCampaignStore, NoteRecord,
};
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{
    AuthState, InMemorySessionStore, MagicLinkLoginRequest, MagicLinkLoginResponse,
};
use trame_server::auth::totp::TotpService;
use trame_server::http::{
    AppState, CampaignInviteResponse, CreateCampaignInviteRequest, ErrorResponse, HealthResponse,
    InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
    seed_campaign_for_export,
};
use trame_server::room::RoomLeaseManager;
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

fn create_test_app_state() -> (AppState, Arc<InMemoryMembershipValidator>) {
    let wal = Arc::new(InMemoryWalStorage::new());
    let lease_manager = Arc::new(RoomLeaseManager::new(wal, 25, 900_000));
    let signing_secret = b"test-hmac-sha256-secret-key-for-api-routes";
    let asset_store = Arc::new(InMemoryAssetStore::with_base_url_and_secret(
        "/assets/download",
        signing_secret.to_vec(),
    ));
    let membership = Arc::new(InMemoryMembershipValidator::new());
    let timeline_storage = Arc::new(InMemoryTimelineStorage::new());
    let session_store = Arc::new(InMemorySessionStore::new());
    let magic_link_service = Arc::new(MagicLinkService::new(
        signing_secret,
        "trame-test",
    ));
    let auth_state = AuthState {
        magic_link_service,
        session_store,
        totp_service: Arc::new(TotpService::default()),
    };

    let state = AppState {
        lease_manager,
        asset_store,
        membership: membership.clone(),
        instance_id: Uuid::new_v4(),
        timeline_storage,
        journal_storage: Arc::new(trame_server::notes::InMemoryPartyJournalStorage::new()),
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state,
        pg_store: None,
        db_healthy: Arc::new(AtomicBool::new(true)),
    };

    (state, membership)
}

#[tokio::test]
async fn test_healthz_verifies_database_connectivity_under_5ms() {
    let (state, _) = create_test_app_state();
    let app = build_router_with_state(state.clone());

    let start = Instant::now();
    let req = Request::builder()
        .method("GET")
        .uri("/healthz")
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    let elapsed = start.elapsed();

    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        elapsed.as_millis() < 5,
        "GET /healthz must complete in under 5ms, took {}ms",
        elapsed.as_millis()
    );

    let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let health: HealthResponse = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(health.status, "ok");
    assert_eq!(health.active_rooms, 0);

    // Simulate database connectivity failure -> 503 Service Unavailable
    state.db_healthy.store(false, Ordering::Release);
    let req_fail = Request::builder()
        .method("GET")
        .uri("/healthz")
        .body(Body::empty())
        .unwrap();
    let resp_fail = app.oneshot(req_fail).await.unwrap();
    assert_eq!(resp_fail.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn test_export_and_import_campaign_archive_roundtrip_and_conflict_guard() {
    let (export_state, export_membership) = create_test_app_state();
    let campaign_id = Uuid::new_v4();
    let gm_id = Uuid::new_v4();
    let outsider_id = Uuid::new_v4();
    export_membership.add_gm(campaign_id, gm_id);

    let scene_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let note_id = Uuid::new_v4();
    let asset_id = Uuid::new_v4();

    seed_campaign_for_export(
        &export_state,
        CampaignMetadata {
            id: campaign_id,
            name: "Shadows of Saltmarsh".to_string(),
            system: "dnd5e".to_string(),
            description: Some("Coastal mystery campaign".to_string()),
            created_at: "2026-03-01T12:00:00Z".to_string(),
        },
        vec![
            ExportEntity {
                entity_type: "scene".to_string(),
                data: json!({
                    "id": scene_id.to_string(),
                    "campaign_id": campaign_id.to_string(),
                    "name": "Haunted House"
                }),
            },
            ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": actor_id.to_string(),
                    "campaign_id": campaign_id.to_string(),
                    "name": "Ned Shakeshaft"
                }),
            },
        ],
        vec![NoteRecord {
            id: note_id,
            title: "Smuggler Signal".to_string(),
            folder: Some("clues".to_string()),
            author_id: gm_id,
            created_at: "2026-03-01T12:00:00Z".to_string(),
            updated_at: "2026-03-01T12:30:00Z".to_string(),
            content_markdown: format!("Watch for [[{actor_id}|Ned Shakeshaft]] in [[{scene_id}]]."),
        }],
        vec![(asset_id, b"RIFF....WEBPVP8 ...coastal map webp...")],
    )
    .await
    .expect("seed campaign for export");

    let export_app = build_router_with_state(export_state);

    // 1. Parameterized authorization checks on GET /api/v1/campaigns/:id/export
    let auth_cases = [
        (
            "unauthenticated_request",
            format!("/api/v1/campaigns/{campaign_id}/export"),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "non_member_forbidden",
            format!("/api/v1/campaigns/{campaign_id}/export?user_id={outsider_id}"),
            StatusCode::FORBIDDEN,
        ),
        (
            "authorized_member_ok",
            format!("/api/v1/campaigns/{campaign_id}/export?user_id={gm_id}"),
            StatusCode::OK,
        ),
    ];

    let mut exported_zip_bytes = Vec::new();
    for (case_id, uri, expected_status) in auth_cases {
        let req = Request::builder()
            .method("GET")
            .uri(&uri)
            .body(Body::empty())
            .unwrap();
        let resp = export_app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), expected_status, "failed case: {case_id}");

        if expected_status == StatusCode::OK {
            assert_eq!(
                resp.headers().get(CONTENT_TYPE).unwrap().to_str().unwrap(),
                "application/zip"
            );
            let cd = resp
                .headers()
                .get(CONTENT_DISPOSITION)
                .unwrap()
                .to_str()
                .unwrap();
            assert!(
                cd.contains(&format!("campaign-{campaign_id}.trame")),
                "Content-Disposition header must include filename campaign-<id>.trame, got: {cd}"
            );
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            assert!(bytes.starts_with(b"PK\x03\x04"));
            exported_zip_bytes = bytes.to_vec();
        }
    }

    // 2. Import archive into a fresh server state -> 201 Created with restoration counters
    let (import_state, _) = create_test_app_state();
    let import_app = build_router_with_state(import_state);

    let import_req = Request::builder()
        .method("POST")
        .uri("/api/v1/campaigns/import")
        .header(CONTENT_TYPE, "application/zip")
        .body(Body::from(exported_zip_bytes.clone()))
        .unwrap();
    let import_resp = import_app.clone().oneshot(import_req).await.unwrap();
    assert_eq!(import_resp.status(), StatusCode::CREATED);

    let import_body = axum::body::to_bytes(import_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let restored: ImportResult = serde_json::from_slice(&import_body).unwrap();
    assert_eq!(restored.campaign_id, campaign_id);
    assert_eq!(restored.name, "Shadows of Saltmarsh");
    assert_eq!(restored.actors_restored, 1);
    assert_eq!(restored.scenes_restored, 1);
    assert_eq!(restored.notes_restored, 1);
    assert_eq!(restored.assets_restored, 1);

    // 3. Re-importing same archive without remap_ids=true -> 409 Conflict CAMPAIGN_ALREADY_EXISTS
    let conflict_req = Request::builder()
        .method("POST")
        .uri("/api/v1/campaigns/import")
        .header(CONTENT_TYPE, "application/zip")
        .body(Body::from(exported_zip_bytes.clone()))
        .unwrap();
    let conflict_resp = import_app.clone().oneshot(conflict_req).await.unwrap();
    assert_eq!(conflict_resp.status(), StatusCode::CONFLICT);

    let conflict_body = axum::body::to_bytes(conflict_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let err_payload: ErrorResponse = serde_json::from_slice(&conflict_body).unwrap();
    assert_eq!(err_payload.code.as_deref(), Some("CAMPAIGN_ALREADY_EXISTS"));

    // 4. Re-importing with remap_ids=true -> 201 Created with remapped campaign_id
    let remap_req = Request::builder()
        .method("POST")
        .uri("/api/v1/campaigns/import?remap_ids=true")
        .header(CONTENT_TYPE, "application/zip")
        .body(Body::from(exported_zip_bytes))
        .unwrap();
    let remap_resp = import_app.oneshot(remap_req).await.unwrap();
    assert_eq!(remap_resp.status(), StatusCode::CREATED);

    let remap_body = axum::body::to_bytes(remap_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let remapped: ImportResult = serde_json::from_slice(&remap_body).unwrap();
    assert_ne!(remapped.campaign_id, campaign_id);
    assert_eq!(remapped.actors_restored, 1);
    assert_eq!(remapped.scenes_restored, 1);
    assert_eq!(remapped.notes_restored, 1);
    assert_eq!(remapped.assets_restored, 1);
}

#[tokio::test]
async fn test_campaign_invites_gm_authorization_and_magic_link_onboarding_flow() {
    let (state, membership) = create_test_app_state();
    let campaign_id = Uuid::new_v4();
    let gm_id = Uuid::new_v4();
    let player_id = Uuid::new_v4();
    let character_id = Uuid::new_v4();

    membership.add_gm(campaign_id, gm_id);
    membership.add_player(campaign_id, player_id);

    let app = build_router_with_state(state.clone());

    // 1. Parameterized RBAC checks on POST /api/v1/campaigns/:id/invites
    let rbac_cases = [
        ("unauthenticated", None, StatusCode::UNAUTHORIZED),
        (
            "non_gm_player_forbidden",
            Some(player_id),
            StatusCode::FORBIDDEN,
        ),
        ("gm_authorized_created", Some(gm_id), StatusCode::CREATED),
    ];

    let mut minted_invite: Option<CampaignInviteResponse> = None;

    for (case_id, caller_uid, expected_status) in rbac_cases {
        let payload = CreateCampaignInviteRequest {
            character_id: Some(character_id),
            role: Some("PLAYER".to_string()),
            ttl_seconds: Some(3600),
            user_id: caller_uid,
            ..Default::default()
        };
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/campaigns/{campaign_id}/invites"))
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), expected_status, "failed case: {case_id}");

        if expected_status == StatusCode::CREATED {
            let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            let invite_resp: CampaignInviteResponse = serde_json::from_slice(&body_bytes).unwrap();
            assert!(!invite_resp.token.is_empty());
            assert!(invite_resp.invite_url.contains(&invite_resp.token));
            assert!(invite_resp.expires_at > 0);
            assert_eq!(invite_resp.campaign_id, campaign_id);
            assert_eq!(invite_resp.character_id, Some(character_id));
            minted_invite = Some(invite_resp);
        }
    }

    let invite = minted_invite.expect("GM invite minted");

    // 2. Redeem the minted invite token on POST /api/v1/auth/magic-link mounted on the same router
    let login_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/magic-link")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&MagicLinkLoginRequest {
                token: invite.token,
                ..Default::default()
            })
            .unwrap(),
        ))
        .unwrap();

    let login_resp = app.clone().oneshot(login_req).await.unwrap();
    assert_eq!(login_resp.status(), StatusCode::OK);
    let cookie_header = login_resp
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();

    let login_body = axum::body::to_bytes(login_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let onboarded: MagicLinkLoginResponse = serde_json::from_slice(&login_body).unwrap();
    assert_eq!(onboarded.campaign_id, campaign_id);
    assert_eq!(onboarded.character_id, Some(character_id));

    // 3. Onboarded player can export the campaign using their session cookie!
    let cookie_pair = cookie_header.split(';').next().unwrap();
    let export_req = Request::builder()
        .method("GET")
        .uri(format!("/api/v1/campaigns/{campaign_id}/export"))
        .header(COOKIE, cookie_pair)
        .body(Body::empty())
        .unwrap();
    let export_resp = app.clone().oneshot(export_req).await.unwrap();
    assert_eq!(export_resp.status(), StatusCode::OK);

    // 4. Onboarded player can create a PAT on POST /api/v1/auth/pat and use it on export
    let pat_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/pat")
        .header(COOKIE, cookie_pair)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "scopes": ["campaigns:read"],
                "campaign_id": campaign_id,
                "name": "CLI Backup Token"
            }))
            .unwrap(),
        ))
        .unwrap();
    let pat_resp = app.clone().oneshot(pat_req).await.unwrap();
    assert_eq!(pat_resp.status(), StatusCode::CREATED);
    let pat_body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(pat_resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let raw_pat = pat_body["token"].as_str().unwrap();

    let pat_export_req = Request::builder()
        .method("GET")
        .uri(format!("/api/v1/campaigns/{campaign_id}/export"))
        .header(AUTHORIZATION, format!("Bearer {raw_pat}"))
        .body(Body::empty())
        .unwrap();
    let pat_export_resp = app.clone().oneshot(pat_export_req).await.unwrap();
    assert_eq!(pat_export_resp.status(), StatusCode::OK);

    // 5. Test download_asset_handler authorization with and without signature
    let asset_id = Uuid::new_v4();
    let asset_key = format!(
        "instances/{}/campaigns/{}/assets/{}.webp",
        state.instance_id, campaign_id, asset_id
    );
    state
        .asset_store
        .put_asset(
            &asset_key,
            bytes::Bytes::from_static(b"FAKE_IMAGE"),
            "image/webp",
        )
        .await
        .unwrap();

    // Unauthenticated and unsigned download request -> 403 Forbidden
    let unauth_dl = Request::builder()
        .method("GET")
        .uri(format!("/assets/download/{asset_key}"))
        .body(Body::empty())
        .unwrap();
    let unauth_dl_resp = app.clone().oneshot(unauth_dl).await.unwrap();
    assert_eq!(unauth_dl_resp.status(), StatusCode::FORBIDDEN);

    // Presigned download URL with valid exp and sig -> 200 OK
    let presigned_url = state
        .asset_store
        .mint_presigned_get_url(&asset_key, std::time::Duration::from_secs(900))
        .await
        .unwrap();
    let presigned_dl = Request::builder()
        .method("GET")
        .uri(&presigned_url)
        .body(Body::empty())
        .unwrap();
    let presigned_dl_resp = app.clone().oneshot(presigned_dl).await.unwrap();
    assert_eq!(presigned_dl_resp.status(), StatusCode::OK);

    // Authenticated campaign member download without signature -> 200 OK
    let member_dl = Request::builder()
        .method("GET")
        .uri(format!("/assets/download/{asset_key}"))
        .header(COOKIE, cookie_pair)
        .body(Body::empty())
        .unwrap();
    let member_dl_resp = app.oneshot(member_dl).await.unwrap();
    assert_eq!(member_dl_resp.status(), StatusCode::OK);
}
