import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RestModal, type RestModalProps, type DiceRollService } from "../../src/components/modals/RestModal.tsx";
import { createDefaultActorData, type Dnd5eActorData } from "../../../game-systems/dnd5e/src/index.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

localeSignal.value = "en";

// Helper to render Preact component to mock DOM and clean up
async function renderModal(props: RestModalProps) {
  const { render, h, options } = await import("preact");
  options.debounceRendering = (cb: () => void) => cb();
  const doc = (globalThis as any).document || setupMockDom();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  render(h(RestModal, props), container);
  await new Promise((r) => setTimeout(r, 10));

  const unmount = () => {
    render(null, container);
    doc.body.removeChild(container);
    doc.activeElement = null;
  };

  const findByText = (text: string): any => {
    const walk = (node: any): any => {
      if (node.nodeType === 1) {
        if (node.textContent.includes(text)) {
          for (const c of node.childNodes) {
            const deeper = walk(c);
            if (deeper) return deeper;
          }
          return node;
        }
      }
      return null;
    };
    return walk(container);
  };

  const queryByText = (text: string): any => {
    return findByText(text);
  };

  const rerender = async (newProps: RestModalProps) => {
    render(h(RestModal, newProps), container);
    await new Promise((r) => setTimeout(r, 10));
  };

  return { container, unmount, findByText, queryByText, rerender };
}

function createTestActor(overrides?: Partial<Dnd5eActorData>): Dnd5eActorData {
  const actor = createDefaultActorData("actor-rest-1", "Alden Swift");
  actor.classId = "fighter";
  actor.attributes.level = 4;
  actor.attributes.hitDiceMax = 4;
  actor.attributes.hitDiceCurrent = 3;
  actor.attributes.hitDieSize = 10;
  actor.attributes.hp = { current: 12, max: 34, temp: 5 };
  actor.attributes.exhaustion = 1;
  actor.attributes.deathSaves = { successes: 1, failures: 1 };
  actor.abilities.con = { score: 14, saveProficiency: true }; // +2 modifier
  actor.resources = {
    second_wind: {
      current: 0,
      max: 1,
      resetOn: "SHORT_REST",
    },
    action_surge: {
      current: 0,
      max: 1,
      resetOn: "SHORT_REST",
    },
    indomitable: {
      current: 0,
      max: 1,
      resetOn: "LONG_REST",
    },
  };
  actor.spellSlots = {
    level1: { current: 1, max: 4 },
    level2: { current: 0, max: 2 },
    pact: { current: 0, max: 2, slotLevel: 2 },
  };
  if (overrides) {
    Object.assign(actor, overrides);
    if (overrides.attributes) {
      actor.attributes = { ...actor.attributes, ...overrides.attributes };
    }
  }
  return actor;
}

