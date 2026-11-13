/**
 * ============================================================================
 * VERSIONED ACTOR SHEET PERSISTENCE & REST DICE (sheet/sheetPersistence.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Single write path for character sheets, shared by the workspace Actors tab
 * and the live-table HUD drawer. Sheets are persistent documents (ADR-0037):
 * they are saved over REST with optimistic concurrency, never through a table
 * command, so a level-up made in one tab cannot silently erase a rest taken in
 * another.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Expected Version From The Store`:
 *    - `expected_version` is the version the client last read into
 *      `SessionState.actors` (REST load or `ActorUpdated`). A sheet never seen
 *      sends `0`, which the server always treats as stale.
 * 2. `Conflict Is A Result, Not A Crash`:
 *    - `409 VERSION_CONFLICT` returns `{ status: "conflict" }` with the
 *      server's `current_version`; the caller decides between reloading the
 *      latest sheet and overwriting it (retry with `current_version`).
 * 3. `Sheet Rolls Use REST, Initiative Uses The Room`:
 *    - `restDiceRollService` rolls via `POST .../dice/roll`, so rest and
 *      level-up rolls work without an open table socket; the server still fans
 *      them out to the live dice log.
 *    - A `ROLL_DICE` whose reason starts with "initiative" (case-insensitive)
 *      goes to the room socket as `RollDice`: only the room actor rolls
 *      initiative (`1d20 + initiative bonus`, once per encounter) and counts
 *      it for the encounter. The REST endpoint would roll the client's own
 *      expression and never reach the initiative order. With the socket
 *      closed nothing is sent and `notConnected` feedback is pushed.
 * 4. `Widget Edits Are Whole-Sheet Saves`:
 *    - `createSheetCommandDispatcher` turns a widget's `UPDATE_ACTOR_SHEET
 *      { path, value }` into a full-sheet PUT built from the stored sheet, so
 *      the same version check guards inline edits and modal results.
 *    - A widget save that leaves the sheet at 0 Hit Points also switches off
 *      the toggles that end there (Rage, `activeFeatureIdsAfterHpChange`),
 *      as the server does for token damage.
 * 5. `Casts Spend On Cast And Refund On Unrolled Cancel`:
 *    - `CAST_SPELL` saves the spent slot immediately; when the cast opens
 *      `ActionResolutionCard` on the table (`table/actionResolution.ts`),
 *      cancelling or replacing that card before rolling or projecting chains
 *      a versioned refund save onto the spend request and reverts any newly
 *      started concentration to the caster token's prior state. Once rolled
 *      or projected (`commitAction`), closing the card keeps both.
 * 6. `Derived Is Recomputed On Every Write`:
 *    - `saveActorSheet` refreshes a D&D 5e sheet's `derived` snapshot
 *      (`withRecomputedDerived`) before the PUT. The server reads the token's
 *      speed, AC, saves and Rage resistances from it, so an exhaustion step,
 *      a rest or a feature toggle saved without it left the token stale.
 * ============================================================================
 */
import {
  CompendiumResolver,
  activeFeatureIdsAfterHpChange,
  spellDamageResolution,
  withRecomputedDerived,
  type Dnd5eActorData,
  type SpellDamageResolution,
} from "../../../game-systems/dnd5e/src/index.ts";
import { ApiError, VERSION_CONFLICT, type ApiClient, type CampaignActor } from "../api/client.ts";
import { describeActionError } from "../api/errorMessages.ts";
import type { Uuid, WireRollVisibility } from "../api/wire.ts";
import type { DiceRollResult, DiceRollService } from "../components/modals/LevelUpModal.tsx";
import { casterTokenId, startAction, type PendingAction } from "../table/actionResolution.ts";
import { setConcentration } from "../table/commands.ts";
import type { SpentSlot } from "./types.ts";

/** Outcome of `saveActorSheet`. */
export type SaveSheetOutcome =
  /** Stored; `actor.version` is the new version. */
  | { status: "saved"; actor: CampaignActor }
  /** Rejected as stale; `currentVersion` is the server's version, when reported. */
  | { status: "conflict"; currentVersion: number | null };

/** Options for `saveActorSheet`. */
export interface SaveSheetOptions {
  /** New display name, sent alongside the sheet. */
  name?: string;
  /** Overrides the stored version, e.g. `currentVersion` to overwrite after a conflict. */
  expectedVersion?: number;
}

