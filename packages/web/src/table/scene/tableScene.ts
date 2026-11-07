/**
 * ============================================================================
 * LIVE TABLE SCENE BUILDER (table/scene/tableScene.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Turns the recipient-projected `ProjectedTableState` into a renderer-neutral
 * draw list (`TableScene`) laid out in the seven `TACTICAL_SCENE_LAYERS`:
 * battlemap, grid + walls, AoE templates, tokens, lighting, fog of war, HUD
 * (pings). The PixiJS adapter (`pixiTableRenderer.ts`) only translates this
 * list into display objects, so every rendering decision (what a player may
 * see, which colour and stroke a wall or ring gets, where the fog opens) is
 * plain data that runs and is tested without WebGL.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Projection Is The Only Source`:
 *    - Walls, tokens, lights and AoEs come from the projection alone. The
 *      server already rewrote closed secret doors and illusions to `NORMAL`
 *      and dropped hidden tokens for non-GMs, so the builder never adds,
 *      un-masks or infers geometry the recipient was not sent.
 * 2. `Fog From Controlled Tokens`:
 *    - Players get fog with one vision polygon per controlled token (the WASM
 *      raycaster, clipped by walls that block sight). The GM sees the whole
 *      map unless `previewPlayerView` is on, which applies the same fog from
 *      player-owned tokens at the explored-dim alpha.
 *    - The sight radius comes from each token's own `senses` (server-derived
 *      darkvision, truesight...) under the ambient preset, resolved by the
 *      engine (`computeTokenVisionPolygon`); a token without senses sees
 *      normally with no darkvision.
 *    - Without the engine (still loading or failed) a viewer sees only its
 *      own footprint: fog fails closed instead of revealing the map.
 * 2b. `Wall Kinds Resolved By The Engine`:
 *    - Every wall reaches the raycaster with its `kind` (`engineWalls`);
 *      windows, open doors, terrain two-hit and one-way normals are decided
 *      in Rust, never pre-filtered here, so client and server agree.
 * 3. `Theme Palette Only`:
 *    - Every colour comes from `CanvasThemePaletteSpec` (or from the data
 *      itself: light `color_hex`, the ping sender's colour); health tiers pair
 *      a colour with a stroke style (solid / dashed / double) so the tier is
 *      readable without colour.
 * 4. `Reduced Motion`:
 *    - With `reducedMotion` pings render as a static ring for their lifetime
 *      instead of an expanding pulse.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `buildTableScene(input)`
 * ├── 1. `boardMetrics` -> cell size and board extent (px).
 * ├── 2. Walls -> palette style per `WallKind`; AoEs -> engine cells;
 * │      difficult terrain -> hatched cells.
 * ├── 3. `listTableTokens` -> rings (disposition or health tier), selection.
 * ├── 4. Ambient preset -> darkness tint; lights -> wall-clipped polygons.
 * ├── 5. Fog -> vision polygons of the viewers + GM reveal/hide cells.
 * └── 6. Live pointer pings (younger than `PING_DURATION_MS`).
 * ============================================================================
 */
import type { PointerPing } from "../../api/session.ts";
import type {
  ProjectedTableState,
  WireAmbientLighting,
  WireBloodiedState,
  WireSenseProfile,
  WireWallKind,
  WireWallSegment,
  Uuid,
} from "../../api/wire.ts";
import {
  CANVAS_AMBIENT_TINTS,
  type CanonicalWallKind,
  type CanvasThemePaletteSpec,
  type TokenRingStrokeStyle,
  type WallEndpointMarker,
} from "../../canvas/CanvasThemePalette.ts";
import type { AoeTemplateDto, GridCell, Point2D, WallSegmentDto } from "../../engine/wasmBridge.ts";
import { listTableTokens } from "../tableView.ts";

/** Lifetime of a pointer ping on the board, in milliseconds. */
export const PING_DURATION_MS = 1500;

/** Board size, in cells, used before a scene with dimensions is active. */
const FALLBACK_BOARD_CELLS = 20;
const FALLBACK_CELL_PX = 50;
/** Senses of a token the projection sent without any: normal sight, no special sense. */
const PLAIN_SENSES: WireSenseProfile = {
  normal_range_ft: 120,
  darkvision_range_ft: 0,
  blindsight_range_ft: 0,
  tremorsense_range_ft: 0,
  truesight_range_ft: 0,
  devils_sight: false,
  see_invisibility: false,
  perceives_channels: 1,
};
const DEFAULT_HEIGHT_FT = 5;
/** Fill alpha of a difficult terrain cell; the diagonal hatch carries the meaning without colour. */
const TERRAIN_FILL_ALPHA = 0.12;

