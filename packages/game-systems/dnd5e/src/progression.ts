/**
 * ============================================================================
 * D&D 5E LEVEL PROGRESSION, SPELL SLOT TABLES & CONDITION TIMERS (progression.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Governs character level advancement (`applyLevelUp`), canonical SRD 5.1 spell
 * slot progression tables across Full, Half, and Warlock Pact Magic casters,
 * and combat turn/round condition duration ticking (`decrementConditionDurations`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Level 20 Ceiling Guard`:
 *      - `applyLevelUp` rejects advancement when `actor.attributes.level >= 20`
 *        to enforce the SRD 5.1 level cap and guarantee valid table lookups in
 *        `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
 *   2. `Minimum +1 HP Per Level Floor`:
 *      - Both `"fixed"` (`floor(hitDieSize / 2) + 1 + conMod`) and `"roll"`
 *        (`rolledHp + conMod`) modes clamp HP gained per level to `>= 1` so a
 *        severe negative Constitution modifier can never reduce maximum HP on level-up.
 *   3. `Incremental Spell Slot Preservation`:
 *      - Advancing a caster increases `current` available slots only by the delta
 *        `max(0, newMax - existing.max)` so previously expended spell slots are
 *        not illicitly refunded mid-adventuring day upon leveling up.
 *   4. `Turn-Scoped Condition Expiry`:
 *      - `decrementConditionDurations` only decrements `"TURNS_START"` and
 *        `"TURNS_END"` conditions when `appliedTurnActorId === currentTurnActorId`,
 *        and automatically prunes conditions whose `durationRounds` drops to `<= 0`.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `applyLevelUp(actor, options)`
 *     ├── 1. Verify `actor.attributes.level < 20` and deep-clone `actor`.
 *     ├── 2. Increment `level`, `hitDiceMax`, and `hitDiceCurrent` by `1`.
 *     ├── 3. Compute `hpGain = max(1, baseGain + conMod)` and add to `hp.max` & `hp.current`.
 *     └── 4. Reconcile `spellSlots` against the target level's `casterType` progression row.
 * ============================================================================
 */

import type {
  ActiveConditionState,
  Dnd5eActorData,
  SpellSlotsState,
  TurnTrigger,
} from "./types.ts";

/**
 * Spellcasting progression archetype used to allocate spell slots upon level-up:
 * - `"full"`: 9-level progression (Bard, Cleric, Druid, Sorcerer, Wizard)
 * - `"half"`: 5-level progression starting at level 2 (Paladin, Ranger)
 * - `"pact"`: Warlock Pact Magic progression (uniform slot level, short-rest recovery)
 * - `"none"`: Non-spellcasting martial progression
 */
export type CasterType = "full" | "half" | "pact" | "none";

/**
 * Configuration options passed to `applyLevelUp`.
 */
export interface LevelUpOptions {
  /** Hit Point gain calculation mode: `"fixed"` takes average die (`d/2 + 1`), `"roll"` uses `rolledHp`. */
  hpIncreaseMode: "fixed" | "roll";
  /** Natural Hit Die roll (`1..=hitDieSize`) used when `hpIncreaseMode === "roll"`. */
  rolledHp?: number;
  /** Optional spellcaster progression table to apply for the new character level. */
  casterType?: CasterType;
}

/**
 * Computes the D&D 5e proficiency bonus (`+2` to `+6`) for a character level clamped to `[1, 20]`.
 */
export function calculateProficiencyBonus(level: number): number {
  return Math.floor((Math.max(1, Math.min(20, Math.trunc(level))) - 1) / 4) + 2;
}

/**
 * SRD 5.1 Full Caster spell slot table indexed by character level (`1..=20`),
 * mapping to a 9-element tuple of maximum slots for spell levels 1 through 9.
 */
