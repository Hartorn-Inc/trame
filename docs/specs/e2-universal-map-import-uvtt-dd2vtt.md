# Specification: Universal Map Import (.uvtt / dd2vtt), Asset WebP Pipeline & Presigned URLs

## 1. Feature Overview
This feature provides universal map ingestion for TRAME. It allows users and MCP agents to import Universal VTT files (`.uvtt` / `.dd2vtt`). The ingestion pipeline parses map metadata, validates binary inputs, encodes map imagery to WebP with thumbnails, maps vector occlusion geometry into `trame-engine` structures, stores assets in content-addressable storage, and enforces campaign-scoped access control on presigned asset URLs.

## 2. Universal VTT Schema & Validation Contract

### 2.1 File Limits & Magic Bytes
- Maximum payload size: 67,108,864 bytes (64 MiB).
- Payload verification: The server verifies the JSON structure and ensures the `image` field contains valid Base64 data starting with valid magic bytes for PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), or WebP (`52 49 46 46 ... 57 45 42 50`).
- Image dimensions: Decoded raster images MUST NOT exceed 10,000 pixels in width or 10,000 pixels in height.

### 2.2 UVTT JSON Structure
The importer accepts JSON matching the Universal VTT schema v0.2+:
- `format`: Number (e.g., 0.2 or 0.3).
- `resolution`: Object containing:
  - `map_origin`: `{ "x": f64, "y": f64 }`
  - `map_size`: `{ "x": f64, "y": f64 }` (in grid cells)
  - `pixels_per_grid`: integer >= 1
- `image`: Base64-encoded string representing the raster battlemap.
- `line_of_sight`: Array of arrays representing polyline coordinate points `[{ "x": f64, "y": f64 }]`.
- `objects_line_of_sight`: Array of arrays representing low obstacle polyline coordinate points.
- `portals`: Array of portal objects:
  - `position`: `{ "x": f64, "y": f64 }`
  - `bounds`: Array of two coordinate points `[{ "x": f64, "y": f64 }, { "x": f64, "y": f64 }]`
  - `rotation`: f64
  - `closed`: boolean
  - `freestanding`: boolean
- `lights`: Array of light objects:
  - `position`: `{ "x": f64, "y": f64 }`
  - `range`: f64 (in grid cells)
  - `color`: String (hex code `#RRGGBB` or `#AARRGGBB`)
  - `intensity`: f64
  - `shadows`: boolean

## 3. Transformation and Mapping Matrix

### 3.1 Coordinate System Normalization
- All coordinate positions in UVTT are expressed in grid cell units.
- The importer scales every coordinate by `pixels_per_grid` into engine world pixel space:
  - `world_x = uvtt_x * pixels_per_grid`
  - `world_y = uvtt_y * pixels_per_grid`

### 3.2 Geometry Mapping Table
| Source UVTT Element | Target Engine Model | Mapping Rules |
| --- | --- | --- |
| `line_of_sight` polyline segment `(p1, p2)` | `WallSegment` | `kind: WallKind::Normal`, `blocks_movement: true`, `blocks_vision: true`, `blocks_light: true`, `blocks_sound: true`, `bottom_elevation_ft: -1000.0`, `top_elevation_ft: 1000.0` |
| `objects_line_of_sight` polyline segment `(p1, p2)` | `WallSegment` | `kind: WallKind::Terrain`, `blocks_movement: true`, `blocks_vision: true`, `blocks_light: true`, `blocks_sound: true`, `bottom_elevation_ft: 0.0`, `top_elevation_ft: 4.0` |
| `portals` entry | `WallSegment` | `kind: WallKind::Door { is_open: !portal.closed, is_locked: false }`, endpoints derived from `bounds[0]` and `bounds[1]`, `blocks_movement: !is_open`, `blocks_vision: !is_open` |
| `lights` entry | `LightSource` | `position: portal_pos * ppg`, `bright_radius: (range / 2.0) * ppg`, `dim_radius: range * ppg`, `intensity: 1.0`, `color: parse_hex(color)` |

## 4. Asset WebP Ingestion & Storage Pipeline

### 4.1 Image Processing Flow
1. Decode base64 string to raw image buffer using pure-Rust `image` crate.
2. Verify decoded bounds `<= 10000x10000`.
3. Compute SHA-256 hash of the decoded canonical WebP data.
4. Encode primary map image to WebP with quality 85.
5. Generate thumbnail scaled down preserving aspect ratio to fit within 256x256 pixels, encoded as WebP.
6. Persist assets via `AssetStore::put_asset`:
   - Primary: `instances/{instance_id}/campaigns/{campaign_id}/assets/{sha256}.webp`
   - Thumbnail: `instances/{instance_id}/campaigns/{campaign_id}/assets/{sha256}_thumb.webp`

### 4.2 AssetStore Trait Definition
```rust
#[async_trait]
pub trait AssetStore: Send + Sync {
    async fn put_asset(&self, key: &str, data: bytes::Bytes, content_type: &str) -> Result<(), AssetStoreError>;
    async fn mint_presigned_get_url(&self, key: &str, ttl: std::time::Duration) -> Result<url::Url, AssetStoreError>;
}
```

## 5. Security & RBAC Enforcement

### 5.1 Asset Authorization Endpoint
- Route: `GET /api/v1/campaigns/{campaign_id}/assets/{hash}/presign`
- Parameter: `campaign_id` (UUID), `hash` (SHA-256 hex string).
- Processing rules:
  - IF the requesting user is NOT an active member of `campaign_id`, THEN the server returns HTTP 403 Forbidden.
  - IF the asset key does not exist, THEN the server returns HTTP 404 Not Found.
  - IF the user is authenticated and authorized, THEN the server invokes `AssetStore::mint_presigned_get_url` with TTL = 900 seconds (15 minutes) and returns `{ "url": "...", "expires_in_secs": 900 }` with HTTP 200 OK.

## 6. ASD-STE100 Testable Invariants
- WHEN a valid `.uvtt` file is posted to the import endpoint, THEN `trame-server` creates a new map entity with matching grid size and dimensions.
- WHEN a portal has `closed: false`, THEN `trame-server` creates a `WallSegment` with `WallKind::Door { is_open: true, is_locked: false }`.
- WHEN a portal has `closed: true`, THEN `trame-server` creates a `WallSegment` with `WallKind::Door { is_open: false, is_locked: false }`.
- WHEN an uploaded file exceeds 64 MiB, THEN `trame-server` rejects the payload with HTTP 413 Payload Too Large.
- WHEN an unauthenticated or non-campaign-member user requests a presigned URL, THEN `trame-server` rejects the request with HTTP 403 Forbidden.
- WHEN a valid light is imported with range 10 cells and pixels_per_grid 100, THEN `trame-server` creates a light source with bright radius 500.0 px and dim radius 1000.0 px.