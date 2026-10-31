import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeclarativeSheetRenderer } from "../../src/sheet/DeclarativeSheetRenderer.ts";
import { BindingResolver } from "../../src/sheet/binding.ts";
import { WidgetRegistry } from "../../src/sheet/WidgetRegistry.ts";
import {
  DuplicateNodeIdError,
  type SheetLayoutNode,
  type SheetLayoutTree,
  type WidgetLayoutNode,
} from "../../src/sheet/types.ts";

function createSampleSheetTree(): SheetLayoutTree {
  return {
    systemId: "dnd5e",
    version: "1.0.0",
    root: {
      id: "root-section",
      kind: "section",
      title: "Character Sheet",
      visibilityTier: "PUBLIC",
      children: [
        {
          id: "core-column",
          kind: "column",
          visibilityTier: "PUBLIC",
          children: [
            {
              id: "statblock-widget",
              kind: "widget",
              widgetType: "StatBlock6",
              visibilityTier: "PUBLIC",
              bindings: {
                abilities: "sheet.abilities",
              },
              options: {
                displayOrder: ["str", "dex", "con", "int", "wis", "cha"],
              },
            },
            {
              id: "hp-bar-widget",
              kind: "widget",
              widgetType: "ResourceBar",
              visibilityTier: "PUBLIC",
              bindings: {
                current: "sheet.hp.current",
                max: "sheet.hp.max",
                temp: "sheet.hp.temp",
              },
            },
          ],
        },
        {
          id: "owner-notes-row",
          kind: "row",
          visibilityTier: "OWNER_ONLY",
          children: [
            {
              id: "private-bio-widget",
              kind: "widget",
              widgetType: "NotesMarkdownPane",
              visibilityTier: "OWNER_ONLY",
              bindings: {
                bio: "sheet.bio",
                notes: "sheet.notes",
              },
            },
          ],
        },
        {
          id: "gm-secrets-section",
          kind: "section",
          title: "GM Lore & Secrets",
          visibilityTier: "GM_ONLY",
          children: [
            {
              id: "gm-tracker-widget",
              kind: "widget",
              widgetType: "CustomTracker",
              visibilityTier: "GM_ONLY",
              bindings: {
                notes: "sheet.gmNotes",
              },
            },
          ],
        },
        {
          id: "navigation-tabs",
          kind: "tabs",
          defaultTabId: "tab-combat",
          visibilityTier: "PUBLIC",
          tabs: [
            {
              id: "tab-combat",
              label: "Combat",
              visibilityTier: "PUBLIC",
              children: [
                {
                  id: "attack-table-widget",
                  kind: "widget",
                  widgetType: "AttackActionTable",
                  visibilityTier: "PUBLIC",
                  bindings: {
                    attacks: "derived.attacks",
                  },
                },
              ],
            },
            {
              id: "tab-gm-audit",
              label: "GM Audit",
              visibilityTier: "GM_ONLY",
              children: [
                {
                  id: "audit-log-widget",
                  kind: "widget",
                  widgetType: "CustomTracker",
                  visibilityTier: "GM_ONLY",
                  bindings: {
                    audit: "derived.auditLog",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("DeclarativeSheetRenderer AST Parsing & Uniqueness", () => {
  it("parses a valid SheetLayoutTree and returns all declared layout nodes", () => {
    const tree = createSampleSheetTree();
    const parsed = DeclarativeSheetRenderer.parse(tree);

    assert.equal(parsed.systemId, "dnd5e");
    assert.equal(parsed.version, "1.0.0");
    assert.ok(parsed.root);
    assert.equal(parsed.root.id, "root-section");
    assert.equal(parsed.root.kind, "section");

    const statBlock = DeclarativeSheetRenderer.findNodeById(parsed, "statblock-widget");
    assert.ok(statBlock);
    assert.equal(statBlock.kind, "widget");
    assert.equal((statBlock as WidgetLayoutNode).widgetType, "StatBlock6");

    const ownerRow = DeclarativeSheetRenderer.findNodeById(parsed, "owner-notes-row");
    assert.ok(ownerRow);
    assert.equal(ownerRow.kind, "row");

    const gmSection = DeclarativeSheetRenderer.findNodeById(parsed, "gm-secrets-section");
    assert.ok(gmSection);
    assert.equal(gmSection.kind, "section");

    const tabs = DeclarativeSheetRenderer.findNodeById(parsed, "navigation-tabs");
    assert.ok(tabs);
    assert.equal(tabs.kind, "tabs");
  });

  it("throws DuplicateNodeIdError when identical identifiers occur across direct nodes", () => {
    const tree = createSampleSheetTree();
    const root = tree.root as SheetLayoutNode & { children: SheetLayoutNode[] };
    root.children.push({
      id: "statblock-widget",
      kind: "widget",
      widgetType: "StatBlock6",
      bindings: {},
    });

    assert.throws(
      () => DeclarativeSheetRenderer.parse(tree),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateNodeIdError);
        assert.equal(err.duplicateId, "statblock-widget");
        assert.ok(err.message.includes("statblock-widget"));
        return true;
      },
    );
  });

  it("throws DuplicateNodeIdError when duplicate identifiers occur inside tabs", () => {
    const tree: SheetLayoutTree = {
      systemId: "dnd5e",
      version: "1.0.0",
      root: {
        id: "root",
        kind: "section",
        children: [
          {
            id: "tabs-1",
            kind: "tabs",
            defaultTabId: "tab-a",
            tabs: [
              {
                id: "tab-a",
                label: "Tab A",
                children: [
                  {
                    id: "shared-id",
                    kind: "widget",
                    widgetType: "StatBlock6",
                    bindings: {},
                  },
                ],
              },
              {
                id: "tab-b",
                label: "Tab B",
                children: [
                  {
                    id: "shared-id",
                    kind: "widget",
                    widgetType: "ResourceBar",
                    bindings: {},
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    assert.throws(
      () => DeclarativeSheetRenderer.parse(tree),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateNodeIdError);
        assert.equal(err.duplicateId, "shared-id");
        return true;
      },
    );
  });
});

describe("DeclarativeSheetRenderer VisibilityTier Rules", () => {
  it("omits GM_ONLY nodes and their children for a non-GM client", () => {
    const tree = createSampleSheetTree();
    const parsed = DeclarativeSheetRenderer.parse(tree, {
      isGm: false,
      isOwner: true,
      role: "PLAYER",
    });

    const gmSection = DeclarativeSheetRenderer.findNodeById(parsed, "gm-secrets-section");
    assert.equal(gmSection, null);

    const gmWidget = DeclarativeSheetRenderer.findNodeById(parsed, "gm-tracker-widget");
    assert.equal(gmWidget, null);

    const auditWidget = DeclarativeSheetRenderer.findNodeById(parsed, "audit-log-widget");
    assert.equal(auditWidget, null);

    const ownerRow = DeclarativeSheetRenderer.findNodeById(parsed, "owner-notes-row");
    assert.ok(ownerRow);
  });

  it("includes GM_ONLY nodes and their children for a GM client", () => {
    const tree = createSampleSheetTree();
    const parsed = DeclarativeSheetRenderer.parse(tree, {
      isGm: true,
      isOwner: false,
      role: "GM",
    });

    const gmSection = DeclarativeSheetRenderer.findNodeById(parsed, "gm-secrets-section");
    assert.ok(gmSection);
    const gmWidget = DeclarativeSheetRenderer.findNodeById(parsed, "gm-tracker-widget");
    assert.ok(gmWidget);

    const auditWidget = DeclarativeSheetRenderer.findNodeById(parsed, "audit-log-widget");
    assert.ok(auditWidget);
  });

  it("omits OWNER_ONLY nodes and their children for a non-owner client", () => {
    const tree = createSampleSheetTree();
    const parsed = DeclarativeSheetRenderer.parse(tree, {
      isGm: false,
      isOwner: false,
      role: "PLAYER",
      userId: "player-bob",
      actorOwnerId: "player-alice",
    });

    const ownerRow = DeclarativeSheetRenderer.findNodeById(parsed, "owner-notes-row");
    assert.equal(ownerRow, null);
    const privateBio = DeclarativeSheetRenderer.findNodeById(parsed, "private-bio-widget");
    assert.equal(privateBio, null);

    const gmSection = DeclarativeSheetRenderer.findNodeById(parsed, "gm-secrets-section");
    assert.equal(gmSection, null);

    const coreCol = DeclarativeSheetRenderer.findNodeById(parsed, "core-column");
    assert.ok(coreCol);
  });

  it("includes OWNER_ONLY nodes for owner clients and GM clients", () => {
    const tree = createSampleSheetTree();

    const ownerParsed = DeclarativeSheetRenderer.parse(tree, {
      isGm: false,
      isOwner: true,
    });
    assert.ok(DeclarativeSheetRenderer.findNodeById(ownerParsed, "owner-notes-row"));
    assert.ok(DeclarativeSheetRenderer.findNodeById(ownerParsed, "private-bio-widget"));

    const gmParsed = DeclarativeSheetRenderer.parse(tree, {
      isGm: true,
      isOwner: false,
    });
    assert.ok(DeclarativeSheetRenderer.findNodeById(gmParsed, "owner-notes-row"));
    assert.ok(DeclarativeSheetRenderer.findNodeById(gmParsed, "private-bio-widget"));
  });

  it("omits the root node entirely when root visibility is unauthorized", () => {
    const tree: SheetLayoutTree = {
      systemId: "dnd5e",
      version: "1.0.0",
      root: {
        id: "gm-root",
        kind: "section",
        visibilityTier: "GM_ONLY",
        children: [
          {
            id: "child-widget",
            kind: "widget",
            widgetType: "StatBlock6",
            bindings: {},
          },
        ],
      },
    };

    const parsed = DeclarativeSheetRenderer.parse(tree, { isGm: false });
    assert.equal(parsed.root, null);
  });
});

describe("BindingResolver Data Traversal Engine", () => {
  const sampleState = {
    sheet: {
      name: "Ezren",
      level: 5,
      hp: { current: 38, max: 44, temp: 0 },
      hasShield: false,
      emptyBio: "",
      nullableDeity: null,
      abilities: {
        str: { score: 10, mod: 0 },
        int: { score: 18, mod: 4 },
      },
      inventory: [
        { id: "item-1", name: "Spellbook", weight: 3 },
        { id: "item-2", name: "Dagger", weight: 1 },
      ],
    },
    derived: {
      spellSaveDc: 15,
      spellAttackBonus: 7,
      attacks: [
        { name: "Fire Bolt", formula: "2d10" },
      ],
    },
  };

  it("resolves an existing dot-separated path and returns the exact bound value", () => {
    assert.equal(BindingResolver.resolve(sampleState, "sheet.name"), "Ezren");
    assert.equal(BindingResolver.resolve(sampleState, "sheet.level"), 5);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.hp.current"), 38);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.hp.temp"), 0);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.hasShield"), false);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.emptyBio"), "");
    assert.equal(BindingResolver.resolve(sampleState, "sheet.nullableDeity"), null);
    assert.equal(BindingResolver.resolve(sampleState, "derived.spellSaveDc"), 15);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.inventory.0.name"), "Spellbook");
  });

  it("resolves paths across combined state without explicit prefix", () => {
    assert.equal(BindingResolver.resolve(sampleState, "name"), "Ezren");
    assert.equal(BindingResolver.resolve(sampleState, "hp.current"), 38);
    assert.equal(BindingResolver.resolve(sampleState, "spellSaveDc"), 15);
  });

  it("returns null without throwing runtime exceptions for non-existent paths", () => {
    assert.equal(BindingResolver.resolve(sampleState, "sheet.nonexistent"), null);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.missing.deeply.nested.property"), null);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.nullableDeity.name"), null);
    assert.equal(BindingResolver.resolve(sampleState, "sheet.level.mod.extra"), null);
    assert.equal(BindingResolver.resolve(sampleState, ""), null);
    assert.equal(BindingResolver.resolve(sampleState, "   "), null);
    assert.equal(BindingResolver.resolve(null, "sheet.hp"), null);
    assert.equal(BindingResolver.resolve(undefined, "sheet.hp"), null);
    assert.equal(BindingResolver.resolve(42, "sheet.hp"), null);
  });

  it("resolves multiple bindings in a single batch", () => {
    const bindings = {
      charName: "sheet.name",
      currHp: "sheet.hp.current",
      missing: "sheet.unknown",
      dc: "derived.spellSaveDc",
    };
    const resolved = BindingResolver.resolveBindings(sampleState, bindings);
    assert.deepEqual(resolved, {
      charName: "Ezren",
      currHp: 38,
      missing: null,
      dc: 15,
    });
  });
});

describe("WidgetRegistry & Component Execution", () => {
  it("stores widget implementation upon register and retrieves it upon get", () => {
    const registry = new WidgetRegistry();
    const testStatBlock = {
      name: "StatBlockMock",
      render: () => "stat-block-rendered",
    };

    assert.equal(registry.has("StatBlock6"), false);
    registry.register("StatBlock6", testStatBlock);
    assert.equal(registry.has("StatBlock6"), true);
    assert.equal(registry.get("StatBlock6"), testStatBlock);

    assert.equal(registry.get("UnknownWidget"), undefined);
    assert.equal(registry.has("UnknownWidget"), false);

    assert.equal(registry.unregister("StatBlock6"), true);
    assert.equal(registry.has("StatBlock6"), false);
  });

  it("rejects empty or invalid widget type identifiers", () => {
    const registry = new WidgetRegistry();
    assert.throws(() => registry.register("", {}));
  });

  it("dispatches RollDice command when ability card click interaction triggers", () => {
    WidgetRegistry.clear();

    WidgetRegistry.register("StatBlock6", (context: import("../../src/sheet/WidgetRegistry.ts").WidgetRenderContext) => {
      const abilities = context.boundValues.abilities as Record<string, { score: number; mod: number }> | undefined;
      return {
        id: context.id,
        triggerAbilityClick(abilityKey: string) {
          const ability = abilities?.[abilityKey];
          const mod = ability?.mod ?? 0;
          const sign = mod >= 0 ? `+${mod}` : `${mod}`;
          context.dispatchCommand?.({
            cmd: "ROLL_DICE",
            expression: `1d20${sign}`,
            visibility: "PUBLIC",
            reason: `Ability check: ${abilityKey}`,
          });
        },
      };
    });

    const tree: SheetLayoutTree = {
      systemId: "dnd5e",
      version: "1.0.0",
      root: {
        id: "root",
        kind: "section",
        children: [
          {
            id: "statblock",
            kind: "widget",
            widgetType: "StatBlock6",
            bindings: {
              abilities: "sheet.abilities",
            },
          },
        ],
      },
    };

    const actorState = {
      sheet: {
        abilities: {
          str: { score: 18, mod: 4 },
        },
      },
    };

    const dispatchedCommands: unknown[] = [];
    const renderedTree = DeclarativeSheetRenderer.render(
      tree,
      actorState,
      { isGm: true },
      (cmd) => dispatchedCommands.push(cmd),
    );

    assert.ok(renderedTree.root);
    const widgetNode = (renderedTree.root as any).children[0];
    assert.equal(widgetNode.id, "statblock");
    assert.equal(widgetNode.boundValues.abilities.str.score, 18);

    widgetNode.renderedOutput.triggerAbilityClick("str");
    assert.equal(dispatchedCommands.length, 1);
    assert.deepEqual(dispatchedCommands[0], {
      cmd: "ROLL_DICE",
      expression: "1d20+4",
      visibility: "PUBLIC",
      reason: "Ability check: str",
    });
  });
});
