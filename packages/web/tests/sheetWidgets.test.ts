import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DeclarativeSheetRenderer,
  type DeclarativeSheetMountOptions,
} from "../src/sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../src/sheet/WidgetRegistry.ts";
import {
  StatBlock6Widget,
  ArmorInitiativeSpeedWidget,
  HitDiceAndDeathSavesWidget,
  ResourceBarWidget,
} from "../src/sheet/widgets/index.ts";
import {
  MobileCompanionLayout,
  LightweightElement,
  isMobileCompanionMode,
} from "../src/mobile/companionMode.ts";
import type { SheetLayoutTree } from "../src/sheet/types.ts";

function createCompleteTestSheet(): SheetLayoutTree {
  return {
    systemId: "dnd5e",
    version: "1.0.0",
    root: {
      id: "root-section",
      kind: "section",
      title: "Character Sheet",
      children: [
        {
          id: "resource-hp",
          kind: "widget",
          widgetType: "ResourceBar",
          bindings: {
            current: "sheet.hp.current",
            max: "sheet.hp.max",
            temp: "sheet.hp.temp",
          },
        },
        {
          id: "statblock",
          kind: "widget",
          widgetType: "StatBlock6",
          bindings: {
            abilities: "sheet.abilities",
          },
        },
        {
          id: "combat-stats",
          kind: "widget",
          widgetType: "ArmorInitiativeSpeed",
          bindings: {
            armorClass: "derived.armorClass",
            initiative: "derived.initiativeBonus",
            speed: "derived.speed",
          },
        },
        {
          id: "hitdice-saves",
          kind: "widget",
          widgetType: "HitDiceAndDeathSaves",
          bindings: {
            hitDiceCurrent: "sheet.hitDiceCurrent",
            hitDiceMax: "sheet.hitDiceMax",
            hpCurrent: "sheet.hp.current",
            deathSuccesses: "sheet.deathSuccesses",
            deathFailures: "sheet.deathFailures",
          },
        },
        {
          id: "saves",
          kind: "widget",
          widgetType: "SavingThrowList",
          bindings: {
            saves: "derived.savingThrows",
          },
        },
        {
          id: "skills",
          kind: "widget",
          widgetType: "SkillCheckList",
          bindings: {
            skills: "derived.skills",
          },
        },
      ],
    },
  };
}

const sampleActorState = {
  sheet: {
    name: "Valeros",
    class: "Fighter",
    level: 5,
    hp: { current: 35, max: 48, temp: 5 },
    hitDiceCurrent: 4,
    hitDiceMax: 5,
    deathSuccesses: 1,
    deathFailures: 0,
    abilities: {
      str: { score: 18, modifier: 4 },
      dex: { score: 14, modifier: 2 },
      con: { score: 16, modifier: 3 },
      int: { score: 10, modifier: 0 },
      wis: { score: 12, modifier: 1 },
      cha: { score: 8, modifier: -1 },
    },
  },
  derived: {
    armorClass: 18,
    initiativeBonus: 2,
    speed: 30,
    savingThrows: {
      str: { modifier: 7, proficient: true },
      dex: { modifier: 2, proficient: false },
      con: { modifier: 6, proficient: true },
    },
    skills: {
      athletics: { modifier: 7, proficiencyRank: 1 },
      acrobatics: { modifier: 2, proficiencyRank: 0 },
      perception: { modifier: 4, proficiencyRank: 1 },
    },
  },
};

