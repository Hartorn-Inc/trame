import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RestModal, type RestModalProps, type DiceRollService } from "../../src/components/modals/RestModal.tsx";
import { createDefaultActorData, type Dnd5eActorData } from "../../../game-systems/dnd5e/src/index.ts";

// Minimal DOM mock to allow Preact render and event dispatch in Node.js
function setupMockDom() {
  class MockClassList {
    private classes = new Set<string>();
    add(...tokens: string[]) { tokens.forEach((t) => this.classes.add(t)); }
    remove(...tokens: string[]) { tokens.forEach((t) => this.classes.delete(t)); }
    contains(token: string) { return this.classes.has(token); }
    get length() { return this.classes.size; }
    toString() { return Array.from(this.classes).join(" "); }
  }

  class MockNode {
    nodeType = 1;
    nodeName = "DIV";
    parentNode: MockNode | null = null;
    childNodes: MockNode[] = [];
    attributes: Record<string, string> = {};
    style: Record<string, string> = {};
    classList = new MockClassList();
    data = "";
    _value = "";
    checked = false;
    disabled = false;
    type = "text";
    name = "";
    id = "";
    listeners: Record<string, Function[]> = {};

    constructor(nodeName: string = "DIV", nodeType: number = 1) {
      this.nodeName = nodeName.toUpperCase();
      this.nodeType = nodeType;
    }

    get textContent(): string {
      if (this.nodeType === 3) return this.data;
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(val: string) {
      this.childNodes = [];
      if (val) {
        const textNode = new MockNode("#text", 3);
        textNode.data = String(val);
        textNode.parentNode = this;
        this.childNodes.push(textNode);
      }
    }

    get value(): string {
      return this._value;
    }
    set value(v: string) {
      this._value = String(v);
    }

    get firstChild(): MockNode | null {
      return this.childNodes[0] || null;
    }
    get lastChild(): MockNode | null {
      return this.childNodes[this.childNodes.length - 1] || null;
    }
    get nextSibling(): MockNode | null {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1] : null;
    }

    appendChild<T extends MockNode>(child: T): T {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }

    insertBefore<T extends MockNode>(newChild: T, refChild: MockNode | null): T {
      if (!refChild) return this.appendChild(newChild);
      if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
      const idx = this.childNodes.indexOf(refChild);
      if (idx === -1) return this.appendChild(newChild);
      newChild.parentNode = this;
      this.childNodes.splice(idx, 0, newChild);
      return newChild;
    }

    removeChild<T extends MockNode>(child: T): T {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) {
        child.parentNode = null;
        this.childNodes.splice(idx, 1);
      }
      return child;
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }

    focus() {
      if (typeof document !== "undefined") {
        (document as any).activeElement = this;
      }
    }

    blur() {
      if (typeof document !== "undefined" && (document as any).activeElement === this) {
        (document as any).activeElement = null;
      }
    }

    contains(other: MockNode | null): boolean {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    setAttribute(name: string, value: any) {
      const strVal = String(value);
      this.attributes[name] = strVal;
      if (name === "class") {
        this.classList = new MockClassList();
        strVal.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
      }
      if (name === "id") this.id = strVal;
      if (name === "type") this.type = strVal;
      if (name === "name") this.name = strVal;
      if (name === "value") this._value = strVal;
      if (name === "disabled") this.disabled = Boolean(value);
      if (name === "checked") this.checked = Boolean(value);
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    hasAttribute(name: string): boolean {
      return name in this.attributes;
    }

    removeAttribute(name: string) {
      delete this.attributes[name];
    }

    addEventListener(type: string, listener: Function) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(listener);
    }

    removeEventListener(type: string, listener: Function) {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }

    dispatchEvent(event: { type: string; [k: string]: any }): boolean {
      const target = event.target ?? this;
      const list = this.listeners[event.type] || [];
      for (const handler of list) {
        handler.call(this, { ...event, target, currentTarget: this });
      }
      if (this.parentNode && (event as any).bubbles !== false) {
        this.parentNode.dispatchEvent({ ...event, target });
      }
      return true;
    }

    matches(selector: string): boolean {
      if (!selector || this.nodeType !== 1) return false;
      if (selector.startsWith("#")) {
        return this.id === selector.slice(1) || this.getAttribute("id") === selector.slice(1);
      }
      if (selector.startsWith(".")) {
        return this.classList.contains(selector.slice(1));
      }
      const bracketIdx = selector.indexOf("[");
      if (bracketIdx !== -1 && selector.endsWith("]")) {
        const tagPart = selector.slice(0, bracketIdx).trim();
        if (tagPart && this.nodeName.toLowerCase() !== tagPart.toLowerCase()) {
          return false;
        }
        const inner = selector.slice(bracketIdx + 1, -1);
        if (inner.includes("=")) {
          const eqIdx = inner.indexOf("=");
          const attr = inner.slice(0, eqIdx).trim();
          const val = inner.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
          return this.getAttribute(attr) === val || (this as any)[attr] === val;
        }
        return this.hasAttribute(inner);
      }
      return this.nodeName.toLowerCase() === selector.toLowerCase();
    }

    closest(selector: string): MockNode | null {
      let cur: MockNode | null = this;
      while (cur) {
        if (cur.matches(selector)) {
          return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }

    querySelector(selector: string): MockNode | null {
      const all = this.querySelectorAll(selector);
      return all[0] || null;
    }

    querySelectorAll(selector: string): MockNode[] {
      const results: MockNode[] = [];
      const walk = (current: MockNode) => {
        for (const child of current.childNodes) {
          if (child.nodeType === 1) {
            if (child.matches(selector)) results.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return results;
    }
  }

  const mockDoc = {
    nodeType: 9,
    nodeName: "#document",
    activeElement: null as MockNode | null,
    createElement(tag: string) {
      return new MockNode(tag, 1);
    },
    createElementNS(_ns: string, tag: string) {
      return new MockNode(tag, 1);
    },
    createTextNode(text: string) {
      const n = new MockNode("#text", 3);
      n.data = String(text);
      return n;
    },
    createDocumentFragment() {
      return new MockNode("#document-fragment", 11);
    },
    body: new MockNode("BODY", 1),
  };

  (globalThis as any).document = mockDoc;
  (globalThis as any).window = globalThis;
  (globalThis as any).Event = class {
    type: string;
    bubbles = true;
    constructor(type: string, opts?: any) {
      this.type = type;
      if (opts?.bubbles !== undefined) this.bubbles = opts.bubbles;
    }
  };
  return mockDoc;
}

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
      assert.ok(findByText("Repos court (Short Rest)"));
      // Vitality overview shows 3 / 4 hit dice and 12 / 34 HP
      assert.ok(findByText("3 / 4 (d10)"));
      assert.ok(findByText("12 / 34"));
      // Counter initialized to 0
      const counter = container.querySelector("[data-testid='spent-dice-count']");
      assert.ok(counter);
      assert.equal(counter.textContent.trim(), "0");

      // Decrement button disabled at 0
      const decBtn = container.querySelector("button[aria-label='Diminuer les dés de vie dépensés']");
      assert.ok(decBtn);
      assert.equal(decBtn.disabled, true);

      // Increment button enabled
      const incBtn = container.querySelector("button[aria-label='Augmenter les dés de vie dépensés']");
      assert.ok(incBtn);
      assert.equal(incBtn.disabled, false);

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
      const incBtn = container.querySelector("button[aria-label='Augmenter les dés de vie dépensés']");
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));

      const counter = container.querySelector("[data-testid='spent-dice-count']");
      assert.equal(counter.textContent.trim(), "2");

      // Roll button is present
      const rollBtn = findByText("Lancer les 2d10 de récupération");
      assert.ok(rollBtn);

      // Click roll button
      rollBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      // diceRollService called for each die
      assert.equal(rollCalls.length, 2);
      assert.equal(rollCalls[0].formula, "1d10");
      assert.equal(rollCalls[0].options?.reason, "short_rest_hit_dice");
      assert.equal(rollCalls[1].formula, "1d10");

      // Displays recovered HP preview (each roll 7 + CON 2 = 9 PV, total 18 PV)
      // 15 + 18 = 33 / 40
      assert.ok(findByText("+18 PV générés"));
      assert.ok(findByText("15 → 33 / 40 (+18 PV)"));

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
      const incBtn = container.querySelector("button[aria-label='Augmenter les dés de vie dépensés']");
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));

      const rollBtn = findByText("Lancer les 1d8 de récupération");
      rollBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      // Minimum 1 HP floor displayed
      assert.ok(findByText("+1 PV (plancher min. 1)"));
      assert.ok(findByText("10 → 11 / 30 (+1 PV)"));

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
      const incBtn = container.querySelector("button[aria-label='Augmenter les dés de vie dépensés']");
      incBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 10));

      // Roll
      const rollBtn = findByText("Lancer les 1d10 de récupération");
      rollBtn.dispatchEvent({ type: "click" });
      await new Promise((r) => setTimeout(r, 20));

      // Confirm button is enabled and clicked
      const confirmBtn = findByText("Confirmer le Repos Court");
      assert.ok(confirmBtn);
      assert.equal(confirmBtn.disabled, false);
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

      const confirmBtn = findByText("Confirmer le Repos Court");
      assert.ok(confirmBtn);
      assert.equal(confirmBtn.disabled, false);
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

      assert.ok(findByText("Repos long (Long Rest)"));
      // Full HP restore: 12 -> 34
      assert.ok(findByText("12 → 34 / 34 (+22 PV)"));
      // Temp HP wiped to 0
      assert.ok(findByText("8 → 0"));
      // Hit dice recovery: max(1, floor(4/2)) = +2 (1 -> 3 / 4)
      assert.ok(findByText("+2 dé(s) (1 → 3 / 4)"));
      // Exhaustion reduced by 1: 2 -> 1
      assert.ok(findByText("2 → 1 (-1 niveau)"));
      // Death saves reset
      assert.ok(findByText("Réinitialisés (0 succès, 0 échec)"));
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

      const confirmBtn = findByText("Confirmer le Repos Long");
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
      assert.equal((globalThis as any).document.activeElement, lastBtn);

      // Tab on last element wraps to first
      lastBtn.focus();
      dialog.dispatchEvent({ type: "keydown", key: "Tab", shiftKey: false });
      assert.equal((globalThis as any).document.activeElement, firstBtn);

      unmount();
    });
  });
});
