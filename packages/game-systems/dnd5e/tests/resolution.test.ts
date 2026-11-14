import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  attackSourceOf,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  d20Expression,
  damageAfterSave,
  damageExpression,
  featureAdvantageSources,
  resolveAttackOutcome,
  resolveAttackRollMode,
  resolveSaveOutcome,
  resolveSavingThrowMode,
  saveBonusWithCover,
  type AbilityId,
  type AttackOutcome,
  type AttackOutcomeInput,
  type AttackSource,
  type CoverLevel,
  type DerivedFeatureRollRule,
  type Dnd5eActorData,
  type RollMode,
  type SaveOutcome,
  type SrdClassId,
} from "../src/index.ts";

function hero(classId: SrdClassId, level: number, active: string[] = []): Dnd5eActorData {
  const actor = createDefaultActorData(`hero-${classId}-${level}`, classId);
  actor.classId = classId;
  actor.attributes.level = level;
  actor.activeFeatureIds = active;
  return actor;
}

function rollsOf(actor: Dnd5eActorData): DerivedFeatureRollRule[] {
  return computeDnd5eSheetDerived(actor).featureRules?.rolls ?? [];
}

describe("d20 and damage expressions", () => {
  const d20Cases: [string, RollMode, number, string][] = [
    ["straight_roll_with_bonus", "normal", 5, "1d20+5"],
    ["advantage_keeps_highest", "advantage", 7, "2d20kh1+7"],
    ["disadvantage_keeps_lowest", "disadvantage", -1, "2d20kl1-1"],
    ["zero_bonus_has_no_modifier", "normal", 0, "1d20"],
  ];
  for (const [id, mode, bonus, expected] of d20Cases) {
    it(id, () => assert.equal(d20Expression(mode, bonus), expected));
  }

  const damageCases: [string, string, number, boolean, string][] = [
    ["normal_hit_adds_modifier", "1d8", 3, false, "1d8+3"],
    ["critical_doubles_dice_not_modifier", "1d8", 3, true, "2d8+3"],
    ["critical_doubles_every_dice_term", "2d6+1d4", 0, true, "4d6+2d4"],
    ["critical_cantrip_without_modifier", "2d10", 0, true, "4d10"],
    ["negative_modifier_kept_once", "1d4", -1, true, "2d4-1"],
  ];
  for (const [id, dice, modifier, critical, expected] of damageCases) {
    it(id, () => assert.equal(damageExpression(dice, modifier, critical), expected));
  }
});

describe("Attack outcome: hit, miss, critical, cover, hidden AC", () => {
  const base: AttackOutcomeInput = { natural: 10, total: 15, targetAc: 15, cover: "NONE" };
  const cases: [string, Partial<AttackOutcomeInput>, AttackOutcome][] = [
    ["total_equal_to_ac_hits", {}, "hit"],
    ["total_below_ac_misses", { total: 14 }, "miss"],
    ["half_cover_adds_two_to_ac", { cover: "HALF", total: 16 }, "miss"],
    ["half_cover_beaten_hits", { cover: "HALF", total: 17 }, "hit"],
    ["three_quarters_cover_adds_five", { cover: "THREE_QUARTERS", total: 19 }, "miss"],
    ["total_cover_blocks_attack", { cover: "TOTAL", natural: 20, total: 30 }, "blocked"],
    ["natural_1_misses_whatever_total", { natural: 1, total: 40 }, "miss"],
    ["natural_20_crits_whatever_ac", { natural: 20, total: 21, targetAc: 30 }, "critical"],
    ["champion_19_crits", { natural: 19, total: 20, targetAc: 25, criticalRange: 19 }, "critical"],
    ["champion_19_range_still_misses_on_18_below_ac", { natural: 18, total: 19, targetAc: 25, criticalRange: 19 }, "miss"],
    ["superior_critical_18_crits", { natural: 18, total: 18, criticalRange: 18 }, "critical"],
    ["auto_critical_turns_hit_into_critical", { autoCritical: true }, "critical"],
    ["auto_critical_does_not_turn_miss_into_hit", { autoCritical: true, total: 5 }, "miss"],
    ["hidden_ac_is_unknown", { targetAc: null }, "unknown"],
    ["hidden_ac_natural_20_is_still_critical", { targetAc: null, natural: 20, total: 25 }, "critical"],
    ["hidden_ac_natural_1_is_still_miss", { targetAc: null, natural: 1, total: 6 }, "miss"],
  ];
  for (const [id, partial, expected] of cases) {
    it(id, () => assert.equal(resolveAttackOutcome({ ...base, ...partial }), expected));
  }
});

