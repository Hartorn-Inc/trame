import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  applyBackground,
  applyFeatChoices,
  applyLevelUp,
  concentrationCheckDc,
  createDefaultActorData,
  getFeatChoices,
  getLevelUpFeatOptions,
  getOriginFeatChoices,
  getSpellsByLevel,
  resolveActionPipeline,
  resolveDamagePipeline,
  validateSelections,
  type ActionDefinition,
  type BuilderSelections,
  type Dnd5eActorData,
  type Dnd5eActorSheet,
  type SrdClassId,
} from "../src/index.ts";

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

function classActor(classId: SrdClassId, level: number): Dnd5eActorData {
  let actor = createDefaultActorData(`hero-${classId}`, classId);
  actor.classId = classId;
  while (actor.attributes.level < level) {
    const next = actor.attributes.level + 1;
    actor = applyLevelUp(actor, { targetLevel: next, subclassId: next === 3 ? "srd:subclass:test" : undefined });
  }
  return actor;
}

describe("GS2: critical hits double dice, never modifiers", () => {
  // Attacker: level 5 INT 16 -> spell attack +6. Target AC 10.
  const cases: [string, number, number, number, number][] = [
    ["crit_doubles_dice_not_modifier", 20, 9, 4, 22],
    ["normal_hit_adds_modifier_once", 15, 9, 4, 13],
    ["crit_without_modifier_doubles_dice", 20, 9, 0, 18],
    ["negative_modifier_never_heals", 15, 1, -3, 0],
  ];
  for (const [id, d20, dice, modifier, expected] of cases) {
    it(id, () => {
      const action: ActionDefinition = {
        id: "longsword",
        name: "Longsword",
        resolutionKind: "attack_roll",
        baseDamage: dice,
        damageModifier: modifier,
      };
      const [outcome] = resolveActionPipeline(sheet(), action, [{ target: sheet({ id: "t" }), attackD20Roll: d20 }]);
      assert.equal(outcome.damageApplied, expected);
    });
  }
});

describe("GS3: an action's own attack bonus and save DC win", () => {
  // Actor spell attack +6 and spell save DC 14 (level 5, INT 16).
  const cases: [string, Partial<ActionDefinition>, number, boolean][] = [
    ["action_attack_bonus_overrides_spell_attack", { resolutionKind: "attack_roll", attackBonus: 0 }, 13, false],
    ["spell_attack_used_without_action_bonus", { resolutionKind: "attack_roll" }, 13, true],
    ["action_dc_overrides_spell_dc", { resolutionKind: "saving_throw", saveDc: 20 }, 15, true],
    ["spell_dc_used_without_action_dc", { resolutionKind: "saving_throw" }, 15, false],
  ];
  for (const [id, overrides, d20, expectedHit] of cases) {
    it(id, () => {
      const action: ActionDefinition = { id: "a", name: "A", resolutionKind: "attack_roll", baseDamage: 5, ...overrides };
      const target = sheet({ id: "t", armorBaseAc: 18, armorKind: "heavy" });
      const [outcome] = resolveActionPipeline(sheet(), action, [{ target, attackD20Roll: d20, saveD20Roll: d20 }]);
      assert.equal(outcome.hitOrFailedSave, expectedHit);
    });
  }
});

describe("GS4: concentration DC is max(10, floor(damage / 2)) capped at 30", () => {
  const cases: [string, number, number][] = [
    ["concentration_dc_floor_10", 5, 10],
    ["concentration_dc_half_damage", 31, 15],
    ["concentration_dc_exactly_30", 60, 30],
    ["concentration_dc_capped_at_30", 90, 30],
  ];
  for (const [id, damage, expected] of cases) {
    it(id, () => {
      assert.equal(concentrationCheckDc(damage), expected);
      const actor = createDefaultActorData("caster", "Caster");
      actor.attributes.hp = { current: 200, max: 200, temp: 0 };
      actor.concentratingOnSpellId = "srd:spell:bless";
      const result = resolveDamagePipeline(actor, [{ amount: damage, type: "fire" }]);
      assert.equal(result.concentrationPrompt?.dc, expected);
    });
  }
});

describe("GS10: Fighting Style feats at feat slots", () => {
  const cases: [string, SrdClassId, number, boolean][] = [
    ["fighter_level_4_offered_fighting_style_feats", "fighter", 3, true],
    ["paladin_level_4_offered_fighting_style_feats", "paladin", 3, true],
    ["wizard_level_4_not_offered_fighting_style_feats", "wizard", 3, false],
  ];
  for (const [id, classId, level, expected] of cases) {
    it(id, () => {
      const options = getLevelUpFeatOptions(classActor(classId, level));
      assert.equal(options.includes("archery"), expected);
      assert.ok(options.includes("alert"));
      assert.ok(!options.includes("ability_score_improvement"));
    });
  }

  it("no_feat_options_off_asi_level", () => {
    assert.deepEqual(getLevelUpFeatOptions(classActor("fighter", 1)), []);
  });

  it("fighter_takes_archery_at_level_4", () => {
    const actor = applyLevelUp(classActor("fighter", 3), {
      targetLevel: 4,
      asiOrFeat: { mode: "feat", featId: "srd:feat:archery" },
    });
    assert.ok(actor.features?.includes("srd:feat:archery"));
  });
});

