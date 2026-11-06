/**
 * ============================================================================
 * SRD 5.2.1 CLASS FEATURE CATALOGUE: POOLS, EFFECTS, ROLL RULES (classFeatures.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Turns the class feature names of `SRD_CLASS_PROGRESSION` (12 classes,
 * levels 1-20) and the features of the 12 SRD subclasses into `ClassFeature`
 * records: an optional `ResourcePool` (max by level or ability modifier,
 * recovery on short or long rest) plus zero or more `ActiveEffect`
 * modifiers and roll rules. Without it the sheet lists feature names only,
 * Rage has no use counter and Unarmored Movement never changes speed (GS13).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `D12 Boundary`:
 *      - `automated`: the feature changes a number or a roll rule the pack
 *        computes (a DAG modifier, a pool, a scaling value, attacks per
 *        action, critical range, advantage, a toggle such as Rage).
 *      - `described`: the player or GM resolves it (choices, profile
 *        replacements such as Wild Shape, summons, reactions). It may still
 *        carry a use counter (`pool`), which rests recover.
 *   2. `Effects Run Through The 5-Phase Pipeline`:
 *      - Modifiers are engine `ActiveEffect`s (snake_case, deterministic ids,
 *        `source_name = "ClassFeature:<id>"`) passed to the WASM evaluator
 *        with the caller's effects; Base raises, Add sums, clamps last.
 *      - Toggle features (`toggle: true`) contribute effects, roll rules
 *        and resistances only while their id is in `actor.activeFeatureIds`.
 *   3. `Pool Maxima Come From The Level And The DAG`:
 *      - `byLevel` tables use the highest key `<= level`; ability-based
 *        maxima read the evaluated `<ability>_mod` (after effects) and
 *        never drop below `min`. A pool is absent before its first level.
 *   4. `Stable Ids`:
 *      - Feature ids are `"<class>:<slug>"` (a repeated name at a later
 *        level gets `"_<level>"`); subclass features are
 *        `"<subclass>:<slug>"`. Pool ids are keys of `actor.resources`.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `computeDnd5eSheetDerived(actor)` (manifest.ts)
 *     ├── 1. `classFeatureEffects(actor)` -> engine `ActiveEffect`s for the DAG.
 *     ├── 2. DAG evaluation (WASM) with those effects.
 *     ├── 3. `deriveClassFeatures(actor, v)` -> features with pools and scaling.
 *     └── 4. `deriveFeatureRules(actor)` -> attacks per action, critical range,
 *            advantages, resistances, weapon bonuses.
 *   `applyShortRest` / `applyLongRest` (rest.ts)
 *     └── `recoverClassFeaturePools(actor, rest, abilityMods)` writes pools back.
 * ============================================================================
 */

import { getActorClassId } from "./classRules.ts";
import { SRD_CLASS_PROGRESSION, type ClassProgression, type SrdClassId } from "./progression.ts";
import type { AbilityId, DamageType, Dnd5eActorData, ResourcePool, RestType, SkillId } from "./types.ts";

/** D12 classification of a `ClassFeature` (see banner invariant 1). */
export type ClassFeatureAutomation = "automated" | "described";

/** Maximum uses of a pool at a given class level. */
export type PoolMax =
  /** Uses by class level (highest key `<= level`). */
  | { byLevel: Readonly<Record<number, number>> }
  /** Ability modifier (after effects), at least `min`. */
  | { abilityMod: AbilityId; min: number }
  /** `perLevel * class level` (Lay On Hands `5`, Focus Points `1`). */
  | { perLevel: number };

/** `ResourcePool` rules of a feature. */
export interface ClassFeaturePoolSpec {
  /** Key in `actor.resources` (e.g. `"barbarian_rage"`). */
  id: string;
  /** Maximum uses. */
  max: PoolMax;
  /** Rest that restores the pool to `max`. */
  resetOn: RestType;
  /** Class level from which a Short Rest restores it fully (Font of Inspiration: `5`). */
  shortRestFromLevel?: number;
  /** Uses regained on a Short Rest when `resetOn` is `"LONG_REST"` (Rage, Channel Divinity: `1`). */
  shortRestRegain?: number;
}

/** Engine `ModifierPhase` (snake_case wire value). */
export type ModifierPhase = "BASE" | "ADD" | "MULTIPLY" | "OVERRIDE" | "CLAMP_MIN" | "CLAMP_MAX";

