import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  applyLongRest,
  applyShortRest,
  classFeaturesFor,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  SRD_CLASS_FEATURE_SUBCLASSES,
  SRD_CLASS_PROGRESSION,
  srdClassFeatures,
  type AbilityId,
  type ActorItem,
  type Dnd5eActorData,
  type SrdClassId,
} from "../src/index.ts";

function hero(
  classId: SrdClassId,
  level: number,
  options: { scores?: Partial<Record<AbilityId, number>>; subclassId?: string; active?: string[]; items?: ActorItem[] } = {}
): Dnd5eActorData {
  const actor = createDefaultActorData(`hero-${classId}-${level}`, classId);
  actor.classId = classId;
  actor.attributes.level = level;
  for (const [ab, score] of Object.entries(options.scores ?? {}) as [AbilityId, number][]) actor.abilities[ab].score = score;
  if (options.subclassId) actor.subclassId = options.subclassId;
  if (options.active) actor.activeFeatureIds = options.active;
  if (options.items) actor.items = options.items;
  return actor;
}

function equipped(compendiumKey: string, name = compendiumKey): ActorItem {
  return { id: `i-${compendiumKey}`, name, quantity: 1, compendiumId: `srd:item:${compendiumKey}`, equipped: true };
}

function pool(actor: Dnd5eActorData, id: string) {
  return computeDnd5eSheetDerived(actor).resourcePools?.find((p) => p.id === id);
}

