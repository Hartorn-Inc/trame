/**
 * ============================================================================
 * SHEET DERIVATIONS: ARMOR, ATTACKS, SPELLCASTING, FEATURES (derivations.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Projects what a character sheet lists beyond the core numbers: the AC
 * inputs of equipped armor and shields, attacks from equipped weapons and
 * damaging spells, the spellcasting summary (slots, Pact Magic, cantrips,
 * prepared spells, DC and attack bonus), and the features gained from class,
 * subclass, species, background and feats. Without it a sheet shows no
 * attacks, a level-1 caster shows no slots and armor never changes AC
 * (UA4, GS5, GS6, GS12).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Numbers Come From The DAG`:
 *      - Modifiers, proficiency bonus, exhaustion penalty, spell save DC and
 *        spell attack bonus are `system.json` DAG outputs (`evaluated`).
 *        Attack bonuses only add those outputs together (ability modifier,
 *        proficiency bonus when proficient, minus the exhaustion penalty).
 *   2. `Armor Feeds The DAG, Best Wins`:
 *      - An equipped armor item replaces the `armor_*` inputs and an equipped
 *        shield sets `shield_bonus`; the DAG still keeps the best of armored
 *        AC and Unarmored Defense.
 *   3. `Equipped Only`:
 *      - Only items with `equipped: true` produce attacks or AC; the first
 *        equipped body armor wins.
 *   4. `Tables Before Tracking`:
 *      - Slot maxima come from the class tables (`reconcileSlots`) for the
 *        actor's level, so a level-1 caster always shows its slots; tracked
 *        `spellSlots.current` values are kept, capped at the maximum.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `computeDnd5eSheetDerived(actor)` (manifest.ts)
 *     ├── 1. `equippedArmorInputs(actor)` overrides the DAG armor inputs.
 *     ├── 2. The DAG is evaluated (WASM).
 *     ├── 3. `deriveSpellcasting` -> slots, spell lists, feat spells.
 *     ├── 4. `deriveAttacks` -> weapons, then damaging spells.
 *     └── 5. `deriveFeatures` -> class and subclass `ClassFeature`s (pools,
 *            scaling, toggles), species, background, feats.
 * ============================================================================
 */

import {
  classFeaturesFor,
  deriveFeatureRules,
  deriveResourcePools,
  isFeatureActive,
  type ClassFeatureSpec,
  type DerivedFeatureRules,
  type DerivedResourcePool,
} from "./classFeatures.ts";
import { getActorClassId, getActorProficiencies, getCantripsKnown, getPreparedSpellCount } from "./classRules.ts";
import { CompendiumResolver, type CompendiumEntry } from "./compendium.ts";
import { getBackgroundRules, getSpeciesRules, srdFeatKey } from "./origins.ts";
import { getCasterTypeForClass, getClassProgression, reconcileSlots } from "./progression.ts";
import type {
  AbilityId,
  ActorItem,
  DamageType,
  DerivedAttack,
  DerivedFeature,
  DerivedSpellcasting,
  DerivedSpellRef,
  DerivedSpellSlot,
  Dnd5eActorData,
  SpellSlotsState,
  WeaponProficiency,
} from "./types.ts";

/** Evaluated `system.json` DAG values keyed by node name. */
export type EvaluatedDag = Readonly<Record<string, number>>;

/** Spell save DC and spell attack bonus for one spellcasting ability (DAG outputs). */
export type SpellNumbersFor = (ability: AbilityId) => { spellSaveDc: number; spellAttackBonus: number };

const ITEM_ENTITY_TYPES = new Set(["item", "weapon", "armor"]);

/** Item name index per default resolver, rebuilt when `installFullSystemSrd` swaps it. */
const nameIndexes = new WeakMap<CompendiumResolver, Map<string, CompendiumEntry>>();

function defaultItemByName(name: string): CompendiumEntry | undefined {
  const resolver = CompendiumResolver.getDefault();
  let nameIndex = nameIndexes.get(resolver);
  if (!nameIndex) {
    nameIndex = new Map();
    for (const entry of resolver.list()) {
      if (ITEM_ENTITY_TYPES.has(entry.entityType)) nameIndex.set(entry.name.toLowerCase(), entry);
    }
    nameIndexes.set(resolver, nameIndex);
  }
  const key = name.trim().toLowerCase();
  return nameIndex.get(key) ?? nameIndex.get(key.replace(/s$/, "")) ?? nameIndex.get(key.replace(/es$/, ""));
}