export const FULL_CASTER_SPELL_SLOTS: Record<number, number[]> = {
  1: [2, 0, 0, 0, 0, 0, 0, 0, 0],
  2: [3, 0, 0, 0, 0, 0, 0, 0, 0],
  3: [4, 2, 0, 0, 0, 0, 0, 0, 0],
  4: [4, 3, 0, 0, 0, 0, 0, 0, 0],
  5: [4, 3, 2, 0, 0, 0, 0, 0, 0],
  6: [4, 3, 3, 0, 0, 0, 0, 0, 0],
  7: [4, 3, 3, 1, 0, 0, 0, 0, 0],
  8: [4, 3, 3, 2, 0, 0, 0, 0, 0],
  9: [4, 3, 3, 3, 1, 0, 0, 0, 0],
  10: [4, 3, 3, 3, 2, 0, 0, 0, 0],
  11: [4, 3, 3, 3, 2, 1, 0, 0, 0],
  12: [4, 3, 3, 3, 2, 1, 0, 0, 0],
  13: [4, 3, 3, 3, 2, 1, 1, 0, 0],
  14: [4, 3, 3, 3, 2, 1, 1, 0, 0],
  15: [4, 3, 3, 3, 2, 1, 1, 1, 0],
  16: [4, 3, 3, 3, 2, 1, 1, 1, 0],
  17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 3, 3, 3, 3, 2, 1, 1, 1],
  20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};

/**
 * SRD 5.1 Half Caster spell slot table indexed by character level (`1..=20`),
 * mapping to a 5-element tuple of maximum slots for spell levels 1 through 5.
 */
export const HALF_CASTER_SPELL_SLOTS: Record<number, number[]> = {
  1: [0, 0, 0, 0, 0],
  2: [2, 0, 0, 0, 0],
  3: [3, 0, 0, 0, 0],
  4: [3, 0, 0, 0, 0],
  5: [4, 2, 0, 0, 0],
  6: [4, 2, 0, 0, 0],
  7: [4, 3, 0, 0, 0],
  8: [4, 3, 0, 0, 0],
  9: [4, 3, 2, 0, 0],
  10: [4, 3, 2, 0, 0],
  11: [4, 3, 3, 0, 0],
  12: [4, 3, 3, 0, 0],
  13: [4, 3, 3, 1, 0],
  14: [4, 3, 3, 1, 0],
  15: [4, 3, 3, 2, 0],
  16: [4, 3, 3, 2, 0],
  17: [4, 3, 3, 3, 1],
  18: [4, 3, 3, 3, 1],
  19: [4, 3, 3, 3, 2],
  20: [4, 3, 3, 3, 2],
};

/**
 * Warlock Pact Magic slot quantity and spell level at a given character level.
 */
export interface PactMagicProgression {
  /** Total number of Pact Magic slots (`1..=4`). */
  slots: number;
  /** Spell level at which Pact Magic slots are cast (`1..=5`). */
  slotLevel: number;
}

/**
 * SRD 5.1 Warlock Pact Magic progression table indexed by character level (`1..=20`).
 */
export const PACT_MAGIC_SPELL_SLOTS: Record<number, PactMagicProgression> = {
  1: { slots: 1, slotLevel: 1 },
  2: { slots: 2, slotLevel: 1 },
  3: { slots: 2, slotLevel: 2 },
  4: { slots: 2, slotLevel: 2 },
  5: { slots: 2, slotLevel: 3 },
  6: { slots: 2, slotLevel: 3 },
  7: { slots: 2, slotLevel: 4 },
  8: { slots: 2, slotLevel: 4 },
  9: { slots: 2, slotLevel: 5 },
  10: { slots: 2, slotLevel: 5 },
  11: { slots: 3, slotLevel: 5 },
  12: { slots: 3, slotLevel: 5 },
  13: { slots: 3, slotLevel: 5 },
  14: { slots: 3, slotLevel: 5 },
  15: { slots: 3, slotLevel: 5 },
  16: { slots: 3, slotLevel: 5 },
  17: { slots: 4, slotLevel: 5 },
  18: { slots: 4, slotLevel: 5 },
  19: { slots: 4, slotLevel: 5 },
  20: { slots: 4, slotLevel: 5 },
};

/**
 * Advances `actor` by one character level (up to level 20), increasing Hit Dice,
 * maximum/current Hit Points, and spell slot capacities according to `options`.
 */
