import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  applyBackground,
  applyClassChoices,
  applyFeatChoices,
  applyLevelUp,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  getClassChoices,
  getSpellsByLevel,
  startingEquipmentItems,
  type AbilityId,
  type ActorItem,
  type BuilderChoice,
  type BuilderSelections,
  type DerivedAttack,
  type Dnd5eActorData,
  type SrdClassId,
} from "../src/index.ts";

function actorWith(classId: string, scores: Partial<Record<AbilityId, number>>, items: ActorItem[] = []): Dnd5eActorData {
  const actor = createDefaultActorData(`hero-${classId}`, classId);
  actor.classId = classId;
  for (const [ab, score] of Object.entries(scores) as [AbilityId, number][]) actor.abilities[ab].score = score;
  actor.items = items;
  return actor;
}

function equipped(compendiumKey: string, name = compendiumKey): ActorItem {
  return { id: `i-${compendiumKey}`, name, quantity: 1, compendiumId: `srd:item:${compendiumKey}`, equipped: true };
}

/** Picks the first `count` options of every choice, `overrides` taking precedence. */
function firstPicks(choices: BuilderChoice[], overrides: BuilderSelections = {}): BuilderSelections {
  return Object.fromEntries(
    choices.map((choice) => [choice.id, overrides[choice.id] ?? choice.options.slice(0, choice.count).map((o) => o.id)])
  );
}

function createdCharacter(classId: SrdClassId, overrides: BuilderSelections = {}): Dnd5eActorData {
  const actor = createDefaultActorData(`new-${classId}`, classId);
  return applyClassChoices(actor, classId, firstPicks(getClassChoices(classId, { actor }), overrides));
}

describe("GS12: equipped armor and shield feed AC (best wins)", () => {
  const cases: [string, string, Partial<Record<AbilityId, number>>, ActorItem[], number][] = [
    ["fighter_chain_mail_shield_ac_18", "fighter", { dex: 14 }, [equipped("chain_mail"), equipped("shield")], 18],
    ["light_armor_adds_full_dex", "rogue", { dex: 16 }, [equipped("leather_armor")], 14],
    ["medium_armor_caps_dex_at_2", "fighter", { dex: 18 }, [equipped("scale_mail")], 16],
    ["monk_unarmored_defense_wins", "monk", { dex: 14, wis: 16 }, [], 15],
    ["barbarian_unarmored_defense_keeps_shield", "barbarian", { dex: 14, con: 16 }, [equipped("shield")], 17],
    ["armor_beats_weaker_unarmored_defense", "barbarian", { dex: 10, con: 12 }, [equipped("chain_mail")], 16],
    ["unequipped_armor_is_ignored", "fighter", { dex: 12 }, [{ ...equipped("plate_armor"), equipped: false }], 11],
  ];
  for (const [id, classId, scores, items, expected] of cases) {
    it(id, () => {
      assert.equal(computeDnd5eSheetDerived(actorWith(classId, scores, items)).armorClass, expected);
    });
  }
});