/** One engine `AttributeModifier` targeting a `system.json` input or derived key. */
export interface FeatureModifier {
  /** DAG key (`"speed"`, `"save_str"`, `"skill_arcana_prof"`, `"ac_base"`). */
  target: string;
  /** Pipeline phase. */
  phase: ModifierPhase;
  /** Operand (also the magnitude used when same-named effects are deduplicated). */
  value: number;
  /** Optional DAG expression replacing `value` (e.g. `"max(1, cha_mod)"`). */
  formula?: string;
}

/** What a roll rule applies to. */
export type RollScope =
  | { roll: "save"; ability: AbilityId }
  | { roll: "check"; ability: AbilityId; skill?: SkillId }
  | { roll: "initiative" }
  | { roll: "death_save" }
  | { roll: "attack"; source: "weapon_str" | "spell" }
  /** Attack rolls made against the feature's owner (Reckless Attack). */
  | { roll: "attacked" };

/** Roll rule granted by a feature. */
export type FeatureRollRule =
  /** Advantage on the scoped roll (feed it to `conditions.ts` `ExtraRollSources`). */
  | { kind: "advantage"; on: RollScope }
  /** Treat a d20 below `value` as `value` on proficient ability checks (Reliable Talent). */
  | { kind: "minimum_d20"; value: number; on: RollScope };

/** Catalogue record of one class or subclass feature. */
export interface ClassFeatureSpec {
  /** Stable id (banner invariant 4). */
  id: string;
  /** Canonical SRD 5.2.1 English name. */
  name: string;
  /** Class granting the feature. */
  classId: SrdClassId;
  /** Subclass compendium id for subclass features (`"srd:subclass:champion"`). */
  subclassId?: string;
  /** Class level at which it is gained (`1..=20`). */
  level: number;
  /** D12 classification. */
  automation: ClassFeatureAutomation;
  /** Limited-use pool. */
  pool?: ClassFeaturePoolSpec;
  /** Effects and roll rules apply only while the id is in `actor.activeFeatureIds`. */
  toggle?: boolean;
  /** `ActiveEffect` modifiers at a class level. */
  effects?: (level: number) => readonly FeatureModifier[];
  /** Roll rules. */
  rolls?: readonly FeatureRollRule[];
  /** Value shown on the sheet at a class level (`"+2"`, `"3d6"`, `"d8"`). */
  scaling?: { label: string; at: (level: number) => string };
  /** Extra attacks when taking the Attack action (Extra Attack `1`, Three Extra Attacks `3`). */
  extraAttacks?: number;
  /** Natural d20 roll from which a weapon or unarmed attack is a critical hit. */
  criticalRange?: number;
  /** Damage resistances (while active for toggles). */
  resistances?: readonly DamageType[];
  /** Bonus to Strength-based melee weapon damage at a class level (Rage Damage). */
  strMeleeDamageBonus?: (level: number) => number;
  /** Ability whose modifier (min `+1`) is added to weapon attack rolls (Sacred Weapon). */
  weaponAttackBonusAbility?: AbilityId;
}

/** Highest table value whose level key is `<= level`, `0` below the first key. */
export function valueAtLevel(table: Readonly<Record<number, number>>, level: number): number {
  let value = 0;
  for (const [key, entry] of Object.entries(table)) {
    if (Number(key) <= level) value = entry;
  }
  return value;
}

const ALL_ABILITIES: readonly AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

const SKILL_IDS: readonly SkillId[] = [
  "acrobatics", "animal_handling", "arcana", "athletics", "deception", "history", "insight", "intimidation",
  "investigation", "medicine", "nature", "perception", "performance", "persuasion", "religion",
  "sleight_of_hand", "stealth", "survival",
];

const pool = (
  id: string,
  max: PoolMax,
  resetOn: RestType,
  extra: Partial<Pick<ClassFeaturePoolSpec, "shortRestFromLevel" | "shortRestRegain">> = {}
): ClassFeaturePoolSpec => ({ id, max, resetOn, ...extra });

const once = (id: string, resetOn: RestType = "LONG_REST") => pool(id, { byLevel: { 1: 1 } }, resetOn);

const die = (table: Readonly<Record<number, number>>) => (level: number) => `d${valueAtLevel(table, level)}`;

const abilityBonus = (ability: AbilityId, max: number): FeatureModifier => ({
  target: ability,
  phase: "ADD",
  value: 4,
  formula: `min(4, max(0, ${max} - ${ability}))`,
});

/** Fields of a catalogue rule; the id, name, class and level come from the progression. */
type FeatureRule = Omit<ClassFeatureSpec, "id" | "name" | "classId" | "subclassId" | "level">;

