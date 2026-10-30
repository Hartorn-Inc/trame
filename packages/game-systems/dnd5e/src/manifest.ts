/**
 * ============================================================================
 * D&D 5E DECLARATIVE GAME SYSTEM MANIFEST & DERIVED STATS (manifest.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Declares the D&D 5e (SRD 5.1 CC-BY-4.0) `GameSystemManifest`—including the
 * canonical 18-skill registry and topological formula DAG—and implements the
 * deterministic derived-stat evaluator (`computeDnd5eSheetDerived`) for both
 * `Dnd5eActorData` and `Dnd5eActorSheet` representations.
 *
 * Open Game Content Attribution:
 * This work includes material from the System Reference Document 5.1 ("SRD 5.1")
 * by Wizards of the Coast LLC, available under the Creative Commons Attribution 4.0
 * International License (CC-BY-4.0).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Acyclic Derived Formula Graph`:
 *      - `DND5E_SRD51_MANIFEST.derivedDAG` orders nodes topologically from base
 *        ability scores and level (`str`..`cha`, `level`) to first-order
 *        modifiers (`*_mod`, `proficiency_bonus`) and second-order combat metrics
 *        (`initiative_bonus`, `spell_save_dc_*`), preventing circular evaluation.
 *   2. `Level Clamping Guard`:
 *      - `computeDnd5eSheetDerived` clamps actor level to integer bounds `[1, 20]`
 *        via `Math.max(1, Math.min(20, Math.trunc(level)))` before computing
 *        proficiency bonus (`floor((level - 1) / 4) + 2`), preventing out-of-range
 *        levels from corrupting saving throws, skills, or spell DCs.
 *   3. `Dual-Representation Parity`:
 *      - Supports both nested `Dnd5eActorData` (with encumbrance thresholds in `lb`)
 *        and flat `Dnd5eActorSheet` (with unarmored Barbarian/Monk defenses and
 *        2024-style exhaustion `-2 * level` d20 penalties).
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `computeDnd5eSheetDerived(actor)`
 *     ├── 1. Discriminate `Dnd5eActorData` (`"attributes" in actor`) vs `Dnd5eActorSheet`.
 *     ├── 2. Clamp level to `1..=20` and compute `proficiencyBonus` (`+2` to `+6`).
 *     ├── 3. Compute six ability modifiers via `floor((score - 10) / 2)`.
 *     ├── 4. Project saving throws, 18 skill totals, and passive scores (`10 + skill`).
 *     └── 5. Evaluate Armor Class, Spell Save DC, Spell Attack Bonus, and encumbrance.
 * ============================================================================
 */

import type {
  AbilityId,
  Dnd5eActorData,
  ProficiencyRank,
  SkillId,
} from "./types.ts";
import type {
  Dnd5eActorSheet,
  Dnd5eDerivedStats,
} from "./pipeline.ts";

/**
 * Symbolic proficiency tier string used on `Dnd5eActorSheet`:
 * - `"none"`: `0x` proficiency bonus
 * - `"half"`: `0.5x` proficiency bonus (rounded down, e.g., Jack of All Trades)
 * - `"proficient"`: `1x` proficiency bonus
 * - `"expertise"`: `2x` proficiency bonus
 */
export type ProficiencyRankString = "none" | "half" | "proficient" | "expertise";

/**
 * Metadata binding a canonical `SkillId` to its UI label and governing `AbilityId`.
 */
export interface SkillMetadata {
  /** Machine identifier of the skill (e.g., `"perception"`). */
  id: SkillId;
  /** Human-readable English display label (e.g., `"Perception"`). */
  label: string;
  /** Default governing ability score used for checks with this skill. */
  ability: AbilityId;
}

/**
 * Single node in the declarative derived-attribute Directed Acyclic Graph (DAG).
 */
export interface DerivedFormulaNodeSpec {
  /** Name of the derived attribute produced by this node (e.g., `"str_mod"`). */
  targetAttr: string;
  /** Upstream attribute or derived node identifiers required before evaluating `expr`. */
  deps: string[];
  /** Pure mathematical expression evaluated once all `deps` are resolved. */
  expr: string;
}

/**
 * Declarative registration manifest describing a tabletop RPG ruleset plugin.
 */
export interface GameSystemManifest {
  /** Unique machine slug for the game system (e.g., `"dnd5e"`). */
  id: string;
  /** Human-readable system title. */
  name: string;
  /** Semantic version string (`MAJOR.MINOR.PATCH`) of the manifest definition. */
  version: string;
  /** Short SPDX / SRD license identifier. */
  srdLicense: string;
  /** Required verbatim legal attribution notice for Open Game / CC-BY content. */
  attribution?: string;
  /** Ordered list of primary ability identifiers. */
  abilities: AbilityId[];
  /** Complete skill catalog for the ruleset. */
  skills: SkillMetadata[];
  /** Topologically ordered derived-stat formula nodes. */
  derivedDAG: DerivedFormulaNodeSpec[];
}

