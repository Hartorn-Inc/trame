/**
 * ============================================================================
 * D&D 5E DECLARATIVE GAME SYSTEM MANIFEST & DERIVED STATS (manifest.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Declares the D&D 5e (SRD 5.2.1 CC-BY-4.0) `GameSystemManifest`—including the
 * canonical 18-skill registry and the formula DAG loaded from `system.json`—and
 * exposes the single derived-stat path (`computeDnd5eSheetDerived`) for both
 * `Dnd5eActorData` and `Dnd5eActorSheet` representations.
 *
 * Open Game Content Attribution:
 * This work includes material from the System Reference Document 5.2.1
 * ("SRD 5.2.1") by Wizards of the Coast LLC, available at
 * https://www.dndbeyond.com/srd, licensed under the Creative Commons
 * Attribution 4.0 International License (CC-BY-4.0).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `system.json Is The Only Rule Source`:
 *      - Every derived number (modifiers, proficiency bonus, saves, skills,
 *        passives, AC, speed, spell DC/attack, carrying capacity) is a
 *        `system.json` `derivedDAG` formula evaluated by the `trame-engine`
 *        WASM through `evaluateDerivedDag`. This module only maps actor fields
 *        to formula inputs and maps outputs back.
 *   2. `Best-Wins Armor Class, Shield Outside`:
 *      - Unarmored, armored and Unarmored Defense (CON or WIS) candidates are
 *        evaluated independently and `ac_base` keeps the maximum; inapplicable
 *        candidates evaluate to `0`. `ac = ac_base + shield_bonus`, so a
 *        Base-phase active effect on `ac_base` (Mage Armor, Barkskin) never
 *        swallows the shield.
 *   3. `Dual-Representation Parity`:
 *      - `Dnd5eActorData` and `Dnd5eActorSheet` go through the same adapter
 *        output shape (`derivedInputsFor*`) and the same formulas, so equal
 *        stats produce equal results.
 *   4. `SRD 5.2.1 Exhaustion`:
 *      - `-2 * level` on d20 tests (saves, skills, initiative, spell attacks)
 *        and `-5 ft * level` of speed. Passive scores are not d20 tests and
 *        the spell save DC is never reduced.
 *   5. `Complete Inputs`:
 *      - Adapters always supply every `derivedInputs` key because the
 *        evaluator fails closed on unknown variables.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `computeDnd5eSheetDerived(actor, activeEffects?)`
 *     ├── 1. Map the actor to the `derivedInputs` record (`level`, scores, flags).
 *     │      Equipped armor and shields override the armor inputs (`derivations.ts`).
 *     ├── 2. `evaluateDerivedDag(inputs, DND5E_DERIVED_FORMULAS, effects)` (WASM),
 *     │      `effects` = `ClassFeature` effects (`classFeatures.ts`) then the
 *     │      caller's `activeEffects`, all in the 5-phase order.
 *     │      `ConditionOverride` rulings (options) can suspend exhaustion first.
 *     ├── 3. Project the evaluated attributes onto `Dnd5eDerivedStats`.
 *     └── 4. Add `attacks`, `spells`, `features`, `resourcePools` and
 *            `featureRules` from the evaluated values; Magic Initiate
 *            abilities re-run the DAG.
 * ============================================================================
 */

import systemJson from "../system.json" with { type: "json" };
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
import { evaluateDerivedDag, extractFormulaIdentifiers } from "./formulaEvaluator.ts";
import { classFeatureEffects, classFeaturesFor, deriveFeatureRules, deriveResourcePools } from "./classFeatures.ts";
import {
  abilityModsOf,
  deriveAttacks,
  deriveFeatures,
  deriveSheetFeatures,
  deriveSpellcasting,
  equippedArmorInputs,
} from "./derivations.ts";
import { getClassProgression } from "./progression.ts";
import { resolveConditionEffects, type ConditionOverrideRuling } from "./conditions.ts";

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
 * Canonical 18 skills from the D&D 5e SRD 5.2.1 paired with their governing abilities.
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
 * Authoritative D&D 5e (SRD 5.2.1 CC-BY-4.0, 2024 rules) system manifest and
 * derived-attribute DAG. Name, version and attribution come from `system.json`.
 */
