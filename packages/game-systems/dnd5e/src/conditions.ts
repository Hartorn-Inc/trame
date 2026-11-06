/**
 * ============================================================================
 * CONDITION ROLL EFFECTS & CONDITION OVERRIDE RULINGS (conditions.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Maps the SRD 5.2.1 conditions to the rules they impose on rolls and
 * movement (advantage / disadvantage, auto-failed saves, automatic critical
 * hits, Speed 0, Incapacitated) and resolves them for an attack, a saving
 * throw, an ability check or initiative. Without it a Paralyzed target is
 * hit like any other and a Restrained creature still walks (GS14, D13).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Effect Ids Are "<condition>.<rule>"`:
 *      - Every automated rule of a condition has a stable id
 *        (`"grappled.speed_zero"`, `"paralyzed.auto_crit_within_5ft"`). The
 *        engine `ConditionOverride` stores `EFFECT` rulings with these ids.
 *   2. `ConditionOverride Always Wins`:
 *      - `CONDITION` rulings add (`FORCE`) or drop (`REMOVE`) a condition
 *        before its rules are looked up; `EFFECT` rulings then force a rule
 *        on (even without its condition) or remove one source of it.
 *      - Removing the `exhaustion` condition zeroes the exhaustion level used
 *        by the sheet (`computeDnd5eSheetDerived` options).
 *   3. `SRD Cancellation`:
 *      - Any advantage source plus any disadvantage source is a straight
 *        roll, whatever their counts (`combineRollMode`).
 *   4. `Engine Parity`:
 *      - `effectiveConditions`, `incapacitated` and `speedZero` are also
 *        computed by `trame-engine` (`condition_effects`, WASM export
 *        `conditionEffects`) to enforce `MoveToken` and reaction prompts;
 *        `packages/web/tests/engine/wasmParity.test.ts` runs both on the
 *        shared fixtures.
 *   5. `Numbers Stay In The DAG`:
 *      - Exhaustion's `-2 * level` on d20 tests and `-5 ft * level` of speed
 *        are `system.json` formulas; this module only reports the level in
 *        force after rulings.
 *   6. `Feature Roll Rules Are Sources Like Conditions`:
 *      - `DerivedFeatureRules.rolls` (Reckless Attack, Danger Sense, Innate
 *        Sorcery, Rage) enter the same cancellation as condition rules, named
 *        by their `ClassFeature` id, so a Poisoned barbarian using Reckless
 *        Attack rolls straight.
 *      - Feature advantage on saving throws is dropped while the creature is
 *        Incapacitated (Danger Sense's own exception; Rage ends anyway).
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `resolveAttackRollMode({ attacker, target, distanceFt, attackerFeatures })`
 *     ├── 1. `resolveConditionEffects` for attacker and target (rulings applied).
 *     ├── 2. Collect attacker-side rules (own attack rolls) and target-side
 *     │      rules (attack rolls against it; Prone depends on distance).
 *     ├── 3. Add feature roll rules of both sides (`featureAdvantageSources`).
 *     ├── 4. Add caller-provided sources (Help, long range...).
 *     └── 5. `combineRollMode` + automatic critical within 5 ft.
 * ============================================================================
 */

import type { DerivedFeatureRollRule } from "./classFeatures.ts";
import type { AbilityId } from "./types.ts";

/** What a `ConditionOverride` ruling targets (engine `OverrideSubject`). */
export type ConditionOverrideSubject = "CONDITION" | "EFFECT";

/** Ruling applied by a `ConditionOverride` (engine `OverrideMode`). */
export type ConditionOverrideMode = "FORCE" | "REMOVE";

/** One Game Master ruling as stored on an engine token (`condition_overrides`). */
export interface ConditionOverrideRuling {
  /** `CONDITION` for a condition id, `EFFECT` for a `"<condition>.<rule>"` effect id. */
  subject: ConditionOverrideSubject;
  /** Lowercase condition id (`"prone"`) or effect id (`"grappled.speed_zero"`). */
  id: string;
  /** `FORCE` applies it regardless of state; `REMOVE` suppresses it. */
  mode: ConditionOverrideMode;
}

