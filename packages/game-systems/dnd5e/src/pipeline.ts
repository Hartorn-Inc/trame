/**
 * ============================================================================
 * D&D 5E COMBAT DAMAGE, DEATH SAVE, REST & ACTION PIPELINES (pipeline.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Implements the authoritative D&D 5e combat and recovery state machines:
 * multi-type damage mitigation and absorption (`resolveDamagePipeline`), death
 * saving throws (`rollDeathSavingThrow`), short/long rest recovery
 * (`applyShortRest`, `applyLongRest`), multi-target attack/save action
 * resolution (`resolveActionPipeline`), and monster ability `d6` recharge
 * (`tryRechargeMonsterAbility`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `5-Phase Damage Resolution Order`:
 *      - Per-type mitigation (`IMMUNE` -> `0`, `RESISTANT` -> `floor(x / 2)`,
 *        `VULNERABLE` -> `x * 2`) runs first, followed by Temporary HP absorption,
 *        Current HP deduction, Instant Death check (`excessDamage >= maxHp`),
 *        and Concentration DC calculation (`max(10, floor(totalMitigatedDamage / 2))`).
 *   2. `Zero-HP & Concentration Termination`:
 *      - Damage dealt to an actor already at `0` HP inflicts `1` death save
 *        failure (`2` on a critical hit) unless it equals or exceeds `max` HP
 *        (instant death). Dropping to `0` HP immediately clears
 *        `concentratingOnSpellId` without emitting a redundant Concentration prompt.
 *   3. `Hit Dice & Resource Guards`:
 *      - `applyShortRest` validates `0 <= hitDiceSpent <= hitDiceCurrent` and
 *        enforces a minimum healing floor of `1` HP per spent Hit Die even when
 *        the Constitution modifier is negative.
 *   4. `Legendary Resistance Override`:
 *      - In `resolveActionPipeline`, a target that fails a saving throw and has
 *        `useLegendaryResistanceIfFailed: true` with `legendary_resistance.current > 0`
 *        automatically converts the failed save into a success and decrements the
 *        resource pool before damage or conditions are applied.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `resolveDamagePipeline(actor, damageInstances, options)`
 *     ├── 1. Deep-clone actor state and sum mitigated damage across instances.
 *     ├── 2. If already at `0` HP: apply massive-damage death or `+1`/`+2` death save failures.
 *     ├── 3. If `current > 0`: absorb into `temp`, deduct from `current`, check massive excess.
 *     ├── 4. Append `"unconscious"` condition when dropping to `0` HP while alive.
 *     └── 5. Emit `ConcentrationPrompt` (`DC = max(10, floor(damage / 2))`) or drop concentration.
 * ============================================================================
 */

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

/**
 * Armor Class calculation formula selector for `Dnd5eActorSheet`:
 * - `"unarmored"`: `10 + DEX`
 * - `"light"`: `armorBaseAc + DEX`
 * - `"medium"`: `armorBaseAc + min(2, DEX)`
 * - `"heavy"`: `armorBaseAc`
 * - `"unarmored_barbarian"`: `10 + DEX + CON`
 * - `"unarmored_monk"`: `10 + DEX + WIS`
 */
export type ArmorCalculationKind =
  | "unarmored"
  | "light"
  | "medium"
  | "heavy"
  | "unarmored_barbarian"
  | "unarmored_monk";

/**
 * Tracked class or monster resource pool on a `Dnd5eActorSheet`.
 */
export interface ResourceTracker {
  /** Unique machine key of the resource (e.g., `"legendary_resistance"`, `"fire_breath"`). */
  id: string;
  /** Human-readable display label (e.g., `"Fire Breath (Recharge 5-6)"`). */
  label: string;
  /** Currently remaining charges (`0..=max`). */
  current: number;
  /** Maximum charges when fully restored (`>= 1`). */
  max: number;
  /** Recovery trigger determining when `current` resets to `max`. */
  recovery: "short_rest" | "long_rest" | "recharge" | "manual";
  /** Minimum `1d6` roll (`2..=6`) required at the start of turn when `recovery === "recharge"`. */
  rechargeMinD6?: number;
}

