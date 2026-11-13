//! ============================================================================
//! HTTP RESPONSE COMPRESSION CONTRACT (traffic_compression_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Checks through the full router that text responses (the SPA bundle, JSON
//!   files, API errors, SVG) are compressed with the encoding the client asked
//!   for, and that already-compressed bodies (WebP, PNG, WOFF2, zip) never are
//!   (D20, SEC20).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Every case serves a highly repetitive body, so a skipped compression is
//!     a content-type decision and never a "too small to help" one.
//! ============================================================================

use axum::Router;
use axum::body::Body;
use axum::http::header::{ACCEPT_ENCODING, CONTENT_ENCODING, VARY};
use axum::http::{Request, StatusCode};
use std::sync::Arc;
use tower::ServiceExt;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::config::ServerConfig;
use trame_server::http::{InMemoryMembershipValidator, build_in_memory_router_with_config};
use trame_server::room::RoomLeaseManager;
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

/// Repetitive payload of about 4 KiB that every compressor shrinks a lot.
fn repetitive(unit: &str) -> Vec<u8> {
    unit.repeat(4096 / unit.len() + 1).into_bytes()
}

/// Router serving a temporary SPA directory holding one file per content type.
fn app_with_static_files() -> Router {
    let dir = std::env::temp_dir().join(format!("trame-compression-{}", Uuid::new_v4()));
    let files = [
        ("index.html", repetitive("<p>TRAME table</p>")),
        (
            "assets/index-abc.js",
            repetitive("export const token = 1;\n"),
        ),
        (
            "assets/srd.json",
            repetitive("{\"name\":\"Goblin\",\"cr\":0.25},"),
        ),
        ("assets/map.webp", repetitive("RIFFWEBPVP8 ")),
        ("brand/logo.png", repetitive("\u{89}PNG chunk ")),
        ("brand/mark.svg", repetitive("<path d=\"M0 0L1 1\"/>")),
        ("fonts/atlas.woff2", repetitive("wOF2 glyph ")),
        ("exports/campaign.zip", repetitive("PK\u{3}\u{4} entry ")),
    ];
    for (path, body) in files {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, body).unwrap();
    }
    let mut config = ServerConfig::dev();
    config.static_dir = Some(dir);
    build_in_memory_router_with_config(
        Arc::new(RoomLeaseManager::new(
            Arc::new(InMemoryWalStorage::new()),
            25,
            900_000,
        )),
        Arc::new(InMemoryAssetStore::with_ephemeral_secret()),
        Arc::new(InMemoryMembershipValidator::new()),
        Uuid::new_v4(),
        Arc::new(InMemoryTimelineStorage::new()),
        &config,
    )
}

#[tokio::test]
async fn responses_are_compressed_per_accept_encoding_except_precompressed_types() {
    let app = app_with_static_files();
    // (case_id, path, Accept-Encoding, expected status, expected Content-Encoding)
    let cases: [(&str, &str, Option<&str>, StatusCode, Option<&str>); 15] = [
        (
            "js_gzip",
            "/assets/index-abc.js",
            Some("gzip"),
            StatusCode::OK,
            Some("gzip"),
        ),
        (
            "js_br",
            "/assets/index-abc.js",
            Some("br"),
            StatusCode::OK,
            Some("br"),
        ),
        (
            "js_zstd",
            "/assets/index-abc.js",
            Some("zstd"),
            StatusCode::OK,
            Some("zstd"),
        ),
        (
            "js_highest_q_value_wins",
            "/assets/index-abc.js",
            Some("gzip;q=0.5, br;q=1.0"),
            StatusCode::OK,
            Some("br"),
        ),
        (
            "js_identity_only_stays_plain",
            "/assets/index-abc.js",
            Some("identity"),
            StatusCode::OK,
            None,
        ),
        (
            "js_without_accept_encoding_stays_plain",
            "/assets/index-abc.js",
            None,
            StatusCode::OK,
            None,
        ),
        (
            "json_file_gzip",
            "/assets/srd.json",
            Some("gzip"),
            StatusCode::OK,
            Some("gzip"),
        ),
        (
            "json_api_error_zstd",
            "/api/v1/campaigns",
            Some("zstd"),
            StatusCode::UNAUTHORIZED,
            Some("zstd"),
        ),
        (
            "spa_html_br",
            "/campaigns/abc/table",
            Some("br"),
            StatusCode::OK,
            Some("br"),
        ),
        (
            "svg_image_is_text_and_compressed",
            "/brand/mark.svg",
            Some("gzip"),
            StatusCode::OK,
            Some("gzip"),
        ),
        (
            "webp_battlemap_skipped",
            "/assets/map.webp",
            Some("gzip, br, zstd"),
            StatusCode::OK,
            None,
        ),
        (
            "png_image_skipped",
            "/brand/logo.png",
            Some("gzip, br, zstd"),
            StatusCode::OK,
            None,
        ),
        (
            "woff2_font_skipped",
            "/fonts/atlas.woff2",
            Some("gzip, br, zstd"),
            StatusCode::OK,
            None,
        ),
        (
            "zip_archive_skipped",
            "/exports/campaign.zip",
            Some("gzip, br, zstd"),
            StatusCode::OK,
            None,
        ),
        (
            "plain_request_skips_zip_too",
            "/exports/campaign.zip",
            None,
            StatusCode::OK,
            None,
        ),
    ];
    for (case, path, accept, want_status, want_encoding) in cases {
        let mut request = Request::builder().uri(path);
        if let Some(accept) = accept {
            request = request.header(ACCEPT_ENCODING, accept);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), want_status, "case {case}");
        let encoding = response
            .headers()
            .get(CONTENT_ENCODING)
            .map(|v| v.to_str().unwrap().to_string());
        assert_eq!(encoding.as_deref(), want_encoding, "case {case}");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        if want_encoding.is_some() && want_status == StatusCode::OK {
            assert!(
                body.len() < 1024,
                "case {case}: a 4 KiB repetitive body must shrink, got {} bytes",
                body.len()
            );
        }
        if want_encoding.is_none() && want_status == StatusCode::OK {
            assert!(body.len() >= 4096, "case {case}: body must be sent raw");
        }
    }
}

#[tokio::test]
async fn compressed_responses_vary_on_accept_encoding() {
    let response = app_with_static_files()
        .oneshot(
            Request::builder()
                .uri("/assets/index-abc.js")
                .header(ACCEPT_ENCODING, "gzip")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let vary = response
        .headers()
        .get_all(VARY)
        .iter()
        .map(|v| v.to_str().unwrap().to_ascii_lowercase())
        .collect::<Vec<_>>();
    assert!(
        vary.iter().any(|v| v.contains("accept-encoding")),
        "Vary must name Accept-Encoding so shared caches keep encodings apart: {vary:?}"
    );
}