/**
 * Automated rules a condition can impose:
 * - `incapacitated`: no action, bonus action or reaction.
 * - `speed_zero`: Speed is 0 (engine rejects `MoveToken`).
 * - `attack_disadvantage`: the creature's own attack rolls have disadvantage.
 * - `attack_disadvantage_vs_others`: disadvantage on attacks against anyone but the grappler.
 * - `attack_advantage`: the creature's own attack rolls have advantage.
 * - `attacked_with_advantage`: attack rolls against the creature have advantage.
 * - `attacked_with_disadvantage`: attack rolls against the creature have disadvantage.
 * - `attacked_prone`: advantage within 5 ft, disadvantage beyond.
 * - `auto_crit_within_5ft`: a hit from an attacker within 5 ft is a critical hit.
 * - `auto_fail_str_dex_saves`: Strength and Dexterity saving throws fail.
 * - `dex_save_disadvantage`: Dexterity saving throws have disadvantage.
 * - `check_disadvantage`: ability checks have disadvantage.
 * - `initiative_advantage` / `initiative_disadvantage`: on the Initiative roll.
 * - `resistance_all_damage`: resistance to all damage.
 */
export type ConditionRule =
  | "incapacitated"
  | "speed_zero"
  | "attack_disadvantage"
  | "attack_disadvantage_vs_others"
  | "attack_advantage"
  | "attacked_with_advantage"
  | "attacked_with_disadvantage"
  | "attacked_prone"
  | "auto_crit_within_5ft"
  | "auto_fail_str_dex_saves"
  | "dex_save_disadvantage"
  | "check_disadvantage"
  | "initiative_advantage"
  | "initiative_disadvantage"
  | "resistance_all_damage";

const INCAPACITATED: readonly ConditionRule[] = ["incapacitated", "initiative_disadvantage"];

/**
 * SRD 5.2.1 condition rules, flattened (Unconscious lists its Incapacitated
 * and Prone rules itself). Charmed, Deafened and Frightened's movement limit
 * depend on who is the source; they stay described. Exhaustion is applied by
 * the DAG (see banner invariant 5).
 */
export const CONDITION_RULES: Readonly<Record<string, readonly ConditionRule[]>> = {
  blinded: ["attack_disadvantage", "attacked_with_advantage"],
  charmed: [],
  deafened: [],
  exhaustion: [],
  frightened: ["attack_disadvantage", "check_disadvantage"],
  grappled: ["speed_zero", "attack_disadvantage_vs_others"],
  incapacitated: INCAPACITATED,
  invisible: ["attack_advantage", "attacked_with_disadvantage", "initiative_advantage"],
  paralyzed: [...INCAPACITATED, "speed_zero", "auto_fail_str_dex_saves", "attacked_with_advantage", "auto_crit_within_5ft"],
  petrified: [...INCAPACITATED, "speed_zero", "auto_fail_str_dex_saves", "attacked_with_advantage", "resistance_all_damage"],
  poisoned: ["attack_disadvantage", "check_disadvantage"],
  prone: ["attack_disadvantage", "attacked_prone"],
  restrained: ["speed_zero", "attack_disadvantage", "attacked_with_advantage", "dex_save_disadvantage"],
  stunned: [...INCAPACITATED, "auto_fail_str_dex_saves", "attacked_with_advantage"],
  unconscious: [
    ...INCAPACITATED,
    "speed_zero",
    "auto_fail_str_dex_saves",
    "attacked_with_advantage",
    "auto_crit_within_5ft",
    "attacked_prone",
  ],
};

/** Conditions and rulings of one creature (a token, or an actor with no rulings). */
export interface ConditionState {
  /** Condition ids, any case, with or without the `srd:condition:` prefix. */
  conditions: readonly string[];
  /** Game Master rulings on the token (engine `condition_overrides`). */
  overrides?: readonly ConditionOverrideRuling[];
}

