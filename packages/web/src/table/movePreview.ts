/**
 * ============================================================================
 * MOVE COST PREVIEW (table/movePreview.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Tells a player what a move will cost before they send it (spec E-A: the
 * movement preview and the server validation share one WASM function). The
 * board asks `previewTokenMove` for the cell under the pointer or the
 * keyboard move cursor and shows the cost in feet, and whether the server
 * would refuse it. Without it a player learns the Chebyshev and
 * difficult-terrain rules only from refusals.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Same Rules As The Server`:
 *    - Cost and wall collision come from the engine `previewMove` with the
 *      projection's walls, `difficult_terrain`, `cell_size_px` and
 *      `feet_per_cell`, the inputs `MoveToken` validates against.
 * 2. `Budget Only In Combat`:
 *    - The engine charges `speed_remaining_ft` in `TURN_BY_TURN` mode only,
 *      so `overBudget` is never set while exploring, and never for a token
 *      whose remaining speed the viewer does not know.
 * 3. `Advisory`:
 *    - The preview never blocks a send: the server stays authoritative and
 *      its refusal toast still explains a stale preview. `null` (engine not
 *      ready, or it threw) shows no preview at all.
 * ============================================================================
 */
import type { ProjectedTableState, WirePoint2D } from "../api/wire.ts";
import { isEngineReady, previewMove } from "../engine/wasmBridge.ts";
import { boardMetrics, engineWalls } from "./scene/tableScene.ts";
import type { TableToken } from "./tableView.ts";

/** Engine slack (`ft`) the server allows when comparing cost with the remaining speed. */
const BUDGET_EPSILON_FT = 1e-6;

/** What moving a token to one destination would cost. */
export interface MoveCostPreview {
  /** Chebyshev cost in feet (`ft`), difficult squares doubled. */
  costFt: number;
  /** Remaining speed in feet (`ft`) when the turn budget applies, else `null`. */
  remainingFt: number | null;
  /** A movement-blocking wall crosses the straight path. */
  blocked: boolean;
  /** The cost exceeds `remainingFt` (combat only, invariant 2). */
  overBudget: boolean;
  /** Neither blocked nor over budget: the server should accept the move. */
  reachable: boolean;
}

/**
 * Previews `token` moving to `toTopLeft` (canvas `px`) with the engine rules,
 * or `null` when no preview can be computed (invariant 3).
 */
export function previewTokenMove(state: ProjectedTableState | null, token: TableToken, toTopLeft: WirePoint2D): MoveCostPreview | null {
  if (!state || !isEngineReady()) return null;
  try {
    const { collision, costFt } = previewMove(
      { topLeft: token.topLeft, gridW: token.gridW, gridH: token.gridH, elevationFt: token.elevationFt, heightFt: token.heightFt },
      toTopLeft,
      engineWalls(state.walls ?? [], "vision"),
      boardMetrics(state).cellPx,
      state.feet_per_cell > 0 ? state.feet_per_cell : 5,
      undefined,
      state.difficult_terrain ?? [],
    );
    const remainingFt = state.mode === "TURN_BY_TURN" ? token.speedRemainingFt : null;
    const blocked = collision !== null;
    const overBudget = remainingFt !== null && costFt > remainingFt + BUDGET_EPSILON_FT;
    return { costFt, remainingFt, blocked, overBudget, reachable: !blocked && !overBudget };
  } catch {
    return null;
  }
}