describe("GS6: weapon attacks", () => {
  type Expected = Partial<DerivedAttack>;
  const cases: [string, string, Partial<Record<AbilityId, number>>, ActorItem, Expected][] = [
    [
      "longsword_uses_str_and_proficiency",
      "fighter",
      { str: 16 },
      equipped("longsword", "Longsword"),
      { delivery: "melee", attackBonus: 5, damageDice: "1d8", damageModifier: 3, versatileDamageDice: "1d10", reachFt: 5, proficient: true },
    ],
    [
      "rapier_finesse_uses_better_dex",
      "rogue",
      { str: 10, dex: 16 },
      equipped("rapier", "Rapier"),
      { delivery: "melee", attackBonus: 5, damageModifier: 3, proficient: true },
    ],
    ["glaive_reach_10_ft", "fighter", { str: 14 }, equipped("glaive", "Glaive"), { reachFt: 10, properties: ["heavy", "reach", "two-handed"] }],
    [
      "longbow_ranged_uses_dex_and_range",
      "fighter",
      { dex: 14 },
      equipped("longbow", "Longbow"),
      { delivery: "ranged", attackBonus: 4, rangeFt: { normal: 150, long: 600 }, damageType: "piercing" },
    ],
    ["monk_proficient_with_light_martial_shortsword", "monk", { dex: 14 }, equipped("shortsword", "Shortsword"), { attackBonus: 4, proficient: true }],
    ["monk_not_proficient_with_longsword", "monk", { str: 14 }, equipped("longsword", "Longsword"), { attackBonus: 2, proficient: false }],
    ["dagger_thrown_keeps_melee_reach_and_range", "wizard", { dex: 12 }, equipped("dagger", "Dagger"), { reachFt: 5, rangeFt: { normal: 20, long: 60 } }],
  ];
  for (const [id, classId, scores, item, expected] of cases) {
    it(id, () => {
      const [attack] = computeDnd5eSheetDerived(actorWith(classId, scores, [item])).attacks ?? [];
      assert.ok(attack);
      assert.equal(attack.source, "weapon");
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(attack[key as keyof DerivedAttack], value, key);
      }
    });
  }

  it("exhaustion_lowers_weapon_attack_bonus", () => {
    const actor = actorWith("fighter", { str: 16 }, [equipped("longsword")]);
    actor.attributes.exhaustion = 2;
    assert.equal(computeDnd5eSheetDerived(actor).attacks?.[0].attackBonus, 1);
  });

  it("weapon_named_in_inventory_without_compendium_id", () => {
    const actor = actorWith("rogue", { dex: 14 }, [{ id: "x", name: "2 Daggers", quantity: 1, equipped: true }]);
    assert.equal(computeDnd5eSheetDerived(actor).attacks?.[0].damageDice, "1d4");
  });
});

describe("GS5: level-1 casters get slots, Pact Magic, cantrips and spells", () => {
  const cases: [string, SrdClassId, { level: number; max: number }[], number | null, number, number][] = [
    ["wizard_level_1_has_two_slots_and_cantrips", "wizard", [{ level: 1, max: 2 }], null, 3, 4],
    ["cleric_level_1_has_two_slots_and_three_cantrips", "cleric", [{ level: 1, max: 2 }], null, 3, 4],
    ["paladin_level_1_has_two_slots_no_cantrips", "paladin", [{ level: 1, max: 2 }], null, 0, 2],
    ["warlock_level_1_pact_magic", "warlock", [], 1, 2, 2],
    ["sorcerer_level_1_four_cantrips", "sorcerer", [{ level: 1, max: 2 }], null, 4, 2],
  ];
  for (const [id, classId, slots, pactSlots, cantrips, prepared] of cases) {
    it(id, () => {
      const spells = computeDnd5eSheetDerived(createdCharacter(classId)).spells;
      assert.ok(spells);
      assert.deepEqual(spells.slots.map(({ level, max }) => ({ level, max })), slots);
      assert.equal(spells.pactMagic?.slots ?? null, pactSlots);
      if (pactSlots !== null) assert.equal(spells.pactMagic?.slotLevel, 1);
      assert.equal(spells.cantripsKnown, cantrips);
      assert.equal(spells.preparedSpellsMax, prepared);
      assert.ok(spells.cantrips.length <= cantrips);
      assert.ok(spells.cantrips.every((ref) => ref.level === 0));
      assert.ok(spells.prepared.every((ref) => (ref.level ?? 1) >= 1));
    });
  }

  it("wizard_level_1_slots_without_tracked_slots", () => {
    const actor = actorWith("wizard", { int: 16 });
    actor.spellSlots = {};
    const spells = computeDnd5eSheetDerived(actor).spells;
    assert.deepEqual(spells?.slots, [{ level: 1, max: 2, current: 2 }]);
    assert.equal(spells?.spellSaveDc, 13, "the class spellcasting ability applies when none is stored");
  });

  it("tracked_slot_usage_is_kept", () => {
    const actor = createdCharacter("wizard");
    actor.spellSlots = { level1: { current: 1, max: 2 } };
    assert.equal(computeDnd5eSheetDerived(actor).spells?.slots[0].current, 1);
  });

  it("fighter_has_no_spellcasting", () => {
    assert.equal(computeDnd5eSheetDerived(createdCharacter("fighter")).spells, undefined);
  });

  it("level_up_spell_ids_join_the_prepared_list", () => {
    const actor = createdCharacter("wizard");
    const [newSpell] = getSpellsByLevel(1, "wizard").map((s) => s.id).filter((id) => !actor.spellIds?.includes(id));
    assert.ok(newSpell, "the catalog needs a 7th level-1 wizard spell");
    const leveled = applyLevelUp(actor, { targetLevel: 2, newSpellIds: [newSpell] });
    const spells = computeDnd5eSheetDerived(leveled).spells;
    assert.ok(spells?.prepared.some((ref) => ref.id === newSpell));
    assert.deepEqual(spells?.slots.map((s) => s.max), [3]);
  });
});

