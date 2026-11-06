import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  combineRollMode,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  resolveAbilityCheckMode,
  resolveActionPipeline,
  resolveAttackRollMode,
  resolveConditionEffects,
  resolveDamagePipeline,
  resolveInitiativeMode,
  resolveSavingThrowMode,
  type AbilityId,
  type ActionDefinition,
  type AttackRollContext,
  type ConditionOverrideRuling,
  type ConditionState,
  type Dnd5eActorSheet,
  type RollMode,
} from "../src/index.ts";

const removeCondition = (id: string): ConditionOverrideRuling => ({ subject: "CONDITION", id, mode: "REMOVE" });
const forceCondition = (id: string): ConditionOverrideRuling => ({ subject: "CONDITION", id, mode: "FORCE" });
const removeEffect = (id: string): ConditionOverrideRuling => ({ subject: "EFFECT", id, mode: "REMOVE" });
const forceEffect = (id: string): ConditionOverrideRuling => ({ subject: "EFFECT", id, mode: "FORCE" });
const state = (conditions: string[], overrides: ConditionOverrideRuling[] = []): ConditionState => ({ conditions, overrides });

function sheet(overrides: Partial<Dnd5eActorSheet> = {}): Dnd5eActorSheet {
  return {
    id: "sheet",
    name: "Sheet",
    level: 5,
    spellcastingAbility: "int",
    abilities: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
    saveProficiencies: {},
    skillProficiencies: {},
    armorKind: "unarmored",
    armorBaseAc: 10,
    hasShield: false,
    hpCurrent: 100,
    hpMax: 100,
    tempHp: 0,
    hitDiceCurrent: 5,
    hitDiceMax: 5,
    hitDieSides: 8,
    exhaustionLevel: 0,
    conditions: [],
    resources: {},
    deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
    ...overrides,
  };
}

describe("SRD cancellation: any advantage plus any disadvantage is a straight roll", () => {
  const cases: [string, number, number, RollMode][] = [
    ["no_sources_is_normal", 0, 0, "normal"],
    ["one_advantage", 1, 0, "advantage"],
    ["two_disadvantages", 0, 2, "disadvantage"],
    ["one_each_cancels", 1, 1, "normal"],
    ["three_advantages_vs_one_disadvantage_still_cancels", 3, 1, "normal"],
  ];
  for (const [id, adv, dis, expected] of cases) {
    it(id, () => assert.equal(combineRollMode(adv, dis), expected));
  }
});

describe("Attack roll mode from attacker and target conditions", () => {
  const cases: [string, Partial<AttackRollContext>, RollMode, boolean][] = [
    ["blinded_attacker_has_disadvantage", { attacker: state(["blinded"]) }, "disadvantage", false],
    ["poisoned_attacker_has_disadvantage", { attacker: state(["poisoned"]) }, "disadvantage", false],
    ["invisible_attacker_has_advantage", { attacker: state(["invisible"]) }, "advantage", false],
    ["restrained_target_grants_advantage", { target: state(["restrained"]) }, "advantage", false],
    ["invisible_target_imposes_disadvantage", { target: state(["invisible"]) }, "disadvantage", false],
    ["blinded_attacker_vs_restrained_target_cancels", { attacker: state(["blinded"]), target: state(["restrained"]) }, "normal", false],
    ["prone_target_within_5ft_grants_advantage", { target: state(["prone"]), distanceFt: 5 }, "advantage", false],
    ["prone_target_at_30ft_imposes_disadvantage", { target: state(["prone"]), distanceFt: 30 }, "disadvantage", false],
    ["unconscious_target_at_range_cancels_to_normal", { target: state(["unconscious"]), distanceFt: 30 }, "normal", false],
    ["paralyzed_target_within_5ft_is_auto_crit", { target: state(["paralyzed"]), distanceFt: 5 }, "advantage", true],
    ["paralyzed_target_at_10ft_is_not_auto_crit", { target: state(["paralyzed"]), distanceFt: 10 }, "advantage", false],
    ["compendium_condition_id_counts", { target: state(["srd:condition:unconscious"]), distanceFt: 5 }, "advantage", true],
    ["grappled_attacker_vs_other_creature_has_disadvantage", { attacker: state(["grappled"]) }, "disadvantage", false],
    ["grappled_attacker_vs_grappler_is_normal", { attacker: state(["grappled"]), targetIsGrappler: true }, "normal", false],
    ["poisoned_attacker_with_reckless_attack_cancels", { attacker: state(["poisoned"]), extra: { advantage: ["reckless_attack"] } }, "normal", false],
    ["removed_blinded_condition_restores_normal", { attacker: state(["blinded"], [removeCondition("blinded")]) }, "normal", false],
    ["forced_condition_applies_its_rules", { target: state([], [forceCondition("stunned")]) }, "advantage", false],
    [
      "removed_auto_crit_effect_keeps_advantage",
      { target: state(["paralyzed"], [removeEffect("paralyzed.auto_crit_within_5ft")]), distanceFt: 5 },
      "advantage",
      false,
    ],
    ["forced_effect_without_condition", { target: state([], [forceEffect("blinded.attacked_with_advantage")]) }, "advantage", false],
  ];
  for (const [id, partial, mode, autoCritical] of cases) {
    it(id, () => {
      const result = resolveAttackRollMode({ attacker: state([]), target: state([]), distanceFt: 5, ...partial });
      assert.deepEqual([result.mode, result.autoCritical], [mode, autoCritical]);
    });
  }
});

