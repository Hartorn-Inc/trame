/**
 * ============================================================================
 * SEMI-AUTOMATED ATTACK & SAVING THROW RESOLUTION RULES (resolution.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Pure SRD 5.2.1 rules behind decision D6 (semi-automated resolution): the
 * d20 expression for a roll mode, cover on AC and Dexterity saving throws,
 * hit / miss / critical hit from the kept d20, critical damage dice and
 * save-for-half damage. The web resolution card rolls on the server and asks
 * these functions what the numbers mean; nothing here touches the table, so
 * a wrong rule is a unit-test failure, not a silent HP change.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Cover Is Explicit`:
 *      - Half cover is `+2` and Three-Quarters cover `+5` to AC and to
 *        Dexterity saving throws; other saves ignore cover. Total cover means
 *        the target cannot be targeted (`"blocked"`): an attack never rolls
 *        and an area effect does not reach it.
 *   2. `Natural 1 And Critical Range Win`:
 *      - A natural 1 always misses. A natural roll at or above
 *        `criticalRange` (20, Champion 19 / 18) is a critical hit whatever
 *        the AC. `autoCritical` (Paralyzed or Unconscious target within 5 ft)
 *        turns any other hit into a critical hit.
 *   3. `Critical Hits Double Dice Only`:
 *      - Every `NdS` term becomes `2NdS`; the flat modifier is added once.
 *   4. `Hidden AC Stays Hidden`:
 *      - Players do not receive a monster's AC. With `targetAc: null` the
 *        outcome is `"unknown"` (unless natural 1 or critical) and the roller
 *        picks hit or miss as the Game Master rules; the AC is never guessed.
 *   5. `Saves`:
 *      - An automatically failed save (`autoFail`) fails without a roll. A
 *        total at or above the DC succeeds. A success takes half damage
 *        (rounded down) when the spell says so, otherwise none.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   Attack: `d20Expression(mode, bonus)` -> server roll -> `resolveAttackOutcome`
 *           -> `damageExpression(dice, modifier, critical)` -> server roll -> Apply.
 *   Save:   `saveBonusWithCover` -> `d20Expression` -> server roll ->
 *           `resolveSaveOutcome` -> `damageAfterSave(raw, outcome, halfOnSave)` -> Apply.
 * ============================================================================
 */

import type { AttackSource, RollMode } from "./conditions.ts";
import type { AbilityId, DerivedAttack } from "./types.ts";

/** Cover between an attacker (or area origin) and a target (SRD 5.2.1, engine `CoverLevel`). */
export type CoverLevel = "NONE" | "HALF" | "THREE_QUARTERS" | "TOTAL";

/** Bonus to AC and Dexterity saving throws per cover level; `null` = cannot be targeted. */
export const COVER_BONUS: Readonly<Record<CoverLevel, number | null>> = { NONE: 0, HALF: 2, THREE_QUARTERS: 5, TOTAL: null };

/** Result of one attack roll against one target. */
export type AttackOutcome =
  /** Critical hit: damage dice are doubled. */
  | "critical"
  | "hit"
  | "miss"
  /** The roller cannot see the target's AC (invariant 4). */
  | "unknown"
  /** Total cover: the target cannot be attacked. */
  | "blocked";

/** Result of one saving throw against an effect. */
export type SaveOutcome =
  | "success"
  | "failure"
  /** The roller does not know the target's save bonus; the roller sets the result. */
  | "unknown"
  /** Total cover from the area's origin: the effect does not reach the target. */
  | "blocked";

function signed(n: number): string {
  return n === 0 ? "" : n > 0 ? `+${n}` : `${n}`;
}

/** Server dice expression of a d20 test: `1d20+5`, `2d20kh1+5` (advantage), `2d20kl1+5` (disadvantage). */
export function d20Expression(mode: RollMode, bonus: number): string {
  const dice = mode === "advantage" ? "2d20kh1" : mode === "disadvantage" ? "2d20kl1" : "1d20";
  return `${dice}${signed(Math.trunc(bonus))}`;
}