export const DND5E_2024_MANIFEST: GameSystemManifest = {
  id: "dnd5e",
  name: systemJson.name,
  version: systemJson.version,
  srdLicense: "CC-BY-4.0 (Wizards of the Coast SRD 5.2.1)",
  attribution: systemJson.attribution,
  abilities: ["str", "dex", "con", "int", "wis", "cha"],
  skills: DND5E_SKILLS,
  derivedDAG: Object.entries(systemJson.derivedDAG).map(([targetAttr, expr]) => ({
    targetAttr,
    deps: extractFormulaIdentifiers(expr),
    expr,
  })),
};

/**
 * `targetAttr -> expression` formulas of `system.json`, in the shape consumed
 * by `evaluateDerivedDag` (and the Rust `evaluate_derived_dag`).
 */
export const DND5E_DERIVED_FORMULAS: Readonly<Record<string, string>> = systemJson.derivedDAG;

/** Default walking speed in feet when an actor carries no species speed. */
export const DEFAULT_SPEED_FT = 30;

/** Feat identifiers that add the proficiency bonus to initiative (SRD 5.2.1 Alert). */
const ALERT_FEAT_IDS = new Set(["alert", "srd:feat:alert"]);

function hasAlert(features: readonly string[] | undefined): number {
  return (features ?? []).some((f) => ALERT_FEAT_IDS.has(f)) ? 1 : 0;
}

const ABILITY_IDS: readonly AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

/** Large enough to never cap a Dexterity modifier (max `+10` at score `30`). */
const UNCAPPED_DEX = 100;

/** Armor-related formula inputs shared by both actor representations. */
interface ArmorInputs {
  armor_worn: number;
  armor_base: number;
  armor_dex_applies: number;
  armor_max_dex: number;
}

function armorInputs(kind: string, baseAc: number): ArmorInputs {
  switch (kind) {
    case "light":
      return { armor_worn: 1, armor_base: baseAc, armor_dex_applies: 1, armor_max_dex: UNCAPPED_DEX };
    case "medium":
      return { armor_worn: 1, armor_base: baseAc, armor_dex_applies: 1, armor_max_dex: 2 };
    case "heavy":
    case "natural":
      return { armor_worn: 1, armor_base: baseAc, armor_dex_applies: 0, armor_max_dex: 0 };
    default:
      return { armor_worn: 0, armor_base: 0, armor_dex_applies: 0, armor_max_dex: 0 };
  }
}

/**
 * Converts a symbolic (`ProficiencyRankString`) or numeric (`ProficiencyRank`)
 * proficiency tier into its numeric multiplier (`0`, `0.5`, `1`, or `2`).
 */
export function proficiencyMultiplier(
  rank: ProficiencyRankString | ProficiencyRank | undefined
): number {
  if (rank === "expertise" || rank === 2) return 2;
  if (rank === "proficient" || rank === 1) return 1;
  if (rank === "half") return 0.5;
  return 0;
}

function normalizedClassId(classId: unknown): string {
  return String(classId ?? "").replace(/^srd:class:/, "").toLowerCase();
}

/**
 * Maps a `Dnd5eActorData` record onto the `system.json` `derivedInputs`.
 * Barbarians and Monks receive their Unarmored Defense candidate from their
 * class, equipped armor and shields replace the armor inputs, and the class
 * spellcasting ability applies when the actor stores none.
 */
