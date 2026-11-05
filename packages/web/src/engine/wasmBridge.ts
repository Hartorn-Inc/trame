/**
 * ============================================================================
 * TRAME ENGINE WASM BRIDGE (wasmBridge.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Single entry point from `@trame/web` into the Rust `trame-engine` compiled to
 * WebAssembly (`make wasm` -> `src/wasm/`, gitignored). Visibility polygons,
 * wall-clipped AoE cells, move previews, sound occlusion and `derivedDAG`
 * evaluation all run the same Rust code as the authoritative server, so the
 * client never drifts from server resolution and no TypeScript copy of the
 * geometry exists.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Explicit Async Init`:
 *      - Browser code must `await initEngine()` once before calling any engine
 *        function; calls before that throw instead of returning wrong geometry.
 *        Node tests use `initEngineSync(bytes)` (see `tests/engine-setup.mjs`).
 *   2. `JSON Wire Contract`:
 *      - Each WASM export takes one JSON request and returns JSON; malformed
 *        requests throw a JS `Error` carrying the Rust message.
 *   3. `Opaque Wall IDs`:
 *      - Client wall IDs are free-form strings while the engine requires UUIDs;
 *        geometry never reads IDs, so walls are sent with the nil UUID.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `initEngine()` -> fetch + instantiate `trame_engine_bg.wasm` (once)
 *   `computeVisibilityPolygon(...)` / `previewAoeCells(...)` / ...
 *     ├── 1. Build the camelCase request (walls get the nil UUID).
 *     ├── 2. Call the WASM export with `JSON.stringify(request)`.
 *     └── 3. `JSON.parse` the response into typed results.
 * ============================================================================
 */

import initWasm, {
  computeVisibilityPolygon as wasmComputeVisibilityPolygon,
  countSoundOccludingWalls as wasmCountSoundOccludingWalls,
  evaluateDerivedDag as wasmEvaluateDerivedDag,
  initSync,
  previewAoeCells as wasmPreviewAoeCells,
  previewMove as wasmPreviewMove,
} from "../wasm/trame_engine.js";

export interface Point2D {
  x: number;
  y: number;
}

export interface WallSegmentDto {
  id: string;
  a: Point2D;
  b: Point2D;
  blocksVision: boolean;
  blocksMovement?: boolean;
  /** Missing means blocking, matching the engine default. */
  blocksSound?: boolean;
  bottomElevationFt: number;
  topElevationFt: number;
}

export interface DrawingEntity {
  id: string;
  points: [number, number][];
  color: string;
  lineWidth: number;
  isClosed: boolean;
  hasPhysicalWalls: boolean;
}

export type DiscretizationMode =
  | "CENTER_POINT"
  | "FIFTY_PERCENT"
  | "ANY_INTERSECTION"
  | "TOKEN_EUCLIDEAN";

export interface GridCell {
  col: number;
  row: number;
}

/** AoE volume in the engine's snake_case shape; distances in feet, angles in degrees. */
export type AoeShapeDto =
  | { shape: "SPHERE"; radius_ft: number }
  | { shape: "CYLINDER"; radius_ft: number; height_ft: number }
  | { shape: "CONE"; length_ft: number; angle_deg: number; direction_deg: number }
  | { shape: "CUBE"; side_ft: number; rotation_deg: number }
  | { shape: "LINE"; length_ft: number; width_ft: number; direction_deg: number };

/** Engine `AoeTemplate` (snake_case). `id` must be a UUID. */
export interface AoeTemplateDto {
  id: string;
  /** Origin in canvas pixels. */
  origin: Point2D;
  /** Origin elevation in feet. */
  origin_elevation_ft: number;
  shape: AoeShapeDto;
  /** Clip propagation against light-blocking walls. */
  stops_at_walls: boolean;
  discretization: DiscretizationMode;
  concentration_caster_id?: string | null;
}

/** Footprint of the token whose move is previewed. Optional fields use engine defaults. */
export interface MoverFootprint {
  /** Current top-left in canvas pixels. */
  topLeft: Point2D;
  /** Width in grid cells (default `1`). */
  gridW?: number;
  /** Height in grid cells (default `1`). */
  gridH?: number;
  /** Current base elevation in feet (default `0`). */
  elevationFt?: number;
  /** Stature in feet (default `5`). */
  heightFt?: number;
  /** Doubles movement cost. */
  isSqueezing?: boolean;
  /** Ethereal tokens pass through walls. */
  isEthereal?: boolean;
}