/**
 * Splits an SRD equipment line into quantity and name (`"4 Handaxes"` ->
 * `{ quantity: 4, name: "Handaxes" }`) and finds the matching compendium item
 * (plural `s`/`es` dropped). `entry` is `undefined` when the item is not in
 * the SRD catalog.
 */
export function parseEquipmentLine(line: string): { name: string; quantity: number; entry?: CompendiumEntry } {
  const match = /^(\d+)\s+(.+)$/.exec(line.trim());
  const name = match ? match[2] : line.trim();
  return { name, quantity: match ? Number(match[1]) : 1, entry: defaultItemByName(name) };
}

function resolveItem(item: ActorItem): CompendiumEntry | undefined {
  if (item.compendiumId) return CompendiumResolver.getDefault().get(item.compendiumId);
  return parseEquipmentLine(item.name).entry;
}

function equippedEntries(actor: Dnd5eActorData): { item: ActorItem; entry: CompendiumEntry }[] {
  return (actor.items ?? []).flatMap((item) => {
    const entry = item.equipped ? resolveItem(item) : undefined;
    return entry ? [{ item, entry }] : [];
  });
}

/** Large enough to never cap a Dexterity modifier (max `+10` at score `30`). */
const UNCAPPED_DEX = 100;

/**
 * DAG armor inputs from the actor's equipped items: the first equipped body
 * armor sets `armor_worn`, `armor_base`, `armor_dex_applies` and
 * `armor_max_dex` (`maxDexBonus`, uncapped when `null`); an equipped shield
 * sets `shield_bonus` (`armorClassBonus`, default `2`). Keys are omitted when
 * no such item is equipped, so the attribute-based inputs stay in force.
 */
export function equippedArmorInputs(actor: Dnd5eActorData): Record<string, number> {
  const inputs: Record<string, number> = {};
  for (const { entry } of equippedEntries(actor)) {
    const data = entry.data;
    if (data.itemType !== "armor") continue;
    if (data.category === "shield") {
      inputs.shield_bonus ??= Number(data.armorClassBonus ?? 2);
    } else if (inputs.armor_worn === undefined) {
      inputs.armor_worn = 1;
      inputs.armor_base = Number(data.armorClass);
      inputs.armor_dex_applies = data.dexBonus === false ? 0 : 1;
      inputs.armor_max_dex = typeof data.maxDexBonus === "number" ? data.maxDexBonus : UNCAPPED_DEX;
    }
  }
  return inputs;
}

function parseRangeFt(range: unknown): { normal: number; long?: number } | undefined {
  if (typeof range !== "string") return undefined;
  const pair = /^(\d+)\s*\/\s*(\d+)$/.exec(range.trim());
  if (pair) return { normal: Number(pair[1]), long: Number(pair[2]) };
  const feet = /^(\d+)\s*(feet|foot|ft)/i.exec(range.trim());
  return feet ? { normal: Number(feet[1]) } : undefined;
}

/**
 * Whether `tokens` cover a weapon: its category (`"simple"`, `"martial"`),
 * its compendium id, or the Monk / Rogue Martial subsets.
 */
export function isWeaponProficient(tokens: readonly WeaponProficiency[], entry: CompendiumEntry): boolean {
  const category = entry.data.category;
  const properties = (entry.data.properties as string[] | undefined) ?? [];
  const light = properties.includes("light");
  return tokens.some(
    (token) =>
      token === category ||
      token === entry.id ||
      (category === "martial" && token === "martial_light" && light) ||
      (category === "martial" && token === "martial_finesse_or_light" && (light || properties.includes("finesse")))
  );
}

