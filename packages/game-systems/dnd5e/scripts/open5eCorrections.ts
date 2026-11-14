/**
 * ============================================================================
 * SRD 5.2.1 CORRECTIONS TO THE PINNED OPEN5E SNAPSHOT (open5eCorrections.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Open5e `v2.2.3` (`srd-2024`) loses some stat-block facts when it imports
 * the SRD 5.2.1. Without these corrections the generated monster pack would
 * ship a Rat as Small, a Skeleton without its Bludgeoning vulnerability, a
 * Ghost without its physical resistances and every legendary creature without
 * a legendary action count. Each value below was checked against
 * `SRD_CC_v5.2.1.pdf` (sha256 `8974902d...5e3d87`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Corrections Replace, Never Merge`:
 *      - An affinity list given here replaces the Open5e list entirely, so a
 *        correction can also remove a wrong entry.
 *   2. `Known Open5e Gaps`:
 *      - Tiny creatures and "Medium or Small" humanoids are all imported as
 *        Small; "Medium or Small" becomes `medium` (the default token size).
 *      - Bludgeoning, Piercing and Slashing affinities, all vulnerabilities
 *        and condition-only immunity lines are dropped by Open5e.
 *      - Legendary Action Uses are not imported at all.
 *   3. `Qualified Affinities Stay Out`:
 *      - The Rakshasa's Piercing vulnerability only applies to weapons
 *        wielded by a Blessed creature; it stays in prose, not in the list.
 *   4. `No AC Source`:
 *      - Open5e stamps "natural armor" on 330 of 331 creatures, including
 *        armored humanoids; SRD 5.2.1 prints no AC source, so none is kept.
 * ============================================================================
 */

import type { AbilityId, DamageType, SkillId } from "../src/types.ts";
import type { ConditionId, CreatureSize } from "../src/monsterStatBlock.ts";

/** Field-level overrides applied to one Open5e creature before mapping. */
export interface MonsterCorrection {
  size?: CreatureSize;
  abilities?: Partial<Record<AbilityId, number>>;
  /** Saving throw totals; a total equal to the ability modifier is dropped from the stat block. */
  savingThrows?: Partial<Record<AbilityId, number>>;
  skills?: Partial<Record<SkillId, number>>;
  xp?: number;
  damageResistances?: DamageType[];
  damageImmunities?: DamageType[];
  damageVulnerabilities?: DamageType[];
  conditionImmunities?: ConditionId[];
}

const TINY: readonly string[] = [
  "badger", "bat", "cat", "crab", "flying-snake", "frog", "hawk", "homunculus", "imp", "lizard",
  "owl", "piranha", "pseudodragon", "quasit", "rat", "raven", "scorpion", "seahorse",
  "sphinx-of-wonder", "spider", "sprite", "stirge", "venomous-snake", "weasel", "will-o-wisp",
];

const MEDIUM_OR_SMALL: readonly string[] = [
  "archmage", "assassin", "bandit", "bandit-captain", "berserker", "commoner", "cultist",
  "cultist-fanatic", "druid", "gladiator", "guard", "guard-captain", "knight", "mage", "mummy",
  "mummy-lord", "noble", "pirate", "pirate-captain", "priest", "priest-acolyte", "scout", "spy",
  "tough", "tough-boss", "vampire", "vampire-familiar", "vampire-spawn", "warrior-infantry",
  "warrior-veteran", "werebear", "wereboar", "wererat", "weretiger", "werewolf", "wraith",
];

const PHYSICAL: DamageType[] = ["bludgeoning", "piercing", "slashing"];
const SWARM_CONDITIONS: ConditionId[] = [
  "charmed", "frightened", "grappled", "paralyzed", "petrified", "prone", "restrained", "stunned",
];
const SENSELESS: ConditionId[] = ["blinded", "charmed", "deafened", "frightened"];
const TWO_HEADED: ConditionId[] = ["blinded", "charmed", "deafened", "frightened", "stunned", "unconscious"];

