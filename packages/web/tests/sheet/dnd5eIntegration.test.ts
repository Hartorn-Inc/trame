import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeDnd5eSheetDerived,
  createDefaultActorData,
  DND5E_SHEET_LAYOUT,
} from "../../../game-systems/dnd5e/src/index.ts";
import {
  DeclarativeSheetRenderer,
  WidgetRegistry,
  type RenderedLayoutNode,
  type SheetLayoutNode,
  type SheetLayoutTree,
  type WidgetLayoutNode,
} from "../../src/sheet/index.ts";

function collectWidgetNodes(node: SheetLayoutNode | RenderedLayoutNode | null): Array<WidgetLayoutNode | RenderedLayoutNode> {
  if (!node) return [];
  const results: Array<WidgetLayoutNode | RenderedLayoutNode> = [];
  if (node.kind === "widget") {
    results.push(node);
  } else if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
    for (const child of node.children || []) {
      results.push(...collectWidgetNodes(child));
    }
  } else if (node.kind === "tabs") {
    for (const tab of node.tabs || []) {
      for (const child of tab.children || []) {
        results.push(...collectWidgetNodes(child));
      }
    }
  }
  return results;
}

function findWidgetById(node: SheetLayoutNode | RenderedLayoutNode | null, id: string): any {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
    for (const child of node.children || []) {
      const found = findWidgetById(child, id);
      if (found) return found;
    }
  } else if (node.kind === "tabs") {
    for (const tab of node.tabs || []) {
      for (const child of tab.children || []) {
        const found = findWidgetById(child, id);
        if (found) return found;
      }
    }
  }
  return null;
}

