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
 * 4. `Typed Damage, Server Affinity`:
 *    - `applyDamage` sends a lowercase SRD `damage_type`; the engine derives
 *      the target's resistance, vulnerability or immunity from it, and the
 *      room refuses a manual affinity from players.
 * 5. `Server-Rolled Death Saving Throws`:
 *    - `recordDeathSave` sends `d20: null` unless the GM typed a physical die
 *      result; the room rolls the d20 for players whatever they send.
 * ============================================================================
 */
import type { Uuid, WirePoint2D, WireTrameCommand, WireWallSegment } from "../api/wire.ts";
import type { AoeTemplateDto, GridCell } from "../engine/wasmBridge.ts";

/** Target affinity toward the damage type (`DamageAffinity`). */
export type DamageAffinity = "NORMAL" | "RESISTANT" | "VULNERABLE" | "IMMUNE";

/** SRD 5.2.1 damage types, lowercase as the engine matches them against `damage_*` lists. */
export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;

/** One SRD damage type (`DAMAGE_TYPES`). */
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** Options of `applyDamage`. */
export interface DamageOptions {
  /** Typed damage; `null` (default) sends untyped damage resolved with `affinity`. */
  damageType?: DamageType | null;
  /** Critical hit: at 0 HP it adds two death saving throw failures instead of one. */
  critical?: boolean;
  /** Manual affinity (GM only; ignored by the engine when `damageType` is set). */
  affinity?: DamageAffinity;
}

/** What a `CONDITION_OVERRIDE` rules on (`OverrideSubject`). */
export type ConditionOverrideSubject = "CONDITION" | "EFFECT";

/** `FORCE` applies, `REMOVE` suppresses, `null` clears the ruling (`OverrideMode`). */
export type ConditionOverrideMode = "FORCE" | "REMOVE" | null;

/** Manual fog ruling on one cell (`FogOverrideMode`). */
export type FogOverrideMode = "REVEAL" | "HIDE" | "CLEAR";

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

/**
 * `APPLY_DAMAGE`: raw damage before mitigation; the engine resolves the type's affinity, temp
 * HP, concentration and, at 0 HP, death saving throw failures (two on a critical hit).
 */
export function applyDamage(tokenId: Uuid, rawDamage: number, options: DamageOptions = {}): WireTrameCommand {
  return {
    cmd: "APPLY_DAMAGE",
    token_id: tokenId,
    raw_damage: nonNegativeInt(rawDamage),
    affinity: options.affinity ?? "NORMAL",
    is_critical: options.critical ?? false,
    damage_type: options.damageType ?? null,
  };
}

/**
 * `PROJECT_AOE`: the engine evaluates the wall-clipped template and answers
 * `AOE_PROJECTED` with the affected tokens; `persistZone` keeps it on the map
 * (bound to `concentration_caster_id`'s concentration when set).
 */
export function projectAoe(template: AoeTemplateDto, persistZone: boolean): WireTrameCommand {
  return {
    cmd: "PROJECT_AOE",
    template: { ...template, concentration_caster_id: template.concentration_caster_id ?? null },
    persist_zone: persistZone,
  };
}

/** `TOGGLE_DOOR`: opens or closes a door (players: unlocked doors; GM: any door). */
export function toggleDoor(wallId: Uuid, isOpen: boolean): WireTrameCommand {
  return { cmd: "TOGGLE_DOOR", wall_id: wallId, is_open: isOpen };
}

/** `REMOVE_TOKEN`: GM-only; also drops the token from the initiative order. */
export function removeToken(tokenId: Uuid): WireTrameCommand {
  return { cmd: "REMOVE_TOKEN", token_id: tokenId };
}

/** `SET_TOKEN_VISIBILITY`: GM-only; `gmHidden` hides the token from every player. */
export function setTokenVisibility(tokenId: Uuid, gmHidden: boolean, invisible: boolean): WireTrameCommand {
  return { cmd: "SET_TOKEN_VISIBILITY", token_id: tokenId, gm_hidden: gmHidden, invisible };
}

/** `GM_OVERRIDE_TOKEN_RESOURCES` with only the remaining speed (`ft`, `>= 0`) set. */
export function overrideRemainingSpeed(tokenId: Uuid, speedFt: number): WireTrameCommand {
  return {
    cmd: "GM_OVERRIDE_TOKEN_RESOURCES",
    token_id: tokenId,
    hp: null,
    temp_hp: null,
    speed_remaining_ft: Number.isFinite(speedFt) ? Math.max(0, speedFt) : 0,
    has_action: null,
    has_bonus_action: null,
    has_reaction: null,
  };
}

/** `SET_DISENGAGED`: Disengage for this turn (GM: any token; players: owned tokens). */
export function setDisengaged(tokenId: Uuid, disengaged: boolean): WireTrameCommand {
  return { cmd: "SET_DISENGAGED", token_id: tokenId, disengaged };
}

/** `SET_TOKEN_CONDITIONS`: replaces the token's condition ids (GM: any token; players: owned). */
export function setTokenConditions(tokenId: Uuid, conditions: string[]): WireTrameCommand {
  return { cmd: "SET_TOKEN_CONDITIONS", token_id: tokenId, conditions };
}

