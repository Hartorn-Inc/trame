/**
 * ============================================================================
 * SRD 5.2.1 CHARACTER ORIGINS: SPECIES, BACKGROUNDS & FEATS (origins.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Holds the rule data of the SRD 5.2.1 (2024 rules) character origin: the 9
 * species, the 4 SRD backgrounds plus 2 original TRAME backgrounds, and the
 * 17 SRD feats, together with the two origin transitions (`applyBackground`,
 * `validateFeatSelection`). `srdContent.ts` renders this data as compendium
 * entries and `progression.ts` enforces it on level-up, so a rule lives in
 * one place.
 *
 * Open Game Content Attribution:
 * This work includes material from the System Reference Document 5.2.1
 * ("SRD 5.2.1") by Wizards of the Coast LLC, available at
 * https://www.dndbeyond.com/srd, licensed under CC-BY-4.0.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Ability Increases Come From Backgrounds`:
 *      - Species grant no ability score increase. A background raises its
 *        three listed abilities by `+2/+1` (two different abilities) or
 *        `+1/+1/+1`, never above `20`.
 *   2. `Origin Feat Per Background`:
 *      - Every background grants exactly one Origin feat, and only SRD 5.2.1
 *        feats are referenced (Alert, Magic Initiate, Savage Attacker, Skilled).
 *   3. `SRD-Only Feats`:
 *      - `SRD_FEATS` holds exactly the 17 SRD 5.2.1 feats. Level-up checks
 *        their level / ability prerequisites, repeatability, and the `+1`
 *        ability increase of General feats (cap `20`) and Epic Boons (cap `30`).
 *        Fighting Style feats come from class features, never from an ASI.
 *   4. `Original Backgrounds`:
 *      - Caravan Guide and Lamplighter are TRAME originals built with the same
 *        shape (three abilities, one Origin feat, two skills, one tool,
 *        equipment or 50 GP) to replace non-SRD Folk Hero and Noble.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `applyBackground(actor, backgroundId, choice)`
 *     ├── 1. Resolve the background and validate the `+2/+1` or `+1/+1/+1` choice.
 *     ├── 2. Raise ability scores (cap 20) and add the retroactive CON HP delta.
 *     ├── 3. Grant the two skill proficiencies and record the Origin feat.
 *     └── 4. Recompute derived statistics through the WASM evaluator.
 * ============================================================================
 */

import type { AbilityId, Dnd5eActorData, SkillId } from "./types.ts";
import { computeDnd5eSheetDerived } from "./manifest.ts";

// ============================================================================
// SPECIES
// ============================================================================

/** Rule data of one SRD 5.2.1 species. Species never raise ability scores. */
export interface SpeciesRules {
  /** Creature size; Human and Tiefling choose Medium or Small. */
  size: "Medium" | "Small" | "Medium or Small";
  /** Walking speed in feet. */
  speedFt: number;
  /** Darkvision range in feet (`0` when none). */
  darkvisionFt: number;
  /** Extra Hit Points per character level (Dwarven Toughness: `1`). */
  hpBonusPerLevel: number;
  /** Trait names (English, canonical). */
  traits: readonly string[];
}

/** Keys of the 9 SRD 5.2.1 species (without the `srd:species:` prefix). */
export type SrdSpeciesId =
  | "dragonborn"
  | "dwarf"
  | "elf"
  | "gnome"
  | "goliath"
  | "halfling"
  | "human"
  | "orc"
  | "tiefling";