const FIELD_CORRECTIONS: Record<string, MonsterCorrection> = {
  "air-elemental": { damageResistances: ["bludgeoning", "lightning", "piercing", "slashing"] },
  "awakened-shrub": { damageResistances: ["piercing"], damageVulnerabilities: ["fire"] },
  "awakened-tree": { damageResistances: ["bludgeoning", "piercing"], damageVulnerabilities: ["fire"] },
  "black-pudding": { damageImmunities: ["acid", "cold", "lightning", "slashing"] },
  "chain-devil": { damageResistances: ["bludgeoning", "cold", "piercing", "slashing"] },
  "clay-golem": { damageResistances: PHYSICAL },
  cloaker: { conditionImmunities: ["frightened"] },
  cockatrice: { conditionImmunities: ["petrified"] },
  couatl: { damageResistances: PHYSICAL },
  "death-dog": { conditionImmunities: TWO_HEADED },
  deva: { conditionImmunities: ["charmed", "exhaustion", "frightened"] },
  doppelganger: { conditionImmunities: ["charmed"] },
  "dust-mephit": { damageVulnerabilities: ["fire"] },
  "earth-elemental": { damageVulnerabilities: ["thunder"] },
  ettin: { conditionImmunities: TWO_HEADED },
  "fire-elemental": { damageResistances: PHYSICAL },
  ghost: { damageResistances: ["acid", "bludgeoning", "cold", "fire", "lightning", "piercing", "slashing", "thunder"] },
  "gibbering-mouther": { conditionImmunities: ["prone"] },
  gorgon: { conditionImmunities: ["exhaustion", "petrified"] },
  "gray-ooze": { conditionImmunities: ["blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled", "prone", "restrained"] },
  "horned-devil": { damageResistances: ["cold"] },
  hydra: { conditionImmunities: TWO_HEADED },
  "ice-mephit": { damageVulnerabilities: ["fire"] },
  "invisible-stalker": { damageResistances: PHYSICAL },
  knight: { conditionImmunities: ["frightened"] },
  "magma-mephit": { damageVulnerabilities: ["cold"] },
  mastiff: { savingThrows: { wis: 3 } },
  "minotaur-skeleton": { damageVulnerabilities: ["bludgeoning"] },
  mummy: { damageVulnerabilities: ["fire"] },
  "mummy-lord": { damageVulnerabilities: ["fire"] },
  "night-hag": { conditionImmunities: ["charmed"] },
  "ochre-jelly": { damageImmunities: ["lightning", "slashing"] },
  octopus: { abilities: { con: 11, cha: 4 }, savingThrows: { con: 0 } },
  panther: { skills: { stealth: 7 } },
  planetar: { conditionImmunities: ["charmed", "exhaustion", "frightened"] },
  rakshasa: { conditionImmunities: ["charmed", "frightened"] },
  salamander: { damageVulnerabilities: ["cold"] },
  seahorse: { xp: 0 },
  shadow: { damageVulnerabilities: ["radiant"] },
  "shrieker-fungus": { xp: 0, conditionImmunities: SENSELESS },
  skeleton: { damageVulnerabilities: ["bludgeoning"] },
  specter: { damageResistances: ["acid", "bludgeoning", "cold", "fire", "lightning", "piercing", "slashing", "thunder"] },
  "swarm-of-bats": { damageResistances: PHYSICAL, conditionImmunities: SWARM_CONDITIONS },
  "swarm-of-crawling-claws": { damageResistances: PHYSICAL },
  "swarm-of-insects": { damageResistances: PHYSICAL, conditionImmunities: SWARM_CONDITIONS },
  "swarm-of-piranhas": { damageResistances: PHYSICAL, conditionImmunities: SWARM_CONDITIONS },
  "swarm-of-rats": { savingThrows: { dex: 2 }, damageResistances: PHYSICAL, conditionImmunities: SWARM_CONDITIONS },
  "swarm-of-ravens": { damageResistances: PHYSICAL, conditionImmunities: SWARM_CONDITIONS },
  "swarm-of-venomous-snakes": { damageResistances: PHYSICAL, conditionImmunities: SWARM_CONDITIONS },
  tarrasque: { damageResistances: PHYSICAL },
  treant: { damageResistances: ["bludgeoning", "piercing"], damageVulnerabilities: ["fire"] },
  "vampire-familiar": { conditionImmunities: ["charmed"] },
  "violet-fungus": { conditionImmunities: SENSELESS },
  "warhorse-skeleton": { damageVulnerabilities: ["bludgeoning"] },
  "will-o-wisp": { damageResistances: ["acid", "bludgeoning", "cold", "fire", "necrotic", "piercing", "slashing"] },
  wraith: { damageResistances: ["acid", "bludgeoning", "cold", "fire", "piercing", "slashing"] },
};

/** Legendary creatures whose Legendary Action Uses has no "(4 in Lair)" variant; every other one is "3 (4 in Lair)". */
const LEGENDARY_WITHOUT_LAIR: ReadonlySet<string> = new Set(["solar", "tarrasque", "unicorn"]);

/**
 * Returns the SRD 5.2.1 corrections for an Open5e creature key (`"rat"`,
 * without the `srd-2024_` prefix), or an empty object.
 */
export function monsterCorrection(key: string): MonsterCorrection {
  const size: CreatureSize | undefined = TINY.includes(key) ? "tiny" : MEDIUM_OR_SMALL.includes(key) ? "medium" : undefined;
  return { ...(size ? { size } : {}), ...FIELD_CORRECTIONS[key] };
}

/** SRD 5.2.1 Legendary Action Uses of a creature that has legendary actions. */
export function legendaryActionUses(key: string): { uses: number; lairUses?: number } {
  return LEGENDARY_WITHOUT_LAIR.has(key) ? { uses: 3 } : { uses: 3, lairUses: 4 };
}