const AUTO = { automation: "automated" } as const;
const DESCRIBED = { automation: "described" } as const;

/** Rules by `"<class>:<slug>"`; class features without an entry are `described`. */
const CLASS_RULES: Readonly<Record<string, FeatureRule>> = {
  // Barbarian
  "barbarian:rage": {
    ...AUTO,
    pool: pool("barbarian_rage", { byLevel: { 1: 2, 3: 3, 6: 4, 12: 5, 17: 6 } }, "LONG_REST", { shortRestRegain: 1 }),
    toggle: true,
    rolls: [
      { kind: "advantage", on: { roll: "check", ability: "str" } },
      { kind: "advantage", on: { roll: "save", ability: "str" } },
    ],
    resistances: ["bludgeoning", "piercing", "slashing"],
    strMeleeDamageBonus: (level) => valueAtLevel({ 1: 2, 9: 3, 16: 4 }, level),
    scaling: { label: "Rage Damage", at: (level) => `+${valueAtLevel({ 1: 2, 9: 3, 16: 4 }, level)}` },
  },
  "barbarian:unarmored_defense": AUTO,
  "barbarian:weapon_mastery": AUTO,
  "barbarian:danger_sense": { ...AUTO, rolls: [{ kind: "advantage", on: { roll: "save", ability: "dex" } }] },
  "barbarian:reckless_attack": {
    ...AUTO,
    toggle: true,
    rolls: [
      { kind: "advantage", on: { roll: "attack", source: "weapon_str" } },
      { kind: "advantage", on: { roll: "attacked" } },
    ],
  },
  "barbarian:extra_attack": { ...AUTO, extraAttacks: 1 },
  "barbarian:fast_movement": {
    ...AUTO,
    effects: () => [{ target: "speed", phase: "ADD", value: 10, formula: "10 * (1 - armor_worn * (1 - armor_dex_applies))" }],
  },
  "barbarian:feral_instinct": { ...AUTO, rolls: [{ kind: "advantage", on: { roll: "initiative" } }] },
  "barbarian:brutal_strike": { ...AUTO, scaling: { label: "Brutal Strike", at: (level) => (level >= 17 ? "2d10" : "1d10") } },
  "barbarian:primal_champion": { ...AUTO, effects: () => [abilityBonus("str", 25), abilityBonus("con", 25)] },
  // Bard
  "bard:bardic_inspiration": {
    ...AUTO,
    pool: pool("bard_bardic_inspiration", { abilityMod: "cha", min: 1 }, "LONG_REST", { shortRestFromLevel: 5 }),
    scaling: { label: "Bardic Inspiration", at: die({ 1: 6, 5: 8, 10: 10, 15: 12 }) },
  },
  "bard:spellcasting": AUTO,
  "bard:jack_of_all_trades": {
    ...AUTO,
    effects: () => SKILL_IDS.map((skill) => ({ target: `skill_${skill}_prof`, phase: "BASE", value: 0.5 })),
  },
  "bard:font_of_inspiration": AUTO,
  // Cleric
  "cleric:spellcasting": AUTO,
  "cleric:channel_divinity": {
    ...DESCRIBED,
    pool: pool("cleric_channel_divinity", { byLevel: { 2: 2, 6: 3, 18: 4 } }, "LONG_REST", { shortRestRegain: 1 }),
  },
  "cleric:sear_undead": { ...DESCRIBED, scaling: { label: "Sear Undead", at: () => "WIS mod d8" } },
  "cleric:divine_intervention": { ...DESCRIBED, pool: once("cleric_divine_intervention") },
  // Druid
  "druid:spellcasting": AUTO,
  "druid:wild_shape": {
    ...DESCRIBED,
    pool: pool("druid_wild_shape", { byLevel: { 2: 2, 6: 3, 17: 4 } }, "LONG_REST", { shortRestRegain: 1 }),
  },
  "druid:wild_resurgence": { ...DESCRIBED, pool: once("druid_wild_resurgence") },
  // Fighter
  "fighter:weapon_mastery": AUTO,
  "fighter:second_wind": {
    ...DESCRIBED,
    pool: pool("fighter_second_wind", { byLevel: { 1: 2, 4: 3, 10: 4 } }, "LONG_REST", { shortRestRegain: 1 }),
    scaling: { label: "Second Wind", at: (level) => `1d10 + ${level}` },
  },
  "fighter:action_surge": { ...DESCRIBED, pool: pool("fighter_action_surge", { byLevel: { 2: 1, 17: 2 } }, "SHORT_REST") },
  "fighter:extra_attack": { ...AUTO, extraAttacks: 1 },
  "fighter:indomitable": { ...DESCRIBED, pool: pool("fighter_indomitable", { byLevel: { 9: 1, 13: 2, 17: 3 } }, "LONG_REST") },
  "fighter:two_extra_attacks": { ...AUTO, extraAttacks: 2 },
  "fighter:indomitable_two_uses": AUTO,
  "fighter:action_surge_two_uses": AUTO,
  "fighter:indomitable_three_uses": AUTO,
  "fighter:three_extra_attacks": { ...AUTO, extraAttacks: 3 },
  // Monk
  "monk:martial_arts": { ...AUTO, scaling: { label: "Martial Arts", at: die({ 1: 6, 5: 8, 11: 10, 17: 12 }) } },
  "monk:unarmored_defense": AUTO,
  "monk:monk_s_focus": { ...DESCRIBED, pool: pool("monk_focus_points", { perLevel: 1 }, "SHORT_REST") },
  "monk:unarmored_movement": {
    ...AUTO,
    effects: (level) => {
      const bonus = valueAtLevel({ 2: 10, 6: 15, 10: 20, 14: 25, 18: 30 }, level);
      return [{ target: "speed", phase: "ADD", value: bonus, formula: `(1 - armor_worn) * (1 - min(shield_bonus, 1)) * ${bonus}` }];
    },
  },
  "monk:uncanny_metabolism": { ...DESCRIBED, pool: once("monk_uncanny_metabolism") },
  "monk:extra_attack": { ...AUTO, extraAttacks: 1 },
  "monk:disciplined_survivor": {
    ...AUTO,
    effects: () => ALL_ABILITIES.map((ab) => ({ target: `save_${ab}_prof`, phase: "BASE", value: 1 })),
  },
  "monk:body_and_mind": { ...AUTO, effects: () => [abilityBonus("dex", 25), abilityBonus("wis", 25)] },
  // Paladin
  "paladin:lay_on_hands": { ...DESCRIBED, pool: pool("paladin_lay_on_hands", { perLevel: 5 }, "LONG_REST") },
  "paladin:spellcasting": AUTO,
  "paladin:weapon_mastery": AUTO,
  "paladin:paladin_s_smite": {
    ...AUTO,
    pool: once("paladin_free_divine_smite"),
    scaling: { label: "Divine Smite", at: () => "2d8 + 1d8 per slot level above 1" },
  },
  "paladin:channel_divinity": {
    ...DESCRIBED,
    pool: pool("paladin_channel_divinity", { byLevel: { 3: 2, 11: 3 } }, "LONG_REST", { shortRestRegain: 1 }),
  },
  "paladin:extra_attack": { ...AUTO, extraAttacks: 1 },
  "paladin:faithful_steed": { ...DESCRIBED, pool: once("paladin_faithful_steed") },
  "paladin:aura_of_protection": {
    ...AUTO,
    effects: () => ALL_ABILITIES.map((ab) => ({ target: `save_${ab}`, phase: "ADD", value: 1, formula: "max(1, cha_mod)" })),
    scaling: { label: "Aura radius", at: (level) => (level >= 18 ? "30 ft" : "10 ft") },
  },
  "paladin:radiant_strikes": { ...DESCRIBED, scaling: { label: "Radiant Strikes", at: () => "1d8 radiant" } },
  "paladin:aura_expansion": AUTO,
  // Ranger
  "ranger:spellcasting": AUTO,
  "ranger:favored_enemy": {
    ...DESCRIBED,
    pool: pool("ranger_favored_enemy", { byLevel: { 1: 2, 5: 3, 9: 4, 13: 5, 17: 6 } }, "LONG_REST"),
  },
  "ranger:weapon_mastery": AUTO,
  "ranger:extra_attack": { ...AUTO, extraAttacks: 1 },
  "ranger:tireless": { ...DESCRIBED, pool: pool("ranger_tireless", { abilityMod: "wis", min: 1 }, "LONG_REST") },
  "ranger:nature_s_veil": { ...DESCRIBED, pool: pool("ranger_natures_veil", { abilityMod: "wis", min: 1 }, "LONG_REST") },
  // Rogue
  "rogue:sneak_attack": { ...AUTO, scaling: { label: "Sneak Attack", at: (level) => `${Math.ceil(level / 2)}d6` } },
  "rogue:weapon_mastery": AUTO,
  "rogue:reliable_talent": {
    ...AUTO,
    rolls: ALL_ABILITIES.map((ability) => ({ kind: "minimum_d20", value: 10, on: { roll: "check", ability } })),
  },
  "rogue:slippery_mind": {
    ...AUTO,
    effects: () => [
      { target: "save_wis_prof", phase: "BASE", value: 1 },
      { target: "save_cha_prof", phase: "BASE", value: 1 },
    ],
  },
  "rogue:stroke_of_luck": { ...DESCRIBED, pool: once("rogue_stroke_of_luck", "SHORT_REST") },
  // Sorcerer
  "sorcerer:spellcasting": AUTO,
  "sorcerer:innate_sorcery": {
    ...AUTO,
    pool: pool("sorcerer_innate_sorcery", { byLevel: { 1: 2 } }, "LONG_REST"),
    toggle: true,
    effects: () => [{ target: "spell_save_dc", phase: "ADD", value: 1 }],
    rolls: [{ kind: "advantage", on: { roll: "attack", source: "spell" } }],
  },
  "sorcerer:font_of_magic": { ...AUTO, pool: pool("sorcerer_sorcery_points", { perLevel: 1 }, "LONG_REST") },
  "sorcerer:sorcerous_restoration": { ...DESCRIBED, pool: once("sorcerer_sorcerous_restoration") },
  // Warlock
  "warlock:pact_magic": AUTO,
  "warlock:magical_cunning": { ...DESCRIBED, pool: once("warlock_magical_cunning") },
  "warlock:contact_patron": { ...DESCRIBED, pool: once("warlock_contact_patron") },
  "warlock:mystic_arcanum_level_6_spell": { ...DESCRIBED, pool: once("warlock_mystic_arcanum_6") },
  "warlock:mystic_arcanum_level_7_spell": { ...DESCRIBED, pool: once("warlock_mystic_arcanum_7") },
  "warlock:mystic_arcanum_level_8_spell": { ...DESCRIBED, pool: once("warlock_mystic_arcanum_8") },
  "warlock:mystic_arcanum_level_9_spell": { ...DESCRIBED, pool: once("warlock_mystic_arcanum_9") },
  // Wizard
  "wizard:spellcasting": AUTO,
  "wizard:arcane_recovery": {
    ...DESCRIBED,
    pool: once("wizard_arcane_recovery"),
    scaling: { label: "Slot levels recovered", at: (level) => `${Math.ceil(level / 2)}` },
  },
  "wizard:signature_spells": { ...DESCRIBED, pool: pool("wizard_signature_spells", { byLevel: { 1: 2 } }, "SHORT_REST") },
};