/** `dice` with every `NdS` term's count doubled (`1d8+1d6` -> `2d8+2d6`, invariant 3). */
export function doubleDamageDice(dice: string): string {
  return dice.replace(/(\d*)d(\d+)/g, (_, count: string, sides: string) => `${2 * Number(count || 1)}d${sides}`);
}

/** Damage expression: dice (doubled on a critical hit) plus the flat modifier once. */
export function damageExpression(dice: string, modifier: number, critical: boolean): string {
  const base = (critical ? doubleDamageDice(dice) : dice).replace(/\s+/g, "");
  return `${base}${signed(Math.trunc(modifier))}`;
}

/** Inputs of `resolveAttackOutcome`. */
export interface AttackOutcomeInput {
  /** Kept natural d20 (`1..=20`). */
  natural: number;
  /** Attack roll total (natural + bonus). */
  total: number;
  /** Target AC, `null` when hidden from the roller. */
  targetAc: number | null;
  /** Cover the user accepted for this target. */
  cover: CoverLevel;
  /** Natural roll from which the attack crits (`20` when absent). */
  criticalRange?: number;
  /** A hit is a critical hit (condition rule `auto_crit_within_5ft`). */
  autoCritical?: boolean;
}

/** Hit, miss or critical hit of one attack roll (invariants 1, 2 and 4). */
export function resolveAttackOutcome(input: AttackOutcomeInput): AttackOutcome {
  const coverBonus = COVER_BONUS[input.cover];
  if (coverBonus === null) return "blocked";
  if (input.natural <= 1) return "miss";
  if (input.natural >= (input.criticalRange ?? 20)) return "critical";
  if (input.targetAc === null) return "unknown";
  if (input.total < input.targetAc + coverBonus) return "miss";
  return input.autoCritical ? "critical" : "hit";
}

/** Saving throw bonus with cover: only Dexterity saves gain it (invariant 1); `null` under total cover. */
export function saveBonusWithCover(bonus: number, ability: AbilityId, cover: CoverLevel): number | null {
  const coverBonus = COVER_BONUS[cover];
  if (coverBonus === null) return null;
  return ability === "dex" ? bonus + coverBonus : bonus;
}

/** Inputs of `resolveSaveOutcome`. */
export interface SaveOutcomeInput {
  /** Saving throw total, `null` when the save bonus is unknown to the roller. */
  total: number | null;
  /** Save DC of the effect. */
  dc: number;
  /** The save fails without a roll (Paralyzed, Stunned... on STR / DEX). */
  autoFail: boolean;
  /** Cover between the area's origin (or caster) and the target. */
  cover: CoverLevel;
}

/** Success or failure of one saving throw (invariants 1 and 5). */
export function resolveSaveOutcome(input: SaveOutcomeInput): SaveOutcome {
  if (input.cover === "TOTAL") return "blocked";
  if (input.autoFail) return "failure";
  if (input.total === null) return "unknown";
  return input.total >= input.dc ? "success" : "failure";
}

/** Damage taken after a saving throw: full on failure, half (rounded down) or none on success. */
export function damageAfterSave(rawDamage: number, outcome: SaveOutcome, halfDamageOnSave: boolean): number {
  const raw = Math.max(0, Math.trunc(rawDamage));
  if (outcome === "blocked") return 0;
  if (outcome === "success") return halfDamageOnSave ? Math.floor(raw / 2) : 0;
  return raw;
}

/** Feature rule source of a derived attack: Strength or Dexterity weapon, or spell. */
export function attackSourceOf(attack: Pick<DerivedAttack, "source" | "ability">): AttackSource {
  if (attack.source === "spell") return "spell";
  return attack.ability === "dex" ? "weapon_dex" : "weapon_str";
}
