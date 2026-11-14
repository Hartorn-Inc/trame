/**
 * ============================================================================
 * SRD 5.2.1 CLASS CREATION RULES (classRules.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Holds the level-1 creation data of the 12 SRD 5.2.1 classes that
 * `progression.ts` (hit die, saves, slots, features) does not: skill choices,
 * armor training, weapon and tool proficiencies, starting equipment options,
 * and the cantrips-known / prepared-spells tables. Without it the builder
 * cannot offer class skills or equipment, attacks have no proficiency to
 * check, and a level-1 caster has no spell counts (GS5, GS12, UA13).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Tables Are Data, Not Formulas`:
 *      - Spell counts are the SRD class tables indexed by level (`1..=20`);
 *        numeric rules (modifiers, DC, AC) stay in the `system.json` DAG.
 *   2. `Equipment By Name`:
 *      - Starting equipment names match compendium names after dropping a
 *        leading count (`"4 Handaxes"` -> `Handaxe` x4), so the generated
 *        catalog can grow without editing this table.
 *   3. `Proficiency Fallback`:
 *      - `getActorProficiencies` returns the actor's lists or, for actors
 *        created before proficiencies were stored, its class's lists.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `getActorProficiencies(actor)`
 *     ├── 1. Return `actor.proficiencies` when present.
 *     └── 2. Otherwise return the class's armor/weapon/tool lists (or empty lists).
 * ============================================================================
 */

import { getClassProgression, type SrdClassId } from "./progression.ts";
import type { ArmorTraining, Dnd5eActorData, ProficiencyLists, SkillId, WeaponProficiency } from "./types.ts";

/** SRD 5.2.1 Musical Instruments (a Bard picks three, a Monk may pick one). */
export const MUSICAL_INSTRUMENTS: readonly string[] = [
  "Bagpipes",
  "Drum",
  "Dulcimer",
  "Flute",
  "Horn",
  "Lute",
  "Lyre",
  "Pan Flute",
  "Shawm",
  "Viol",
];

/** SRD 5.2.1 Artisan's Tools. */
export const ARTISAN_TOOLS: readonly string[] = [
  "Alchemist's Supplies",
  "Brewer's Supplies",
  "Calligrapher's Supplies",
  "Carpenter's Tools",
  "Cartographer's Tools",
  "Cobbler's Tools",
  "Cook's Utensils",
  "Glassblower's Tools",
  "Jeweler's Tools",
  "Leatherworker's Tools",
  "Mason's Tools",
  "Painter's Supplies",
  "Potter's Tools",
  "Smith's Tools",
  "Tinker's Tools",
  "Weaver's Tools",
  "Woodcarver's Tools",
];

/** One starting equipment option: items (names as in the SRD) plus gold. */
export interface StartingEquipmentOption {
  /** Option letter shown by the SRD (`"A"`, `"B"`, `"C"`). */
  id: string;
  /** Item names, a leading count meaning quantity (`"4 Handaxes"`). */
  items: readonly string[];
  /** Gold pieces granted with the option (`GP`). */
  gp: number;
}

/** Level-1 creation rules of one class. */
export interface ClassStartingRules {
  /** Skill proficiencies: pick `count` of `options`. */
  skillChoices: { count: number; options: readonly SkillId[] };
  /** Armor training. */
  armor: readonly ArmorTraining[];
  /** Weapon proficiencies. */
  weapons: readonly WeaponProficiency[];
  /** Fixed tool proficiencies. */
  tools: readonly string[];
  /** Tool proficiencies to pick (Bard: 3 instruments, Monk: 1 artisan tool or instrument). */
  toolChoices?: { count: number; options: readonly string[] };
  /** Starting equipment options; the last one is gold only. */
  equipment: readonly StartingEquipmentOption[];
  /** Cantrips known at each level (`index = level - 1`); absent without cantrips. */
  cantripsKnown?: readonly number[];
  /** Spells prepared at each level (`index = level - 1`); absent for non-casters. */
  preparedSpells?: readonly number[];
  /** Level-1 spells written in a Wizard's spellbook (more than it prepares). */
  spellbookAtLevel1?: number;
}

const ALL_SKILLS: readonly SkillId[] = [
  "acrobatics",
  "animal_handling",
  "arcana",
  "athletics",
  "deception",
  "history",
  "insight",
  "intimidation",
  "investigation",
  "medicine",
  "nature",
  "perception",
  "performance",
  "persuasion",
  "religion",
  "sleight_of_hand",
  "stealth",
  "survival",
];

/** Cantrips known by level for 2 / 3 / 4 progressions (rising at levels 4 and 10). */
function cantripTable(atLevel1: number): number[] {
  return Array.from({ length: 20 }, (_, i) => atLevel1 + (i + 1 >= 4 ? 1 : 0) + (i + 1 >= 10 ? 1 : 0));
}

