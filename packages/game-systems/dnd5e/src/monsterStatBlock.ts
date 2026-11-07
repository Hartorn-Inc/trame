/**
 * ============================================================================
 * MONSTER STAT BLOCK SCHEMA, BOUNDS & SHEET PROJECTION (monsterStatBlock.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Defines `MonsterStatBlock`, the complete SRD 5.2.1 monster record (speed by
 * mode, size, senses, traits, actions with multiattack, typed damage lists
 * with riders, reactions, legendary actions, damage and condition affinities,
 * CR, XP, proficiency bonus, AC and HP). Without it a compendium monster only
 * carried HP, AC and two attacks, so staged tokens spawned as 20 HP / AC 10
 * placeholders with no actions (audit UA2, GS8).
 *
 * `schemas/monster-stat-block.schema.json` is the language-neutral contract of
 * the same shape: the server validates copied stat blocks against it (D7) and
 * homebrew editors use it to reject out-of-range values.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Explicit Numeric Bounds`:
 *      - `MONSTER_STAT_BLOCK_BOUNDS` lists every numeric range (AC 1-30,
 *        HP 1-1000, speeds 0-200 ft, senses 0-500 ft, CR 0-30, save DC 1-30,
 *        ...). The JSON Schema repeats the same numbers and a test keeps
 *        both in sync, so the server cannot drift from the TypeScript pack.
 *   2. `Automation Is Declared, Not Guessed`:
 *      - Every `MonsterAction` states `automation`: `"full"` when its whole
 *        text is captured by the structured fields, `"partial"` when the
 *        roll is structured but extra prose remains, `"text"` when the
 *        action is description-only. Resolution code must ignore structured
 *        fields of `"text"` actions and show the description instead.
 *   3. `Typed Damage With Riders`:
 *      - `damage` lists the parts that always apply on a hit or failed save.
 *        Anything conditional (extra dice "if the attack roll had
 *        Advantage", a condition, a follow-up save) is a `MonsterActionRider`
 *        with its trigger, so damage is never double counted.
 *   4. `Sheet Projection Is Lossy Above CR 20`:
 *      - `monsterSheetFromStatBlock` maps the proficiency bonus to a
 *        character level (`2 -> 1` ... `6 -> 17`). The `derivedDAG` caps
 *        level at 20, so CR 21+ monsters (PB 7-9) project PB 6; the stat
 *        block keeps the authoritative save, skill and attack totals.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `monsterSheetFromStatBlock(id, statBlock)`
 *     ├── 1. Derive level from the proficiency bonus and hit dice from the HP formula.
 *     ├── 2. Derive save proficiencies and skill ranks from the printed totals.
 *     ├── 3. Build resource trackers (Legendary Resistance, legendary actions, recharge, per-day).
 *     └── 4. Flatten structured attacks and saves into the legacy `actions` list.
 * ============================================================================
 */

import type { Dnd5eActorSheet, ResourceTracker } from "./pipeline.ts";
import type { AbilityId, DamageType, SkillId } from "./types.ts";

/** SRD 5.2.1 creature size categories. */
export type CreatureSize = "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan";

/** SRD 5.2.1 creature types. */
export type CreatureType =
  | "aberration"
  | "beast"
  | "celestial"
  | "construct"
  | "dragon"
  | "elemental"
  | "fey"
  | "fiend"
  | "giant"
  | "humanoid"
  | "monstrosity"
  | "ooze"
  | "plant"
  | "undead";

/** The 15 SRD 5.2.1 conditions, as lowercase identifiers. */
export type ConditionId =
  | "blinded"
  | "charmed"
  | "deafened"
  | "exhaustion"
  | "frightened"
  | "grappled"
  | "incapacitated"
  | "invisible"
  | "paralyzed"
  | "petrified"
  | "poisoned"
  | "prone"
  | "restrained"
  | "stunned"
  | "unconscious";

/** Area of effect shapes used by spells and monster actions. */
export type AreaShape = "cone" | "cube" | "cylinder" | "emanation" | "line" | "sphere";

