/**
 * ============================================================================
 * CHARACTER BUILDER CHOICE DESCRIPTORS (builderChoices.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Turns the picks SRD 5.2.1 requires into `BuilderChoice` descriptors the
 * builder UI renders without knowing any rule, then validates and applies
 * the selections:
 * - Feats: Magic Initiate (spell list, spellcasting ability, two cantrips,
 *   one level-1 spell) and Skilled (three skills or tools). Without them an
 *   actor could hold Magic Initiate with no spells (GS10).
 * - Classes at level 1: skills, tools, the Fighting Style feat (Fighter),
 *   starting equipment, cantrips and prepared (or spellbook) spells. Without them a level-1 caster has no
 *   spells or slots and nobody has class skills or gear (GS5, GS12, UA13).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Rules Stay In Data`:
 *      - The picks come from `FEAT_CHOICE_SPECS` (`origins.ts`); spell
 *        options come from the compendium (`getSpellsByLevel`), so homebrew
 *        spells on the list are offered through the caller's resolver.
 *   2. `Exact, Distinct, Allowed`:
 *      - `validateSelections` requires exactly `count` distinct ids per
 *        choice, each one among the options computed from the same
 *        selections (a spell outside the chosen list is rejected).
 *   3. `Fixed Lists From Backgrounds`:
 *      - A background's Magic Initiate (Acolyte: Cleric, Sage: Wizard) offers
 *        a single spell list option; a repeated Magic Initiate must use a
 *        spell list not used before (SRD 5.2.1 Repeatable rule).
 *   4. `No Wasted Proficiency`:
 *      - When an actor is given, Skilled does not offer skills or tools the
 *        actor already has.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `applyFeatChoices(actor, featId, selections, options?)`
 *     ├── 1. Require the feat on the actor and build its `BuilderChoice`s.
 *     ├── 2. `validateSelections` (count, distinctness, allowed options).
 *     ├── 3. Skilled: grant skill proficiency / record tools.
 *     ├── 4. Record a `FeatChoiceRecord` (Magic Initiate spells live there).
 *     └── 5. Recompute derived statistics.
 *
 *   `applyClassChoices(actor, classId, selections, options?)`
 *     ├── 1. Build `getClassChoices` for the actor and validate the selections.
 *     ├── 2. Record class, saves, hit die, caster type, spellcasting ability.
 *     ├── 3. Grant skills and the Fighting Style feat; store armor/weapon/tool proficiencies.
 *     ├── 4. Add the starting equipment option (weapons and armor equipped).
 *     ├── 5. Learn cantrips and spells; fill slots for the actor's level.
 *     └── 6. Recompute derived statistics.
 * ============================================================================
 */

import {
  getActorProficiencies,
  getCantripsKnown,
  getClassStartingRules,
  getPreparedSpellCount,
  type ClassStartingRules,
  type StartingEquipmentOption,
} from "./classRules.ts";
import { CompendiumResolver } from "./compendium.ts";
import { parseEquipmentLine } from "./derivations.ts";
import { computeDnd5eSheetDerived, DND5E_SKILLS } from "./manifest.ts";
import {
  getClassProgression,
  getFightingStyleFeatOptions,
  grantsFightingStyleFeat,
  recordFightingStyleFeat,
  reconcileSlots,
} from "./progression.ts";
import {
  FEAT_CHOICE_SPECS,
  MAGIC_INITIATE_ABILITIES,
  MAGIC_INITIATE_SPELL_LISTS,
  SRD_FEATS,
  SRD_TOOLS,
  getBackgroundRules,
  srdFeatKey,
  type FeatChoiceSpec,
  type MagicInitiateSpellList,
} from "./origins.ts";
import type {
  AbilityId,
  ActorItem,
  BuilderChoice,
  BuilderChoiceOption,
  BuilderSelections,
  Dnd5eActorData,
  SkillId,
} from "./types.ts";

/** Prefix of tool option ids in `"skill_or_tool"` choices (`"tool:Thieves' Tools"`). */
export const TOOL_OPTION_PREFIX = "tool:";

const ABILITY_LABELS: Record<AbilityId, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

const SPELL_LIST_LABELS: Record<MagicInitiateSpellList, string> = {
  cleric: "Cleric",
  druid: "Druid",
  wizard: "Wizard",
};

/** Options controlling `getFeatChoices`. */
export interface FeatChoiceOptions {
  /** Spell list imposed by the source (a background's Magic Initiate). */
  fixedSpellList?: MagicInitiateSpellList;
  /** Selections made so far; resolves `dependsOn` options (spells of the chosen list). */
  selections?: BuilderSelections;
  /** Actor taking the feat; filters out proficiencies and spell lists already used. */
  actor?: Dnd5eActorData;
  /** Compendium used for spell options (defaults to `SYSTEM_SRD`). */
  resolver?: CompendiumResolver;
}