describe("Saving throws: auto-fail and disadvantage", () => {
  const cases: [string, ConditionState, AbilityId, RollMode, boolean][] = [
    ["paralyzed_fails_str", state(["paralyzed"]), "str", "normal", true],
    ["stunned_fails_dex", state(["stunned"]), "dex", "normal", true],
    ["unconscious_fails_dex", state(["unconscious"]), "dex", "normal", true],
    ["petrified_fails_str", state(["petrified"]), "str", "normal", true],
    ["stunned_wis_save_is_rolled", state(["stunned"]), "wis", "normal", false],
    ["restrained_dex_save_has_disadvantage", state(["restrained"]), "dex", "disadvantage", false],
    ["restrained_str_save_is_normal", state(["restrained"]), "str", "normal", false],
    ["removed_stun_is_rolled", state(["stunned"], [removeCondition("stunned")]), "dex", "normal", false],
    ["removed_auto_fail_effect_is_rolled", state(["stunned"], [removeEffect("stunned.auto_fail_str_dex_saves")]), "dex", "normal", false],
  ];
  for (const [id, s, ability, mode, autoFail] of cases) {
    it(id, () => {
      const result = resolveSavingThrowMode(s, ability);
      assert.deepEqual([result.mode, result.autoFail], [mode, autoFail]);
    });
  }
});

describe("Ability checks and initiative", () => {
  const checks: [string, ConditionState, RollMode][] = [
    ["poisoned_check_has_disadvantage", state(["poisoned"]), "disadvantage"],
    ["frightened_check_has_disadvantage", state(["frightened"]), "disadvantage"],
    ["blinded_check_is_normal", state(["blinded"]), "normal"],
  ];
  for (const [id, s, mode] of checks) {
    it(id, () => assert.equal(resolveAbilityCheckMode(s).mode, mode));
  }
  const initiative: [string, ConditionState, RollMode][] = [
    ["invisible_initiative_has_advantage", state(["invisible"]), "advantage"],
    ["incapacitated_initiative_has_disadvantage", state(["incapacitated"]), "disadvantage"],
    ["invisible_and_poisoned_initiative_cancels", state(["invisible", "poisoned"]), "normal"],
  ];
  for (const [id, s, mode] of initiative) {
    it(id, () => assert.equal(resolveInitiativeMode(s).mode, mode));
  }
});

describe("Engine-shared effects (speed 0, incapacitated)", () => {
  const cases: [string, ConditionState, boolean, boolean][] = [
    ["grappled_speed_zero", state(["grappled"]), true, false],
    ["restrained_speed_zero", state(["restrained"]), true, false],
    ["stunned_incapacitated_but_moves", state(["stunned"]), false, true],
    ["petrified_both", state(["petrified"]), true, true],
    ["removed_speed_effect", state(["grappled"], [removeEffect("grappled.speed_zero")]), false, false],
    ["forced_speed_effect", state([], [forceEffect("restrained.speed_zero")]), true, false],
  ];
  for (const [id, s, speedZero, incapacitated] of cases) {
    it(id, () => {
      const effects = resolveConditionEffects(s);
      assert.deepEqual([effects.speedZero, effects.incapacitated], [speedZero, incapacitated]);
    });
  }
});

