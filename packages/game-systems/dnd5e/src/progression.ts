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
  AbilityId,
  ActiveConditionState,
  AsiOrFeatSelection,
  AsiSelection,
  CasterType,
  Dnd5eActorData,
  FeatSelection,
  HitPointsMode,
  LevelUpOptions,
  PactMagicProgression,
  SpellSlotsState,
  TurnTrigger,
} from "./types.ts";
import { computeDnd5eSheetDerived } from "./manifest.ts";

export type {
  AsiOrFeatSelection,
  AsiSelection,
  CasterType,
  FeatSelection,
  HitPointsMode,
  LevelUpOptions,
  PactMagicProgression,
};

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
 * Returns the subclass unlock level for a given class: 1 for Cleric/Sorcerer, 2 for Druid/Wizard, 3 for others.
 */
export function getSubclassUnlockLevel(classId?: string): number {
  if (!classId) return 3;
  const clean = classId.replace(/^srd:class:/, "").toLowerCase();
  if (clean === "cleric" || clean === "sorcerer") {
    return 1;
  }
  if (clean === "druid" || clean === "wizard") {
    return 2;
  }
  return 3;
}

/**
 * Returns whether the given character level is an Ability Score Improvement (ASI) level.
 * Standard classes: 4, 8, 12, 16, 19. Fighter: 4, 6, 8, 12, 14, 16, 19. Rogue: 4, 8, 10, 12, 16, 19.
 */
export function isAsiLevel(level: number, classId?: string): boolean {
  const clean = classId?.replace(/^srd:class:/, "").toLowerCase();
  if (clean === "fighter") {
    return [4, 6, 8, 12, 14, 16, 19].includes(level);
  }
  if (clean === "rogue") {
    return [4, 8, 10, 12, 16, 19].includes(level);
  }
  return [4, 8, 12, 16, 19].includes(level);
}

/**
 * Determines the canonical caster type for a given D&D 5e class identifier.
 */
export function getCasterTypeForClass(classId?: string): CasterType {
  if (!classId) return "none";
  const clean = classId.replace(/^srd:class:/, "").toLowerCase();
  switch (clean) {
    case "bard":
    case "cleric":
    case "druid":
    case "sorcerer":
    case "wizard":
      return "full";
    case "paladin":
    case "ranger":
      return "half";
    case "warlock":
      return "pact";
    default:
      return "none";
  }
}

/**
 * Normalizes variant CasterType tokens (e.g., 'FULL_CASTER', 'full') into canonical keys.
 */
function normalizeCasterType(type?: CasterType): "full" | "half" | "pact" | "none" {
  if (!type) return "none";
  const lower = type.toLowerCase().replace(/_caster$/, "");
  if (lower === "full") return "full";
  if (lower === "half") return "half";
  if (lower === "pact" || lower === "pact_magic") return "pact";
  return "none";
}

/**
 * Reconciles spell slot tiers against the canonical SRD 5.1 progression table for a given target level,
 * preserving previously expended slots by incrementing available capacity only by the newly unlocked delta.
 */
export function reconcileSlots(
  existingSlots: SpellSlotsState | undefined,
  casterType: CasterType,
  targetLevel: number
): SpellSlotsState {
  const normalized = normalizeCasterType(casterType);
  const result: SpellSlotsState = existingSlots ? JSON.parse(JSON.stringify(existingSlots)) : {};
  if (normalized === "none") {
    return result;
  }

  if (normalized === "full") {
    const slots = FULL_CASTER_SPELL_SLOTS[targetLevel];
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
          const existing = result[key];
          const current = existing
            ? existing.current + Math.max(0, newMax - existing.max)
            : newMax;
          result[key] = { current, max: newMax };
        } else if (result[key]) {
          result[key] = { current: 0, max: 0 };
        }
      }
    }
  } else if (normalized === "half") {
    const slots = HALF_CASTER_SPELL_SLOTS[targetLevel];
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
          const existing = result[key];
          const current = existing
            ? existing.current + Math.max(0, newMax - existing.max)
            : newMax;
          result[key] = { current, max: newMax };
        } else if (result[key]) {
          result[key] = { current: 0, max: 0 };
        }
      }
    }
  } else if (normalized === "pact") {
    const pactInfo = PACT_MAGIC_SPELL_SLOTS[targetLevel];
    if (pactInfo) {
      const existing = result.pact;
      const current = existing
        ? existing.current + Math.max(0, pactInfo.slots - existing.max)
        : pactInfo.slots;
      result.pact = {
        current,
        max: pactInfo.slots,
        slotLevel: pactInfo.slotLevel,
      };
    }
  }

  return result;
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
 * Advances `actor` by one character level (up to level 20), validating level increment,
 * subclass tiers, HP progression mode, ASI/Feat selection, and reconciling spell slots.
 */
