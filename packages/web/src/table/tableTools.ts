/**
 * ============================================================================
 * LIVE TABLE BRUSHES & BOARD VIEWPORT (table/tableTools.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Pure geometry behind the GM map tools and the zoomable board: which grid
 * cells a fog or difficult-terrain brush stroke covers, which commands a
 * finished stroke sends, and how zooming around a point moves the scroll
 * offsets. Keeping it out of `TableCanvas` makes the brush and viewport rules
 * testable without a DOM or WebGL.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `On-Map Cells Only`:
 *    - Every brush cell is clipped to `0..cols` x `0..rows`; the engine
 *      rejects `SET_DIFFICULT_TERRAIN` when any cell lies off the map.
 * 2. `Bounded Strokes, One Undo Step Each`:
 *    - A stroke keeps at most `MAX_STROKE_CELLS` distinct cells and finishes
 *      as one command (`SET_FOG_OVERRIDES` or `SET_DIFFICULT_TERRAIN`), so a
 *      5x5 drag is one undo entry instead of evicting the 50-entry undo ring.
 *    - `strokeCapped` tells the canvas that a stroke reached the cap, so the
 *      GM is told the rest of the drag was not painted.
 * 3. `Gap-Free Drags`:
 *    - Consecutive pointer samples are joined with a Bresenham line, so a
 *      fast drag paints every cell it crossed.
 * 4. `Zoom Anchoring`:
 *    - `zoomAround` keeps the board point under the anchor fixed on screen:
 *      `scroll' = (scroll + anchor) * zoom' / zoom - anchor`, with the zoom
 *      clamped to `MIN_ZOOM..=MAX_ZOOM`. Panning is the scroll container's
 *      own scrolling, so scrollbars, trackpads and touch all pan natively.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `pointerdown` -> `cellAt` -> `brushCells` -> stroke
 * `pointermove` -> `strokeCells(last, cell)` -> `brushCells` -> `mergeCells`
 * `pointerup`   -> `strokeCommands(tool, stroke)` -> `submitCommand`; cap notice
 * ============================================================================
 */
import type { WirePoint2D, WireTrameCommand } from "../api/wire.ts";
import type { GridCell } from "../engine/wasmBridge.ts";
import { setDifficultTerrain, setFogOverrides } from "./commands.ts";

/** Board interaction mode. `select` moves and selects tokens; the rest are GM brushes. */
export type TableTool = "select" | "fogReveal" | "fogHide" | "fogClear" | "terrainPaint" | "terrainErase";

/** Every `TableTool`, in toolbar order. */
export const TABLE_TOOLS: readonly TableTool[] = ["select", "fogReveal", "fogHide", "fogClear", "terrainPaint", "terrainErase"];

/** Brush edge lengths in cells (square brushes centred on the pointer cell). */
export const BRUSH_SIZES: readonly number[] = [1, 3, 5];

/** Maximum distinct cells one stroke may cover (invariant 2). */
export const MAX_STROKE_CELLS = 64;

/** Zoom bounds and the factor of one zoom step (buttons, wheel notch, keyboard). */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.25;

/** Board size in whole grid cells. */
export interface GridBounds {
  cols: number;
  rows: number;
}