/** The 9 SRD 5.2.1 species. */
export const SRD_SPECIES: Readonly<Record<SrdSpeciesId, SpeciesRules>> = {
  dragonborn: {
    size: "Medium",
    speedFt: 30,
    darkvisionFt: 60,
    hpBonusPerLevel: 0,
    traits: ["Draconic Ancestry", "Breath Weapon", "Damage Resistance", "Darkvision", "Draconic Flight"],
  },
  dwarf: {
    size: "Medium",
    speedFt: 30,
    darkvisionFt: 120,
    hpBonusPerLevel: 1,
    traits: ["Darkvision", "Dwarven Resilience", "Dwarven Toughness", "Stonecunning"],
  },
  elf: {
    size: "Medium",
    speedFt: 30,
    darkvisionFt: 60,
    hpBonusPerLevel: 0,
    traits: ["Darkvision", "Elven Lineage", "Fey Ancestry", "Keen Senses", "Trance"],
  },
  gnome: {
    size: "Small",
    speedFt: 30,
    darkvisionFt: 60,
    hpBonusPerLevel: 0,
    traits: ["Darkvision", "Gnomish Cunning", "Gnomish Lineage"],
  },
  goliath: {
    size: "Medium",
    speedFt: 35,
    darkvisionFt: 0,
    hpBonusPerLevel: 0,
    traits: ["Giant Ancestry", "Large Form", "Powerful Build"],
  },
  halfling: {
    size: "Small",
    speedFt: 30,
    darkvisionFt: 0,
    hpBonusPerLevel: 0,
    traits: ["Brave", "Halfling Nimbleness", "Luck", "Naturally Stealthy"],
  },
  human: {
    size: "Medium or Small",
    speedFt: 30,
    darkvisionFt: 0,
    hpBonusPerLevel: 0,
    traits: ["Resourceful", "Skillful", "Versatile"],
  },
  orc: {
    size: "Medium",
    speedFt: 30,
    darkvisionFt: 120,
    hpBonusPerLevel: 0,
    traits: ["Adrenaline Rush", "Darkvision", "Relentless Endurance"],
  },
  tiefling: {
    size: "Medium or Small",
    speedFt: 30,
    darkvisionFt: 60,
    hpBonusPerLevel: 0,
    traits: ["Darkvision", "Fiendish Legacy", "Otherworldly Presence"],
  },
};

/** Resolves `"dwarf"` or `"srd:species:dwarf"` to its rules, or `undefined`. */
export function getSpeciesRules(speciesId?: string): SpeciesRules | undefined {
  if (!speciesId) return undefined;
  const key = speciesId.replace(/^srd:species:/, "").toLowerCase();
  return Object.hasOwn(SRD_SPECIES, key) ? SRD_SPECIES[key as SrdSpeciesId] : undefined;
}

// ============================================================================
// FEATS
// ============================================================================

/** SRD 5.2.1 feat categories. */
export type FeatCategory = "origin" | "general" | "fighting_style" | "epic_boon";

/** Rule data of one SRD 5.2.1 feat. */
export interface FeatRules {
  /** Feat category. Fighting Style feats are only granted by class features. */
  category: FeatCategory;
  /** Minimum character level to take the feat (`4` for General, `19` for Epic Boons). */
  minLevel: number;
  /** When set, at least one of these abilities must be `>= 13` (Grappler: STR or DEX). */
  prerequisiteAbilities?: readonly AbilityId[];
  /** Requires the Spellcasting or Pact Magic feature (Boon of Spell Recall). */
  requiresSpellcasting?: boolean;
  /** Whether the feat can be taken more than once. */
  repeatable: boolean;
  /** `+1` increase granted by the feat: allowed abilities and the score cap. */
  abilityIncrease?: { abilities: readonly AbilityId[]; max: 20 | 30 };
  /** English benefit summary. */
  benefit: string;
}

const ALL_ABILITIES: readonly AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

const EPIC_BOON_INCREASE = { abilities: ALL_ABILITIES, max: 30 } as const;

/** Keys of the 17 SRD 5.2.1 feats (without the `srd:feat:` prefix). */
export type SrdFeatId =
  | "alert"
  | "magic_initiate"
  | "savage_attacker"
  | "skilled"
  | "ability_score_improvement"
  | "grappler"
  | "archery"
  | "defense"
  | "great_weapon_fighting"
  | "two_weapon_fighting"
  | "boon_of_combat_prowess"
  | "boon_of_dimensional_travel"
  | "boon_of_fate"
  | "boon_of_irresistible_offense"
  | "boon_of_spell_recall"
  | "boon_of_the_night_spirit"
  | "boon_of_truesight";

