import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LevelUpModal, type LevelUpModalProps } from "../../src/components/modals/LevelUpModal.tsx";
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

    querySelector(selector: string): MockNode | null {
      const all = this.querySelectorAll(selector);
      return all[0] || null;
    }

    querySelectorAll(selector: string): MockNode[] {
      const results: MockNode[] = [];
      const match = (node: MockNode): boolean => {
        if (selector.startsWith("#")) {
          return node.id === selector.slice(1) || node.getAttribute("id") === selector.slice(1);
        }
        if (selector.startsWith(".")) {
          return node.classList.contains(selector.slice(1));
        }
        const bracketIdx = selector.indexOf("[");
        if (bracketIdx !== -1 && selector.endsWith("]")) {
          const tagPart = selector.slice(0, bracketIdx).trim();
          if (tagPart && node.nodeName.toLowerCase() !== tagPart.toLowerCase()) {
            return false;
          }
          const inner = selector.slice(bracketIdx + 1, -1);
          if (inner.includes("=")) {
            const eqIdx = inner.indexOf("=");
            const attr = inner.slice(0, eqIdx).trim();
            const val = inner.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
            return node.getAttribute(attr) === val || (node as any)[attr] === val;
          }
          return node.hasAttribute(inner);
        }
        return node.nodeName.toLowerCase() === selector.toLowerCase();
      };

      const walk = (current: MockNode) => {
        for (const child of current.childNodes) {
          if (child.nodeType === 1) {
            if (match(child)) results.push(child);
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
async function renderModal(props: LevelUpModalProps) {
  const { render, h, options } = await import("preact");
  options.debounceRendering = (cb: () => void) => cb();
  const doc = (globalThis as any).document || setupMockDom();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  render(h(LevelUpModal, props), container);
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

  const getButtons = (): any[] => {
    return container.querySelectorAll("button");
  };

  const getNextButton = (): any => {
    const buttons = getButtons();
    return buttons.find((b: any) => b.textContent.includes("Suivant")) || null;
  };

  const getConfirmButton = (): any => {
    const buttons = getButtons();
    return buttons.find((b: any) => b.textContent.includes("Confirmer et Appliquer")) || null;
  };

  const getPrevButton = (): any => {
    const buttons = getButtons();
    return buttons.find((b: any) => b.textContent.includes("Précédent")) || null;
  };

  return {
    container,
    unmount,
    findByText,
    getButtons,
    getNextButton,
    getConfirmButton,
    getPrevButton,
    rerender: (newProps: LevelUpModalProps) => {
      render(h(LevelUpModal, newProps), container);
    },
  };
}

setupMockDom();

describe("LevelUpModal Preact 4-Step Wizard Component Suite", () => {
  it("WHEN LevelUpModal renders with isOpen = false, LevelUpModal renders nothing to the DOM", async () => {
    const actor = createDefaultActorData("actor-1", "Alden");
    const { container, unmount } = await renderModal({
      isOpen: false,
      actor,
      onClose: () => {},
      onSave: () => {},
    });
    assert.equal(container.childNodes.length, 0);
    unmount();
  });

  it("WHEN LevelUpModal renders for an actor at target subclass level without a chosen subclass, LevelUpModal displays subclass selector and disables the Next button until a subclass is selected (AC1)", async () => {
    const actor = createDefaultActorData("actor-wizard", "Galdor");
    actor.classId = "wizard";
    actor.attributes.level = 1; // advancing to lvl 2, wizard subclass unlock level is 2
    delete (actor as any).subclassId;
    delete (actor.attributes as any).subclassId;

    const { container, getNextButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    // Confirm dialog accessibility
    const dialog = container.querySelector("[role='dialog']");
    assert.ok(dialog, "Must have role='dialog'");
    assert.equal(dialog.getAttribute("aria-modal"), "true");

    // Subclass select should be present
    const select = container.querySelector("#subclass-select");
    assert.ok(select, "Subclass selector must be rendered when subclass is needed");

    // Next button must be disabled initially
    const nextBtn = getNextButton();
    assert.ok(nextBtn, "Next button should be present");
    assert.equal(nextBtn.disabled, true, "Next button must be disabled when required subclass is unselected");

    // Select a subclass
    select.value = "srd:subclass:evocation";
    select.dispatchEvent(new (globalThis as any).Event("change"));

    // Next button should become enabled
    assert.equal(nextBtn.disabled, false, "Next button must become enabled once subclass is selected");

    unmount();
  });

  it("WHEN LevelUpModal Step 2 is set to 'Moyenne fixe', LevelUpModal displays deterministic HP gain floor(hitDieSize / 2) + 1 + conMod (AC2)", async () => {
    const actor = createDefaultActorData("actor-fighter", "Valeros");
    actor.classId = "fighter";
    actor.attributes.level = 1;
    actor.attributes.hitDieSize = 10; // Fighter d10
    actor.abilities.con.score = 14; // CON mod = +2

    const { container, getNextButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    assert.ok(container.textContent.includes("+8 PV"), "Must display deterministic fixed HP gain (+8 PV for d10 with CON 14)");
    assert.equal(nextBtn.disabled, false, "Next button must be enabled in fixed mode");

    unmount();
  });

  it("WHEN LevelUpModal Step 2 is set to 'Tirer le dé de vie', LevelUpModal requests an authoritative roll from diceRollService, renders verified result, and disables Next until roll succeeds (AC3)", async () => {
    const actor = createDefaultActorData("actor-cleric", "Kyra");
    actor.classId = "cleric";
    actor.attributes.level = 1;
    actor.attributes.hitDieSize = 8; // Cleric d8
    actor.abilities.con.score = 12; // CON mod = +1

    let rollRequested = false;
    let requestedFormula = "";
    const mockDiceService = {
      roll: async (formula: string) => {
        rollRequested = true;
        requestedFormula = formula;
        return {
          total: 6,
          rolls: [6],
          formula,
          signature: "chacha20-auth-sig-123",
        };
      },
    };

    const { container, getNextButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
      diceRollService: mockDiceService as any,
    });

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    const radios = container.querySelectorAll("input[name='hpMode']");
    const rolledRadio = radios.find((r: any) => r.value === "rolled");
    assert.ok(rolledRadio, "Rolled HP radio option must exist");

    rolledRadio.dispatchEvent(new (globalThis as any).Event("change"));
    assert.equal(nextBtn.disabled, true, "Next must be disabled before dice roll is performed");

    const buttons = container.querySelectorAll("button");
    const rollBtn = buttons.find((b: any) => b.textContent.includes("Lancer 1d8"));
    assert.ok(rollBtn, "Roll dice button must be displayed in rolled mode");

    await rollBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(rollRequested, true, "diceRollService.roll must be invoked");
    assert.equal(requestedFormula, "1d8", "diceRollService must be queried with 1d8");
    assert.ok(container.textContent.includes("+7 PV"), "Must display rolled result + CON mod (+7 PV)");
    assert.equal(nextBtn.disabled, false, "Next must become enabled after server roll succeeds");

    unmount();
  });

  it("WHEN LevelUpModal Step 3 renders at an ASI level, LevelUpModal enforces either +2 or +1/+1 strictly capped at 20, or a valid Feat selection before enabling Next (AC4)", async () => {
    const actor = createDefaultActorData("actor-rogue", "Merisiel");
    actor.classId = "rogue";
    actor.attributes.level = 3; // Advancing to lvl 4 (ASI level for all classes)
    actor.abilities.str.score = 19; // +2 would give 21 (> 20 cap)
    actor.abilities.dex.score = 16;
    actor.abilities.con.score = 14;

    const { container, getNextButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    assert.equal(nextBtn.disabled, true, "Next must be disabled when +2 exceeds maximum score of 20");

    // Verify aria-live='polite' alert is present on ASI cap violation
    const alertMsg = container.querySelector("[role='alert']");
    assert.ok(alertMsg, "Validation alert must have role='alert'");
    assert.equal(alertMsg.getAttribute("aria-live"), "polite");

    // Switch to Feat mode
    const featTabBtn = container.querySelectorAll("button").find((b: any) => b.textContent.includes("Choisir un Don"));
    assert.ok(featTabBtn, "Feat tab button must exist");
    featTabBtn.dispatchEvent(new (globalThis as any).Event("click"));

    assert.equal(nextBtn.disabled, true, "Next must be disabled when no Feat is selected");

    const featSelect = container.querySelector("#asi-feat-select");
    assert.ok(featSelect, "Feat select must be rendered with id='asi-feat-select'");
    featSelect.value = "srd:feat:tough";
    featSelect.dispatchEvent(new (globalThis as any).Event("change"));

    assert.equal(nextBtn.disabled, false, "Next must be enabled after selecting a valid Feat");

    unmount();
  });

  it("WHEN LevelUpModal Step 4 renders for a Wizard, LevelUpModal presents updated spell slot grid and requires exactly 2 new spells before completion (AC5)", async () => {
    const actor = createDefaultActorData("actor-wizard", "Galdor");
    actor.classId = "wizard";
    actor.attributes.level = 2; // Advancing to lvl 3 (Circle 2 spells unlock)
    actor.attributes.casterType = "full";

    const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    // Check Spell Slots grid rendered with 'LVL X'
    assert.ok(container.textContent.includes("Nouveaux emplacements de sorts"), "Spell slots section must be displayed");
    assert.ok(container.textContent.includes("LVL 1"), "Level 1 spell slots must be listed with LVL 1");
    assert.ok(container.textContent.includes("LVL 2"), "Level 2 spell slots must be listed with LVL 2");

    // Check Confirm button is available at Step 4 but disabled until 2 wizard spells are picked
    const confirmBtn = getConfirmButton();
    assert.ok(confirmBtn, "Confirmer et Appliquer button must be present at Step 4");
    assert.equal(confirmBtn.disabled, true, "Confirm button must be disabled for Wizard with 0 spells chosen");

    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    assert.ok(checkboxes.length >= 2, "Wizard must have at least 2 spells available");

    // Select first spell
    checkboxes[0].dispatchEvent(new (globalThis as any).Event("change"));
    assert.equal(confirmBtn.disabled, true, "Confirm button must remain disabled with only 1 spell chosen");

    // Select second spell
    checkboxes[1].dispatchEvent(new (globalThis as any).Event("change"));
    assert.equal(confirmBtn.disabled, false, "Confirm button must be enabled once 2 spells are chosen");

    unmount();
  });

  it("WHEN LevelUpModal Step 4 renders for a divine caster (Cleric), LevelUpModal displays preparation banner and no checkboxes (AC5)", async () => {
    const actor = createDefaultActorData("actor-cleric", "Kyra");
    actor.classId = "cleric";
    actor.attributes.level = 1; // advancing to lvl 2
    actor.attributes.casterType = "full";

    const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    assert.ok(container.textContent.includes("Préparation divine des sorts"), "Divine preparation banner must be displayed");
    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    assert.equal(checkboxes.length, 0, "Divine casters must not have spell learning checkboxes");

    const confirmBtn = getConfirmButton();
    assert.ok(confirmBtn, "Confirm button must be present");
    assert.equal(confirmBtn.disabled, false, "Confirm button must be enabled without checkbox requirement for divine caster");

    unmount();
  });

  it("WHEN user clicks 'Confirmer et Appliquer', LevelUpModal invokes applyLevelUp with compiled LevelUpOptions, calls onSave with mutated actor, and triggers onClose (AC6)", async () => {
    const actor = createDefaultActorData("actor-fighter", "Valeros");
    actor.classId = "fighter";
    actor.attributes.level = 1;
    actor.attributes.hp.max = 12;
    actor.attributes.hp.current = 12;
    actor.attributes.hitDieSize = 10;
    actor.abilities.con.score = 14;

    let savedActor: Dnd5eActorData | null = null;
    let closeTriggered = false;

    const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {
        closeTriggered = true;
      },
      onSave: (updated) => {
        savedActor = updated;
      },
    });

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    const confirmBtn = getConfirmButton();
    assert.ok(confirmBtn, "Confirm button must exist on final step");

    await confirmBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(closeTriggered, true, "onClose must be called upon completion");
    assert.ok(savedActor, "onSave must receive the mutated actor");
    assert.equal(savedActor?.attributes.level, 2, "Actor level must advance to 2");
    assert.equal(savedActor?.attributes.hp.max, 20, "Max HP must increase by 8 (12 + 8 = 20)");

    unmount();
  });

  it("WHEN Escape key is pressed or close button clicked, LevelUpModal triggers onClose and enforces ARIA attributes (AC7 & AC8)", async () => {
    const actor = createDefaultActorData("actor-1", "Test");
    let closedCount = 0;

    const { container, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {
        closedCount++;
      },
      onSave: () => {},
    });

    const dialog = container.querySelector("[role='dialog']");
    assert.ok(dialog, "Must have role='dialog'");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-labelledby"), "Must have aria-labelledby");
    assert.ok(dialog.getAttribute("aria-describedby"), "Must have aria-describedby");

    dialog.dispatchEvent({ type: "keydown", key: "Escape", stopPropagation: () => {} });
    assert.equal(closedCount, 1, "Escape key must trigger onClose");

    const closeBtn = container.querySelector("button[aria-label='Fermer la fenêtre de montée de niveau']");
    assert.ok(closeBtn, "Close button with proper aria-label must exist");
    closeBtn.dispatchEvent(new (globalThis as any).Event("click"));
    assert.equal(closedCount, 2, "Close button click must trigger onClose");

    unmount();
  });

  it("WHEN LevelUpModal mounts with isOpen=true, initial focus moves programmatically to the first interactive element (WCAG 2.4.3)", async () => {
    const actor = createDefaultActorData("actor-1", "Test Actor");
    const { container, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const closeBtn = container.querySelector("button[aria-label='Fermer la fenêtre de montée de niveau']");
    assert.ok(closeBtn, "Close button must exist");
    assert.equal((globalThis as any).document.activeElement, closeBtn, "Initial focus must be placed on the close button");

    unmount();
  });

  it("WHEN keyboard Tab and Shift+Tab are pressed, focus is trapped inside the active modal dialog (WCAG 2.4.3)", async () => {
    const actor = createDefaultActorData("actor-wizard", "Galdor");
    actor.classId = "wizard";
    actor.attributes.level = 1;

    const { container, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const dialog = container.querySelector("[role='dialog']");
    assert.ok(dialog, "Dialog element must exist");

    const closeBtn = container.querySelector("button[aria-label='Fermer la fenêtre de montée de niveau']");
    const cancelBtn = container.querySelectorAll("button").find((b: any) => b.textContent.includes("Annuler"));
    assert.ok(closeBtn, "Close button must exist");
    assert.ok(cancelBtn, "Cancel button must exist");

    closeBtn.focus();
    let shiftPrevented = false;
    dialog.dispatchEvent({
      type: "keydown",
      key: "Tab",
      shiftKey: true,
      preventDefault: () => { shiftPrevented = true; },
      stopPropagation: () => {},
    });
    assert.equal(shiftPrevented, true, "Shift+Tab on first element must prevent default");
    assert.equal((globalThis as any).document.activeElement, cancelBtn, "Shift+Tab on first element must wrap to last element");

    cancelBtn.focus();
    let tabPrevented = false;
    dialog.dispatchEvent({
      type: "keydown",
      key: "Tab",
      shiftKey: false,
      preventDefault: () => { tabPrevented = true; },
      stopPropagation: () => {},
    });
    assert.equal(tabPrevented, true, "Tab on last element must prevent default");
    assert.equal((globalThis as any).document.activeElement, closeBtn, "Tab on last element must wrap to first element");

    unmount();
  });

  it("WHEN Stepper Bar renders, active step has aria-current='step' and completed steps show checkmark glyph '✓' (WCAG 1.4.1 & Non-Color Redundancy)", async () => {
    const actor = createDefaultActorData("actor-1", "Test Actor");
    actor.classId = "fighter";
    actor.attributes.level = 1;

    const { container, getNextButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const nav = container.querySelector("nav[aria-label='Étapes de progression']");
    assert.ok(nav, "Stepper nav element must exist");

    const stepNodes = nav.childNodes.filter((c: any) => c.nodeType === 1);
    assert.equal(stepNodes.length, 4, "Must have 4 steps");

    assert.equal(stepNodes[0].getAttribute("aria-current"), "step");
    assert.equal(stepNodes[0].textContent.includes("✓"), false, "Step 1 should not have checkmark while active");
    assert.equal(stepNodes[1].getAttribute("aria-current"), null);

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    assert.equal(stepNodes[0].getAttribute("aria-current"), null);
    assert.ok(stepNodes[0].textContent.includes("✓"), "Past step 1 must have checkmark glyph");
    assert.equal(stepNodes[1].getAttribute("aria-current"), "step", "Current step 2 must have aria-current='step'");
    assert.equal(stepNodes[1].textContent.includes("✓"), false, "Step 2 should not have checkmark while active");

    unmount();
  });

  it("WHEN Step 3 ASI/Feat mode switcher renders, it exposes role='tablist', role='tab' buttons, aria-selected, and visual indicator glyphs (WCAG 1.4.1 & 4.1.2)", async () => {
    const actor = createDefaultActorData("actor-1", "Test Rogue");
    actor.classId = "rogue";
    actor.attributes.level = 3;

    const { container, getNextButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const nextBtn = getNextButton();
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    const tablist = container.querySelector("[role='tablist']");
    assert.ok(tablist, "Tablist container must have role='tablist'");

    const tabs = tablist.querySelectorAll("[role='tab']");
    assert.equal(tabs.length, 2, "Must have 2 tab buttons");

    const asiTab = tabs.find((t: any) => t.textContent.includes("ASI"));
    const featTab = tabs.find((t: any) => t.textContent.includes("Choisir un Don"));
    assert.ok(asiTab, "ASI tab must exist");
    assert.ok(featTab, "Feat tab must exist");

    assert.equal(asiTab.getAttribute("aria-selected"), "true");
    assert.ok(asiTab.textContent.includes("●"), "Selected tab must display active glyph ●");
    assert.equal(featTab.getAttribute("aria-selected"), "false");
    assert.ok(featTab.textContent.includes("○"), "Inactive tab must display inactive glyph ○");

    featTab.dispatchEvent(new (globalThis as any).Event("click"));
    assert.equal(asiTab.getAttribute("aria-selected"), "false");
    assert.ok(asiTab.textContent.includes("○"), "Deselected tab must display inactive glyph ○");
    assert.equal(featTab.getAttribute("aria-selected"), "true");
    assert.ok(featTab.textContent.includes("●"), "Selected tab must display active glyph ●");

    unmount();
  });

  it("WHEN interactive buttons and select controls render, they satisfy min-h-[40px] and focus-visible styling (WCAG 2.5.8, 2.4.7, 2.4.11)", async () => {
    const actor = createDefaultActorData("actor-1", "Test Actor");
    actor.classId = "wizard";
    actor.attributes.level = 1;
    delete (actor as any).subclassId;
    delete (actor.attributes as any).subclassId;

    const { container, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const closeBtn = container.querySelector("button[aria-label='Fermer la fenêtre de montée de niveau']");
    assert.ok(closeBtn.getAttribute("class")?.includes("min-h-[40px]"), "Close button must have min-h-[40px]");

    const subclassSelect = container.querySelector("#subclass-select");
    assert.ok(subclassSelect.getAttribute("class")?.includes("min-h-[40px]"), "Subclass select must have min-h-[40px]");
    assert.ok(subclassSelect.getAttribute("class")?.includes("focus-visible:ring-[var(--atlas-focus)]"), "Subclass select must have atlas-focus ring");

    const buttons = container.querySelectorAll("button");
    for (const btn of buttons) {
      const cls = btn.getAttribute("class") || "";
      assert.ok(cls.includes("min-h-[40px]"), `Button '${btn.textContent.trim()}' must satisfy min-h-[40px]`);
      assert.ok(cls.includes("focus-visible:ring-[var(--atlas-focus)]"), `Button '${btn.textContent.trim()}' must have atlas-focus ring`);
    }

    unmount();
  });

  it("WHEN primary action and confirmation buttons render, they pair var(--atlas-action) with var(--atlas-on-action) for compliant contrast (WCAG 1.4.3)", async () => {
    const actor = createDefaultActorData("actor-1", "Test Actor");
    actor.classId = "fighter";
    actor.attributes.level = 1;

    const { container, getNextButton, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const nextBtn = getNextButton();
    const nextCls = nextBtn.getAttribute("class") || "";
    assert.ok(nextCls.includes("bg-[var(--atlas-action)]"), "Next button must use var(--atlas-action)");
    assert.ok(nextCls.includes("text-[var(--atlas-on-action)]"), "Next button must use var(--atlas-on-action)");

    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    const rolledRadio = container.querySelectorAll("input[name='hpMode']").find((r: any) => r.value === "rolled");
    rolledRadio.dispatchEvent(new (globalThis as any).Event("change"));

    const rollBtn = container.querySelectorAll("button").find((b: any) => b.textContent.includes("Lancer 1d"));
    assert.ok(rollBtn, "Roll button must exist");
    const rollCls = rollBtn.getAttribute("class") || "";
    assert.ok(rollCls.includes("bg-[var(--atlas-action)]"), "Roll button must use var(--atlas-action)");
    assert.ok(rollCls.includes("text-[var(--atlas-on-action)]"), "Roll button must use var(--atlas-on-action)");

    const fixedRadio = container.querySelectorAll("input[name='hpMode']").find((r: any) => r.value === "fixed");
    fixedRadio.dispatchEvent(new (globalThis as any).Event("change"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));

    const confirmBtn = container.querySelectorAll("button").find((b: any) => b.textContent.includes("Confirmer et Appliquer"));
    assert.ok(confirmBtn, "Confirm button must exist");
    const confirmCls = confirmBtn.getAttribute("class") || "";
    assert.ok(confirmCls.includes("bg-[var(--atlas-action)]"), "Confirm button must use var(--atlas-action)");
    assert.ok(confirmCls.includes("text-[var(--atlas-on-action)]"), "Confirm button must use var(--atlas-on-action)");

    unmount();
  });
});
