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

  it("WHEN a user adjusts the value in ResourceBar, ResourceBar dispatches a TrameCommand.UpdateActorSheet command with the updated numeric value", () => {
    const dispatched: any[] = [];
    const widget = ResourceBar({
      id: "hp-bar-1",
      boundValues: {
        current: 24,
        max: 30,
        temp: 5,
      },
      options: {
        label: "Hit Points",
        color: "#ff0000",
      },
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    assert.equal(widget.current, 24);
    assert.equal(widget.max, 30);
    assert.equal(widget.temp, 5);

    widget.updateValue(18);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].path, "current");
    assert.equal(dispatched[0].value, 18);
  });

  it("WHEN a user clicks a saving throw row in SavingThrowList, SavingThrowList dispatches a TrameCommand.RollDice command with formula 1d20 + saveModifier", () => {
    const dispatched: any[] = [];
    const widget = SavingThrowList({
      id: "saves-1",
      boundValues: {
        saves: {
          dex: { modifier: 4, proficient: true },
          wis: { modifier: -1, proficient: false },
        },
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.clickSave("dex");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d20 + 4");
    assert.equal(dispatched[0].ability, "dex");

    widget.clickSave("wis");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].cmd, "ROLL_DICE");
    assert.equal(dispatched[1].formula, "1d20 - 1");
  });

  it("WHEN a user clicks a skill row in SkillCheckList, SkillCheckList dispatches a TrameCommand.RollDice command with formula 1d20 + skillModifier", () => {
    const dispatched: any[] = [];
    const widget = SkillCheckList({
      id: "skills-1",
      boundValues: {
        skills: {
          stealth: { modifier: 5, proficiencyLevel: "proficient", passive: 15 },
          athletics: { modifier: -2, proficiencyLevel: "none", passive: 8 },
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

    widget.clickSkill("athletics");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].cmd, "ROLL_DICE");
    assert.equal(dispatched[1].formula, "1d20 - 2");
  });

  it("WHEN a user clicks the initiative card in ArmorInitiativeSpeed, ArmorInitiativeSpeed dispatches a TrameCommand.RollDice command with formula 1d20 + initiativeModifier", () => {
    const dispatched: any[] = [];
    const widget = ArmorInitiativeSpeed({
      id: "ais-1",
      boundValues: {
        armorClass: 16,
        initiative: 3,
        speed: 30,
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    assert.equal(widget.armorClass, 16);
    assert.equal(widget.initiative, 3);
    assert.equal(widget.speed, 30);

    widget.clickInitiative();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d20 + 3");
  });

  it("WHEN a user clicks spend hit die in HitDiceAndDeathSaves, HitDiceAndDeathSaves dispatches a TrameCommand.RollDice command and a TrameCommand.UpdateActorSheet command decrementing hitDiceCurrent", () => {
    const dispatched: any[] = [];
    const widget = HitDiceAndDeathSaves({
      id: "hdds-1",
      boundValues: {
        hitDiceCurrent: 4,
        hitDiceMax: 4,
        hitDieSides: 8,
        conModifier: 2,
        deathSuccesses: 0,
        deathFailures: 0,
        hpCurrent: 10,
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.spendHitDie();
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[0].formula, "1d8 + 2");
    assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[1].path, "hitDiceCurrent");
    assert.equal(dispatched[1].value, 3);
  });

  it("WHEN a user evaluates death saving throw roll results in HitDiceAndDeathSaves, HitDiceAndDeathSaves dispatches the appropriate death failure, death success, or revival commands matching threshold rules", () => {
    let dispatched: any[] = [];
    const widget = HitDiceAndDeathSaves({
      id: "hdds-death-test",
      boundValues: {
        hitDiceCurrent: 0,
        hitDiceMax: 4,
        hitDieSides: 8,
        conModifier: 0,
        deathSuccesses: 1,
        deathFailures: 0,
        hpCurrent: 0,
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    // Roll 1: Natural 1 adds 2 failures
    dispatched = [];
    widget.evaluateDeathSaveResult(1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].deathFailures, 2);

    // Roll 5: 2-9 adds 1 failure
    dispatched = [];
    widget.evaluateDeathSaveResult(5);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].deathFailures, 1);

    // Roll 15: 10-19 adds 1 success
    dispatched = [];
    widget.evaluateDeathSaveResult(15);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].deathSuccesses, 2);

    // Roll 20: Natural 20 revives with 1 HP and resets death counters
    dispatched = [];
    widget.evaluateDeathSaveResult(20);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].deathSuccesses, 0);
    assert.equal(dispatched[0].deathFailures, 0);
    assert.equal(dispatched[0].hpCurrent, 1);
  });

  it("WHEN a user clicks attack roll or damage roll in AttackActionTable, AttackActionTable dispatches the corresponding TrameCommand.RollDice commands", () => {
    const dispatched: any[] = [];
    const widget = AttackActionTable({
      id: "attacks-1",
      boundValues: {
        attacks: [
          {
            id: "atk-longsword",
            name: "Longsword",
            attackBonus: 6,
            damageFormula: "1d8 + 4",
            damageType: "slashing",
            range: "5 ft",
          },
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

  it("WHEN casting a spell with level1..level9 keys in SpellbookAccordion, SpellbookAccordion resolves the key correctly and dispatches UpdateActorSheet with slots.levelX.current", () => {
    const dispatched: any[] = [];
    const widget = SpellbookAccordion({
      id: "spellbook-dnd5e-keys",
      boundValues: {
        slots: {
          level1: { current: 4, max: 4 },
          level2: { current: 3, max: 3 },
        },
        spells: [
          { id: "sp-cure", name: "Cure Wounds", level: 1, requiresAoE: false },
        ],
        spellSaveDc: 13,
        spellAttackBonus: 5,
      },
      options: {
        autoDeductSlots: true,
      },
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.castSpell("sp-cure");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].cmd, "ROLL_DICE");
    assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[1].path, "slots.level1.current");
    assert.equal(dispatched[1].current, 3);

    widget.toggleSlotPip(1);
    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[2].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[2].path, "slots.level1.current");
  });

  it("WHEN a user moves an item or deletes an item in InventoryContainerTree, InventoryContainerTree dispatches the corresponding TrameCommand.UpdateActorSheet commands", () => {
    const dispatched: any[] = [];
    const widget = InventoryContainerTree({
      id: "inv-1",
      boundValues: {
        items: [
          { id: "item-potion", name: "Healing Potion", quantity: 1, unitWeight: 0.5, containerId: null },
        ],
        currency: { cp: 10, sp: 5, ep: 0, gp: 50, pp: 0 },
      },
      options: {},
      dispatchCommand: (cmd) => dispatched.push(cmd),
    });

    widget.moveItem("item-potion", "backpack-main");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].path, "items.item-potion.containerId");
    assert.equal(dispatched[0].containerId, "backpack-main");

    widget.removeItem("item-potion");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[1].action, "delete");
  });

  it("WHEN a user expands and collapses feature items in FeatureTraitList, FeatureTraitList tracks expanded state locally without dispatching network commands", () => {
    const widget = FeatureTraitList({
      id: "features-1",
      boundValues: {
        features: [
          { id: "feat-sneak-attack", name: "Sneak Attack", source: "Rogue", description: "Extra damage on advantage." },
        ],
      },
      options: {},
    });

    assert.equal(widget.isExpanded("feat-sneak-attack"), false);
    widget.toggleFeature("feat-sneak-attack");
    assert.equal(widget.isExpanded("feat-sneak-attack"), true);
    widget.toggleFeature("feat-sneak-attack");
    assert.equal(widget.isExpanded("feat-sneak-attack"), false);
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

    widget.editNotes("<script>bad()</script>Valid notes");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, "UPDATE_ACTOR_SHEET");
    assert.equal(dispatched[0].path, "notes");
    assert.equal(dispatched[0].notes, "Valid notes");
  });
});