describe("ClassFeature catalogue covers the 12 SRD classes and subclasses", () => {
  it("every_progression_feature_has_a_catalogue_entry", () => {
    for (const [classId, progression] of Object.entries(SRD_CLASS_PROGRESSION)) {
      const names = Object.values(progression.features).flat().length;
      const entries = srdClassFeatures().filter((spec) => spec.classId === classId && !spec.subclassId).length;
      assert.equal(entries, names, classId);
    }
  });

  it("twelve_subclasses_one_per_class", () => {
    assert.equal(SRD_CLASS_FEATURE_SUBCLASSES.length, 12);
    const classes = new Set(srdClassFeatures().filter((spec) => spec.subclassId).map((spec) => spec.classId));
    assert.equal(classes.size, 12);
  });

  it("feature_ids_are_unique", () => {
    const ids = srdClassFeatures().map((spec) => spec.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("pool_ids_are_unique", () => {
    const ids = srdClassFeatures().flatMap((spec) => (spec.pool ? [spec.pool.id] : []));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("levels_stay_within_1_to_20", () => {
    assert.ok(srdClassFeatures().every((spec) => spec.level >= 1 && spec.level <= 20));
  });
});

describe("D12 boundary: automated vs described", () => {
  const cases: [string, string, "automated" | "described"][] = [
    ["rage_changes_rolls_and_damage", "barbarian:rage", "automated"],
    ["extra_attack_changes_attacks", "fighter:extra_attack", "automated"],
    ["unarmored_movement_changes_speed", "monk:unarmored_movement", "automated"],
    ["improved_critical_changes_crit_range", "champion:improved_critical", "automated"],
    ["sneak_attack_damage_scales", "rogue:sneak_attack", "automated"],
    ["divine_smite_damage_scales", "paladin:paladin_s_smite", "automated"],
    ["wild_shape_is_a_profile_replacement", "druid:wild_shape", "described"],
    ["channel_divinity_options_are_chosen", "cleric:channel_divinity", "described"],
    ["lay_on_hands_is_spent_by_the_player", "paladin:lay_on_hands", "described"],
    ["action_surge_is_a_turn_choice", "fighter:action_surge", "described"],
    ["deflect_attacks_is_a_reaction", "monk:deflect_attacks", "described"],
  ];
  for (const [id, featureId, automation] of cases) {
    it(id, () => {
      assert.equal(srdClassFeatures().find((spec) => spec.id === featureId)?.automation, automation);
    });
  }
});

describe("Resource pools scale with level and ability modifiers", () => {
  const cases: [string, Dnd5eActorData, string, number, "SHORT_REST" | "LONG_REST"][] = [
    ["rage_2_at_level_1", hero("barbarian", 1), "barbarian_rage", 2, "LONG_REST"],
    ["rage_6_at_level_17", hero("barbarian", 17), "barbarian_rage", 6, "LONG_REST"],
    ["bardic_inspiration_cha_mod", hero("bard", 1, { scores: { cha: 16 } }), "bard_bardic_inspiration", 3, "LONG_REST"],
    ["bardic_inspiration_min_1", hero("bard", 1, { scores: { cha: 8 } }), "bard_bardic_inspiration", 1, "LONG_REST"],
    ["font_of_inspiration_short_rest", hero("bard", 5, { scores: { cha: 16 } }), "bard_bardic_inspiration", 3, "SHORT_REST"],
    ["channel_divinity_3_at_cleric_6", hero("cleric", 6), "cleric_channel_divinity", 3, "LONG_REST"],
    ["wild_shape_2_at_druid_2", hero("druid", 2), "druid_wild_shape", 2, "LONG_REST"],
    ["second_wind_4_at_fighter_10", hero("fighter", 10), "fighter_second_wind", 4, "LONG_REST"],
    ["action_surge_2_at_fighter_17", hero("fighter", 17), "fighter_action_surge", 2, "SHORT_REST"],
    ["focus_points_equal_monk_level", hero("monk", 7), "monk_focus_points", 7, "SHORT_REST"],
    ["lay_on_hands_5_per_level", hero("paladin", 4), "paladin_lay_on_hands", 20, "LONG_REST"],
    ["sorcery_points_equal_level", hero("sorcerer", 9), "sorcerer_sorcery_points", 9, "LONG_REST"],
    ["favored_enemy_3_at_ranger_5", hero("ranger", 5), "ranger_favored_enemy", 3, "LONG_REST"],
    ["wholeness_of_body_wis_mod", hero("monk", 6, { scores: { wis: 18 }, subclassId: "open_hand" }), "open_hand_wholeness_of_body", 4, "LONG_REST"],
  ];
  for (const [id, actor, poolId, max, resetOn] of cases) {
    it(id, () => {
      const derived = pool(actor, poolId);
      assert.deepEqual([derived?.max, derived?.current, derived?.resetOn], [max, max, resetOn]);
    });
  }

  const absent: [string, Dnd5eActorData, string][] = [
    ["no_action_surge_at_fighter_1", hero("fighter", 1), "fighter_action_surge"],
    ["no_focus_at_monk_1", hero("monk", 1), "monk_focus_points"],
    ["no_subclass_pool_without_subclass", hero("monk", 6, { scores: { wis: 18 } }), "open_hand_wholeness_of_body"],
  ];
  for (const [id, actor, poolId] of absent) {
    it(id, () => assert.equal(pool(actor, poolId), undefined));
  }

  it("tracked_current_is_kept_and_capped_at_max", () => {
    const actor = hero("barbarian", 3);
    actor.resources = { barbarian_rage: { current: 1, max: 3, resetOn: "LONG_REST" } };
    assert.equal(pool(actor, "barbarian_rage")?.current, 1);
    actor.resources.barbarian_rage.current = 9;
    assert.equal(pool(actor, "barbarian_rage")?.current, 3);
  });
});

describe("Sheet features expose pools, scaling and toggles", () => {
  it("rage_feature_has_pool_scaling_and_toggle_state", () => {
    const actor = hero("barbarian", 9, { active: ["barbarian:rage"] });
    actor.resources = { barbarian_rage: { current: 2, max: 4, resetOn: "LONG_REST" } };
    const rage = computeDnd5eSheetDerived(actor).features?.find((f) => f.id === "barbarian:rage");
    assert.deepEqual(rage, {
      name: "Rage",
      source: "class",
      level: 1,
      id: "barbarian:rage",
      automation: "automated",
      pool: { id: "barbarian_rage", current: 2, max: 4, resetOn: "LONG_REST", shortRestRegain: 1 },
      scaling: { label: "Rage Damage", value: "+3" },
      active: true,
    });
  });

  it("subclass_features_follow_the_subclass_entry", () => {
    const features = computeDnd5eSheetDerived(hero("fighter", 15, { subclassId: "srd:subclass:champion" })).features ?? [];
    const subclassIndex = features.findIndex((f) => f.id === "srd:subclass:champion");
    const critIndex = features.findIndex((f) => f.id === "champion:superior_critical");
    assert.ok(subclassIndex >= 0 && critIndex > subclassIndex);
    assert.equal(features[critIndex].source, "subclass");
    assert.ok(!features.some((f) => f.id === "champion:survivor"));
  });
});

describe("Feature effects run through the 5-phase DAG", () => {
  const cases: [string, Dnd5eActorData, (d: ReturnType<typeof computeDnd5eSheetDerived>) => number, number][] = [
    ["monk_unarmored_movement_plus_10_at_2", hero("monk", 2), (d) => d.speed, 40],
    ["monk_unarmored_movement_plus_30_at_18", hero("monk", 18), (d) => d.speed, 60],
    ["monk_unarmored_movement_lost_in_armor", hero("monk", 2, { items: [equipped("leather_armor")] }), (d) => d.speed, 30],
    ["barbarian_fast_movement_at_5", hero("barbarian", 5), (d) => d.speed, 40],
    ["barbarian_fast_movement_lost_in_heavy_armor", hero("barbarian", 5, { items: [equipped("chain_mail")] }), (d) => d.speed, 30],
    ["jack_of_all_trades_half_prof_on_untrained_skill", hero("bard", 2), (d) => d.skills.arcana, 1],
    ["aura_of_protection_adds_cha_mod_to_saves", hero("paladin", 6, { scores: { cha: 16 } }), (d) => d.savingThrows.str, 3],
    ["aura_of_protection_minimum_1", hero("paladin", 6, { scores: { cha: 8 } }), (d) => d.savingThrows.str, 1],
    ["disciplined_survivor_proficient_in_all_saves", hero("monk", 14), (d) => d.savingThrows.int, 5],
    ["slippery_mind_wis_save_proficiency", hero("rogue", 15), (d) => d.savingThrows.wis, 5],
    ["primal_champion_raises_str_by_4", hero("barbarian", 20, { scores: { str: 20 } }), (d) => d.abilityMods.str, 7],
    ["primal_champion_capped_at_25", hero("barbarian", 20, { scores: { str: 23 } }), (d) => d.abilityMods.str, 7],
    ["draconic_resilience_ac_10_dex_cha", hero("sorcerer", 3, { scores: { dex: 14, cha: 16 }, subclassId: "draconic" }), (d) => d.armorClass, 15],
    ["innate_sorcery_off_keeps_dc", hero("sorcerer", 1, { scores: { cha: 16 } }), (d) => d.spellSaveDc, 13],
    ["innate_sorcery_on_adds_1_to_dc", hero("sorcerer", 1, { scores: { cha: 16 }, active: ["sorcerer:innate_sorcery"] }), (d) => d.spellSaveDc, 14],
  ];
  for (const [id, actor, read, expected] of cases) {
    it(id, () => assert.equal(read(computeDnd5eSheetDerived(actor)), expected));
  }

  it("caller_effects_still_apply_alongside_feature_effects", () => {
    const effect = {
      id: "00000000-0000-4000-8000-0000000000aa",
      source_name: "Longstrider",
      enabled: true,
      duration_rounds_remaining: null,
      concentration_caster_id: null,
      modifiers: [{ target: "speed", phase: "ADD", value: 10 }],
    };
    assert.equal(computeDnd5eSheetDerived(hero("monk", 2), [effect]).speed, 50);
  });
});

describe("Feature rules: attacks, crits, roll rules, resistances", () => {
  const cases: [string, Dnd5eActorData, number, number][] = [
    ["fighter_1_one_attack", hero("fighter", 1), 1, 20],
    ["fighter_5_extra_attack", hero("fighter", 5), 2, 20],
    ["fighter_11_two_extra_attacks", hero("fighter", 11), 3, 20],
    ["fighter_20_three_extra_attacks", hero("fighter", 20), 4, 20],
    ["champion_3_crits_on_19", hero("fighter", 3, { subclassId: "champion" }), 1, 19],
    ["champion_15_crits_on_18", hero("fighter", 15, { subclassId: "champion" }), 3, 18],
  ];
  for (const [id, actor, attacks, crit] of cases) {
    it(id, () => {
      const rules = computeDnd5eSheetDerived(actor).featureRules;
      assert.deepEqual([rules?.attacksPerAction, rules?.criticalRange], [attacks, crit]);
    });
  }

  it("rage_off_grants_nothing", () => {
    const rules = computeDnd5eSheetDerived(hero("barbarian", 1)).featureRules;
    assert.deepEqual([rules?.resistances, rules?.strMeleeDamageBonus, rules?.rolls.length], [[], 0, 0]);
  });

  it("rage_on_grants_resistances_damage_and_str_advantage", () => {
    const rules = computeDnd5eSheetDerived(hero("barbarian", 1, { active: ["barbarian:rage"] })).featureRules;
    assert.deepEqual(rules?.resistances, ["bludgeoning", "piercing", "slashing"]);
    assert.equal(rules?.strMeleeDamageBonus, 2);
    assert.ok(rules?.rolls.some((r) => r.kind === "advantage" && r.on.roll === "save" && r.on.ability === "str"));
  });

  it("rage_damage_reaches_str_melee_weapon_attacks", () => {
    const attack = computeDnd5eSheetDerived(
      hero("barbarian", 1, { scores: { str: 16 }, active: ["barbarian:rage"], items: [equipped("greataxe", "Greataxe")] })
    ).attacks?.[0];
    assert.equal(attack?.damageModifier, 5);
  });

  it("sacred_weapon_adds_cha_to_weapon_attacks", () => {
    const base = { scores: { str: 16, cha: 16 }, subclassId: "devotion", items: [equipped("longsword", "Longsword")] };
    const off = computeDnd5eSheetDerived(hero("paladin", 3, base)).attacks?.[0].attackBonus ?? 0;
    const on = computeDnd5eSheetDerived(hero("paladin", 3, { ...base, active: ["devotion:sacred_weapon"] })).attacks?.[0].attackBonus;
    assert.equal(on, off + 3);
  });

  it("champion_weapon_attacks_carry_critical_range", () => {
    const attack = computeDnd5eSheetDerived(
      hero("fighter", 3, { subclassId: "champion", items: [equipped("longsword", "Longsword")] })
    ).attacks?.[0];
    assert.equal(attack?.criticalRange, 19);
  });

  it("reliable_talent_sets_minimum_d20_on_checks", () => {
    const rules = computeDnd5eSheetDerived(hero("rogue", 7)).featureRules;
    assert.ok(rules?.rolls.some((r) => r.kind === "minimum_d20" && r.value === 10 && r.featureId === "rogue:reliable_talent"));
  });
});

describe("Rests recover class feature pools", () => {
  function spent(actor: Dnd5eActorData, values: Record<string, number>): Dnd5eActorData {
    const derived = computeDnd5eSheetDerived(actor).resourcePools ?? [];
    actor.resources = Object.fromEntries(
      derived.map((p) => [p.id, { current: values[p.id] ?? p.max, max: p.max, resetOn: p.resetOn }])
    );
    return actor;
  }

  const shortRest: [string, Dnd5eActorData, string, number][] = [
    ["short_rest_refills_action_surge", spent(hero("fighter", 2), { fighter_action_surge: 0 }), "fighter_action_surge", 1],
    ["short_rest_refills_focus_points", spent(hero("monk", 5), { monk_focus_points: 0 }), "monk_focus_points", 5],
    ["short_rest_regains_one_rage", spent(hero("barbarian", 3), { barbarian_rage: 0 }), "barbarian_rage", 1],
    ["short_rest_regains_one_second_wind", spent(hero("fighter", 4), { fighter_second_wind: 1 }), "fighter_second_wind", 2],
    ["short_rest_keeps_lay_on_hands_spent", spent(hero("paladin", 2), { paladin_lay_on_hands: 3 }), "paladin_lay_on_hands", 3],
    ["short_rest_keeps_sorcery_points_spent", spent(hero("sorcerer", 4), { sorcerer_sorcery_points: 1 }), "sorcerer_sorcery_points", 1],
  ];
  for (const [id, actor, poolId, expected] of shortRest) {
    it(id, () => assert.equal(applyShortRest(actor).resources?.[poolId]?.current, expected));
  }

  const longRest: [string, Dnd5eActorData, string, number][] = [
    ["long_rest_refills_rage", spent(hero("barbarian", 3), { barbarian_rage: 0 }), "barbarian_rage", 3],
    ["long_rest_refills_lay_on_hands", spent(hero("paladin", 2), { paladin_lay_on_hands: 3 }), "paladin_lay_on_hands", 10],
    ["long_rest_refills_divine_intervention", spent(hero("cleric", 10), { cleric_divine_intervention: 0 }), "cleric_divine_intervention", 1],
  ];
  for (const [id, actor, poolId, expected] of longRest) {
    it(id, () => assert.equal(applyLongRest(actor).resources?.[poolId]?.current, expected));
  }

  it("rest_after_level_up_writes_the_new_maximum_and_cadence", () => {
    const actor = spent(hero("bard", 4, { scores: { cha: 16 } }), { bard_bardic_inspiration: 0 });
    actor.attributes.level = 5;
    assert.deepEqual(applyShortRest(actor).resources?.bard_bardic_inspiration, { current: 3, max: 3, resetOn: "SHORT_REST" });
  });

  it("rest_without_class_features_keeps_resources", () => {
    const actor = createDefaultActorData("plain", "Plain");
    actor.resources = { custom: { current: 0, max: 2, resetOn: "LONG_REST" } };
    assert.deepEqual(applyShortRest(actor).resources, { custom: { current: 0, max: 2, resetOn: "LONG_REST" } });
  });
});

describe("classFeaturesFor filters by class, level and subclass", () => {
  const cases: [string, Dnd5eActorData, string, boolean][] = [
    ["level_gate_excludes_future_features", hero("rogue", 6), "rogue:reliable_talent", false],
    ["level_gate_includes_reached_features", hero("rogue", 7), "rogue:reliable_talent", true],
    ["bare_subclass_id_is_normalised", hero("rogue", 3, { subclassId: "thief" }), "thief:fast_hands", true],
    ["other_subclass_features_are_excluded", hero("rogue", 3, { subclassId: "thief" }), "champion:improved_critical", false],
  ];
  for (const [id, actor, featureId, present] of cases) {
    it(id, () => assert.equal(classFeaturesFor(actor).some((spec) => spec.id === featureId), present));
  }
});