/** Area of effect of a spell or monster action. */
export interface AreaOfEffect {
  /** Template shape. */
  shape: AreaShape;
  /**
   * Main dimension in feet (`1..=500`): cone length, cube side, sphere,
   * cylinder or emanation radius, line length.
   */
  sizeFt: number;
  /** Line width in feet (`1..=500`); only for `"line"`. */
  widthFt?: number;
  /** Cylinder height in feet (`1..=500`); only for `"cylinder"`. */
  heightFt?: number;
}

/** One typed damage roll, e.g. `13 (1d10 + 8)` Slashing. */
export interface DamagePart {
  /** Dice expression as printed (`"1d10 + 8"`, `"17d6"`) or a flat number (`"1"`). */
  dice: string;
  /** Printed average damage (`0..=999`). */
  average: number;
  /** Damage type. */
  type: DamageType;
}

/** A saving throw demanded by an action or rider. */
export interface SavingThrowSpec {
  /** Ability used for the save. */
  ability: AbilityId;
  /** Difficulty Class (`1..=30`). */
  dc: number;
}

/**
 * Conditional effect attached to an action, applied on a hit (`"onHit"`) or
 * on a failed saving throw (`"onFailedSave"`). At least one of `damage`,
 * `condition` or `save` is set.
 */
export interface MonsterActionRider {
  /** When the rider applies. */
  trigger: "onHit" | "onFailedSave";
  /** Prose qualifier that must hold (e.g. `"if the attack roll had Advantage"`); absent when unconditional. */
  when?: string;
  /** Extra damage dealt by the rider. */
  damage?: DamagePart;
  /** Condition applied to the target. */
  condition?: ConditionId;
  /** Escape DC (`1..=30`) of a `"grappled"` condition. */
  escapeDc?: number;
  /** Follow-up saving throw the target makes. */
  save?: SavingThrowSpec;
}

/** Attack roll of a monster action. */
export interface MonsterAttack {
  /** Attack kind as printed in the stat block. */
  kind: "melee" | "ranged" | "melee_or_ranged";
  /** Attack roll bonus (`-5..=30`). */
  toHit: number;
  /** Melee reach in feet (`0..=100`). */
  reachFt?: number;
  /** Normal range in feet (`1..=1000`). */
  rangeFt?: number;
  /** Long range in feet (`1..=1000`), at Disadvantage. */
  longRangeFt?: number;
}

/** Saving throw resolution of a monster action. */
export interface MonsterSave extends SavingThrowSpec {
  /** Area of effect, when the action targets an area. */
  area?: AreaOfEffect;
  /** Effect of a successful save: `"half"` damage or `"none"`. */
  onSuccess: "half" | "none";
}

/**
 * One step of a Multiattack: `count` attacks chosen among `actionIds`
 * (one id, or several for "Bite or Claw" choices).
 */
export interface MultiattackStep {
  /** Ids of the actions of the same stat block that may be used (`1..=5`). */
  actionIds: string[];
  /** Number of attacks (`1..=10`). */
  count: number;
}

/**
 * Limited use of an action:
 * - `"recharge"`: available again when a d6 rolled at the start of the turn is `>= minRoll` (`2..=6`).
 * - `"per_day"`: `uses` (`1..=10`) uses per day.
 * - `"rest"`: recharges after a Short or Long Rest.
 */
export interface MonsterActionUsage {
  kind: "recharge" | "per_day" | "rest";
  /** Minimum d6 roll for `"recharge"`. */
  minRoll?: number;
  /** Uses per day for `"per_day"`. */
  uses?: number;
}

/**
 * How far a `MonsterAction` can be resolved automatically:
 * - `"full"`: every rule in the text is captured by the structured fields.
 * - `"partial"`: the attack or save roll is structured; extra prose must be read.
 * - `"text"`: description only; nothing is resolved automatically.
 */
export type MonsterActionAutomation = "full" | "partial" | "text";

