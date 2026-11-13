import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeDnd5eSheetDerived, getSpellsByLevel } from "../../../game-systems/dnd5e/src/index.ts";
import {
  BuilderDraftStore,
  CharacterBuilderWizard,
  calculatePointBuyCost,
  validateStandardArray,
  type CharacterDraft,
} from "../../src/builder/index.ts";

const STANDARD = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };

function wizardWith(draft: Partial<CharacterDraft> = {}) {
  return new CharacterBuilderWizard({ draftStore: new BuilderDraftStore(), initialDraft: draft });
}

const COMPLETE: Partial<CharacterDraft> = {
  name: "Brakka",
  speciesId: "dwarf",
  classId: "fighter",
  backgroundId: "soldier",
  backgroundChoice: { mode: "plus2_plus1", plus2: "str", plus1: "con" },
  abilityScores: { ...STANDARD },
  abilityGenerationMethod: "standardArray",
  equipmentIds: ["Spear", "Shortbow"],
  classSelections: { skills: ["acrobatics", "perception"], fighting_style: ["srd:feat:archery"], equipment: ["A"] },
};

/** Fills every Origin feat choice with its first `count` options. */
function pickFirstOriginFeatOptions(wizard: CharacterBuilderWizard): void {
  for (const choice of wizard.getOriginFeatChoices()) {
    if (wizard.getFeatSelection(choice.id).length === choice.count) continue;
    for (const option of choice.options.slice(0, choice.count)) wizard.toggleFeatOption(choice.id, option.id);
  }
}

/** Fills every class choice with its first `count` options. */
function pickFirstClassOptions(wizard: CharacterBuilderWizard): void {
  for (const choice of wizard.getClassChoices()) {
    for (const option of choice.options.slice(0, choice.count)) wizard.toggleClassOption(choice.id, option.id);
  }
}

