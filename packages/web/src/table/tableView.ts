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
 * 4. `Door Handles Follow The Projection`:
 *    - Players never receive a closed secret door (the server sends it as
 *      `NORMAL`), so `doorHandles` cannot reveal one. A handle is actionable
 *      for the GM on every door, and for players on unlocked plain doors,
 *      the same rule the engine applies to `TOGGLE_DOOR`. Each handle
 *      carries one probe point per side so the board can hide handles of
 *      doors the player does not see (both sides fogged).
 * 5. `Death Saving Throw Phase`:
 *    - `deathSavePhase` reads the server's counters and flags; the client
 *      never evaluates a roll itself, the room resolves `RECORD_DEATH_SAVE`.
 * ============================================================================
 */
import type { ConditionOverrideRuling } from "../../../game-systems/dnd5e/src/conditions.ts";
import type { ProjectedTableState, Uuid, WireBloodiedState, WirePoint2D, WireReactionPrompt, WireTokenState } from "../api/wire.ts";

/** `CHANNEL_GM_HIDDEN` bit of `TokenState::visibility_channel` (`geometry.rs`). */
const CHANNEL_GM_HIDDEN = 0b100;

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
  /** GM rulings (`condition_overrides`), controlled tokens only. */
  conditionOverrides: ConditionOverrideRuling[];
  /** Concentrating on a spell, with (`concentrating_on_aoe_id`) or without a zone. */
  concentrating: boolean;
  /** Death saving throw counters (`0..=3`), controlled tokens only. */
  deathSaves: { successes: number; failures: number };
  /** Stable at 0 HP (no more death saving throws until damaged). */
  isStable: boolean;
  isDead: boolean;
  /** Disengage taken this turn (no opportunity attacks). */
  disengaged: boolean;
  /** Hidden from every player by the GM (`CHANNEL_GM_HIDDEN`). */
  gmHidden: boolean;
  invisible: boolean;
  /** Remaining and maximum walking speed in feet (`ft`), controlled tokens only. */
  speedRemainingFt: number | null;
  speedMaxFt: number | null;
  /** Base elevation and stature in feet (`ft`). */
  elevationFt: number;
  heightFt: number;
  /** Name of the server-validated stat block copy (`stat_block.name`), when any. */
  statBlockName: string | null;
}

/** Life state driving the death saving throw controls (`deathSavePhase`). */
export type DeathSavePhase = "conscious" | "dying" | "stable" | "dead" | "unknown";

/** Door handle drawn at a door's midpoint on the board. */
export interface DoorHandle {
  wallId: Uuid;
  /** Segment start point in canvas pixels (`px`). */
  a: WirePoint2D;
  /** Segment end point in canvas pixels (`px`). */
  b: WirePoint2D;
  /** Bottom elevation of the door segment in feet (`ft`). */
  bottomElevationFt: number;
  /** Top elevation of the door segment in feet (`ft`). */
  topElevationFt: number;
  /** Midpoint of the door segment in canvas pixels (`px`). */
  pos: WirePoint2D;
  isOpen: boolean;
  isLocked: boolean;
  isSecret: boolean;
  /** The recipient may send `TOGGLE_DOOR` for it (see invariant 4). */
  canToggle: boolean;
  /**
   * Two points `DOOR_SIDE_PROBE_PX` off the door's midpoint, one on each side
   * of the segment; a player sees the handle when either is out of the fog
   * (the midpoint itself lies on the vision polygon's edge).
   */
  sides: [WirePoint2D, WirePoint2D];
}

/** Distance (`px`) of the door side probes from the door line. */
export const DOOR_SIDE_PROBE_PX = 8;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function overridesOf(raw: WireTokenState): ConditionOverrideRuling[] {
  const list = Array.isArray(raw.condition_overrides) ? (raw.condition_overrides as ConditionOverrideRuling[]) : [];
  return list.filter((o) => (o.subject === "CONDITION" || o.subject === "EFFECT") && typeof o.id === "string");
}