/** SRD 5.2.1 subclass features: `[level, name, rule?]` (no rule = described). */
const SUBCLASS_FEATURES: Readonly<Record<string, { classId: SrdClassId; features: readonly [number, string, FeatureRule?][] }>> = {
  "srd:subclass:berserker": {
    classId: "barbarian",
    features: [
      [3, "Frenzy", { ...AUTO, scaling: { label: "Frenzy", at: (level) => `${valueAtLevel({ 1: 2, 9: 3, 16: 4 }, level)}d6` } }],
      [6, "Mindless Rage"],
      [10, "Retaliation"],
      [14, "Intimidating Presence", { ...DESCRIBED, pool: once("berserker_intimidating_presence") }],
    ],
  },
  "srd:subclass:lore": {
    classId: "bard",
    features: [[3, "Bonus Proficiencies"], [3, "Cutting Words"], [6, "Magical Discoveries"], [14, "Peerless Skill"]],
  },
  "srd:subclass:life": {
    classId: "cleric",
    features: [
      [3, "Disciple of Life"],
      [3, "Life Domain Spells", AUTO],
      [3, "Preserve Life", { ...DESCRIBED, scaling: { label: "Preserve Life", at: (level) => `${5 * level} HP` } }],
      [6, "Blessed Healer"],
      [17, "Supreme Healing"],
    ],
  },
  "srd:subclass:land": {
    classId: "druid",
    features: [
      [3, "Circle of the Land Spells", AUTO],
      [3, "Land's Aid"],
      [6, "Natural Recovery", { ...DESCRIBED, pool: once("land_natural_recovery") }],
      [10, "Nature's Ward"],
      [14, "Nature's Sanctuary"],
    ],
  },
  "srd:subclass:champion": {
    classId: "fighter",
    features: [
      [3, "Improved Critical", { ...AUTO, criticalRange: 19 }],
      [
        3,
        "Remarkable Athlete",
        {
          ...AUTO,
          rolls: [
            { kind: "advantage", on: { roll: "initiative" } },
            { kind: "advantage", on: { roll: "check", ability: "str", skill: "athletics" } },
          ],
        },
      ],
      [7, "Additional Fighting Style"],
      [10, "Heroic Warrior"],
      [15, "Superior Critical", { ...AUTO, criticalRange: 18 }],
      [18, "Survivor", { ...AUTO, rolls: [{ kind: "advantage", on: { roll: "death_save" } }] }],
    ],
  },
  "srd:subclass:open_hand": {
    classId: "monk",
    features: [
      [3, "Open Hand Technique"],
      [6, "Wholeness of Body", { ...DESCRIBED, pool: pool("open_hand_wholeness_of_body", { abilityMod: "wis", min: 1 }, "LONG_REST") }],
      [11, "Fleet Step"],
      [17, "Quivering Palm"],
    ],
  },
  "srd:subclass:devotion": {
    classId: "paladin",
    features: [
      [3, "Oath of Devotion Spells", AUTO],
      [3, "Sacred Weapon", { ...AUTO, toggle: true, weaponAttackBonusAbility: "cha" }],
      [7, "Aura of Devotion"],
      [15, "Smite of Protection"],
      [20, "Holy Nimbus", { ...DESCRIBED, pool: once("devotion_holy_nimbus") }],
    ],
  },
  "srd:subclass:hunter": {
    classId: "ranger",
    features: [[3, "Hunter's Lore"], [3, "Hunter's Prey"], [7, "Defensive Tactics"], [11, "Superior Hunter's Prey"], [15, "Superior Hunter's Defense"]],
  },
  "srd:subclass:thief": {
    classId: "rogue",
    features: [[3, "Fast Hands"], [3, "Second-Story Work"], [9, "Supreme Sneak"], [13, "Use Magic Device"], [17, "Thief's Reflexes"]],
  },
  "srd:subclass:draconic": {
    classId: "sorcerer",
    features: [
      [
        3,
        "Draconic Resilience",
        { ...AUTO, effects: () => [{ target: "ac_base", phase: "BASE", value: 10, formula: "(1 - armor_worn) * (10 + dex_mod + cha_mod)" }] },
      ],
      [3, "Draconic Spells", AUTO],
      [6, "Elemental Affinity"],
      [14, "Dragon Wings", { ...DESCRIBED, pool: once("draconic_dragon_wings") }],
      [18, "Dragon Companion", { ...DESCRIBED, pool: once("draconic_dragon_companion") }],
    ],
  },
  "srd:subclass:fiend": {
    classId: "warlock",
    features: [
      [3, "Dark One's Blessing", { ...DESCRIBED, scaling: { label: "Temporary HP", at: (level) => `CHA mod + ${level}` } }],
      [3, "Fiend Spells", AUTO],
      [6, "Dark One's Own Luck", { ...DESCRIBED, pool: pool("fiend_dark_ones_own_luck", { abilityMod: "cha", min: 1 }, "LONG_REST") }],
      [10, "Fiendish Resilience"],
      [14, "Hurl Through Hell", { ...DESCRIBED, pool: once("fiend_hurl_through_hell") }],
    ],
  },
  "srd:subclass:evocation": {
    classId: "wizard",
    features: [
      [3, "Evocation Savant"],
      [3, "Potent Cantrip"],
      [6, "Sculpt Spells"],
      [10, "Empowered Evocation", { ...DESCRIBED, scaling: { label: "Empowered Evocation", at: () => "+INT mod" } }],
      [14, "Overchannel", { ...DESCRIBED, pool: once("evocation_overchannel") }],
    ],
  },
};