describe("Saving throws: cover, auto-fail, save-for-half", () => {
  const bonusCases: [string, number, AbilityId, CoverLevel, number | null][] = [
    ["dex_save_gains_half_cover", 3, "dex", "HALF", 5],
    ["dex_save_gains_three_quarters_cover", 3, "dex", "THREE_QUARTERS", 8],
    ["con_save_ignores_cover", 3, "con", "THREE_QUARTERS", 3],
    ["total_cover_has_no_save", 3, "dex", "TOTAL", null],
  ];
  for (const [id, bonus, ability, cover, expected] of bonusCases) {
    it(id, () => assert.equal(saveBonusWithCover(bonus, ability, cover), expected));
  }

  const outcomeCases: [string, number | null, boolean, CoverLevel, SaveOutcome][] = [
    ["total_meets_dc_succeeds", 13, false, "NONE", "success"],
    ["total_below_dc_fails", 12, false, "NONE", "failure"],
    ["auto_fail_ignores_total", 30, true, "NONE", "failure"],
    ["unknown_bonus_is_unknown", null, false, "NONE", "unknown"],
    ["total_cover_is_blocked", 2, true, "TOTAL", "blocked"],
  ];
  for (const [id, total, autoFail, cover, expected] of outcomeCases) {
    it(id, () => assert.equal(resolveSaveOutcome({ total, dc: 13, autoFail, cover }), expected));
  }

  const damageCases: [string, number, SaveOutcome, boolean, number][] = [
    ["failed_save_takes_full", 28, "failure", true, 28],
    ["successful_save_takes_half_rounded_down", 27, "success", true, 13],
    ["successful_save_without_half_takes_none", 27, "success", false, 0],
    ["blocked_takes_none", 27, "blocked", true, 0],
    ["unknown_defaults_to_full_until_ruled", 10, "unknown", true, 10],
  ];
  for (const [id, raw, outcome, half, expected] of damageCases) {
    it(id, () => assert.equal(damageAfterSave(raw, outcome, half), expected));
  }
});

describe("Class feature roll rules join condition cancellation", () => {
  const attackCases: [string, string[], string[], AttackSource, RollMode][] = [
    ["reckless_attack_grants_strength_weapon_advantage", ["barbarian:reckless_attack"], [], "weapon_str", "advantage"],
    ["reckless_attack_ignores_dexterity_weapons", ["barbarian:reckless_attack"], [], "weapon_dex", "normal"],
    ["reckless_attack_cancelled_by_poisoned", ["barbarian:reckless_attack"], ["poisoned"], "weapon_str", "normal"],
    ["inactive_reckless_attack_grants_nothing", [], [], "weapon_str", "normal"],
  ];
  for (const [id, active, conditions, source, expected] of attackCases) {
    it(id, () => {
      const result = resolveAttackRollMode({
        attacker: { conditions },
        target: { conditions: [] },
        distanceFt: 5,
        source,
        attackerFeatures: rollsOf(hero("barbarian", 2, active)),
      });
      assert.equal(result.mode, expected);
    });
  }

  it("attacks_against_reckless_barbarian_have_advantage", () => {
    const result = resolveAttackRollMode({
      attacker: { conditions: [] },
      target: { conditions: [] },
      distanceFt: 5,
      targetFeatures: rollsOf(hero("barbarian", 2, ["barbarian:reckless_attack"])),
    });
    assert.deepEqual([result.mode, result.advantageSources], ["advantage", ["barbarian:reckless_attack"]]);
  });

  it("innate_sorcery_grants_spell_attack_advantage", () => {
    const rolls = rollsOf(hero("sorcerer", 1, ["sorcerer:innate_sorcery"]));
    assert.deepEqual(featureAdvantageSources(rolls, { roll: "attack", source: "spell" }), ["sorcerer:innate_sorcery"]);
  });

  const saveCases: [string, string[], AbilityId, RollMode][] = [
    ["danger_sense_grants_dex_save_advantage", [], "dex", "advantage"],
    ["danger_sense_cancelled_by_restrained", ["restrained"], "dex", "normal"],
    ["danger_sense_lost_while_incapacitated", ["incapacitated"], "dex", "normal"],
    ["danger_sense_does_not_cover_wis_saves", [], "wis", "normal"],
  ];
  for (const [id, conditions, ability, expected] of saveCases) {
    it(id, () => {
      const result = resolveSavingThrowMode({ conditions }, ability, undefined, rollsOf(hero("barbarian", 2)));
      assert.equal(result.mode, expected);
    });
  }

  const sourceCases: [string, "weapon" | "spell", AbilityId | undefined, AttackSource][] = [
    ["strength_weapon", "weapon", "str", "weapon_str"],
    ["finesse_weapon_with_dex", "weapon", "dex", "weapon_dex"],
    ["spell_attack", "spell", undefined, "spell"],
  ];
  for (const [id, source, ability, expected] of sourceCases) {
    it(`attack_source_${id}`, () => assert.equal(attackSourceOf({ source, ability }), expected));
  }
});