describe("D&D 5e Declarative Character Sheet Layout Integration Suite", () => {
  it("WHEN DeclarativeSheetRenderer evaluates DND5E_SHEET_LAYOUT AST, DND5E_SHEET_LAYOUT conforms to SheetLayoutTree schema referencing only registered widgets.", () => {
    assert.equal(DND5E_SHEET_LAYOUT.systemId, "dnd5e");
    assert.equal(DND5E_SHEET_LAYOUT.version, "1.0.0");
    assert.ok(DND5E_SHEET_LAYOUT.root);
    assert.equal(DND5E_SHEET_LAYOUT.root.kind, "section");
    assert.equal(DND5E_SHEET_LAYOUT.root.id, "dnd5e-sheet-root");

    WidgetRegistry.registerDefaults();

    const parsed = DeclarativeSheetRenderer.parse(DND5E_SHEET_LAYOUT, { isGm: true, isOwner: true });
    assert.ok(parsed.root);

    const allWidgets = collectWidgetNodes(parsed.root) as WidgetLayoutNode[];
    assert.ok(allWidgets.length >= 10, `Expected at least 10 widget nodes, found ${allWidgets.length}`);

    const expectedWidgetTypes = new Set([
      "StatBlock6",
      "ResourceBar",
      "SavingThrowList",
      "SkillCheckList",
      "ArmorInitiativeSpeed",
      "HitDiceAndDeathSaves",
      "AttackActionTable",
      "SpellbookAccordion",
      "InventoryContainerTree",
      "FeatureTraitList",
      "ConditionBadgeStrip",
      "NotesMarkdownPane",
    ]);

    for (const w of allWidgets) {
      assert.ok(
        expectedWidgetTypes.has(w.widgetType),
        `Layout widgetType ${w.widgetType} must be one of the 12 canonical widgets.`,
      );
      assert.ok(
        WidgetRegistry.has(w.widgetType),
        `WidgetRegistry must have registered implementation for ${w.widgetType}`,
      );
    }
  });

  it("WHEN DeclarativeSheetRenderer.render executes with complete D&D 5e actor data, it returns a bound component hierarchy with resolved boundValues.", () => {
    WidgetRegistry.registerDefaults();

    const actor = createDefaultActorData("hero-100", "Alathea Starbreeze");
    actor.abilities.str = { score: 14, saveProficiency: false };
    actor.abilities.dex = { score: 16, saveProficiency: true };
    actor.abilities.con = { score: 12, saveProficiency: false };
    actor.abilities.int = { score: 18, saveProficiency: true };
    actor.abilities.wis = { score: 10, saveProficiency: false };
    actor.abilities.cha = { score: 8, saveProficiency: false };
    actor.attributes.hp = { current: 32, max: 38, temp: 5 };
    actor.attributes.level = 5;
    actor.attributes.hitDiceCurrent = 5;
    actor.attributes.hitDiceMax = 5;
    actor.attributes.hitDieSize = 6;
    actor.attributes.spellcastingAbility = "int";
    actor.spellSlots = {
      level1: { current: 4, max: 4 },
      level2: { current: 3, max: 3 },
      level3: { current: 2, max: 2 },
    };
    actor.conditions = [
      { id: "poisoned", name: "Poisoned", durationRounds: 3, trigger: "ROUNDS" },
    ];

    const derived = computeDnd5eSheetDerived(actor);

    const customSheet = {
      ...actor,
      bio: "A cunning elven wizard from the northern citadels.",
      notes: "Carries ancient scroll deciphering ritual.",
      currency: { cp: 10, sp: 20, ep: 0, gp: 150, pp: 5 },
      items: [
        { id: "item-spellbook", name: "Spellbook", quantity: 1, unitWeight: 3, containerId: null },
        { id: "item-wand", name: "Wand of Magic Missiles", quantity: 1, unitWeight: 1, containerId: null },
      ],
    };

    const customDerived = {
      ...derived,
      speed: 30,
      attacks: [
        { id: "atk-dagger", name: "Dagger", attackBonus: 6, damageFormula: "1d4 + 3", damageType: "piercing", range: "20/60" },
        { id: "atk-rayoffrost", name: "Ray of Frost", attackBonus: 7, damageFormula: "2d8", damageType: "cold", range: "60 ft" },
      ],
      spells: [
        { id: "spl-shield", name: "Shield", level: 1, castingTime: "1 reaction" },
        { id: "spl-fireball", name: "Fireball", level: 3, requiresAoE: true, aoeShape: { type: "sphere", radiusFt: 20 } },
      ],
      features: [
        { id: "feat-arcane-recovery", name: "Arcane Recovery", source: "Wizard Class", description: "Regain spell slots during short rest." },
        { id: "feat-darkvision", name: "Darkvision", source: "Elf Ancestry", description: "See in darkness up to 60 feet." },
      ],
    };

    const actorState = {
      sheet: customSheet,
      derived: customDerived,
    };

    const rendered = DeclarativeSheetRenderer.render(DND5E_SHEET_LAYOUT, actorState, {
      isGm: true,
      isOwner: true,
      role: "GM",
    });

    assert.ok(rendered);
    assert.equal(rendered.systemId, "dnd5e");
    assert.ok(rendered.root);

    const hpBar = findWidgetById(rendered.root, "dnd5e-hp-bar");
    assert.ok(hpBar);
    assert.equal(hpBar.boundValues.current, 32);
    assert.equal(hpBar.boundValues.max, 38);
    assert.equal(hpBar.boundValues.temp, 5);

    const combatStats = findWidgetById(rendered.root, "dnd5e-combat-stats");
    assert.ok(combatStats);
    assert.equal(combatStats.boundValues.armorClass, 13);
    assert.equal(combatStats.boundValues.initiative, 3);
    assert.equal(combatStats.boundValues.speed, 30);

    const statblock = findWidgetById(rendered.root, "dnd5e-statblock-abilities");
    assert.ok(statblock);
    assert.equal(statblock.boundValues.abilities.int.score, 18);

    const saves = findWidgetById(rendered.root, "dnd5e-saving-throws");
    assert.ok(saves);
    assert.equal(saves.boundValues.saves.int.modifier, 7);
    assert.equal(saves.boundValues.saves.int.proficient, true);

    const skills = findWidgetById(rendered.root, "dnd5e-skill-checks");
    assert.ok(skills);
    assert.ok(skills.boundValues.skills.stealth !== undefined);

    const attacks = findWidgetById(rendered.root, "dnd5e-actions-attacks");
    assert.ok(attacks);
    assert.equal(attacks.renderedOutput.attacks.length, 2);
    assert.equal(attacks.renderedOutput.attacks[0].name, "Dagger");

    const spellbook = findWidgetById(rendered.root, "dnd5e-spellbook-accordion");
    assert.ok(spellbook);
    assert.equal(spellbook.boundValues.spells.length, 2);
    assert.equal(spellbook.boundValues.spellSaveDc, 15);
    assert.equal(spellbook.boundValues.spellAttackBonus, 7);

    const inventory = findWidgetById(rendered.root, "dnd5e-inventory-tree");
    assert.ok(inventory);
    assert.equal(inventory.renderedOutput.items.length, 2);
    assert.equal(inventory.renderedOutput.currency.gp, 150);
  });

  it("WHEN a user triggers an ability check, saving throw, weapon attack, or spell cast on the rendered D&D 5e sheet, the corresponding widget dispatches a valid TrameCommand payload.", () => {
    WidgetRegistry.registerDefaults();

    const actor = createDefaultActorData("hero-101", "Brog the Barbarian");
    actor.abilities.str = { score: 18, saveProficiency: true };
    actor.abilities.dex = { score: 14, saveProficiency: false };
    actor.attributes.hp = { current: 45, max: 45, temp: 0 };
    actor.attributes.level = 4;
    actor.spellSlots = { level1: { current: 2, max: 2 } };

    const derived = computeDnd5eSheetDerived(actor);

    const actorState = {
      sheet: actor,
      derived: {
        ...derived,
        attacks: [
          { id: "atk-greataxe", name: "Greataxe", attackBonus: 6, damageFormula: "1d12 + 4", damageType: "slashing" },
        ],
        spells: [
          { id: "spl-burning-hands", name: "Burning Hands", level: 1, requiresAoE: true, aoeShape: { type: "cone", distanceFt: 15 } },
          { id: "spl-magic-missile", name: "Magic Missile", level: 1, requiresAoE: false },
        ],
      },
    };

    const dispatchedCommands: any[] = [];
    const rendered = DeclarativeSheetRenderer.render(
      DND5E_SHEET_LAYOUT,
      actorState,
      { isGm: true, isOwner: true },
      (cmd) => dispatchedCommands.push(cmd),
    );

    assert.ok(rendered.root);

    const abilities = findWidgetById(rendered.root, "dnd5e-statblock-abilities");
    abilities.renderedOutput.clickAbility("str");
    assert.equal(dispatchedCommands.length, 1);
    assert.equal(dispatchedCommands[0].cmd, "ROLL_DICE");
    assert.equal(dispatchedCommands[0].ability, "str");
    assert.equal(dispatchedCommands[0].expression, "1d20+4");

    const saves = findWidgetById(rendered.root, "dnd5e-saving-throws");
    saves.renderedOutput.clickSave("str");
    assert.equal(dispatchedCommands.length, 2);
    assert.equal(dispatchedCommands[1].cmd, "ROLL_DICE");
    assert.equal(dispatchedCommands[1].formula, "1d20 + 6");

    const attacks = findWidgetById(rendered.root, "dnd5e-actions-attacks");
    attacks.renderedOutput.clickAttack("atk-greataxe");
    assert.equal(dispatchedCommands.length, 3);
    assert.equal(dispatchedCommands[2].cmd, "ROLL_DICE");
    assert.equal(dispatchedCommands[2].name, "Greataxe");
    assert.equal(dispatchedCommands[2].expression, "1d20+6");

    attacks.renderedOutput.clickDamage("atk-greataxe");
    assert.equal(dispatchedCommands.length, 4);
    assert.equal(dispatchedCommands[3].cmd, "ROLL_DICE");
    assert.equal(dispatchedCommands[3].formula, "1d12 + 4");

    const spellbook = findWidgetById(rendered.root, "dnd5e-spellbook-accordion");
    spellbook.renderedOutput.castSpell("spl-burning-hands");
    assert.ok(dispatchedCommands.length >= 5);
    const aoeCmd = dispatchedCommands.find((c) => c.cmd === "PROJECT_AOE");
    assert.ok(aoeCmd);
    assert.equal(aoeCmd.name, "Burning Hands");

    const singleSpellIndex = dispatchedCommands.length;
    spellbook.renderedOutput.castSpell("spl-magic-missile");
    const diceSpellCmd = dispatchedCommands[singleSpellIndex];
    assert.ok(diceSpellCmd);
    assert.equal(diceSpellCmd.cmd, "ROLL_DICE");
    assert.equal(diceSpellCmd.name, "Magic Missile");
  });

  it("WHEN viewer context is non-owner and non-GM, DeclarativeSheetRenderer omits OWNER_ONLY tabs and nodes from DND5E_SHEET_LAYOUT.", () => {
    WidgetRegistry.registerDefaults();
    const actor = createDefaultActorData("hero-102", "Private Character");
    const derived = computeDnd5eSheetDerived(actor);
    const actorState = { sheet: actor, derived };

    const rendered = DeclarativeSheetRenderer.render(
      DND5E_SHEET_LAYOUT,
      actorState,
      { isGm: false, isOwner: false, role: "PLAYER", userId: "other-user", actorOwnerId: "hero-owner" },
    );

    assert.ok(rendered.root);
    const notesWidget = findWidgetById(rendered.root, "dnd5e-notes-pane");
    assert.equal(notesWidget, null, "OWNER_ONLY notes widget must not be rendered for non-owner player");
  });
});