/**
 * Canonical 18 skills from the D&D 5e SRD 5.1 paired with their governing abilities.
 */
export const DND5E_SKILLS: SkillMetadata[] = [
  { id: "acrobatics", label: "Acrobatics", ability: "dex" },
  { id: "animal_handling", label: "Animal Handling", ability: "wis" },
  { id: "arcana", label: "Arcana", ability: "int" },
  { id: "athletics", label: "Athletics", ability: "str" },
  { id: "deception", label: "Deception", ability: "cha" },
  { id: "history", label: "History", ability: "int" },
  { id: "insight", label: "Insight", ability: "wis" },
  { id: "intimidation", label: "Intimidation", ability: "cha" },
  { id: "investigation", label: "Investigation", ability: "int" },
  { id: "medicine", label: "Medicine", ability: "wis" },
  { id: "nature", label: "Nature", ability: "int" },
  { id: "perception", label: "Perception", ability: "wis" },
  { id: "performance", label: "Performance", ability: "cha" },
  { id: "persuasion", label: "Persuasion", ability: "cha" },
  { id: "religion", label: "Religion", ability: "int" },
  { id: "sleight_of_hand", label: "Sleight of Hand", ability: "dex" },
  { id: "stealth", label: "Stealth", ability: "dex" },
  { id: "survival", label: "Survival", ability: "wis" },
];

/**
 * Authoritative D&D 5e (SRD 5.1 CC-BY-4.0) system manifest and derived-attribute DAG.
 */
export const DND5E_SRD51_MANIFEST: GameSystemManifest = {
  id: "dnd5e",
  name: "Dungeons & Dragons 5th Edition (SRD 5.1)",
  version: "1.0.0",
  srdLicense: "CC-BY-4.0 (Wizards of the Coast SRD 5.1)",
  attribution:
    'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  abilities: ["str", "dex", "con", "int", "wis", "cha"],
  skills: DND5E_SKILLS,
  derivedDAG: [
    { targetAttr: "str_mod", deps: ["str"], expr: "floor((str - 10) / 2)" },
    { targetAttr: "dex_mod", deps: ["dex"], expr: "floor((dex - 10) / 2)" },
    { targetAttr: "con_mod", deps: ["con"], expr: "floor((con - 10) / 2)" },
    { targetAttr: "int_mod", deps: ["int"], expr: "floor((int - 10) / 2)" },
    { targetAttr: "wis_mod", deps: ["wis"], expr: "floor((wis - 10) / 2)" },
    { targetAttr: "cha_mod", deps: ["cha"], expr: "floor((cha - 10) / 2)" },
    {
      targetAttr: "proficiency_bonus",
      deps: ["level"],
      expr: "floor((level - 1) / 4) + 2",
    },
    {
      targetAttr: "initiative_bonus",
      deps: ["dex_mod"],
      expr: "dex_mod",
    },
    {
      targetAttr: "spell_save_dc_int",
      deps: ["proficiency_bonus", "int_mod"],
      expr: "8 + proficiency_bonus + int_mod",
    },
    {
      targetAttr: "spell_save_dc_wis",
      deps: ["proficiency_bonus", "wis_mod"],
      expr: "8 + proficiency_bonus + wis_mod",
    },
    {
      targetAttr: "spell_save_dc_cha",
      deps: ["proficiency_bonus", "cha_mod"],
      expr: "8 + proficiency_bonus + cha_mod",
    },
  ],
};

/**
 * Alias of `DND5E_SRD51_MANIFEST` maintained for 2024 ruleset compatibility consumers.
 */
export const DND5E_2024_MANIFEST = DND5E_SRD51_MANIFEST;

/**
 * Deterministically computes all derived D&D 5e statistics—including proficiency
 * bonus, ability modifiers, saving throws, skill modifiers, passive senses,
 * Armor Class, spellcasting DC/attack bonus, and carrying capacity (in `lb`)—from
 * either a `Dnd5eActorData` record or a `Dnd5eActorSheet`.
 *
 * When given a `Dnd5eActorSheet`, applies an exhaustion penalty of `exhaustionLevel * 2`
 * to saving throws, skill modifiers, initiative, Spell Save DC, and Spell Attack Bonus.
 */