function weaponAttack(
  item: ActorItem,
  entry: CompendiumEntry,
  actor: Dnd5eActorData,
  v: EvaluatedDag,
  rules: DerivedFeatureRules
): DerivedAttack {
  const data = entry.data;
  const properties = (data.properties as string[] | undefined) ?? [];
  const ranged = data.weaponType === "ranged" || properties.includes("ammunition");
  const finesse = properties.includes("finesse");
  const ability: AbilityId = ranged || (finesse && v.dex_mod > v.str_mod) ? "dex" : "str";
  const proficient = isWeaponProficient(getActorProficiencies(actor).weapons, entry);
  const rangeFt = parseRangeFt(data.range);
  const featureAttackBonus = rules.weaponAttackBonusAbility ? Math.max(1, v[`${rules.weaponAttackBonusAbility}_mod`]) : 0;
  const rageBonus = !ranged && ability === "str" ? rules.strMeleeDamageBonus : 0;
  return {
    id: item.id,
    name: item.name,
    source: "weapon",
    delivery: ranged ? "ranged" : "melee",
    attackBonus: v[`${ability}_mod`] + (proficient ? v.prof_bonus : 0) - v.exhaustion_penalty + featureAttackBonus,
    damageDice: String(data.damage),
    damageModifier: v[`${ability}_mod`] + rageBonus,
    ...(rules.criticalRange < 20 ? { criticalRange: rules.criticalRange } : {}),
    ...(typeof data.versatileDamage === "string" ? { versatileDamageDice: data.versatileDamage } : {}),
    damageType: data.damageType as DamageType,
    ...(ranged ? {} : { reachFt: properties.includes("reach") ? 10 : 5 }),
    ...(rangeFt ? { rangeFt } : {}),
    properties: [...properties],
    ...(typeof data.mastery === "string" ? { mastery: data.mastery } : {}),
    proficient,
    ability,
  };
}

/** Cantrip damage dice scaled by character level (x2 at 5, x3 at 11, x4 at 17). */
export function scaleCantripDice(dice: string, characterLevel: number): string {
  const match = /^(\d+)d(\d+)$/.exec(dice.trim());
  if (!match) return dice;
  const tier = 1 + (characterLevel >= 5 ? 1 : 0) + (characterLevel >= 11 ? 1 : 0) + (characterLevel >= 17 ? 1 : 0);
  return `${Number(match[1]) * tier}d${match[2]}`;
}

function spellAttack(
  entry: CompendiumEntry,
  characterLevel: number,
  numbers: { spellSaveDc: number; spellAttackBonus: number }
): DerivedAttack | undefined {
  const data = entry.data;
  if (typeof data.damageDice !== "string" || typeof data.damageType !== "string") return undefined;
  const save = data.saveAbility as AbilityId | undefined;
  const range = String(data.range ?? "");
  const melee = data.attackType === "melee" || /^(touch|self)/i.test(range);
  const rangeFt = parseRangeFt(range);
  return {
    id: entry.id,
    name: entry.name,
    source: "spell",
    delivery: save ? "save" : melee ? "melee" : "ranged",
    attackBonus: save ? null : numbers.spellAttackBonus,
    ...(save ? { save: { ability: save, dc: numbers.spellSaveDc } } : {}),
    damageDice: data.level === 0 ? scaleCantripDice(data.damageDice, characterLevel) : data.damageDice,
    damageModifier: 0,
    damageType: data.damageType as DamageType,
    ...(melee && !save ? { reachFt: 5 } : {}),
    ...(rangeFt ? { rangeFt } : {}),
    properties: [],
    proficient: true,
  };
}

function spellRef(id: string): DerivedSpellRef {
  const entry = CompendiumResolver.getDefault().get(id);
  return { id, name: entry?.name ?? id, level: typeof entry?.data.level === "number" ? entry.data.level : null };
}

const SLOT_KEYS = ["level1", "level2", "level3", "level4", "level5", "level6", "level7", "level8", "level9"] as const;

/**
 * Spellcasting summary of `actor`, or `undefined` when it has no class
 * spellcasting, no spells and no spell feats. Slot maxima follow the class
 * table at the actor's level; `current` keeps tracked values (capped).
 * Magic Initiate spells use the feat's chosen ability through `spellNumbersFor`.
 */
