//! ============================================================================
//! JSON ENGINE API SHARED BY NATIVE RUST AND WEBASSEMBLY (wasm_api.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! One JSON-in / JSON-out function per engine capability the browser and Node
//! consumers need: visibility polygon, wall-clipped AoE cells, move preview with
//! wall collision, cover suggestion, sound occlusion count, and `derivedDAG` evaluation (G1: the
//! single formula evaluator). `lib.rs` wraps each function in a thin
//! `#[wasm_bindgen]` export; native tests call the same functions directly, so
//! the shared parity fixtures (`tests/fixtures/wasm_parity.json`) prove that
//! native and WASM outputs are identical without a second implementation in
//! TypeScript.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Fail-Closed JSON Boundary`:
//!      - Every request is deserialized with `serde_json`; malformed input returns
//!        `Err(String)` (thrown as a JS `Error` by the WASM wrapper) instead of
//!        panicking across the FFI boundary.
//!   2. `Same Rules As The Server`:
//!      - Move previews run `TableState::preview_move`, which reuses the
//!        `MoveToken` wall-collision and cost code; AoE and visibility reuse
//!        `AoeTemplate::evaluate_targets` and `Bvh2D::compute_visibility_polygon`.
//!   3. `Bit-Identical Geometry`:
//!      - Trigonometry goes through the pure-Rust `libm` crate, so native and
//!        wasm32 builds produce the same `f64` bits for the parity fixtures.
//!   4. `camelCase Wire Shape`:
//!      - Request/response envelopes use camelCase; embedded engine types keep
//!        their own serde shape (`WallSegment` also accepts camelCase input,
//!        `AoeTemplate` and `ActiveEffect` are snake_case).
//! ============================================================================

use crate::aoe::{AoeTemplate, GridCell};
use crate::commands::{MovePreview, TableState, TokenState};
use crate::cover::{CoverLevel, suggest_cover};
use crate::geometry::{Bvh2D, CHANNEL_ETHEREAL, Point2D, WallSegment, count_sound_occluding_walls};
use crate::rules::{ActiveEffect, evaluate_actor_attributes};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

fn parse<T: DeserializeOwned>(request_json: &str) -> Result<T, String> {
    serde_json::from_str(request_json).map_err(|e| format!("invalid request: {e}"))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// Request for `compute_visibility_polygon_json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisibilityRequest {
    /// Walls to raycast against.
    walls: Vec<WallSegment>,
    /// Observer position in pixels (`px`).
    origin: Point2D,
    /// Observer eye elevation in feet (`ft`).
    observer_eye_ft: f64,
    /// Ray length in pixels (`px`).
    max_range_px: f64,
    /// When `true`, illusions with `pierced_by_truesight` do not block rays.
    #[serde(default)]
    has_truesight: bool,
}

/// Visibility polygon: `{ walls, origin, observerEyeFt, maxRangePx, hasTruesight? }` ->
/// `Point2D[]` ordered by ray angle from `-PI`.
pub fn compute_visibility_polygon_json(request_json: &str) -> Result<String, String> {
    let req: VisibilityRequest = parse(request_json)?;
    let bvh = Bvh2D::build(req.walls);
    to_json(&bvh.compute_visibility_polygon(
        req.origin,
        req.observer_eye_ft,
        req.max_range_px,
        req.has_truesight,
    ))
}

/// Request for `preview_aoe_cells_json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AoeRequest {
    /// Walls used to clip `template` when `stops_at_walls` is set.
    walls: Vec<WallSegment>,
    /// AoE template in its snake_case engine shape.
    template: AoeTemplate,
    /// Grid cell edge in pixels (`px`, `> 0`).
    cell_size_px: f64,
    /// Feet per grid cell (`ft`, typically `5`).
    feet_per_cell: f64,
}

/// Wall-clipped AoE cells: `{ walls, template, cellSizePx, feetPerCell }` -> `{col, row}[]`
/// in column-major order.
pub fn preview_aoe_cells_json(request_json: &str) -> Result<String, String> {
    let req: AoeRequest = parse(request_json)?;
    let bvh = Bvh2D::build(req.walls);
    let (cells, _) = req
        .template
        .evaluate_targets(&[], req.cell_size_px, req.feet_per_cell, &bvh);
    to_json(&cells)
}

/// Footprint of a token in `preview_move_json` and `suggest_cover_json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenFootprint {
    /// Current top-left position in pixels (`px`).
    top_left: Point2D,
    /// Width in grid cells (default `1`).
    #[serde(default = "one_cell")]
    grid_w: u8,
    /// Height in grid cells (default `1`).
    #[serde(default = "one_cell")]
    grid_h: u8,
    /// Current base elevation in feet (`ft`, default `0`).
    #[serde(default)]
    elevation_ft: f64,
    /// Stature in feet (`ft`, default `5`).
    #[serde(default = "medium_height_ft")]
    height_ft: f64,
    /// Doubles the movement cost when set.
    #[serde(default)]
    is_squeezing: bool,
    /// Ethereal tokens pass through walls.
    #[serde(default)]
    is_ethereal: bool,
}

impl TokenFootprint {
    /// A default token (nil id) carrying this footprint.
    fn to_token(&self) -> TokenState {
        let mut token = TokenState::new_default(Uuid::nil(), "preview", self.top_left);
        token.grid_w = self.grid_w;
        token.grid_h = self.grid_h;
        token.elevation_ft = self.elevation_ft;
        token.height_ft = self.height_ft;
        token.is_squeezing = self.is_squeezing;
        if self.is_ethereal {
            token.visibility_channel |= CHANNEL_ETHEREAL;
        }
        token
    }
}

fn one_cell() -> u8 {
    1
}