/** Spell options of `level` on a class `list`, as builder options. */
export function spellOptions(list: string, level: number, resolver?: CompendiumResolver): BuilderChoiceOption[] {
  return (resolver ?? CompendiumResolver.getDefault())
    .getSpellsByLevel(level, list)
    .map((entry) => ({ id: entry.id, label: entry.name }));
}

function usedMagicInitiateLists(actor: Dnd5eActorData | undefined): string[] {
  return (actor?.featChoices ?? [])
    .filter((record) => srdFeatKey(record.featId) === "magic_initiate")
    .flatMap((record) => record.selections.spell_list ?? []);
}

function skillOrToolOptions(actor: Dnd5eActorData | undefined): BuilderChoiceOption[] {
  const tools = new Set(actor?.proficiencies?.tools ?? []);
  return [
    ...DND5E_SKILLS.filter((skill) => (actor?.skills[skill.id]?.proficiencyRank ?? 0) === 0).map((skill) => ({
      id: skill.id,
      label: skill.label,
    })),
    ...SRD_TOOLS.filter((tool) => !tools.has(tool)).map((tool) => ({ id: `${TOOL_OPTION_PREFIX}${tool}`, label: tool })),
  ];
}

function choiceFromSpec(spec: FeatChoiceSpec, options: FeatChoiceOptions): BuilderChoice {
  const base = { id: spec.id, kind: spec.kind, label: spec.label, count: spec.count };
  switch (spec.kind) {
    case "spell_list": {
      const used = new Set(usedMagicInitiateLists(options.actor));
      const lists = options.fixedSpellList
        ? [options.fixedSpellList]
        : MAGIC_INITIATE_SPELL_LISTS.filter((list) => !used.has(list));
      return { ...base, options: lists.map((list) => ({ id: list, label: SPELL_LIST_LABELS[list] })) };
    }
    case "ability":
      return { ...base, options: MAGIC_INITIATE_ABILITIES.map((ab) => ({ id: ab, label: ABILITY_LABELS[ab] })) };
    case "spell": {
      const list = options.fixedSpellList ?? options.selections?.spell_list?.[0];
      return {
        ...base,
        dependsOn: "spell_list",
        options: list ? spellOptions(list, spec.spellLevel ?? 0, options.resolver) : [],
      };
    }
    case "skill_or_tool":
      return { ...base, options: skillOrToolOptions(options.actor) };
  }
}

/**
 * Builder choices required by `featId` (`"srd:feat:magic_initiate"` or
 * `"magic_initiate"`); `[]` for feats without choices and homebrew feats.
 */
export function getFeatChoices(featId: string, options: FeatChoiceOptions = {}): BuilderChoice[] {
  const key = srdFeatKey(featId);
  const specs = key ? FEAT_CHOICE_SPECS[key] : undefined;
  return (specs ?? []).map((spec) => choiceFromSpec(spec, options));
}

/**
 * Choices of the Origin feat granted by `backgroundId`, with the background's
 * fixed Magic Initiate spell list applied (Acolyte: Cleric, Sage: Wizard).
 */
export function getOriginFeatChoices(
  backgroundId: string,
  options: Omit<FeatChoiceOptions, "fixedSpellList"> = {}
): BuilderChoice[] {
  const background = getBackgroundRules(backgroundId);
  if (!background) throw new Error(`Unknown background: ${backgroundId}`);
  return getFeatChoices(background.originFeat, { ...options, fixedSpellList: background.originFeatSpellList });
}

/**
 * Validates `selections` against `choices`: every choice needs exactly
 * `count` distinct ids taken from its `options`. Throws
 * `Invalid selection for <choiceId>` otherwise.
 */
export function validateSelections(choices: readonly BuilderChoice[], selections: BuilderSelections): void {
  for (const choice of choices) {
    const picked = selections[choice.id] ?? [];
    const allowed = new Set(choice.options.map((option) => option.id));
    if (
      picked.length !== choice.count ||
      new Set(picked).size !== picked.length ||
      picked.some((id) => !allowed.has(id))
    ) {
      throw new Error(`Invalid selection for ${choice.id}`);
    }
  }
}

/**
 * Validates and applies the picks of `featId` to a copy of `actor`: Skilled
 * grants skill proficiencies and tools, every feat with choices records a
 * `FeatChoiceRecord` (Magic Initiate spells are read from it). Throws when the
 * actor does not hold the feat, the feat has no choices, or a selection is
 * invalid.
 */