describe("RestModal Component", () => {
  setupMockDom();

  describe("Modal Visibility & Escape Handling", () => {
    it("renders null when isOpen is false", async () => {
      const actor = createTestActor();
      const { container, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: false,
        onClose: () => {},
        onSave: () => {},
      });
      assert.equal(container.childNodes.length, 0);
      unmount();
    });

    it("closes when Escape key is pressed", async () => {
      let closed = false;
      const actor = createTestActor();
      const { container, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => { closed = true; },
        onSave: () => {},
      });
      const backdrop = container.querySelector("[role='dialog']");
      assert.ok(backdrop);
      backdrop.dispatchEvent({ type: "keydown", key: "Escape" });
      assert.equal(closed, true);
      unmount();
    });

    it("stops propagation on Escape key to prevent closing parent containers", async () => {
      let closed = false;
      let stopPropagationCalled = false;
      const actor = createTestActor();
      const { container, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => { closed = true; },
        onSave: () => {},
      });
      const backdrop = container.querySelector("[role='dialog']");
      assert.ok(backdrop);
      backdrop.dispatchEvent({
        type: "keydown",
        key: "Escape",
        stopPropagation: () => { stopPropagationCalled = true; },
      });
      assert.equal(closed, true);
      assert.equal(stopPropagationCalled, true);
      unmount();
    });

    it("stops propagation on Escape even when isSubmitting is true without closing modal", async () => {
      let closed = false;
      let stopPropagationCalled = false;
      let resolveSave: () => void = () => {};
      const slowSavePromise = new Promise<void>((resolve) => {
        resolveSave = resolve;
      });

      const actor = createTestActor();
      const { container, findByText, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => { closed = true; },
        onSave: () => slowSavePromise,
      });

      const confirmBtn = findByText("Confirm Short Rest");
      assert.ok(confirmBtn);
      confirmBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));

      const backdrop = container.querySelector("[role='dialog']");
      assert.ok(backdrop);
      backdrop.dispatchEvent({
        type: "keydown",
        key: "Escape",
        stopPropagation: () => { stopPropagationCalled = true; },
      });

      assert.equal(closed, false);
      assert.equal(stopPropagationCalled, true);

      resolveSave();
      await new Promise((r) => setTimeout(r, 20));
      unmount();
    });
  });

  describe("Short Rest Workflow (restType: 'short')", () => {
    it("displays current and max Hit Dice, HP and spending counter between 0 and hitDiceCurrent", async () => {
      const actor = createTestActor({
        attributes: {
          level: 4,
          hitDiceMax: 4,
          hitDiceCurrent: 3,
          hitDieSize: 10,
          hp: { current: 12, max: 34, temp: 0 },
          exhaustion: 0,
          deathSaves: { successes: 0, failures: 0 },
        },
      });
      const { container, findByText, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
      });

      // Modal header and title
      assert.ok(findByText("Short Rest"));
      // Vitality overview shows 3 / 4 hit dice and 12 / 34 HP
      assert.ok(findByText("3 / 4 (d10)"));
      assert.ok(findByText("12 / 34"));
      // Counter initialized to 0
      const counter = container.querySelector("[data-testid='spent-dice-count']");
      assert.ok(counter);
      assert.equal(counter.textContent.trim(), "0");

      // Decrement button refuses (aria-disabled) at 0
      const decBtn = container.querySelector("button[aria-label='Decrease hit dice spent']");
      assert.ok(decBtn);
      assert.equal(decBtn.getAttribute("aria-disabled"), "true");

      // Increment button accepts input
      const incBtn = container.querySelector("button[aria-label='Increase hit dice spent']");
      assert.ok(incBtn);
      assert.equal(incBtn.getAttribute("aria-disabled"), null);

      unmount();
    });

    it("executes authoritative dice roll requests via diceRollService for each die and displays recovered HP preview", async () => {
      const actor = createTestActor({
        attributes: {
          level: 4,
          hitDiceMax: 4,
          hitDiceCurrent: 2,
          hitDieSize: 10,
          hp: { current: 15, max: 40, temp: 0 },
          exhaustion: 0,
          deathSaves: { successes: 0, failures: 0 },
        },
      });

      const rollCalls: { formula: string; options?: any }[] = [];
      const mockDiceService: DiceRollService = {
        roll: async (formula, options) => {
          rollCalls.push({ formula, options });
          return {
            formula,
            total: 7,
            rolls: [7],
            signature: "mock-sig-123",
          };
        },
      };

      const { container, findByText, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
        diceRollService: mockDiceService,
      });

      // Increment to spend 2 dice
      const incBtn = container.querySelector("button[aria-label='Increase hit dice spent']");
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));

      const counter = container.querySelector("[data-testid='spent-dice-count']");
      assert.equal(counter.textContent.trim(), "2");

      // Roll button is present
      const rollBtn = findByText("Roll 2d10 for recovery");
      assert.ok(rollBtn);

      // Click roll button
      rollBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      // diceRollService called for each die
      assert.equal(rollCalls.length, 2);
      assert.equal(rollCalls[0].formula, "1d10");
      assert.equal(rollCalls[0].options?.reason, "short_rest_hit_dice");
      assert.equal(rollCalls[1].formula, "1d10");

      // Displays recovered HP preview (each roll 7 + CON 2 = 9 HP, total 18 HP)
      // 15 + 18 = 33 / 40
      assert.ok(findByText("+18 HP generated"));
      assert.ok(findByText("15 → 33 / 40 (+18 HP)"));

      unmount();
    });

    it("respects minimum 1 HP floor per spent die even with negative Constitution", async () => {
      const actor = createTestActor({
        attributes: {
          level: 4,
          hitDiceMax: 4,
          hitDiceCurrent: 1,
          hitDieSize: 8,
          hp: { current: 10, max: 30, temp: 0 },
          exhaustion: 0,
          deathSaves: { successes: 0, failures: 0 },
        },
      });
      // CON 6 -> modifier -2
      actor.abilities.con = { score: 6, saveProficiency: false };

      const mockDiceService: DiceRollService = {
        roll: async (formula) => ({
          formula,
          total: 1,
          rolls: [1], // 1 + (-2) = -1, floored to 1 HP
        }),
      };

      const { container, findByText, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
        diceRollService: mockDiceService,
      });

      // Increment to spend 1 die
      const incBtn = container.querySelector("button[aria-label='Increase hit dice spent']");
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));

      const rollBtn = findByText("Roll 1d8 for recovery");
      rollBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      // Minimum 1 HP floor displayed
      assert.ok(findByText("+1 HP (min. 1 floor)"));
      assert.ok(findByText("10 → 11 / 30 (+1 HP)"));

      unmount();
    });

    it("confirms Short Rest, executes applyShortRest, calls onSave with updated actor, and closes modal", async () => {
      let savedActor: Dnd5eActorData | null = null;
      let modalClosed = false;
      const actor = createTestActor({
        attributes: {
          level: 4,
          hitDiceMax: 4,
          hitDiceCurrent: 2,
          hitDieSize: 10,
          hp: { current: 10, max: 30, temp: 0 },
          exhaustion: 0,
          deathSaves: { successes: 0, failures: 0 },
        },
      });

      const mockDiceService: DiceRollService = {
        roll: async () => ({ formula: "1d10", total: 8, rolls: [8] }),
      };

      const { container, findByText, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => { modalClosed = true; },
        onSave: (updated) => { savedActor = updated; },
        diceRollService: mockDiceService,
      });

      // Spend 1 die
      const incBtn = container.querySelector("button[aria-label='Increase hit dice spent']");
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));

      // Roll
      const rollBtn = findByText("Roll 1d10 for recovery");
      rollBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      // Confirm button is enabled and clicked
      const confirmBtn = findByText("Confirm Short Rest");
      assert.ok(confirmBtn);
      assert.equal(confirmBtn.getAttribute("aria-disabled"), null);
      confirmBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(modalClosed, true);
      assert.ok(savedActor);
      // Hit dice decremented: 2 - 1 = 1
      assert.equal((savedActor as Dnd5eActorData).attributes.hitDiceCurrent, 1);
      // HP healed: 10 + (8 + 2) = 20
      assert.equal((savedActor as Dnd5eActorData).attributes.hp.current, 20);
      // SHORT_REST resources replenished
      assert.equal((savedActor as Dnd5eActorData).resources?.second_wind?.current, 1);
      assert.equal((savedActor as Dnd5eActorData).resources?.action_surge?.current, 1);
      // LONG_REST resource NOT replenished
      assert.equal((savedActor as Dnd5eActorData).resources?.indomitable?.current, 0);
      // Pact Magic slot replenished
      assert.equal((savedActor as Dnd5eActorData).spellSlots?.pact?.current, 2);

      unmount();
    });

    it("allows confirming Short Rest with 0 Hit Dice spent to reset resources without rolls", async () => {
      let savedActor: Dnd5eActorData | null = null;
      let modalClosed = false;
      const actor = createTestActor({
        attributes: {
          level: 4,
          hitDiceMax: 4,
          hitDiceCurrent: 0,
          hitDieSize: 10,
          hp: { current: 15, max: 30, temp: 0 },
          exhaustion: 0,
          deathSaves: { successes: 0, failures: 0 },
        },
      });

      const { findByText, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => { modalClosed = true; },
        onSave: (updated) => { savedActor = updated; },
      });

      const confirmBtn = findByText("Confirm Short Rest");
      assert.ok(confirmBtn);
      assert.equal(confirmBtn.getAttribute("aria-disabled"), null);
      confirmBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(modalClosed, true);
      assert.ok(savedActor);
      assert.equal((savedActor as Dnd5eActorData).attributes.hp.current, 15);
      assert.equal((savedActor as Dnd5eActorData).attributes.hitDiceCurrent, 0);
      assert.equal((savedActor as Dnd5eActorData).resources?.second_wind?.current, 1);

      unmount();
    });
  });

  describe("Long Rest Workflow (restType: 'long')", () => {
    it("displays a read-only recovery summary showing full HP, hit dice recovery, spell slots reset, resource pool reset, and exhaustion reduction", async () => {
      const actor = createTestActor({
        attributes: {
          level: 4,
          hitDiceMax: 4,
          hitDiceCurrent: 1,
          hitDieSize: 10,
          hp: { current: 12, max: 34, temp: 8 },
          exhaustion: 2,
          deathSaves: { successes: 2, failures: 1 },
        },
      });

      const { findByText, unmount } = await renderModal({
        actor,
        restType: "long",
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
      });

      assert.ok(findByText("Long Rest"));
      // Full HP restore: 12 -> 34
      assert.ok(findByText("12 → 34 / 34 (+22 HP)"));
      // Temp HP wiped to 0
      assert.ok(findByText("8 → 0"));
      // Hit dice recovery: max(1, floor(4/2)) = +2 (1 -> 3 / 4)
      assert.ok(findByText("+2 hit dice (1 → 3 / 4)"));
      // Exhaustion reduced by 1: 2 -> 1
      assert.ok(findByText("2 → 1 (-1 level)"));
      // Death saves reset
      assert.ok(findByText("Reset (0 successes, 0 failures)"));
      // Spell slots
      assert.ok(findByText("1 / 4 → 4 / 4")); // level 1 slots
      assert.ok(findByText("0 / 2 → 2 / 2")); // level 2 slots
      assert.ok(findByText("0 / 2 → 2 / 2")); // pact slots
      // Resources
      assert.ok(findByText("0 / 1 → 1 / 1")); // indomitable / second wind / action surge

      unmount();
    });

    it("confirms Long Rest, executes applyLongRest, calls onSave with updated actor, and closes modal", async () => {
      let savedActor: Dnd5eActorData | null = null;
      let modalClosed = false;
      const actor = createTestActor({
        attributes: {
          level: 4,
          hitDiceMax: 4,
          hitDiceCurrent: 1,
          hitDieSize: 10,
          hp: { current: 12, max: 34, temp: 8 },
          exhaustion: 2,
          deathSaves: { successes: 2, failures: 1 },
        },
      });

      const { findByText, unmount } = await renderModal({
        actor,
        restType: "long",
        isOpen: true,
        onClose: () => { modalClosed = true; },
        onSave: (updated) => { savedActor = updated; },
      });

      const confirmBtn = findByText("Confirm Long Rest");
      assert.ok(confirmBtn);
      confirmBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(modalClosed, true);
      assert.ok(savedActor);
      // Full HP restored
      assert.equal((savedActor as Dnd5eActorData).attributes.hp.current, 34);
      // Temp HP cleared
      assert.equal((savedActor as Dnd5eActorData).attributes.hp.temp, 0);
      // Hit dice recovered: 1 + 2 = 3
      assert.equal((savedActor as Dnd5eActorData).attributes.hitDiceCurrent, 3);
      // Exhaustion decremented by 1: 2 -> 1
      assert.equal((savedActor as Dnd5eActorData).attributes.exhaustion, 1);
      // Death saves reset
      assert.equal((savedActor as Dnd5eActorData).attributes.deathSaves.successes, 0);
      assert.equal((savedActor as Dnd5eActorData).attributes.deathSaves.failures, 0);
      // All spell slots restored
      assert.equal((savedActor as Dnd5eActorData).spellSlots?.level1?.current, 4);
      assert.equal((savedActor as Dnd5eActorData).spellSlots?.level2?.current, 2);
      assert.equal((savedActor as Dnd5eActorData).spellSlots?.pact?.current, 2);
      // All resource pools restored (both short and long rest)
      assert.equal((savedActor as Dnd5eActorData).resources?.second_wind?.current, 1);
      assert.equal((savedActor as Dnd5eActorData).resources?.action_surge?.current, 1);
      assert.equal((savedActor as Dnd5eActorData).resources?.indomitable?.current, 1);

      unmount();
    });
  });

  describe("Accessibility & Keyboard Trapping", () => {
    it("has role='dialog', aria-modal='true', and valid aria-labelledby/describedby", async () => {
      const actor = createTestActor();
      const { container, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
      });
      const dialog = container.querySelector("[role='dialog']");
      assert.ok(dialog);
      assert.equal(dialog.getAttribute("aria-modal"), "true");
      const labelledBy = dialog.getAttribute("aria-labelledby");
      assert.ok(labelledBy);
      const titleEl = container.querySelector(`#${labelledBy}`);
      assert.ok(titleEl);
      const describedBy = dialog.getAttribute("aria-describedby");
      assert.ok(describedBy);
      const descEl = container.querySelector(`#${describedBy}`);
      assert.ok(descEl);
      unmount();
    });

    it("groups stepper controls with role='group' and aria-labelledby while exposing numeric counter without aria-labelledby override", async () => {
      const actor = createTestActor();
      const { container, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
      });

      const stepperGroup = container.querySelector("[role='group']");
      assert.ok(stepperGroup, "Stepper controls must be enclosed in role='group'");
      assert.equal(
        stepperGroup.getAttribute("aria-labelledby"),
        "spent-dice-label",
        "Stepper group must be labelled by spent-dice-label"
      );

      const counter = container.querySelector("[data-testid='spent-dice-count']");
      assert.ok(counter, "Counter span must exist");
      assert.equal(
        counter.getAttribute("aria-live"),
        "polite",
        "Counter must announce live numeric updates via aria-live='polite'"
      );
      assert.equal(
        counter.getAttribute("aria-labelledby"),
        null,
        "Counter span must not have aria-labelledby to avoid overriding numeric value in accessibility tree"
      );

      unmount();
    });

    it("traps focus with Tab and Shift+Tab", async () => {
      const actor = createTestActor();
      const { container, unmount } = await renderModal({
        actor,
        restType: "short",
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
      });
      const dialog = container.querySelector("[role='dialog']");
      assert.ok(dialog);
      const buttons = container.querySelectorAll("button:not([disabled])");
      assert.ok(buttons.length >= 2);
      const firstBtn = buttons[0];
      const lastBtn = buttons[buttons.length - 1];

      // Shift+Tab on first element wraps to last
      firstBtn.focus();
      dialog.dispatchEvent({ type: "keydown", key: "Tab", shiftKey: true });
      assert.ok((globalThis as any).document.activeElement === lastBtn);

      // Tab on last element wraps to first
      lastBtn.focus();
      dialog.dispatchEvent({ type: "keydown", key: "Tab", shiftKey: false });
      assert.ok((globalThis as any).document.activeElement === firstBtn);

      unmount();
    });
  });
});