/** Magic items whose SRD 5.2.1 rarity varies by variant while Open5e imports a single rarity. */
export const MAGIC_ITEM_RARITIES: Readonly<Record<string, readonly string[]>> = {
  "horn-of-valhalla": ["rare", "very_rare", "legendary"],
};

/**
 * SRD 5.2.1 magic items that Open5e files under `Item.json` (adventuring
 * gear), which has no rarity or attunement columns. Variant rarities are read
 * from the item text; `rarity` is only given when the text names none.
 * The Spell Scroll text Open5e carries is the Equipment chapter entry
 * (Cantrip and Level 1 scrolls), hence a single common rarity.
 */
export const GEAR_MAGIC_ITEMS: Readonly<
  Record<string, { category: "potion" | "scroll" | "wondrous_item"; requiresAttunement: boolean; rarity?: string }>
> = {
  "ioun-stone": { category: "wondrous_item", requiresAttunement: true },
  "potion-of-giant-strength": { category: "potion", requiresAttunement: false },
  "potions-of-healing": { category: "potion", requiresAttunement: false },
  "spell-scroll": { category: "scroll", requiresAttunement: false, rarity: "common" },
};

/**
 * Spell class-list overrides on top of the SRD 5.2.1 text. The SRD 5.2.1 spell
 * entry lists Mass Suggestion for Bard, Sorcerer and Wizard only; the TRAME
 * spec (GS9) puts it on the Warlock list as well, matching the 2024 rules.
 */
export const SPELL_CLASS_ADDITIONS: Readonly<Record<string, readonly string[]>> = {
  "mass-suggestion": ["warlock"],
};

/** SRD 5.2.1 spell texts that the Open5e import left empty. */
export const SPELL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "greater-invisibility": "A creature you touch has the Invisible condition until the spell ends.",
};

/** Repeated beams, darts or rays a spell creates, each resolved on its own. */
export interface SpellInstancesRule {
  /** What one instance is called on the table. */
  unit: "beam" | "dart" | "ray";
  /** Instances at the spell's own level (or at character level 1 for a cantrip). */
  count: number;
  /** Extra instances per slot level above the spell's level (Magic Missile `1`). */
  perSlotLevel?: number;
  /** Cantrip: `count` times the cantrip damage tier (x2 at level 5, x3 at 11, x4 at 17). */
  cantripScaling?: boolean;
}

/** Resolution facts the spell text states in prose that the parser cannot read reliably. */
export interface SpellRuleCorrection {
  /**
   * How damage resolves for a spell with neither an attack roll nor a saving throw:
   * `automatic` (it hits, Magic Missile) or `rider` (added to a weapon hit, Hex).
   * Unlisted spells of that kind are `described` (the damage comes from a later
   * trigger or is self-inflicted), so they never borrow the spell attack bonus.
   */
  damageResolution?: "automatic" | "rider";
  /**
   * How the `damage` parts combine at once: `all` (Flame Strike: Fire and Radiant)
   * or `choice` (Spirit Guardians: Radiant or Necrotic). Unlisted spells deal only
   * the first part at once; later parts are timed or conditional (Acid Arrow).
   */
  damageCombination?: "all" | "choice";
  /** Repeated instances (Eldritch Blast beams, Magic Missile darts, Scorching Ray rays). */
  instances?: SpellInstancesRule;
}

/**
 * Per-spell resolution corrections by compendium id, each checked against the
 * SRD 5.2.1 spell text. `srdContentGenerated.test.ts` fails when an id matches
 * no generated spell.
 */
export const SPELL_RULES: Readonly<Record<string, SpellRuleCorrection>> = {
  "srd:spell:magic_missile": { damageResolution: "automatic", instances: { unit: "dart", count: 3, perSlotLevel: 1 } },
  "srd:spell:eldritch_blast": { instances: { unit: "beam", count: 1, cantripScaling: true } },
  "srd:spell:scorching_ray": { instances: { unit: "ray", count: 3, perSlotLevel: 1 } },
  "srd:spell:hex": { damageResolution: "rider" },
  "srd:spell:hunters_mark": { damageResolution: "rider" },
  "srd:spell:divine_favor": { damageResolution: "rider" },
  "srd:spell:divine_smite": { damageResolution: "rider" },
  "srd:spell:shining_smite": { damageResolution: "rider" },
  "srd:spell:flame_strike": { damageCombination: "all" },
  "srd:spell:ice_storm": { damageCombination: "all" },
  "srd:spell:meteor_swarm": { damageCombination: "all" },
  "srd:spell:fire_shield": { damageCombination: "choice" },
  "srd:spell:prismatic_spray": { damageCombination: "choice" },
  "srd:spell:prismatic_wall": { damageCombination: "choice" },
  "srd:spell:spirit_guardians": { damageCombination: "choice" },
};
