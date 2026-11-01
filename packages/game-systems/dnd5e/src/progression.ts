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
 *      - A Constitution ASI that changes the modifier adds the difference for
 *        every earlier level, and the Tough feat adds `2 * level` when taken
 *        and `+2` on each later level (SRD retroactive HP rules).
 *   3. `Incremental Spell Slot Preservation`:
 *      - Advancing a caster increases `current` available slots only by the delta
 *        `max(0, newMax - existing.max)` so previously expended spell slots are
 *        not illicitly refunded mid-adventuring day upon leveling up.
 *   4. `Table-Driven Class Rules`:
 *      - Subclass level, ASI levels, caster type and features of the 12 SRD
 *        classes live in `SRD_CLASS_PROGRESSION` (Cleric/Sorcerer/Warlock pick
 *        a subclass at 1, Druid/Wizard at 2, everyone else at 3).
 *   5. `Turn-Scoped Condition Expiry`:
 *      - `decrementConditionDurations` only decrements `"TURNS_START"` and
 *        `"TURNS_END"` conditions when `appliedTurnActorId === currentTurnActorId`,
 *        and automatically prunes conditions whose `durationRounds` drops to `<= 0`.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `applyLevelUp(actor, options)`
 *     ├── 1. Verify `actor.attributes.level < 20` and deep-clone `actor`.
 *     ├── 2. Increment `level`, `hitDiceMax`, and `hitDiceCurrent` by `1`.
 *     ├── 3. Compute `hpGain = max(1, baseGain + conMod)` plus retroactive CON and
 *     │      Tough bonuses, and add it to `hp.max` & `hp.current`.
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
import { calculateProficiencyBonus, computeDnd5eSheetDerived } from "./manifest.ts";

export type {
  AsiOrFeatSelection,
  AsiSelection,
  CasterType,
  FeatSelection,
  HitPointsMode,
  LevelUpOptions,
  PactMagicProgression,
};

/** Identifiers of the 12 SRD 5.1 classes (without the `srd:class:` prefix). */
export type SrdClassId =
  | "barbarian"
  | "bard"
  | "cleric"
  | "druid"
  | "fighter"
  | "monk"
  | "paladin"
  | "ranger"
  | "rogue"
  | "sorcerer"
  | "warlock"
  | "wizard";

/** Level 1-20 progression rules of one SRD 5.1 class. */
export interface ClassProgression {
  /** Hit Die size (`6`, `8`, `10` or `12`). */
  hitDie: number;
  /** Spell slot table used by `reconcileSlots`. */
  casterType: CasterType;
  /** Spellcasting ability, absent for non-casters. */
  spellcastingAbility?: AbilityId;
  /** Saving throw proficiencies granted at level 1. */
  savingThrows: [AbilityId, AbilityId];
  /** Level at which the subclass is chosen (`1`, `2` or `3`). */
  subclassLevel: number;
  /** Levels granting an Ability Score Improvement or feat. */
  asiLevels: readonly number[];
  /** SRD 5.1 class feature names (English, canonical) gained at each level. */
  features: Readonly<Record<number, readonly string[]>>;
}

const STANDARD_ASI_LEVELS: readonly number[] = [4, 8, 12, 16, 19];

/**
 * SRD 5.1 class progression for levels 1 through 20. Subclass levels follow
 * the SRD: Cleric, Sorcerer and Warlock at 1; Druid and Wizard at 2; others at 3.
 */
