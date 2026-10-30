import type {
  AbilityId,
  ActiveConditionState,
  DamageType,
  Dnd5eActorData,
  ProficiencyRank,
  SkillId,
  TurnTrigger,
} from "./types.ts";
import {
  computeDnd5eSheetDerived,
  DND5E_SKILLS,
  type ProficiencyRankString,
} from "./manifest.ts";
import { decrementConditionDurations } from "./progression.ts";

export { computeDnd5eSheetDerived, decrementConditionDurations };

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
  skillProficiencies: Partial<Record<SkillId, ProficiencyRankString | ProficiencyRank>>;
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
  spellSaveDC?: number;
  spellAttackBonus: number;
  spellAttackModifier?: number;
  encumbrance?: {
    carryingCapacity: number;
    heavilyEncumbered: number;
    encumbered: number;
  };
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonusForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(20, Math.trunc(level)));
  return Math.floor((clamped - 1) / 4) + 2;
}

export function proficiencyMultiplier(
  rank: ProficiencyRankString | ProficiencyRank | undefined
): number {
  if (rank === "expertise" || rank === 2) return 2;
  if (rank === "proficient" || rank === 1) return 1;
  if (rank === "half") return 0.5;
  return 0;
}

export interface DamageInstance {
  amount: number;
  type: DamageType;
}

export interface DamagePipelineOptions {
  isCritical?: boolean;
}

export interface ConcentrationPrompt {
  spellId: string;
  dc: number;
}

export interface DamageResolutionResult {
  actor: Dnd5eActorData;
  totalMitigatedDamage: number;
  damageAppliedToTempHp: number;
  damageAppliedToCurrentHp: number;
  instantDeath: boolean;
  deathSavesModified: boolean;
  concentrationPrompt?: ConcentrationPrompt;
  concentrationCheckPrompt?: ConcentrationPrompt;
}

export function resolveDamagePipeline(
  actor: Dnd5eActorData,
  damageInstances: DamageInstance[],
  options: DamagePipelineOptions = {}
): DamageResolutionResult {
  const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actor));

  let totalMitigatedDamage = 0;
  for (const instance of damageInstances) {
    const mitigation = clone.damageMitigations?.[instance.type] ?? "NONE";
    let instanceAmount = Math.max(0, instance.amount);
    if (mitigation === "IMMUNE") {
      instanceAmount = 0;
    } else if (mitigation === "RESISTANT") {
      instanceAmount = Math.floor(instanceAmount * 0.5);
    } else if (mitigation === "VULNERABLE") {
      instanceAmount = instanceAmount * 2;
    }
    totalMitigatedDamage += instanceAmount;
  }

  if (totalMitigatedDamage === 0) {
    return {
      actor: clone,
      totalMitigatedDamage: 0,
      damageAppliedToTempHp: 0,
      damageAppliedToCurrentHp: 0,
      instantDeath: false,
      deathSavesModified: false,
    };
  }

  let damageAppliedToTempHp = 0;
  let damageAppliedToCurrentHp = 0;
  let instantDeath = false;
  let deathSavesModified = false;

  if (clone.attributes.hp.current === 0) {
    if (totalMitigatedDamage >= clone.attributes.hp.max) {
      clone.isDead = true;
      clone.attributes.deathSaves.failures = 3;
      instantDeath = true;
      deathSavesModified = true;
    } else {
      const addedFailures = options.isCritical ? 2 : 1;
      clone.attributes.deathSaves.failures = Math.min(
        3,
        clone.attributes.deathSaves.failures + addedFailures
      );
      if (clone.attributes.deathSaves.failures >= 3) {
        clone.isDead = true;
      }
      deathSavesModified = true;
    }
  } else {
    let unabsorbedDamage = totalMitigatedDamage;
    if (clone.attributes.hp.temp > 0) {
      damageAppliedToTempHp = Math.min(clone.attributes.hp.temp, unabsorbedDamage);
      clone.attributes.hp.temp -= damageAppliedToTempHp;
      unabsorbedDamage -= damageAppliedToTempHp;
    }

    let excessDamage = 0;
    if (unabsorbedDamage > 0) {
      damageAppliedToCurrentHp = Math.min(clone.attributes.hp.current, unabsorbedDamage);
      clone.attributes.hp.current -= damageAppliedToCurrentHp;
      excessDamage = unabsorbedDamage - damageAppliedToCurrentHp;
    }

    if (clone.attributes.hp.current === 0) {
      if (excessDamage >= clone.attributes.hp.max) {
        clone.isDead = true;
        clone.attributes.deathSaves.failures = 3;
        instantDeath = true;
        deathSavesModified = true;
      } else {
        const hasUnconscious = clone.conditions.some((c) => c.id === "unconscious");
        if (!hasUnconscious) {
          clone.conditions.push({
            id: "unconscious",
            name: "Inconscient",
            durationRounds: 999,
            trigger: "ROUNDS",
          });
        }
      }
    }
  }

  let concentrationPrompt: ConcentrationPrompt | undefined;
  if (
    clone.concentratingOnSpellId &&
    !clone.isDead &&
    clone.attributes.hp.current > 0 &&
    totalMitigatedDamage > 0
  ) {
    const concentrationDC = Math.max(10, Math.floor(totalMitigatedDamage / 2));
    concentrationPrompt = {
      spellId: clone.concentratingOnSpellId,
      dc: concentrationDC,
    };
  }

  if (clone.attributes.hp.current === 0 && clone.concentratingOnSpellId) {
    clone.concentratingOnSpellId = undefined;
  }

  return {
    actor: clone,
    totalMitigatedDamage,
    damageAppliedToTempHp,
    damageAppliedToCurrentHp,
    instantDeath,
    deathSavesModified,
    concentrationPrompt,
    concentrationCheckPrompt: concentrationPrompt,
  };
}

