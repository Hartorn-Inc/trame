import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StatBlock6,
  ResourceBar,
  SavingThrowList,
  SkillCheckList,
  ArmorInitiativeSpeed,
  HitDiceAndDeathSaves,
  AttackActionTable,
  SpellbookAccordion,
  InventoryContainerTree,
  FeatureTraitList,
  ConditionBadgeStrip,
  NotesMarkdownPane,
  sanitizeHtml,
} from "../../src/sheet/widgets/index.ts";

describe("Ticket #88 - 12 Declarative Widgets Parametrized & CoreBuildLock Suite", () => {
  describe("Widget 1: StatBlock6", () => {
    const abilityCases = [
      { key: "str", score: 18, modifier: 4, expectedFormula: "1d20 + 4" },
      { key: "dex", score: 14, modifier: 2, expectedFormula: "1d20 + 2" },
      { key: "con", score: 10, modifier: 0, expectedFormula: "1d20 + 0" },
      { key: "int", score: 8, modifier: -1, expectedFormula: "1d20 - 1" },
      { key: "wis", score: 7, modifier: -2, expectedFormula: "1d20 - 2" },
      { key: "cha", score: 20, modifier: 5, expectedFormula: "1d20 + 5" },
    ];

    for (const testCase of abilityCases) {
      it(`WHEN clicking ${testCase.key} in locked mode, THEN StatBlock6 dispatches RollDice with ${testCase.expectedFormula}`, () => {
        const dispatched: any[] = [];
        const widget = StatBlock6({
          id: "statblock-test",
          boundValues: {
            abilities: {
              [testCase.key]: { score: testCase.score, modifier: testCase.modifier },
            },
          },
          options: { displayOrder: [testCase.key] },
          dispatchCommand: (cmd) => dispatched.push(cmd),
        });

        widget.clickAbility(testCase.key);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].cmd, "ROLL_DICE");
        assert.equal(dispatched[0].ability, testCase.key);
        assert.equal(dispatched[0].formula, testCase.expectedFormula);
        assert.equal(dispatched[0].modifier, testCase.modifier);
      });
    }
  });

  describe("Widget 2: ResourceBar", () => {
    it("WHEN adjusting current HP, THEN ResourceBar dispatches UpdateActorSheet with the new current value", () => {
      const dispatched: any[] = [];
      const widget = ResourceBar({
        id: "hp-bar",
        boundValues: { current: 35, max: 40, temp: 5 },
        options: { label: "Hit Points", color: "#22c55e" },
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      assert.equal(widget.current, 35);
      assert.equal(widget.max, 40);
      assert.equal(widget.temp, 5);
      assert.equal(widget.label, "Hit Points");

      widget.updateValue(28);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[0].path, "current");
      assert.equal(dispatched[0].current, 28);
    });
  });

  describe("Widget 3: ArmorInitiativeSpeed", () => {
    it("WHEN clicking initiative, THEN ArmorInitiativeSpeed dispatches RollDice with authoritative initiative modifier", () => {
      const dispatched: any[] = [];
      const widget = ArmorInitiativeSpeed({
        id: "ais-widget",
        boundValues: { armorClass: 18, initiative: 4, speed: 30 },
        options: {},
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      assert.equal(widget.armorClass, 18);
      assert.equal(widget.initiative, 4);
      assert.equal(widget.speed, 30);

      widget.clickInitiative();
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].cmd, "ROLL_DICE");
      assert.equal(dispatched[0].formula, "1d20 + 4");
      assert.equal(dispatched[0].initiative, 4);
    });
  });

  describe("Widget 4: SavingThrowList", () => {
    const saveCases = [
      { ability: "dex", mod: 5, proficient: true, formula: "1d20 + 5" },
      { ability: "con", mod: 2, proficient: false, formula: "1d20 + 2" },
      { ability: "cha", mod: -1, proficient: false, formula: "1d20 - 1" },
    ];

    for (const testCase of saveCases) {
      it(`WHEN clicking save for ${testCase.ability}, THEN SavingThrowList dispatches RollDice with ${testCase.formula}`, () => {
        const dispatched: any[] = [];
        const widget = SavingThrowList({
          id: "saves-widget",
          boundValues: {
            saves: {
              [testCase.ability]: { modifier: testCase.mod, proficient: testCase.proficient },
            },
          },
          options: {},
          dispatchCommand: (cmd) => dispatched.push(cmd),
        });

        widget.clickSave(testCase.ability);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].cmd, "ROLL_DICE");
        assert.equal(dispatched[0].ability, testCase.ability);
        assert.equal(dispatched[0].formula, testCase.formula);
      });
    }
  });

  describe("Widget 5: SkillCheckList", () => {
    const skillCases = [
      { key: "stealth", mod: 7, rank: "expertise", formula: "1d20 + 7" },
      { key: "athletics", mod: 3, rank: "proficient", formula: "1d20 + 3" },
      { key: "history", mod: -1, rank: "none", formula: "1d20 - 1" },
    ];

    for (const testCase of skillCases) {
      it(`WHEN clicking skill check for ${testCase.key}, THEN SkillCheckList dispatches RollDice with ${testCase.formula}`, () => {
        const dispatched: any[] = [];
        const widget = SkillCheckList({
          id: "skills-widget",
          boundValues: {
            skills: {
              [testCase.key]: { modifier: testCase.mod, proficiencyLevel: testCase.rank, passive: 10 + testCase.mod },
            },
          },
          options: {},
          dispatchCommand: (cmd) => dispatched.push(cmd),
        });

        widget.clickSkill(testCase.key);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].cmd, "ROLL_DICE");
        assert.equal(dispatched[0].skill, testCase.key);
        assert.equal(dispatched[0].formula, testCase.formula);
      });
    }
  });

  describe("Widget 6: HitDiceAndDeathSaves", () => {
    it("WHEN spending a hit die, THEN HitDiceAndDeathSaves dispatches RollDice and decrements hitDiceCurrent", () => {
      const dispatched: any[] = [];
      const widget = HitDiceAndDeathSaves({
        id: "hdds-widget",
        boundValues: {
          hitDiceCurrent: 5,
          hitDiceMax: 5,
          hitDieSides: 10,
          conModifier: 3,
          deathSuccesses: 0,
          deathFailures: 0,
          hpCurrent: 12,
        },
        options: {},
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      widget.spendHitDie();
      assert.equal(dispatched.length, 2);
      assert.equal(dispatched[0].cmd, "ROLL_DICE");
      assert.equal(dispatched[0].formula, "1d10 + 3");
      assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[1].path, "hitDiceCurrent");
      assert.equal(dispatched[1].value, 4);
    });

    const deathSaveScenarios = [
      { roll: 1, expectedFailuresIncrement: 2, expectedSuccesses: 0 },
      { roll: 6, expectedFailuresIncrement: 1, expectedSuccesses: 0 },
      { roll: 12, expectedSuccessesIncrement: 1, expectedFailures: 0 },
    ];

    for (const scenario of deathSaveScenarios) {
      it(`WHEN death saving throw roll is ${scenario.roll}, THEN evaluateDeathSaveResult updates counters per INV-10`, () => {
        const dispatched: any[] = [];
        const widget = HitDiceAndDeathSaves({
          id: "hdds-eval",
          boundValues: {
            hitDiceCurrent: 0,
            hitDiceMax: 5,
            hitDieSides: 10,
            conModifier: 0,
            deathSuccesses: 0,
            deathFailures: 0,
            hpCurrent: 0,
          },
          options: {},
          dispatchCommand: (cmd) => dispatched.push(cmd),
        });

        widget.evaluateDeathSaveResult(scenario.roll);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
        if (scenario.expectedFailuresIncrement) {
          assert.equal(dispatched[0].deathFailures, scenario.expectedFailuresIncrement);
        }
        if (scenario.expectedSuccessesIncrement) {
          assert.equal(dispatched[0].deathSuccesses, scenario.expectedSuccessesIncrement);
        }
      });
    }

    it("WHEN death saving throw is a natural 20, THEN evaluateDeathSaveResult restores 1 HP and resets counters per INV-10", () => {
      const dispatched: any[] = [];
      const widget = HitDiceAndDeathSaves({
        id: "hdds-nat20",
        boundValues: {
          hitDiceCurrent: 0,
          hitDiceMax: 5,
          hitDieSides: 10,
          conModifier: 0,
          deathSuccesses: 2,
          deathFailures: 1,
          hpCurrent: 0,
        },
        options: {},
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      widget.evaluateDeathSaveResult(20);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[0].deathSuccesses, 0);
      assert.equal(dispatched[0].deathFailures, 0);
      assert.equal(dispatched[0].hpCurrent, 1);
    });
  });

  describe("Widget 7: ConditionBadgeStrip", () => {
    it("WHEN removing a condition badge, THEN ConditionBadgeStrip dispatches UpdateActorSheet with remaining conditions", () => {
      const dispatched: any[] = [];
      const widget = ConditionBadgeStrip({
        id: "conditions-widget",
        boundValues: {
          conditions: ["Charmed", "Frightened", "Paralyzed"],
        },
        options: {},
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      widget.removeCondition("Frightened");
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[0].removedConditionId, "Frightened");
      assert.deepEqual(dispatched[0].conditions, ["Charmed", "Paralyzed"]);
    });
  });

  describe("Widget 8: AttackActionTable", () => {
    it("WHEN triggering attack and damage rolls, THEN AttackActionTable dispatches RollDice commands", () => {
      const dispatched: any[] = [];
      const widget = AttackActionTable({
        id: "attacks-widget",
        boundValues: {
          attacks: [
            {
              id: "dagger-atk",
              name: "Dagger",
              attackBonus: 5,
              damageFormula: "1d4 + 3",
              damageType: "piercing",
            },
          ],
        },
        options: {},
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      widget.clickAttack("dagger-atk");
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].cmd, "ROLL_DICE");
      assert.equal(dispatched[0].formula, "1d20 + 5");

      widget.clickDamage("dagger-atk");
      assert.equal(dispatched.length, 2);
      assert.equal(dispatched[1].cmd, "ROLL_DICE");
      assert.equal(dispatched[1].formula, "1d4 + 3");
    });
  });

  describe("Widget 9: SpellbookAccordion", () => {
    it("WHEN casting an AoE spell with autoDeductSlots, THEN SpellbookAccordion projects AoE and decrements slot", () => {
      const dispatched: any[] = [];
      const widget = SpellbookAccordion({
        id: "spellbook-widget",
        boundValues: {
          slots: { level3: { current: 3, max: 3 } },
          spells: [{ id: "spell-fireball", name: "Fireball", level: 3, requiresAoE: true }],
          spellSaveDc: 16,
          spellAttackBonus: 8,
        },
        options: { autoDeductSlots: true },
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      widget.castSpell("spell-fireball");
      assert.equal(dispatched.length, 2);
      assert.equal(dispatched[0].cmd, "PROJECT_AOE");
      assert.equal(dispatched[0].spellId, "spell-fireball");
      assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[1].path, "slots.level3.current");
      assert.equal(dispatched[1].current, 2);
    });
  });

  describe("Widget 10: InventoryContainerTree", () => {
    it("WHEN moving or deleting inventory items, THEN InventoryContainerTree dispatches UpdateActorSheet", () => {
      const dispatched: any[] = [];
      const widget = InventoryContainerTree({
        id: "inv-widget",
        boundValues: {
          items: [
            { id: "potion-greater", name: "Greater Healing Potion", quantity: 2, unitWeight: 0.5, containerId: null },
          ],
          currency: { cp: 100, sp: 20, ep: 0, gp: 5, pp: 0 },
        },
        options: {},
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      widget.moveItem("potion-greater", "chest-1");
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[0].targetContainerId, "chest-1");

      widget.removeItem("potion-greater");
      assert.equal(dispatched.length, 2);
      assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[1].action, "delete");
    });
  });

  describe("Widget 11: FeatureTraitList", () => {
    it("WHEN expanding or collapsing feature headers, THEN FeatureTraitList updates local expansion state without network dispatch", () => {
      const widget = FeatureTraitList({
        id: "features-widget",
        boundValues: {
          features: [
            { id: "cunning-action", name: "Cunning Action", source: "Rogue", description: "Bonus action Dash/Disengage/Hide." },
          ],
        },
        options: {},
      });

      assert.equal(widget.isExpanded("cunning-action"), false);
      widget.toggleFeature("cunning-action");
      assert.equal(widget.isExpanded("cunning-action"), true);
      widget.toggleFeature("cunning-action");
      assert.equal(widget.isExpanded("cunning-action"), false);
    });
  });

  describe("Widget 12: NotesMarkdownPane", () => {
    it("WHEN editing bio or notes, THEN NotesMarkdownPane sanitizes HTML elements and dispatches UpdateActorSheet", () => {
      const dispatched: any[] = [];
      const widget = NotesMarkdownPane({
        id: "notes-widget",
        boundValues: {
          bio: "Initial bio",
          notes: "Initial notes",
        },
        options: {},
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      const rawBio = "<script>alert(1)</script>Elf Ranger from the high forest";
      assert.equal(sanitizeHtml(rawBio), "Elf Ranger from the high forest");

      widget.editBio(rawBio);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[0].path, "bio");
      assert.equal(dispatched[0].bio, "Elf Ranger from the high forest");

      widget.editNotes("Secret meeting at dusk");
      assert.equal(dispatched.length, 2);
      assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(dispatched[1].path, "notes");
      assert.equal(dispatched[1].notes, "Secret meeting at dusk");
    });
  });
});