/** Action, bonus action, reaction or legendary action of a stat block. */
export interface MonsterAction {
  /** Snake-case id, unique within the stat block (`^[a-z0-9_]{1,64}$`). */
  id: string;
  /** Display name without the usage suffix (`"Fire Breath"`). */
  name: string;
  /** Full English rules text (`<= 4000` chars). */
  description: string;
  /** Automation level of this action. */
  automation: MonsterActionAutomation;
  /** Attack roll, for attack actions. */
  attack?: MonsterAttack;
  /** Saving throw, for save actions. */
  save?: MonsterSave;
  /** Damage dealt on a hit or a failed save (`<= 6` parts). */
  damage?: DamagePart[];
  /** Conditional effects (`<= 10`). */
  riders?: MonsterActionRider[];
  /** Multiattack steps, for the Multiattack action (`<= 6`). */
  multiattack?: MultiattackStep[];
  /** Limited use (recharge, per day, per rest). */
  usage?: MonsterActionUsage;
  /** Legendary action cost (`1..=3`); only on legendary action options. */
  legendaryCost?: number;
}

/** Passive trait of a stat block (Amphibious, Pack Tactics, ...). */
export interface MonsterTrait {
  /** Snake-case id, unique within the stat block. */
  id: string;
  /** Display name. */
  name: string;
  /** Full English rules text (`<= 4000` chars). */
  description: string;
}

/** Complete SRD 5.2.1 monster stat block. */
export interface MonsterStatBlock {
  /** Display name (`<= 120` chars). */
  name: string;
  /** Size category. */
  size: CreatureSize;
  /** Creature type. */
  creatureType: CreatureType;
  /** Alignment as printed (`"chaotic evil"`, `"unaligned"`). */
  alignment: string;
  /** Armor Class. */
  armorClass: {
    /** AC value (`1..=30`). */
    value: number;
    /** Optional source note (`"plate armor, shield"`); SRD 5.2.1 stat blocks omit it. */
    source?: string;
  };
  /** Hit Points. */
  hitPoints: {
    /** Average HP (`1..=1000`). */
    average: number;
    /** Hit dice formula as printed (`"19d12 + 133"`). */
    formula: string;
  };
  /** Speeds in feet (`0..=200`). `walk` is always present (`0` for immobile creatures). */
  speed: {
    walk: number;
    fly?: number;
    swim?: number;
    climb?: number;
    burrow?: number;
    /** True when the creature can hover while flying. */
    hover?: boolean;
  };
  /** Ability scores (`1..=30`). */
  abilities: Record<AbilityId, number>;
  /** Saving throw totals (`-5..=20`) that differ from the plain ability modifier. */
  savingThrows: Partial<Record<AbilityId, number>>;
  /** Skill totals (`-5..=30`) for the skills printed in the stat block. */
  skills: Partial<Record<SkillId, number>>;
  /** Initiative bonus (`-10..=20`). */
  initiativeBonus: number;
  /** Senses in feet (`0..=500`) and Passive Perception (`1..=40`). */
  senses: {
    darkvision?: number;
    blindsight?: number;
    tremorsense?: number;
    truesight?: number;
    passivePerception: number;
  };
  /** Languages as printed, including telepathy (`<= 300` chars, `""` when none). */
  languages: string;
  /** Challenge Rating: `0`, `0.125`, `0.25`, `0.5` or an integer `1..=30`. */
  challengeRating: number;
  /** Experience points for the CR (`0..=155000`). */
  xp: number;
  /** Proficiency bonus (`2..=9`). */
  proficiencyBonus: number;
  /** Damage types dealing double damage. */
  damageVulnerabilities: DamageType[];
  /** Damage types dealing half damage. */
  damageResistances: DamageType[];
  /** Damage types dealing no damage. */
  damageImmunities: DamageType[];
  /** Conditions that cannot affect the creature. */
  conditionImmunities: ConditionId[];
  /** Legendary Resistance uses per day (`1..=10`), with the in-lair value when it differs. */
  legendaryResistance?: { uses: number; lairUses?: number };
  /** Passive traits (`<= 20`). */
  traits: MonsterTrait[];
  /** Actions (`<= 20`). */
  actions: MonsterAction[];
  /** Bonus actions (`<= 20`). */
  bonusActions: MonsterAction[];
  /** Reactions (`<= 20`). */
  reactions: MonsterAction[];
  /** Legendary actions: uses per round (`1..=5`, in lair `1..=6`) and options (`<= 10`). */
  legendaryActions?: { uses: number; lairUses?: number; options: MonsterAction[] };
  /** Provenance of the stat block. */
  source: "srd-5.2.1" | "srd-5.1" | "homebrew";
}

