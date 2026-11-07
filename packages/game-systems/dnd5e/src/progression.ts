/**
 * ============================================================================
 * D&D 5E LEVEL PROGRESSION, SPELL SLOT TABLES & CONDITION TIMERS (progression.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Governs character level advancement (`applyLevelUp`), canonical SRD 5.2.1
 * (2024 rules) class progression and spell slot tables across Full, Half, and
 * Warlock Pact Magic casters, Weapon Mastery counts, and combat turn/round
 * condition duration ticking (`decrementConditionDurations`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Level 20 Ceiling Guard`:
 *      - `applyLevelUp` rejects advancement when `actor.attributes.level >= 20`
 *        to enforce the level cap and guarantee valid table lookups in
 *        `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
 *   2. `Minimum +1 HP Per Level Floor`:
 *      - Both `"fixed"` (`floor(hitDieSize / 2) + 1 + conMod`) and `"roll"`
 *        (`rolledHp + conMod`) modes clamp HP gained per level to `>= 1` so a
 *        severe negative Constitution modifier can never reduce maximum HP on level-up.
 *      - A Constitution increase (ASI or feat) that changes the modifier adds
 *        the difference for every earlier level; Dwarven Toughness adds `+1`
 *        per level. No SRD 5.2.1 feat grants HP per level.
 *      - Class features with `hpMaxPerLevel` (Draconic Resilience) add the
 *        difference of `classFeatureHpMaxBonus` before and after the level:
 *        `+3` when the Draconic subclass arrives at level 3, `+1` per level after.
 *   3. `Incremental Spell Slot Preservation`:
 *      - Advancing a caster increases `current` available slots only by the delta
 *        `max(0, newMax - existing.max)` so previously expended spell slots are
 *        not illicitly refunded mid-adventuring day upon leveling up.
 *   4. `Table-Driven Class Rules`:
 *      - ASI levels, caster type, Weapon Mastery counts and features of the 12
 *        SRD classes live in `SRD_CLASS_PROGRESSION`. Every class picks its
 *        subclass at level 3 (`SUBCLASS_UNLOCK_LEVEL`), and level-up refuses
 *        to reach level 3 or more without one.
 *   5. `SRD-Only Feats`:
 *      - Feats taken at an ASI level are validated by `validateFeatSelection`
 *        (prerequisites, repeatability, `+1` increases up to 20 or 30).
 *      - The Fighting Style feature (Fighter 1, Paladin/Ranger 2) and the
 *        Champion's Additional Fighting Style (7) grant one Fighting Style
 *        feat (`grantsFightingStyleFeat`), recorded by `recordFightingStyleFeat`
 *        only at those levels and never twice.
 *   6. `Turn-Scoped Condition Expiry`:
 *      - `decrementConditionDurations` only decrements `"TURNS_START"` and
 *        `"TURNS_END"` conditions when `appliedTurnActorId === currentTurnActorId`,
 *        and automatically prunes conditions whose `durationRounds` drops to `<= 0`.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `applyLevelUp(actor, options)`
 *     ├── 1. Verify `actor.attributes.level < 20`, the subclass, HP mode and ASI/feat.
 *     ├── 2. Deep-clone; increment `level`, `hitDiceMax`, and `hitDiceCurrent` by `1`.
 *     ├── 3. Apply the ASI or feat (and its `+1` increase).
 *     ├── 4. Compute `hpGain = max(1, baseGain + conMod)` plus retroactive CON and
 *     │      species bonuses, and add it to `hp.max` & `hp.current`.
 *     ├── 5. Record class/subclass; add the class feature HP bonus delta.
 *     └── 6. Reconcile `spellSlots` against the target level's `casterType` progression row.
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
import { classFeatureHpMaxBonus, srdClassFeatures } from "./classFeatures.ts";
import { calculateProficiencyBonus, computeDnd5eSheetDerived } from "./manifest.ts";
import {
  getFeatSlotOptions,
  getSpeciesRules,
  SRD_FEATS,
  srdFeatKey,
  validateFeatSelection,
  type FeatSelectionContext,
  type SrdFeatId,
} from "./origins.ts";

export type {
  AsiOrFeatSelection,
  AsiSelection,
  CasterType,
  FeatSelection,
  HitPointsMode,
  LevelUpOptions,
  PactMagicProgression,
};

/** Identifiers of the 12 SRD 5.2.1 classes (without the `srd:class:` prefix). */
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