/** Saves a full sheet with `{ expected_version, data }` and a fresh `derived` (see invariants 1, 2 and 6). */
export async function saveActorSheet(
  client: ApiClient,
  campaignId: Uuid,
  actorId: Uuid,
  data: unknown,
  options: SaveSheetOptions = {},
): Promise<SaveSheetOutcome> {
  const expectedVersion = options.expectedVersion ?? client.state.actors.value[actorId]?.version ?? 0;
  try {
    const actor = await client.updateActor(campaignId, actorId, { expectedVersion, name: options.name, data: withRecomputedDerived(data) });
    return { status: "saved", actor };
  } catch (err) {
    if (err instanceof ApiError && err.code === VERSION_CONFLICT) {
      const current = err.body.current_version;
      return { status: "conflict", currentVersion: typeof current === "number" ? current : null };
    }
    throw err;
  }
}

/** Maps the widget visibility labels (`PUBLIC`, `GM`, `BLIND`) to `RollVisibility`. */
function toRollVisibility(raw: unknown): WireRollVisibility | undefined {
  switch (String(raw ?? '').toUpperCase()) {
    case 'GM':
    case 'GMONLY':
    case 'GM_ONLY':
      return 'GmOnly';
    case 'BLIND':
    case 'BLINDGM':
    case 'BLIND_GM':
      return 'BlindGm';
    case 'PUBLIC':
      return 'Public';
    default:
      return undefined;
  }
}

/** Mirrors the room actor's initiative check: reason starts with "initiative", case-insensitive. */
function isInitiativeReason(reason: string): boolean {
  return reason.trimStart().toLowerCase().startsWith('initiative');
}

/** Returns a deep copy of `data` with `value` written at a dotted path (`attributes.hp.current`). */
export function setAtPath(data: unknown, path: string, value: unknown): unknown {
  const keys = path.replace(/^sheet\./, '').split('.').filter(Boolean);
  const root: Record<string, unknown> = structuredClone((data ?? {}) as Record<string, unknown>);
  let cursor = root;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      cursor[key] = value;
      return;
    }
    const next = cursor[key];
    cursor[key] = next !== null && typeof next === 'object' ? next : {};
    cursor = cursor[key] as Record<string, unknown>;
  });
  return root;
}

/** Wiring for `createSheetCommandDispatcher`. */
export interface SheetDispatcherOptions {
  client: ApiClient;
  campaignId: Uuid;
  actorId: Uuid;
  /** Called when a widget edit hits `VERSION_CONFLICT`. */
  onConflict?: (currentVersion: number | null) => void;
  /** Called when a roll or save fails for another reason. */
  onError?: (message: string) => void;
}

/** `data` with the class feature toggles that end at 0 Hit Points switched off (invariant 4). */
function withZeroHpTogglesEnded(data: unknown): unknown {
  const actor = data as Dnd5eActorData;
  if (!Array.isArray(actor?.activeFeatureIds) || (actor.attributes?.hp?.current ?? 1) > 0) return data;
  return { ...actor, activeFeatureIds: activeFeatureIdsAfterHpChange(actor) };
}

/**
 * Routes the sheet widgets' virtual commands:
 * - `ROLL_DICE` becomes a REST roll (initiative goes to the room).
 * - `UPDATE_ACTOR_SHEET { path, value }` or `{ changes: { path: value } }` is
 *   one versioned sheet save (several paths at once, so a toggle and the pool
 *   use it spends cannot race each other's version).
 * - `CAST_SPELL` saves the spent slot, starts concentration on the caster's
 *   token for a concentration spell when not already concentrating, and on the
 *   table opens the resolution card (area, attack or save spells) with a
 *   rollback that refunds the slot and reverts concentration if cancelled
 *   before rolling or projecting.
 * - `RESOLVE_ATTACK` opens the resolution card for a sheet attack.
 * Other widget commands (compendium drops, notices) are ignored here.
 */