export function applyLevelUp(
  actor: Dnd5eActorData,
  options: LevelUpOptions
): Dnd5eActorData {
  if (actor.attributes.level >= 20) {
    throw new Error("Cannot level up past level 20");
  }

  const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actor));
  clone.attributes.level += 1;
  clone.attributes.hitDiceMax += 1;
  clone.attributes.hitDiceCurrent += 1;

  const conMod = Math.floor((clone.abilities.con.score - 10) / 2);
  let hpGain: number;
  if (options.hpIncreaseMode === "fixed") {
    hpGain = Math.max(1, Math.floor(clone.attributes.hitDieSize / 2) + 1 + conMod);
  } else {
    hpGain = Math.max(1, (options.rolledHp || 1) + conMod);
  }
  clone.attributes.hp.max += hpGain;
  clone.attributes.hp.current += hpGain;

  if (options.casterType && options.casterType !== "none") {
    if (!clone.spellSlots) {
      clone.spellSlots = {};
    }
    const newLevel = clone.attributes.level;
    if (options.casterType === "full") {
      const slots = FULL_CASTER_SPELL_SLOTS[newLevel];
      if (slots) {
        const slotKeys: (keyof SpellSlotsState)[] = [
          "level1",
          "level2",
          "level3",
          "level4",
          "level5",
          "level6",
          "level7",
          "level8",
          "level9",
        ];
        for (let i = 0; i < slotKeys.length; i++) {
          const key = slotKeys[i];
          const newMax = slots[i];
          if (newMax > 0) {
            const existing = clone.spellSlots[key];
            const current = existing
              ? existing.current + Math.max(0, newMax - existing.max)
              : newMax;
            clone.spellSlots[key] = { current, max: newMax };
          }
        }
      }
    } else if (options.casterType === "half") {
      const slots = HALF_CASTER_SPELL_SLOTS[newLevel];
      if (slots) {
        const slotKeys: (keyof SpellSlotsState)[] = [
          "level1",
          "level2",
          "level3",
          "level4",
          "level5",
        ];
        for (let i = 0; i < slotKeys.length; i++) {
          const key = slotKeys[i];
          const newMax = slots[i];
          if (newMax > 0) {
            const existing = clone.spellSlots[key];
            const current = existing
              ? existing.current + Math.max(0, newMax - existing.max)
              : newMax;
            clone.spellSlots[key] = { current, max: newMax };
          }
        }
      }
    } else if (options.casterType === "pact") {
      const pactInfo = PACT_MAGIC_SPELL_SLOTS[newLevel];
      if (pactInfo) {
        const existing = clone.spellSlots.pact;
        const current = existing
          ? existing.current + Math.max(0, pactInfo.slots - existing.max)
          : pactInfo.slots;
        clone.spellSlots.pact = { current, max: pactInfo.slots };
      }
    }
  }

  return clone;
}

/**
 * Advances active condition timers matching `trigger` (and `currentTurnActorId` for
 * turn-scoped triggers) by `1` round, returning a new array with expired (`<= 0` rounds)
 * conditions removed.
 */
export function decrementConditionDurations(
  conditions: ActiveConditionState[],
  trigger: TurnTrigger,
  currentTurnActorId?: string
): ActiveConditionState[] {
  const survivingConditions: ActiveConditionState[] = [];
  for (const cond of conditions) {
    let remaining = cond.durationRounds;
    if (trigger === "TURNS_START" || trigger === "TURNS_END") {
      if (
        cond.appliedTurnActorId !== undefined &&
        cond.appliedTurnActorId === currentTurnActorId &&
        cond.trigger === trigger
      ) {
        remaining = cond.durationRounds - 1;
      }
    } else if (trigger === "ROUNDS") {
      if (cond.trigger === "ROUNDS") {
        remaining = cond.durationRounds - 1;
      }
    }
    if (remaining > 0) {
      survivingConditions.push({ ...cond, durationRounds: remaining });
    }
  }
  return survivingConditions;
}