/** Effects in force on one creature after the rulings. */
export interface ConditionEffects {
  /** Conditions in force, normalized, in order (same as the engine). */
  effectiveConditions: string[];
  /** Effect ids in force (`"<condition>.<rule>"`), forced ones included. */
  activeEffects: string[];
  /** No actions, bonus actions or reactions (same as the engine). */
  incapacitated: boolean;
  /** Speed 0 (same as the engine). */
  speedZero: boolean;
  /** Saving throws that fail automatically (`["str", "dex"]` or `[]`). */
  autoFailSaves: AbilityId[];
  /** Resistance to all damage (Petrified). */
  resistsAllDamage: boolean;
  /** `false` when a `REMOVE` ruling on `exhaustion` suspends the exhaustion level. */
  exhaustionApplies: boolean;
}

/** Normalizes a condition id the way the engine does (trim, lowercase, no `srd:condition:`). */
export function normalizeConditionId(id: string): string {
  return id.trim().toLowerCase().replace(/^srd:condition:/, "");
}

/** Conditions in force after `CONDITION` rulings (engine `effective_condition_ids`). */
export function effectiveConditionIds(state: ConditionState): string[] {
  const rulings = (state.overrides ?? []).filter((o) => o.subject === "CONDITION");
  const removed = new Set(rulings.filter((o) => o.mode === "REMOVE").map((o) => o.id));
  const forced = rulings.filter((o) => o.mode === "FORCE").map((o) => o.id);
  const out: string[] = [];
  for (const id of [...state.conditions.map(normalizeConditionId), ...forced]) {
    if (!removed.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Resolves every automated condition rule of `state` after its rulings (banner invariant 2). */
export function resolveConditionEffects(state: ConditionState): ConditionEffects {
  const effectiveConditions = effectiveConditionIds(state);
  const effectRulings = (state.overrides ?? []).filter((o) => o.subject === "EFFECT");
  const removed = new Set(effectRulings.filter((o) => o.mode === "REMOVE").map((o) => o.id));
  const activeEffects = effectiveConditions.flatMap((condition) =>
    (CONDITION_RULES[condition] ?? []).map((rule) => `${condition}.${rule}`).filter((id) => !removed.has(id))
  );
  for (const ruling of effectRulings) {
    if (ruling.mode === "FORCE" && !activeEffects.includes(ruling.id)) activeEffects.push(ruling.id);
  }
  const has = (rule: ConditionRule) => activeEffects.some((id) => id.endsWith(`.${rule}`));
  const exhaustionRemoved = (state.overrides ?? []).some(
    (o) => o.subject === "CONDITION" && o.mode === "REMOVE" && o.id === "exhaustion"
  );
  return {
    effectiveConditions,
    activeEffects,
    incapacitated: has("incapacitated"),
    speedZero: has("speed_zero"),
    autoFailSaves: has("auto_fail_str_dex_saves") ? ["str", "dex"] : [],
    resistsAllDamage: has("resistance_all_damage"),
    exhaustionApplies: !exhaustionRemoved,
  };
}

/** Advantage state of a d20 roll. */
export type RollMode = "advantage" | "disadvantage" | "normal";

/** SRD cancellation: any advantage plus any disadvantage is a straight roll. */
export function combineRollMode(advantageSources: number, disadvantageSources: number): RollMode {
  if (advantageSources > 0 && disadvantageSources === 0) return "advantage";
  if (disadvantageSources > 0 && advantageSources === 0) return "disadvantage";
  return "normal";
}

/** Kept d20 of a roll in `mode` (`rolls[0]` alone for a straight roll). */
export function keptD20(mode: RollMode, rolls: readonly [number, number] | readonly [number]): number {
  if (mode === "normal" || rolls.length === 1) return rolls[0];
  return mode === "advantage" ? Math.max(rolls[0], rolls[1]) : Math.min(rolls[0], rolls[1]);
}

/** Roll mode of one d20 test with the ids of the rules that produced it. */
export interface RollModeResolution {
  /** Combined mode after cancellation. */
  mode: RollMode;
  /** Effect ids or caller labels granting advantage. */
  advantageSources: string[];
  /** Effect ids or caller labels imposing disadvantage. */
  disadvantageSources: string[];
}

/** Extra advantage / disadvantage sources from outside conditions (features, Help, Reckless Attack). */
export interface ExtraRollSources {
  /** Labels of advantage sources (e.g. `"barbarian:reckless_attack"`). */
  advantage?: readonly string[];
  /** Labels of disadvantage sources (e.g. `"long_range"`). */
  disadvantage?: readonly string[];
}

/**
 * What kind of attack is rolled, for feature rules scoped to one source:
 * - `"weapon_str"`: weapon attack using Strength (Reckless Attack).
 * - `"weapon_dex"`: weapon attack using Dexterity.
 * - `"spell"`: spell attack (Innate Sorcery).
 */
export type AttackSource = "weapon_str" | "weapon_dex" | "spell";

/** d20 test a feature roll rule is matched against. */
export type FeatureRollQuery =
  | { roll: "attack"; source: AttackSource }
  | { roll: "attacked" }
  | { roll: "save"; ability: AbilityId }
  | { roll: "check"; ability: AbilityId }
  | { roll: "initiative" }
  | { roll: "death_save" };

/**
 * `ClassFeature` ids of the `"advantage"` rules in `rolls` that apply to
 * `query`: same roll kind, same ability for saves and checks, same source for
 * attacks. Skill-scoped check rules (Remarkable Athlete) never match a plain
 * ability check. `minimum_d20` rules (Reliable Talent) are not roll modes.
 */
export function featureAdvantageSources(rolls: readonly DerivedFeatureRollRule[] | undefined, query: FeatureRollQuery): string[] {
  return (rolls ?? [])
    .filter((rule) => {
      if (rule.kind !== "advantage" || rule.on.roll !== query.roll) return false;
      if (rule.on.roll === "attack" && query.roll === "attack") return rule.on.source === query.source;
      if ((rule.on.roll === "save" || rule.on.roll === "check") && (query.roll === "save" || query.roll === "check")) {
        return rule.on.ability === query.ability && !("skill" in rule.on && rule.on.skill);
      }
      return true;
    })
    .map((rule) => rule.featureId);
}

/** Inputs of `resolveAttackRollMode`. */
export interface AttackRollContext {
  /** Attacker conditions and rulings. */
  attacker: ConditionState;
  /** Target conditions and rulings. */
  target: ConditionState;
  /** Distance between attacker and target in feet (`ft`), for Prone and automatic critical hits. */
  distanceFt: number;
  /** `true` when the target is the creature grappling the attacker. */
  targetIsGrappler?: boolean;
  /** Kind of attack, matched against the attacker's feature rules (none matched when absent). */
  source?: AttackSource;
  /** Attacker's `DerivedFeatureRules.rolls` (Reckless Attack, Innate Sorcery). */
  attackerFeatures?: readonly DerivedFeatureRollRule[];
  /** Target's `DerivedFeatureRules.rolls` (attacks against a reckless barbarian). */
  targetFeatures?: readonly DerivedFeatureRollRule[];
  /** Sources from outside conditions and features. */
  extra?: ExtraRollSources;
}

/** Roll mode of an attack plus the automatic critical hit rule. */
export interface AttackRollResolution extends RollModeResolution {
  /** A hit is a critical hit (Paralyzed or Unconscious target, attacker within 5 ft). */
  autoCritical: boolean;
}

function withRule(effects: ConditionEffects, rule: ConditionRule): string[] {
  return effects.activeEffects.filter((id) => id.endsWith(`.${rule}`));
}

function resolution(advantage: string[], disadvantage: string[], extra?: ExtraRollSources): RollModeResolution {
  const advantageSources = [...advantage, ...(extra?.advantage ?? [])];
  const disadvantageSources = [...disadvantage, ...(extra?.disadvantage ?? [])];
  return {
    mode: combineRollMode(advantageSources.length, disadvantageSources.length),
    advantageSources,
    disadvantageSources,
  };
}

/** Advantage, disadvantage and automatic critical hit of an attack roll (SRD 5.2.1 conditions). */
export function resolveAttackRollMode(ctx: AttackRollContext): AttackRollResolution {
  const attacker = resolveConditionEffects(ctx.attacker);
  const target = resolveConditionEffects(ctx.target);
  const within5 = ctx.distanceFt <= 5;
  const prone = withRule(target, "attacked_prone");
  const advantage = [
    ...withRule(attacker, "attack_advantage"),
    ...withRule(target, "attacked_with_advantage"),
    ...(within5 ? prone : []),
    ...(ctx.source ? featureAdvantageSources(ctx.attackerFeatures, { roll: "attack", source: ctx.source }) : []),
    ...featureAdvantageSources(ctx.targetFeatures, { roll: "attacked" }),
  ];
  const disadvantage = [
    ...withRule(attacker, "attack_disadvantage"),
    ...(ctx.targetIsGrappler ? [] : withRule(attacker, "attack_disadvantage_vs_others")),
    ...withRule(target, "attacked_with_disadvantage"),
    ...(within5 ? [] : prone),
  ];
  return {
    ...resolution(advantage, disadvantage, ctx.extra),
    autoCritical: within5 && withRule(target, "auto_crit_within_5ft").length > 0,
  };
}

/** Roll mode of a saving throw plus the automatic failure rule. */
export interface SavingThrowResolution extends RollModeResolution {
  /** The save fails without a roll (Paralyzed, Petrified, Stunned, Unconscious on STR / DEX). */
  autoFail: boolean;
}

/**
 * Advantage, disadvantage and automatic failure of a saving throw of
 * `ability`. `features` are the creature's own feature roll rules (Danger
 * Sense, Rage); they are ignored while it is Incapacitated (invariant 6).
 */
export function resolveSavingThrowMode(
  state: ConditionState,
  ability: AbilityId,
  extra?: ExtraRollSources,
  features?: readonly DerivedFeatureRollRule[]
): SavingThrowResolution {
  const effects = resolveConditionEffects(state);
  const disadvantage = ability === "dex" ? withRule(effects, "dex_save_disadvantage") : [];
  const advantage = effects.incapacitated ? [] : featureAdvantageSources(features, { roll: "save", ability });
  return { ...resolution(advantage, disadvantage, extra), autoFail: effects.autoFailSaves.includes(ability) };
}

/**
 * Advantage and disadvantage of an ability check (skills included, initiative
 * excluded). `ability` selects the feature rules of `features` that apply (Rage
 * on Strength checks).
 */
export function resolveAbilityCheckMode(
  state: ConditionState,
  extra?: ExtraRollSources,
  features?: readonly DerivedFeatureRollRule[],
  ability?: AbilityId
): RollModeResolution {
  const advantage = ability ? featureAdvantageSources(features, { roll: "check", ability }) : [];
  return resolution(advantage, withRule(resolveConditionEffects(state), "check_disadvantage"), extra);
}

/** Advantage and disadvantage of the Initiative roll (a Dexterity check). */
export function resolveInitiativeMode(
  state: ConditionState,
  extra?: ExtraRollSources,
  features?: readonly DerivedFeatureRollRule[]
): RollModeResolution {
  const effects = resolveConditionEffects(state);
  return resolution(
    [...withRule(effects, "initiative_advantage"), ...featureAdvantageSources(features, { roll: "initiative" })],
    [...withRule(effects, "initiative_disadvantage"), ...withRule(effects, "check_disadvantage")],
    extra
  );
}
