/**
 * ============================================================================
 * LIVE TABLE VIEW MODEL (table/tableView.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Pure selectors over the recipient-projected `ProjectedTableState` used by
 * the table components (canvas, combat tracker, vitals controls, reaction
 * banner). Keeping them out of the components makes the projection rules
 * testable without a DOM and keeps every component reading the same facts.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Projection Is The Permission Boundary`:
 *    - A token in `tokens` is controlled by the recipient (every token for a
 *      GM); a token in `public_tokens` is only visible. Controls (move,
 *      damage, heal) are offered for controlled tokens only; the engine still
 *      re-checks every command (G6).
 * 2. `No Vitals Leak`:
 *    - Public tokens expose a `bloodied` tier, never exact hit points; the
 *      view model forwards what the projection carries and invents nothing.
 * 3. `Grid Snapping`:
 *    - Click targets snap to the top-left corner of the grid cell under the
 *      pointer (`floor(x / cell) * cell`), so moves land on cells.
 * ============================================================================
 */
import type { ProjectedTableState, Uuid, WireBloodiedState, WirePoint2D, WireReactionPrompt } from "../api/wire.ts";

/** Token as rendered on the table. */
export interface TableToken {
  id: Uuid;
  name: string;
  /** `true` when the token is in `tokens` (recipient controls it). */
  controlled: boolean;
  actorId: Uuid | null;
  ownerUserId: Uuid | null;
  /** Top-left canvas coordinate in pixels (`px`). */
  topLeft: WirePoint2D;
  /** Footprint in grid cells (`>= 1`). */
  gridW: number;
  gridH: number;
  /** Exact hit points, controlled tokens only. */
  hp: number | null;
  maxHp: number | null;
  tempHp: number | null;
  /** Coarse health tier, public tokens only. */
  bloodied: WireBloodiedState | null;
  conditions: string[];
}

/** One row of the combat tracker. */
export interface InitiativeEntry {
  tokenId: Uuid;
  name: string;
  /** Rolled total, `null` until known. */
  total: number | null;
  isActive: boolean;
}

/** Snaps a canvas point (`px`) to the top-left corner of its grid cell. */
export function snapToCell(point: WirePoint2D, cellSizePx: number): WirePoint2D {
  const cell = cellSizePx > 0 ? cellSizePx : 1;
  return { x: Math.floor(point.x / cell) * cell, y: Math.floor(point.y / cell) * cell };
}

/**
 * Asset hash accepted by `GET .../assets/{hash}/presign`. Scenes store the full
 * object key (`instances/{i}/campaigns/{c}/assets/{hash}.webp`), and activation
 * copies it into `background_asset_hash`, so the last path segment is taken
 * and the `.webp` suffix dropped; a bare hash passes through unchanged.
 */
export function assetHashFromKey(keyOrHash: string): string {
  return (keyOrHash.split("/").pop() ?? keyOrHash).replace(/\.webp$/, "");
}

/** Every token the recipient can see, controlled tokens first, then by name. */
export function listTableTokens(state: ProjectedTableState | null): TableToken[] {
  if (!state) return [];
  const toToken = (raw: ProjectedTableState["tokens"][Uuid], controlled: boolean): TableToken => ({
    id: raw.id,
    name: raw.name ?? "",
    controlled,
    actorId: raw.actor_id ?? null,
    ownerUserId: raw.owner_user_id ?? null,
    topLeft: raw.top_left ?? { x: 0, y: 0 },
    gridW: Math.max(1, raw.grid_w ?? 1),
    gridH: Math.max(1, raw.grid_h ?? 1),
    hp: controlled && typeof raw.hp === "number" ? raw.hp : null,
    maxHp: controlled && typeof raw.max_hp === "number" ? raw.max_hp : null,
    tempHp: controlled && typeof raw.temp_hp === "number" ? raw.temp_hp : null,
    bloodied: controlled ? null : (raw.bloodied ?? null),
    conditions: Array.isArray(raw.conditions) ? raw.conditions : [],
  });
  const tokens = [
    ...Object.values(state.tokens).map((raw) => toToken(raw, true)),
    ...Object.values(state.public_tokens ?? {})
      .filter((raw) => !state.tokens[raw.id])
      .map((raw) => toToken(raw, false)),
  ];
  return tokens.sort((a, b) => Number(b.controlled) - Number(a.controlled) || a.name.localeCompare(b.name));
}

/**
 * First grid cell (row-major from the top-left) whose top-left corner holds
 * no visible token, used to drop a newly placed token; falls back to the
 * origin when the board is full.
 */
export function firstFreeCell(state: ProjectedTableState | null): WirePoint2D {
  const cell = state && state.cell_size_px > 0 ? state.cell_size_px : 50;
  const cols = Math.max(1, Math.floor((state?.map_width_px || cell * 20) / cell));
  const rows = Math.max(1, Math.floor((state?.map_height_px || cell * 20) / cell));
  const taken = new Set(listTableTokens(state).map((tok) => `${tok.topLeft.x},${tok.topLeft.y}`));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!taken.has(`${col * cell},${row * cell}`)) return { x: col * cell, y: row * cell };
    }
  }
  return { x: 0, y: 0 };
}

/** Initiative rows in turn order; hidden combatants are absent from the projection. */
export function initiativeEntries(state: ProjectedTableState | null, totals: Record<Uuid, number>): InitiativeEntry[] {
  if (!state || state.mode !== "TURN_BY_TURN") return [];
  const names = new Map(listTableTokens(state).map((tok) => [tok.id, tok.name]));
  return state.initiative_order.map((tokenId, index) => ({
    tokenId,
    name: names.get(tokenId) ?? "",
    total: totals[tokenId] ?? null,
    isActive: state.active_turn_index === index,
  }));
}

/** Token holding the current turn, `null` outside combat or when hidden. */
export function activeTurnTokenId(state: ProjectedTableState | null): Uuid | null {
  if (!state || state.mode !== "TURN_BY_TURN" || state.active_turn_index === null) return null;
  return state.initiative_order[state.active_turn_index] ?? null;
}

/**
 * Prompts the user must decide: their own reactor's prompts, plus every
 * prompt for a GM (who decides GM-owned reactors and may force any decision).
 */
export function promptsForUser(state: ProjectedTableState | null, userId: Uuid | null, isGm: boolean): WireReactionPrompt[] {
  if (!state) return [];
  return Object.values(state.active_reaction_prompts ?? {}).filter(
    (prompt) => isGm || (userId !== null && prompt.reactor_owner_user_id === userId),
  );
}