describe("CharacterBuilderWizard: 2024 step order and gating", () => {
  it("starts on species with an empty draft and follows the SRD 5.2.1 order", () => {
    const wizard = wizardWith(COMPLETE);
    const visited = [wizard.currentStep];
    while (wizard.nextStep()) visited.push(wizard.currentStep);
    assert.deepEqual(visited, ["species", "class", "background", "abilityScores", "skills", "equipment", "spells", "review"]);
  });

  const blocked: Array<{ id: string; draft: Partial<CharacterDraft>; step: string; error: string }> = [
    { id: "unknown species blocks the species step", draft: { ...COMPLETE, speciesId: "half-elf" }, step: "species", error: "builder.error.species" },
    { id: "unknown class blocks the class step", draft: { ...COMPLETE, classId: "artificer" }, step: "class", error: "builder.error.class" },
    { id: "missing background blocks the background step", draft: { ...COMPLETE, backgroundId: null }, step: "background", error: "builder.error.background" },
    {
      id: "+2/+1 on the same ability is rejected",
      draft: { ...COMPLETE, backgroundChoice: { mode: "plus2_plus1", plus2: "str", plus1: "str" } },
      step: "background",
      error: "builder.error.backgroundChoice",
    },
    {
      id: "+2 on an ability outside the background list is rejected",
      draft: { ...COMPLETE, backgroundChoice: { mode: "plus2_plus1", plus2: "cha", plus1: "str" } },
      step: "background",
      error: "builder.error.backgroundChoice",
    },
    {
      id: "[G1-sage-missing-magic-initiate] Sage background without Magic Initiate picks blocks the background step",
      draft: { ...COMPLETE, backgroundId: "sage", backgroundChoice: { mode: "plus1_each" }, featSelections: {} },
      step: "background",
      error: "builder.error.originFeat",
    },
    {
      id: "[G1-acolyte-wrong-spell-list] Acolyte Magic Initiate rejects a spell outside the Cleric list",
      draft: {
        ...COMPLETE,
        backgroundId: "acolyte",
        backgroundChoice: { mode: "plus1_each" },
        featSelections: {
          spell_list: ["cleric"],
          spellcasting_ability: ["wis"],
          cantrips: ["srd:spell:fire_bolt", "srd:spell:mage_hand"],
          level_1_spell: ["srd:spell:magic_missile"],
        },
      },
      step: "background",
      error: "builder.error.originFeat",
    },
    {
      id: "[G1-caravan-guide-missing-skilled] Caravan Guide background without 3 Skilled picks blocks the background step",
      draft: {
        ...COMPLETE,
        backgroundId: "caravan_guide",
        backgroundChoice: { mode: "plus1_each" },
        featSelections: { proficiencies: ["stealth", "arcana"] },
      },
      step: "background",
      error: "builder.error.originFeat",
    },
    {
      id: "[G1-caravan-guide-duplicate-bg-skill] Caravan Guide Skilled rejects a skill already granted by the background",
      draft: {
        ...COMPLETE,
        backgroundId: "caravan_guide",
        backgroundChoice: { mode: "plus1_each" },
        featSelections: { proficiencies: ["survival", "stealth", "arcana"] },
      },
      step: "background",
      error: "builder.error.originFeat",
    },
    {
      id: "duplicated standard array values are rejected",
      draft: { ...COMPLETE, abilityScores: { ...STANDARD, cha: 15 } },
      step: "abilityScores",
      error: "builder.error.standardArray",
    },
    {
      id: "point buy above 27 points is rejected",
      draft: { ...COMPLETE, abilityGenerationMethod: "pointBuy", abilityScores: { str: 15, dex: 15, con: 15, int: 9, wis: 8, cha: 8 } },
      step: "abilityScores",
      error: "builder.error.pointBuy",
    },
    { id: "missing class skills block the skills step", draft: { ...COMPLETE, classSelections: { equipment: ["A"] } }, step: "skills", error: "builder.error.skills" },
    {
      id: "a skill outside the class list is rejected",
      draft: { ...COMPLETE, classSelections: { skills: ["acrobatics", "arcana"], equipment: ["A"] } },
      step: "skills",
      error: "builder.error.skills",
    },
    {
      id: "a skill the background already grants is not offered",
      draft: { ...COMPLETE, classSelections: { skills: ["acrobatics", "athletics"], equipment: ["A"] } },
      step: "skills",
      error: "builder.error.skills",
    },
    {
      id: "a missing Fighting Style feat blocks a Fighter's skills step",
      draft: { ...COMPLETE, classSelections: { skills: ["acrobatics", "perception"], equipment: ["A"] } },
      step: "skills",
      error: "builder.error.fightingStyle",
    },
    {
      id: "a general feat is not a Fighting Style pick",
      draft: { ...COMPLETE, classSelections: { skills: ["acrobatics", "perception"], fighting_style: ["srd:feat:alert"], equipment: ["A"] } },
      step: "skills",
      error: "builder.error.fightingStyle",
    },
    { id: "empty equipment blocks the equipment step", draft: { ...COMPLETE, equipmentIds: [] }, step: "equipment", error: "builder.error.equipment" },
    {
      id: "a missing class equipment option blocks the equipment step",
      draft: { ...COMPLETE, classSelections: { skills: ["acrobatics", "perception"], fighting_style: ["srd:feat:archery"] } },
      step: "equipment",
      error: "builder.error.classEquipment",
    },
    {
      id: "a Wizard without spells is blocked on the spells step",
      draft: { ...COMPLETE, classId: "wizard", classSelections: { skills: ["insight", "medicine"], equipment: ["A"] } },
      step: "spells",
      error: "builder.error.spells",
    },
    { id: "a blank name blocks the review", draft: { ...COMPLETE, name: "  " }, step: "review", error: "builder.error.name" },
  ];

  for (const c of blocked) {
    it(c.id, () => {
      const wizard = wizardWith(c.draft);
      while (wizard.currentStep !== c.step && wizard.nextStep());
      assert.equal(wizard.currentStep, c.step);
      assert.ok(wizard.validateStep(c.step as never).errors.includes(c.error));
      assert.equal(wizard.confirm(), null);
    });
  }

  it("forward jumps require every earlier step to validate; backward moves are free", () => {
    const wizard = wizardWith({ ...COMPLETE, classId: null });
    assert.equal(wizard.goToStep("review"), false);
    assert.equal(wizard.goToStep("class"), true);
    assert.equal(wizard.previousStep(), true);
    assert.equal(wizard.currentStep, "species");
  });

  it("changing the background resets the split to +1/+1/+1, feat picks, and class skills", () => {
    const wizard = wizardWith({
      ...COMPLETE,
      backgroundId: "caravan_guide",
      backgroundChoice: { mode: "plus1_each" },
      featSelections: { proficiencies: ["stealth", "arcana", "history"] },
    });
    wizard.setBackground("sage");
    assert.deepEqual(wizard.getDraft()?.backgroundChoice, { mode: "plus1_each" });
    assert.deepEqual(wizard.getDraft()?.featSelections, {});
    assert.deepEqual(wizard.getDraft()?.classSelections, { fighting_style: ["srd:feat:archery"], equipment: ["A"] });
  });

  it("changing the class clears every class pick", () => {
    const wizard = wizardWith(COMPLETE);
    wizard.setClass("rogue");
    assert.deepEqual(wizard.getDraft()?.classSelections, {});
  });

  const toggles: Array<{ id: string; choice: string; clicks: string[]; picked: string[] }> = [
    { id: "multi-pick choices stop at their count", choice: "skills", clicks: ["acrobatics", "perception", "history"], picked: ["acrobatics", "perception"] },
    { id: "picking an option again removes it", choice: "skills", clicks: ["acrobatics", "perception", "acrobatics", "history"], picked: ["perception", "history"] },
    { id: "a single-pick choice replaces its pick", choice: "equipment", clicks: ["A", "B"], picked: ["B"] },
  ];
  for (const c of toggles) {
    it(`toggleClassOption: ${c.id}`, () => {
      const wizard = wizardWith({ ...COMPLETE, classSelections: {} });
      for (const option of c.clicks) wizard.toggleClassOption(c.choice, option);
      assert.deepEqual(wizard.getClassSelection(c.choice), c.picked);
    });
  }

  const offered: Array<{ id: string; draft: Partial<CharacterDraft>; step: "skills" | "spells"; choices: string[] }> = [
    { id: "a Fighter picks skills and a Fighting Style feat on the skills step", draft: COMPLETE, step: "skills", choices: ["skills", "fighting_style"] },
    { id: "a Paladin has no Fighting Style feat at level 1", draft: { ...COMPLETE, classId: "paladin" }, step: "skills", choices: ["skills"] },
    { id: "a Bard also picks tools on the skills step", draft: { ...COMPLETE, classId: "bard" }, step: "skills", choices: ["skills", "tools"] },
    { id: "a Fighter has no spell picks", draft: COMPLETE, step: "spells", choices: [] },
    { id: "a Wizard picks cantrips and spellbook spells", draft: { ...COMPLETE, classId: "wizard" }, step: "spells", choices: ["cantrips", "spells"] },
  ];
  for (const c of offered) {
    it(c.id, () => {
      const wizard = wizardWith(c.draft);
      assert.deepEqual(wizard.choicesForStep(c.step).map((choice) => choice.id), c.choices);
    });
  }
});