export function createSheetCommandDispatcher(options: SheetDispatcherOptions): (command: unknown) => void {
  const { client, campaignId, actorId } = options;
  const fail = (err: unknown) => options.onError?.(describeActionError(err, String(err)));
  const save = (changes: Record<string, unknown>, fallbackBase?: unknown): Promise<SaveSheetOutcome | null> => {
    const stored = client.state.actors.value[actorId]?.data;
    const hasStoredKeys = stored !== null && typeof stored === 'object' && Object.keys(stored as object).length > 0;
    let next: unknown = hasStoredKeys ? stored : (fallbackBase ?? stored ?? {});
    for (const [path, value] of Object.entries(changes)) next = setAtPath(next, path, value);
    return saveActorSheet(client, campaignId, actorId, withZeroHpTogglesEnded(next))
      .then((outcome) => {
        if (outcome.status === 'conflict') options.onConflict?.(outcome.currentVersion);
        return outcome;
      })
      .catch((err) => {
        fail(err);
        return null;
      });
  };
  return (command) => {
    const cmd = (command ?? {}) as Record<string, unknown>;
    if (cmd.cmd === 'ROLL_DICE') {
      const expression = String(cmd.expression ?? cmd.formula ?? '');
      if (!expression) return;
      const reason = typeof cmd.reason === 'string' ? cmd.reason : undefined;
      const visibility = toRollVisibility(cmd.visibility);
      if (reason && isInitiativeReason(reason)) {
        client.rollDice(expression, visibility ?? 'Public', reason);
        return;
      }
      client.rollDiceRest(campaignId, expression, { visibility, reason }).catch(fail);
      return;
    }
    if (cmd.cmd === 'UPDATE_ACTOR_SHEET') {
      if (typeof cmd.path === 'string' && 'value' in cmd) void save({ [cmd.path]: cmd.value });
      else if (cmd.changes && typeof cmd.changes === 'object') void save(cmd.changes as Record<string, unknown>);
      return;
    }
    if (cmd.cmd === 'CAST_SPELL' && typeof cmd.spellId === 'string') {
      const slot = cmd.slot as SpentSlot | null;
      const preCastSheet = structuredClone(client.state.actors.value[actorId]?.data ?? {});
      const spendPromise = slot ? save({ [`spellSlots.${slot.key}`]: slot.tier }) : null;
      const refundSlot =
        slot && spendPromise
          ? () => {
              void spendPromise.then((outcome) => {
                if (outcome?.status !== 'saved') return;
                const latest = client.state.actors.value[actorId]?.data as Record<string, Record<string, unknown>> | undefined;
                const currentTier = latest?.spellSlots?.[slot.key] as SpentSlot['tier'] | undefined;
                const baseCurrent = typeof currentTier?.current === 'number' ? currentTier.current : slot.tier.current;
                const restored = { ...slot.tier, current: Math.min(slot.tier.max, baseCurrent + 1) };
                void save({ [`spellSlots.${slot.key}`]: restored }, preCastSheet);
              });
            }
          : null;
      castOnTable(client, actorId, cmd.spellId, cmd.onTable === true, slot?.castLevel, refundSlot);
      return;
    }
    if (cmd.cmd === 'RESOLVE_ATTACK' && typeof cmd.attackId === 'string') {
      startAction({ kind: 'attack', actorId, attackId: cmd.attackId });
    }
  };
}

/** Spell damage resolutions a cast opens on the table (`castOnTable`). */
const CAST_RESOLUTIONS: ReadonlySet<SpellDamageResolution | null> = new Set(['attack', 'save', 'automatic']);

/**
 * Table side of a cast: a concentration spell starts concentration on the
 * caster's token when not already concentrating (an area also binds its
 * persistent zone when projected); on the table an area spell opens area
 * placement and a damaging spell opens the attack / save / automatic
 * resolution, scaled to `castLevel` when upcast, with a rollback that restores
 * the spent slot and prior concentration if cancelled before rolling. A rider
 * (Hex) deals its damage on later weapon hits, from the attacks table, and a
 * described non-area spell (Teleport's mishap) is resolved by the table:
 * neither opens a resolution when cast.
 */
function castOnTable(
  client: ApiClient,
  actorId: Uuid,
  spellId: string,
  onTable: boolean,
  castLevel?: number,
  refundSlot?: (() => void) | null,
): void {
  const data = CompendiumResolver.getDefault().get(spellId)?.data;
  if (!data) return;
  const table = client.state.table.value;
  const caster = casterTokenId(table, actorId);
  const casterToken = caster ? (table?.tokens[caster] ?? table?.public_tokens?.[caster]) : undefined;
  const wasConcentrating = casterToken?.concentrating === true;
  const startedConcentration =
    data.concentration === true && caster !== null && !wasConcentrating && client.submitCommand(setConcentration(caster, true));
  if (!onTable) return;
  const action: PendingAction | null = data.area
    ? { kind: 'area', actorId, spellId, castLevel }
    : CAST_RESOLUTIONS.has(spellDamageResolution(data))
      ? { kind: 'attack', actorId, attackId: spellId, castLevel }
      : null;
  if (!action) return;
  startAction(action, () => {
    refundSlot?.();
    if (startedConcentration && caster !== null) client.submitCommand(setConcentration(caster, false));
  });
}

/** Adapts `ApiClient.rollDiceRest` to the modal `DiceRollService` (invariant 3). */
export function restDiceRollService(client: ApiClient, campaignId: Uuid): DiceRollService {
  return {
    async roll(formula, options = {}): Promise<DiceRollResult> {
      const roll = await client.rollDiceRest(campaignId, formula, { reason: options.reason });
      const terms = (roll.terms ?? []) as Array<{ kept_rolls?: number[] }>;
      return {
        total: roll.total ?? 0,
        rolls: terms.flatMap((term) => term.kept_rolls ?? []),
        formula: roll.expression ?? formula,
      };
    },
  };
}