describe("Action pipeline applies condition effects", () => {
  const sword: ActionDefinition = {
    id: "sword",
    name: "Sword",
    resolutionKind: "attack_roll",
    baseDamage: 5,
    damageModifier: 3,
    attackBonus: 5,
  };
  const hold: ActionDefinition = {
    id: "shove",
    name: "Shove",
    resolutionKind: "saving_throw",
    saveAbility: "dex",
    saveDc: 10,
    baseDamage: 6,
  };

  it("hit_within_5ft_on_paralyzed_target_is_critical", () => {
    const [outcome] = resolveActionPipeline(sheet(), sword, [
      { target: sheet({ id: "t", conditions: ["paralyzed"] }), attackD20Rolls: [4, 12], distanceFt: 5 },
    ]);
    assert.deepEqual([outcome.rollMode, outcome.criticalHit, outcome.damageApplied], ["advantage", true, 13]);
  });

  it("disadvantage_keeps_the_lower_d20_and_misses", () => {
    const [outcome] = resolveActionPipeline(sheet({ conditions: ["poisoned"] }), sword, [
      { target: sheet({ id: "t" }), attackD20Rolls: [18, 2] },
    ]);
    assert.deepEqual([outcome.rollMode, outcome.hitOrFailedSave], ["disadvantage", false]);
  });

  it("removed_attacker_condition_keeps_the_first_d20", () => {
    const [outcome] = resolveActionPipeline(
      sheet({ conditions: ["poisoned"] }),
      sword,
      [{ target: sheet({ id: "t" }), attackD20Rolls: [18, 2] }],
      undefined,
      [removeCondition("poisoned")]
    );
    assert.deepEqual([outcome.rollMode, outcome.hitOrFailedSave], ["normal", true]);
  });

  it("stunned_target_auto_fails_dex_save_even_on_20", () => {
    const [outcome] = resolveActionPipeline(sheet(), hold, [
      { target: sheet({ id: "t", conditions: ["stunned"] }), saveD20Roll: 20 },
    ]);
    assert.deepEqual([outcome.autoFailedSave, outcome.hitOrFailedSave, outcome.damageApplied], [true, true, 6]);
  });

  it("removed_stun_ruling_lets_the_save_succeed", () => {
    const [outcome] = resolveActionPipeline(sheet(), hold, [
      { target: sheet({ id: "t", conditions: ["stunned"] }), saveD20Roll: 20, overrides: [removeCondition("stunned")] },
    ]);
    assert.deepEqual([outcome.autoFailedSave, outcome.hitOrFailedSave], [false, false]);
  });
});

describe("Damage pipeline: Petrified resists all damage", () => {
  const cases: [string, ConditionOverrideRuling[], number][] = [
    ["petrified_halves_force_damage", [], 5],
    ["removed_petrified_takes_full_damage", [removeCondition("petrified")], 10],
    ["removed_resistance_effect_takes_full_damage", [removeEffect("petrified.resistance_all_damage")], 10],
  ];
  for (const [id, conditionOverrides, expected] of cases) {
    it(id, () => {
      const actor = createDefaultActorData("statue", "Statue");
      actor.attributes.hp = { current: 20, max: 20, temp: 0 };
      actor.conditions = [{ id: "petrified", name: "Petrified", durationRounds: 10, trigger: "ROUNDS" }];
      const result = resolveDamagePipeline(actor, [{ amount: 10, type: "force" }], { conditionOverrides });
      assert.equal(result.totalMitigatedDamage, expected);
    });
  }
});

describe("Sheet derivation exposes condition effects", () => {
  it("grappled_actor_reports_speed_zero_and_keeps_walking_speed", () => {
    const actor = createDefaultActorData("held", "Held");
    actor.conditions = [{ id: "grappled", name: "Grappled", durationRounds: 1, trigger: "ROUNDS" }];
    const derived = computeDnd5eSheetDerived(actor);
    assert.deepEqual([derived.conditionEffects?.speedZero, derived.speed], [true, 30]);
  });

  const exhaustion: [string, ConditionOverrideRuling[], number, number][] = [
    ["exhaustion_2_reduces_speed_and_saves", [], 20, -4],
    ["removed_exhaustion_ruling_suspends_the_penalties", [removeCondition("exhaustion")], 30, 0],
  ];
  for (const [id, conditionOverrides, speed, strSave] of exhaustion) {
    it(id, () => {
      const actor = createDefaultActorData("tired", "Tired");
      actor.attributes.exhaustion = 2;
      const derived = computeDnd5eSheetDerived(actor, undefined, { conditionOverrides });
      assert.deepEqual([derived.speed, derived.savingThrows.str], [speed, strSave]);
    });
  }
});
