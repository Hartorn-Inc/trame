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
 * 3. `Sheet Rolls Use REST`:
 *    - `restDiceRollService` rolls via `POST .../dice/roll`, so rest and
 *      level-up rolls work without an open table socket; the server still fans
 *      them out to the live dice log.
 * 4. `Widget Edits Are Whole-Sheet Saves`:
 *    - `createSheetCommandDispatcher` turns a widget's `UPDATE_ACTOR_SHEET
 *      { path, value }` into a full-sheet PUT built from the stored sheet, so
 *      the same version check guards inline edits and modal results.
 * ============================================================================
 */
import { ApiError, VERSION_CONFLICT, type ApiClient, type CampaignActor } from "../api/client.ts";
import type { Uuid, WireRollVisibility } from "../api/wire.ts";
import type { DiceRollResult, DiceRollService } from "../components/modals/LevelUpModal.tsx";

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

/** Saves a full sheet with `{ expected_version, data }` (see invariants 1 and 2). */
export async function saveActorSheet(
  client: ApiClient,
  campaignId: Uuid,
  actorId: Uuid,
  data: unknown,
  options: SaveSheetOptions = {},
): Promise<SaveSheetOutcome> {
  const expectedVersion = options.expectedVersion ?? client.state.actors.value[actorId]?.version ?? 0;
  try {
    const actor = await client.updateActor(campaignId, actorId, { expectedVersion, name: options.name, data });
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

/**
 * Routes the sheet widgets' virtual commands to REST: `ROLL_DICE` becomes a
 * REST roll and `UPDATE_ACTOR_SHEET { path, value }` a versioned sheet save.
 * Other widget commands (AoE templates, compendium drops) need the table and
 * are ignored here.
 */
export function createSheetCommandDispatcher(options: SheetDispatcherOptions): (command: unknown) => void {
  const { client, campaignId, actorId } = options;
  const fail = (err: unknown) => options.onError?.(err instanceof Error ? err.message : String(err));
  return (command) => {
    const cmd = (command ?? {}) as Record<string, unknown>;
    if (cmd.cmd === 'ROLL_DICE') {
      const expression = String(cmd.expression ?? cmd.formula ?? '');
      if (!expression) return;
      client
        .rollDiceRest(campaignId, expression, {
          visibility: toRollVisibility(cmd.visibility),
          reason: typeof cmd.reason === 'string' ? cmd.reason : undefined,
        })
        .catch(fail);
      return;
    }
    if (cmd.cmd === 'UPDATE_ACTOR_SHEET' && typeof cmd.path === 'string' && 'value' in cmd) {
      const current = client.state.actors.value[actorId]?.data ?? {};
      saveActorSheet(client, campaignId, actorId, setAtPath(current, cmd.path, cmd.value))
        .then((outcome) => {
          if (outcome.status === 'conflict') options.onConflict?.(outcome.currentVersion);
        })
        .catch(fail);
    }
  };
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