/**
 * Death saving throw state tracked on a flat `Dnd5eActorSheet`.
 */
export interface DeathSaveState {
  /** Number of successful death saves (`0..=3`). */
  successes: number;
  /** Number of failed death saves (`0..=3`). */
  failures: number;
  /** True once the actor reaches `3` successes or rolls a natural `20`. */
  isStable: boolean;
  /** True once the actor reaches `3` failures. */
  isDead: boolean;
}

/**
 * Flat combat sheet representation used by the action resolution and sheet-level pipelines.
 */
export interface Dnd5eActorSheet {
  /** Unique actor identifier. */
  id: string;
  /** Display name of the character or monster. */
  name: string;
  /** Character or challenge level (`1..=20`). */
  level: number;
  /** Governing ability score for spell Save DC and spell attack rolls. */
  spellcastingAbility: AbilityId;
  /** Raw ability scores (`1..=30`) keyed by `AbilityId`. */
  abilities: Record<AbilityId, number>;
  /** Saving throw proficiency flags keyed by `AbilityId`. */
  saveProficiencies: Partial<Record<AbilityId, boolean>>;
  /** Skill proficiency multipliers keyed by `SkillId`. */
  skillProficiencies: Partial<Record<SkillId, ProficiencyRankString | ProficiencyRank>>;
  /** Active Armor Class calculation mode. */
  armorKind: ArmorCalculationKind;
  /** Base AC from equipped armor or natural armor. */
  armorBaseAc: number;
  /** Whether the actor is wielding a shield (`+2` AC). */
  hasShield: boolean;
  /** Current Hit Points (`0..=hpMax`). */
  hpCurrent: number;
  /** Maximum Hit Points (`>= 1`). */
  hpMax: number;
  /** Temporary Hit Points (`>= 0`). */
  tempHp: number;
  /** Currently unspent Hit Dice (`0..=hitDiceMax`). */
  hitDiceCurrent: number;
  /** Maximum Hit Dice pool (`>= 1`). */
  hitDiceMax: number;
  /** Die size for Hit Dice recovery rolls (e.g., `6`, `8`, `10`, `12`). */
  hitDieSides: number;
  /** Exhaustion level (`0..=6`), applying a `-2 * exhaustionLevel` penalty to d20 checks/saves/DCs. */
  exhaustionLevel: number;
  /** List of active condition names or identifiers on the sheet. */
  conditions: string[];
  /** Keyed map of class/monster expendable resource trackers. */
  resources: Record<string, ResourceTracker>;
  /** Current death saving throw counters and stability flags. */
  deathSaves: DeathSaveState;
}

/**
 * Computed derived statistics projected from a `Dnd5eActorData` or `Dnd5eActorSheet`.
 */
export interface Dnd5eDerivedStats {
  /** Level-scaled proficiency bonus (`+2` at level 1 up to `+6` at level 20). */
  proficiencyBonus: number;
  /** Signed ability modifiers (`floor((score - 10) / 2)`) for each `AbilityId`. */
  abilityMods: Record<AbilityId, number>;
  /** Total saving throw modifiers for each `AbilityId`. */
  savingThrows: Record<AbilityId, number>;
  /** Total skill check modifiers for all 18 canonical `SkillId`s. */
  skills: Record<SkillId, number>;
  /** Passive Perception score (`10 + skills.perception`). */
  passivePerception: number;
  /** Passive Investigation score (`10 + skills.investigation`). */
  passiveInvestigation: number;
  /** Passive Insight score (`10 + skills.insight`). */
  passiveInsight: number;
  /** Total effective Armor Class including Dexterity caps, unarmored defenses, and shield bonus. */
  armorClass: number;
  /** Initiative roll modifier derived from Dexterity (minus exhaustion penalty on sheets). */
  initiativeBonus: number;
  /** Spell Save Difficulty Class (`8 + proficiencyBonus + spellcastingMod`). */
  spellSaveDc: number;
  /** Legacy uppercase-DC alias of `spellSaveDc` for consumer compatibility. */
  spellSaveDC?: number;
  /** Spell Attack roll modifier (`proficiencyBonus + spellcastingMod`). */
  spellAttackBonus: number;
  /** Alias of `spellAttackBonus` for sheet consumers. */
  spellAttackModifier?: number;
  /** Carrying capacity thresholds in pounds (`lb`) computed from Strength score. */
  encumbrance?: {
    /** Maximum weight in pounds (`STR * 15 lb`) before speed drops to `5 ft`. */
    carryingCapacity: number;
    /** Weight threshold in pounds (`STR * 10 lb`) for heavy encumbrance (`-20 ft` speed). */
    heavilyEncumbered: number;
    /** Weight threshold in pounds (`STR * 5 lb`) for standard encumbrance (`-10 ft` speed). */
    encumbered: number;
  };
}