export function deriveSpellcasting(
  actor: Dnd5eActorData,
  v: EvaluatedDag,
  spellNumbersFor: SpellNumbersFor
): DerivedSpellcasting | undefined {
  const classId = getActorClassId(actor);
  const level = actor.attributes.level;
  const table: SpellSlotsState = reconcileSlots(
    undefined,
    actor.attributes.casterType ?? getCasterTypeForClass(classId),
    level
  );
  const tracked = actor.spellSlots ?? {};
  const slots: DerivedSpellSlot[] = SLOT_KEYS.flatMap((key, i) => {
    const max = table[key]?.max ?? 0;
    return max > 0 ? [{ level: i + 1, max, current: Math.min(max, tracked[key]?.current ?? max) }] : [];
  });
  const pactMagic = table.pact
    ? {
        slots: table.pact.max,
        slotLevel: table.pact.slotLevel ?? 1,
        current: Math.min(table.pact.max, tracked.pact?.current ?? table.pact.max),
      }
    : undefined;

  const featSpells = (actor.featChoices ?? [])
    .filter((record) => srdFeatKey(record.featId) === "magic_initiate" && record.selections.spellcasting_ability?.[0])
    .map((record) => {
      const ability = record.selections.spellcasting_ability[0] as AbilityId;
      return {
        featId: record.featId,
        ability,
        ...spellNumbersFor(ability),
        spells: [...(record.selections.cantrips ?? []), ...(record.selections.level_1_spell ?? [])].map(spellRef),
      };
    });

  const refs = (actor.spellIds ?? []).map(spellRef);
  const cantripsKnown = getCantripsKnown(classId, level);
  const preparedSpellsMax = getPreparedSpellCount(classId, level);
  if (slots.length === 0 && !pactMagic && refs.length === 0 && featSpells.length === 0 && preparedSpellsMax === 0) {
    return undefined;
  }
  const ability = actor.attributes.spellcastingAbility ?? getClassProgression(classId)?.spellcastingAbility;
  return {
    ...(ability ? { ability } : {}),
    spellSaveDc: v.spell_save_dc,
    spellAttackBonus: v.spell_attack_bonus,
    slots,
    ...(pactMagic ? { pactMagic } : {}),
    cantripsKnown,
    preparedSpellsMax,
    cantrips: refs.filter((ref) => ref.level === 0),
    prepared: refs.filter((ref) => ref.level !== 0),
    featSpells,
  };
}

/**
 * Attacks of `actor`: each equipped weapon (STR, DEX for ranged weapons, the
 * better of both for Finesse), then each damaging class or feat spell
 * (attack roll or saving throw). Weapon attacks carry the `ClassFeature`
 * rules in force: Rage Damage on Strength melee damage, the Sacred Weapon
 * attack bonus and a Champion critical range below `20`.
 */
export function deriveAttacks(
  actor: Dnd5eActorData,
  v: EvaluatedDag,
  spells: DerivedSpellcasting | undefined
): DerivedAttack[] {
  const rules = deriveFeatureRules(actor);
  const weapons = equippedEntries(actor)
    .filter(({ entry }) => entry.data.itemType === "weapon")
    .map(({ item, entry }) => weaponAttack(item, entry, actor, v, rules));
  if (!spells) return weapons;
  const resolver = CompendiumResolver.getDefault();
  const sources = [
    { refs: [...spells.cantrips, ...spells.prepared], numbers: spells },
    ...spells.featSpells.map((feat) => ({ refs: feat.spells, numbers: feat })),
  ];
  const spellAttacks = sources.flatMap(({ refs, numbers }) =>
    refs.flatMap((ref) => {
      const entry = resolver.get(ref.id);
      const attack = entry ? spellAttack(entry, actor.attributes.level, numbers) : undefined;
      return attack ? [attack] : [];
    })
  );
  return [...weapons, ...spellAttacks];
}

function featFeatures(featIds: readonly string[], levels: readonly { featId: string; level: number }[]): DerivedFeature[] {
  const pending = [...levels];
  const resolver = CompendiumResolver.getDefault();
  return featIds.map((featId) => {
    const index = pending.findIndex((taken) => taken.featId === featId);
    const level = index >= 0 ? pending.splice(index, 1)[0].level : null;
    const key = srdFeatKey(featId);
    const id = key ? `srd:feat:${key}` : featId;
    return { name: resolver.get(id)?.name ?? featId, source: "feat", level, id };
  });
}

function isFeatId(id: string): boolean {
  return srdFeatKey(id) !== undefined || id.includes(":feat:");
}

