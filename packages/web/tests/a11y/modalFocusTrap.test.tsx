import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { h, options, render } from "preact";
import { useRef } from "preact/hooks";
import { localeSignal } from "../../src/i18n/index.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

localeSignal.value = "en";
options.debounceRendering = (cb: () => void) => cb();
options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
const doc = setupMockDom() as any;
(globalThis as any).addEventListener = () => undefined;
(globalThis as any).removeEventListener = () => undefined;

const { useModalFocusTrap } = await import("../../src/components/a11y/useModalFocusTrap.ts");
const { HandoutRevealModal, activeHandoutModalSignal, dispatchHandoutRevealedFrame } = await import(
  "../../src/workspace/DocumentsWorkspaceTab.tsx"
);

let escapes = 0;

function Dialog({ showMiddle }: { showMiddle: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap(ref, { onEscape: () => escapes++ });
  return h(
    "div",
    { ref, role: "dialog", "aria-modal": "true", "data-testid": "dialog" },
    h("button", { "data-testid": "first" }, "First"),
    showMiddle && h("button", { "data-testid": "middle" }, "Middle"),
    h("button", { "data-testid": "last" }, "Last"),
    h("button", { "data-testid": "off", disabled: true }, "Off"),
  );
}

describe("useModalFocusTrap keeps keyboard focus and Escape inside the dialog", () => {
  let page: any;
  let trigger: any;
  let alreadyInert: any;
  let host: any;
  const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
  const key = (k: string, shiftKey = false) => doc.dispatchEvent({ type: "keydown", key: k, shiftKey, preventDefault: () => undefined });
  const open = (showMiddle = true) => render(h(Dialog, { showMiddle }), host);

  beforeEach(() => {
    escapes = 0;
    page = doc.createElement("div");
    trigger = doc.createElement("button");
    alreadyInert = doc.createElement("aside");
    alreadyInert.setAttribute("inert", "");
    host = doc.createElement("div");
    page.appendChild(trigger);
    page.appendChild(alreadyInert);
    page.appendChild(host);
    doc.body.appendChild(page);
    trigger.focus();
  });

  afterEach(() => {
    render(null, host);
    doc.body.removeChild(page);
  });

  it("moves focus to the first control on open", () => {
    open();
    assert.equal(doc.activeElement, byTestId("first"));
  });

  const tabCases = [
    { id: "Tab on the last control wraps to the first, skipping the disabled trailing button", from: "last", shift: false, to: "first" },
    { id: "Shift+Tab on the first control wraps to the last enabled control", from: "first", shift: true, to: "last" },
    { id: "Tab after focus fell to <body> re-enters at the first control", from: "body", shift: false, to: "first" },
    { id: "Shift+Tab after focus fell to <body> re-enters at the last control", from: "body", shift: true, to: "last" },
  ];

  for (const c of tabCases) {
    it(c.id, () => {
      open();
      if (c.from === "body") doc.activeElement = doc.body;
      else byTestId(c.from).focus();
      key("Tab", c.shift);
      assert.equal(doc.activeElement, byTestId(c.to));
    });
  }

  const escapeCases = [
    { id: "Escape from a focused control closes the dialog", unmountFocused: false },
    { id: "Escape still closes after the focused control unmounted and focus fell to <body>", unmountFocused: true },
  ];

  for (const c of escapeCases) {
    it(c.id, () => {
      open();
      byTestId("middle").focus();
      if (c.unmountFocused) {
        open(false);
        doc.activeElement = doc.body;
      }
      key("Escape");
      assert.equal(escapes, 1);
    });
  }

  it("focusin outside the dialog pulls focus back to the first control", () => {
    open();
    doc.dispatchEvent({ type: "focusin", target: trigger });
    assert.equal(doc.activeElement, byTestId("first"));
  });

  const inertCases = [
    { id: "background sibling is inert while open", phase: "open", node: () => trigger, inert: true },
    { id: "background sibling inert is removed on close", phase: "closed", node: () => trigger, inert: false },
    { id: "pre-existing inert on a sibling survives close", phase: "closed", node: () => alreadyInert, inert: true },
  ];

  for (const c of inertCases) {
    it(c.id, () => {
      open();
      if (c.phase === "closed") render(null, host);
      assert.equal(c.node().hasAttribute("inert"), c.inert);
    });
  }

  it("restores focus to the trigger on close", () => {
    open();
    render(null, host);
    assert.equal(doc.activeElement, trigger);
  });
});

describe("HandoutRevealModal uses the shared focus trap", () => {
  let host: any;

  beforeEach(() => {
    host = doc.createElement("div");
    doc.body.appendChild(host);
    render(h(HandoutRevealModal, {}), host);
    dispatchHandoutRevealedFrame({ handout_id: "h-1", title: "Decree", content: "Portals sealed." });
  });

  afterEach(() => {
    activeHandoutModalSignal.value = null;
    render(null, host);
    doc.body.removeChild(host);
  });

  const cases = [
    { id: "opening focuses the close button", key: null, open: true, focus: "close-handout-modal" },
    { id: "Escape on document closes the handout", key: "Escape", open: false, focus: null },
    { id: "Tab from outside the dialog returns to the close button", key: "Tab", open: true, focus: "close-handout-modal" },
  ];

  for (const c of cases) {
    it(c.id, () => {
      const modal = host.querySelector('[data-testid="handout-reveal-modal"]');
      assert.ok(modal);
      assert.equal(modal.getAttribute("aria-modal"), "true");
      if (c.key) {
        doc.activeElement = doc.body;
        doc.dispatchEvent({ type: "keydown", key: c.key, shiftKey: false, preventDefault: () => undefined });
      }
      assert.equal(Boolean(host.querySelector('[data-testid="handout-reveal-modal"]')), c.open);
      if (c.focus) assert.equal(doc.activeElement, host.querySelector(`[data-testid="${c.focus}"]`));
    });
  }
});