const FULL_CASTER_PREPARED = [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22];
const HALF_CASTER_PREPARED = [2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15];

/** SRD 5.2.1 level-1 creation rules of the 12 classes. */
export const SRD_CLASS_STARTING_RULES: Readonly<Record<SrdClassId, ClassStartingRules>> = {
  barbarian: {
    skillChoices: { count: 2, options: ["animal_handling", "athletics", "intimidation", "nature", "perception", "survival"] },
    armor: ["light", "medium", "shield"],
    weapons: ["simple", "martial"],
    tools: [],
    equipment: [
      { id: "A", items: ["Greataxe", "4 Handaxes", "Explorer's Pack"], gp: 15 },
      { id: "B", items: [], gp: 75 },
    ],
  },
  bard: {
    skillChoices: { count: 3, options: ALL_SKILLS },
    armor: ["light"],
    weapons: ["simple"],
    tools: [],
    toolChoices: { count: 3, options: MUSICAL_INSTRUMENTS },
    equipment: [
      { id: "A", items: ["Leather Armor", "2 Daggers", "Musical Instrument", "Entertainer's Pack"], gp: 19 },
      { id: "B", items: [], gp: 90 },
    ],
    cantripsKnown: cantripTable(2),
    preparedSpells: FULL_CASTER_PREPARED,
  },
  cleric: {
    skillChoices: { count: 2, options: ["history", "insight", "medicine", "persuasion", "religion"] },
    armor: ["light", "medium", "shield"],
    weapons: ["simple"],
    tools: [],
    equipment: [
      { id: "A", items: ["Chain Shirt", "Shield", "Mace", "Holy Symbol", "Priest's Pack"], gp: 7 },
      { id: "B", items: [], gp: 110 },
    ],
    cantripsKnown: cantripTable(3),
    preparedSpells: FULL_CASTER_PREPARED,
  },
  druid: {
    skillChoices: {
      count: 2,
      options: ["arcana", "animal_handling", "insight", "medicine", "nature", "perception", "religion", "survival"],
    },
    armor: ["light", "shield"],
    weapons: ["simple"],
    tools: ["Herbalism Kit"],
    equipment: [
      { id: "A", items: ["Leather Armor", "Shield", "Sickle", "Quarterstaff", "Explorer's Pack", "Herbalism Kit"], gp: 9 },
      { id: "B", items: [], gp: 50 },
    ],
    cantripsKnown: cantripTable(2),
    preparedSpells: FULL_CASTER_PREPARED,
  },
  fighter: {
    skillChoices: {
      count: 2,
      options: ["acrobatics", "animal_handling", "athletics", "history", "insight", "intimidation", "persuasion", "perception", "survival"],
    },
    armor: ["light", "medium", "heavy", "shield"],
    weapons: ["simple", "martial"],
    tools: [],
    equipment: [
      { id: "A", items: ["Chain Mail", "Greatsword", "Flail", "8 Javelins", "Dungeoneer's Pack"], gp: 4 },
      {
        id: "B",
        items: ["Studded Leather Armor", "Scimitar", "Shortsword", "Longbow", "20 Arrows", "Quiver", "Dungeoneer's Pack"],
        gp: 11,
      },
      { id: "C", items: [], gp: 155 },
    ],
  },
  monk: {
    skillChoices: { count: 2, options: ["acrobatics", "athletics", "history", "insight", "religion", "stealth"] },
    armor: [],
    weapons: ["simple", "martial_light"],
    tools: [],
    toolChoices: { count: 1, options: [...ARTISAN_TOOLS, ...MUSICAL_INSTRUMENTS] },
    equipment: [
      { id: "A", items: ["Spear", "5 Daggers", "Explorer's Pack"], gp: 11 },
      { id: "B", items: [], gp: 50 },
    ],
  },
  paladin: {
    skillChoices: { count: 2, options: ["athletics", "insight", "intimidation", "medicine", "persuasion", "religion"] },
    armor: ["light", "medium", "heavy", "shield"],
    weapons: ["simple", "martial"],
    tools: [],
    equipment: [
      { id: "A", items: ["Chain Mail", "Shield", "Longsword", "6 Javelins", "Holy Symbol", "Priest's Pack"], gp: 9 },
      { id: "B", items: [], gp: 150 },
    ],
    preparedSpells: HALF_CASTER_PREPARED,
  },
  ranger: {
    skillChoices: {
      count: 3,
      options: ["animal_handling", "athletics", "insight", "investigation", "nature", "perception", "stealth", "survival"],
    },
    armor: ["light", "medium", "shield"],
    weapons: ["simple", "martial"],
    tools: [],
    equipment: [
      {
        id: "A",
        items: ["Studded Leather Armor", "Scimitar", "Shortsword", "Longbow", "20 Arrows", "Quiver", "Druidic Focus", "Explorer's Pack"],
        gp: 7,
      },
      { id: "B", items: [], gp: 150 },
    ],
    preparedSpells: HALF_CASTER_PREPARED,
  },
  rogue: {
    skillChoices: {
      count: 4,
      options: [
        "acrobatics",
        "athletics",
        "deception",
        "insight",
        "intimidation",
        "investigation",
        "perception",
        "persuasion",
        "sleight_of_hand",
        "stealth",
      ],
    },
    armor: ["light"],
    weapons: ["simple", "martial_finesse_or_light"],
    tools: ["Thieves' Tools"],
    equipment: [
      {
        id: "A",
        items: ["Leather Armor", "2 Daggers", "Shortsword", "Shortbow", "20 Arrows", "Quiver", "Thieves' Tools", "Burglar's Pack"],
        gp: 8,
      },
      { id: "B", items: [], gp: 100 },
    ],
  },
  sorcerer: {
    skillChoices: { count: 2, options: ["arcana", "deception", "insight", "intimidation", "persuasion", "religion"] },
    armor: [],
    weapons: ["simple"],
    tools: [],
    equipment: [
      { id: "A", items: ["Spear", "2 Daggers", "Arcane Focus", "Dungeoneer's Pack"], gp: 28 },
      { id: "B", items: [], gp: 50 },
    ],
    cantripsKnown: cantripTable(4),
    preparedSpells: [2, 4, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22],
  },
  warlock: {
    skillChoices: { count: 2, options: ["arcana", "deception", "history", "intimidation", "investigation", "nature", "religion"] },
    armor: ["light"],
    weapons: ["simple"],
    tools: [],
    equipment: [
      { id: "A", items: ["Leather Armor", "Sickle", "2 Daggers", "Arcane Focus", "Book", "Scholar's Pack"], gp: 15 },
      { id: "B", items: [], gp: 100 },
    ],
    cantripsKnown: cantripTable(2),
    preparedSpells: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15],
  },
  wizard: {
    skillChoices: { count: 2, options: ["arcana", "history", "insight", "investigation", "medicine", "nature", "religion"] },
    armor: [],
    weapons: ["simple"],
    tools: [],
    equipment: [
      { id: "A", items: ["2 Daggers", "Quarterstaff", "Robe", "Spellbook", "Scholar's Pack"], gp: 5 },
      { id: "B", items: [], gp: 55 },
    ],
    cantripsKnown: cantripTable(3),
    preparedSpells: [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 18, 19, 21, 22, 23, 24, 25],
    spellbookAtLevel1: 6,
  },
};

