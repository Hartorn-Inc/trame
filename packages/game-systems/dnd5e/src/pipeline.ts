import {
  type AbilityId,
  DND5E_SKILLS,
  type ProficiencyRank,
  type SkillId,
} from "./manifest.ts";

export type ArmorCalculationKind =
  | "unarmored"
  | "light"
  | "medium"
  | "heavy"
  | "unarmored_barbarian"
  | "unarmored_monk";

export interface ResourceTracker {
  id: string;
  label: string;
  current: number;
  max: number;
  recovery: "short_rest" | "long_rest" | "recharge" | "manual";
  rechargeMinD6?: number;
}

export interface DeathSaveState {
  successes: number;
  failures: number;
  isStable: boolean;
  isDead: boolean;
}

export interface Dnd5eActorSheet {
  id: string;
  name: string;
  level: number;
  spellcastingAbility: AbilityId;
  abilities: Record<AbilityId, number>;
  saveProficiencies: Partial<Record<AbilityId, boolean>>;
  skillProficiencies: Partial<Record<SkillId, ProficiencyRank>>;
  armorKind: ArmorCalculationKind;
  armorBaseAc: number;
  hasShield: boolean;
  hpCurrent: number;
  hpMax: number;
  tempHp: number;
  hitDiceCurrent: number;
  hitDiceMax: number;
  hitDieSides: number;
  exhaustionLevel: number;
  conditions: string[];
  resources: Record<string, ResourceTracker>;
  deathSaves: DeathSaveState;
}

export interface Dnd5eDerivedStats {
  proficiencyBonus: number;
  abilityMods: Record<AbilityId, number>;
  savingThrows: Record<AbilityId, number>;
  skills: Record<SkillId, number>;
  passivePerception: number;
  passiveInvestigation: number;
  passiveInsight: number;
  armorClass: number;
  initiativeBonus: number;
  spellSaveDc: number;
  spellAttackBonus: number;
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonusForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(20, Math.trunc(level)));
  return Math.floor((clamped - 1) / 4) + 2;
}

export function proficiencyMultiplier(rank: ProficiencyRank | undefined): number {
  switch (rank) {
    case "expertise":
      return 2;
    case "proficient":
      return 1;
    case "half":
      return 0.5;
    default:
      return 0;
  }
}

export function computeDnd5eSheetDerived(sheet: Dnd5eActorSheet): Dnd5eDerivedStats {
  const pb = proficiencyBonusForLevel(sheet.level);
  const abilityMods: Record<AbilityId, number> = {
    str: abilityModifier(sheet.abilities.str),
    dex: abilityModifier(sheet.abilities.dex),
    con: abilityModifier(sheet.abilities.con),
    int: abilityModifier(sheet.abilities.int),
    wis: abilityModifier(sheet.abilities.wis),
    cha: abilityModifier(sheet.abilities.cha),
  };

  // D&D 5e 2024 Exhaustion penalty: -2 per exhaustion level to all d20 tests & spell save DC
  const exhaustionPenalty = sheet.exhaustionLevel * 2;

  const savingThrows = {} as Record<AbilityId, number>;
  for (const ab of ["str", "dex", "con", "int", "wis", "cha"] as AbilityId[]) {
    const prof = sheet.saveProficiencies[ab] ? pb : 0;
    savingThrows[ab] = abilityMods[ab] + prof - exhaustionPenalty;
  }

  const skills = {} as Record<SkillId, number>;
  for (const skill of DND5E_SKILLS) {
    const mult = proficiencyMultiplier(sheet.skillProficiencies[skill.id]);
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

  const castMod = abilityMods[sheet.spellcastingAbility];

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
    spellSaveDc: 8 + pb + castMod - exhaustionPenalty,
    spellAttackBonus: pb + castMod - exhaustionPenalty,
  };
}

export interface ActionUpcastRule {
  baseSlotLevel: number;
  extraDamagePerSlot: number;
}

export interface ActionDefinition {
  id: string;
  name: string;
  resourceCostId?: string;
  resolutionKind: "attack_roll" | "saving_throw" | "auto_hit";
  saveAbility?: AbilityId;
  halfDamageOnSave?: boolean;
  baseDamage: number;
  upcastRule?: ActionUpcastRule;
  applyConditionOnFail?: string;
}