/** Level 1-20 progression rules of one SRD 5.2.1 class. */
export interface ClassProgression {
  /** Hit Die size (`6`, `8`, `10` or `12`). */
  hitDie: number;
  /** Spell slot table used by `reconcileSlots`. */
  casterType: CasterType;
  /** Spellcasting ability, absent for non-casters. */
  spellcastingAbility?: AbilityId;
  /** Saving throw proficiencies granted at level 1. */
  savingThrows: [AbilityId, AbilityId];
  /** Level at which the subclass is chosen (`3` for every SRD 5.2.1 class). */
  subclassLevel: number;
  /** Levels granting an Ability Score Improvement or feat (19 is the Epic Boon). */
  asiLevels: readonly number[];
  /**
   * Weapon Mastery: number of weapon kinds mastered, keyed by the level at which
   * the count starts applying. Absent for classes without Weapon Mastery.
   */
  weaponMastery?: Readonly<Record<number, number>>;
  /** SRD 5.2.1 class feature names (English, canonical) gained at each level. */
  features: Readonly<Record<number, readonly string[]>>;
}

/** Level at which every SRD 5.2.1 class chooses its subclass. */
export const SUBCLASS_UNLOCK_LEVEL = 3;

const STANDARD_ASI_LEVELS: readonly number[] = [4, 8, 12, 16, 19];

/**
 * SRD 5.2.1 class progression for levels 1 through 20. Every class takes its
 * subclass at level 3 and its Epic Boon at level 19.
 */