describe("CharacterBuilderWizard: finalized level-1 actor", () => {
  const cases: Array<{
    id: string;
    draft: Partial<CharacterDraft>;
    scores: Record<string, number>;
    hp: number;
    speedFt: number;
    feat: string;
    skills: string[];
    saves: string[];
  }> = [
    {
      id: "dwarf soldier fighter: species adds no score, background +2 STR / +1 CON, Dwarven Toughness HP",
      draft: COMPLETE,
      scores: { str: 17, dex: 14, con: 14, int: 12, wis: 10, cha: 8 },
      hp: 10 + 2 + 1,
      speedFt: 30,
      feat: "srd:feat:savage_attacker",
      skills: ["athletics", "intimidation"],
      saves: ["str", "con"],
    },
    {
      id: "elf sage wizard with +1/+1/+1: CON delta raises HP, Magic Initiate origin feat",
      draft: { ...COMPLETE, speciesId: "elf", classId: "wizard", backgroundId: "sage", backgroundChoice: { mode: "plus1_each" }, classSelections: {} },
      scores: { str: 15, dex: 14, con: 14, int: 13, wis: 11, cha: 8 },
      hp: 6 + 2,
      speedFt: 30,
      feat: "srd:feat:magic_initiate",
      skills: ["arcana", "history"],
      saves: ["int", "wis"],
    },
    {
      id: "dwarf artisan fighter (+2 STR / +1 CON) and Skilled origin feat",
      draft: {
        ...COMPLETE,
        speciesId: "dwarf",
        classId: "fighter",
        backgroundId: "artisan",
        backgroundChoice: { mode: "plus2_plus1", plus2: "str", plus1: "con" },
        classSelections: { skills: ["athletics", "perception"], fighting_style: ["srd:feat:archery"], equipment: ["A"] },
      },
      scores: { str: 17, dex: 14, con: 14, int: 12, wis: 10, cha: 8 },
      hp: 10 + 2 + 1,
      speedFt: 30,
      feat: "srd:feat:skilled",
      skills: ["investigation", "persuasion"],
      saves: ["str", "con"],
    },
    {
      id: "gnome artisan wizard (+2 INT / +1 CON) hits 17 INT / 14 CON",
      draft: {
        ...COMPLETE,
        speciesId: "gnome",
        classId: "wizard",
        backgroundId: "artisan",
        backgroundChoice: { mode: "plus2_plus1", plus2: "int", plus1: "con" },
        abilityScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
        classSelections: {},
      },
      scores: { str: 8, dex: 14, con: 14, int: 17, wis: 12, cha: 10 },
      hp: 6 + 2,
      speedFt: 30,
      feat: "srd:feat:skilled",
      skills: ["investigation", "persuasion"],
      saves: ["int", "wis"],
    },
    {
      id: "half_elf merchant sorcerer (+2 CHA / +1 CON): species adds no score, Skilled origin feat",
      draft: {
        ...COMPLETE,
        speciesId: "half_elf",
        classId: "sorcerer",
        backgroundId: "merchant",
        backgroundChoice: { mode: "plus2_plus1", plus2: "cha", plus1: "con" },
        abilityScores: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 },
        classSelections: {},
      },
      scores: { str: 8, dex: 14, con: 14, int: 12, wis: 10, cha: 17 },
      hp: 6 + 2,
      speedFt: 30,
      feat: "srd:feat:skilled",
      skills: ["persuasion", "insight"],
      saves: ["con", "cha"],
    },
    {
      id: "radiant_scion house_guardian paladin (+2 STR / +1 CHA): Alert origin feat",
      draft: {
        ...COMPLETE,
        speciesId: "radiant_scion",
        classId: "paladin",
        backgroundId: "house_guardian",
        backgroundChoice: { mode: "plus2_plus1", plus2: "str", plus1: "cha" },
        abilityScores: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
        classSelections: {},
      },
      scores: { str: 17, dex: 10, con: 14, int: 8, wis: 12, cha: 14 },
      hp: 10 + 2,
      speedFt: 30,
      feat: "srd:feat:alert",
      skills: ["athletics", "medicine"],
      saves: ["wis", "cha"],
    },
  ];

  for (const c of cases) {
    it(c.id, () => {
      const wizard = wizardWith(c.draft);
      pickFirstOriginFeatOptions(wizard);
      if (Object.keys(c.draft.classSelections ?? {}).length === 0) pickFirstClassOptions(wizard);
      while (wizard.nextStep());
      const actor = wizard.confirm();
      assert.ok(actor);
      const scores = Object.fromEntries(Object.entries(actor.abilities).map(([k, v]) => [k, v.score]));
      assert.deepEqual(scores, c.scores);
      assert.equal(actor.attributes.level, 1);
      assert.equal(actor.subclassId, undefined, "no subclass before level 3");
      assert.equal(actor.attributes.hp.max, c.hp);
      assert.equal(actor.attributes.speedFt, c.speedFt);
      assert.ok(actor.features?.includes(c.feat));
      if (actor.classId === "fighter") assert.ok(actor.features?.includes("srd:feat:archery"), "the Fighting Style feat is recorded");
      for (const skill of c.skills) assert.equal(actor.skills[skill as keyof typeof actor.skills].proficiencyRank, 1);
      assert.deepEqual(
        Object.entries(actor.abilities).filter(([, v]) => v.saveProficiency).map(([k]) => k),
        c.saves,
      );
      assert.ok(wizard.getDraft(), "confirm keeps the draft so a failed create can be retried");
    });
  }

  it("writes the background and class equipment to the sheet items", () => {
    const wizard = wizardWith({ ...COMPLETE, equipmentIds: ["50 GP"], classSelections: { skills: ["acrobatics", "perception"], fighting_style: ["srd:feat:archery"], equipment: ["C"] } });
    while (wizard.nextStep());
    const actor = wizard.confirm() as unknown as { items: Array<{ name: string }> };
    assert.deepEqual(actor.items.map((i) => i.name), ["50 GP", "155 GP"]);
  });

  const armor = [
    { id: "Fighter option A equips Chain Mail (AC 16)", equipment: "A", ac: 16 },
    { id: "Fighter option B equips Studded Leather (AC 12 + DEX 2)", equipment: "B", ac: 14 },
    { id: "Fighter option C (gold only) leaves AC at 10 + DEX", equipment: "C", ac: 12 },
  ];
  for (const c of armor) {
    it(`class starting equipment feeds Armor Class: ${c.id}`, () => {
      const wizard = wizardWith({ ...COMPLETE, classSelections: { skills: ["acrobatics", "perception"], fighting_style: ["srd:feat:archery"], equipment: [c.equipment] } });
      while (wizard.nextStep());
      const actor = wizard.confirm();
      assert.ok(actor);
      assert.equal(computeDnd5eSheetDerived(actor).armorClass, c.ac);
    });
  }

  it("class skills, cantrips, spellbook spells and level-1 slots reach the Wizard sheet", () => {
    const wizard = wizardWith({ ...COMPLETE, classId: "wizard", classSelections: {} });
    pickFirstClassOptions(wizard);
    const picks = wizard.getDraft()!.classSelections;
    while (wizard.nextStep());
    const actor = wizard.confirm();
    assert.ok(actor);
    for (const skill of picks.skills) assert.equal(actor.skills[skill as keyof typeof actor.skills].proficiencyRank, 1);
    assert.deepEqual(actor.spellIds, [...picks.cantrips, ...picks.spells]);
    assert.equal(picks.cantrips.length, 3);
    assert.equal(picks.spells.length, 6);
    assert.equal(actor.spellSlots?.level1?.max, 2);
  });
});