fn medium_height_ft() -> f64 {
    5.0
}

/// Request for `preview_move_json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveRequest {
    /// Walls checked for movement collision.
    walls: Vec<WallSegment>,
    /// Mover footprint and current position.
    token: TokenFootprint,
    /// Destination top-left in pixels (`px`).
    to_top_left: Point2D,
    /// Destination elevation in feet (`ft`); defaults to the current elevation.
    #[serde(default)]
    to_elevation_ft: Option<f64>,
    /// Grid cell edge in pixels (`px`, `> 0`).
    cell_size_px: f64,
    /// Feet per grid cell (`ft`, typically `5`).
    feet_per_cell: f64,
    /// Difficult terrain cells of the map (`{col, row}`, default none).
    #[serde(default)]
    difficult_terrain: BTreeSet<GridCell>,
}

/// Move preview: `{ walls, token, toTopLeft, toElevationFt?, cellSizePx, feetPerCell,
/// difficultTerrain? }` -> `{ collision: {x, y} | null, costFt }`, using the server's
/// `MoveToken` rules (Chebyshev squares, difficult terrain doubled).
pub fn preview_move_json(request_json: &str) -> Result<String, String> {
    let req: MoveRequest = parse(request_json)?;
    let mut table = TableState::new(req.cell_size_px, req.feet_per_cell, req.walls);
    table.data.difficult_terrain = req.difficult_terrain;
    let token = req.token.to_token();
    let to_elevation_ft = req.to_elevation_ft.unwrap_or(token.elevation_ft);
    let preview: MovePreview = table.preview_move(&token, req.to_top_left, to_elevation_ft);
    to_json(&preview)
}

/// Request for `suggest_cover_json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverRequest {
    /// Walls between the two tokens (kinds decide which ones physically block).
    walls: Vec<WallSegment>,
    /// Attacker footprint; squeezing shrinks it like on the table.
    attacker: TokenFootprint,
    /// Target footprint.
    target: TokenFootprint,
    /// Grid cell edge in pixels (`px`, `> 0`).
    cell_size_px: f64,
}

/// Response of `suggest_cover_json`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoverResponse {
    /// Suggested cover level.
    cover: CoverLevel,
    /// AC and Dexterity save bonus (`0`, `2`, `5`); `null` for `TOTAL` cover.
    bonus: Option<i32>,
}

/// Cover suggestion (never applied by the engine): `{ walls, attacker, target, cellSizePx }`
/// -> `{ cover: "NONE" | "HALF" | "THREE_QUARTERS" | "TOTAL", bonus }`, using the
/// corner-to-corner rule of `cover::suggest_cover`.
pub fn suggest_cover_json(request_json: &str) -> Result<String, String> {
    let req: CoverRequest = parse(request_json)?;
    let cover = suggest_cover(
        &req.walls,
        &req.attacker.to_token().spatial_ref(),
        &req.target.to_token().spatial_ref(),
        req.cell_size_px,
    );
    to_json(&CoverResponse {
        cover,
        bonus: cover.bonus(),
    })
}

/// Request for `count_sound_occluding_walls_json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoundOcclusionRequest {
    /// Walls checked for sound occlusion.
    walls: Vec<WallSegment>,
    /// Emitter position in pixels (`px`).
    emitter: Point2D,
    /// Emitter elevation in feet (`ft`).
    emitter_elevation_ft: f64,
    /// Listener position in pixels (`px`).
    listener: Point2D,
    /// Listener elevation in feet (`ft`).
    listener_elevation_ft: f64,
}

/// Sound occlusion: `{ walls, emitter, emitterElevationFt, listener, listenerElevationFt }` ->
/// number of crossed sound-blocking walls.
pub fn count_sound_occluding_walls_json(request_json: &str) -> Result<String, String> {
    let req: SoundOcclusionRequest = parse(request_json)?;
    to_json(&count_sound_occluding_walls(
        &req.walls,
        req.emitter,
        req.emitter_elevation_ft,
        req.listener,
        req.listener_elevation_ft,
    ))
}

/// Request for `evaluate_derived_dag_json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DerivedDagRequest {
    /// Base attribute values by key.
    base_attributes: BTreeMap<String, f64>,
    /// `derivedDAG` formulas by derived key.
    derived_formulas: BTreeMap<String, String>,
    /// Optional active effects run through the 5-phase modifier pipeline.
    #[serde(default)]
    active_effects: Vec<ActiveEffect>,
}

/// `derivedDAG` evaluation (G1): `{ baseAttributes, derivedFormulas, activeEffects? }` ->
/// `{ [key]: number }` with base and derived keys. Cycles, syntax errors, and unknown
/// variables fail closed with the `RulesEngineError` message.
pub fn evaluate_derived_dag_json(request_json: &str) -> Result<String, String> {
    let req: DerivedDagRequest = parse(request_json)?;
    let values = evaluate_actor_attributes(
        &req.base_attributes,
        &req.derived_formulas,
        &req.active_effects,
    )
    .map_err(|e| e.to_string())?;
    to_json(&values)
}

/// Dispatches `export` (the JS export name) to its JSON function; used by the parity fixtures.
pub fn call_export(export: &str, request_json: &str) -> Result<String, String> {
    match export {
        "computeVisibilityPolygon" => compute_visibility_polygon_json(request_json),
        "previewAoeCells" => preview_aoe_cells_json(request_json),
        "previewMove" => preview_move_json(request_json),
        "suggestCover" => suggest_cover_json(request_json),
        "countSoundOccludingWalls" => count_sound_occluding_walls_json(request_json),
        "evaluateDerivedDag" => evaluate_derived_dag_json(request_json),
        other => Err(format!("unknown export '{other}'")),
    }
}