const ABILITY_IDS: readonly AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

/** `<ability>_mod` DAG outputs (after effects) by ability. */
export function abilityModsOf(v: EvaluatedDag): Record<AbilityId, number> {
  return Object.fromEntries(ABILITY_IDS.map((ab) => [ab, v[`${ab}_mod`]])) as Record<AbilityId, number>;
}

function classFeature(spec: ClassFeatureSpec, actor: Dnd5eActorData, pools: ReadonlyMap<string, DerivedResourcePool>): DerivedFeature {
  const level = actor.attributes.level;
  const pool = spec.pool ? pools.get(spec.pool.id) : undefined;
  return {
    name: spec.name,
    source: spec.subclassId ? "subclass" : "class",
    level: spec.level,
    id: spec.id,
    automation: spec.automation,
    ...(pool
      ? {
          pool: {
            id: pool.id,
            current: pool.current,
            max: pool.max,
            resetOn: pool.resetOn,
            ...(pool.shortRestRegain ? { shortRestRegain: pool.shortRestRegain } : {}),
          },
        }
      : {}),
    ...(spec.scaling ? { scaling: { label: spec.scaling.label, value: spec.scaling.at(level) } } : {}),
    ...(spec.toggle ? { active: isFeatureActive(actor, spec) } : {}),
  };
}

/**
 * Features of `actor` in sheet order: class features up to its level (from
 * the `ClassFeature` catalogue, with D12 automation, pool and scaling), the
 * subclass (at the class's subclass level) followed by its features, species
 * traits and the background (level 1), then feats with the level recorded in
 * `featsTaken` (origin feats default to level 1). Other `features` strings
 * are kept as `"other"` with an unknown level. Pool maxima read the ability
 * modifiers of `v`.
 */
export function deriveFeatures(actor: Dnd5eActorData, v: EvaluatedDag): DerivedFeature[] {
  const resolver = CompendiumResolver.getDefault();
  const progression = getClassProgression(getActorClassId(actor));
  const pools = new Map(deriveResourcePools(actor, abilityModsOf(v)).map((pool) => [pool.id, pool]));
  const catalogue = classFeaturesFor(actor);
  const features: DerivedFeature[] = catalogue
    .filter((spec) => !spec.subclassId)
    .map((spec) => classFeature(spec, actor, pools));
  const subclassId = actor.subclassId ?? actor.attributes.subclassId;
  if (subclassId) {
    const entry = resolver.get(subclassId) ?? resolver.get(`srd:subclass:${subclassId}`);
    features.push({ name: entry?.name ?? subclassId, source: "subclass", level: progression?.subclassLevel ?? 3, id: entry?.id ?? subclassId });
    features.push(...catalogue.filter((spec) => spec.subclassId).map((spec) => classFeature(spec, actor, pools)));
  }
  const traits = getSpeciesRules(actor.speciesId)?.traits ?? [];
  for (const name of traits) features.push({ name, source: "species", level: 1 });
  const background = getBackgroundRules(actor.backgroundId);
  if (background && actor.backgroundId) {
    const entry = resolver.get(actor.backgroundId);
    features.push({ name: entry?.name ?? actor.backgroundId, source: "background", level: 1, id: actor.backgroundId });
  }
  const owned = actor.features ?? [];
  const featLevels = [...(actor.featsTaken ?? [])];
  if (background && !featLevels.some((taken) => taken.featId === background.originFeat)) {
    featLevels.push({ featId: background.originFeat, level: 1 });
  }
  features.push(...ownedFeatures(owned.filter((name) => !traits.includes(name)), featLevels));
  return features;
}

function ownedFeatures(owned: readonly string[], featLevels: readonly { featId: string; level: number }[]): DerivedFeature[] {
  return [
    ...featFeatures(owned.filter(isFeatId), featLevels),
    ...owned.filter((name) => !isFeatId(name)).map((name): DerivedFeature => ({ name, source: "other", level: null })),
  ];
}

/** Features of a flat `Dnd5eActorSheet` from its `features` ids (no level is recorded on sheets). */
export function deriveSheetFeatures(featureIds: readonly string[] | undefined): DerivedFeature[] {
  return ownedFeatures(featureIds ?? [], []);
}