/**
 * Darkness overlay alpha per ambient preset (`0` = no overlay). Lights are
 * only drawn when the overlay is present, so daylight never washes the map.
 */
const AMBIENT_DARKNESS_ALPHA: Record<keyof typeof CANVAS_AMBIENT_TINTS, number> = {
  DAYLIGHT: 0,
  DUSK: 0.25,
  NIGHT_MOONLIGHT: 0.5,
  PITCH_DARKNESS: 0.8,
};

const WALL_KIND_STYLE: Record<WireWallKind["kind"], CanonicalWallKind> = {
  NORMAL: "Normal",
  WINDOW: "Window",
  TERRAIN: "Terrain",
  ONE_WAY: "OneWay",
  DOOR: "Door",
  SECRET_DOOR: "SecretDoor",
  ILLUSION: "Illusion",
};

/** Ray-casting hooks backed by the WASM engine (`wasmBridge.ts`). */
export interface SceneGeometry {
  /** Visibility polygon around `origin` (px) clipped by `walls`, `rangePx` deep. */
  visibilityPolygon(walls: WallSegmentDto[], origin: Point2D, eyeFt: number, rangePx: number, truesight: boolean): Point2D[];
  /** Vision polygon of one token from its `senses` under `ambient` (`computeTokenVisionPolygon`). */
  tokenVisionPolygon(
    walls: WallSegmentDto[],
    origin: Point2D,
    eyeFt: number,
    senses: WireSenseProfile,
    ambient: WireAmbientLighting,
    pxPerFt: number,
  ): Point2D[];
  /** Grid cells covered by `template`, clipped by `walls` when it stops at walls. */
  aoeCells(template: AoeTemplateDto, walls: WallSegmentDto[], cellPx: number, feetPerCell: number): GridCell[];
}

export interface TableSceneInput {
  state: ProjectedTableState | null;
  palette: CanvasThemePaletteSpec;
  isGm: boolean;
  selectedTokenId: Uuid | null;
  /** Token holding the current turn (`activeTurnTokenId`), `null` outside combat. */
  activeTurnTokenId: Uuid | null;
  /** GM only: apply the players' fog over the GM view. Ignored for players. */
  previewPlayerView: boolean;
  reducedMotion: boolean;
  pings: PointerPing[];
  /** Current time in epoch milliseconds, used to expire pings. */
  nowMs: number;
  /** `null` while the engine is not ready. */
  geometry: SceneGeometry | null;
}

/** Axis-aligned rectangle in canvas pixels (`px`). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardMetrics {
  cellPx: number;
  widthPx: number;
  heightPx: number;
}

export interface SceneWall {
  id: Uuid;
  a: Point2D;
  b: Point2D;
  kind: CanonicalWallKind;
  color: number;
  widthPx: number;
  dash: readonly [number, number] | null;
  marker: WallEndpointMarker;
  /** Open doors are drawn at half alpha. */
  alpha: number;
}

export interface SceneRing {
  color: number;
  style: TokenRingStrokeStyle;
  dash: readonly [number, number] | null;
}

export interface SceneToken {
  id: Uuid;
  /** Footprint in canvas pixels. */
  rect: Rect;
  center: Point2D;
  radiusPx: number;
  fill: number;
  labelColor: number;
  initials: string;
  /** Disposition ring, or health-tier ring for tokens the recipient does not control. */
  ring: SceneRing;
  healthTier: WireBloodiedState | null;
  /** Extra outer ring for the selection / the active turn. */
  highlight: SceneRing | null;
}

export interface SceneAoe {
  id: Uuid;
  origin: Point2D;
  cells: Rect[];
  fill: number;
  fillAlpha: number;
  stroke: number;
  dash: readonly [number, number];
}

export interface SceneLight {
  id: Uuid;
  origin: Point2D;
  brightPx: number;
  dimPx: number;
  /** Linear RGB in `0..=1`. */
  rgb: [number, number, number];
  intensity: number;
  /** Wall-clipped lit area, `null` when the engine is not ready. */
  polygon: Point2D[] | null;
}

/** Difficult terrain cells: a faint fill plus a diagonal hatch (non-colour cue). */
export interface SceneTerrain {
  cells: Rect[];
  color: number;
  fillAlpha: number;
}

export interface SceneFog {
  color: number;
  alpha: number;
  /** Areas the viewers currently see (holes in the fog). */
  vision: Point2D[][];
  /** GM `REVEAL` cells (holes). */
  reveal: Rect[];
  /** GM `HIDE` cells (fog drawn over vision). */
  hide: Rect[];
}

