/**
 * ============================================================================
 * STUDIO DIFFICULT-TERRAIN BRUSH (maps/terrainBrush.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Pure cell math behind the map studio terrain brush: which grid cell a
 * canvas point falls in, painting or erasing one cell, and moving the
 * keyboard cursor. The cells are saved with the scene (`difficult_terrain`)
 * and `ActivateScene` loads them onto the table, so the Game Master prepares
 * rubble and mud before play instead of painting it live in front of players.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `On-Map Cells Only`:
 *    - Cells outside `0..cols` x `0..rows` are never stored; the engine would
 *      drop them on activation anyway.
 * 2. `Set Semantics`:
 *    - Painting a painted cell or erasing a bare one returns the same array,
 *      so a pointer drag over one cell does not churn renders or duplicates.
 * 3. `Keyboard Parity`:
 *    - Arrow keys move the cursor one cell (clamped to the map), Home / End
 *      jump to the row ends; every cell the mouse can paint is reachable.
 * ============================================================================
 */
import type { GridCell, Point2D } from '../engine/wasmBridge.ts';

/** Studio terrain brush mode: paint marks difficult terrain, erase clears it. */
export type TerrainBrushMode = 'paint' | 'erase';

/** Grid size of a scene in whole cells (`cols` x `rows`, at least 1 x 1). */
export function sceneGridSize(widthPx: number, heightPx: number, cellPx: number): { cols: number; rows: number } {
  const cell = cellPx > 0 ? cellPx : 70;
  return { cols: Math.max(1, Math.ceil(widthPx / cell)), rows: Math.max(1, Math.ceil(heightPx / cell)) };
}

/** The cell containing scene point `p`, or `null` off the map (invariant 1). */
export function cellAtPoint(p: Point2D, cellPx: number, cols: number, rows: number): GridCell | null {
  const col = Math.floor(p.x / cellPx);
  const row = Math.floor(p.y / cellPx);
  return col >= 0 && row >= 0 && col < cols && row < rows ? { col, row } : null;
}

/** Whether `cells` holds `cell`. */
export function hasCell(cells: readonly GridCell[], cell: GridCell): boolean {
  return cells.some((c) => c.col === cell.col && c.row === cell.row);
}

/** `cells` with `cell` painted or erased; the same array when nothing changes (invariant 2). */
export function applyTerrainBrush(cells: GridCell[], cell: GridCell, mode: TerrainBrushMode): GridCell[] {
  const present = hasCell(cells, cell);
  if (mode === 'paint') return present ? cells : [...cells, { col: cell.col, row: cell.row }];
  return present ? cells.filter((c) => c.col !== cell.col || c.row !== cell.row) : cells;
}

/** Cursor after `key`, clamped to the map, or `null` when the key is not a cursor key (invariant 3). */
export function moveTerrainCursor(cursor: GridCell, key: string, cols: number, rows: number): GridCell | null {
  const clamp = (col: number, row: number): GridCell => ({
    col: Math.min(cols - 1, Math.max(0, col)),
    row: Math.min(rows - 1, Math.max(0, row)),
  });
  switch (key) {
    case 'ArrowLeft':
      return clamp(cursor.col - 1, cursor.row);
    case 'ArrowRight':
      return clamp(cursor.col + 1, cursor.row);
    case 'ArrowUp':
      return clamp(cursor.col, cursor.row - 1);
    case 'ArrowDown':
      return clamp(cursor.col, cursor.row + 1);
    case 'Home':
      return clamp(0, cursor.row);
    case 'End':
      return clamp(cols - 1, cursor.row);
    default:
      return null;
  }
}