export interface MovePreview {
  /** First blocking wall crossing in canvas pixels, or `null` when the path is clear. */
  collision: Point2D | null;
  /**
   * Movement cost in feet: Chebyshev squares (diagonals cost one cell), difficult squares
   * doubled, elevation change as a third axis (`max`), doubled while squeezing.
   */
  costFt: number;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

let engineReady = false;
let initPromise: Promise<void> | null = null;

/** Loads and instantiates the engine once; safe to call repeatedly. */
export function initEngine(): Promise<void> {
  initPromise ??= initWasm().then(() => {
    engineReady = true;
  });
  return initPromise;
}

/** Instantiates the engine from raw `trame_engine_bg.wasm` bytes (Node tests, no fetch). */
export function initEngineSync(wasmBytes: BufferSource): void {
  initSync({ module: wasmBytes });
  engineReady = true;
}

export function isEngineReady(): boolean {
  return engineReady;
}

function callEngine<T>(exported: (requestJson: string) => string, request: unknown): T {
  if (!engineReady) {
    throw new Error("trame-engine WASM is not initialized; await initEngine() first");
  }
  return JSON.parse(exported(JSON.stringify(request))) as T;
}

function toEngineWalls(walls: WallSegmentDto[]): WallSegmentDto[] {
  return walls.map((wall) => ({ ...wall, id: NIL_UUID }));
}

/**
 * Converts a vector drawing with `hasPhysicalWalls = true` into physical wall segments
 * blocking movement, vision, and sound (`docs/specs/e4-interactive-table-hud-combat-trac.md`).
 */
export function convertDrawingToWallSegments(
  drawing: DrawingEntity,
  bottomElevationFt = -1000,
  topElevationFt = 1000,
): WallSegmentDto[] {
  if (!drawing.hasPhysicalWalls || drawing.points.length < 2) {
    return [];
  }
  const walls: WallSegmentDto[] = [];
  for (let i = 0; i < drawing.points.length - 1; i++) {
    walls.push({
      id: `${drawing.id}-segment-${i}`,
      a: { x: drawing.points[i][0], y: drawing.points[i][1] },
      b: { x: drawing.points[i + 1][0], y: drawing.points[i + 1][1] },
      blocksVision: true,
      blocksMovement: true,
      blocksSound: true,
      bottomElevationFt,
      topElevationFt,
    });
  }
  if (drawing.isClosed && drawing.points.length >= 3) {
    const lastIdx = drawing.points.length - 1;
    walls.push({
      id: `${drawing.id}-segment-${lastIdx}`,
      a: { x: drawing.points[lastIdx][0], y: drawing.points[lastIdx][1] },
      b: { x: drawing.points[0][0], y: drawing.points[0][1] },
      blocksVision: true,
      blocksMovement: true,
      blocksSound: true,
      bottomElevationFt,
      topElevationFt,
    });
  }
  return walls;
}

/**
 * Radial visibility polygon around `origin` (pixels) at eye height `observerEyeFt`, up to
 * `maxRangePx`, clipped by vision-blocking walls. Vertices are ordered by ray angle from `-PI`.
 */
export function computeVisibilityPolygon(
  walls: WallSegmentDto[],
  origin: Point2D,
  observerEyeFt: number,
  maxRangePx: number,
  hasTruesight = false,
): Point2D[] {
  return callEngine(wasmComputeVisibilityPolygon, {
    walls: toEngineWalls(walls),
    origin,
    observerEyeFt,
    maxRangePx,
    hasTruesight,
  });
}

/** Grid cells covered by `template`, clipped against `walls` when `stops_at_walls` is set. */
export function previewAoeCells(
  template: AoeTemplateDto,
  walls: WallSegmentDto[],
  cellSizePx: number,
  feetPerCell: number,
): GridCell[] {
  return callEngine(wasmPreviewAoeCells, {
    walls: toEngineWalls(walls),
    template,
    cellSizePx,
    feetPerCell,
  });
}

/** Sphere shortcut over `previewAoeCells` with a ground-level origin. */
export function previewSphereAoeCells(
  origin: Point2D,
  radiusFt: number,
  cellSizePx: number,
  feetPerCell: number,
  mode: DiscretizationMode,
  stopsAtWalls: boolean,
  walls: WallSegmentDto[],
): GridCell[] {
  return previewAoeCells(
    {
      id: NIL_UUID,
      origin,
      origin_elevation_ft: 0,
      shape: { shape: "SPHERE", radius_ft: radiusFt },
      stops_at_walls: stopsAtWalls,
      discretization: mode,
    },
    walls,
    cellSizePx,
    feetPerCell,
  );
}

/**
 * Previews a straight move with the server's `MoveToken` wall-collision and cost rules.
 * `difficultTerrain` is the map's `difficult_terrain` cell list; entering one costs double.
 */
export function previewMove(
  token: MoverFootprint,
  toTopLeft: Point2D,
  walls: WallSegmentDto[],
  cellSizePx: number,
  feetPerCell: number,
  toElevationFt?: number,
  difficultTerrain: GridCell[] = [],
): MovePreview {
  return callEngine(wasmPreviewMove, {
    walls: toEngineWalls(walls),
    token,
    toTopLeft,
    toElevationFt,
    cellSizePx,
    feetPerCell,
    difficultTerrain,
  });
}

/**
 * Counts sound-blocking walls (closed doors included, open doors ignored) crossed strictly
 * between emitter and listener at the interpolated path elevation.
 */
export function countSoundOccludingWalls(
  emitter: { x: number; y: number; elevationFt: number },
  listener: { x: number; y: number; elevationFt: number },
  walls: WallSegmentDto[],
): number {
  return callEngine(wasmCountSoundOccludingWalls, {
    walls: toEngineWalls(walls),
    emitter: { x: emitter.x, y: emitter.y },
    emitterElevationFt: emitter.elevationFt,
    listener: { x: listener.x, y: listener.y },
    listenerElevationFt: listener.elevationFt,
  });
}

/**
 * Evaluates `derivedDAG` formulas (G1: the single formula evaluator) over `baseAttributes`,
 * optionally through the 5-phase active-effect pipeline (`activeEffects` in engine snake_case).
 * Throws on cycles, syntax errors, or unknown variables.
 */
export function evaluateDerivedDag(
  baseAttributes: Record<string, number>,
  derivedFormulas: Record<string, string>,
  activeEffects: unknown[] = [],
): Record<string, number> {
  return callEngine(wasmEvaluateDerivedDag, { baseAttributes, derivedFormulas, activeEffects });
}