describe("GS6: spell attacks", () => {
  it("cantrip_attack_scales_with_level_and_uses_spell_attack", () => {
    const actor = actorWith("wizard", { int: 16 });
    actor.attributes.level = 5;
    actor.attributes.spellcastingAbility = "int";
    actor.spellIds = ["srd:spell:fire_bolt"];
    const derived = computeDnd5eSheetDerived(actor);
    const attack = derived.attacks?.find((a) => a.id === "srd:spell:fire_bolt");
    assert.deepEqual(
      [attack?.delivery, attack?.damageDice, attack?.attackBonus, attack?.rangeFt],
      ["ranged", "2d10", derived.spellAttackBonus, { normal: 120 }]
    );
  });

  it("save_spell_attack_reports_dc", () => {
    const actor = actorWith("cleric", { wis: 16 });
    actor.attributes.spellcastingAbility = "wis";
    actor.spellIds = ["srd:spell:sacred_flame"];
    const attack = computeDnd5eSheetDerived(actor).attacks?.find((a) => a.id === "srd:spell:sacred_flame");
    assert.deepEqual([attack?.delivery, attack?.attackBonus, attack?.save], ["save", null, { ability: "dex", dc: 13 }]);
  });

  it("magic_initiate_spells_use_the_feat_ability", () => {
    const sage = applyBackground(actorWith("fighter", { int: 14, wis: 8 }), "sage", { mode: "plus1_each" });
    const cantrips = getSpellsByLevel(0, "wizard").map((s) => s.id);
    const firstBolt = cantrips.includes("srd:spell:fire_bolt") ? "srd:spell:fire_bolt" : cantrips[0];
    const other = cantrips.find((id) => id !== firstBolt)!;
    const [spell] = getSpellsByLevel(1, "wizard").map((s) => s.id);
    const actor = applyFeatChoices(
      sage,
      "srd:feat:magic_initiate",
      { spell_list: ["wizard"], spellcasting_ability: ["int"], cantrips: [firstBolt, other], level_1_spell: [spell] },
      { fixedSpellList: "wizard" }
    );
    const spells = computeDnd5eSheetDerived(actor).spells;
    // INT 15 after the Sage +1: modifier +2, level 1 proficiency +2.
    assert.deepEqual(
      [spells?.featSpells[0].ability, spells?.featSpells[0].spellSaveDc, spells?.featSpells[0].spellAttackBonus],
      ["int", 12, 4]
    );
    assert.equal(spells?.featSpells[0].spells.length, 3);
  });
});

describe("UA4: features with level", () => {
  it("class_subclass_species_background_and_feat_features", () => {
    let actor = createDefaultActorData("feat-hero", "Feat Hero");
    actor.classId = "fighter";
    actor.speciesId = "srd:species:dwarf";
    actor.abilities.str.score = 15;
    actor = applyBackground(actor, "soldier", { mode: "plus1_each" });
    for (let level = 2; level <= 4; level += 1) {
      actor = applyLevelUp(actor, {
        targetLevel: level,
        subclassId: level === 3 ? "srd:subclass:champion" : undefined,
        asiOrFeat: level === 4 ? { mode: "feat", featId: "srd:feat:grappler", abilityIncrease: "str" } : undefined,
      });
    }
    const features = computeDnd5eSheetDerived(actor).features ?? [];
    const find = (name: string) => features.find((f) => f.name === name);
    assert.deepEqual([find("Fighting Style")?.source, find("Fighting Style")?.level], ["class", 1]);
    assert.equal(find("Action Surge")?.level, 2);
    assert.deepEqual([features.find((f) => f.source === "subclass")?.level], [3]);
    assert.deepEqual([find("Stonecunning")?.source, find("Stonecunning")?.level], ["species", 1]);
    assert.equal(features.find((f) => f.source === "background")?.id, "srd:background:soldier");
    assert.equal(features.find((f) => f.id === "srd:feat:savage_attacker")?.level, 1);
    assert.equal(features.find((f) => f.id === "srd:feat:grappler")?.level, 4);
    assert.ok(!features.some((f) => f.source === "class" && f.level! > 4));
  });
});