/** Zoom level and scroll offsets (`px`) of the board scroll container. */
export interface ViewportState {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

/** Cell count of a `widthPx` x `heightPx` board (partial edge cells count, like the engine). */
export function gridBounds(widthPx: number, heightPx: number, cellPx: number): GridBounds {
  const cell = cellPx > 0 ? cellPx : 1;
  return { cols: Math.max(1, Math.ceil(widthPx / cell)), rows: Math.max(1, Math.ceil(heightPx / cell)) };
}

/** Grid cell under a board point (`px`). */
export function cellAt(point: WirePoint2D, cellPx: number): GridCell {
  const cell = cellPx > 0 ? cellPx : 1;
  return { col: Math.floor(point.x / cell), row: Math.floor(point.y / cell) };
}

/** Square `size` x `size` brush centred on `center`, clipped to the map (invariant 1). */
export function brushCells(center: GridCell, size: number, bounds: GridBounds): GridCell[] {
  const edge = Math.max(1, Math.trunc(size));
  const start = -Math.floor((edge - 1) / 2);
  const cells: GridCell[] = [];
  for (let dr = start; dr < start + edge; dr++) {
    for (let dc = start; dc < start + edge; dc++) {
      const col = center.col + dc;
      const row = center.row + dr;
      if (col >= 0 && row >= 0 && col < bounds.cols && row < bounds.rows) cells.push({ col, row });
    }
  }
  return cells;
}

/** Cells on the Bresenham line from `from` to `to`, both included (invariant 3). */
export function strokeCells(from: GridCell, to: GridCell): GridCell[] {
  const cells: GridCell[] = [];
  let { col, row } = from;
  const dc = Math.abs(to.col - col);
  const dr = -Math.abs(to.row - row);
  const sc = col < to.col ? 1 : -1;
  const sr = row < to.row ? 1 : -1;
  let err = dc + dr;
  for (;;) {
    cells.push({ col, row });
    if (col === to.col && row === to.row) return cells;
    const e2 = 2 * err;
    if (e2 >= dr) {
      err += dr;
      col += sc;
    }
    if (e2 <= dc) {
      err += dc;
      row += sr;
    }
  }
}

/** Appends the new cells of `added` to `stroke`, without duplicates, up to `MAX_STROKE_CELLS`. */
export function mergeCells(stroke: GridCell[], added: GridCell[]): GridCell[] {
  const seen = new Set(stroke.map((c) => `${c.col},${c.row}`));
  const out = [...stroke];
  for (const cell of added) {
    if (out.length >= MAX_STROKE_CELLS) break;
    const key = `${cell.col},${cell.row}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cell);
    }
  }
  return out;
}

/** A stroke reached `MAX_STROKE_CELLS`; later cells of the drag were dropped (invariant 2). */
export function strokeCapped(cells: readonly GridCell[]): boolean {
  return cells.length >= MAX_STROKE_CELLS;
}

/** Commands a finished stroke sends: one fog command or one terrain command (one undo step). */
export function strokeCommands(tool: TableTool, cells: GridCell[]): WireTrameCommand[] {
  if (cells.length === 0) return [];
  switch (tool) {
    case "fogReveal":
      return [setFogOverrides("REVEAL", cells)];
    case "fogHide":
      return [setFogOverrides("HIDE", cells)];
    case "fogClear":
      return [setFogOverrides("CLEAR", cells)];
    case "terrainPaint":
      return [setDifficultTerrain(cells, true)];
    case "terrainErase":
      return [setDifficultTerrain(cells, false)];
    case "select":
      return [];
  }
}

/** Clamps a zoom level to `MIN_ZOOM..=MAX_ZOOM` (non-finite values reset to `1`). */
export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1;
}

/**
 * Zooms by `factor` around `anchor` (a point in the scroll container's visible
 * area, `px`), keeping the board point under it in place (invariant 4).
 */
export function zoomAround(view: ViewportState, factor: number, anchor: WirePoint2D): ViewportState {
  const zoom = clampZoom(view.zoom * factor);
  const ratio = zoom / view.zoom;
  return {
    zoom,
    scrollLeft: Math.max(0, (view.scrollLeft + anchor.x) * ratio - anchor.x),
    scrollTop: Math.max(0, (view.scrollTop + anchor.y) * ratio - anchor.y),
  };
}

/** Zoom factor of a two-finger pinch: current finger distance over the previous one. */
export function pinchFactor(previous: [WirePoint2D, WirePoint2D], current: [WirePoint2D, WirePoint2D]): number {
  const before = Math.hypot(previous[0].x - previous[1].x, previous[0].y - previous[1].y);
  const after = Math.hypot(current[0].x - current[1].x, current[0].y - current[1].y);
  return before > 0 ? after / before : 1;
}