describe("GS10: Magic Initiate and Skilled choice descriptors", () => {
  it("magic_initiate_lists_its_four_choices", () => {
    const choices = getFeatChoices("srd:feat:magic_initiate");
    assert.deepEqual(
      choices.map((c) => [c.id, c.kind, c.count]),
      [
        ["spell_list", "spell_list", 1],
        ["spellcasting_ability", "ability", 1],
        ["cantrips", "spell", 2],
        ["level_1_spell", "spell", 1],
      ]
    );
    assert.deepEqual(choices[2].options, [], "spells wait for the spell list");
  });

  it("magic_initiate_spells_follow_selected_list", () => {
    const choices = getFeatChoices("magic_initiate", { selections: { spell_list: ["wizard"] } });
    const cantripIds = getSpellsByLevel(0, "wizard").map((s) => s.id);
    assert.deepEqual(choices[2].options.map((o) => o.id), cantripIds);
    assert.ok(cantripIds.length >= 2);
  });

  it("acolyte_magic_initiate_fixed_to_cleric_list", () => {
    const [list] = getOriginFeatChoices("acolyte");
    assert.deepEqual(list.options.map((o) => o.id), ["cleric"]);
  });

  it("skilled_offers_skills_and_tools", () => {
    const [choice] = getFeatChoices("srd:feat:skilled");
    assert.equal(choice.count, 3);
    assert.ok(choice.options.some((o) => o.id === "stealth"));
    assert.ok(choice.options.some((o) => o.id === "tool:Thieves' Tools"));
  });

  it("feat_without_choices_returns_empty", () => {
    assert.deepEqual(getFeatChoices("srd:feat:alert"), []);
  });

  const invalid: [string, BuilderSelections][] = [
    ["too_few_picks", { proficiencies: ["stealth", "arcana"] }],
    ["duplicate_pick", { proficiencies: ["stealth", "stealth", "arcana"] }],
    ["unknown_pick", { proficiencies: ["stealth", "arcana", "tool:Laser"] }],
  ];
  for (const [id, selections] of invalid) {
    it(`skilled_rejects_${id}`, () => {
      assert.throws(() => validateSelections(getFeatChoices("skilled"), selections), /Invalid selection for proficiencies/);
    });
  }

  it("skilled_grants_skills_and_tool_proficiency", () => {
    const actor = applyBackground(createDefaultActorData("guide", "Guide"), "caravan_guide", { mode: "plus1_each" });
    const result = applyFeatChoices(actor, "srd:feat:skilled", { proficiencies: ["stealth", "arcana", "tool:Thieves' Tools"] });
    assert.equal(result.skills.stealth.proficiencyRank, 1);
    assert.equal(result.skills.arcana.proficiencyRank, 1);
    assert.ok(result.proficiencies?.tools.includes("Thieves' Tools"));
    assert.equal(result.featChoices?.length, 1);
  });

  it("skilled_does_not_offer_background_skills", () => {
    const actor = applyBackground(createDefaultActorData("guide", "Guide"), "caravan_guide", { mode: "plus1_each" });
    const [choice] = getFeatChoices("skilled", { actor });
    assert.ok(!choice.options.some((o) => o.id === "survival"));
  });

  it("sage_magic_initiate_records_wizard_spells", () => {
    const actor = applyBackground(createDefaultActorData("sage", "Sage"), "sage", { mode: "plus1_each" });
    const [cantripA, cantripB] = getSpellsByLevel(0, "wizard").map((s) => s.id);
    const [spell] = getSpellsByLevel(1, "wizard").map((s) => s.id);
    const result = applyFeatChoices(
      actor,
      "srd:feat:magic_initiate",
      { spell_list: ["wizard"], spellcasting_ability: ["int"], cantrips: [cantripA, cantripB], level_1_spell: [spell] },
      { fixedSpellList: "wizard" }
    );
    assert.deepEqual(result.featChoices?.[0].selections.cantrips, [cantripA, cantripB]);
  });

  it("feat_choices_require_the_feat", () => {
    assert.throws(
      () => applyFeatChoices(createDefaultActorData("x", "X"), "skilled", { proficiencies: ["stealth", "arcana", "history"] }),
      /Feat not held/
    );
  });
});