export function rollDeathSavingThrow(
  actor: Dnd5eActorData,
  d20Roll: number
): { actor: Dnd5eActorData; outcome: "success" | "failure" | "revived" | "dead" | "stabilized" };
export function rollDeathSavingThrow(
  sheet: Dnd5eActorSheet,
  naturalD20: number
): DeathSaveState;
export function rollDeathSavingThrow(
  actorOrSheet: Dnd5eActorData | Dnd5eActorSheet,
  d20Roll: number
): 
  | { actor: Dnd5eActorData; outcome: "success" | "failure" | "revived" | "dead" | "stabilized" }
  | DeathSaveState {
  if ("attributes" in actorOrSheet) {
    const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actorOrSheet));
    let outcome: "success" | "failure" | "revived" | "dead" | "stabilized";

    if (d20Roll === 1) {
      clone.attributes.deathSaves.failures += 2;
      if (clone.attributes.deathSaves.failures >= 3) {
        clone.isDead = true;
        outcome = "dead";
      } else {
        outcome = "failure";
      }
    } else if (d20Roll === 20) {
      clone.attributes.hp.current = 1;
      clone.attributes.deathSaves.successes = 0;
      clone.attributes.deathSaves.failures = 0;
      clone.conditions = clone.conditions.filter((c) => c.id !== "unconscious");
      outcome = "revived";
    } else if (d20Roll >= 10) {
      clone.attributes.deathSaves.successes += 1;
      if (clone.attributes.deathSaves.successes >= 3) {
        clone.attributes.deathSaves.successes = 0;
        clone.attributes.deathSaves.failures = 0;
        outcome = "stabilized";
      } else {
        outcome = "success";
      }
    } else {
      clone.attributes.deathSaves.failures += 1;
      if (clone.attributes.deathSaves.failures >= 3) {
        clone.isDead = true;
        outcome = "dead";
      } else {
        outcome = "failure";
      }
    }
    return { actor: clone, outcome };
  } else {
    const sheet = actorOrSheet;
    if (d20Roll === 20) {
      sheet.hpCurrent = 1;
      sheet.deathSaves = { successes: 0, failures: 0, isStable: true, isDead: false };
      return sheet.deathSaves;
    }
    if (d20Roll === 1) {
      sheet.deathSaves.failures = Math.min(3, sheet.deathSaves.failures + 2);
    } else if (d20Roll >= 10) {
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
}

export interface ShortRestOptions {
  hitDiceSpent: number;
  diceRolls: number[];
}

export function applyShortRest(
  actor: Dnd5eActorData,
  options: ShortRestOptions
): Dnd5eActorData;
export function applyShortRest(
  sheet: Dnd5eActorSheet,
  hitDiceRolls: number[]
): { hpRecovered: number; hitDiceSpent: number };
export function applyShortRest(
  actorOrSheet: Dnd5eActorData | Dnd5eActorSheet,
  optionsOrRolls: ShortRestOptions | number[]
): Dnd5eActorData | { hpRecovered: number; hitDiceSpent: number } {
  if ("attributes" in actorOrSheet) {
    const actor = actorOrSheet;
    const options = Array.isArray(optionsOrRolls)
      ? { hitDiceSpent: optionsOrRolls.length, diceRolls: optionsOrRolls }
      : optionsOrRolls;

    if (
      options.hitDiceSpent < 0 ||
      options.hitDiceSpent > actor.attributes.hitDiceCurrent
    ) {
      throw new Error("Invalid hit dice count spent");
    }
    if (options.diceRolls.length !== options.hitDiceSpent) {
      throw new Error("Dice rolls count must match hit dice spent");
    }

    const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actor));
    const conMod = Math.floor((clone.abilities.con.score - 10) / 2);

    for (const r of options.diceRolls) {
      const recovered = Math.max(1, r + conMod);
      clone.attributes.hp.current = Math.min(
        clone.attributes.hp.max,
        clone.attributes.hp.current + recovered
      );
    }

    clone.attributes.hitDiceCurrent -= options.hitDiceSpent;

    if (clone.resources) {
      for (const res of Object.values(clone.resources)) {
        if (res.resetOn === "SHORT_REST") {
          res.current = res.max;
        }
      }
    }

    if (clone.spellSlots?.pact) {
      clone.spellSlots.pact.current = clone.spellSlots.pact.max;
    }

    return clone;
  } else {
    const sheet = actorOrSheet;
    const hitDiceRolls = Array.isArray(optionsOrRolls)
      ? optionsOrRolls
      : optionsOrRolls.diceRolls;
    const conMod = Math.floor((sheet.abilities.con - 10) / 2);
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
}