export const SRD_CLASS_PROGRESSION: Readonly<Record<SrdClassId, ClassProgression>> = {
  barbarian: {
    hitDie: 12,
    casterType: "none",
    savingThrows: ["str", "con"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    weaponMastery: { 1: 2, 4: 3, 10: 4 },
    features: {
      1: ["Rage", "Unarmored Defense", "Weapon Mastery"],
      2: ["Danger Sense", "Reckless Attack"],
      3: ["Barbarian Subclass", "Primal Knowledge"],
      5: ["Extra Attack", "Fast Movement"],
      7: ["Feral Instinct", "Instinctive Pounce"],
      9: ["Brutal Strike"],
      11: ["Relentless Rage"],
      13: ["Improved Brutal Strike"],
      15: ["Persistent Rage"],
      17: ["Improved Brutal Strike"],
      18: ["Indomitable Might"],
      19: ["Epic Boon"],
      20: ["Primal Champion"],
    },
  },
  bard: {
    hitDie: 8,
    casterType: "full",
    spellcastingAbility: "cha",
    savingThrows: ["dex", "cha"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Bardic Inspiration", "Spellcasting"],
      2: ["Expertise", "Jack of All Trades"],
      3: ["Bard Subclass"],
      5: ["Font of Inspiration"],
      7: ["Countercharm"],
      9: ["Expertise"],
      10: ["Magical Secrets"],
      18: ["Superior Inspiration"],
      19: ["Epic Boon"],
      20: ["Words of Creation"],
    },
  },
  cleric: {
    hitDie: 8,
    casterType: "full",
    spellcastingAbility: "wis",
    savingThrows: ["wis", "cha"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Divine Order"],
      2: ["Channel Divinity"],
      3: ["Cleric Subclass"],
      5: ["Sear Undead"],
      7: ["Blessed Strikes"],
      10: ["Divine Intervention"],
      14: ["Improved Blessed Strikes"],
      19: ["Epic Boon"],
      20: ["Greater Divine Intervention"],
    },
  },
  druid: {
    hitDie: 8,
    casterType: "full",
    spellcastingAbility: "wis",
    savingThrows: ["int", "wis"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Druidic", "Primal Order"],
      2: ["Wild Shape", "Wild Companion"],
      3: ["Druid Subclass"],
      5: ["Wild Resurgence"],
      7: ["Elemental Fury"],
      15: ["Improved Elemental Fury"],
      18: ["Beast Spells"],
      19: ["Epic Boon"],
      20: ["Archdruid"],
    },
  },
  fighter: {
    hitDie: 10,
    casterType: "none",
    savingThrows: ["str", "con"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: [4, 6, 8, 12, 14, 16, 19],
    weaponMastery: { 1: 3, 4: 4, 10: 5, 16: 6 },
    features: {
      1: ["Fighting Style", "Second Wind", "Weapon Mastery"],
      2: ["Action Surge", "Tactical Mind"],
      3: ["Fighter Subclass"],
      5: ["Extra Attack", "Tactical Shift"],
      9: ["Indomitable", "Tactical Master"],
      11: ["Two Extra Attacks"],
      13: ["Indomitable (two uses)", "Studied Attacks"],
      17: ["Action Surge (two uses)", "Indomitable (three uses)"],
      19: ["Epic Boon"],
      20: ["Three Extra Attacks"],
    },
  },
  monk: {
    hitDie: 8,
    casterType: "none",
    savingThrows: ["str", "dex"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Martial Arts", "Unarmored Defense"],
      2: ["Monk's Focus", "Unarmored Movement", "Uncanny Metabolism"],
      3: ["Deflect Attacks", "Monk Subclass"],
      4: ["Slow Fall"],
      5: ["Extra Attack", "Stunning Strike"],
      6: ["Empowered Strikes"],
      7: ["Evasion"],
      9: ["Acrobatic Movement"],
      10: ["Heightened Focus", "Self-Restoration"],
      13: ["Deflect Energy"],
      14: ["Disciplined Survivor"],
      15: ["Perfect Focus"],
      18: ["Superior Defense"],
      19: ["Epic Boon"],
      20: ["Body and Mind"],
    },
  },
  paladin: {
    hitDie: 10,
    casterType: "half",
    spellcastingAbility: "cha",
    savingThrows: ["wis", "cha"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    weaponMastery: { 1: 2 },
    features: {
      1: ["Lay On Hands", "Spellcasting", "Weapon Mastery"],
      2: ["Fighting Style", "Paladin's Smite"],
      3: ["Channel Divinity", "Paladin Subclass"],
      5: ["Extra Attack", "Faithful Steed"],
      6: ["Aura of Protection"],
      9: ["Abjure Foes"],
      10: ["Aura of Courage"],
      11: ["Radiant Strikes"],
      14: ["Restoring Touch"],
      18: ["Aura Expansion"],
      19: ["Epic Boon"],
    },
  },
  ranger: {
    hitDie: 10,
    casterType: "half",
    spellcastingAbility: "wis",
    savingThrows: ["str", "dex"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    weaponMastery: { 1: 2 },
    features: {
      1: ["Spellcasting", "Favored Enemy", "Weapon Mastery"],
      2: ["Deft Explorer", "Fighting Style"],
      3: ["Ranger Subclass"],
      5: ["Extra Attack"],
      6: ["Roving"],
      9: ["Expertise"],
      10: ["Tireless"],
      13: ["Relentless Hunter"],
      14: ["Nature's Veil"],
      17: ["Precise Hunter"],
      18: ["Feral Senses"],
      19: ["Epic Boon"],
      20: ["Foe Slayer"],
    },
  },
  rogue: {
    hitDie: 8,
    casterType: "none",
    savingThrows: ["dex", "int"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: [4, 8, 10, 12, 16, 19],
    weaponMastery: { 1: 2 },
    features: {
      1: ["Expertise", "Sneak Attack", "Thieves' Cant", "Weapon Mastery"],
      2: ["Cunning Action"],
      3: ["Rogue Subclass", "Steady Aim"],
      5: ["Cunning Strike", "Uncanny Dodge"],
      6: ["Expertise"],
      7: ["Evasion", "Reliable Talent"],
      11: ["Improved Cunning Strike"],
      14: ["Devious Strikes"],
      15: ["Slippery Mind"],
      18: ["Elusive"],
      19: ["Epic Boon"],
      20: ["Stroke of Luck"],
    },
  },
  sorcerer: {
    hitDie: 6,
    casterType: "full",
    spellcastingAbility: "cha",
    savingThrows: ["con", "cha"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Innate Sorcery"],
      2: ["Font of Magic", "Metamagic"],
      3: ["Sorcerer Subclass"],
      5: ["Sorcerous Restoration"],
      7: ["Sorcery Incarnate"],
      10: ["Metamagic"],
      17: ["Metamagic"],
      19: ["Epic Boon"],
      20: ["Arcane Apotheosis"],
    },
  },
  warlock: {
    hitDie: 8,
    casterType: "pact",
    spellcastingAbility: "cha",
    savingThrows: ["wis", "cha"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Eldritch Invocations", "Pact Magic"],
      2: ["Magical Cunning"],
      3: ["Warlock Subclass"],
      9: ["Contact Patron"],
      11: ["Mystic Arcanum (level 6 spell)"],
      13: ["Mystic Arcanum (level 7 spell)"],
      15: ["Mystic Arcanum (level 8 spell)"],
      17: ["Mystic Arcanum (level 9 spell)"],
      19: ["Epic Boon"],
      20: ["Eldritch Master"],
    },
  },
  wizard: {
    hitDie: 6,
    casterType: "full",
    spellcastingAbility: "int",
    savingThrows: ["int", "wis"],
    subclassLevel: SUBCLASS_UNLOCK_LEVEL,
    asiLevels: STANDARD_ASI_LEVELS,
    features: {
      1: ["Spellcasting", "Ritual Adept", "Arcane Recovery"],
      2: ["Scholar"],
      3: ["Wizard Subclass"],
      5: ["Memorize Spell"],
      18: ["Spell Mastery"],
      19: ["Epic Boon"],
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
 * SRD 5.2.1 Full Caster spell slot table indexed by character level (`1..=20`),
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
 * SRD 5.2.1 Half Caster (Paladin, Ranger) spell slot table indexed by character
 * level (`1..=20`), mapping to a 5-element tuple of maximum slots for spell
 * levels 1 through 5. Both classes cast from level 1 under the 2024 rules.
 */
export const HALF_CASTER_SPELL_SLOTS: Record<number, number[]> = {
  1: [2, 0, 0, 0, 0],
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
 * One-third caster spell slot table (no SRD 5.2.1 class uses it; kept for
 * homebrew subclasses) indexed by character level (`1..=20`),
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
 * Returns the subclass unlock level for a given class: `3` for every SRD 5.2.1
 * class and for unknown classes.
 */
export function getSubclassUnlockLevel(classId?: string): number {
  return getClassProgression(classId)?.subclassLevel ?? SUBCLASS_UNLOCK_LEVEL;
}

/**
 * Number of weapon kinds a class masters at `characterLevel` (`0` for classes
 * without Weapon Mastery).
 */
export function getWeaponMasteryCount(classId: string | undefined, characterLevel: number): number {
  const table = getClassProgression(classId)?.weaponMastery;
  if (!table) return 0;
  let count = 0;
  for (const [level, kinds] of Object.entries(table)) {
    if (characterLevel >= Number(level)) count = Math.max(count, kinds);
  }
  return count;
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
 * Reconciles spell slot tiers against the canonical SRD 5.2.1 progression table for a given target level,
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
 * SRD 5.2.1 Warlock Pact Magic progression table indexed by character level (`1..=20`).
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
 * Whether `classId` has gained the class feature named `featureName`
 * (canonical English name, e.g. `"Fighting Style"`) by `characterLevel`.
 */
export function hasClassFeature(classId: string | undefined, characterLevel: number, featureName: string): boolean {
  const features = getClassProgression(classId)?.features ?? {};
  return Object.entries(features).some(
    ([level, names]) => Number(level) <= characterLevel && names.includes(featureName)
  );
}

function actorClassId(actor: Dnd5eActorData): string | undefined {
  return (actor.classId ?? actor.class ?? actor.attributes.classId ?? actor.attributes.class)?.toString();
}

function featSelectionContext(
  actor: Dnd5eActorData,
  classId: string | undefined,
  targetLevel: number
): FeatSelectionContext {
  return {
    targetLevel,
    abilities: Object.fromEntries(
      Object.entries(actor.abilities).map(([ab, { score }]) => [ab, score])
    ) as Record<AbilityId, number>,
    heldFeatIds: actor.features ?? [],
    hasSpellcasting: getCasterTypeForClass(classId) !== "none",
    hasFightingStyle: hasClassFeature(classId, targetLevel, "Fighting Style"),
  };
}

/**
 * SRD feats `actor` may take at the feat slot of `targetLevel` (defaults to
 * the next level), including Fighting Style feats for classes with the
 * Fighting Style feature. Returns `[]` when that level has no feat slot.
 */
export function getLevelUpFeatOptions(actor: Dnd5eActorData, targetLevel = actor.attributes.level + 1): SrdFeatId[] {
  const classId = actorClassId(actor);
  if (!isAsiLevel(targetLevel, classId)) return [];
  return getFeatSlotOptions(featSelectionContext(actor, classId, targetLevel));
}

/** Class and subclass features whose gain grants one Fighting Style feat. */
const FIGHTING_STYLE_FEATURES: ReadonlySet<string> = new Set(["Fighting Style", "Additional Fighting Style"]);

/**
 * Whether reaching `level` grants a Fighting Style feat: the Fighting Style
 * class feature (Fighter 1, Paladin 2, Ranger 2) or the Champion's Additional
 * Fighting Style (Fighter 7). Accepts bare or `srd:` prefixed ids.
 */
export function grantsFightingStyleFeat(classId: string | undefined, subclassId: string | undefined, level: number): boolean {
  const cls = classId?.replace(/^srd:class:/, "").toLowerCase();
  const sub = subclassId && (subclassId.startsWith("srd:subclass:") ? subclassId : `srd:subclass:${subclassId}`);
  return srdClassFeatures().some(
    (spec) =>
      spec.classId === cls &&
      spec.level === level &&
      FIGHTING_STYLE_FEATURES.has(spec.name) &&
      (!spec.subclassId || spec.subclassId === sub)
  );
}

/** Fighting Style feats (`srd:feat:<key>`) not already in `heldFeatIds`, in `SRD_FEATS` order. */
export function getFightingStyleFeatOptions(heldFeatIds: readonly string[]): string[] {
  const held = new Set(heldFeatIds.map(srdFeatKey));
  return (Object.keys(SRD_FEATS) as SrdFeatId[])
    .filter((key) => SRD_FEATS[key].category === "fighting_style" && !held.has(key))
    .map((key) => `srd:feat:${key}`);
}

/**
 * Validates a Fighting Style feat granted at `level` and returns its canonical
 * `srd:feat:<key>` id. Throws when the level grants none, the feat is not a
 * Fighting Style feat, or it is already held.
 */
function validateFightingStyleFeat(
  featId: string,
  heldFeatIds: readonly string[],
  classId: string | undefined,
  subclassId: string | undefined,
  level: number
): string {
  if (!grantsFightingStyleFeat(classId, subclassId, level)) {
    throw new Error("No Fighting Style feat at this level");
  }
  const canonical = `srd:feat:${srdFeatKey(featId) ?? ""}`;
  if (!getFightingStyleFeatOptions([]).includes(canonical)) {
    throw new Error("Invalid Fighting Style feat");
  }
  if (!getFightingStyleFeatOptions(heldFeatIds).includes(canonical)) {
    throw new Error("Feat already taken");
  }
  return canonical;
}

/**
 * Records a Fighting Style feat on `actor` (mutated): `features` and
 * `featsTaken` at `level`. Shared by `applyLevelUp` and `applyClassChoices`.
 */
export function recordFightingStyleFeat(
  actor: Dnd5eActorData,
  featId: string,
  classId: string | undefined,
  subclassId: string | undefined,
  level: number
): void {
  const canonical = validateFightingStyleFeat(featId, actor.features ?? [], classId, subclassId, level);
  actor.features = [...(actor.features ?? []), canonical];
  actor.featsTaken = [...(actor.featsTaken ?? []), { featId: canonical, level }];
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

  const hasSubclass = Boolean(actor.subclassId ?? actor.attributes.subclassId);
  if (targetLevel >= getSubclassUnlockLevel(classId) && !hasSubclass && !options.subclassId) {
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
  let featIncrease: AbilityId | undefined;
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
      featIncrease = validateFeatSelection(options.asiOrFeat.featId, {
        ...featSelectionContext(actor, classId, targetLevel),
        abilityIncrease: options.asiOrFeat.abilityIncrease,
      });
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
      clone.featsTaken = [...(clone.featsTaken ?? []), { featId: options.asiOrFeat.featId, level: targetLevel }];
      if (featIncrease) {
        clone.abilities[featIncrease].score += 1;
      }
    }
  }

  // 9. Calculate and apply HP increase (new level, retroactive CON, species bonus)
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
  hpGain += getSpeciesRules(actor.speciesId)?.hpBonusPerLevel ?? 0;
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

  // 10b. Fighting Style feat (Paladin/Ranger 2, Champion 7), once class and subclass are known
  if (options.fightingStyleFeatId !== undefined) {
    recordFightingStyleFeat(
      clone,
      options.fightingStyleFeatId,
      classId,
      clone.subclassId ?? clone.attributes.subclassId,
      targetLevel
    );
  }

  // 10c. Feature Hit Point maximum bonuses (Draconic Resilience)
  const featureHpGain = classFeatureHpMaxBonus(clone) - classFeatureHpMaxBonus(actor);
  clone.attributes.hp.max += featureHpGain;
  clone.attributes.hp.current += featureHpGain;

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