export function computeDnd5eSheetDerived(
  actor: Dnd5eActorData | Dnd5eActorSheet
): Dnd5eDerivedStats {
  if ("attributes" in actor) {
    const level = actor.attributes.level;
    const pb = Math.floor((Math.max(1, Math.min(20, Math.trunc(level))) - 1) / 4) + 2;

    const abilityMods: Record<AbilityId, number> = {
      str: Math.floor((actor.abilities.str.score - 10) / 2),
      dex: Math.floor((actor.abilities.dex.score - 10) / 2),
      con: Math.floor((actor.abilities.con.score - 10) / 2),
      int: Math.floor((actor.abilities.int.score - 10) / 2),
      wis: Math.floor((actor.abilities.wis.score - 10) / 2),
      cha: Math.floor((actor.abilities.cha.score - 10) / 2),
    };

    const savingThrows: Record<AbilityId, number> = {
      str: abilityMods.str + (actor.abilities.str.saveProficiency ? pb : 0),
      dex: abilityMods.dex + (actor.abilities.dex.saveProficiency ? pb : 0),
      con: abilityMods.con + (actor.abilities.con.saveProficiency ? pb : 0),
      int: abilityMods.int + (actor.abilities.int.saveProficiency ? pb : 0),
      wis: abilityMods.wis + (actor.abilities.wis.saveProficiency ? pb : 0),
      cha: abilityMods.cha + (actor.abilities.cha.saveProficiency ? pb : 0),
    };

    const skills: Record<SkillId, number> = {} as Record<SkillId, number>;
    for (const skill of DND5E_SKILLS) {
      const sk = actor.skills[skill.id];
      const rank = sk ? sk.proficiencyRank : 0;
      skills[skill.id] = abilityMods[skill.ability] + rank * pb;
    }

    const armorType = actor.attributes.armorType || "none";
    const baseAc = actor.attributes.baseArmorAC ?? 10;
    const shield = actor.attributes.shieldBonus || 0;
    let armorClass: number;
    if (armorType === "none") {
      armorClass = 10 + abilityMods.dex + shield;
    } else if (armorType === "light") {
      armorClass = baseAc + abilityMods.dex + shield;
    } else if (armorType === "medium") {
      armorClass = baseAc + Math.min(abilityMods.dex, 2) + shield;
    } else {
      armorClass = baseAc + shield;
    }

    const castAbility = actor.attributes.spellcastingAbility;
    const castMod = castAbility ? abilityMods[castAbility] : 0;
    const spellSaveDc = 8 + pb + castMod;
    const spellAttackBonus = pb + castMod;

    return {
      proficiencyBonus: pb,
      abilityMods,
      savingThrows,
      skills,
      passivePerception: 10 + skills.perception,
      passiveInvestigation: 10 + skills.investigation,
      passiveInsight: 10 + skills.insight,
      armorClass,
      initiativeBonus: abilityMods.dex,
      spellSaveDc,
      spellSaveDC: spellSaveDc,
      spellAttackBonus,
      spellAttackModifier: spellAttackBonus,
      encumbrance: {
        carryingCapacity: actor.abilities.str.score * 15,
        heavilyEncumbered: actor.abilities.str.score * 10,
        encumbered: actor.abilities.str.score * 5,
      },
    };
  } else {
    const sheet = actor;
    const pb = Math.floor((Math.max(1, Math.min(20, Math.trunc(sheet.level))) - 1) / 4) + 2;
    const abilityMods: Record<AbilityId, number> = {
      str: Math.floor((sheet.abilities.str - 10) / 2),
      dex: Math.floor((sheet.abilities.dex - 10) / 2),
      con: Math.floor((sheet.abilities.con - 10) / 2),
      int: Math.floor((sheet.abilities.int - 10) / 2),
      wis: Math.floor((sheet.abilities.wis - 10) / 2),
      cha: Math.floor((sheet.abilities.cha - 10) / 2),
    };

    const exhaustionPenalty = (sheet.exhaustionLevel || 0) * 2;

    const savingThrows: Record<AbilityId, number> = {} as Record<AbilityId, number>;
    for (const ab of ["str", "dex", "con", "int", "wis", "cha"] as AbilityId[]) {
      const prof = sheet.saveProficiencies[ab] ? pb : 0;
      savingThrows[ab] = abilityMods[ab] + prof - exhaustionPenalty;
    }

    const skills: Record<SkillId, number> = {} as Record<SkillId, number>;
    for (const skill of DND5E_SKILLS) {
      const rawRank = sheet.skillProficiencies[skill.id];
      let mult = 0;
      if (rawRank === "expertise" || rawRank === 2) mult = 2;
      else if (rawRank === "proficient" || rawRank === 1) mult = 1;
      else if (rawRank === "half") mult = 0.5;
      const bonus = Math.floor(pb * mult);
      skills[skill.id] = abilityMods[skill.ability] + bonus - exhaustionPenalty;
    }

    let armorClass = 10 + abilityMods.dex;
    switch (sheet.armorKind) {
      case "unarmored":
        armorClass = 10 + abilityMods.dex;
        break;
      case "light":
        armorClass = sheet.armorBaseAc + abilityMods.dex;
        break;
      case "medium":
        armorClass = sheet.armorBaseAc + Math.min(2, abilityMods.dex);
        break;
      case "heavy":
        armorClass = sheet.armorBaseAc;
        break;
      case "unarmored_barbarian":
        armorClass = 10 + abilityMods.dex + abilityMods.con;
        break;
      case "unarmored_monk":
        armorClass = 10 + abilityMods.dex + abilityMods.wis;
        break;
    }
    if (sheet.hasShield) {
      armorClass += 2;
    }

    const castMod = abilityMods[sheet.spellcastingAbility] ?? 0;
    const spellSaveDc = 8 + pb + castMod - exhaustionPenalty;
    const spellAttackBonus = pb + castMod - exhaustionPenalty;

    return {
      proficiencyBonus: pb,
      abilityMods,
      savingThrows,
      skills,
      passivePerception: 10 + skills.perception,
      passiveInvestigation: 10 + skills.investigation,
      passiveInsight: 10 + skills.insight,
      armorClass,
      initiativeBonus: abilityMods.dex - exhaustionPenalty,
      spellSaveDc,
      spellSaveDC: spellSaveDc,
      spellAttackBonus,
      spellAttackModifier: spellAttackBonus,
    };
  }
}