/** `"Monk's Focus"` -> `"monk_s_focus"`, `"Indomitable (two uses)"` -> `"indomitable_two_uses"`. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function buildCatalogue(): ClassFeatureSpec[] {
  const specs: ClassFeatureSpec[] = [];
  for (const [classId, progression] of Object.entries(SRD_CLASS_PROGRESSION) as [SrdClassId, ClassProgression][]) {
    const seen = new Set<string>();
    for (const [level, names] of Object.entries(progression.features)) {
      for (const name of names) {
        const key = slug(name);
        const id = seen.has(key) ? `${classId}:${key}_${level}` : `${classId}:${key}`;
        seen.add(key);
        specs.push({ ...(CLASS_RULES[`${classId}:${key}`] ?? DESCRIBED), id, name, classId, level: Number(level) });
      }
    }
  }
  const unmatched = Object.keys(CLASS_RULES).filter((key) => !specs.some((spec) => spec.id === key));
  if (unmatched.length > 0) throw new Error(`ClassFeature rules without a progression feature: ${unmatched.join(", ")}`);
  for (const [subclassId, { classId, features }] of Object.entries(SUBCLASS_FEATURES)) {
    const short = subclassId.replace(/^srd:subclass:/, "");
    for (const [level, name, rule] of features) {
      specs.push({ ...(rule ?? DESCRIBED), id: `${short}:${slug(name)}`, name, classId, subclassId, level });
    }
  }
  return specs;
}

let catalogue: readonly ClassFeatureSpec[] | undefined;

/**
 * Every `ClassFeature` of the 12 SRD classes and 12 SRD subclasses, class
 * features first. Built on first call: `progression.ts` imports `manifest.ts`,
 * which imports this module, so reading `SRD_CLASS_PROGRESSION` at module
 * evaluation would hit the import cycle before progression is initialised.
 */