/** Resolves `"wizard"` / `"srd:class:wizard"` (any case) to its creation rules. */
export function getClassStartingRules(classId?: string): ClassStartingRules | undefined {
  if (!getClassProgression(classId)) return undefined;
  return SRD_CLASS_STARTING_RULES[classId!.replace(/^srd:class:/, "").toLowerCase() as SrdClassId];
}

function tableValue(table: readonly number[] | undefined, level: number): number {
  return table?.[Math.min(20, Math.max(1, Math.trunc(level))) - 1] ?? 0;
}

/** Cantrips a class knows at `level` (`0` for classes without cantrips). */
export function getCantripsKnown(classId: string | undefined, level: number): number {
  return tableValue(getClassStartingRules(classId)?.cantripsKnown, level);
}

/** Spells a class prepares at `level` (`0` for non-casters). */
export function getPreparedSpellCount(classId: string | undefined, level: number): number {
  return tableValue(getClassStartingRules(classId)?.preparedSpells, level);
}

/** Primary class id of an actor (`classId`, `class`, then the attribute aliases). */
export function getActorClassId(actor: Dnd5eActorData): string | undefined {
  return (actor.classId ?? actor.class ?? actor.attributes.classId ?? actor.attributes.class)?.toString();
}

/**
 * Armor, weapon and tool proficiencies of `actor`: its stored lists, or its
 * class's starting lists when none are stored. Always returns fresh arrays.
 */
export function getActorProficiencies(actor: Dnd5eActorData): ProficiencyLists {
  if (actor.proficiencies) {
    return {
      armor: [...actor.proficiencies.armor],
      weapons: [...actor.proficiencies.weapons],
      tools: [...actor.proficiencies.tools],
    };
  }
  const rules = getClassStartingRules(getActorClassId(actor));
  return { armor: [...(rules?.armor ?? [])], weapons: [...(rules?.weapons ?? [])], tools: [...(rules?.tools ?? [])] };
}