export interface TargetResolutionInput {
  target: Dnd5eActorSheet;
  attackD20Roll?: number;
  saveD20Roll?: number;
  useLegendaryResistanceIfFailed?: boolean;
}

export interface TargetResolutionOutcome {
  targetId: string;
  hitOrFailedSave: boolean;
  usedLegendaryResistance: boolean;
  damageApplied: number;
  remainingHp: number;
  appliedCondition?: string;
}

/**
 * Executes the multi-step D&D 5e Action Resolution Pipeline:
 * `SpendResource -> AttackRoll / SavingThrow (with Legendary Resistance) -> DamageRoll (with Upcasting) -> ApplyCondition`
 */
export function resolveActionPipeline(
  actor: Dnd5eActorSheet,
  action: ActionDefinition,
  targets: TargetResolutionInput[],
  castSlotLevel?: number,
): TargetResolutionOutcome[] {
  if (action.resourceCostId) {
    const res = actor.resources[action.resourceCostId];
    if (!res || res.current <= 0) {
      throw new Error(`Insufficient resource: ${action.resourceCostId}`);
    }
    res.current -= 1;
  }

  const actorDerived = computeDnd5eSheetDerived(actor);
  let totalBaseDamage = action.baseDamage;
  if (
    action.upcastRule &&
    castSlotLevel !== undefined &&
    castSlotLevel > action.upcastRule.baseSlotLevel
  ) {
    const extraLevels = castSlotLevel - action.upcastRule.baseSlotLevel;
    totalBaseDamage += extraLevels * action.upcastRule.extraDamagePerSlot;
  }

  const outcomes: TargetResolutionOutcome[] = [];
  for (const item of targets) {
    const targetDerived = computeDnd5eSheetDerived(item.target);
    let hitOrFailedSave = true;
    let usedLegendaryResistance = false;
    let isCriticalHit = false;

    if (action.resolutionKind === "attack_roll") {
      const d20 = item.attackD20Roll ?? 10;
      isCriticalHit = d20 === 20;
      const isAutoMiss = d20 === 1;
      const totalAttack = d20 + actorDerived.spellAttackBonus;
      hitOrFailedSave = !isAutoMiss && (isCriticalHit || totalAttack >= targetDerived.armorClass);
    } else if (action.resolutionKind === "saving_throw") {
      const saveAb = action.saveAbility ?? "dex";
      const d20 = item.saveD20Roll ?? 10;
      const totalSave = d20 + targetDerived.savingThrows[saveAb];
      hitOrFailedSave = totalSave < actorDerived.spellSaveDc;

      if (hitOrFailedSave && item.useLegendaryResistanceIfFailed) {
        const legRes = item.target.resources.legendary_resistance;
        if (legRes && legRes.current > 0) {
          legRes.current -= 1;
          hitOrFailedSave = false;
          usedLegendaryResistance = true;
        }
      }
    }

    let damageApplied = 0;
    if (hitOrFailedSave) {
      damageApplied = isCriticalHit ? totalBaseDamage * 2 : totalBaseDamage;
    } else if (action.resolutionKind === "saving_throw" && action.halfDamageOnSave) {
      damageApplied = Math.floor(totalBaseDamage / 2);
    }

    // Apply Temp HP absorption then HP reduction
    const absorbed = Math.min(item.target.tempHp, damageApplied);
    item.target.tempHp -= absorbed;
    const remainder = damageApplied - absorbed;
    item.target.hpCurrent = Math.max(0, item.target.hpCurrent - remainder);

    let appliedCondition: string | undefined;
    if (hitOrFailedSave && action.applyConditionOnFail) {
      if (!item.target.conditions.includes(action.applyConditionOnFail)) {
        item.target.conditions.push(action.applyConditionOnFail);
      }
      appliedCondition = action.applyConditionOnFail;
    }

    outcomes.push({
      targetId: item.target.id,
      hitOrFailedSave,
      usedLegendaryResistance,
      damageApplied,
      remainingHp: item.target.hpCurrent,
      appliedCondition,
    });
  }

  return outcomes;
}