describe("CharacterBuilderWizard: Origin feat choices (G1)", () => {
  const descriptorCases: Array<{
    id: string;
    backgroundId: string;
    classId: string;
    expectedChoiceIds: string[];
    autoSpellList?: string[];
    excludedOptions?: string[];
  }> = [
    {
      id: "[G1-choices-acolyte] Acolyte offers Cleric Magic Initiate choices with Cleric pre-seeded",
      backgroundId: "acolyte",
      classId: "fighter",
      expectedChoiceIds: ["spell_list", "spellcasting_ability", "cantrips", "level_1_spell"],
      autoSpellList: ["cleric"],
    },
    {
      id: "[G1-choices-sage] Sage offers Wizard Magic Initiate choices with Wizard pre-seeded",
      backgroundId: "sage",
      classId: "fighter",
      expectedChoiceIds: ["spell_list", "spellcasting_ability", "cantrips", "level_1_spell"],
      autoSpellList: ["wizard"],
    },
    {
      id: "[G1-choices-caravan-guide] Caravan Guide Rogue offers Skilled excluding background skills/tools and Rogue Thieves' Tools",
      backgroundId: "caravan_guide",
      classId: "rogue",
      expectedChoiceIds: ["proficiencies"],
      excludedOptions: ["animal_handling", "survival", "tool:Cartographer's Tools", "tool:Thieves' Tools"],
    },
    {
      id: "[ADR-0038-choices-artisan] Artisan Fighter offers Skilled excluding investigation, persuasion, and Smith's Tools",
      backgroundId: "artisan",
      classId: "fighter",
      expectedChoiceIds: ["proficiencies"],
      excludedOptions: ["investigation", "persuasion", "tool:Smith's Tools"],
    },
    {
      id: "[ADR-0038-choices-merchant] Merchant Sorcerer offers Skilled excluding persuasion, insight, and Navigator's Tools",
      backgroundId: "merchant",
      classId: "sorcerer",
      expectedChoiceIds: ["proficiencies"],
      excludedOptions: ["persuasion", "insight", "tool:Navigator's Tools"],
    },
    {
      id: "[ADR-0038-choices-house-guardian] House Guardian Paladin (Alert) requires no Origin feat sub-choices",
      backgroundId: "house_guardian",
      classId: "paladin",
      expectedChoiceIds: [],
    },
    {
      id: "[G1-choices-soldier-none] Soldier (Savage Attacker) requires no Origin feat sub-choices",
      backgroundId: "soldier",
      classId: "fighter",
      expectedChoiceIds: [],
    },
    {
      id: "[G1-choices-criminal-none] Criminal (Alert) requires no Origin feat sub-choices",
      backgroundId: "criminal",
      classId: "rogue",
      expectedChoiceIds: [],
    },
  ];

  for (const c of descriptorCases) {
    it(c.id, () => {
      const wizard = wizardWith({ ...COMPLETE, classId: c.classId, backgroundId: c.backgroundId, backgroundChoice: { mode: "plus1_each" } });
      const choices = wizard.getOriginFeatChoices();
      assert.deepEqual(choices.map((ch) => ch.id), c.expectedChoiceIds);
      if (c.autoSpellList) {
        assert.deepEqual(wizard.getFeatSelection("spell_list"), c.autoSpellList);
      }
      if (c.excludedOptions) {
        const offered = new Set(choices[0].options.map((o) => o.id));
        for (const excluded of c.excludedOptions) {
          assert.equal(offered.has(excluded), false, `${excluded} should not be offered`);
        }
      }
    });
  }

  const clericCantrips = getSpellsByLevel(0, "cleric").map((s) => s.id);
  const [clericSpell1] = getSpellsByLevel(1, "cleric").map((s) => s.id);
  const wizardCantrips = getSpellsByLevel(0, "wizard").map((s) => s.id);
  const fireBolt = wizardCantrips.includes("srd:spell:fire_bolt") ? "srd:spell:fire_bolt" : wizardCantrips[0];
  const secondWizardCantrip = wizardCantrips.find((id) => id !== fireBolt)!;
  const [wizardSpell1] = getSpellsByLevel(1, "wizard").map((s) => s.id);

  const applyCases: Array<{
    id: string;
    backgroundId: string;
    featSelections: Record<string, string[]>;
    expectedFeatId: string;
    expectedSpellAbility?: string;
    expectedSpellIds?: string[];
    expectedSkills?: string[];
    expectedTools?: string[];
  }> = [
    {
      id: "[G1-apply-acolyte-cleric] Acolyte Fighter applies Cleric Magic Initiate spells and WIS spellcasting",
      backgroundId: "acolyte",
      featSelections: {
        spellcasting_ability: ["wis"],
        cantrips: [clericCantrips[0], clericCantrips[1]],
        level_1_spell: [clericSpell1],
      },
      expectedFeatId: "srd:feat:magic_initiate",
      expectedSpellAbility: "wis",
      expectedSpellIds: [clericCantrips[0], clericCantrips[1], clericSpell1],
    },
    {
      id: "[G1-apply-sage-wizard] Sage Fighter applies Wizard Magic Initiate spells and INT spellcasting",
      backgroundId: "sage",
      featSelections: {
        spellcasting_ability: ["int"],
        cantrips: [fireBolt, secondWizardCantrip],
        level_1_spell: [wizardSpell1],
      },
      expectedFeatId: "srd:feat:magic_initiate",
      expectedSpellAbility: "int",
      expectedSpellIds: [fireBolt, secondWizardCantrip, wizardSpell1],
    },
    {
      id: "[G1-apply-caravan-guide-skilled] Caravan Guide Fighter applies 2 Skilled skills and 1 Skilled tool",
      backgroundId: "caravan_guide",
      featSelections: {
        proficiencies: ["stealth", "arcana", "tool:Thieves' Tools"],
      },
      expectedFeatId: "srd:feat:skilled",
      expectedSkills: ["stealth", "arcana", "animal_handling", "survival"],
      expectedTools: ["Cartographer's Tools", "Thieves' Tools"],
    },
  ];

  for (const c of applyCases) {
    it(c.id, () => {
      const wizard = wizardWith({
        ...COMPLETE,
        backgroundId: c.backgroundId,
        backgroundChoice: { mode: "plus1_each" },
        featSelections: c.featSelections,
        classSelections: { skills: ["acrobatics", "perception"], fighting_style: ["srd:feat:archery"], equipment: ["A"] },
      });
      while (wizard.nextStep());
      assert.equal(wizard.currentStep, "review");
      const actor = wizard.confirm();
      assert.ok(actor);
      assert.equal(actor.featChoices?.length, 1);
      assert.equal(actor.featChoices?.[0].featId, c.expectedFeatId);
      if (c.expectedSpellAbility && c.expectedSpellIds) {
        const featSpellEntry = computeDnd5eSheetDerived(actor).spells?.featSpells[0];
        assert.ok(featSpellEntry, "derived.spells.featSpells must include Magic Initiate");
        assert.equal(featSpellEntry.ability, c.expectedSpellAbility);
        assert.deepEqual(featSpellEntry.spells.map((s) => s.id), c.expectedSpellIds);
      }
      for (const skill of c.expectedSkills ?? []) {
        assert.equal(actor.skills[skill as keyof typeof actor.skills].proficiencyRank, 1);
      }
      for (const tool of c.expectedTools ?? []) {
        assert.ok(actor.proficiencies?.tools.includes(tool), `expected tool ${tool}`);
      }
    });
  }

  it("[G1-skilled-excludes-from-class-skills] picking a skill in Skilled removes it from class skill options and prunes duplicate class picks", () => {
    const wizard = wizardWith({
      ...COMPLETE,
      backgroundId: "caravan_guide",
      backgroundChoice: { mode: "plus1_each" },
      featSelections: { proficiencies: ["stealth", "arcana"] },
      classSelections: { skills: ["acrobatics", "perception"], fighting_style: ["srd:feat:archery"], equipment: ["A"] },
    });
    wizard.toggleFeatOption("proficiencies", "acrobatics");
    assert.deepEqual(wizard.getDraft()?.classSelections.skills, ["perception"]);
    const classSkillOptions = wizard.getClassChoices().find((ch) => ch.id === "skills")?.options.map((o) => o.id) ?? [];
    assert.equal(classSkillOptions.includes("acrobatics"), false);
  });
});

describe("ability score utilities", () => {
  const costs = [
    { id: "all 8s cost nothing", scores: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }, cost: 0 },
    { id: "15/15/15/8/8/8 costs 27", scores: { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 }, cost: 27 },
    { id: "a 16 is outside point buy", scores: { str: 16, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }, cost: Number.POSITIVE_INFINITY },
  ];
  for (const c of costs) {
    it(`calculatePointBuyCost: ${c.id}`, () => assert.equal(calculatePointBuyCost(c.scores), c.cost));
  }

  const arrays = [
    { id: "any permutation of the array is valid", scores: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 }, valid: true },
    { id: "a duplicate value is invalid", scores: { str: 15, dex: 15, con: 14, int: 13, wis: 12, cha: 10 }, valid: false },
  ];
  for (const c of arrays) {
    it(`validateStandardArray: ${c.id}`, () => assert.equal(validateStandardArray(c.scores), c.valid));
  }
});
