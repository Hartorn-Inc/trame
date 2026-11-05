/**
 * ============================================================================
 * FEAT CHOICE DESCRIPTORS FOR THE CHARACTER BUILDER (builderChoices.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Turns the picks an SRD 5.2.1 feat requires (Magic Initiate: spell list,
 * spellcasting ability, two cantrips and one level-1 spell; Skilled: three
 * skills or tools) into `BuilderChoice` descriptors the builder UI renders
 * without knowing any rule, then validates and applies the selections. Without
 * it, an actor could hold Magic Initiate with no spells or Skilled with no
 * proficiencies, which is an illegal build (GS10).
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
 * ============================================================================
 */

import { CompendiumResolver } from "./compendium.ts";
import { computeDnd5eSheetDerived, DND5E_SKILLS } from "./manifest.ts";
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
      clone.proficiencies ??= { armor: [], weapons: [], tools: [] };
      clone.proficiencies.tools.push(pick.slice(TOOL_OPTION_PREFIX.length));
    } else {
      clone.skills[pick as SkillId].proficiencyRank = 1;
    }
  }
  clone.featChoices = [...(clone.featChoices ?? []), record];
  clone.derived = computeDnd5eSheetDerived(clone);
  return clone;
}