/** Exactly the 17 SRD 5.2.1 feats. */
export const SRD_FEATS: Readonly<Record<SrdFeatId, FeatRules>> = {
  alert: {
    category: "origin",
    minLevel: 1,
    repeatable: false,
    benefit: "Add your Proficiency Bonus to Initiative rolls and swap Initiative with a willing ally.",
  },
  magic_initiate: {
    category: "origin",
    minLevel: 1,
    repeatable: true,
    benefit: "Learn two cantrips and one level 1 spell from the Cleric, Druid or Wizard list.",
  },
  savage_attacker: {
    category: "origin",
    minLevel: 1,
    repeatable: false,
    benefit: "Once per turn when you hit with a weapon, roll its damage dice twice and use either roll.",
  },
  skilled: {
    category: "origin",
    minLevel: 1,
    repeatable: true,
    benefit: "Gain proficiency in any combination of three skills or tools.",
  },
  ability_score_improvement: {
    category: "general",
    minLevel: 4,
    repeatable: true,
    benefit: "Increase one ability score by 2, or two ability scores by 1, to a maximum of 20.",
  },
  grappler: {
    category: "general",
    minLevel: 4,
    prerequisiteAbilities: ["str", "dex"],
    repeatable: false,
    abilityIncrease: { abilities: ["str", "dex"], max: 20 },
    benefit: "Increase Strength or Dexterity by 1; punch and grab in one attack and drag grappled foes easily.",
  },
  archery: {
    category: "fighting_style",
    minLevel: 1,
    repeatable: false,
    benefit: "Gain a +2 bonus to attack rolls with Ranged weapons.",
  },
  defense: {
    category: "fighting_style",
    minLevel: 1,
    repeatable: false,
    benefit: "Gain a +1 bonus to Armor Class while wearing Light, Medium or Heavy armor.",
  },
  great_weapon_fighting: {
    category: "fighting_style",
    minLevel: 1,
    repeatable: false,
    benefit: "Treat any 1 or 2 on a damage die of a two-handed melee weapon attack as a 3.",
  },
  two_weapon_fighting: {
    category: "fighting_style",
    minLevel: 1,
    repeatable: false,
    benefit: "Add your ability modifier to the damage of the extra attack of a Light weapon.",
  },
  boon_of_combat_prowess: {
    category: "epic_boon",
    minLevel: 19,
    repeatable: false,
    abilityIncrease: EPIC_BOON_INCREASE,
    benefit: "Increase one ability by 1 (max 30); once per turn, turn a missed attack into a hit.",
  },
  boon_of_dimensional_travel: {
    category: "epic_boon",
    minLevel: 19,
    repeatable: false,
    abilityIncrease: EPIC_BOON_INCREASE,
    benefit: "Increase one ability by 1 (max 30); teleport 30 feet after the Attack or Magic action.",
  },
  boon_of_fate: {
    category: "epic_boon",
    minLevel: 19,
    repeatable: false,
    abilityIncrease: EPIC_BOON_INCREASE,
    benefit: "Increase one ability by 1 (max 30); add or subtract 2d4 to a nearby D20 Test.",
  },
  boon_of_irresistible_offense: {
    category: "epic_boon",
    minLevel: 19,
    repeatable: false,
    abilityIncrease: { abilities: ["str", "dex"], max: 30 },
    benefit: "Increase Strength or Dexterity by 1 (max 30); your B/P/S damage ignores Resistance.",
  },
  boon_of_spell_recall: {
    category: "epic_boon",
    minLevel: 19,
    requiresSpellcasting: true,
    repeatable: false,
    abilityIncrease: { abilities: ["int", "wis", "cha"], max: 30 },
    benefit: "Increase Intelligence, Wisdom or Charisma by 1 (max 30); low slots may not be expended.",
  },
  boon_of_the_night_spirit: {
    category: "epic_boon",
    minLevel: 19,
    repeatable: false,
    abilityIncrease: EPIC_BOON_INCREASE,
    benefit: "Increase one ability by 1 (max 30); become Invisible in dim light or darkness.",
  },
  boon_of_truesight: {
    category: "epic_boon",
    minLevel: 19,
    repeatable: false,
    abilityIncrease: EPIC_BOON_INCREASE,
    benefit: "Increase one ability by 1 (max 30); gain Truesight with a range of 60 feet.",
  },
};

/** Resolves `"alert"` or `"srd:feat:alert"` to `"alert"`, or `undefined` for non-SRD feats. */
export function srdFeatKey(featId: string): SrdFeatId | undefined {
  const key = featId.replace(/^srd:feat:/, "");
  return Object.hasOwn(SRD_FEATS, key) ? (key as SrdFeatId) : undefined;
}

/** Context needed to validate a feat taken on level-up. */
export interface FeatSelectionContext {
  /** Level being reached. */
  targetLevel: number;
  /** Current ability scores of the actor. */
  abilities: Record<AbilityId, number>;
  /** Feat identifiers already held. */
  heldFeatIds: readonly string[];
  /** Whether the actor has the Spellcasting or Pact Magic feature. */
  hasSpellcasting: boolean;
  /** Ability chosen for the feat's `+1` increase, if any. */
  abilityIncrease?: AbilityId;
}