export interface ScenePing {
  key: string;
  pos: Point2D;
  color: number;
  receivedAtMs: number;
}

export interface TableScene extends BoardMetrics {
  voidColor: number;
  mapHash: string | null;
  grid: { color: number; alpha: number };
  walls: SceneWall[];
  terrain: SceneTerrain;
  aoes: SceneAoe[];
  tokens: SceneToken[];
  ambient: { tint: number; alpha: number };
  /** Empty in daylight (`ambient.alpha === 0`). */
  lights: SceneLight[];
  /** `null` when the recipient sees the whole map (GM without preview). */
  fog: SceneFog | null;
  pings: ScenePing[];
  reducedMotion: boolean;
}

/** Cell size and board extent; falls back to a 20x20 board of 50 px cells. */
export function boardMetrics(state: ProjectedTableState | null): BoardMetrics {
  const cellPx = state && state.cell_size_px > 0 ? state.cell_size_px : FALLBACK_CELL_PX;
  return {
    cellPx,
    widthPx: state && state.map_width_px > 0 ? state.map_width_px : cellPx * FALLBACK_BOARD_CELLS,
    heightPx: state && state.map_height_px > 0 ? state.map_height_px : cellPx * FALLBACK_BOARD_CELLS,
  };
}

/** `#RRGGBB` (or `#RGB`) to `0xRRGGBB`; `null` for anything else. */
export function parseHexColor(hex: string): number | null {
  const clean = hex.trim().replace(/^#/, "");
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
  return /^[0-9a-fA-F]{6}$/.test(full) ? parseInt(full, 16) : null;
}

function rgbOf(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

/**
 * Projected walls in the WASM request shape, every wall kept with its `kind`
 * (invariant 2b). `channel` picks the base flag the raycaster reads as
 * `blocksVision`: `blocks_vision` for sight, `blocks_light` for lights and
 * AoE spread.
 */
export function engineWalls(walls: WireWallSegment[], channel: "vision" | "light"): WallSegmentDto[] {
  return walls.map((wall) => ({
    id: wall.id,
    a: wall.a,
    b: wall.b,
    kind: wall.kind,
    blocksVision: channel === "vision" ? wall.blocks_vision : wall.blocks_light,
    blocksMovement: wall.blocks_movement,
    blocksSound: wall.blocks_sound,
    bottomElevationFt: wall.bottom_elevation_ft,
    topElevationFt: wall.top_elevation_ft,
  }));
}

function ambientPreset(raw: string): WireAmbientLighting {
  return raw in CANVAS_AMBIENT_TINTS ? (raw as WireAmbientLighting) : "DAYLIGHT";
}

function cellRect(col: number, row: number, cellPx: number): Rect {
  return { x: col * cellPx, y: row * cellPx, w: cellPx, h: cellPx };
}

function healthRing(tier: WireBloodiedState, palette: CanvasThemePaletteSpec): SceneRing {
  switch (tier) {
    case "UNHURT":
      return { color: palette.focusHex, style: "solid", dash: null };
    case "BLOODIED":
      return { color: palette.actionHex, style: "dashed", dash: palette.tokenDispositions.hostile.dashPatternPx };
    case "DOWN":
      return { color: palette.dangerHex, style: "double", dash: null };
  }
}

function dispositionRing(kind: "ally" | "hostile" | "selected" | "activeTurn", palette: CanvasThemePaletteSpec): SceneRing {
  const style = palette.tokenDispositions[kind];
  return { color: style.ringColorHex, style: style.ringStrokeStyle, dash: style.dashPatternPx };
}

function buildWalls(state: ProjectedTableState, palette: CanvasThemePaletteSpec): SceneWall[] {
  return (state.walls ?? []).map((wall) => {
    const kind = WALL_KIND_STYLE[wall.kind?.kind] ?? "Normal";
    const style = palette.wallKinds[kind];
    const open = (wall.kind.kind === "DOOR" || wall.kind.kind === "SECRET_DOOR") && wall.kind.is_open;
    return {
      id: wall.id,
      a: wall.a,
      b: wall.b,
      kind,
      color: style.strokeColorHex,
      widthPx: style.strokeWidthPx,
      dash: style.dashPatternPx,
      marker: style.endpointMarker,
      alpha: open ? 0.5 : 1,
    };
  });
}

function safely<T>(compute: () => T, fallback: T): T {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

function buildAoes(state: ProjectedTableState, input: TableSceneInput, cellPx: number): SceneAoe[] {
  const style = input.palette.aoeTemplate;
  const walls = engineWalls(state.walls ?? [], "light");
  return Object.entries(state.persistent_aoes ?? {}).map(([id, template]) => {
    const cells = input.geometry
      ? safely(() => input.geometry!.aoeCells(template, walls, cellPx, state.feet_per_cell || 5), [] as GridCell[])
      : [];
    return {
      id,
      origin: template.origin,
      cells: cells.map((cell) => cellRect(cell.col, cell.row, cellPx)),
      fill: style.fillHex,
      fillAlpha: style.fillAlpha,
      stroke: style.strokeHex,
      dash: style.boundaryDashPx,
    };
  });
}

function buildTokens(state: ProjectedTableState, input: TableSceneInput, cellPx: number): SceneToken[] {
  const { palette } = input;
  return listTableTokens(state).map((token) => {
    const rect = { x: token.topLeft.x, y: token.topLeft.y, w: token.gridW * cellPx, h: token.gridH * cellPx };
    const ring = token.bloodied
      ? healthRing(token.bloodied, palette)
      : dispositionRing(token.controlled && (token.ownerUserId !== null || !input.isGm) ? "ally" : "hostile", palette);
    const highlight =
      token.id === input.selectedTokenId
        ? dispositionRing("selected", palette)
        : token.id === input.activeTurnTokenId
          ? dispositionRing("activeTurn", palette)
          : null;
    return {
      id: token.id,
      rect,
      center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
      radiusPx: Math.min(rect.w, rect.h) / 2 - 2,
      fill: palette.surfaceRaisedHex,
      labelColor: palette.textHex,
      initials: token.name.trim().slice(0, 2) || "?",
      ring,
      healthTier: token.bloodied,
      highlight,
    };
  });
}

function buildLights(state: ProjectedTableState, input: TableSceneInput, cellPx: number): SceneLight[] {
  const pxPerFt = cellPx / (state.feet_per_cell || 5);
  const walls = engineWalls(state.walls ?? [], "light");
  const fallback = input.palette.textHex;
  return (state.lights ?? []).map((light) => {
    const dimPx = Math.max(light.dim_radius_ft, light.bright_radius_ft) * pxPerFt;
    return {
      id: light.id,
      origin: light.position,
      brightPx: light.bright_radius_ft * pxPerFt,
      dimPx,
      rgb: rgbOf(parseHexColor(light.color_hex ?? "") ?? fallback),
      intensity: Math.min(1, Math.max(0, light.intensity ?? 1)),
      polygon: input.geometry
        ? safely(() => input.geometry!.visibilityPolygon(walls, light.position, light.elevation_ft ?? 0, dimPx, false), null)
        : null,
    };
  });
}

function buildTerrain(state: ProjectedTableState, input: TableSceneInput, cellPx: number): SceneTerrain {
  return {
    cells: (state.difficult_terrain ?? []).map((cell) => cellRect(cell.col, cell.row, cellPx)),
    color: input.palette.textMutedHex,
    fillAlpha: TERRAIN_FILL_ALPHA,
  };
}

function buildFog(state: ProjectedTableState, input: TableSceneInput, cellPx: number): SceneFog | null {
  if (input.isGm && !input.previewPlayerView) return null;
  const viewers = Object.values(state.tokens).filter((raw) => !input.isGm || (raw.owner_user_id ?? null) !== null);
  const pxPerFt = cellPx / (state.feet_per_cell || 5);
  const ambient = ambientPreset(state.ambient_lighting);
  const walls = engineWalls(state.walls ?? [], "vision");
  const vision = viewers.map((raw) => {
    const topLeft = raw.top_left ?? { x: 0, y: 0 };
    const w = Math.max(1, raw.grid_w ?? 1) * cellPx;
    const h = Math.max(1, raw.grid_h ?? 1) * cellPx;
    const footprint = [topLeft, { x: topLeft.x + w, y: topLeft.y }, { x: topLeft.x + w, y: topLeft.y + h }, { x: topLeft.x, y: topLeft.y + h }];
    if (!input.geometry) return footprint;
    const origin = { x: topLeft.x + w / 2, y: topLeft.y + h / 2 };
    const eyeFt = (raw.elevation_ft ?? 0) + (raw.height_ft ?? DEFAULT_HEIGHT_FT);
    const senses = { ...PLAIN_SENSES, ...raw.senses };
    return safely(() => input.geometry!.tokenVisionPolygon(walls, origin, eyeFt, senses, ambient, pxPerFt), footprint);
  });
  const overrides = state.fog_overrides ?? [];
  return {
    color: input.palette.fogUnexploredHex,
    alpha: input.isGm ? input.palette.fogExploredDimAlpha : 1,
    vision,
    reveal: overrides.filter((o) => o.mode === "REVEAL").map((o) => cellRect(o.cell_x, o.cell_y, cellPx)),
    hide: overrides.filter((o) => o.mode === "HIDE").map((o) => cellRect(o.cell_x, o.cell_y, cellPx)),
  };
}

function insidePolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function insideRect(point: Point2D, rect: Rect): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h;
}

/**
 * The viewer sees `point` through the fog: no fog at all (GM), or inside a
 * vision polygon or a GM `REVEAL` cell and not under a GM `HIDE` cell (the
 * renderer draws hide cells over vision). Uses even-odd ray casting.
 */
export function isPointUnfogged(fog: SceneFog | null, point: Point2D): boolean {
  if (!fog) return true;
  if (fog.hide.some((rect) => insideRect(point, rect))) return false;
  return fog.reveal.some((rect) => insideRect(point, rect)) || fog.vision.some((polygon) => polygon.length >= 3 && insidePolygon(point, polygon));
}

function buildPings(input: TableSceneInput): ScenePing[] {
  return input.pings
    .filter((ping) => input.nowMs - ping.receivedAtMs < PING_DURATION_MS)
    .map((ping) => ({
      key: `${ping.senderUserId}:${ping.receivedAtMs}`,
      pos: ping.pos,
      color: parseHexColor(ping.colorHex) ?? input.palette.pointerPingHex,
      receivedAtMs: ping.receivedAtMs,
    }));
}

/**
 * Ping ring at `nowMs`: an expanding, fading pulse, or a static ring when the
 * user prefers reduced motion. `alpha` is `0` once the ping expired.
 */
export function pingRing(ping: ScenePing, nowMs: number, cellPx: number, reducedMotion: boolean): { radiusPx: number; alpha: number } {
  const progress = (nowMs - ping.receivedAtMs) / PING_DURATION_MS;
  if (progress >= 1 || progress < 0) return { radiusPx: 0, alpha: 0 };
  if (reducedMotion) return { radiusPx: cellPx * 0.75, alpha: 1 };
  return { radiusPx: cellPx * (0.25 + 1.25 * progress), alpha: 1 - progress };
}

/** Builds the full draw list for one frame of the live table. */
export function buildTableScene(input: TableSceneInput): TableScene {
  const metrics = boardMetrics(input.state);
  const { palette, state } = input;
  const preset = ambientPreset(state?.ambient_lighting ?? "DAYLIGHT");
  const ambient = { tint: parseHexColor(CANVAS_AMBIENT_TINTS[preset]) ?? palette.fogUnexploredHex, alpha: AMBIENT_DARKNESS_ALPHA[preset] };
  return {
    ...metrics,
    voidColor: palette.canvasVoidHex,
    mapHash: state?.background_asset_hash ?? null,
    grid: { color: palette.gridLineHex, alpha: palette.gridLineAlpha },
    walls: state ? buildWalls(state, palette) : [],
    terrain: state ? buildTerrain(state, input, metrics.cellPx) : { cells: [], color: palette.textMutedHex, fillAlpha: TERRAIN_FILL_ALPHA },
    aoes: state ? buildAoes(state, input, metrics.cellPx) : [],
    tokens: state ? buildTokens(state, input, metrics.cellPx) : [],
    ambient,
    lights: state && ambient.alpha > 0 ? buildLights(state, input, metrics.cellPx) : [],
    fog: state ? buildFog(state, input, metrics.cellPx) : null,
    pings: buildPings(input),
    reducedMotion: input.reducedMotion,
  };
}

/**
 * Splits a polyline into dash segments (`[on, off]` in px), carrying the
 * pattern phase across vertices. Used for dashed walls, rings and AoE edges
 * because PixiJS strokes have no native dash.
 */
export function dashPolyline(points: Point2D[], dash: readonly [number, number], closed = false): [Point2D, Point2D][] {
  const [on, off] = dash;
  if (on <= 0 || points.length < 2) return [];
  const path = closed ? [...points, points[0]] : points;
  const segments: [Point2D, Point2D][] = [];
  let drawing = true;
  let left = on;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let at = 0;
    while (at < length - 1e-9) {
      const step = Math.min(left, length - at);
      if (drawing) {
        const t0 = at / length;
        const t1 = (at + step) / length;
        segments.push([
          { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
          { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
        ]);
      }
      at += step;
      left -= step;
      if (left <= 1e-9) {
        drawing = !drawing;
        left = drawing ? on : off;
      }
    }
  }
  return segments;
}

/** Regular polygon approximating a circle (`steps` vertices). */
export function circlePoints(center: Point2D, radius: number, steps = 48): Point2D[] {
  return Array.from({ length: steps }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}