export function applyFeatChoices(
  actor: Dnd5eActorData,
  featId: string,
  selections: BuilderSelections,
  options: Omit<FeatChoiceOptions, "selections" | "actor"> = {}
): Dnd5eActorData {
  const key = srdFeatKey(featId);
  if (!key || !FEAT_CHOICE_SPECS[key]) throw new Error(`Feat has no choices: ${featId}`);
  const held = (actor.features ?? []).filter((id) => srdFeatKey(id) === key).length;
  const recorded = (actor.featChoices ?? []).filter((record) => srdFeatKey(record.featId) === key).length;
  if (recorded >= held) throw new Error(`Feat not held: ${featId}`);
  if (!SRD_FEATS[key].repeatable && recorded > 0) throw new Error(`Feat choices already made: ${featId}`);

  validateSelections(getFeatChoices(featId, { ...options, selections, actor }), selections);

  const clone: Dnd5eActorData = structuredClone(actor);
  const record = {
    featId: `srd:feat:${key}`,
    selections: Object.fromEntries(Object.entries(selections).map(([id, picks]) => [id, [...picks]])),
  };
  for (const pick of record.selections.proficiencies ?? []) {
    if (pick.startsWith(TOOL_OPTION_PREFIX)) {
      clone.proficiencies ??= getActorProficiencies(clone);
      clone.proficiencies.tools.push(pick.slice(TOOL_OPTION_PREFIX.length));
    } else {
      clone.skills[pick as SkillId].proficiencyRank = 1;
    }
  }
  clone.featChoices = [...(clone.featChoices ?? []), record];
  clone.derived = computeDnd5eSheetDerived(clone);
  return clone;
}

// ============================================================================
// CLASS CHOICES (level-1 creation)
// ============================================================================

/** Options controlling `getClassChoices`. */
export interface ClassChoiceOptions {
  /** Actor being built; skills it already has are not offered. */
  actor?: Dnd5eActorData;
  /** Compendium used for spell options (defaults to `SYSTEM_SRD`). */
  resolver?: CompendiumResolver;
}

function requireClassRules(classId: string): ClassStartingRules {
  const rules = getClassStartingRules(classId);
  if (!rules) throw new Error(`Unknown class: ${classId}`);
  return rules;
}

function equipmentLabel(option: StartingEquipmentOption): string {
  return [...option.items, ...(option.gp > 0 ? [`${option.gp} GP`] : [])].join(", ");
}

/**
 * Level-1 builder choices of `classId`, in step order:
 * - `"skills"` (`"skill"`): the class skill picks.
 * - `"tools"` (`"tool"`): Bard instruments / Monk tool, when the class has one.
 * - `"fighting_style"` (`"feat"`): one Fighting Style feat (`srd:feat:<key>`)
 *   when the class gains Fighting Style at level 1 (Fighter).
 * - `"equipment"` (`"equipment_option"`): one starting equipment option id (`"A"`, `"B"`, ...).
 * - `"cantrips"` (`"spell"`): class cantrips known at level 1, when any.
 * - `"spells"` (`"spell"`): level-1 class spells prepared (Wizard: its 6
 *   spellbook spells), when any. Spell counts are capped by the spells the
 *   compendium offers.
 * Throws on unknown classes.
 */
export function getClassChoices(classId: string, options: ClassChoiceOptions = {}): BuilderChoice[] {
  const rules = requireClassRules(classId);
  const list = classId.replace(/^srd:class:/, "").toLowerCase();
  const owned = (skill: SkillId) => (options.actor?.skills[skill]?.proficiencyRank ?? 0) > 0;
  const skillLabel = (skill: SkillId) => DND5E_SKILLS.find((s) => s.id === skill)?.label ?? skill;
  const choices: BuilderChoice[] = [
    {
      id: "skills",
      kind: "skill",
      label: "Skill proficiencies",
      count: rules.skillChoices.count,
      options: rules.skillChoices.options.filter((skill) => !owned(skill)).map((skill) => ({ id: skill, label: skillLabel(skill) })),
    },
  ];
  if (rules.toolChoices) {
    choices.push({
      id: "tools",
      kind: "tool",
      label: "Tool proficiencies",
      count: rules.toolChoices.count,
      options: rules.toolChoices.options.map((tool) => ({ id: tool, label: tool })),
    });
  }
  if (grantsFightingStyleFeat(classId, undefined, 1)) {
    const resolver = options.resolver ?? CompendiumResolver.getDefault();
    choices.push({
      id: "fighting_style",
      kind: "feat",
      label: "Fighting Style feat",
      count: 1,
      options: getFightingStyleFeatOptions(options.actor?.features ?? []).map((id) => ({ id, label: resolver.get(id)?.name ?? id })),
    });
  }
  choices.push({
    id: "equipment",
    kind: "equipment_option",
    label: "Starting equipment",
    count: 1,
    options: rules.equipment.map((option) => ({ id: option.id, label: equipmentLabel(option) })),
  });
  const cantrips = getCantripsKnown(classId, 1);
  if (cantrips > 0) {
    const cantripOptions = spellOptions(list, 0, options.resolver);
    choices.push({ id: "cantrips", kind: "spell", label: "Cantrips", count: Math.min(cantrips, cantripOptions.length), options: cantripOptions });
  }
  const spells = rules.spellbookAtLevel1 ?? getPreparedSpellCount(classId, 1);
  if (spells > 0) {
    const levelOneOptions = spellOptions(list, 1, options.resolver);
    choices.push({
      id: "spells",
      kind: "spell",
      label: rules.spellbookAtLevel1 ? "Spellbook spells" : "Prepared spells",
      count: Math.min(spells, levelOneOptions.length),
      options: levelOneOptions,
    });
  }
  return choices;
}