export function applyLongRest(actor: Dnd5eActorData): Dnd5eActorData;
export function applyLongRest(
  sheet: Dnd5eActorSheet
): { hpRecovered: number; hitDiceRecovered: number };
export function applyLongRest(
  actorOrSheet: Dnd5eActorData | Dnd5eActorSheet
): Dnd5eActorData | { hpRecovered: number; hitDiceRecovered: number } {
  if ("attributes" in actorOrSheet) {
    const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actorOrSheet));
    clone.attributes.hp.current = clone.attributes.hp.max;
    clone.attributes.hp.temp = 0;

    const recoveredDice = Math.max(1, Math.floor(clone.attributes.hitDiceMax / 2));
    clone.attributes.hitDiceCurrent = Math.min(
      clone.attributes.hitDiceMax,
      clone.attributes.hitDiceCurrent + recoveredDice
    );

    if (clone.attributes.exhaustion > 0) {
      clone.attributes.exhaustion -= 1;
    }

    clone.attributes.deathSaves.successes = 0;
    clone.attributes.deathSaves.failures = 0;

    if (clone.spellSlots) {
      for (const slot of Object.values(clone.spellSlots)) {
        if (slot) {
          slot.current = slot.max;
        }
      }
    }

    if (clone.resources) {
      for (const res of Object.values(clone.resources)) {
        res.current = res.max;
      }
    }

    return clone;
  } else {
    const sheet = actorOrSheet;
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

export function resolveActionPipeline(
  actor: Dnd5eActorSheet,
  action: ActionDefinition,
  targets: TargetResolutionInput[],
  castSlotLevel?: number
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

export function tryRechargeMonsterAbility(
  resource: ResourceTracker,
  d6Roll: number
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
