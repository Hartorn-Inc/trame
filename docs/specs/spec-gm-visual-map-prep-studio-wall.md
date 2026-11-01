# Technical & Functional Specification: GM Visual Map Prep Studio & Player SceneAtlas

## 1. Executive Summary & Scope

This specification defines the architecture and business rules for the `MapsStudioTab` tab of the `CampaignWorkspace` component. The system includes:
1. A **Map Prep Studio** for the game master to create, import, edit and organize map scenes (`CampaignMapScene`);
2. A 2.5D geometric editor (`MapsStudioTab Canvas`) to draw and edit wall segments (`WallSegment`), place light sources (`LightSource`), configure sound emitters (`SpatialAudioEmitter`), pre-place ambush tokens (`StagedToken`), and paint the fog of war manually (`DualBufferFogOfWar`);
3. A scene transition orchestrator (`ActivateScene`) that instantly deploys a prepared scene to the active table managed by `TableRoomActor`, carrying over the players' heroes (`HeroToken`) without losing dynamic state;
4. An interactive map gallery for players (`SceneAtlas`), protected by a zero-trust security policy that hides secret doors, illusory walls and hidden creatures.

---

## 2. Canonical Terms & ASD-STE100 Invariants

This document strictly applies the ASD-STE100 standard and the project's canonical glossary:
- **Explicit actor**: every technical requirement statement names the subject module (`TableRoomActor`, `SpatialAudioManager`, `DualBufferFogOfWar`, `MapsStudioTab Canvas`, `BackendController`).
- **Prohibited terms**: the synonyms `Push to Live Table`, `Visual Map Editor`, `multi-scene gallery grid`, `sound dampening` and `DD2VTT` are replaced by their canonical equivalents `ActivateScene`, `MapsStudioTab Canvas`, `SceneAtlas`, `AcousticOcclusion` and `UvttMap`. In scene persistence, GM-hidden visibility is written `VisibilityChannel::GmHidden` (the engine's bitmask equivalent is `CHANNEL_GM_HIDDEN`).

---

## 3. Persistence Schema and Rust Data Models

### 3.1 SQL Database Migration (`campaign_map_scenes`)

The backend stores campaign scenes in the PostgreSQL table `campaign_map_scenes`:

```sql
CREATE TABLE campaign_map_scenes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    grid_type VARCHAR(20) NOT NULL DEFAULT 'Square',
    grid_size_px INT NOT NULL DEFAULT 70,
    grid_cell_distance_ft REAL NOT NULL DEFAULT 5.0,
    width_px INT NOT NULL,
    height_px INT NOT NULL,
    background_image_url TEXT,
    default_ground_elevation_ft REAL NOT NULL DEFAULT 0.0,
    revealed_to_players BOOLEAN NOT NULL DEFAULT false,
    spawn_points JSONB NOT NULL DEFAULT '[]'::jsonb,
    wall_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
    light_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
    spatial_audio_emitters JSONB NOT NULL DEFAULT '[]'::jsonb,
    staged_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
    explored_fog_texture BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_campaign_map_scenes_campaign_id ON campaign_map_scenes(campaign_id);
```

### 3.2 Rust Domain Data Models (`trame-engine / trame-server`)

> **Convergence note (spec v3, audit A29):** the engine's `WallSegment` (`crates/trame-engine/src/geometry.rs`, with `WallKind`) is the only wall type. The `WallType` / `WallSegment` shapes below describe the scene persistence payload; `crates/trame-server/src/maps.rs` maps them onto the engine type instead of keeping a duplicate.

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GridType {
    Square,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WallType {
    Normal,
    Window,
    Terrain,
    Door,
    SecretDoor,
    Illusion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DoorState {
    Open,
    Closed,
    Locked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VisibilityChannel {
    Public,
    GmHidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WallSegment {
    pub id: Uuid,
    pub p1: Point2D,
    pub p2: Point2D,
    pub wall_type: WallType,
    pub door_state: Option<DoorState>,
    pub bottom_elevation_ft: f32,
    pub top_elevation_ft: f32,
    pub blocks_light: bool,
    pub blocks_movement: bool,
    pub blocks_sound: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LightSource {
    pub id: Uuid,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub radius_ft: f32,
    pub color_hex: String,
    pub intensity: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpatialAudioEmitter {
    pub id: Uuid,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub radius_ft: f32,
    pub volume: f32,
    pub looping: bool,
    pub gm_only: bool,
    pub audio_clip_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedToken {
    pub id: Uuid,
    pub name: String,
    pub monster_template_id: Option<String>,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub size_cells: u32,
    pub token_avatar_url: Option<String>,
    pub visibility: VisibilityChannel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpawnPoint {
    pub id: Uuid,
    pub name: String,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CampaignMapScene {
    pub id: Uuid,
    pub campaign_id: Uuid,
    pub name: String,
    pub grid_type: GridType,
    pub grid_size_px: u32,
    pub grid_cell_distance_ft: f32,
    pub width_px: u32,
    pub height_px: u32,
    pub background_image_url: Option<String>,
    pub default_ground_elevation_ft: f32,
    pub revealed_to_players: bool,
    pub spawn_points: Vec<SpawnPoint>,
    pub wall_segments: Vec<WallSegment>,
    pub light_sources: Vec<LightSource>,
    pub spatial_audio_emitters: Vec<SpatialAudioEmitter>,
    pub staged_tokens: Vec<StagedToken>,
    pub explored_fog_texture: Option<Vec<u8>>,
}
```

---

## 4. REST API Endpoints & Zero-Trust Security

### 4.1 Route Specification

- `GET /api/v1/campaigns/{campaign_id}/maps`: lists the campaign's scenes.
- `POST /api/v1/campaigns/{campaign_id}/maps`: creates a new map scene.
- `GET /api/v1/campaigns/{campaign_id}/maps/{map_id}`: gets one scene with its full geometry.
- `PUT /api/v1/campaigns/{campaign_id}/maps/{map_id}`: updates the prepared scene (GM only).
- `DELETE /api/v1/campaigns/{campaign_id}/maps/{map_id}`: deletes the prepared scene (GM only).
- `POST /api/v1/campaigns/{campaign_id}/maps/{map_id}/activate`: runs `ActivateScene` on the active table.
- `POST /api/v1/campaigns/{campaign_id}/maps/import`: imports a `.uvtt` / `.dd2vtt` file as a new scene (GM only, see section 7).

### 4.2 Zero-Trust Filtering Matrix for Players

WHEN a user with the `CampaignRole::Player` role sends a `GET` request to `/api/v1/campaigns/{campaign_id}/maps`, THEN the backend filters the selection with the following strict rules:
1. The backend excludes every scene where `revealed_to_players == false`.
2. For every allowed scene returned to the player:
   - The backend changes every `WallSegment` of type `WallType::SecretDoor` with `door_state != Some(DoorState::Open)` into `WallType::Normal`, with `door_state = None`.
   - The backend changes every `WallSegment` of type `WallType::Illusion` into `WallType::Normal`.
   - The backend removes every token from `staged_tokens` with `visibility == VisibilityChannel::GmHidden`.
   - The backend removes every emitter from `spatial_audio_emitters` with `gm_only == true`.
   - The backend serializes the `explored_fog_texture` texture encoded as an 8-bit grayscale PNG to show the explored area without revealing hidden areas.

WHEN a user with the `CampaignRole::Player` role sends `GET /api/v1/campaigns/{campaign_id}/maps/{map_id}` for a scene where `revealed_to_players == false`, THEN the backend returns HTTP `403 Forbidden`.

### 4.3 Deterministic `StarterDungeon` Template

WHEN the request `POST /api/v1/campaigns/{campaign_id}/maps` contains the payload `template = "StarterDungeon"`, THEN the backend creates a deterministic `CampaignMapScene` with the following properties:
- `name`: "The Forgotten Crypt"
- `grid_type`: `GridType::Square`
- `grid_size_px`: 70
- `grid_cell_distance_ft`: 5.0
- `width_px`: 2800 (40 cells)
- `height_px`: 2100 (30 cells)
- `default_ground_elevation_ft`: 0.0
- `revealed_to_players`: false
- `spawn_points`: `[SpawnPoint { id: <uuid>, name: "Crypt Entrance", x: 350.0, y: 1050.0 }]`
- `wall_segments`: the walls enclose a rectangular 10x10-cell antechamber `[(140, 700) -> (840, 700) -> (840, 1400) -> (140, 1400) -> (140, 700)]`, a 4-cell-wide central corridor up to `(1680, 1050)`, and a final 16x16-cell boss room up to `(2660, 1820)`. A `WallType::Door` door (`door_state: Some(DoorState::Closed)`) separates the corridor from the final room at `(1680, 980) -> (1680, 1120)`. A `WallType::SecretDoor` secret door (`door_state: Some(DoorState::Closed)`) is placed at `(490, 700) -> (630, 700)`.
- `light_sources`: 2 wall torches in the antechamber at `(210.0, 770.0)` and `(210.0, 1330.0)` (`radius_ft: 20.0`, `color_hex: "#FFAA33"`, `intensity: 1.0`), and 1 central brazier in the boss room at `(2170.0, 1050.0)` (`radius_ft: 40.0`, `color_hex: "#FF5500"`, `intensity: 1.2`).
- `staged_tokens`: 2 skeletons pre-placed in the corridor at `(1120.0, 980.0)` and `(1120.0, 1120.0)` with `visibility: VisibilityChannel::GmHidden` and `monster_template_id: Some("Skeleton")`, and 1 necromancer boss in the final room at `(2380.0, 1050.0)` with `visibility: VisibilityChannel::GmHidden` and `monster_template_id: Some("Boss")`.

---

## 5. 2.5D Geometry Engine & Occlusion Matrix

### 5.1 `WallSegment` Geometric Invariants

The backend and the WASM bridge validate every `WallSegment` against the following strict invariants:
1. **Minimum length**: the Euclidean distance between `p1` and `p2` must be strictly greater than `0.1` ft:
   $$\sqrt{(p2.x - p1.x)^2 + (p2.y - p1.y)^2} > 0.1$$
   IF the distance is less than or equal to `0.1` ft, THEN the backend rejects the request with HTTP `422 Unprocessable Entity`.
2. **Valid elevation**: `bottom_elevation_ft < top_elevation_ft`.
   IF `bottom_elevation_ft >= top_elevation_ft`, THEN the backend rejects the request with HTTP `422 Unprocessable Entity`.

### 5.2 Physical and Optical Matrix

| WallType | DoorState | blocks_movement | blocks_light | blocks_sound | GM rendering (`MapsStudioTab Canvas`) | Player rendering (`SceneAtlas` / table) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Normal` | `None` | `true` | `true` | `true` | Solid blue line (#2A72D6) | Standard obstacle line |
| `Window` | `None` | `true` | `false` | `true` | Dotted cyan line (#00D2D3) | Translucent cyan glass |
| `Terrain` | `None` | Elevation-based | Elevation-based | Elevation-based | Double green line (#10AC84) | Green slope line |
| `Door` | `Closed` | `true` | `true` | `true` | Solid orange line (#FF9F43) | Closed orange door |
| `Door` | `Open` | `false` | `false` | `false` | Dotted orange line (#FF9F43) | Open passage |
| `Door` | `Locked` | `true` | `true` | `true` | Solid red line (#EE5253) | Closed door with a padlock |
| `SecretDoor`| `Closed` | `true` | `true` | `true` | Purple 'S' line (#5F27CD) | Normal blue wall line (#2A72D6) |
| `SecretDoor`| `Open` | `false` | `false` | `false` | Dotted purple line (#5F27CD) | Open passage |
| `Illusion` | `None` | `false` | `false` | `false` | Striped magenta line (#FF007F) | Normal blue wall line (#2A72D6) |

### 5.3 2.5D Acoustic Occlusion Model (`AcousticOcclusion`)

`SpatialAudioManager` computes the sound attenuation between an emitter $E(x_e, y_e, z_e)$ and a listener $L(x_l, y_l, z_l)$:
1. `SpatialAudioManager` traces the direct ray segment $\vec{R} = L - E$.
2. `SpatialAudioManager` counts the number $N$ of intersections with `WallSegment`s that satisfy:
   - The 2D segment $(p_1, p_2)$ crosses the 2D projection of $\vec{R}$ at the point $(x_i, y_i)$.
   - The ray elevation $z_i$ at the intersection point satisfies $bottom\_elevation\_ft \le z_i \le top\_elevation\_ft$.
   - The segment has `blocks_sound == true`.
3. For every valid intersection, `SpatialAudioManager` applies a 12 dB attenuation ($factor = 0.25$) and a first-order low-pass filter with an 800 Hz cutoff frequency.

---

## 6. Atomic `ActivateScene` Deployment on the Game Table

### 6.1 Deterministic Token Migration Protocol

WHEN the game master triggers `ActivateScene` by sending `POST /api/v1/campaigns/{campaign_id}/maps/{map_id}/activate`, THEN `TableRoomActor` runs the following atomic sequence:
1. `TableRoomActor` loads the `CampaignMapScene` identified by `map_id` from the database.
2. `TableRoomActor` extracts every current `HeroToken` on the table (`owner_user_id.is_some()`), sorted lexicographically by UUID.
3. `TableRoomActor` keeps the `HeroToken` state attributes unchanged: `hp_current`, `hp_max`, `temp_hp`, `conditions`, `inventory_items`.
4. For every `HeroToken` with index `token_index` (0-based):
   - WHEN `scene.spawn_points` is not empty, THEN `TableRoomActor` sets `token.x = scene.spawn_points[token_index % scene.spawn_points.len()].x`, `token.y = scene.spawn_points[token_index % scene.spawn_points.len()].y`, and `token.elevation_ft = scene.default_ground_elevation_ft`.
   - WHEN `scene.spawn_points` is empty, THEN `TableRoomActor` sets `token.x = 0.0`, `token.y = 0.0`, and `token.elevation_ft = scene.default_ground_elevation_ft`.
5. `TableRoomActor` removes every former unowned NPC and monster (`owner_user_id.is_none()`).
6. `TableRoomActor` creates each `StagedToken` of the scene as a new active table token (`SyntheticToken`), with `visibility = staged_token.visibility`.
7. `TableRoomActor` replaces the table's wall geometry with `scene.wall_segments`, the lights with `scene.light_sources`, and the sound sources with `scene.spatial_audio_emitters`.
8. `TableRoomActor` broadcasts the `SceneActivated` WebSocket event with the complete new state to every connected client (filtered per recipient).

---

## 7. `UvttMap` Import Pipeline (`.uvtt` / `.dd2vtt`)

The `wasmBridge.ts` converter and the backend import service (GM-only route `POST /api/v1/campaigns/{campaign_id}/maps/import`) transform universal `UvttMap` files through the following steps. Oversized or malformed images are rejected before decoding (ADR-0002).
1. **Texture & resolution extraction**: the converter decodes the base64 `image` string into an image buffer, and reads `resolution.map_size` and `resolution.pixels_per_grid`.
2. **Line wall conversion**: for every element of `line_of_sight`:
   - The converter splits the polylines into consecutive segments `(p[k], p[k+1])`.
   - The converter creates a `WallSegment` with `wall_type = WallType::Normal`, `bottom_elevation_ft = 0.0`, `top_elevation_ft = 10.0`, `blocks_light = true`, `blocks_movement = true`, `blocks_sound = true`.
3. **Door & portal conversion**: for every element of `portals`:
   - The converter creates a `WallSegment` joining the door coordinates.
   - The converter sets `wall_type = WallType::Door`.
   - IF `portal.closed == true`, THEN the converter sets `door_state = Some(DoorState::Closed)` and `blocks_sound = true`.
   - ELSE the converter sets `door_state = Some(DoorState::Open)` and `blocks_sound = false`.
4. **Point light conversion**: for every element of `lights`:
   - The converter creates a `LightSource` at `(position.x * pixels_per_grid, position.y * pixels_per_grid)`.
   - The converter keeps the radius `radius_ft = range * 5.0` and the hexadecimal color from the RGB `color` component.

---

## 8. User Interface & Frontend Interaction (`@trame/web`)

### 8.1 GM Prep Studio (`MapsStudioTab Canvas`)

The `MapsStudioTab` tab offers the game master:
1. A toolbar with the selectors `Select/Move`, `Draw Wall` (with a `Normal`, `Window`, `Terrain`, `Door`, `SecretDoor`, `Illusion` sub-menu), `Light Source Tool`, `Spatial Audio Tool`, `Staged Monster Spawner`, `Fog Brush`.
2. Grid snapping settings (`Snap to Grid`): on by default on the intersections and centers of the square grid cells.
3. A contextual inspector for the selected segment to change `DoorState` (`Open`, `Closed`, `Locked`) and the elevation bounds `bottom_elevation_ft` and `top_elevation_ft`.
4. The **1-Click GM Monster Templates** palette to instantly insert a `StagedToken` (`Goblin`, `Bandit`, `Guard`, `Skeleton`, `Wolf`, `Ogre`, `Boss`) with the `VisibilityChannel` switch set to `GmHidden` by default.
5. The main action button `[ActivateScene]` that deploys the scene to the active table immediately.
6. The `[Revealed in Player Atlas]` switch (`revealed_to_players`) to publish the scene to, or remove it from, the players' gallery.

### 8.2 `SceneAtlas` Gallery for Players

For players, the `MapsStudioTab` tab shows only the `SceneAtlas` gallery:
1. A grid of thumbnails of the published scenes (`revealed_to_players == true`).
2. Clicking a thumbnail opens the scene full-screen with smooth zoom and pan controls.
3. Secure rendering according to ADR-0035: secret doors shown as ordinary walls, no hidden tokens, and only the explored fog of war shown.

---

## 9. Specialized Subsystems

### 9.1 Manual Fog of War (`DualBufferFogOfWar`)

`DualBufferFogOfWar` keeps two separate WebGL textures:
- `ActiveVisionTexture`: recomputed every frame from the dynamic line of sight of the active tokens on the table.
- `ExploredMemoryTexture`: accumulates the observed areas. In `MapsStudioTab Canvas`, the game master can paint directly on `ExploredMemoryTexture` with a circular brush (radius adjustable from 10 to 200 px, `Reveal` and `Hide` modes).
- `DualBufferFogOfWar` encodes the `ExploredMemoryTexture` texture only as an 8-bit grayscale PNG byte buffer (the R channel holds the exploration alpha from 0 to 255) for database persistence and network transfer.

### 9.2 Spatial Audio Listener Position

`SpatialAudioManager` determines the listener position $L(x_l, y_l, z_l)$ with the following deterministic rules:
- For the game master (GM): the listener is centered on the canvas viewport: $x_l = viewport.center_x$, $y_l = viewport.center_y$, and $z_l = 0.0$ ft.
- For a player:
  - IF the player owns at least one hero token on the active table, THEN the listener follows the coordinates of the first hero token sorted lexicographically by UUID: $x_l = hero_token.x$, $y_l = hero_token.y$, and $z_l = hero_token.elevation_ft$.
  - IF the player owns no token on the active table, THEN the listener is set to $x_l = 0.0$, $y_l = 0.0$, and $z_l = 0.0$ ft.

---

## 10. TDD Test Strategy & Acceptance Criteria

### 10.1 Suite 1: Backend UVTT Importer Test (`tests/uvtt_importer_test.rs`)
- **Test 1.1**: import a valid `.uvtt` file with 12 wall segments, 3 doors and 4 colored lights. Check that 15 `WallSegment`s and 4 `LightSource`s are created with exact coordinates and matching RGB colors.
- **Test 1.2**: reject a corrupted `.uvtt` file, or one with segments shorter than $0.1$ ft, with an explicit validation error.

### 10.2 Suite 2: RBAC Security & SceneAtlas Masking Test (`tests/scene_atlas_security_test.rs`)
- **Test 2.1**: a player account requesting `GET /api/v1/campaigns/{id}/maps` receives only the scenes with `revealed_to_players == true`.
- **Test 2.2**: a player account requesting `GET /api/v1/campaigns/{id}/maps/{map_id}` on a hidden scene receives HTTP `403 Forbidden`.
- **Test 2.3**: in the payload a player receives for a revealed scene, no segment is a closed `WallType::SecretDoor` (changed into `WallType::Normal`), no segment is a `WallType::Illusion` (changed into `WallType::Normal`), no token has `visibility == VisibilityChannel::GmHidden`, and no sound has `gm_only == true`.

### 10.3 Suite 3: ActivateScene Table Transition Test (`tests/activate_scene_test.rs`)
- **Test 3.1**: trigger `ActivateScene` on a table with 3 player tokens. Check that the 3 `HeroToken`s are kept with their hit points intact, and placed on the `spawn_points` coordinates according to the deterministic rule `token_index % spawn_points.len()`.
- **Test 3.2**: check the deterministic fallback to `(0.0, 0.0, scene.default_ground_elevation_ft)` when `spawn_points` is an empty list.
- **Test 3.3**: check that the table's former monsters are removed and that the new scene's `StagedToken`s are created with their respective visibility.

### 10.4 Suite 4: Frontend Studio & Canvas Interaction Test (`packages/web/tests/MapsStudioTab.test.tsx`)
- **Test 4.1**: check interactive wall drawing with grid snapping (`Snap to Grid`).
- **Test 4.2**: check door state switching (`Closed` -> `Open` -> `Locked`) and the reactive update of the occlusion properties.
- **Test 4.3**: check inserting a monster through the 1-Click GM Monster Templates menu and the default `VisibilityChannel::GmHidden` assignment.