/**
 * Sheet items of starting equipment option `optionId` of `classId`: SRD
 * names resolved to compendium items (quantity from a leading count),
 * weapons, armor and shields equipped, plus a `"<n> GP"` entry. Ids are
 * `item-<n>` numbered after `firstIndex`.
 */
export function startingEquipmentItems(classId: string, optionId: string, firstIndex = 0): ActorItem[] {
  const option = requireClassRules(classId).equipment.find((candidate) => candidate.id === optionId);
  if (!option) throw new Error(`Unknown equipment option: ${optionId}`);
  const lines = [...option.items, ...(option.gp > 0 ? [`${option.gp} GP`] : [])];
  return lines.map((line, i) => {
    const { quantity, entry } = parseEquipmentLine(line);
    const itemType = entry?.data.itemType;
    return {
      id: `item-${firstIndex + i + 1}`,
      name: entry ? entry.name : line,
      quantity: entry ? quantity : 1,
      ...(entry ? { compendiumId: entry.id } : {}),
      ...(itemType === "weapon" || itemType === "armor" ? { equipped: true } : {}),
      isContainer: entry?.data.isContainer === true,
      containerId: null,
    };
  });
}

/**
 * Validates `selections` against `getClassChoices(classId, { actor })` and
 * applies them to a copy of `actor`: records the class (ids, saving throws,
 * hit die, caster type, spellcasting ability), grants the chosen skills,
 * stores the class armor/weapon/tool proficiencies plus chosen tools, adds the
 * chosen starting equipment (weapons and armor equipped), learns the chosen
 * cantrips and spells, fills the spell slots of the actor's level and
 * recomputes derived statistics. Hit points are left to the caller (species
 * bonus, rolled or fixed).
 */
export function applyClassChoices(
  actor: Dnd5eActorData,
  classId: string,
  selections: BuilderSelections,
  options: Omit<ClassChoiceOptions, "actor"> = {}
): Dnd5eActorData {
  const rules = requireClassRules(classId);
  validateSelections(getClassChoices(classId, { ...options, actor }), selections);
  const progression = getClassProgression(classId)!;
  const key = classId.replace(/^srd:class:/, "").toLowerCase();

  const clone: Dnd5eActorData = structuredClone(actor);
  clone.classId = key;
  clone.attributes.classId = key;
  clone.attributes.hitDieSize = progression.hitDie;
  clone.attributes.casterType = progression.casterType;
  if (progression.spellcastingAbility) clone.attributes.spellcastingAbility = progression.spellcastingAbility;
  for (const ab of Object.keys(clone.abilities) as AbilityId[]) {
    clone.abilities[ab].saveProficiency = progression.savingThrows.includes(ab);
  }
  for (const skill of selections.skills ?? []) clone.skills[skill as SkillId].proficiencyRank = 1;
  for (const featId of selections.fighting_style ?? []) recordFightingStyleFeat(clone, featId, key, undefined, 1);

  const proficiencies = getActorProficiencies(clone);
  const add = <T>(list: T[], values: readonly T[]) => values.forEach((value) => list.includes(value) || list.push(value));
  add(proficiencies.armor, rules.armor);
  add(proficiencies.weapons, rules.weapons);
  add(proficiencies.tools, [...rules.tools, ...(selections.tools ?? [])]);
  clone.proficiencies = proficiencies;

  const items = clone.items ?? [];
  clone.items = [...items, ...startingEquipmentItems(key, selections.equipment[0], items.length)];

  const spellIds = clone.spellIds ?? [];
  add(spellIds, [...(selections.cantrips ?? []), ...(selections.spells ?? [])]);
  clone.spellIds = spellIds;
  if (progression.casterType !== "none") {
    clone.spellSlots = reconcileSlots(clone.spellSlots, progression.casterType, clone.attributes.level);
  }
  clone.derived = computeDnd5eSheetDerived(clone);
  return clone;
}
