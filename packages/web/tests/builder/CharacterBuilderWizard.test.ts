import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
};

describe("CharacterBuilderWizard: 2024 step order and gating", () => {
  it("starts on species with an empty draft and follows the SRD 5.2.1 order", () => {
    const wizard = wizardWith(COMPLETE);
    const visited = [wizard.currentStep];
    while (wizard.nextStep()) visited.push(wizard.currentStep);
    assert.deepEqual(visited, ["species", "class", "background", "abilityScores", "equipment", "review"]);
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
    { id: "empty equipment blocks the equipment step", draft: { ...COMPLETE, equipmentIds: [] }, step: "equipment", error: "builder.error.equipment" },
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

  it("changing the background resets the split to +1/+1/+1", () => {
    const wizard = wizardWith(COMPLETE);
    wizard.setBackground("sage");
    assert.deepEqual(wizard.getDraft()?.backgroundChoice, { mode: "plus1_each" });
  });
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
      draft: { ...COMPLETE, speciesId: "elf", classId: "wizard", backgroundId: "sage", backgroundChoice: { mode: "plus1_each" } },
      scores: { str: 15, dex: 14, con: 14, int: 13, wis: 11, cha: 8 },
      hp: 6 + 2,
      speedFt: 30,
      feat: "srd:feat:magic_initiate",
      skills: ["arcana", "history"],
      saves: ["int", "wis"],
    },
  ];

  for (const c of cases) {
    it(c.id, () => {
      const wizard = wizardWith(c.draft);
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
      for (const skill of c.skills) assert.equal(actor.skills[skill as keyof typeof actor.skills].proficiencyRank, 1);
      assert.deepEqual(
        Object.entries(actor.abilities).filter(([, v]) => v.saveProficiency).map(([k]) => k),
        c.saves,
      );
      assert.ok(wizard.getDraft(), "confirm keeps the draft so a failed create can be retried");
    });
  }

  it("writes the chosen equipment to the sheet items", () => {
    const wizard = wizardWith({ ...COMPLETE, equipmentIds: ["50 GP"] });
    while (wizard.nextStep());
    const actor = wizard.confirm() as unknown as { items: Array<{ name: string }> };
    assert.deepEqual(actor.items.map((i) => i.name), ["50 GP"]);
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