/**
 * Numeric bounds of `MonsterStatBlock`, mirrored verbatim by
 * `schemas/monster-stat-block.schema.json`.
 */
export const MONSTER_STAT_BLOCK_BOUNDS = {
  abilityScore: { min: 1, max: 30 },
  armorClass: { min: 1, max: 30 },
  hitPoints: { min: 1, max: 1000 },
  speedFt: { min: 0, max: 200 },
  senseRangeFt: { min: 0, max: 500 },
  passivePerception: { min: 1, max: 40 },
  challengeRating: { min: 0, max: 30 },
  xp: { min: 0, max: 155000 },
  proficiencyBonus: { min: 2, max: 9 },
  savingThrowBonus: { min: -5, max: 20 },
  skillBonus: { min: -5, max: 30 },
  initiativeBonus: { min: -10, max: 20 },
  toHit: { min: -5, max: 30 },
  saveDc: { min: 1, max: 30 },
  damageAverage: { min: 0, max: 999 },
  reachFt: { min: 0, max: 100 },
  rangeFt: { min: 1, max: 1000 },
  areaSizeFt: { min: 1, max: 500 },
  legendaryActionUses: { min: 1, max: 5 },
  legendaryActionLairUses: { min: 1, max: 6 },
  legendaryActionCost: { min: 1, max: 3 },
  legendaryResistanceUses: { min: 1, max: 10 },
  rechargeMinRoll: { min: 2, max: 6 },
  usesPerDay: { min: 1, max: 10 },
  multiattackCount: { min: 1, max: 10 },
} as const;

/** Valid Challenge Rating values. */
export const CHALLENGE_RATINGS: readonly number[] = [
  0, 0.125, 0.25, 0.5, ...Array.from({ length: 30 }, (_, i) => i + 1),
];

const XP_BY_CR: Record<string, number> = {
  "0": 10, "0.125": 25, "0.25": 50, "0.5": 100,
  "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800, "6": 2300, "7": 2900, "8": 3900,
  "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000, "14": 11500, "15": 13000,
  "16": 15000, "17": 18000, "18": 20000, "19": 22000, "20": 25000, "21": 33000, "22": 41000,
  "23": 50000, "24": 62000, "25": 75000, "26": 90000, "27": 105000, "28": 120000,
  "29": 135000, "30": 155000,
};

/**
 * SRD 5.2.1 experience points for a Challenge Rating. CR 0 is worth 10 XP
 * (0 XP only for creatures with no effective attacks, which the SRD marks
 * explicitly and the pack does not distinguish).
 */
export function xpForChallengeRating(cr: number): number {
  const xp = XP_BY_CR[String(cr)];
  if (xp === undefined) throw new Error(`Invalid challenge rating: ${cr}`);
  return xp;
}

/** SRD 5.2.1 proficiency bonus for a Challenge Rating: `+2` at CR 0-4 up to `+9` at CR 29-30. */
export function proficiencyBonusForChallengeRating(cr: number): number {
  return Math.max(2, Math.floor((Math.max(cr, 1) - 1) / 4) + 2);
}

