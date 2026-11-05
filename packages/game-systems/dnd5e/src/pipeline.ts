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
 *        and Concentration DC calculation (`min(30, max(10, floor(totalMitigatedDamage / 2)))`).
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
 *   5. `Critical Hits Double Dice Only` (SRD 5.2.1):
 *      - A natural `20` doubles the dice part of the damage (`baseDamage` and
 *        upcast dice); `damageModifier` is added once, never doubled.
 *   6. `Action Numbers Win`:
 *      - `ActionDefinition.attackBonus` / `saveDc` (a weapon's own bonus, a
 *        monster ability's DC) override the actor's generic spell attack
 *        bonus and spell save DC.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `resolveDamagePipeline(actor, damageInstances, options)`
 *     ├── 1. Deep-clone actor state and sum mitigated damage across instances.
 *     ├── 2. If already at `0` HP: apply massive-damage death or `+1`/`+2` death save failures.
 *     ├── 3. If `current > 0`: absorb into `temp`, deduct from `current`, check massive excess.
 *     ├── 4. Append `CONDITION_UNCONSCIOUS` when dropping to `0` HP while alive.
 *     └── 5. Emit `ConcentrationPrompt` (`DC = min(30, max(10, floor(damage / 2)))`) or drop concentration.
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
import { computeDnd5eSheetDerived, type ProficiencyRankString } from "./manifest.ts";
import { decrementConditionDurations } from "./progression.ts";

export { computeDnd5eSheetDerived, decrementConditionDurations };

/**
 * Stable compendium identifier of the Unconscious condition applied when an
 * actor drops to `0` HP. UIs localize it by id (`srd:condition:unconscious`).
 */
export const CONDITION_UNCONSCIOUS = "srd:condition:unconscious";

/** Condition ids accepted as Unconscious, including the pre-compendium `"unconscious"` id. */
const UNCONSCIOUS_IDS = new Set([CONDITION_UNCONSCIOUS, "unconscious"]);

/**
 * Armor Class calculation selector for `Dnd5eActorSheet`, mapped onto the
 * `system.json` AC candidates (the best applicable candidate wins):
 * - `"unarmored"`: `10 + DEX`
 * - `"light"`: `armorBaseAc + DEX`
 * - `"medium"`: `armorBaseAc + min(2, DEX)`
 * - `"heavy"`: `armorBaseAc`
 * - `"natural"`: `armorBaseAc` taken verbatim from a monster stat block
 * - `"unarmored_barbarian"`: best of `10 + DEX` and `10 + DEX + CON`
 * - `"unarmored_monk"`: best of `10 + DEX` and `10 + DEX + WIS` (no shield)
 */
export type ArmorCalculationKind =
  | "unarmored"
  | "light"
  | "medium"
  | "heavy"
  | "natural"
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
  /**
   * Exhaustion level (`0..=6`, SRD 5.2.1): `-2 * exhaustionLevel` on d20 tests and
   * `-5 ft * exhaustionLevel` of speed, never on passive scores or the spell save DC.
   * Level `6` is death (see `applyExhaustion`).
   */
  exhaustionLevel: number;
  /** Walking speed in feet before exhaustion (defaults to `30`). */
  speedFt?: number;
  /** Feat and feature identifiers held by the actor (e.g. `"srd:feat:alert"`). */
  features?: string[];
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
  /** Passive Perception (`10 + WIS + Perception proficiency`); exhaustion does not apply. */
  passivePerception: number;
  /** Passive Investigation (`10 + INT + Investigation proficiency`); exhaustion does not apply. */
  passiveInvestigation: number;
  /** Passive Insight (`10 + WIS + Insight proficiency`); exhaustion does not apply. */
  passiveInsight: number;
  /** Total effective Armor Class (`ac_base` + shield bonus). */
  armorClass: number;
  /** Initiative modifier: DEX (+ proficiency bonus with Alert) minus the exhaustion penalty. */
  initiativeBonus: number;
  /** Walking speed in feet after exhaustion (`max(0, speedFt - 5 * exhaustion)`). */
  speed: number;
  /** Spell Save Difficulty Class (`8 + proficiencyBonus + spellcastingMod`). */
  spellSaveDc: number;
  /** Legacy uppercase-DC alias of `spellSaveDc` for consumer compatibility. */
  spellSaveDC?: number;
  /** Spell Attack roll modifier (`proficiencyBonus + spellcastingMod`). */
  spellAttackBonus: number;
  /** Alias of `spellAttackBonus` for sheet consumers. */
  spellAttackModifier?: number;
  /**
   * Carrying capacity thresholds in pounds (`lb`) computed from Strength score.
   * `carryingCapacity` is the SRD 5.2.1 rule; the two encumbrance thresholds
   * are the SRD 5.1 Variant: Encumbrance rule.
   */
  encumbrance?: {
    /** Maximum carried weight in pounds (`STR * 15 lb`, Small or Medium creature). */
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

/** Exhaustion level at which a creature dies (SRD 5.2.1). */
export const EXHAUSTION_DEATH_LEVEL = 6;

/**
 * Returns a copy of `actor` with its exhaustion level changed by `delta` and
 * clamped to `0..=6`, for either actor representation. Reaching level `6`
 * kills the creature (`isDead` on `Dnd5eActorData`, `deathSaves.isDead` on
 * `Dnd5eActorSheet`); lowering exhaustion never revives it.
 */
export function applyExhaustion<T extends Dnd5eActorData | Dnd5eActorSheet>(actor: T, delta: number): T {
  const clone: Dnd5eActorData | Dnd5eActorSheet = structuredClone(actor);
  const clamp = (level: number) => Math.min(EXHAUSTION_DEATH_LEVEL, Math.max(0, level + delta));
  if ("attributes" in clone) {
    clone.attributes.exhaustion = clamp(clone.attributes.exhaustion ?? 0);
    if (clone.attributes.exhaustion === EXHAUSTION_DEATH_LEVEL) {
      clone.isDead = true;
    }
  } else {
    clone.exhaustionLevel = clamp(clone.exhaustionLevel ?? 0);
    if (clone.exhaustionLevel === EXHAUSTION_DEATH_LEVEL) {
      clone.deathSaves = { ...clone.deathSaves, isDead: true };
    }
  }
  return clone as T;
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
  /** Constitution saving throw Difficulty Class (`min(30, max(10, floor(totalMitigatedDamage / 2)))`). */
  dc: number;
}

/** Highest Concentration check DC (SRD 5.2.1: "up to a maximum DC of 30"). */
export const MAX_CONCENTRATION_DC = 30;

/**
 * Concentration check DC for `damage` points taken: half the damage rounded
 * down, at least `10` and at most `MAX_CONCENTRATION_DC` (`30`).
 */
export function concentrationCheckDc(damage: number): number {
  return Math.min(MAX_CONCENTRATION_DC, Math.max(10, Math.floor(damage / 2)));
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
 * 5. Computes the Concentration check DC (`concentrationCheckDc`, 10 to 30) or breaks concentration at `0` HP.
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
        const hasUnconscious = clone.conditions.some((c) => UNCONSCIOUS_IDS.has(c.id));
        if (!hasUnconscious) {
          clone.conditions.push({
            id: CONDITION_UNCONSCIOUS,
            name: "Unconscious",
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
    concentrationPrompt = {
      spellId: clone.concentratingOnSpellId,
      dc: concentrationCheckDc(totalMitigatedDamage),
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
      clone.conditions = clone.conditions.filter((c) => !UNCONSCIOUS_IDS.has(c.id));
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
  /** Whether a successful saving throw still deals `floor(totalDamage / 2)` damage. */
  halfDamageOnSave?: boolean;
  /**
   * Damage rolled on the action's dice (rolled total or average, `>= 0`), dealt
   * on a hit or failed save. A critical hit doubles it.
   */
  baseDamage: number;
  /**
   * Flat damage modifier (ability modifier, magic bonus; may be negative)
   * added once after the dice, never doubled on a critical hit. Defaults to `0`.
   */
  damageModifier?: number;
  /**
   * The action's own attack roll bonus (weapon attack, monster attack). When
   * set it replaces the actor's spell attack bonus for `"attack_roll"`.
   */
  attackBonus?: number;
  /**
   * The action's own save DC (monster ability, item). When set it replaces the
   * actor's spell save DC for `"saving_throw"`.
   */
  saveDc?: number;
  /** Optional spell-slot upcasting scaling rule (extra damage counts as dice). */
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
 * evaluating critical hits (`d20 === 20` doubles the dice, not `damageModifier`)
 * and Legendary Resistance, deducting Temporary/Current HP, and applying failure
 * conditions. The action's own `attackBonus` / `saveDc` take precedence over
 * the actor's spell attack bonus / spell save DC.
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
  const attackBonus = action.attackBonus ?? actorDerived.spellAttackBonus;
  const saveDc = action.saveDc ?? actorDerived.spellSaveDc;
  const damageModifier = action.damageModifier ?? 0;
  let diceDamage = action.baseDamage;
  if (
    action.upcastRule &&
    castSlotLevel !== undefined &&
    castSlotLevel > action.upcastRule.baseSlotLevel
  ) {
    const extraLevels = castSlotLevel - action.upcastRule.baseSlotLevel;
    diceDamage += extraLevels * action.upcastRule.extraDamagePerSlot;
  }
  const totalDamage = Math.max(0, diceDamage + damageModifier);

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
      const totalAttack = d20 + attackBonus;
      hitOrFailedSave = !isAutoMiss && (isCriticalHit || totalAttack >= targetDerived.armorClass);
    } else if (action.resolutionKind === "saving_throw") {
      const saveAb = action.saveAbility ?? "dex";
      const d20 = item.saveD20Roll ?? 10;
      const totalSave = d20 + targetDerived.savingThrows[saveAb];
      hitOrFailedSave = totalSave < saveDc;

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
      damageApplied = isCriticalHit ? Math.max(0, diceDamage * 2 + damageModifier) : totalDamage;
    } else if (action.resolutionKind === "saving_throw" && action.halfDamageOnSave) {
      damageApplied = Math.floor(totalDamage / 2);
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
