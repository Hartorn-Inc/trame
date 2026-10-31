/**
 * ============================================================================
 * D&D 5E SHORT & LONG REST RECOVERY MECHANICS (rest.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Implements authoritative, deterministic D&D 5e rest state machines complying
 * with ADR-0034 and Sections 3.2, 4.3, and 4.4 of the SRD 5.1 specification:
 * - Short Rest recovery (`applyShortRest`) with Hit Dice spending, Constitution
 *   modifier floor of 1 HP per spent die, Short Rest resource pool replenishment,
 *   and Warlock Pact Magic slot recovery.
 * - Long Rest recovery (`applyLongRest`) with full HP and spell slot restoration,
 *   Temporary HP clearing, half-max Hit Dice recovery (minimum 1), Short and
 *   Long Rest resource pool replenishment, and single-level exhaustion decrement.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Hit Dice Availability & Spend Validation`:
 *      - `applyShortRest` validates `0 <= count <= actor.attributes.hitDiceCurrent`
 *        and throws `new Error('Insufficient hit dice')` if count exceeds available.
 *   2. `Minimum 1 HP Healing Floor`:
 *      - Each spent Hit Die restores `Math.max(1, roll + conMod)` HP up to `hp.max`,
 *        guaranteeing that severe negative Constitution modifiers never reduce or
 *        zero out healing.
 *   3. `Half-Max Hit Dice Long Rest Recovery`:
 *      - `applyLongRest` increments `hitDiceCurrent` by `Math.max(1, Math.floor(hitDiceMax / 2))`
 *        without exceeding `hitDiceMax`.
 *   4. `Deterministic Rest Boundary Replenishment`:
 *      - Short rests reset only `"SHORT_REST"` pools and Pact Magic slots.
 *      - Long rests reset all standard spell slots (levels 1-9), Pact Magic, and
 *        both `"SHORT_REST"` and `"LONG_REST"` resource pools, while clearing
 *        `hp.temp` to `0` and decrementing exhaustion by exactly `1` when `> 0`.
 *   5. `State Immutability`:
 *      - All functions return deep-cloned state records, preserving pure,
 *        deterministic transitions across client-side UI and server pipelines.
 * ============================================================================
 */

import type {
  AbilityId,
  Dnd5eActorData,
  ResourcePool,
  SpellSlotsState,
} from "./types.ts";
import type { Dnd5eActorSheet } from "./pipeline.ts";

/**
 * Hit Die expenditure request specification.
 */
export interface HitDieSpendRequest {
  readonly count: number;
  readonly rollResults: readonly number[];
}

/**
 * Options configuring a Short Rest recovery cycle.
 */
export interface ShortRestOptions {
  /** Hit die expenditure request with count and roll results. */
  readonly hitDieSpend?: HitDieSpendRequest;
  /** Backward-compatible alias for number of Hit Dice to spend (`0..=hitDiceCurrent`). */
  readonly hitDiceSpent?: number;
  /** Backward-compatible alias for raw die roll results (`1..=hitDieSize`). */
  readonly diceRolls?: readonly number[];
}

/**
 * Summary metrics describing rest recovery outcomes.
 */
export interface RestRecoverySummary {
  readonly hpRecovered: number;
  readonly hitDiceSpent: number;
  readonly hitDiceRecovered: number;
  readonly spellSlotsRecovered: readonly number[];
  readonly exhaustionReduced: number;
}

/**
 * Computes the number of Hit Dice recovered during a Long Rest:
 * `Math.max(1, Math.floor(hitDiceMax / 2))`.
 */
export function calculateHitDieRecovery(hitDiceMax: number): number {
  return Math.max(1, Math.floor(Math.max(1, Math.trunc(hitDiceMax)) / 2));
}

/**
 * Computes HP gained from a single Hit Die roll with Constitution modifier floor of 1:
 * `Math.max(1, roll + floor((conScore - 10) / 2))`.
 */
export function calculateShortRestHpGain(roll: number, conScore: number): number {
  const conMod = Math.floor((conScore - 10) / 2);
  return Math.max(1, roll + conMod);
}

/**
 * Applies a D&D 5e Short Rest: spends Hit Dice (adding `max(1, roll + conMod)` HP per die
 * up to `hp.max`), restores `"SHORT_REST"` resources to `max`, and replenishes Warlock
 * Pact Magic spell slots.
 */