export function derivedInputsForActorData(actor: Dnd5eActorData): Record<string, number> {
  const inputs: Record<string, number> = {
    level: actor.attributes.level,
    exhaustion: actor.attributes.exhaustion ?? 0,
    speed_base: actor.attributes.speedFt ?? DEFAULT_SPEED_FT,
    initiative_prof: hasAlert(actor.features),
    shield_bonus: actor.attributes.shieldBonus ?? 0,
    ...armorInputs(actor.attributes.armorType ?? "none", actor.attributes.baseArmorAC ?? 10),
  };
  const classId = normalizedClassId(
    actor.classId ?? actor.class ?? actor.attributes.classId ?? actor.attributes.class
  );
  inputs.unarmored_defense_con = classId === "barbarian" ? 1 : 0;
  inputs.unarmored_defense_wis = classId === "monk" ? 1 : 0;
  Object.assign(inputs, equippedArmorInputs(actor));
  const spellAbility = actor.attributes.spellcastingAbility ?? getClassProgression(classId)?.spellcastingAbility;
  for (const ab of ABILITY_IDS) {
    inputs[ab] = actor.abilities[ab].score;
    inputs[`save_${ab}_prof`] = actor.abilities[ab].saveProficiency ? 1 : 0;
    inputs[`spell_ability_${ab}`] = spellAbility === ab ? 1 : 0;
  }
  for (const skill of DND5E_SKILLS) {
    inputs[`skill_${skill.id}_prof`] = proficiencyMultiplier(actor.skills[skill.id]?.proficiencyRank);
  }
  return inputs;
}

/**
 * Maps a flat `Dnd5eActorSheet` onto the `system.json` `derivedInputs`.
 * `unarmored_barbarian` / `unarmored_monk` become Unarmored Defense candidates
 * that compete with plain unarmored AC ("best wins").
 */
export function derivedInputsForSheet(sheet: Dnd5eActorSheet): Record<string, number> {
  const inputs: Record<string, number> = {
    level: sheet.level,
    exhaustion: sheet.exhaustionLevel ?? 0,
    speed_base: sheet.speedFt ?? DEFAULT_SPEED_FT,
    initiative_prof: hasAlert(sheet.features),
    shield_bonus: sheet.hasShield ? 2 : 0,
    unarmored_defense_con: sheet.armorKind === "unarmored_barbarian" ? 1 : 0,
    unarmored_defense_wis: sheet.armorKind === "unarmored_monk" ? 1 : 0,
    ...armorInputs(sheet.armorKind, sheet.armorBaseAc),
  };
  for (const ab of ABILITY_IDS) {
    inputs[ab] = sheet.abilities[ab];
    inputs[`save_${ab}_prof`] = sheet.saveProficiencies[ab] ? 1 : 0;
    inputs[`spell_ability_${ab}`] = sheet.spellcastingAbility === ab ? 1 : 0;
  }
  for (const skill of DND5E_SKILLS) {
    inputs[`skill_${skill.id}_prof`] = proficiencyMultiplier(sheet.skillProficiencies[skill.id]);
  }
  return inputs;
}

/**
 * Computes the D&D 5e proficiency bonus (`+2` to `+6`) by evaluating the
 * `system.json` `prof_bonus` formula, which clamps `level` to `[1, 20]`.
 */
export function calculateProficiencyBonus(level: number): number {
  return evaluateDerivedDag(
    { level: Math.trunc(level) },
    { prof_bonus: DND5E_DERIVED_FORMULAS.prof_bonus }
  ).prof_bonus;
}

/** Optional inputs of `computeDnd5eSheetDerived` beyond the actor and its active effects. */
export interface SheetDerivationOptions {
  /**
   * `ConditionOverride` rulings on the actor's token. They decide
   * `conditionEffects`; a `REMOVE` ruling on `exhaustion` evaluates the DAG
   * with exhaustion `0`.
   */
  conditionOverrides?: readonly ConditionOverrideRuling[];
}

/**
 * Computes every derived D&D 5e statistic—proficiency bonus, ability modifiers,
 * saving throws, skills, passive senses, Armor Class, speed (`ft`), spell save
 * DC, spell attack bonus and carrying capacity (`lb`)—for either actor
 * representation by evaluating the `system.json` formula DAG through the
 * WASM evaluator seam, optionally through engine `activeEffects`
 * (snake_case `ActiveEffect` objects; e.g. a Base-phase `ac_base` candidate).
 *
 * Exhaustion (SRD 5.2.1) applies `-2 * level` to saves, skills, initiative and
 * spell attacks and `-5 ft * level` to speed; passive scores and the spell
 * save DC are never reduced.
 *
 * For `Dnd5eActorData` it also lists `attacks` (equipped weapons, damaging
 * spells), `spells` (slots, Pact Magic, spell lists; absent for non-casters)
 * and `features`. A `Dnd5eActorSheet` gets `attacks: []` and the features
 * named in `sheet.features`.
 */