describe("GS12 / UA13: class builder choices", () => {
  const countCases: [string, SrdClassId, string, number][] = [
    ["rogue_picks_four_skills", "rogue", "skills", 4],
    ["ranger_picks_three_skills", "ranger", "skills", 3],
    ["bard_picks_three_instruments", "bard", "tools", 3],
    ["monk_picks_one_tool", "monk", "tools", 1],
    ["fighter_has_three_equipment_options", "fighter", "equipment", 1],
  ];
  for (const [id, classId, choiceId, count] of countCases) {
    it(id, () => {
      const choice = getClassChoices(classId).find((c) => c.id === choiceId);
      assert.equal(choice?.count, count);
    });
  }

  it("fighter_equipment_options_are_a_b_c", () => {
    const equipment = getClassChoices("fighter").find((c) => c.id === "equipment");
    assert.deepEqual(equipment?.options.map((o) => o.id), ["A", "B", "C"]);
    assert.match(equipment?.options[0].label ?? "", /^Chain Mail, Greatsword, Flail, 8 Javelins/);
  });

  it("non_casters_have_no_spell_choices", () => {
    assert.ok(!getClassChoices("barbarian").some((c) => c.kind === "spell"));
  });

  it("fighter_option_a_equips_chain_mail_and_weapons", () => {
    const actor = createdCharacter("fighter", { equipment: ["A"] });
    const derived = computeDnd5eSheetDerived(actor);
    assert.equal(derived.armorClass, 16);
    assert.ok(derived.attacks?.some((a) => a.name === "Greatsword" && a.proficient));
    assert.ok(actor.proficiencies?.armor.includes("heavy"));
    assert.ok(actor.items?.some((item) => item.name === "4 GP"));
  });

  it("javelins_keep_their_quantity", () => {
    const javelins = startingEquipmentItems("fighter", "A").find((item) => item.compendiumId === "srd:item:javelin");
    assert.equal(javelins?.quantity, 8);
  });

  it("rogue_gets_thieves_tools_and_chosen_skills", () => {
    const actor = createdCharacter("rogue", { skills: ["stealth", "acrobatics", "deception", "insight"] });
    assert.ok(actor.proficiencies?.tools.includes("Thieves' Tools"));
    assert.equal(actor.skills.stealth.proficiencyRank, 1);
    assert.deepEqual(actor.proficiencies?.weapons, ["simple", "martial_finesse_or_light"]);
  });

  it("class_skill_outside_list_is_rejected", () => {
    const actor = createDefaultActorData("x", "X");
    const selections = firstPicks(getClassChoices("fighter"), { skills: ["arcana", "athletics"] });
    assert.throws(() => applyClassChoices(actor, "fighter", selections), /Invalid selection for skills/);
  });

  it("background_skills_are_not_offered_again", () => {
    const actor = applyBackground(createDefaultActorData("s", "S"), "soldier", { mode: "plus1_each" });
    const skills = getClassChoices("fighter", { actor }).find((c) => c.id === "skills");
    assert.ok(!skills?.options.some((o) => o.id === "athletics"));
  });

  it("background_tool_proficiency_is_stored", () => {
    const actor = applyBackground(createDefaultActorData("c", "C"), "criminal", { mode: "plus1_each" });
    assert.deepEqual(actor.proficiencies?.tools, ["Thieves' Tools"]);
  });

  it("unknown_class_throws", () => {
    assert.throws(() => getClassChoices("artificer"), /Unknown class/);
  });
});