function statBlockName(raw: WireTokenState): string | null {
  const name = raw.stat_block?.name;
  return typeof name === "string" && name.trim() ? name : null;
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
    conditionOverrides: controlled ? overridesOf(raw) : [],
    concentrating: raw.concentrating === true || (typeof raw.concentrating_on_aoe_id === "string" && raw.concentrating_on_aoe_id !== ""),
    deathSaves: {
      successes: controlled ? numberOr(raw.death_save_successes, 0) : 0,
      failures: controlled ? numberOr(raw.death_save_failures, 0) : 0,
    },
    isStable: raw.is_stable === true,
    isDead: raw.is_dead === true,
    disengaged: raw.disengaged === true,
    gmHidden: (numberOr(raw.visibility_channel, 1) & CHANNEL_GM_HIDDEN) !== 0,
    invisible: raw.invisible === true,
    speedRemainingFt: controlled && typeof raw.speed_remaining_ft === "number" ? raw.speed_remaining_ft : null,
    speedMaxFt: controlled && typeof raw.speed_max_ft === "number" ? raw.speed_max_ft : null,
    elevationFt: numberOr(raw.elevation_ft, 0),
    heightFt: numberOr(raw.height_ft, 5),
    statBlockName: controlled ? statBlockName(raw) : null,
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

/**
 * Top-left (`px`) of a compendium spawn: the GM's selected cell, else the cell under
 * the viewport centre, else `firstFreeCell`; clamped to the map grid so a stale point
 * from a larger map never lands off the board.
 */
export function spawnTopLeft(
  state: ProjectedTableState | null,
  selectedCell: WirePoint2D | null,
  viewportCenter: WirePoint2D | null,
): WirePoint2D {
  const point = selectedCell ?? viewportCenter;
  if (!point) return firstFreeCell(state);
  const cell = state && state.cell_size_px > 0 ? state.cell_size_px : 50;
  const maxX = Math.max(0, Math.ceil((state?.map_width_px || cell) / cell) - 1) * cell;
  const maxY = Math.max(0, Math.ceil((state?.map_height_px || cell) / cell) - 1) * cell;
  const snapped = snapToCell(point, cell);
  return { x: Math.min(maxX, Math.max(0, snapped.x)), y: Math.min(maxY, Math.max(0, snapped.y)) };
}

/**
 * `base` when no visible token carries that name yet, otherwise `base N` with
 * the smallest free `N >= 2`, so several spawned monsters of one kind stay
 * distinguishable in target lists and the initiative tracker.
 */
export function uniqueTokenName(base: string, state: ProjectedTableState | null): string {
  return uniqueNameAmong(base, listTableTokens(state).map((tok) => tok.name));
}

/** `uniqueTokenName` over an explicit name list (for example a scene's staged tokens). */
export function uniqueNameAmong(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
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
 * Death saving throw phase of a token: `unknown` for tokens whose hit points
 * the recipient does not see, `dead` / `stable` from the server flags, then
 * `dying` at 0 HP and `conscious` above.
 */
export function deathSavePhase(token: TableToken): DeathSavePhase {
  if (token.isDead) return "dead";
  if (token.hp === null) return "unknown";
  if (token.hp > 0) return "conscious";
  return token.isStable ? "stable" : "dying";
}

/** Door handles of the projected walls (invariant 4); `spectator` handles are never actionable. */
export function doorHandles(state: ProjectedTableState | null, isGm: boolean, spectator = false): DoorHandle[] {
  if (!state) return [];
  return (state.walls ?? []).flatMap((wall): DoorHandle[] => {
    const kind = wall.kind;
    if (kind?.kind !== "DOOR" && kind?.kind !== "SECRET_DOOR") return [];
    const isLocked = kind.kind === "DOOR" && kind.is_locked;
    const isSecret = kind.kind === "SECRET_DOOR";
    const pos = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
    const length = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
    const nx = (-(wall.b.y - wall.a.y) / length) * DOOR_SIDE_PROBE_PX;
    const ny = ((wall.b.x - wall.a.x) / length) * DOOR_SIDE_PROBE_PX;
    return [
      {
        wallId: wall.id,
        a: wall.a,
        b: wall.b,
        bottomElevationFt: numberOr(wall.bottom_elevation_ft, -1000),
        topElevationFt: numberOr(wall.top_elevation_ft, 1000),
        pos,
        isOpen: kind.is_open,
        isLocked,
        isSecret,
        canToggle: !spectator && (isGm || (!isSecret && !isLocked)),
        sides: [
          { x: pos.x + nx, y: pos.y + ny },
          { x: pos.x - nx, y: pos.y - ny },
        ],
      },
    ];
  });
}

function segmentIntersectsRect(a: WirePoint2D, b: WirePoint2D, min: WirePoint2D, max: WirePoint2D): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, a.x - min.x) && clip(dx, max.x - a.x) && clip(-dy, a.y - min.y) && clip(dy, max.y - a.y);
}

function segmentRectDistancePx(a: WirePoint2D, b: WirePoint2D, min: WirePoint2D, max: WirePoint2D): number {
  if (segmentIntersectsRect(a, b, min, max)) return 0;
  const toRect = (p: WirePoint2D): number => {
    const dx = Math.max(0, min.x - p.x, p.x - max.x);
    const dy = Math.max(0, min.y - p.y, p.y - max.y);
    return Math.hypot(dx, dy);
  };
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const lenSq = sx * sx + sy * sy;
  const toSegment = (p: WirePoint2D): number => {
    const t = lenSq > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * sx + (p.y - a.y) * sy) / lenSq)) : 0;
    return Math.hypot(p.x - (a.x + t * sx), p.y - (a.y + t * sy));
  };
  return Math.min(
    toRect(a),
    toRect(b),
    toSegment(min),
    toSegment({ x: max.x, y: min.y }),
    toSegment(max),
    toSegment({ x: min.x, y: max.y }),
  );
}

/**
 * 3D distance in feet (`ft`) from `token`'s footprint to `door`, matching the
 * engine's `player_reaches_door` check: the larger of the horizontal
 * footprint-to-segment distance and the vertical gap to the door's elevation
 * span, rounded to `0.1 ft`.
 */
export function doorDistanceFt(door: DoorHandle, token: TableToken, cellSizePx: number, feetPerCell = 5): number {
  const cell = cellSizePx > 0 ? cellSizePx : 50;
  const ftPerCell = feetPerCell > 0 ? feetPerCell : 5;
  const max = {
    x: token.topLeft.x + Math.max(1, token.gridW) * cell,
    y: token.topLeft.y + Math.max(1, token.gridH) * cell,
  };
  const horizontalFt = segmentRectDistancePx(door.a, door.b, token.topLeft, max) * (ftPerCell / cell);
  const verticalFt = Math.max(0, door.bottomElevationFt - token.elevationFt, token.elevationFt - door.topElevationFt);
  return Math.round(Math.max(horizontalFt, verticalFt) * 10) / 10;
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
