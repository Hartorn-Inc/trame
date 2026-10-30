import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BuilderDraftStore,
  CharacterBuilderWizard,
  MAX_POINT_BUY_BUDGET,
  calculatePointBuyCost,
  validateStandardArray,
  type CreateActorCommand,
} from "../../src/builder/index.ts";

describe("CharacterBuilderWizard and BuilderDraftStore Suite", () => {
  it("WHEN CharacterBuilderWizard initializes, CharacterBuilderWizard sets currentStep to ancestry and draft state to default empty values.", () => {
    const dispatched: unknown[] = [];
    const wizard = new CharacterBuilderWizard((cmd) => dispatched.push(cmd));

    assert.equal(wizard.currentStep, "ancestry");
    assert.equal(wizard.step, "ancestry");
    assert.equal(wizard.getStep(), "ancestry");
    assert.equal(wizard.getStepIndex(), 0);

    const draft = wizard.getDraft();
    assert.notEqual(draft, null);
    assert.equal(draft?.ancestryId, null);
    assert.equal(draft?.classId, null);
    assert.equal(draft?.subclassId, null);
    assert.equal(draft?.name, "");
    assert.deepEqual(draft?.equipmentIds, []);
    assert.deepEqual(draft?.spellIds, []);
    assert.deepEqual(draft?.featIds, []);
    assert.deepEqual(draft?.skills, []);
    assert.equal(draft?.abilityGenerationMethod, "pointBuy");
    assert.deepEqual(draft?.abilityScores, {
      str: 8,
      dex: 8,
      con: 8,
      int: 8,
      wis: 8,
      cha: 8,
    });

    assert.equal(dispatched.length, 0);
  });

  it("WHEN a user attempts to transition to class while ancestryId is null, CharacterBuilderWizard rejects step progression and returns false.", () => {
    const wizard = new CharacterBuilderWizard();
    assert.equal(wizard.currentStep, "ancestry");
    assert.equal(wizard.getDraft()?.ancestryId, null);

    const nextResult = wizard.nextStep();
    assert.equal(nextResult, false);
    assert.equal(wizard.currentStep, "ancestry");

    const jumpResult = wizard.goToStep("class");
    assert.equal(jumpResult, false);
    assert.equal(wizard.currentStep, "ancestry");

    wizard.setAncestry("   ");
    assert.equal(wizard.nextStep(), false);
    assert.equal(wizard.currentStep, "ancestry");

    wizard.setAncestry("elf");
    assert.equal(wizard.canAdvance(), true);
    assert.equal(wizard.canTransitionTo("class"), true);
    const successfulNext = wizard.nextStep();
    assert.equal(successfulNext, true);
    assert.equal(wizard.currentStep, "class");
  });

  it("CharacterBuilderWizard verifies that classId is selected before advancing from class step.", () => {
    const wizard = new CharacterBuilderWizard();
    wizard.setAncestry("dwarf");
    wizard.nextStep();
    assert.equal(wizard.currentStep, "class");
    assert.equal(wizard.getDraft()?.classId, null);

    const nextResult = wizard.nextStep();
    assert.equal(nextResult, false);
    assert.equal(wizard.currentStep, "class");

    const jumpResult = wizard.goToStep("abilityScores");
    assert.equal(jumpResult, false);
    assert.equal(wizard.currentStep, "class");

    wizard.setClass("wizard");
    assert.equal(wizard.nextStep(), true);
    assert.equal(wizard.currentStep, "abilityScores");
  });

  it("WHEN a user attempts to transition to equipment while allocated point buy cost exceeds 27 points, CharacterBuilderWizard rejects step progression and returns false.", () => {
    const wizard = new CharacterBuilderWizard();
    wizard.setAncestry("human");
    wizard.nextStep();
    wizard.setClass("fighter");
    wizard.nextStep();
    assert.equal(wizard.currentStep, "abilityScores");

    wizard.setAbilityScores(
      {
        str: 15,
        dex: 15,
        con: 15,
        int: 15,
        wis: 10,
        cha: 8,
      },
      "pointBuy",
    );

    const cost = wizard.getPointBuyCost();
    assert.equal(cost, 38);
    assert.ok(cost > MAX_POINT_BUY_BUDGET);
    assert.equal(wizard.isPointBuyValid(), false);
    assert.equal(wizard.getRemainingPointBuyBudget(), -11);

    const nextResult = wizard.nextStep();
    assert.equal(nextResult, false);
    assert.equal(wizard.currentStep, "abilityScores");

    const jumpResult = wizard.goToStep("equipment");
    assert.equal(jumpResult, false);
    assert.equal(wizard.currentStep, "abilityScores");

    wizard.setAbilityScores(
      {
        str: 15,
        dex: 15,
        con: 15,
        int: 9,
        wis: 8,
        cha: 8,
      },
      "pointBuy",
    );
    assert.equal(wizard.getPointBuyCost(), 28);
    assert.equal(wizard.nextStep(), false);

    wizard.setAbilityScores(
      {
        str: 15,
        dex: 15,
        con: 15,
        int: 8,
        wis: 8,
        cha: 8,
      },
      "pointBuy",
    );
    assert.equal(wizard.getPointBuyCost(), 27);
    assert.equal(wizard.isPointBuyValid(), true);
    assert.equal(wizard.getRemainingPointBuyBudget(), 0);

    const advanceResult = wizard.nextStep();
    assert.equal(advanceResult, true);
    assert.equal(wizard.currentStep, "equipment");
  });

  it("CharacterBuilderWizard evaluates standard array assignments ([15, 14, 13, 12, 10, 8] without duplicates) before advancing from abilityScores step.", () => {
    const wizard = new CharacterBuilderWizard();
    wizard.setAncestry("halfling");
    wizard.nextStep();
    wizard.setClass("rogue");
    wizard.nextStep();
    assert.equal(wizard.currentStep, "abilityScores");

    wizard.setAbilityScores(
      {
        str: 15,
        dex: 15,
        con: 13,
        int: 12,
        wis: 10,
        cha: 8,
      },
      "standardArray",
    );
    assert.equal(wizard.isStandardArrayValid(), false);
    assert.equal(wizard.nextStep(), false);
    assert.equal(wizard.currentStep, "abilityScores");

    wizard.setAbilityScores(
      {
        str: 16,
        dex: 14,
        con: 13,
        int: 12,
        wis: 10,
        cha: 8,
      },
      "standardArray",
    );
    assert.equal(wizard.isStandardArrayValid(), false);
    assert.equal(wizard.nextStep(), false);

    wizard.setAbilityScores(
      {
        str: 15,
        dex: 14,
        con: 13,
        int: 12,
        wis: 10,
        cha: 8,
      },
      "standardArray",
    );
    assert.equal(wizard.isStandardArrayValid(), true);
    assert.equal(wizard.nextStep(), true);
    assert.equal(wizard.currentStep, "equipment");
  });

  it("WHEN a user transitions through wizard steps 1 to 4, CharacterBuilderWizard dispatches zero network commands and creates zero CRDT entries.", () => {
    const dispatchedCommands: unknown[] = [];
    const wizard = new CharacterBuilderWizard((cmd) =>
      dispatchedCommands.push(cmd),
    );

    assert.equal(wizard.currentStep, "ancestry");
    wizard.setName("Theron");
    wizard.setAncestry("human");
    assert.equal(dispatchedCommands.length, 0);

    const toClass = wizard.nextStep();
    assert.equal(toClass, true);
    assert.equal(wizard.currentStep, "class");
    wizard.setClass("paladin");
    assert.equal(dispatchedCommands.length, 0);

    const toAbilities = wizard.nextStep();
    assert.equal(toAbilities, true);
    assert.equal(wizard.currentStep, "abilityScores");
    wizard.setAbilityScores(
      { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      "standardArray",
    );
    assert.equal(dispatchedCommands.length, 0);

    const toEquipment = wizard.nextStep();
    assert.equal(toEquipment, true);
    assert.equal(wizard.currentStep, "equipment");
    wizard.setEquipment(["longsword", "shield", "chainmail"]);
    wizard.addEquipment("holy_symbol");
    assert.equal(dispatchedCommands.length, 0);

    wizard.previousStep();
    assert.equal(wizard.currentStep, "abilityScores");
    wizard.nextStep();
    assert.equal(wizard.currentStep, "equipment");
    assert.equal(dispatchedCommands.length, 0);

    const toReview = wizard.nextStep();
    assert.equal(toReview, true);
    assert.equal(wizard.currentStep, "review");
    assert.equal(dispatchedCommands.length, 0);
  });

  it("WHEN a user confirms character creation in the review step, CharacterBuilderWizard dispatches exactly one TrameCommand.CreateActor command containing the finalized character configuration.", () => {
    const dispatchedCommands: CreateActorCommand[] = [];
    const wizard = new CharacterBuilderWizard((cmd) =>
      dispatchedCommands.push(cmd as CreateActorCommand),
    );

    wizard.setName("Lyra Silvertongue");
    wizard.setAncestry("half-elf");
    wizard.nextStep();
    wizard.setClass("bard", "college-of-lore");
    wizard.nextStep();
    wizard.setAbilityScores(
      { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 },
      "standardArray",
    );
    wizard.nextStep();
    wizard.setEquipment(["rapier", "lute", "leather-armor"]);
    wizard.nextStep();

    assert.equal(wizard.currentStep, "review");
    assert.equal(dispatchedCommands.length, 0);

    const confirmed = wizard.confirm();
    assert.equal(confirmed, true);
    assert.equal(dispatchedCommands.length, 1);

    const cmd = dispatchedCommands[0];
    assert.equal(cmd.cmd, "CREATE_ACTOR");
    assert.equal(cmd.type, "CREATE_ACTOR");
    assert.equal(cmd.name, "Lyra Silvertongue");
    assert.equal(cmd.ancestryId, "half-elf");
    assert.equal(cmd.classId, "bard");
    assert.equal(cmd.subclassId, "college-of-lore");
    assert.deepEqual(cmd.equipmentIds, ["rapier", "lute", "leather-armor"]);
    assert.deepEqual(cmd.abilityScores, {
      str: 8,
      dex: 14,
      con: 13,
      int: 12,
      wis: 10,
      cha: 15,
    });
    assert.ok(cmd.actor);
    assert.equal((cmd.actor as any).name, "Lyra Silvertongue");
    assert.equal((cmd.actor as any).abilities.cha.score, 15);
    assert.equal((cmd.actor as any).abilities.cha.mod, 2);
  });

  it("WHEN character creation dispatch succeeds, CharacterBuilderWizard clears the draft in BuilderDraftStore to null.", () => {
    const customStore = new BuilderDraftStore();
    const dispatched: unknown[] = [];
    const wizard = new CharacterBuilderWizard({
      draftStore: customStore,
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    wizard.setAncestry("gnome");
    wizard.nextStep();
    wizard.setClass("wizard");
    wizard.nextStep();
    wizard.setAbilityScores(
      { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      "standardArray",
    );
    wizard.nextStep();
    wizard.setEquipment(["spellbook", "dagger"]);
    wizard.nextStep();
    assert.equal(wizard.currentStep, "review");

    assert.notEqual(customStore.getDraft(), null);
    assert.notEqual(wizard.getDraft(), null);

    wizard.confirm();

    assert.equal(customStore.getDraft(), null);
    assert.equal(wizard.getDraft(), null);
    assert.equal(customStore.hasDraft(), false);

    const secondConfirm = wizard.confirm();
    assert.equal(secondConfirm, false);
    assert.equal(dispatched.length, 1);
  });

  it("WHEN a user cancels character creation, BuilderDraftStore resets active draft state to null without dispatching any TrameCommand.", () => {
    const dispatched: unknown[] = [];
    const customStore = new BuilderDraftStore();
    const wizard = new CharacterBuilderWizard({
      draftStore: customStore,
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    wizard.setName("Abandoned Hero");
    wizard.setAncestry("orc");
    assert.notEqual(customStore.getDraft(), null);
    assert.equal(customStore.getDraft()?.name, "Abandoned Hero");

    wizard.cancel();

    assert.equal(customStore.getDraft(), null);
    assert.equal(wizard.getDraft(), null);
    assert.equal(customStore.hasDraft(), false);
    assert.equal(dispatched.length, 0);

    customStore.initDraft({ name: "Direct Store Draft" });
    assert.notEqual(customStore.getDraft(), null);
    customStore.cancel();
    assert.equal(customStore.getDraft(), null);
    assert.equal(dispatched.length, 0);
  });

  it("BuilderDraftStore static singleton methods reset draft to null without dispatching commands", () => {
    BuilderDraftStore.initDraft({ name: "Static Draft", ancestryId: "elf" });
    assert.notEqual(BuilderDraftStore.getDraft(), null);
    assert.equal(BuilderDraftStore.getDraft()?.ancestryId, "elf");

    BuilderDraftStore.cancel();
    assert.equal(BuilderDraftStore.getDraft(), null);
    assert.equal(BuilderDraftStore.hasDraft(), false);
  });

  it("WHEN draft abilityGenerationMethod is undefined or manual with scores exceeding 27 points, CharacterBuilderWizard rejects step progression.", () => {
    const wizard = new CharacterBuilderWizard();
    wizard.setAncestry("human");
    wizard.nextStep();
    wizard.setClass("fighter");
    wizard.nextStep();
    assert.equal(wizard.currentStep, "abilityScores");

    wizard.updateDraft({
      abilityGenerationMethod: undefined,
      abilityScores: { str: 15, dex: 15, con: 15, int: 15, wis: 10, cha: 8 },
    });
    assert.equal(wizard.nextStep(), false);
    assert.equal(wizard.currentStep, "abilityScores");

    wizard.updateDraft({
      abilityGenerationMethod: "manual" as any,
      abilityScores: { str: 18, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
    });
    assert.equal(wizard.nextStep(), false);
    assert.equal(wizard.currentStep, "abilityScores");
  });

  it("rejects confirm() before review step without dispatching commands", () => {
    const dispatched: unknown[] = [];
    const wizard = new CharacterBuilderWizard((cmd) => dispatched.push(cmd));
    wizard.setAncestry("human");

    const result = wizard.confirm();
    assert.equal(result, false);
    assert.equal(dispatched.length, 0);
  });

  it("supports navigation backwards to previous steps", () => {
    const wizard = new CharacterBuilderWizard();
    wizard.setAncestry("tiefling");
    wizard.nextStep();
    wizard.setClass("warlock");
    wizard.nextStep();

    assert.equal(wizard.currentStep, "abilityScores");
    assert.equal(wizard.previousStep(), true);
    assert.equal(wizard.currentStep, "class");
    assert.equal(wizard.previousStep(), true);
    assert.equal(wizard.currentStep, "ancestry");
    assert.equal(wizard.previousStep(), false);
    assert.equal(wizard.currentStep, "ancestry");
  });

  it("evaluates calculatePointBuyCost and validateStandardArray utility functions", () => {
    const stdScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
    assert.equal(validateStandardArray(stdScores), true);
    assert.equal(calculatePointBuyCost(stdScores), 27);

    const duplicateScores = { str: 15, dex: 15, con: 13, int: 12, wis: 10, cha: 8 };
    assert.equal(validateStandardArray(duplicateScores), false);

    const outOfBoundsScores = { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
    assert.equal(calculatePointBuyCost(outOfBoundsScores), Number.POSITIVE_INFINITY);
  });
});