export const SRD_CLASS_PROGRESSION: Readonly<Record<SrdClassId, ClassProgression>> = {
  barbarian: {
    hitDie: 12,
    casterType: "none",
    savingThrows: ["str", "con"],
    subclassLevel: 3,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Rage", "Unarmored Defense"],
      2: ["Reckless Attack", "Danger Sense"],
      3: ["Primal Path"],
      5: ["Extra Attack", "Fast Movement"],
      7: ["Feral Instinct"],
      9: ["Brutal Critical (1 die)"],
      11: ["Relentless Rage"],
      13: ["Brutal Critical (2 dice)"],
      15: ["Persistent Rage"],
      17: ["Brutal Critical (3 dice)"],
      18: ["Indomitable Might"],
      20: ["Primal Champion"],
    },
  },
  bard: {
    hitDie: 8,
    casterType: "full",
    spellcastingAbility: "cha",
    savingThrows: ["dex", "cha"],
    subclassLevel: 3,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Bardic Inspiration (d6)"],
      2: ["Jack of All Trades", "Song of Rest (d6)"],
      3: ["Bard College", "Expertise"],
      5: ["Bardic Inspiration (d8)", "Font of Inspiration"],
      6: ["Countercharm"],
      10: ["Bardic Inspiration (d10)", "Expertise", "Magical Secrets"],
      14: ["Magical Secrets"],
      15: ["Bardic Inspiration (d12)"],
      18: ["Magical Secrets"],
      20: ["Superior Inspiration"],
    },
  },
  cleric: {
    hitDie: 8,
    casterType: "full",
    spellcastingAbility: "wis",
    savingThrows: ["wis", "cha"],
    subclassLevel: 1,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Divine Domain"],
      2: ["Channel Divinity (1/rest)"],
      5: ["Destroy Undead (CR 1/2)"],
      6: ["Channel Divinity (2/rest)"],
      8: ["Destroy Undead (CR 1)"],
      10: ["Divine Intervention"],
      11: ["Destroy Undead (CR 2)"],
      14: ["Destroy Undead (CR 3)"],
      17: ["Destroy Undead (CR 4)"],
      18: ["Channel Divinity (3/rest)"],
      20: ["Divine Intervention Improvement"],
    },
  },
  druid: {
    hitDie: 8,
    casterType: "full",
    spellcastingAbility: "wis",
    savingThrows: ["int", "wis"],
    subclassLevel: 2,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Druidic", "Spellcasting"],
      2: ["Wild Shape", "Druid Circle"],
      4: ["Wild Shape Improvement"],
      8: ["Wild Shape Improvement"],
      18: ["Timeless Body", "Beast Spells"],
      20: ["Archdruid"],
    },
  },
  fighter: {
    hitDie: 10,
    casterType: "none",
    savingThrows: ["str", "con"],
    subclassLevel: 3,
    asiLevels: [4, 6, 8, 12, 14, 16, 19],
    features: {
      1: ["Fighting Style", "Second Wind"],
      2: ["Action Surge (one use)"],
      3: ["Martial Archetype"],
      5: ["Extra Attack"],
      9: ["Indomitable (one use)"],
      11: ["Extra Attack (2)"],
      13: ["Indomitable (two uses)"],
      17: ["Action Surge (two uses)", "Indomitable (three uses)"],
      20: ["Extra Attack (3)"],
    },
  },
  monk: {
    hitDie: 8,
    casterType: "none",
    savingThrows: ["str", "dex"],
    subclassLevel: 3,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Unarmored Defense", "Martial Arts"],
      2: ["Ki", "Unarmored Movement"],
      3: ["Monastic Tradition", "Deflect Missiles"],
      4: ["Slow Fall"],
      5: ["Extra Attack", "Stunning Strike"],
      6: ["Ki-Empowered Strikes"],
      7: ["Evasion", "Stillness of Mind"],
      10: ["Purity of Body"],
      13: ["Tongue of the Sun and Moon"],
      14: ["Diamond Soul"],
      15: ["Timeless Body"],
      18: ["Empty Body"],
      20: ["Perfect Self"],
    },
  },
  paladin: {
    hitDie: 10,
    casterType: "half",
    spellcastingAbility: "cha",
    savingThrows: ["wis", "cha"],
    subclassLevel: 3,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Divine Sense", "Lay on Hands"],
      2: ["Fighting Style", "Spellcasting", "Divine Smite"],
      3: ["Divine Health", "Sacred Oath"],
      5: ["Extra Attack"],
      6: ["Aura of Protection"],
      10: ["Aura of Courage"],
      11: ["Improved Divine Smite"],
      14: ["Cleansing Touch"],
      18: ["Aura Improvements"],
    },
  },
  ranger: {
    hitDie: 10,
    casterType: "half",
    spellcastingAbility: "wis",
    savingThrows: ["str", "dex"],
    subclassLevel: 3,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Favored Enemy", "Natural Explorer"],
      2: ["Fighting Style", "Spellcasting"],
      3: ["Ranger Archetype", "Primeval Awareness"],
      5: ["Extra Attack"],
      8: ["Land's Stride"],
      10: ["Hide in Plain Sight"],
      14: ["Vanish"],
      18: ["Feral Senses"],
      20: ["Foe Slayer"],
    },
  },
  rogue: {
    hitDie: 8,
    casterType: "none",
    savingThrows: ["dex", "int"],
    subclassLevel: 3,
    asiLevels: [4, 8, 10, 12, 16, 19],
    features: {
      1: ["Expertise", "Sneak Attack", "Thieves' Cant"],
      2: ["Cunning Action"],
      3: ["Roguish Archetype"],
      5: ["Uncanny Dodge"],
      6: ["Expertise"],
      7: ["Evasion"],
      11: ["Reliable Talent"],
      14: ["Blindsense"],
      15: ["Slippery Mind"],
      18: ["Elusive"],
      20: ["Stroke of Luck"],
    },
  },
  sorcerer: {
    hitDie: 6,
    casterType: "full",
    spellcastingAbility: "cha",
    savingThrows: ["con", "cha"],
    subclassLevel: 1,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Sorcerous Origin"],
      2: ["Font of Magic"],
      3: ["Metamagic"],
      10: ["Metamagic"],
      17: ["Metamagic"],
      20: ["Sorcerous Restoration"],
    },
  },
  warlock: {
    hitDie: 8,
    casterType: "pact",
    spellcastingAbility: "cha",
    savingThrows: ["wis", "cha"],
    subclassLevel: 1,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Otherworldly Patron", "Pact Magic"],
      2: ["Eldritch Invocations"],
      3: ["Pact Boon"],
      11: ["Mystic Arcanum (6th level)"],
      13: ["Mystic Arcanum (7th level)"],
      15: ["Mystic Arcanum (8th level)"],
      17: ["Mystic Arcanum (9th level)"],
      20: ["Eldritch Master"],
    },
  },
  wizard: {
    hitDie: 6,
    casterType: "full",
    spellcastingAbility: "int",
    savingThrows: ["int", "wis"],
    subclassLevel: 2,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Arcane Recovery"],
      2: ["Arcane Tradition"],
      18: ["Spell Mastery"],
      20: ["Signature Spells"],
    },
  },
};