export function srdClassFeatures(): readonly ClassFeatureSpec[] {
  catalogue ??= buildCatalogue();
  return catalogue;
}

/** Subclass compendium ids covered by the catalogue. */
export const SRD_CLASS_FEATURE_SUBCLASSES: readonly string[] = Object.keys(SUBCLASS_FEATURES);

function normalizedSubclassId(actor: Dnd5eActorData): string | undefined {
  const raw = actor.subclassId ?? actor.attributes.subclassId;
  if (!raw) return undefined;
  return raw.startsWith("srd:subclass:") ? raw : `srd:subclass:${raw}`;
}

/** Features `actor` has at its level: class features, then its subclass's features. */
export function classFeaturesFor(actor: Dnd5eActorData): ClassFeatureSpec[] {
  const classId = getActorClassId(actor)?.replace(/^srd:class:/, "").toLowerCase();
  const subclassId = normalizedSubclassId(actor);
  const level = actor.attributes.level;
  return srdClassFeatures().filter(
    (spec) => spec.classId === classId && spec.level <= level && (!spec.subclassId || spec.subclassId === subclassId)
  );
}

/** `true` when `spec` is in force: not a toggle, or toggled on in `actor.activeFeatureIds`. */
export function isFeatureActive(actor: Dnd5eActorData, spec: ClassFeatureSpec): boolean {
  return !spec.toggle || (actor.activeFeatureIds ?? []).includes(spec.id);
}

