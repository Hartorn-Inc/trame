/**
 * ============================================================================
 * PLAYER FOG MEMORY (table/fogMemory.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Remembers which grid cells a player's tokens have seen on a map, so the
 * table keeps them visible as dimmed "explored" terrain after the tokens move
 * on (`FogLayer` Layer 1, GLOSSARY.md) instead of dropping them back into
 * opaque fog. Without it a player loses the map behind them at every step.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Cells, Not Pixels`:
 *    - A cell is explored once its centre falls inside a vision polygon of
 *      one of the player's tokens (the engine's polygons from `tableScene`).
 *      Cells are stored as `row * cols + col` in a bitset.
 * 2. `Per Player, Per Map, Local`:
 *    - The server stores only one `explored_fog_texture` per scene and no
 *      per-player memory, so memory lives in this browser's `localStorage`
 *      under `fogMemoryKey(user, campaign, scene)`. A stored value records
 *      the grid size; a map whose grid changed starts unexplored.
 *    - Memory only reveals terrain: live tokens are never drawn from it
 *      (the server already drops tokens outside line of sight, and
 *      `tableScene` hides any non-controlled token outside current sight).
 * 3. `Fail Closed On Bad Data`:
 *    - Unreadable, truncated or foreign values decode to "nothing explored";
 *      storage errors (private mode, quota) are ignored, never thrown.
 * 4. `Identity When Unchanged`:
 *    - `exploreCells` returns the same `Set` when no new cell was seen, so
 *      callers can skip saving and re-rendering.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `loadFogMemory(storage, key, grid)` on map change
 * -> each render: `exploreCells(memory, scene.fog.vision, grid)`
 * -> changed: `saveFogMemory(storage, key, memory, grid)`
 * ============================================================================
 */
import type { Point2D } from "../engine/wasmBridge.ts";

/** Grid of the active map: `cols` x `rows` cells of `cellPx` pixels. */
export interface FogGrid {
  cols: number;
  rows: number;
  cellPx: number;
}

/** `localStorage` subset used for persistence (`null` when unavailable). */
export type FogStorage = Pick<Storage, "getItem" | "setItem"> | null;

const VERSION = "v1";

/** Grid covering a `widthPx` x `heightPx` board (partial edge cells included). */
export function fogGrid(widthPx: number, heightPx: number, cellPx: number): FogGrid {
  return { cols: Math.max(1, Math.ceil(widthPx / cellPx)), rows: Math.max(1, Math.ceil(heightPx / cellPx)), cellPx };
}

/** Storage key of one player's memory of one map. */
export function fogMemoryKey(userId: string, campaignId: string, sceneKey: string): string {
  return `trame.fogMemory.${VERSION}:${userId}:${campaignId}:${sceneKey}`;
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

/**
 * `explored` plus every on-map cell whose centre is inside one of `vision`
 * (invariant 1). Returns `explored` itself when nothing new was seen (invariant 4).
 */
export function exploreCells(explored: ReadonlySet<number>, vision: readonly Point2D[][], grid: FogGrid): ReadonlySet<number> {
  let next: Set<number> | null = null;
  for (const polygon of vision) {
    if (polygon.length < 3) continue;
    const xs = polygon.map((p) => p.x);
    const ys = polygon.map((p) => p.y);
    const c0 = Math.max(0, Math.floor(Math.min(...xs) / grid.cellPx));
    const c1 = Math.min(grid.cols - 1, Math.floor(Math.max(...xs) / grid.cellPx));
    const r0 = Math.max(0, Math.floor(Math.min(...ys) / grid.cellPx));
    const r1 = Math.min(grid.rows - 1, Math.floor(Math.max(...ys) / grid.cellPx));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const key = row * grid.cols + col;
        if (explored.has(key) || next?.has(key)) continue;
        if (!insidePolygon({ x: (col + 0.5) * grid.cellPx, y: (row + 0.5) * grid.cellPx }, polygon)) continue;
        next ??= new Set(explored);
        next.add(key);
      }
    }
  }
  return next ?? explored;
}

/** `v1:<cols>x<rows>:<base64 bitset>`. */
export function encodeCells(cells: ReadonlySet<number>, grid: FogGrid): string {
  const bytes = new Uint8Array(Math.ceil((grid.cols * grid.rows) / 8));
  for (const key of cells) {
    if (key >= 0 && key < grid.cols * grid.rows) bytes[key >> 3] |= 1 << (key & 7);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${VERSION}:${grid.cols}x${grid.rows}:${btoa(binary)}`;
}

/** Inverse of `encodeCells`; anything else, or another grid size, is empty (invariants 2 and 3). */
export function decodeCells(value: string | null, grid: FogGrid): Set<number> {
  const cells = new Set<number>();
  const match = value?.match(/^v1:(\d+)x(\d+):([A-Za-z0-9+/=]*)$/);
  if (!match || Number(match[1]) !== grid.cols || Number(match[2]) !== grid.rows) return cells;
  let binary: string;
  try {
    binary = atob(match[3]);
  } catch {
    return cells;
  }
  if (binary.length !== Math.ceil((grid.cols * grid.rows) / 8)) return cells;
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) cells.add(i * 8 + bit);
  }
  return cells;
}

/** Stored memory for `key`, empty when absent or unreadable (invariant 3). */
export function loadFogMemory(storage: FogStorage, key: string, grid: FogGrid): Set<number> {
  try {
    return decodeCells(storage?.getItem(key) ?? null, grid);
  } catch {
    return new Set();
  }
}

/** Persists `cells` under `key`; storage failures are ignored (invariant 3). */
export function saveFogMemory(storage: FogStorage, key: string, cells: ReadonlySet<number>, grid: FogGrid): void {
  try {
    storage?.setItem(key, encodeCells(cells, grid));
  } catch {
    // Private browsing or a full quota: the memory lasts for this session only.
  }
}