describe("Ticket #107: DeclarativeSheetRenderer PadlockEditMode, Tabular-Nums & Touch Target Suite", () => {
  beforeEach?.(() => {
    WidgetRegistry.registerDefaults();
  });

  describe("AC 1 & AC 4: PadlockEditMode Mounting and Toggle Behavior", () => {
    it("WHEN a user mounts DeclarativeSheetRenderer, the sheet header renders a button with data-testid='sheet-padlock-toggle' and aria-pressed='false' by default", () => {
      const container = new LightweightElement("div");
      const mountOptions: DeclarativeSheetMountOptions = {
        container,
        sheetLayout: createCompleteTestSheet(),
        actorState: sampleActorState,
      };

      const renderer = new DeclarativeSheetRenderer(mountOptions);
      renderer.mount();

      const toggleBtn = container.querySelector('[data-testid="sheet-padlock-toggle"]');
      assert.ok(toggleBtn, "header must contain button with data-testid='sheet-padlock-toggle'");
      assert.equal(toggleBtn.getAttribute("aria-pressed"), "false");
      assert.equal(toggleBtn.getAttribute("data-locked"), "true");
    });

    it("WHEN a user clicks the button with data-testid='sheet-padlock-toggle', the button toggles aria-pressed to 'true' and enables editing on all structural fields", () => {
      const container = new LightweightElement("div");
      const renderer = new DeclarativeSheetRenderer({
        container,
        sheetLayout: createCompleteTestSheet(),
        actorState: sampleActorState,
      });
      renderer.mount();

      const toggleBtn = container.querySelector('[data-testid="sheet-padlock-toggle"]');
      assert.ok(toggleBtn);
      assert.equal(toggleBtn.getAttribute("aria-pressed"), "false");

      // Click to unlock
      toggleBtn.click();
      assert.equal(toggleBtn.getAttribute("aria-pressed"), "true");
      assert.equal(toggleBtn.getAttribute("data-locked"), "false");
      assert.equal(renderer.isLocked(), false);

      // Click again to lock
      toggleBtn.click();
      assert.equal(toggleBtn.getAttribute("aria-pressed"), "false");
      assert.equal(toggleBtn.getAttribute("data-locked"), "true");
      assert.equal(renderer.isLocked(), true);
    });
  });

  describe("AC 2 & AC 3: Structural vs Operational Combat Field Gating under PadlockEditMode", () => {
    it("WHEN PadlockEditMode is locked with aria-pressed='false', DeclarativeSheetRenderer marks actor structural inputs including ability score values and proficiency checkboxes with disabled or readonly attributes", () => {
      const container = new LightweightElement("div");
      const renderer = new DeclarativeSheetRenderer({
        container,
        sheetLayout: createCompleteTestSheet(),
        actorState: sampleActorState,
      });
      renderer.mount();

      // Check ability score steppers / inputs are absent or disabled/readonly in locked mode
      const decStrBtn = container.querySelector('[data-testid="ability-dec-str"]');
      assert.equal(decStrBtn, null, "Ability steppers should not be active in locked mode");

      // Check proficiency toggles are disabled or rendered non-interactively
      const saveProfToggle = container.querySelector('[data-testid="save-prof-toggle-str"]');
      assert.equal(saveProfToggle, null, "Saving throw proficiency toggles should not be active in locked mode");

      const skillCycleBtn = container.querySelector('[data-testid="skill-prof-cycle-athletics"]');
      assert.equal(skillCycleBtn, null, "Skill proficiency rank cycling buttons should not be active in locked mode");

      // Check max HP is locked
      const maxHpInput = container.querySelector('[data-testid="resource-input-max"]');
      assert.equal(maxHpInput, null, "Resource max input should not be editable in locked mode");
      const maxHpVal = container.querySelector('[data-testid="resource-max-val"]');
      assert.ok(maxHpVal, "Locked max HP should be displayed as static element");
    });

    it("WHEN PadlockEditMode is locked with aria-pressed='false', DeclarativeSheetRenderer maintains roll-button elements and HP increment or decrement buttons in an enabled and clickable state", () => {
      const container = new LightweightElement("div");
      const dispatched: unknown[] = [];
      const renderer = new DeclarativeSheetRenderer({
        container,
        sheetLayout: createCompleteTestSheet(),
        actorState: sampleActorState,
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });
      renderer.mount();

      // Operational roll controls remain enabled and clickable
      const strCard = container.querySelector('[data-testid="ability-card-str"]');
      assert.ok(strCard, "Ability roll card exists");
      assert.equal(strCard.getAttribute("role"), "button");
      strCard.click();
      assert.ok(dispatched.length > 0, "Clicking ability card in locked play mode must dispatch roll dice");

      // Operational HP input/steppers remain enabled
      const currentHpInput = container.querySelector('[data-testid="resource-input-current"]');
      assert.ok(currentHpInput, "Current HP input remains accessible for operational combat tracking");
      assert.equal(currentHpInput.getAttribute("disabled"), null);
      assert.equal(currentHpInput.getAttribute("readonly"), null);

      const tempHpInput = container.querySelector('[data-testid="resource-input-temp"]');
      assert.ok(tempHpInput, "Temp HP input remains accessible for operational combat tracking");
      assert.equal(tempHpInput.getAttribute("disabled"), null);
      assert.equal(tempHpInput.getAttribute("readonly"), null);
    });

    it("WHEN PadlockEditMode is unlocked with aria-pressed='true', structural edit controls become active and operational roll clicks switch to editing", () => {
      const container = new LightweightElement("div");
      const renderer = new DeclarativeSheetRenderer({
        container,
        sheetLayout: createCompleteTestSheet(),
        actorState: sampleActorState,
      });
      renderer.mount();
      renderer.setUnlocked(true);

      // Now structural editing controls exist
      const decStrBtn = container.querySelector('[data-testid="ability-dec-str"]');
      const incStrBtn = container.querySelector('[data-testid="ability-inc-str"]');
      assert.ok(decStrBtn, "Ability score decrement stepper is active in unlocked mode");
      assert.ok(incStrBtn, "Ability score increment stepper is active in unlocked mode");

      const saveProfToggle = container.querySelector('[data-testid="save-prof-toggle-str"]');
      assert.ok(saveProfToggle, "Saving throw proficiency toggle is active in unlocked mode");

      const skillCycleBtn = container.querySelector('[data-testid="skill-prof-cycle-athletics"]');
      assert.ok(skillCycleBtn, "Skill proficiency cycling is active in unlocked mode");

      const maxHpInput = container.querySelector('[data-testid="resource-input-max"]');
      assert.ok(maxHpInput, "Resource max input is active in unlocked mode");
    });
  });

  describe("AC 5: Tabular-Nums Typography Discipline across Canonical Widgets", () => {
    const tabularCases = [
      {
        widgetName: "StatBlock6Widget",
        render: () =>
          StatBlock6Widget({
            id: "statblock-test",
            boundValues: { abilities: { str: { score: 18, modifier: 4 } } },
            options: { displayOrder: ["str"] },
            isLocked: true,
          }),
        expectedSelectors: [".atlas-tabular-nums"],
      },
      {
        widgetName: "ArmorInitiativeSpeedWidget",
        render: () =>
          ArmorInitiativeSpeedWidget({
            id: "ais-test",
            boundValues: { armorClass: 16, initiativeBonus: 3, speed: 30 },
          }),
        expectedSelectors: [".atlas-tabular-nums"],
      },
      {
        widgetName: "HitDiceAndDeathSavesWidget",
        render: () =>
          HitDiceAndDeathSavesWidget({
            id: "hdds-test",
            boundValues: { hitDiceCurrent: 3, hitDiceMax: 5, hitDieSides: 8 },
          }),
        expectedSelectors: [".atlas-tabular-nums"],
      },
      {
        widgetName: "ResourceBarWidget",
        render: () =>
          ResourceBarWidget({
            id: "rb-test",
            boundValues: { current: 24, max: 30, temp: 5 },
            isLocked: true,
          }),
        expectedSelectors: [".atlas-tabular-nums"],
      },
    ];

    for (const tc of tabularCases) {
      it(`WHEN WidgetRegistry renders ${tc.widgetName}, each numeric container includes CSS class .atlas-tabular-nums`, () => {
        const vnode = tc.render() as any;
        assert.ok(vnode, `${tc.widgetName} must render a VNode`);

        const serializeClasses = (node: any): string[] => {
          if (!node || typeof node !== "object") return [];
          const classes: string[] = [];
          const cls = node.props?.class || node.props?.className;
          if (typeof cls === "string") {
            classes.push(...cls.split(/\s+/));
          }
          const kids = Array.isArray(node.props?.children)
            ? node.props.children
            : node.props?.children
            ? [node.props.children]
            : [];
          for (const kid of kids) {
            classes.push(...serializeClasses(kid));
          }
          return classes;
        };

        const classes = serializeClasses(vnode);
        const hasTabular = classes.some((c) => c === "atlas-tabular-nums");
        assert.ok(
          hasTabular,
          `Expected ${tc.widgetName} to include 'atlas-tabular-nums' in its class hierarchy`,
        );
      });
    }
  });

  describe("AC 6: MobileCompanionLayout 44x44px Minimum Touch Hit Targets (< 768px)", () => {
    const viewports = [320, 390, 500, 767];
    for (const width of viewports) {
      it(`WHEN MobileCompanionLayout renders navigation tabs with viewport ${width}px (< 768px), each bottom tab button exposes minimum dimensions of 44px by 44px`, () => {
        assert.equal(isMobileCompanionMode(width), true);

        const container = new LightweightElement("div");
        const layout = new MobileCompanionLayout(container, width);
        layout.mount();

        const tabIds = [
          "tab-button-sheet",
          "tab-button-dice",
          "tab-button-inventory",
          "tab-button-journal",
        ];

        for (const tabId of tabIds) {
          const btn = container.querySelector(`[data-testid="${tabId}"]`);
          assert.ok(btn, `Tab button ${tabId} must be present`);

          // Check minimum dimensions via style attribute, rect, or dimensions contract
          const style = btn.getAttribute("style") ?? "";
          assert.match(
            style,
            /min-width:\s*44px/i,
            `Tab button ${tabId} must enforce min-width: 44px`,
          );
          assert.match(
            style,
            /min-height:\s*44px/i,
            `Tab button ${tabId} must enforce min-height: 44px`,
          );

          const dims = layout.getTabButtonDimensions(tabId);
          assert.ok(dims.minWidth >= 44, `minWidth ${dims.minWidth} must be >= 44`);
          assert.ok(dims.minHeight >= 44, `minHeight ${dims.minHeight} must be >= 44`);

          const rect = btn.getBoundingClientRect();
          assert.ok(rect.width >= 44, `rect.width ${rect.width} must be >= 44`);
          assert.ok(rect.height >= 44, `rect.height ${rect.height} must be >= 44`);
        }
      });
    }
  });
});
