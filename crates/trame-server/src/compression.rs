//! ============================================================================
//! HTTP RESPONSE COMPRESSION (compression.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Cuts server egress (SEC20, D20). On Cloud Run every byte leaving Europe is
//! billed, and the SPA bundle, the WASM engine and every JSON API response are
//! highly repetitive text. Without this layer each page load ships them raw.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Client-Negotiated Encoding`:
//!      - `http_compression_layer` picks gzip, br or zstd from the request's
//!        `Accept-Encoding` (q-values honoured). A request without it, or with
//!        `identity` only, gets the body unchanged. Compressed responses carry
//!        `Content-Encoding` and `Vary: Accept-Encoding`.
//!   2. `Already-Compressed Content Is Skipped`:
//!      - Images (`image/*` except `image/svg+xml`, so WebP battlemaps and PNG
//!        brand assets), fonts (`font/*`, WOFF2 is Brotli inside) and archives
//!        (`application/zip` such as `.trame` exports, `application/gzip`) go
//!        out as-is: compressing them again costs CPU and saves nothing.
//!      - Bodies of at most 32 bytes, gRPC and Server-Sent Events are skipped
//!        (`tower_http` `DefaultPredicate`). A `101 Switching Protocols`
//!        upgrade has an empty body, so the WebSocket handshake is untouched.
//!   3. `Bounded CPU`:
//!      - Default levels: gzip 6, zstd 3, and Brotli 4 (`tower_http` caps the
//!        Brotli default, whose library default of 11 is far too slow for
//!        on-the-fly compression).
//!   4. `BREACH Exposure`:
//!      - Session tokens travel in `Set-Cookie` headers, which HTTP/1.1 never
//!        compresses. Cookies are `SameSite=Lax`, so a cross-site page cannot
//!        make a credentialed `fetch` and measure compressed response sizes.
//! ============================================================================

use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::{CompressionLayer, CompressionLevel};

/// Content-type prefixes whose bodies are already compressed (invariant 2), on top of the
/// `image/*` rule of `DefaultPredicate`.
pub const PRECOMPRESSED_CONTENT_TYPES: [&str; 3] = ["font/", "application/zip", "application/gzip"];

/// Response compression for the whole router: gzip, br or zstd negotiated from
/// `Accept-Encoding`, skipping already-compressed content types (module invariants 1-2).
pub fn http_compression_layer() -> CompressionLayer<impl Predicate> {
    let [fonts, zip, gzip] = PRECOMPRESSED_CONTENT_TYPES.map(NotForContentType::const_new);
    CompressionLayer::new()
        .quality(CompressionLevel::Default)
        .compress_when(DefaultPredicate::new().and(fonts).and(zip).and(gzip))
}