/**
 * Computes the standard D&D 5e ability modifier `floor((score - 10) / 2)` for an ability score.
 */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Computes the proficiency bonus (`+2` to `+6`) for a character level clamped to `[1, 20]`.
 */
export function proficiencyBonusForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(20, Math.trunc(level)));
  return Math.floor((clamped - 1) / 4) + 2;
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

/**
 * Single typed damage component within an attack, spell, or environmental hazard.
 */
export interface DamageInstance {
  /** Raw pre-mitigation damage amount (`>= 0`, negative inputs are clamped to `0`). */
  amount: number;
  /** Elemental or physical damage category used for immunity/resistance/vulnerability lookup. */
  type: DamageType;
}

/**
 * Optional modifiers controlling the combat damage pipeline.
 */
export interface DamagePipelineOptions {
  /** When true, damage dealt to an actor already at `0` HP inflicts `2` death save failures instead of `1`. */
  isCritical?: boolean;
}

/**
 * Prompt emitted when a concentrating actor survives damage and must roll a Constitution saving throw.
 */
export interface ConcentrationPrompt {
  /** Identifier of the active concentration spell at risk of breaking. */
  spellId: string;
  /** Constitution saving throw Difficulty Class (`max(10, floor(totalMitigatedDamage / 2))`). */
  dc: number;
}

/**
 * Immutable outcome produced by `resolveDamagePipeline`.
 */
export interface DamageResolutionResult {
  /** Updated deep-cloned actor state after damage, conditions, and concentration updates. */
  actor: Dnd5eActorData;
  /** Sum of all damage instances after applying immunity, resistance, and vulnerability. */
  totalMitigatedDamage: number;
  /** Portion of `totalMitigatedDamage` absorbed by Temporary HP. */
  damageAppliedToTempHp: number;
  /** Portion of `totalMitigatedDamage` deducted from current Hit Points. */
  damageAppliedToCurrentHp: number;
  /** True if massive excess damage (`>= hp.max`) killed the actor outright. */
  instantDeath: boolean;
  /** True if death saving throw failure counters were incremented or maxed out. */
  deathSavesModified: boolean;
  /** Concentration saving throw requirement if the actor took damage while concentrating and remained above `0` HP. */
  concentrationPrompt?: ConcentrationPrompt;
  /** Alias of `concentrationPrompt` retained for consumer compatibility. */
  concentrationCheckPrompt?: ConcentrationPrompt;
}

/**
 * Executes the 5-phase D&D 5e damage resolution pipeline on an immutable clone of `actor`:
 * 1. Evaluates `IMMUNE` (`0x`), `RESISTANT` (`floor(0.5x)`), and `VULNERABLE` (`2x`) per `DamageInstance`.
 * 2. Absorbs mitigated damage into Temporary HP (`hp.temp`) first.
 * 3. Deducts remaining damage from Current HP (`hp.current`).
 * 4. Enforces Instant Death (`excessDamage >= hp.max`), unconsciousness at `0` HP, or death save failures when hit at `0` HP.
 * 5. Computes the Concentration check DC (`max(10, floor(totalMitigatedDamage / 2))`) or breaks concentration at `0` HP.
 */
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