export function applyLevelUp(
  actor: Dnd5eActorData,
  options: LevelUpOptions
): Dnd5eActorData {
  // 1. Level ceiling checks
  if (options.targetLevel !== undefined && options.targetLevel > 20) {
    throw new Error("Max level is 20");
  }
  if (actor.attributes.level >= 20) {
    throw new Error("Max level is 20");
  }

  // 2. Level increment validation
  if (
    options.targetLevel !== undefined &&
    options.targetLevel !== actor.attributes.level + 1
  ) {
    throw new Error("Invalid level increment");
  }

  const targetLevel = options.targetLevel ?? actor.attributes.level + 1;

  // 3. Class and Subclass validation
  const classId = (
    options.classId ??
    actor.classId ??
    (actor as Record<string, unknown>).class ??
    actor.attributes.classId ??
    (actor.attributes as Record<string, unknown>).class
  )?.toString();

  const subclassUnlockLevel = getSubclassUnlockLevel(classId);
  if (targetLevel === subclassUnlockLevel && !options.subclassId) {
    throw new Error("Subclass selection required at this level");
  }

  // 4. Hit points mode validation
  const hitPointsMode: HitPointsMode =
    options.hitPointsMode ??
    (options.hpIncreaseMode === "roll" ? "rolled" : options.hpIncreaseMode) ??
    "fixed";

  if (hitPointsMode === "rolled") {
    if (
      options.rolledHp === undefined ||
      options.rolledHp === null ||
      typeof options.rolledHp !== "number" ||
      Number.isNaN(options.rolledHp) ||
      options.rolledHp < 1 ||
      options.rolledHp > actor.attributes.hitDieSize
    ) {
      throw new Error("Invalid rolledHp value");
    }
  }

  // 5. ASI / Feat validation at ASI levels
  const isAsi = isAsiLevel(targetLevel, classId);
  if (isAsi && options.asiOrFeat) {
    if (options.asiOrFeat.mode === "asi") {
      const bonuses = options.asiOrFeat.bonuses;
      if (!bonuses || typeof bonuses !== "object") {
        throw new Error("Invalid ASI bonus sum");
      }
      const entries = Object.entries(bonuses);
      if (entries.length === 0) {
        throw new Error("Invalid ASI bonus sum");
      }
      let totalBonus = 0;
      for (const [, val] of entries) {
        if (typeof val !== "number" || val <= 0 || !Number.isInteger(val)) {
          throw new Error("Invalid ASI bonus sum");
        }
        totalBonus += val;
      }
      if (totalBonus !== 2) {
        throw new Error("Invalid ASI bonus sum");
      }
      for (const [key, bonus] of entries) {
        const abilityKey = key as AbilityId;
        const currentScore = actor.abilities[abilityKey]?.score ?? 10;
        if (currentScore + bonus > 20) {
          throw new Error("Ability score cannot exceed 20");
        }
      }
    } else if (options.asiOrFeat.mode === "feat") {
      if (!options.asiOrFeat.featId || typeof options.asiOrFeat.featId !== "string" || !options.asiOrFeat.featId.trim()) {
        throw new Error("Invalid featId value");
      }
    }
  }

  // 6. Deep clone actor state
  const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actor));

  // 7. Update level and Hit Dice
  clone.attributes.level = targetLevel;
  clone.attributes.hitDiceMax += 1;
  clone.attributes.hitDiceCurrent += 1;

  // 8. Calculate and apply HP increase
  const conModifier = Math.floor((clone.abilities.con.score - 10) / 2);
  let hpGain: number;
  if (hitPointsMode === "fixed") {
    hpGain = Math.max(
      1,
      Math.floor(clone.attributes.hitDieSize / 2) + 1 + conModifier
    );
  } else {
    hpGain = Math.max(1, options.rolledHp! + conModifier);
  }
  clone.attributes.hp.max += hpGain;
  clone.attributes.hp.current += hpGain;

  // 9. Record subclass & class
  if (options.subclassId) {
    clone.subclassId = options.subclassId;
    clone.attributes.subclassId = options.subclassId;
  }
  if (options.classId) {
    clone.classId = options.classId;
    clone.attributes.classId = options.classId;
  }

  // 10. Apply ASI bonuses or Feat
  if (isAsi && options.asiOrFeat) {
    if (options.asiOrFeat.mode === "asi") {
      for (const [key, bonus] of Object.entries(options.asiOrFeat.bonuses)) {
        const ab = key as AbilityId;
        if (clone.abilities[ab]) {
          clone.abilities[ab].score += bonus!;
        }
      }
    } else if (options.asiOrFeat.mode === "feat") {
      if (!clone.features) {
        clone.features = [];
      }
      clone.features.push(options.asiOrFeat.featId);
    }
  }

  // 11. Register new spell identifiers
  if (options.newSpellIds && Array.isArray(options.newSpellIds)) {
    if (!clone.spellIds) {
      clone.spellIds = [];
    }
    for (const spellId of options.newSpellIds) {
      if (!clone.spellIds.includes(spellId)) {
        clone.spellIds.push(spellId);
      }
    }
  }

  // 12. Reconcile spell slots
  const explicitCaster = options.casterType;
  const effectiveCasterType =
    explicitCaster && normalizeCasterType(explicitCaster) !== "none"
      ? explicitCaster
      : getCasterTypeForClass(classId);

  if (normalizeCasterType(effectiveCasterType) !== "none") {
    clone.spellSlots = reconcileSlots(
      clone.spellSlots,
      effectiveCasterType,
      targetLevel
    );
    clone.attributes.casterType = effectiveCasterType;
  }

  // 13. Recalculate proficiency bonus and derived stats
  const pb = calculateProficiencyBonus(targetLevel);
  clone.attributes.proficiencyBonus = pb;
  clone.proficiencyBonus = pb;
  (clone as Record<string, unknown>).derived = computeDnd5eSheetDerived(clone);

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