/** `CONDITION_OVERRIDE`: GM ruling forcing, removing or clearing (`null`) a condition or effect. */
export function conditionOverride(tokenId: Uuid, subject: ConditionOverrideSubject, id: string, mode: ConditionOverrideMode): WireTrameCommand {
  return { cmd: "CONDITION_OVERRIDE", token_id: tokenId, subject, id, mode };
}

/** `SET_CONCENTRATION`: starts or ends concentration without a zone (GM: any; players: owned). */
export function setConcentration(tokenId: Uuid, concentrating: boolean): WireTrameCommand {
  return { cmd: "SET_CONCENTRATION", token_id: tokenId, concentrating };
}

/** `RECORD_DEATH_SAVE`: `d20` is a GM's physical die (`1..=20`), else `null` for a server roll. */
export function recordDeathSave(tokenId: Uuid, d20: number | null = null): WireTrameCommand {
  return { cmd: "RECORD_DEATH_SAVE", token_id: tokenId, d20 };
}

/** `SET_FOG_OVERRIDE`: GM-only manual fog ruling on one grid cell. */
export function setFogOverride(mode: FogOverrideMode, cell: GridCell): WireTrameCommand {
  return { cmd: "SET_FOG_OVERRIDE", mode, cell_x: cell.col, cell_y: cell.row };
}

/** `SET_DIFFICULT_TERRAIN`: GM-only; paints (`difficult`) or erases a non-empty set of cells. */
export function setDifficultTerrain(cells: GridCell[], difficult: boolean): WireTrameCommand {
  return { cmd: "SET_DIFFICULT_TERRAIN", cells, difficult };
}

/** `ADD_WALL`: GM-only; adds a wall segment to the live map. */
export function addWall(wall: WireWallSegment): WireTrameCommand {
  return { cmd: "ADD_WALL", wall };
}

/** `HEAL_ACTOR`: restores hit points up to the token's maximum. */
export function healActor(tokenId: Uuid, amount: number): WireTrameCommand {
  return { cmd: "HEAL_ACTOR", token_id: tokenId, amount: nonNegativeInt(amount) };
}

/** `ACTIVATE_SCENE`: GM-only; the server resolves the stored scene (invariant 2). */
export function activateScene(sceneId: Uuid): WireTrameCommand {
  return { cmd: "ACTIVATE_SCENE", scene_id: sceneId };
}

/** Ambient lighting preset (`AmbientLightingPreset`). */
export type AmbientLightingPreset = "DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS";

/** Every `AmbientLightingPreset`, brightest first. */
export const AMBIENT_LIGHTING_PRESETS: readonly AmbientLightingPreset[] = ["DAYLIGHT", "DUSK", "NIGHT_MOONLIGHT", "PITCH_DARKNESS"];

/** `SET_AMBIENT_LIGHTING`: GM-only global lighting preset. */
export function setAmbientLighting(preset: AmbientLightingPreset): WireTrameCommand {
  return { cmd: "SET_AMBIENT_LIGHTING", preset };
}

/** Linked-actor fields copied onto a new token (`SpawnTokenInput`). */
export interface SpawnTokenInput {
  /** New token UUID. */
  tokenId: Uuid;
  /** Persistent actor sheet linked to the token (ADR-0037), when any. */
  actorId: Uuid | null;
  name: string;
  /** Controlling player, `null` for GM-controlled NPCs. */
  ownerUserId: Uuid | null;
  /** Top-left canvas coordinate in pixels (`px`). */
  topLeft: WirePoint2D;
  hp: number;
  maxHp: number;
  ac: number;
  dexMod: number;
  /** Walking speed in feet (`ft`). */
  speedFt: number;
}

/**
 * `SPAWN_TOKEN`: GM-only. Sends a complete `TokenState` (the engine has no
 * defaults for most fields): a 1x1 Medium token on the material channel with
 * plain sight and no darkvision, full action economy, and no effects. The
 * server replaces the senses of sheet-linked and stat-block tokens with the
 * species or stat-block values, so no sense is assumed here.
 */
export function spawnToken(input: SpawnTokenInput): WireTrameCommand {
  const maxHp = Math.max(1, Math.trunc(input.maxHp));
  return {
    cmd: "SPAWN_TOKEN",
    token: {
      id: input.tokenId,
      name: input.name,
      owner_user_id: input.ownerUserId,
      actor_id: input.actorId,
      top_left: input.topLeft,
      grid_w: 1,
      grid_h: 1,
      is_squeezing: false,
      elevation_ft: 0,
      height_ft: 5,
      visibility_channel: 1,
      invisible: false,
      senses: {
        normal_range_ft: 120,
        darkvision_range_ft: 0,
        blindsight_range_ft: 0,
        tremorsense_range_ft: 0,
        truesight_range_ft: 0,
        devils_sight: false,
        see_invisibility: false,
        perceives_channels: 1,
      },
      hp: Math.min(maxHp, nonNegativeInt(input.hp)),
      max_hp: maxHp,
      temp_hp: 0,
      ac: Math.trunc(input.ac),
      dex_mod: Math.trunc(input.dexMod),
      speed_max_ft: input.speedFt,
      speed_remaining_ft: input.speedFt,
      has_action: true,
      has_bonus_action: true,
      has_reaction: true,
      concentrating_on_aoe_id: null,
      active_effects: [],
      conditions: [],
    },
  };
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