/**
 * Constructs a clean baseline level-1 `Dnd5eActorData` instance with all ability
 * scores set to `10` (`+0` modifier), `10/10` HP, `1d8` Hit Die, unarmored AC `10`,
 * and `"NONE"` mitigation across all 13 damage types.
 */
export function createDefaultActorData(
  id = "actor-1",
  name = "Default Character",
  type: "character" | "npc" | "monster" = "character"
): Dnd5eActorData {
  return {
    id,
    name,
    type,
    abilities: {
      str: { score: 10, saveProficiency: false },
      dex: { score: 10, saveProficiency: false },
      con: { score: 10, saveProficiency: false },
      int: { score: 10, saveProficiency: false },
      wis: { score: 10, saveProficiency: false },
      cha: { score: 10, saveProficiency: false },
    },
    skills: {
      acrobatics: { ability: "dex", proficiencyRank: 0 },
      animal_handling: { ability: "wis", proficiencyRank: 0 },
      arcana: { ability: "int", proficiencyRank: 0 },
      athletics: { ability: "str", proficiencyRank: 0 },
      deception: { ability: "cha", proficiencyRank: 0 },
      history: { ability: "int", proficiencyRank: 0 },
      insight: { ability: "wis", proficiencyRank: 0 },
      intimidation: { ability: "cha", proficiencyRank: 0 },
      investigation: { ability: "int", proficiencyRank: 0 },
      medicine: { ability: "wis", proficiencyRank: 0 },
      nature: { ability: "int", proficiencyRank: 0 },
      perception: { ability: "wis", proficiencyRank: 0 },
      performance: { ability: "cha", proficiencyRank: 0 },
      persuasion: { ability: "cha", proficiencyRank: 0 },
      religion: { ability: "int", proficiencyRank: 0 },
      sleight_of_hand: { ability: "dex", proficiencyRank: 0 },
      stealth: { ability: "dex", proficiencyRank: 0 },
      survival: { ability: "wis", proficiencyRank: 0 },
    },
    attributes: {
      level: 1,
      hp: {
        current: 10,
        max: 10,
        temp: 0,
      },
      hitDiceMax: 1,
      hitDiceCurrent: 1,
      hitDieSize: 8,
      exhaustion: 0,
      deathSaves: {
        successes: 0,
        failures: 0,
      },
      armorType: "none",
      baseArmorAC: 10,
      shieldBonus: 0,
    },
    damageMitigations: {
      acid: "NONE",
      bludgeoning: "NONE",
      cold: "NONE",
      fire: "NONE",
      force: "NONE",
      lightning: "NONE",
      necrotic: "NONE",
      piercing: "NONE",
      poison: "NONE",
      psychic: "NONE",
      radiant: "NONE",
      slashing: "NONE",
      thunder: "NONE",
    },
    conditions: [],
    resources: {},
    spellSlots: {},
    isDead: false,
  };
}