/**
 * Resolves `classId` (`"wizard"`, `"srd:class:wizard"`, any case) to its
 * `SRD_CLASS_PROGRESSION` entry, or `undefined` for unknown classes.
 */
export function getClassProgression(classId?: string): ClassProgression | undefined {
  if (!classId) return undefined;
  const clean = classId.replace(/^srd:class:/, "").toLowerCase();
  return Object.hasOwn(SRD_CLASS_PROGRESSION, clean)
    ? SRD_CLASS_PROGRESSION[clean as SrdClassId]
    : undefined;
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
 * SRD 5.1 one-third caster spell slot table indexed by character level (`1..=20`),
 * mapping to a 4-element tuple of maximum slots for spell levels 1 through 4.
 */
export const THIRD_CASTER_SPELL_SLOTS: Record<number, number[]> = {
  1: [0, 0, 0, 0],
  2: [0, 0, 0, 0],
  3: [2, 0, 0, 0],
  4: [3, 0, 0, 0],
  5: [3, 0, 0, 0],
  6: [3, 0, 0, 0],
  7: [4, 2, 0, 0],
  8: [4, 2, 0, 0],
  9: [4, 2, 0, 0],
  10: [4, 3, 0, 0],
  11: [4, 3, 0, 0],
  12: [4, 3, 0, 0],
  13: [4, 3, 2, 0],
  14: [4, 3, 2, 0],
  15: [4, 3, 2, 0],
  16: [4, 3, 3, 0],
  17: [4, 3, 3, 0],
  18: [4, 3, 3, 0],
  19: [4, 3, 3, 1],
  20: [4, 3, 3, 1],
};

/**
 * Returns the subclass unlock level for a given class: 1 for Cleric/Sorcerer/Warlock,
 * 2 for Druid/Wizard, 3 for every other class (and unknown classes).
 */
export function getSubclassUnlockLevel(classId?: string): number {
  return getClassProgression(classId)?.subclassLevel ?? 3;
}

/**
 * Returns whether the given character level is an Ability Score Improvement (ASI) level.
 * Standard classes: 4, 8, 12, 16, 19. Fighter: 4, 6, 8, 12, 14, 16, 19. Rogue: 4, 8, 10, 12, 16, 19.
 */
export function isAsiLevel(level: number, classId?: string): boolean {
  return (getClassProgression(classId)?.asiLevels ?? STANDARD_ASI_LEVELS).includes(level);
}

/**
 * Determines the canonical caster type for a given D&D 5e class identifier.
 */
export function getCasterTypeForClass(classId?: string): CasterType {
  return getClassProgression(classId)?.casterType ?? "none";
}

type NormalizedCasterType = "full" | "half" | "third" | "pact" | "none";

/**
 * Normalizes variant CasterType tokens (e.g., 'FULL_CASTER', 'full') into canonical keys.
 */
function normalizeCasterType(type?: CasterType): NormalizedCasterType {
  if (!type) return "none";
  const lower = type.toLowerCase().replace(/_caster$/, "");
  if (lower === "full") return "full";
  if (lower === "half") return "half";
  if (lower === "third") return "third";
  if (lower === "pact" || lower === "pact_magic") return "pact";
  return "none";
}

const SLOT_TABLES: Record<"full" | "half" | "third", Record<number, number[]>> = {
  full: FULL_CASTER_SPELL_SLOTS,
  half: HALF_CASTER_SPELL_SLOTS,
  third: THIRD_CASTER_SPELL_SLOTS,
};

const SLOT_KEYS: readonly (keyof SpellSlotsState)[] = [
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

/**
 * Highest spell slot level (`0..=9`) granted by `casterType` at `characterLevel`.
 */
export function getMaxSpellSlotLevel(casterType: CasterType, characterLevel: number): number {
  const normalized = normalizeCasterType(casterType);
  if (normalized === "none") return 0;
  if (normalized === "pact") return PACT_MAGIC_SPELL_SLOTS[characterLevel]?.slotLevel ?? 0;
  const row = SLOT_TABLES[normalized][characterLevel] ?? [];
  return row.reduce((max, slots, i) => (slots > 0 ? i + 1 : max), 0);
}

/**
 * Spell levels (`1..=9`) a class can cast at `characterLevel`: every slot level
 * up to the highest one, plus the Warlock's Mystic Arcanum levels (6th at 11,
 * 7th at 13, 8th at 15, 9th at 17).
 */
export function getCastableSpellLevels(classId: string, characterLevel: number): number[] {
  const maxSlot = getMaxSpellSlotLevel(getCasterTypeForClass(classId), characterLevel);
  const levels = Array.from({ length: maxSlot }, (_, i) => i + 1);
  if (getCasterTypeForClass(classId) === "pact") {
    for (const [arcanumLevel, spellLevel] of [[11, 6], [13, 7], [15, 8], [17, 9]]) {
      if (characterLevel >= arcanumLevel) levels.push(spellLevel);
    }
  }
  return levels;
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

  if (normalized !== "pact") {
    const slots = SLOT_TABLES[normalized][targetLevel];
    if (slots) {
      for (let i = 0; i < slots.length; i++) {
        const key = SLOT_KEYS[i];
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
  } else {
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

/** Maximum HP granted by the Tough feat per character level. */
export const TOUGH_HP_PER_LEVEL = 2;

/** Matches `"srd:feat:tough"` and the short `"tough"` feat id. */
function isToughFeat(featId: string): boolean {
  return featId === "tough" || featId === "srd:feat:tough";
}

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
    actor.class ??
    actor.attributes.classId ??
    actor.attributes.class
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

  // 8. Apply ASI bonuses or Feat
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

  // 9. Calculate and apply HP increase (new level, retroactive CON, Tough)
  const previousConModifier = Math.floor((actor.abilities.con.score - 10) / 2);
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
  hpGain += (conModifier - previousConModifier) * actor.attributes.level;
  if (isAsi && options.asiOrFeat?.mode === "feat" && isToughFeat(options.asiOrFeat.featId)) {
    hpGain += TOUGH_HP_PER_LEVEL * targetLevel;
  } else if ((actor.features ?? []).some(isToughFeat)) {
    hpGain += TOUGH_HP_PER_LEVEL;
  }
  clone.attributes.hp.max += hpGain;
  clone.attributes.hp.current += hpGain;

  // 10. Record subclass & class
  if (options.subclassId) {
    clone.subclassId = options.subclassId;
    clone.attributes.subclassId = options.subclassId;
  }
  if (options.classId) {
    clone.classId = options.classId;
    clone.attributes.classId = options.classId;
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
  } else if (clone.spellSlots && Object.keys(clone.spellSlots).length === 0) {
    delete clone.spellSlots;
  }

  // 13. Recalculate proficiency bonus and derived stats
  const pb = calculateProficiencyBonus(targetLevel);
  clone.attributes.proficiencyBonus = pb;
  clone.proficiencyBonus = pb;
  clone.derived = computeDnd5eSheetDerived(clone);

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