/** Printed CR label: `"1/8"`, `"1/4"`, `"1/2"` or the integer. */
export function challengeRatingLabel(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

/** Flat actor sheet projected from a stat block, plus the monster-only fields the compendium keeps. */
export type MonsterSheetData = Omit<Dnd5eActorSheet, "spellcastingAbility"> & {
  spellcastingAbility?: AbilityId;
  challengeRating: string;
  cr: number;
  damageVulnerabilities: DamageType[];
  damageResistances: DamageType[];
  damageImmunities: DamageType[];
  conditionImmunities: ConditionId[];
  /** Legacy flat attack list (structured attack and save actions only). */
  actions: LegacyMonsterAction[];
  source: MonsterStatBlock["source"];
};

/** Flat attack entry kept for consumers of the pre-`MonsterStatBlock` monster shape. */
export interface LegacyMonsterAction {
  id: string;
  name: string;
  attackBonus?: number;
  damage: string;
  damageType: DamageType;
  range?: string;
  saveAbility?: AbilityId;
  dc?: number;
}

const ABILITIES: readonly AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

const ABILITY_BY_NAME: Record<string, AbilityId> = {
  strength: "str",
  dexterity: "dex",
  constitution: "con",
  intelligence: "int",
  wisdom: "wis",
  charisma: "cha",
};

/** Governing ability of each skill, used to recover proficiency ranks from printed totals. */
const SKILL_ABILITY: Record<SkillId, AbilityId> = {
  acrobatics: "dex",
  animal_handling: "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  sleight_of_hand: "dex",
  stealth: "dex",
  survival: "wis",
};

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Character level whose `prof_bonus` equals `pb`, capped at 17 (PB 6). */
function levelForProficiencyBonus(pb: number): number {
  return Math.min(17, (Math.max(pb, 2) - 2) * 4 + 1);
}

function usageLabel(usage: MonsterActionUsage | undefined): string {
  if (!usage) return "";
  if (usage.kind === "recharge") return usage.minRoll === 6 ? " (Recharge 6)" : ` (Recharge ${usage.minRoll}-6)`;
  if (usage.kind === "per_day") return ` (${usage.uses}/Day)`;
  return " (Recharge after a Short or Long Rest)";
}

function usageTracker(action: MonsterAction): ResourceTracker | undefined {
  const usage = action.usage;
  if (!usage) return undefined;
  const label = `${action.name}${usageLabel(usage)}`;
  if (usage.kind === "recharge") {
    return { id: action.id, label, current: 1, max: 1, recovery: "recharge", rechargeMinD6: usage.minRoll };
  }
  if (usage.kind === "per_day") {
    const uses = usage.uses ?? 1;
    return { id: action.id, label, current: uses, max: uses, recovery: "long_rest" };
  }
  return { id: action.id, label, current: 1, max: 1, recovery: "short_rest" };
}

function legacyAction(action: MonsterAction): LegacyMonsterAction | undefined {
  const first = action.damage?.[0];
  if (!first || action.automation === "text") return undefined;
  const name = `${action.name}${usageLabel(action.usage)}`;
  if (action.attack) {
    const { rangeFt, longRangeFt } = action.attack;
    const range = rangeFt ? (longRangeFt ? `${rangeFt}/${longRangeFt}` : String(rangeFt)) : undefined;
    return {
      id: action.id,
      name,
      attackBonus: action.attack.toHit,
      damage: first.dice,
      damageType: first.type,
      ...(range ? { range } : {}),
    };
  }
  if (action.save) {
    return { id: action.id, name, damage: first.dice, damageType: first.type, saveAbility: action.save.ability, dc: action.save.dc };
  }
  return undefined;
}

/**
 * Spellcasting ability named by a "Spellcasting" action ("using Charisma as
 * the spellcasting ability"), or `undefined` for non-casters.
 */
function spellcastingAbilityOf(statBlock: MonsterStatBlock): AbilityId | undefined {
  for (const action of [...statBlock.actions, ...statBlock.bonusActions]) {
    const match = /using (\w+) as the spellcasting ability/i.exec(action.description);
    if (match) return ABILITY_BY_NAME[match[1].toLowerCase()];
  }
  return undefined;
}

/**
 * Projects a stat block onto the flat `Dnd5eActorSheet` shape used by
 * `computeDnd5eSheetDerived`, the damage pipeline and rests:
 * - `level` reproduces the proficiency bonus (capped at PB 6, see banner).
 * - Hit dice come from the HP formula (`"19d12 + 133"` -> 19 d12).
 * - A save is proficient when its total exceeds the modifier by at least PB;
 *   a skill is `"expertise"` when its total exceeds the modifier by 2 PB.
 * - AC is `"natural"`: the stat-block value is used verbatim.
 */
export function monsterSheetFromStatBlock(id: string, statBlock: MonsterStatBlock): MonsterSheetData {
  const pb = statBlock.proficiencyBonus;
  const hitDice = /^(\d+)d(\d+)/.exec(statBlock.hitPoints.formula);
  const hitDiceMax = hitDice ? Number(hitDice[1]) : 1;
  const hitDieSides = hitDice ? Number(hitDice[2]) : 8;

  const saveProficiencies: Partial<Record<AbilityId, boolean>> = {};
  for (const ability of ABILITIES) {
    const total = statBlock.savingThrows[ability];
    if (total !== undefined && total - abilityMod(statBlock.abilities[ability]) >= pb) {
      saveProficiencies[ability] = true;
    }
  }

  const skillProficiencies: Partial<Record<SkillId, "proficient" | "expertise">> = {};
  for (const [skill, total] of Object.entries(statBlock.skills) as [SkillId, number][]) {
    const rank = Math.round((total - abilityMod(statBlock.abilities[SKILL_ABILITY[skill]])) / pb);
    if (rank >= 2) skillProficiencies[skill] = "expertise";
    else if (rank === 1) skillProficiencies[skill] = "proficient";
  }

  const resources: Record<string, ResourceTracker> = {};
  if (statBlock.legendaryResistance) {
    const uses = statBlock.legendaryResistance.uses;
    resources.legendary_resistance = {
      id: "legendary_resistance",
      label: `Legendary Resistance (${uses}/Day)`,
      current: uses,
      max: uses,
      recovery: "long_rest",
    };
  }
  if (statBlock.legendaryActions) {
    const uses = statBlock.legendaryActions.uses;
    resources.legendary_actions = {
      id: "legendary_actions",
      label: `Legendary Actions (${uses})`,
      current: uses,
      max: uses,
      recovery: "manual",
    };
  }
  for (const action of [...statBlock.actions, ...statBlock.bonusActions, ...statBlock.reactions]) {
    const tracker = usageTracker(action);
    if (tracker) resources[tracker.id] = tracker;
  }

  const spellcastingAbility = spellcastingAbilityOf(statBlock);
  return {
    id,
    name: statBlock.name,
    level: levelForProficiencyBonus(pb),
    ...(spellcastingAbility ? { spellcastingAbility } : {}),
    challengeRating: challengeRatingLabel(statBlock.challengeRating),
    cr: statBlock.challengeRating,
    abilities: { ...statBlock.abilities },
    saveProficiencies,
    skillProficiencies,
    armorKind: "natural",
    armorBaseAc: statBlock.armorClass.value,
    hasShield: false,
    hpCurrent: statBlock.hitPoints.average,
    hpMax: statBlock.hitPoints.average,
    tempHp: 0,
    hitDiceCurrent: hitDiceMax,
    hitDiceMax,
    hitDieSides,
    exhaustionLevel: 0,
    speedFt: statBlock.speed.walk,
    conditions: [],
    resources,
    deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
    damageVulnerabilities: [...statBlock.damageVulnerabilities],
    damageResistances: [...statBlock.damageResistances],
    damageImmunities: [...statBlock.damageImmunities],
    conditionImmunities: [...statBlock.conditionImmunities],
    actions: statBlock.actions.map(legacyAction).filter((a): a is LegacyMonsterAction => a !== undefined),
    source: statBlock.source,
  };
}