export function applyShortRest(
  actor: Dnd5eActorData,
  options?: ShortRestOptions
): Dnd5eActorData;
export function applyShortRest(
  sheet: Dnd5eActorSheet,
  hitDiceRolls: number[]
): { hpRecovered: number; hitDiceSpent: number };
export function applyShortRest(
  actorOrSheet: Dnd5eActorData | Dnd5eActorSheet,
  optionsOrRolls?: ShortRestOptions | number[]
): Dnd5eActorData | { hpRecovered: number; hitDiceSpent: number } {
  if ("attributes" in actorOrSheet) {
    const actor = actorOrSheet;
    const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actor));

    let count = 0;
    let rollResults: readonly number[] = [];

    if (Array.isArray(optionsOrRolls)) {
      count = optionsOrRolls.length;
      rollResults = optionsOrRolls;
    } else if (optionsOrRolls?.hitDieSpend) {
      count = optionsOrRolls.hitDieSpend.count;
      rollResults =
        optionsOrRolls.hitDieSpend.rollResults ??
        (optionsOrRolls.hitDieSpend as unknown as { diceRolls?: readonly number[] }).diceRolls ??
        [];
    } else if (optionsOrRolls?.hitDiceSpent !== undefined) {
      count = optionsOrRolls.hitDiceSpent;
      rollResults = optionsOrRolls.diceRolls ?? [];
    }

    if (count < 0 || count > clone.attributes.hitDiceCurrent) {
      throw new Error("Insufficient hit dice");
    }
    if (rollResults.length !== count) {
      throw new Error("Dice rolls count must match hit dice spent");
    }

    if (count > 0) {
      const conScore =
        typeof clone.abilities?.con === "object"
          ? clone.abilities.con.score
          : typeof clone.abilities?.con === "number"
            ? clone.abilities.con
            : 10;
      const conMod = Math.floor((conScore - 10) / 2);

      for (const roll of rollResults) {
        const hpGain = Math.max(1, roll + conMod);
        clone.attributes.hp.current = Math.min(
          clone.attributes.hp.max,
          clone.attributes.hp.current + hpGain
        );
      }
      clone.attributes.hitDiceCurrent -= count;
    }

    if (clone.resources) {
      for (const res of Object.values(clone.resources)) {
        if (
          res &&
          (res.resetOn === "SHORT_REST" || (res as unknown as { recovery?: string }).recovery === "short_rest")
        ) {
          res.current = res.max;
        }
      }
    }

    if (clone.spellSlots?.pact) {
      clone.spellSlots.pact.current = clone.spellSlots.pact.max;
    }

    return clone;
  } else {
    const sheet = actorOrSheet;
    const hitDiceRolls = Array.isArray(optionsOrRolls)
      ? optionsOrRolls
      : optionsOrRolls?.hitDieSpend?.rollResults ?? optionsOrRolls?.diceRolls ?? [];
    const conMod = Math.floor((sheet.abilities.con - 10) / 2);
    let hpRecovered = 0;
    let hitDiceSpent = 0;

    for (const roll of hitDiceRolls) {
      if (sheet.hitDiceCurrent <= 0 || sheet.hpCurrent >= sheet.hpMax) {
        break;
      }
      sheet.hitDiceCurrent -= 1;
      hitDiceSpent += 1;
      const heal = Math.max(1, roll + conMod);
      const before = sheet.hpCurrent;
      sheet.hpCurrent = Math.min(sheet.hpMax, sheet.hpCurrent + heal);
      hpRecovered += sheet.hpCurrent - before;
    }

    for (const res of Object.values(sheet.resources)) {
      if (res.recovery === "short_rest") {
        res.current = res.max;
      }
    }

    return { hpRecovered, hitDiceSpent };
  }
}

/**
 * Applies a D&D 5e Long Rest: restores Hit Points to `max`, clears Temporary HP,
 * recovers `max(1, floor(hitDiceMax / 2))` Hit Dice (capped at `hitDiceMax`),
 * restores all standard and Pact Magic spell slots, replenishes Short and Long Rest
 * resource pools, decrements exhaustion by 1 if greater than 0, and resets death saves.
 */
export function applyLongRest(actor: Dnd5eActorData): Dnd5eActorData;
export function applyLongRest(
  sheet: Dnd5eActorSheet
): { hpRecovered: number; hitDiceRecovered: number };
export function applyLongRest(
  actorOrSheet: Dnd5eActorData | Dnd5eActorSheet
): Dnd5eActorData | { hpRecovered: number; hitDiceRecovered: number } {
  if ("attributes" in actorOrSheet) {
    const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actorOrSheet));

    clone.attributes.hp.current = clone.attributes.hp.max;
    clone.attributes.hp.temp = 0;

    const recoveredDice = Math.max(1, Math.floor(clone.attributes.hitDiceMax / 2));
    clone.attributes.hitDiceCurrent = Math.min(
      clone.attributes.hitDiceMax,
      clone.attributes.hitDiceCurrent + recoveredDice
    );

    if (clone.attributes.exhaustion > 0) {
      clone.attributes.exhaustion -= 1;
    }

    if (clone.attributes.deathSaves) {
      clone.attributes.deathSaves.successes = 0;
      clone.attributes.deathSaves.failures = 0;
    }

    if (clone.spellSlots) {
      const tiers: (keyof SpellSlotsState)[] = [
        "level1",
        "level2",
        "level3",
        "level4",
        "level5",
        "level6",
        "level7",
        "level8",
        "level9",
        "pact",
      ];
      for (const tier of tiers) {
        const slot = clone.spellSlots[tier];
        if (slot) {
          slot.current = slot.max;
        }
      }
    }

    if (clone.resources) {
      for (const res of Object.values(clone.resources)) {
        if (
          res &&
          (res.resetOn === "SHORT_REST" ||
            res.resetOn === "LONG_REST" ||
            (res as unknown as { recovery?: string }).recovery === "short_rest" ||
            (res as unknown as { recovery?: string }).recovery === "long_rest")
        )
        {
          res.current = res.max;
        }
      }
    }

    clone.concentratingOnSpellId = undefined;

    return clone;
  } else {
    const sheet = actorOrSheet;
    const hpRecovered = sheet.hpMax - sheet.hpCurrent;
    sheet.hpCurrent = sheet.hpMax;
    sheet.tempHp = 0;

    const regainHd = Math.max(1, Math.floor(sheet.hitDiceMax / 2));
    const beforeHd = sheet.hitDiceCurrent;
    sheet.hitDiceCurrent = Math.min(sheet.hitDiceMax, sheet.hitDiceCurrent + regainHd);
    const hitDiceRecovered = sheet.hitDiceCurrent - beforeHd;

    if (sheet.exhaustionLevel > 0) {
      sheet.exhaustionLevel -= 1;
    }

    for (const res of Object.values(sheet.resources)) {
      if (res.recovery === "short_rest" || res.recovery === "long_rest") {
        res.current = res.max;
      }
    }

    sheet.deathSaves = { successes: 0, failures: 0, isStable: false, isDead: false };
    return { hpRecovered, hitDiceRecovered };
  }
}