/** Engine `ActiveEffect` JSON (snake_case) built from feature modifiers. */
export interface ClassFeatureActiveEffect {
  id: string;
  source_name: string;
  enabled: true;
  duration_rounds_remaining: null;
  concentration_caster_id: null;
  modifiers: FeatureModifier[];
}

/**
 * `ActiveEffect`s of `actor`'s features in force (banner invariant 2), with
 * deterministic UUIDs so evaluations are reproducible.
 */
export function classFeatureEffects(actor: Dnd5eActorData): ClassFeatureActiveEffect[] {
  const level = actor.attributes.level;
  return classFeaturesFor(actor)
    .filter((spec) => spec.effects && isFeatureActive(actor, spec))
    .map((spec, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      source_name: `ClassFeature:${spec.id}`,
      enabled: true,
      duration_rounds_remaining: null,
      concentration_caster_id: null,
      modifiers: spec.effects!(level).map((modifier) => ({ ...modifier })),
    }));
}

/** Maximum uses of `spec` at `level` with the evaluated ability modifiers. */
export function poolMax(spec: ClassFeaturePoolSpec, level: number, abilityMods: Readonly<Record<AbilityId, number>>): number {
  const max = spec.max;
  if ("byLevel" in max) return valueAtLevel(max.byLevel, level);
  if ("abilityMod" in max) return Math.max(max.min, abilityMods[max.abilityMod]);
  return max.perLevel * level;
}

/** Rest that restores `spec` fully at `level`. */
export function poolResetOn(spec: ClassFeaturePoolSpec, level: number): RestType {
  return spec.shortRestFromLevel !== undefined && level >= spec.shortRestFromLevel ? "SHORT_REST" : spec.resetOn;
}