/**
 * Validates an SRD feat chosen on level-up and returns the ability it raises
 * (or `undefined`). Non-SRD (homebrew) feat ids pass without checks.
 * Throws on unmet level/ability/spellcasting prerequisites, Fighting Style
 * feats, repeated non-repeatable feats, and missing or invalid increases.
 */
export function validateFeatSelection(featId: string, ctx: FeatSelectionContext): AbilityId | undefined {
  const key = srdFeatKey(featId);
  if (!key) return undefined;
  const feat = SRD_FEATS[key];
  if (feat.category === "fighting_style") {
    throw new Error("Fighting Style feats are granted by class features");
  }
  if (key === "ability_score_improvement") {
    throw new Error("Use the ASI selection for Ability Score Improvement");
  }
  if (ctx.targetLevel < feat.minLevel) {
    throw new Error("Feat prerequisite not met");
  }
  if (feat.prerequisiteAbilities && !feat.prerequisiteAbilities.some((ab) => ctx.abilities[ab] >= 13)) {
    throw new Error("Feat prerequisite not met");
  }
  if (feat.requiresSpellcasting && !ctx.hasSpellcasting) {
    throw new Error("Feat prerequisite not met");
  }
  if (!feat.repeatable && ctx.heldFeatIds.some((held) => srdFeatKey(held) === key)) {
    throw new Error("Feat already taken");
  }
  if (!feat.abilityIncrease) return undefined;
  const ability = ctx.abilityIncrease;
  if (!ability || !feat.abilityIncrease.abilities.includes(ability)) {
    throw new Error("Invalid feat ability increase");
  }
  if (ctx.abilities[ability] + 1 > feat.abilityIncrease.max) {
    throw new Error(`Ability score cannot exceed ${feat.abilityIncrease.max}`);
  }
  return ability;
}

// ============================================================================
// BACKGROUNDS
// ============================================================================

/** Rule data of one background. */
export interface BackgroundRules {
  /** The three abilities a background may raise. */
  abilities: readonly [AbilityId, AbilityId, AbilityId];
  /** Origin feat granted at level 1 (an SRD feat id). */
  originFeat: `srd:feat:${SrdFeatId}`;
  /** Spell list for Magic Initiate, when that is the origin feat. */
  originFeatSpellList?: "cleric" | "druid" | "wizard";
  /** The two skill proficiencies granted. */
  skillProficiencies: readonly [SkillId, SkillId];
  /** The tool proficiency granted. */
  toolProficiency: string;
  /** Equipment option A (option B is always 50 GP). */
  equipment: readonly string[];
  /** `"srd"` for SRD 5.2.1 backgrounds, `"trame-original"` for original ones. */
  source: "srd" | "trame-original";
}

/** Keys of the 6 backgrounds (without the `srd:background:` prefix). */
export type BackgroundId = "acolyte" | "criminal" | "sage" | "soldier" | "caravan_guide" | "lamplighter";

/** SRD 5.2.1 Acolyte, Criminal, Sage and Soldier, plus two TRAME originals. */
export const BACKGROUNDS: Readonly<Record<BackgroundId, BackgroundRules>> = {
  acolyte: {
    abilities: ["int", "wis", "cha"],
    originFeat: "srd:feat:magic_initiate",
    originFeatSpellList: "cleric",
    skillProficiencies: ["insight", "religion"],
    toolProficiency: "Calligrapher's Supplies",
    equipment: ["Calligrapher's Supplies", "Book (prayers)", "Holy Symbol", "Parchment (10 sheets)", "Robe", "8 GP"],
    source: "srd",
  },
  criminal: {
    abilities: ["dex", "con", "int"],
    originFeat: "srd:feat:alert",
    skillProficiencies: ["sleight_of_hand", "stealth"],
    toolProficiency: "Thieves' Tools",
    equipment: ["2 Daggers", "Thieves' Tools", "Crowbar", "2 Pouches", "Traveler's Clothes", "16 GP"],
    source: "srd",
  },
  sage: {
    abilities: ["con", "int", "wis"],
    originFeat: "srd:feat:magic_initiate",
    originFeatSpellList: "wizard",
    skillProficiencies: ["arcana", "history"],
    toolProficiency: "Calligrapher's Supplies",
    equipment: ["Quarterstaff", "Calligrapher's Supplies", "Book (history)", "Parchment (8 sheets)", "Robe", "8 GP"],
    source: "srd",
  },
  soldier: {
    abilities: ["str", "dex", "con"],
    originFeat: "srd:feat:savage_attacker",
    skillProficiencies: ["athletics", "intimidation"],
    toolProficiency: "Gaming Set (one kind)",
    equipment: ["Spear", "Shortbow", "20 Arrows", "Gaming Set", "Healer's Kit", "Quiver", "Traveler's Clothes", "14 GP"],
    source: "srd",
  },
  caravan_guide: {
    abilities: ["str", "con", "wis"],
    originFeat: "srd:feat:skilled",
    skillProficiencies: ["animal_handling", "survival"],
    toolProficiency: "Cartographer's Tools",
    equipment: ["Cartographer's Tools", "Bedroll", "Hempen Rope", "Lantern", "Traveler's Clothes", "12 GP"],
    source: "trame-original",
  },
  lamplighter: {
    abilities: ["dex", "int", "wis"],
    originFeat: "srd:feat:alert",
    skillProficiencies: ["investigation", "perception"],
    toolProficiency: "Tinker's Tools",
    equipment: ["Tinker's Tools", "Hooded Lantern", "2 Flasks of Oil", "Tinderbox", "Traveler's Clothes", "15 GP"],
    source: "trame-original",
  },
};