/**
 * Short Rest: spends Hit Dice (adding CON modifier per die, minimum 1 HP gained per die)
 * and restores all `short_rest` resources.
 */
export function applyShortRest(
  sheet: Dnd5eActorSheet,
  hitDiceRolls: number[],
): { hpRecovered: number; hitDiceSpent: number } {
  const conMod = abilityModifier(sheet.abilities.con);
  let hpRecovered = 0;
  let hitDiceSpent = 0;

  for (const roll of hitDiceRolls) {
    if (sheet.hitDiceCurrent <= 0 || sheet.hpCurrent >= sheet.hpMax) {
      break;
    }
    sheet.hitDiceCurrent -= 1;
    hitDiceSpent += 1;
    const heal = Math.max(1, roll + conMod);
    const before = sheet.hpCurrent;
    sheet.hpCurrent = Math.min(sheet.hpMax, sheet.hpCurrent + heal);
    hpRecovered += sheet.hpCurrent - before;
  }

  for (const res of Object.values(sheet.resources)) {
    if (res.recovery === "short_rest") {
      res.current = res.max;
    }
  }

  return { hpRecovered, hitDiceSpent };
}

/**
 * Long Rest: restores full HP, regains `max(1, floor(hitDiceMax / 2))` Hit Dice,
 * resets all `short_rest` and `long_rest` resources, and reduces exhaustion by 1.
 */
export function applyLongRest(sheet: Dnd5eActorSheet): {
  hpRecovered: number;
  hitDiceRecovered: number;
} {
  const hpRecovered = sheet.hpMax - sheet.hpCurrent;
  sheet.hpCurrent = sheet.hpMax;
  sheet.tempHp = 0;

  const regainHd = Math.max(1, Math.floor(sheet.hitDiceMax / 2));
  const beforeHd = sheet.hitDiceCurrent;
  sheet.hitDiceCurrent = Math.min(sheet.hitDiceMax, sheet.hitDiceCurrent + regainHd);
  const hitDiceRecovered = sheet.hitDiceCurrent - beforeHd;

  if (sheet.exhaustionLevel > 0) {
    sheet.exhaustionLevel -= 1;
  }

  for (const res of Object.values(sheet.resources)) {
    if (res.recovery === "short_rest" || res.recovery === "long_rest") {
      res.current = res.max;
    }
  }

  sheet.deathSaves = { successes: 0, failures: 0, isStable: false, isDead: false };
  return { hpRecovered, hitDiceRecovered };
}

/**
 * Evaluates a Death Saving Throw according to D&D 5e SRD 5.2 rules.
 */
export function rollDeathSavingThrow(
  sheet: Dnd5eActorSheet,
  naturalD20: number,
): DeathSaveState {
  if (naturalD20 === 20) {
    sheet.hpCurrent = 1;
    sheet.deathSaves = { successes: 0, failures: 0, isStable: true, isDead: false };
    return sheet.deathSaves;
  }

  if (naturalD20 === 1) {
    sheet.deathSaves.failures = Math.min(3, sheet.deathSaves.failures + 2);
  } else if (naturalD20 >= 10) {
    sheet.deathSaves.successes = Math.min(3, sheet.deathSaves.successes + 1);
  } else {
    sheet.deathSaves.failures = Math.min(3, sheet.deathSaves.failures + 1);
  }

  if (sheet.deathSaves.failures >= 3) {
    sheet.deathSaves.isDead = true;
  } else if (sheet.deathSaves.successes >= 3) {
    sheet.deathSaves.isStable = true;
  }

  return sheet.deathSaves;
}

/**
 * Evaluates a Monster Recharge roll (e.g. Dragon Fire Breath `Recharge 5-6`) at the start of turn.
 */
export function tryRechargeMonsterAbility(
  resource: ResourceTracker,
  d6Roll: number,
): boolean {
  if (
    resource.recovery === "recharge" &&
    resource.rechargeMinD6 !== undefined &&
    d6Roll >= resource.rechargeMinD6
  ) {
    resource.current = resource.max;
    return true;
  }
  return false;
}