export function computeDnd5eSheetDerived(
  actor: Dnd5eActorData | Dnd5eActorSheet,
  activeEffects?: unknown[],
  options: SheetDerivationOptions = {}
): Dnd5eDerivedStats {
  const inputs = "attributes" in actor ? derivedInputsForActorData(actor) : derivedInputsForSheet(actor);
  const conditionEffects = resolveConditionEffects({
    conditions: (actor.conditions ?? []).map((c) => (typeof c === "string" ? c : c.id)),
    overrides: options.conditionOverrides,
  });
  if (!conditionEffects.exhaustionApplies) inputs.exhaustion = 0;
  const effects = "attributes" in actor ? [...classFeatureEffects(actor), ...(activeEffects ?? [])] : activeEffects;
  const v = evaluateDerivedDag(inputs, DND5E_DERIVED_FORMULAS, effects);

  let extras: Pick<Dnd5eDerivedStats, "attacks" | "spells" | "features" | "resourcePools" | "featureRules">;
  if ("attributes" in actor) {
    const spellNumbersFor = (ability: AbilityId) => {
      const flags = Object.fromEntries(ABILITY_IDS.map((ab) => [`spell_ability_${ab}`, ab === ability ? 1 : 0]));
      const r = evaluateDerivedDag({ ...inputs, ...flags }, DND5E_DERIVED_FORMULAS, effects);
      return { spellSaveDc: r.spell_save_dc, spellAttackBonus: r.spell_attack_bonus };
    };
    const spells = deriveSpellcasting(actor, v, spellNumbersFor);
    const classFeatures = classFeaturesFor(actor).length > 0
      ? { resourcePools: deriveResourcePools(actor, abilityModsOf(v)), featureRules: deriveFeatureRules(actor) }
      : {};
    extras = {
      attacks: deriveAttacks(actor, v, spells),
      ...(spells ? { spells } : {}),
      features: deriveFeatures(actor, v),
      ...classFeatures,
    };
  } else {
    extras = { attacks: [], features: deriveSheetFeatures(actor.features) };
  }

  const abilityMods = {} as Record<AbilityId, number>;
  const savingThrows = {} as Record<AbilityId, number>;
  for (const ab of ABILITY_IDS) {
    abilityMods[ab] = v[`${ab}_mod`];
    savingThrows[ab] = v[`save_${ab}`];
  }
  const skills = {} as Record<SkillId, number>;
  for (const skill of DND5E_SKILLS) {
    skills[skill.id] = v[`skill_${skill.id}`];
  }

  return {
    proficiencyBonus: v.prof_bonus,
    abilityMods,
    savingThrows,
    skills,
    passivePerception: v.passive_perception,
    passiveInvestigation: v.passive_investigation,
    passiveInsight: v.passive_insight,
    armorClass: v.ac,
    initiativeBonus: v.initiative,
    speed: v.speed,
    spellSaveDc: v.spell_save_dc,
    spellSaveDC: v.spell_save_dc,
    spellAttackBonus: v.spell_attack_bonus,
    spellAttackModifier: v.spell_attack_bonus,
    encumbrance: {
      carryingCapacity: v.carrying_capacity,
      heavilyEncumbered: v.heavily_encumbered,
      encumbered: v.encumbered,
    },
    ...extras,
    conditionEffects,
  };
}

/**
 * Constructs a clean baseline level-1 `Dnd5eActorData` instance with all ability
 * scores set to `10` (`+0` modifier), `10/10` HP, `1d8` Hit Die, unarmored AC `10`,
 * `30 ft` speed, and `"NONE"` mitigation across all 13 damage types.
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
      speedFt: DEFAULT_SPEED_FT,
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