/** Resolves `"sage"` or `"srd:background:sage"` to its rules, or `undefined`. */
export function getBackgroundRules(backgroundId?: string): BackgroundRules | undefined {
  if (!backgroundId) return undefined;
  const key = backgroundId.replace(/^srd:background:/, "").toLowerCase();
  return Object.hasOwn(BACKGROUNDS, key) ? BACKGROUNDS[key as BackgroundId] : undefined;
}

/**
 * Background ability score choice:
 * - `"plus2_plus1"`: `+2` to `plus2` and `+1` to `plus1` (two different listed abilities).
 * - `"plus1_each"`: `+1` to each of the three listed abilities.
 */
export type BackgroundAbilityChoice =
  | { mode: "plus2_plus1"; plus2: AbilityId; plus1: AbilityId }
  | { mode: "plus1_each" };

/** Ability increases (`AbilityId -> +N`) produced by `choice` for `background`. */
export function backgroundAbilityIncreases(
  background: BackgroundRules,
  choice: BackgroundAbilityChoice
): Partial<Record<AbilityId, number>> {
  if (choice.mode === "plus1_each") {
    return Object.fromEntries(background.abilities.map((ab) => [ab, 1]));
  }
  if (
    choice.plus2 === choice.plus1 ||
    !background.abilities.includes(choice.plus2) ||
    !background.abilities.includes(choice.plus1)
  ) {
    throw new Error("Invalid background ability choice");
  }
  return { [choice.plus2]: 2, [choice.plus1]: 1 };
}

/**
 * Applies `backgroundId` to a new character: raises abilities per `choice`
 * (cap `20`, with the retroactive CON HP delta for every level), grants the
 * two skill proficiencies, records the background and its Origin feat, and
 * recomputes derived statistics. Throws on unknown backgrounds, a second
 * background, invalid choices or scores above 20.
 */
export function applyBackground(
  actor: Dnd5eActorData,
  backgroundId: string,
  choice: BackgroundAbilityChoice
): Dnd5eActorData {
  const background = getBackgroundRules(backgroundId);
  if (!background) {
    throw new Error(`Unknown background: ${backgroundId}`);
  }
  if (actor.backgroundId) {
    throw new Error("Background already applied");
  }
  const increases = backgroundAbilityIncreases(background, choice);
  for (const [ab, bonus] of Object.entries(increases) as [AbilityId, number][]) {
    if (actor.abilities[ab].score + bonus > 20) {
      throw new Error("Ability score cannot exceed 20");
    }
  }

  const clone: Dnd5eActorData = structuredClone(actor);
  const previousConMod = Math.floor((clone.abilities.con.score - 10) / 2);
  for (const [ab, bonus] of Object.entries(increases) as [AbilityId, number][]) {
    clone.abilities[ab].score += bonus;
  }
  const hpDelta = (Math.floor((clone.abilities.con.score - 10) / 2) - previousConMod) * clone.attributes.level;
  clone.attributes.hp.max += hpDelta;
  clone.attributes.hp.current += hpDelta;

  for (const skill of background.skillProficiencies) {
    const entry = clone.skills[skill];
    if (entry.proficiencyRank === 0) {
      entry.proficiencyRank = 1;
    }
  }
  clone.backgroundId = `srd:background:${backgroundId.replace(/^srd:background:/, "").toLowerCase()}`;
  clone.features = [...(clone.features ?? []), background.originFeat];
  clone.derived = computeDnd5eSheetDerived(clone);
  return clone;
}
