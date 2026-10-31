# ADR-0002: Ingestion Pipeline for Universal VTT and Asset Storage Abstraction

## Status
Accepted

## Context
TRAME requires support for importing Universal VTT (`.uvtt` and `.dd2vtt`) battlemaps produced by tools like Dungeondraft and Dungeon Alchemist. An imported map includes a raster image encoded in Base64, grid geometry, line of sight (LOS) blockers, doors (portals), and ambient/point light sources.

Key architectural concerns include:
1. Server resilience and protection against memory exhaustion (decompression bombs, malformed payloads).
2. Deterministic decoding and conversion to WebP with automatic thumbnail generation.
3. Decoupled object storage supporting Cloudflare R2 and S3/MinIO in production while enabling offline unit and integration tests.
4. Strict Role-Based Access Control (RBAC) ensuring non-members of a campaign cannot generate signed URLs or access campaign assets.

## Decision
1. Introduce the `AssetStore` asynchronous trait in `trame-server` providing `put_asset`, `get_asset`, and `mint_presigned_get_url`.
2. Provide `S3Store` (targeting Cloudflare R2 or MinIO) with PostgreSQL/local-disk asset fallback and `InMemoryAssetStore` for unit tests.
3. Implement a pure-Rust image ingestion pipeline using `image` without native C dependencies, enforcing:
   - Maximum payload size of 64 MiB.
   - Maximum raster resolution of 10,000 x 10,000 pixels.
   - Magic bytes verification (PNG, JPEG, WebP, UVTT JSON).
   - WebP re-encoding and thumbnail generation at 256px maximum dimension.
   - Content addressing using SHA-256 digests (`instances/{id}/campaigns/{cid}/assets/{hash}.webp`).
4. Map UVTT vector coordinates from grid units into engine pixels (`x_px = (x_uvtt - origin_x) * pixels_per_grid`, `y_px = (y_uvtt - origin_y) * pixels_per_grid`):
   - `line_of_sight` maps to `WallSegment` with `WallKind::Normal`.
   - `objects_line_of_sight` maps to `WallSegment` with `WallKind::Terrain`.
   - `portals` map to `WallSegment` with `WallKind::Door { is_open: !portal.closed, is_locked: false }`.
   - `lights` map to engine `LightSource` with bright radius equal to `range / 2` and dim radius equal to `range`.
5. Protect the asset pre-signing endpoint (`GET /api/v1/campaigns/{cid}/assets/{hash}/presign`) behind strict campaign membership verification with 15-minute TTL.

## Consequences
### Positive
- Guarantees zero C-library runtime dependency overhead for image encoding/decoding.
- Tests remain 100% deterministic.

### Negative
- Large 10,000 x 10,000 maps incur brief CPU spikes during initial WebP transcoding.
