import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeclarativeSheetRenderer } from "../../src/sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../../src/sheet/WidgetRegistry.ts";
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
import type { SheetLayoutTree } from "../../src/sheet/types.ts";

describe("Twelve Canonical Atomic Sheet Widgets & Command Dispatching", () => {
  it("WHEN a user clicks an ability card in StatBlock6, StatBlock6 dispatches a TrameCommand.RollDice command with formula 1d20 + modifier", () => {
    const dispatched: any[] = [];
    const widget = StatBlock6({
      id: "statblock-1",
      boundValues: {
        abilities: {
          str: { score: 16, modifier: 3 },
          dex: { score: 8, modifier: -1 },
        },
      },
      options: {
        displayOrder: ["str", "dex"],
      },
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.clickAbility("str");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d20 + 3");
    assert.equal(dispatched[0].ability, "str");

    widget.clickAbility("dex");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].cmd, "ROLL_DICE");
    assert.equal(dispatched[1].formula, "1d20 - 1");
  });

  it("WHEN a user modifies the current value in ResourceBar, ResourceBar dispatches a TrameCommand.UpdateActorSheet command with the updated numeric value", () => {
    const dispatched: any[] = [];
    const widget = ResourceBar({
      id: "hp-bar",
      boundValues: {
        current: 25,
        max: 30,
        temp: 5,
      },
      options: {
        label: "Hit Points",
      },
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    assert.equal(widget.current, 25);
    assert.equal(widget.max, 30);
    assert.equal(widget.temp, 5);

    widget.updateValue(18);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].value, 18);
    assert.equal(dispatched[0].current, 18);
  });

  it("WHEN a user clicks a saving throw row in SavingThrowList, SavingThrowList dispatches a TrameCommand.RollDice command with formula 1d20 + modifier", () => {
    const dispatched: any[] = [];
    const widget = SavingThrowList({
      id: "saves-1",
      boundValues: {
        saves: {
          con: { modifier: 4, proficient: true },
          int: { modifier: -1, proficient: false },
        },
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.clickSave("con");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d20 + 4");
    assert.equal(dispatched[0].ability, "con");
  });

  it("WHEN a user clicks a skill check row in SkillCheckList, SkillCheckList dispatches a TrameCommand.RollDice command with formula 1d20 + modifier", () => {
    const dispatched: any[] = [];
    const widget = SkillCheckList({
      id: "skills-1",
      boundValues: {
        skills: {
          stealth: { modifier: 5, proficiencyLevel: "proficient", passive: 15 },
          athletics: { modifier: -1, proficiencyLevel: "none", passive: 9 },
        },
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.clickSkill("stealth");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d20 + 5");
    assert.equal(dispatched[0].skill, "stealth");
  });

  it("WHEN a user clicks the initiative trigger in ArmorInitiativeSpeed, ArmorInitiativeSpeed dispatches a TrameCommand.RollDice command with formula 1d20 + initiative", () => {
    const dispatched: any[] = [];
    const widget = ArmorInitiativeSpeed({
      id: "ais-1",
      boundValues: {
        armorClass: 18,
        initiative: 2,
        speed: "30 ft",
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    assert.equal(widget.armorClass, 18);
    widget.clickInitiative();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d20 + 2");
    assert.equal(dispatched[0].initiative, 2);
  });

  it("WHEN a user clicks Spend Hit Die in HitDiceAndDeathSaves, HitDiceAndDeathSaves dispatches a TrameCommand.RollDice command for 1d{sides} + conModifier and dispatches a TrameCommand.UpdateActorSheet command decrementing hitDiceCurrent by 1", () => {
    const dispatched: any[] = [];
    const widget = HitDiceAndDeathSaves({
      id: "hd-ds-1",
      boundValues: {
        hitDiceCurrent: 4,
        hitDiceMax: 5,
        hitDieSides: 10,
        conModifier: 3,
        deathSuccesses: 0,
        deathFailures: 0,
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.spendHitDie();
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d10 + 3");
    assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[1].hitDiceCurrent, 3);
  });

  it("WHEN a death save roll evaluates to 1 in HitDiceAndDeathSaves, HitDiceAndDeathSaves dispatches a TrameCommand.UpdateActorSheet command incrementing deathFailures by 2", () => {
    const dispatched: any[] = [];
    const widget = HitDiceAndDeathSaves({
      id: "hd-ds-1",
      boundValues: {
        deathSuccesses: 0,
        deathFailures: 0,
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.evaluateDeathSaveResult(1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].deathFailures, 2);
  });

  it("WHEN a death save roll evaluates between 2 and 9 inclusive in HitDiceAndDeathSaves, HitDiceAndDeathSaves dispatches a TrameCommand.UpdateActorSheet command incrementing deathFailures by 1", () => {
    const dispatched: any[] = [];
    const widget = HitDiceAndDeathSaves({
      id: "hd-ds-1",
      boundValues: {
        deathSuccesses: 1,
        deathFailures: 1,
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.evaluateDeathSaveResult(5);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].deathFailures, 2);
  });

  it("WHEN a death save roll evaluates between 10 and 19 inclusive in HitDiceAndDeathSaves, HitDiceAndDeathSaves dispatches a TrameCommand.UpdateActorSheet command incrementing deathSuccesses by 1", () => {
    const dispatched: any[] = [];
    const widget = HitDiceAndDeathSaves({
      id: "hd-ds-1",
      boundValues: {
        deathSuccesses: 1,
        deathFailures: 2,
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.evaluateDeathSaveResult(14);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].deathSuccesses, 2);
  });

  it("WHEN a death save roll evaluates to 20 in HitDiceAndDeathSaves, HitDiceAndDeathSaves dispatches a TrameCommand.UpdateActorSheet command resetting death counters to 0 and incrementing current hit points by 1", () => {
    const dispatched: any[] = [];
    const widget = HitDiceAndDeathSaves({
      id: "hd-ds-1",
      boundValues: {
        deathSuccesses: 2,
        deathFailures: 2,
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

  it("WHEN a user clicks an attack roll button in AttackActionTable, AttackActionTable dispatches a TrameCommand.RollDice command with formula 1d20 + attackBonus", () => {
    const dispatched: any[] = [];
    const widget = AttackActionTable({
      id: "attacks-1",
      boundValues: {
        attacks: [
          { id: "atk-longsword", name: "Longsword", attackBonus: 6, damageFormula: "1d8 + 4", damageType: "slashing" },
        ],
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.clickAttack("atk-longsword");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d20 + 6");

    widget.clickDamage("atk-longsword");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].cmd, "ROLL_DICE");
    assert.equal(dispatched[1].formula, "1d8 + 4");
  });

  it("WHEN a user clicks cast on an area-of-effect spell in SpellbookAccordion, SpellbookAccordion dispatches a TrameCommand.ProjectAoE command and decrements the corresponding spell slot by 1 when autoDeductSlots is true", () => {
    const dispatched: any[] = [];
    const widget = SpellbookAccordion({
      id: "spellbook-1",
      boundValues: {
        slots: {
          slot_3: { current: 2, max: 2 },
        },
        spells: [
          { id: "sp-fireball", name: "Fireball", level: 3, requiresAoE: true },
          { id: "sp-magic-missile", name: "Magic Missile", level: 1, requiresAoE: false },
        ],
        spellSaveDc: 15,
        spellAttackBonus: 7,
      },
      options: {
        autoDeductSlots: true,
      },
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.castSpell("sp-fireball");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].cmd, "PROJECT_AOE");
    assert.equal(dispatched[0].spellId, "sp-fireball");
    assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[1].current, 1);

    widget.castSpell("sp-magic-missile");
    assert.equal(dispatched[2].cmd, "ROLL_DICE");
  });

  it("WHEN a user clicks the remove button on a condition badge in ConditionBadgeStrip, ConditionBadgeStrip dispatches a TrameCommand.UpdateActorSheet command removing that condition identifier", () => {
    const dispatched: any[] = [];
    const widget = ConditionBadgeStrip({
      id: "conditions-1",
      boundValues: {
        conditions: ["Poisoned", "Blinded"],
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.removeCondition("Poisoned");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].removedConditionId, "Poisoned");
    assert.deepEqual(dispatched[0].conditions, ["Blinded"]);
  });

  it("WHEN a user edits the text in NotesMarkdownPane, NotesMarkdownPane sanitizes HTML elements and dispatches a TrameCommand.UpdateActorSheet command with the updated text", () => {
    const dispatched: any[] = [];
    const widget = NotesMarkdownPane({
      id: "notes-1",
      boundValues: {
        bio: "Heroic warrior",
        notes: "Secret plans",
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    assert.equal(sanitizeHtml("<script>alert('xss')</script><b>Clean</b>"), "Clean");

    widget.editNotes("<p>Hello</p><script>evil()</script>");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].notes, "Hello");
    assert.equal(dispatched[0].text, "Hello");
  });

  it("renders canonical widgets declaratively via DeclarativeSheetRenderer and dispatches commands", () => {
    WidgetRegistry.registerDefaults();

    const tree: SheetLayoutTree = {
      systemId: "dnd5e",
      version: "1.0.0",
      root: {
        id: "inventory-widget",
        kind: "widget",
        widgetType: "InventoryContainerTree",
        bindings: {
          items: "sheet.items",
          currency: "sheet.currency",
        },
      },
    };

    const state = {
      sheet: {
        items: [
          { id: "item-bag", name: "Backpack", isContainer: true, containerId: null },
          { id: "item-potion", name: "Healing Potion", containerId: null },
        ],
        currency: { gp: 50 },
      },
    };

    const dispatched: any[] = [];
    const rendered = DeclarativeSheetRenderer.render(tree, state, undefined, (cmd) => dispatched.push(cmd));

    assert.ok(rendered.root);
    const widgetOut = (rendered.root as any).renderedOutput;
    assert.ok(widgetOut);
    widgetOut.moveItem("item-potion", "item-bag");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].itemId, "item-potion");
    assert.equal(dispatched[0].targetContainerId, "item-bag");
  });
});