/**
 * Resolves a single `1d20` Death Saving Throw according to D&D 5e rules:
 * - Natural `1`: Inflicts `2` death save failures (triggers `"dead"` at `>= 3`).
 * - Natural `20`: Restores `1` HP, clears death save tallies and `"unconscious"`, and revives the actor.
 * - `10..=19`: Adds `1` success (triggers `"stabilized"` at `3` successes).
 * - `2..=9`: Adds `1` failure (triggers `"dead"` at `3` failures).
 */
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



/**
 * Scaling rule for spells cast using a higher-level spell slot than `baseSlotLevel`.
 */
export interface ActionUpcastRule {
  /** Minimum spell slot level (`1..=9`) required to cast the spell at base potency. */
  baseSlotLevel: number;
  /** Additional base damage added per slot level above `baseSlotLevel`. */
  extraDamagePerSlot: number;
}

/**
 * Declarative specification for an attack, spell, or monster ability executed via `resolveActionPipeline`.
 */
export interface ActionDefinition {
  /** Unique machine identifier for the action (e.g., `"fireball"`). */
  id: string;
  /** Display name of the spell or ability. */
  name: string;
  /** Optional key in `actor.resources` that must have `current >= 1` and is decremented on use. */
  resourceCostId?: string;
  /** Resolution mechanic determining how hits/saves are evaluated against each target. */
  resolutionKind: "attack_roll" | "saving_throw" | "auto_hit";
  /** Target ability score used when `resolutionKind === "saving_throw"` (defaults to `"dex"`). */
  saveAbility?: AbilityId;
  /** Whether a successful saving throw still deals `floor(totalBaseDamage / 2)` damage. */
  halfDamageOnSave?: boolean;
  /** Unscaled base damage dealt on a hit or failed saving throw (`>= 0`). */
  baseDamage: number;
  /** Optional spell-slot upcasting scaling rule. */
  upcastRule?: ActionUpcastRule;
  /** Optional condition name appended to `target.conditions` when the target is hit or fails its save. */
  applyConditionOnFail?: string;
}

/**
 * Per-target roll inputs and tactical choices passed to `resolveActionPipeline`.
 */
export interface TargetResolutionInput {
  /** Target actor sheet receiving the attack or saving throw effect. */
  target: Dnd5eActorSheet;
  /** Natural `1d20` attack roll (`1..=20`) when `resolutionKind === "attack_roll"`. */
  attackD20Roll?: number;
  /** Natural `1d20` saving throw roll (`1..=20`) when `resolutionKind === "saving_throw"`. */
  saveD20Roll?: number;
  /** When true, spends `1` charge of `legendary_resistance` if available to turn a failed save into a success. */
  useLegendaryResistanceIfFailed?: boolean;
}

/**
 * Per-target resolution outcome returned by `resolveActionPipeline`.
 */
export interface TargetResolutionOutcome {
  /** Identifier of the affected target (`target.id`). */
  targetId: string;
  /** True if the attack hit or the target failed its saving throw (after Legendary Resistance). */
  hitOrFailedSave: boolean;
  /** True if the target expended a Legendary Resistance charge to override a failed save. */
  usedLegendaryResistance: boolean;
  /** Total damage dealt to the target (including Temporary HP absorption). */
  damageApplied: number;
  /** Target's remaining `hpCurrent` after absorbing damage into `tempHp` and `hpCurrent`. */
  remainingHp: number;
  /** Condition applied to the target on hit/failed save, if any. */
  appliedCondition?: string;
}

/**
 * Resolves an `ActionDefinition` (attack roll, saving throw, or auto-hit) from `actor`
 * against one or more `targets`, deducting `resourceCostId`, scaling upcast damage,
 * evaluating critical hits (`d20 === 20` doubles damage) and Legendary Resistance,
 * deducting Temporary/Current HP, and applying failure conditions.
 */
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

/**
 * Evaluates a monster `1d6` recharge roll (e.g., Recharge 5–6) against `resource.rechargeMinD6`.
 * Restores `resource.current` to `resource.max` and returns `true` when recharged.
 */
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
