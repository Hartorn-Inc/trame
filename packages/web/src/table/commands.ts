/**
 * ============================================================================
 * TYPED TRAME COMMAND BUILDERS (table/commands.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Builds the internally tagged `TrameCommand` maps the engine deserializes
 * (`#[serde(tag = "cmd", rename_all = "SCREAMING_SNAKE_CASE")]`). Without one
 * place that owns field names and tags, every component would hand-roll
 * `{ cmd: ... }` literals and a typo would only surface as a server-side
 * `CommandRejected` during play.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Tag And Field Parity`:
 *    - Each builder mirrors one variant of `TrameCommand` in
 *      `crates/trame-engine/src/commands.rs` with snake_case fields; optional
 *      engine fields are always sent explicitly (`null` / defaults).
 * 2. `Server-Resolved Scenes`:
 *    - `activateScene` sends only `scene_id`; the server fills the stored
 *      scene payload, so a client can never inject geometry.
 * 3. `Integer Hit Points`:
 *    - Damage and healing amounts are truncated to non-negative integers,
 *      matching the engine `i32` fields and rejecting negative "healing damage".
 * ============================================================================
 */
import type { Uuid, WirePoint2D, WireTrameCommand } from "../api/wire.ts";

/** Target affinity toward the damage type (`DamageAffinity`). */
export type DamageAffinity = "NORMAL" | "RESISTANT" | "VULNERABLE" | "IMMUNE";

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** `MOVE_TOKEN`: moves a token's top-left corner to `to` (canvas `px`). */
export function moveToken(tokenId: Uuid, to: WirePoint2D, gmTeleport = false): WireTrameCommand {
  return { cmd: "MOVE_TOKEN", token_id: tokenId, to_top_left: to, to_elevation_ft: null, gm_teleport: gmTeleport };
}

/** `START_TURN_BY_TURN`: enters combat with the given order (totals may be added later). */
export function startTurnByTurn(initiativeOrder: Uuid[], initiativeTotals: Record<Uuid, number> = {}): WireTrameCommand {
  return { cmd: "START_TURN_BY_TURN", initiative_order: initiativeOrder, initiative_totals: initiativeTotals };
}

/** `SET_INITIATIVE_TOTAL`: records a rolled total; the engine re-sorts the order. */
export function setInitiativeTotal(tokenId: Uuid, total: number): WireTrameCommand {
  return { cmd: "SET_INITIATIVE_TOTAL", token_id: tokenId, total: Math.trunc(total) };
}

/** `ADVANCE_TURN`: passes the turn to the next combatant. */
export function advanceTurn(): WireTrameCommand {
  return { cmd: "ADVANCE_TURN" };
}

/** `END_TURN_BY_TURN`: leaves combat and returns to exploration. */
export function endTurnByTurn(): WireTrameCommand {
  return { cmd: "END_TURN_BY_TURN" };
}

/** `APPLY_DAMAGE`: raw damage before affinity; the engine resolves temp HP and resistance. */
export function applyDamage(tokenId: Uuid, rawDamage: number, affinity: DamageAffinity = "NORMAL"): WireTrameCommand {
  return {
    cmd: "APPLY_DAMAGE",
    token_id: tokenId,
    raw_damage: nonNegativeInt(rawDamage),
    affinity,
    is_critical: false,
    damage_type: null,
  };
}

/** `HEAL_ACTOR`: restores hit points up to the token's maximum. */
export function healActor(tokenId: Uuid, amount: number): WireTrameCommand {
  return { cmd: "HEAL_ACTOR", token_id: tokenId, amount: nonNegativeInt(amount) };
}

/** `ACTIVATE_SCENE`: GM-only; the server resolves the stored scene (invariant 2). */
export function activateScene(sceneId: Uuid): WireTrameCommand {
  return { cmd: "ACTIVATE_SCENE", scene_id: sceneId };
}

/** `COMMIT_MCP_STAGING`: applies a staged MCP batch atomically (GM-only). */
export function commitMcpStaging(proposalId: Uuid): WireTrameCommand {
  return { cmd: "COMMIT_MCP_STAGING", proposal_id: proposalId };
}

/** `REJECT_MCP_STAGING`: discards a staged MCP batch (GM-only). */
export function rejectMcpStaging(proposalId: Uuid): WireTrameCommand {
  return { cmd: "REJECT_MCP_STAGING", proposal_id: proposalId };
}

/** `UNDO_LAST_ACTION`: GM-only; closes prompts with `UNDONE` and re-opens restored ones. */
export function undoLastAction(): WireTrameCommand {
  return { cmd: "UNDO_LAST_ACTION" };
}

/** `DECIDE_REACTION`: spends (`TRIGGER`) or declines (`PASS`) a reaction. */
export function decideReaction(promptId: Uuid, actorId: Uuid, trigger: boolean): WireTrameCommand {
  return {
    cmd: "DECIDE_REACTION",
    prompt_id: promptId,
    actor_id: actorId,
    decision: trigger ? { decision: "TRIGGER", ability_id: null } : { decision: "PASS" },
  };
}

/** `RESOLVE_REACTION`: GM closes a triggered prompt after resolving its effect. */
export function resolveReaction(promptId: Uuid): WireTrameCommand {
  return { cmd: "RESOLVE_REACTION", prompt_id: promptId };
}