/** A class feature pool with its tracked value, as listed on the sheet. */
export interface DerivedResourcePool {
  /** Key in `actor.resources`. */
  id: string;
  /** Feature that owns the pool. */
  featureId: string;
  /** Remaining uses (`0..=max`), `max` when untracked. */
  current: number;
  /** Maximum uses at the actor's level. */
  max: number;
  /** Rest restoring it fully. */
  resetOn: RestType;
  /** Uses regained on a Short Rest when `resetOn` is `"LONG_REST"`. */
  shortRestRegain?: number;
}

/** Pools of `actor`'s features with `current` from `actor.resources` (capped at `max`). */
export function deriveResourcePools(
  actor: Dnd5eActorData,
  abilityMods: Readonly<Record<AbilityId, number>>
): DerivedResourcePool[] {
  const level = actor.attributes.level;
  return classFeaturesFor(actor).flatMap((spec): DerivedResourcePool[] => {
    if (!spec.pool) return [];
    const max = poolMax(spec.pool, level, abilityMods);
    if (max <= 0) return [];
    const tracked = actor.resources?.[spec.pool.id]?.current;
    return [
      {
        id: spec.pool.id,
        featureId: spec.id,
        current: Math.max(0, Math.min(max, tracked ?? max)),
        max,
        resetOn: poolResetOn(spec.pool, level),
        ...(spec.pool.shortRestRegain ? { shortRestRegain: spec.pool.shortRestRegain } : {}),
      },
    ];
  });
}

/**
 * `actor.resources` after a rest: every class feature pool is written with
 * its current maximum; a Long Rest refills all of them, a Short Rest refills
 * `SHORT_REST` pools and adds `shortRestRegain` uses to the others.
 */
export function recoverClassFeaturePools(
  actor: Dnd5eActorData,
  rest: RestType,
  abilityMods: Readonly<Record<AbilityId, number>>
): Record<string, ResourcePool> {
  const resources: Record<string, ResourcePool> = { ...(actor.resources ?? {}) };
  for (const derived of deriveResourcePools(actor, abilityMods)) {
    let current = derived.current;
    if (rest === "LONG_REST" || derived.resetOn === "SHORT_REST") current = derived.max;
    else if (derived.shortRestRegain) current = Math.min(derived.max, current + derived.shortRestRegain);
    resources[derived.id] = {
      current,
      max: derived.max,
      resetOn: derived.resetOn,
      ...(derived.shortRestRegain ? { shortRestRegain: derived.shortRestRegain } : {}),
    };
  }
  return resources;
}

/** Roll rule with the feature that grants it. */
export type DerivedFeatureRollRule = FeatureRollRule & { featureId: string };

/** Numbers and roll rules the features in force add to play. */
export interface DerivedFeatureRules {
  /** Attacks per Attack action (`1` + the best Extra Attack). */
  attacksPerAction: number;
  /** Natural d20 roll from which weapon attacks crit (`20`, Champion `19` / `18`). */
  criticalRange: number;
  /** Roll rules in force (advantage sources, Reliable Talent). */
  rolls: DerivedFeatureRollRule[];
  /** Damage resistances from active features (Rage). */
  resistances: DamageType[];
  /** Added to Strength-based melee weapon damage (Rage Damage while raging). */
  strMeleeDamageBonus: number;
  /** Ability whose modifier (min `+1`) is added to weapon attack rolls (Sacred Weapon). */
  weaponAttackBonusAbility?: AbilityId;
}

/** Aggregates the attacks, critical range, roll rules and resistances of `actor`'s features in force. */
export function deriveFeatureRules(actor: Dnd5eActorData): DerivedFeatureRules {
  const level = actor.attributes.level;
  const active = classFeaturesFor(actor).filter((spec) => isFeatureActive(actor, spec));
  const rules: DerivedFeatureRules = {
    attacksPerAction: 1 + Math.max(0, ...active.map((spec) => spec.extraAttacks ?? 0)),
    criticalRange: Math.min(20, ...active.map((spec) => spec.criticalRange ?? 20)),
    rolls: active.flatMap((spec) => (spec.rolls ?? []).map((rule) => ({ ...rule, featureId: spec.id }))),
    resistances: [...new Set(active.flatMap((spec) => spec.resistances ?? []))],
    strMeleeDamageBonus: active.reduce((sum, spec) => sum + (spec.strMeleeDamageBonus?.(level) ?? 0), 0),
  };
  const sacred = active.find((spec) => spec.weaponAttackBonusAbility);
  if (sacred) rules.weaponAttackBonusAbility = sacred.weaponAttackBonusAbility;
  return rules;
}
