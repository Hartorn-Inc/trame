import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LevelUpModal, getNewSpellsAllowance, type LevelUpModalProps } from "../../src/components/modals/LevelUpModal.tsx";
import { createDefaultActorData, type Dnd5eActorData } from "../../../game-systems/dnd5e/src/index.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { assertAbsent, assertSameNode } from "../helpers/domAssert.ts";

localeSignal.value = "en";

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
    return buttons.find((b: any) => b.textContent.includes("Next")) || null;
  };

  const getConfirmButton = (): any => {
    const buttons = getButtons();
    return buttons.find((b: any) => b.textContent.includes("Confirm and Apply")) || null;
  };

  const getPrevButton = (): any => {
    const buttons = getButtons();
    return buttons.find((b: any) => b.textContent.includes("Previous")) || null;
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
    actor.attributes.level = 2; // advancing to lvl 3, every SRD 5.2.1 class picks its subclass at 3
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
    assert.equal(nextBtn.getAttribute("aria-disabled"), "true", "Next button must be disabled when required subclass is unselected");

    // Select a subclass
    select.value = "srd:subclass:evocation";
    select.dispatchEvent(new (globalThis as any).Event("change"));

    // Next button should become enabled
    assert.equal(nextBtn.getAttribute("aria-disabled"), null, "Next button must become enabled once subclass is selected");

    unmount();
  });

  it("WHEN LevelUpModal Step 2 is set to 'Fixed average', LevelUpModal displays deterministic HP gain floor(hitDieSize / 2) + 1 + conMod (AC2)", async () => {
    const actor = createDefaultActorData("actor-fighter", "Kael");
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

    assert.ok(container.textContent.includes("+8 HP"), "Must display deterministic fixed HP gain (+8 HP for d10 with CON 14)");
    assert.equal(nextBtn.getAttribute("aria-disabled"), null, "Next button must be enabled in fixed mode");

    unmount();
  });

  it("WHEN LevelUpModal Step 2 is set to 'Roll the hit die', LevelUpModal requests an authoritative roll from diceRollService, renders verified result, and disables Next until roll succeeds (AC3)", async () => {
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
    assert.equal(nextBtn.getAttribute("aria-disabled"), "true", "Next must be disabled before dice roll is performed");

    const buttons = container.querySelectorAll("button");
    const rollBtn = buttons.find((b: any) => b.textContent.includes("Roll 1d8"));
    assert.ok(rollBtn, "Roll dice button must be displayed in rolled mode");

    await rollBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(rollRequested, true, "diceRollService.roll must be invoked");
    assert.equal(requestedFormula, "1d8", "diceRollService must be queried with 1d8");
    assert.ok(container.textContent.includes("+7 HP"), "Must display rolled result + CON mod (+7 HP)");
    assert.equal(nextBtn.getAttribute("aria-disabled"), null, "Next must become enabled after server roll succeeds");

    unmount();
  });

  it("WHEN LevelUpModal Step 3 renders at an ASI level, LevelUpModal enforces either +2 or +1/+1 strictly capped at 20, or a valid Feat selection before enabling Next (AC4)", async () => {
    const actor = createDefaultActorData("actor-rogue", "Merisiel");
    actor.classId = "rogue";
    actor.attributes.level = 3; // Advancing to lvl 4 (ASI level for all classes)
    actor.subclassId = "srd:subclass:thief";
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

    assert.equal(nextBtn.getAttribute("aria-disabled"), "true", "Next must be disabled when +2 exceeds maximum score of 20");

    // Before a Next attempt the cap violation is a quiet description, not an alert
    const singleSelect = container.querySelector("#asi-single-ability");
    assertAbsent(container.querySelector("[role='alert']"), "No alert before the user tries to proceed");
    assert.ok(singleSelect.getAttribute("aria-describedby"), "Select must reference the validation hint");
    assert.equal(singleSelect.getAttribute("aria-invalid"), null);

    // Pressing Next on the invalid step escalates the hint to an alert and marks the field invalid
    nextBtn.dispatchEvent(new (globalThis as any).Event("click"));
    const alertMsg = container.querySelector("[role='alert']");
    assert.ok(alertMsg, "Validation alert must have role='alert' after a submit attempt");
    assert.equal(alertMsg.getAttribute("aria-live"), null, "role='alert' must not be paired with aria-live='polite'");
    assert.equal(singleSelect.getAttribute("aria-describedby"), alertMsg.id);
    assert.equal(singleSelect.getAttribute("aria-invalid"), "true");

    // Switch to Feat mode
    const featTabBtn = container.querySelectorAll("button").find((b: any) => b.textContent.includes("Choose a Feat"));
    assert.ok(featTabBtn, "Feat tab button must exist");
    featTabBtn.dispatchEvent(new (globalThis as any).Event("click"));

    assert.equal(nextBtn.getAttribute("aria-disabled"), "true", "Next must be disabled when no Feat is selected");

    const featSelect = container.querySelector("#asi-feat-select");
    assert.ok(featSelect, "Feat select must be rendered with id='asi-feat-select'");
    featSelect.value = "srd:feat:alert";
    featSelect.dispatchEvent(new (globalThis as any).Event("change"));

    assert.equal(nextBtn.getAttribute("aria-disabled"), null, "Next must be enabled after selecting a valid Feat");

    unmount();
  });

  it("WHEN LevelUpModal Step 4 renders for a Wizard, LevelUpModal presents updated spell slot grid and requires exactly 2 new spells before completion (AC5)", async () => {
    const actor = createDefaultActorData("actor-wizard", "Galdor");
    actor.classId = "wizard";
    actor.attributes.level = 2; // Advancing to lvl 3 (Circle 2 spells unlock)
    actor.subclassId = "srd:subclass:evocation";
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
    assert.ok(container.textContent.includes("New spell slots"), "Spell slots section must be displayed");
    assert.ok(container.textContent.includes("LVL 1"), "Level 1 spell slots must be listed with LVL 1");
    assert.ok(container.textContent.includes("LVL 2"), "Level 2 spell slots must be listed with LVL 2");

    // Check Confirm button is available at Step 4 but disabled until 2 wizard spells are picked
    const confirmBtn = getConfirmButton();
    assert.ok(confirmBtn, "Confirm and Apply button must be present at Step 4");
    assert.equal(confirmBtn.getAttribute("aria-disabled"), "true", "Confirm button must be disabled for Wizard with 0 spells chosen");

    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    assert.ok(checkboxes.length >= 2, "Wizard must have at least 2 spells available");

    // Select first spell
    checkboxes[0].dispatchEvent(new (globalThis as any).Event("change"));
    assert.equal(confirmBtn.getAttribute("aria-disabled"), "true", "Confirm button must remain disabled with only 1 spell chosen");

    // Select second spell
    checkboxes[1].dispatchEvent(new (globalThis as any).Event("change"));
    assert.equal(confirmBtn.getAttribute("aria-disabled"), null, "Confirm button must be enabled once 2 spells are chosen");

    unmount();
  });

  it("WHEN LevelUpModal Step 4 renders for a divine caster (Cleric), LevelUpModal displays preparation banner and no checkboxes (AC5)", async () => {
    const actor = createDefaultActorData("actor-cleric", "Kyra");
    actor.classId = "cleric";
    actor.attributes.level = 1; // advancing to lvl 2
    actor.subclassId = "srd:subclass:life";
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

    assert.ok(container.textContent.includes("Divine spell preparation"), "Divine preparation banner must be displayed");
    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    assert.equal(checkboxes.length, 0, "Divine casters must not have spell learning checkboxes");

    const confirmBtn = getConfirmButton();
    assert.ok(confirmBtn, "Confirm button must be present");
    assert.equal(confirmBtn.getAttribute("aria-disabled"), null, "Confirm button must be enabled without checkbox requirement for divine caster");

    unmount();
  });

  it("WHEN user clicks 'Confirm and Apply', LevelUpModal invokes applyLevelUp with compiled LevelUpOptions, calls onSave with mutated actor, and triggers onClose (AC6)", async () => {
    const actor = createDefaultActorData("actor-fighter", "Kael");
    actor.classId = "fighter";
    actor.attributes.level = 1;
    actor.attributes.hp.max = 12;
    actor.attributes.hp.current = 12;
    actor.attributes.hitDieSize = 10;
    actor.abilities.con.score = 14;

    let savedActor = null as Dnd5eActorData | null;
    let closeTriggered = false;

    const { getNextButton, getConfirmButton, unmount } = await renderModal({
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

    const closeBtn = container.querySelector("button[aria-label='Close level up dialog']");
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

    const closeBtn = container.querySelector("button[aria-label='Close level up dialog']");
    assert.ok(closeBtn, "Close button must exist");
    assert.ok((globalThis as any).document.activeElement === closeBtn, "Initial focus must be placed on the close button");

    unmount();
  });

  it("WHEN keyboard Tab and Shift+Tab are pressed, focus is trapped inside the active modal dialog (WCAG 2.4.3)", async () => {
    const actor = createDefaultActorData("actor-wizard", "Galdor");
    actor.classId = "wizard";
    actor.attributes.level = 2;

    const { container, unmount } = await renderModal({
      isOpen: true,
      actor,
      onClose: () => {},
      onSave: () => {},
    });

    const dialog = container.querySelector("[role='dialog']");
    assert.ok(dialog, "Dialog element must exist");

    const closeBtn = container.querySelector("button[aria-label='Close level up dialog']");
    // Next is aria-disabled until a subclass is picked but stays focusable, so it is the last trap stop.
    const lastBtn = container.querySelectorAll("button").find((b: any) => b.textContent.includes("Next"));
    assert.ok(closeBtn, "Close button must exist");
    assert.ok(lastBtn, "Next button must exist");
    assert.equal(lastBtn.getAttribute("aria-disabled"), "true");

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
    assert.ok((globalThis as any).document.activeElement === lastBtn, "Shift+Tab on first element must wrap to last element");

    lastBtn.focus();
    let tabPrevented = false;
    dialog.dispatchEvent({
      type: "keydown",
      key: "Tab",
      shiftKey: false,
      preventDefault: () => { tabPrevented = true; },
      stopPropagation: () => {},
    });
    assert.equal(tabPrevented, true, "Tab on last element must prevent default");
    assert.ok((globalThis as any).document.activeElement === closeBtn, "Tab on last element must wrap to first element");

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

    const nav = container.querySelector("nav[aria-label='Progression steps']");
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
    actor.subclassId = "srd:subclass:thief";

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
    const featTab = tabs.find((t: any) => t.textContent.includes("Choose a Feat"));
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

  const advance = (getNextButton: () => any, steps: number) => {
    for (let i = 0; i < steps; i++) getNextButton().dispatchEvent(new (globalThis as any).Event("click"));
  };

  /** Builds a probe actor; `subclassId` is needed past the class's subclass level or step 1 blocks Next. */
  const actorFor = (classId: string, level: number, subclassId?: string) => {
    const actor = createDefaultActorData(`actor-${classId}`, "Probe");
    actor.classId = classId;
    actor.attributes.level = level;
    if (classId === "wizard") actor.attributes.casterType = "full";
    delete (actor as any).subclassId;
    delete (actor.attributes as any).subclassId;
    if (subclassId) actor.subclassId = subclassId;
    return actor;
  };

  const THIEF = "srd:subclass:thief";
  const EVOCATION = "srd:subclass:evocation";

  const CONTROL_SCENARIOS = [
    { id: "step1-subclass-select", classId: "wizard", level: 2, steps: 0, subclassId: undefined },
    { id: "step2-hit-points-choices", classId: "fighter", level: 1, steps: 1, subclassId: undefined },
    { id: "step3-asi-tabs-and-selects", classId: "rogue", level: 3, steps: 2, subclassId: THIEF },
    { id: "step4-wizard-spell-checkboxes", classId: "wizard", level: 2, steps: 3, subclassId: EVOCATION },
  ];

  for (const scenario of CONTROL_SCENARIOS) {
    it(`[${scenario.id}] every control uses a ds-* primitive (hit target, focus ring, control border)`, async () => {
      const { container, getNextButton, unmount } = await renderModal({
        isOpen: true,
        actor: actorFor(scenario.classId, scenario.level, scenario.subclassId),
        onClose: () => {},
        onSave: () => {},
      });
      if (scenario.id === "step1-subclass-select") {
        const select = container.querySelector("#subclass-select");
        select.value = "srd:subclass:evocation";
        select.dispatchEvent(new (globalThis as any).Event("change"));
      }
      advance(getNextButton, scenario.steps);

      for (const btn of container.querySelectorAll("button")) {
        const cls = btn.getAttribute("class") || "";
        assert.ok(/\bds-btn\b|\bds-btn-reset\b/.test(cls), `Button '${btn.textContent.trim()}' must use ds-btn or ds-btn-reset: ${cls}`);
      }
      for (const select of container.querySelectorAll("select")) {
        assert.ok(select.classList.contains("ds-input"), `Select #${select.id} must use ds-input`);
      }
      for (const input of container.querySelectorAll("input")) {
        assert.ok(input.closest("label")?.classList.contains("ds-choice"), "Radio/checkbox must sit inside a ds-choice label");
      }
      unmount();
    });
  }

  const PRIMARY_SCENARIOS = [
    { id: "next-on-step1", steps: 0, label: "Next" },
    { id: "confirm-on-step4", steps: 3, label: "Confirm and Apply" },
  ];

  for (const scenario of PRIMARY_SCENARIOS) {
    it(`[${scenario.id}] the single primary action uses ds-btn-primary`, async () => {
      const { container, getNextButton, unmount } = await renderModal({
        isOpen: true,
        actor: actorFor("fighter", 1),
        onClose: () => {},
        onSave: () => {},
      });
      advance(getNextButton, scenario.steps);
      const primaries = container.querySelectorAll(".ds-btn-primary");
      assert.equal(primaries.length, 1, "Exactly one primary action per step");
      assert.ok(primaries[0].textContent.includes(scenario.label));
      unmount();
    });
  }

  it("WHEN Next on step 3 leads to step 4, the Confirm button is a fresh element so focus cannot carry a second activation", async () => {
    const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
      isOpen: true,
      actor: actorFor("fighter", 1),
      onClose: () => {},
      onSave: () => {},
    });
    advance(getNextButton, 2);
    const nextOnStep3 = getNextButton();
    nextOnStep3.dispatchEvent(new (globalThis as any).Event("click"));
    const confirm = getConfirmButton();
    assert.ok(confirm, "Confirm must render on step 4");
    assert.ok(confirm !== nextOnStep3, "Next and Confirm must not share a DOM node");
    assert.equal(container.contains(nextOnStep3), false, "The Next node must be unmounted on step 4");
    unmount();
  });

  const HEADING_SCENARIOS = [
    { id: "step2-hit-points", steps: 1, heading: "Hit Point Increase" },
    { id: "step3-features-without-asi", steps: 2, heading: "Class Features" },
    { id: "step4-summary", steps: 3, heading: "Summary" },
  ];

  for (const scenario of HEADING_SCENARIOS) {
    it(`[${scenario.id}] moving to a step focuses that step's heading`, async () => {
      const { getNextButton, unmount } = await renderModal({
        isOpen: true,
        actor: actorFor("fighter", 1),
        onClose: () => {},
        onSave: () => {},
      });
      advance(getNextButton, scenario.steps);
      const active = (globalThis as any).document.activeElement;
      assert.equal(active?.nodeName, "H3", "Focus must land on the step heading");
      assert.equal(active.getAttribute("tabindex"), "-1");
      assert.ok(active.textContent.includes(scenario.heading), `Expected heading '${scenario.heading}', got '${active.textContent}'`);
      unmount();
    });
  }

  const SELECT_SCENARIOS = [
    { id: "subclass-select", classId: "wizard", level: 2, steps: 0, mode: null, subclassId: undefined },
    { id: "asi-single-ability", classId: "rogue", level: 3, steps: 2, mode: null, subclassId: THIEF },
    { id: "asi-first-ability", classId: "rogue", level: 3, steps: 2, mode: "plusOneOne", subclassId: THIEF },
    { id: "asi-second-ability", classId: "rogue", level: 3, steps: 2, mode: "plusOneOne", subclassId: THIEF },
    { id: "asi-feat-select", classId: "rogue", level: 3, steps: 2, mode: "feat", subclassId: THIEF },
    { id: "fighting-style-select", classId: "paladin", level: 1, steps: 2, mode: null, subclassId: undefined },
  ];

  for (const scenario of SELECT_SCENARIOS) {
    it(`[${scenario.id}] labelled select is named by its <label> alone (no aria-label override)`, async () => {
      const { container, getNextButton, unmount } = await renderModal({
        isOpen: true,
        actor: actorFor(scenario.classId, scenario.level, scenario.subclassId),
        onClose: () => {},
        onSave: () => {},
      });
      advance(getNextButton, scenario.steps);
      if (scenario.mode === "plusOneOne") {
        container.querySelectorAll("input[name='asiSubMode']").find((r: any) => r.value === "plusOneOne").dispatchEvent(new (globalThis as any).Event("change"));
      } else if (scenario.mode === "feat") {
        container.querySelector("#tab-feat").dispatchEvent(new (globalThis as any).Event("click"));
      }
      const select = container.querySelector(`#${scenario.id}`);
      assert.ok(select, `Select #${scenario.id} must render`);
      assert.equal(select.getAttribute("aria-label"), null);
      assert.ok(container.querySelector(`label[for='${scenario.id}']`), "A visible <label for> must name the select");
      unmount();
    });
  }

  const ROVING_SCENARIOS = [
    { id: "arrow-right-from-asi", start: "asi", key: "ArrowRight", expected: "feat" },
    { id: "arrow-left-from-asi-wraps", start: "asi", key: "ArrowLeft", expected: "feat" },
    { id: "arrow-right-from-feat-wraps", start: "feat", key: "ArrowRight", expected: "asi" },
    { id: "end-selects-feat", start: "asi", key: "End", expected: "feat" },
    { id: "home-selects-asi", start: "feat", key: "Home", expected: "asi" },
  ];

  for (const scenario of ROVING_SCENARIOS) {
    it(`[${scenario.id}] ASI/feat tabs rove with arrow keys and keep a single tab stop`, async () => {
      const { container, getNextButton, unmount } = await renderModal({
        isOpen: true,
        actor: actorFor("rogue", 3, THIEF),
        onClose: () => {},
        onSave: () => {},
      });
      advance(getNextButton, 2);
      const startTab = container.querySelector(`#tab-${scenario.start}`);
      startTab.dispatchEvent(new (globalThis as any).Event("click"));
      startTab.dispatchEvent({ type: "keydown", key: scenario.key, preventDefault: () => {} });

      const expected = container.querySelector(`#tab-${scenario.expected}`);
      const other = container.querySelector(`#tab-${scenario.expected === "asi" ? "feat" : "asi"}`);
      assert.equal(expected.getAttribute("aria-selected"), "true");
      assert.equal(expected.getAttribute("tabindex"), "0");
      assert.equal(other.getAttribute("tabindex"), "-1");
      assertSameNode((globalThis as any).document.activeElement, expected, "Focus must follow the selected tab");
      unmount();
    });
  }
});

describe("LevelUpModal: Fighting Style feat on the features step", () => {
  const actorAt = (classId: string, level: number, subclassId?: string): Dnd5eActorData => {
    const actor = createDefaultActorData(`actor-${classId}`, "Probe");
    actor.classId = classId;
    actor.attributes.level = level;
    actor.features = classId === "fighter" ? ["srd:feat:defense"] : [];
    if (subclassId) actor.subclassId = subclassId;
    return actor;
  };
  const click = (el: any) => el.dispatchEvent(new (globalThis as any).Event("click"));

  const SCENARIOS = [
    { id: "paladin-2-picks-a-style", actor: () => actorAt("paladin", 1), pick: "srd:feat:archery" },
    { id: "ranger-2-picks-a-style", actor: () => actorAt("ranger", 1), pick: "srd:feat:two_weapon_fighting" },
    { id: "champion-7-picks-an-additional-style", actor: () => actorAt("fighter", 6, "srd:subclass:champion"), pick: "srd:feat:archery" },
    { id: "fighter-2-has-no-style-step", actor: () => actorAt("fighter", 1), pick: null },
  ];

  for (const scenario of SCENARIOS) {
    it(`[${scenario.id}] the style is required before Next and recorded on confirm`, async () => {
      let saved = null as Dnd5eActorData | null;
      const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
        isOpen: true,
        actor: scenario.actor(),
        onClose: () => {},
        onSave: (updated) => {
          saved = updated;
        },
      });
      click(getNextButton());
      click(getNextButton());
      const select = container.querySelector("#fighting-style-select");
      if (!scenario.pick) {
        assertAbsent(select, "No Fighting Style select off its levels");
        unmount();
        return;
      }
      assert.ok(select, "The Fighting Style select must render");
      const offered = select.querySelectorAll("option").map((o: any) => o.value);
      assert.equal(offered.includes("srd:feat:defense"), scenario.actor().features?.length === 0, "A held style is not offered again");
      assert.equal(getNextButton().getAttribute("aria-disabled"), "true", "Next stays disabled until a style is chosen");
      select.value = scenario.pick;
      select.dispatchEvent(new (globalThis as any).Event("change"));
      assert.equal(getNextButton().getAttribute("aria-disabled"), null);
      click(getNextButton());
      click(getConfirmButton());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(saved, "onSave must receive the leveled actor");
      assert.equal(saved?.features?.includes(scenario.pick), true);
      unmount();
    });
  }
});

describe("LevelUpModal: GS10 feat slot filtering, +1 abilityIncrease ceiling, and feat sub-choices", () => {
  const click = (el: any) => el.dispatchEvent(new (globalThis as any).Event("click"));
  const change = (el: any) => el.dispatchEvent(new (globalThis as any).Event("change"));

  const SLOT_FILTER_CASES = [
    {
      id: "rogue-l4-offers-origin-and-grappler-without-epic-boons-or-fighting-styles",
      classId: "rogue",
      currentLevel: 3,
      subclassId: "srd:subclass:thief",
      abilities: { str: 10, dex: 16 },
      heldFeats: ["srd:feat:alert"],
      mustInclude: ["srd:feat:magic_initiate", "srd:feat:skilled", "srd:feat:savage_attacker", "srd:feat:grappler"],
      mustExclude: [
        "srd:feat:alert",
        "srd:feat:ability_score_improvement",
        "srd:feat:archery",
        "srd:feat:boon_of_combat_prowess",
        "srd:feat:boon_of_spell_recall",
      ],
    },
    {
      id: "wizard-l4-low-str-dex-excludes-grappler-and-epic-boons",
      classId: "wizard",
      currentLevel: 3,
      subclassId: "srd:subclass:evocation",
      abilities: { str: 8, dex: 12, int: 16 },
      heldFeats: [],
      mustInclude: ["srd:feat:alert", "srd:feat:magic_initiate", "srd:feat:skilled"],
      mustExclude: [
        "srd:feat:grappler",
        "srd:feat:archery",
        "srd:feat:boon_of_dimensional_travel",
        "srd:feat:boon_of_spell_recall",
      ],
    },
    {
      id: "fighter-l19-offers-martial-epic-boons-and-fighting-styles-but-excludes-spell-recall",
      classId: "fighter",
      currentLevel: 18,
      subclassId: "srd:subclass:champion",
      abilities: { str: 20, dex: 16 },
      heldFeats: ["srd:feat:defense"],
      mustInclude: [
        "srd:feat:archery",
        "srd:feat:boon_of_combat_prowess",
        "srd:feat:boon_of_dimensional_travel",
        "srd:feat:boon_of_fate",
        "srd:feat:boon_of_irresistible_offense",
        "srd:feat:boon_of_the_night_spirit",
        "srd:feat:boon_of_truesight",
      ],
      mustExclude: ["srd:feat:defense", "srd:feat:boon_of_spell_recall", "srd:feat:ability_score_improvement"],
    },
    {
      id: "cleric-l19-offers-all-seven-epic-boons-including-spell-recall",
      classId: "cleric",
      currentLevel: 18,
      subclassId: "srd:subclass:life",
      abilities: { str: 14, dex: 10, wis: 20 },
      heldFeats: [],
      mustInclude: [
        "srd:feat:boon_of_combat_prowess",
        "srd:feat:boon_of_dimensional_travel",
        "srd:feat:boon_of_fate",
        "srd:feat:boon_of_irresistible_offense",
        "srd:feat:boon_of_spell_recall",
        "srd:feat:boon_of_the_night_spirit",
        "srd:feat:boon_of_truesight",
      ],
      mustExclude: ["srd:feat:archery", "srd:feat:ability_score_improvement"],
    },
  ] as const;

  for (const tc of SLOT_FILTER_CASES) {
    it(`[${tc.id}] filters Step 3 feat options via getLevelUpFeatOptions`, async () => {
      const actor = createDefaultActorData(`actor-${tc.id}`, "Probe");
      actor.classId = tc.classId;
      actor.attributes.level = tc.currentLevel;
      actor.subclassId = tc.subclassId;
      actor.features = [...tc.heldFeats];
      for (const [ab, score] of Object.entries(tc.abilities)) {
        actor.abilities[ab as keyof typeof actor.abilities].score = score;
      }

      const { container, getNextButton, unmount } = await renderModal({
        isOpen: true,
        actor,
        onClose: () => {},
        onSave: () => {},
      });

      click(getNextButton());
      click(getNextButton());
      click(container.querySelector("#tab-feat"));

      const featSelect = container.querySelector("#asi-feat-select");
      const offered = featSelect
        .querySelectorAll("option")
        .map((o: any) => o.value)
        .filter(Boolean);

      for (const expected of tc.mustInclude) {
        assert.equal(offered.includes(expected), true, `Expected ${expected} in [${offered.join(", ")}]`);
      }
      for (const forbidden of tc.mustExclude) {
        assert.equal(offered.includes(forbidden), false, `Expected ${forbidden} NOT in [${offered.join(", ")}]`);
      }

      unmount();
    });
  }

  const ABILITY_INCREASE_CASES = [
    {
      id: "grappler-l4-caps-at-20-filters-capped-str-and-raises-dex",
      classId: "rogue",
      currentLevel: 3,
      subclassId: "srd:subclass:thief",
      featId: "srd:feat:grappler",
      initialScores: { str: 20, dex: 16 },
      expectedOptions: ["dex"],
      pickAbility: "dex" as const,
      expectedFinalScore: 17,
      expectedMaxLabel: "max 20",
    },
    {
      id: "epic-boon-combat-prowess-l19-allows-20-to-21-and-filters-30",
      classId: "fighter",
      currentLevel: 18,
      subclassId: "srd:subclass:champion",
      featId: "srd:feat:boon_of_combat_prowess",
      initialScores: { str: 20, dex: 18, con: 30, int: 10, wis: 12, cha: 10 },
      expectedOptions: ["str", "dex", "int", "wis", "cha"],
      pickAbility: "str" as const,
      expectedFinalScore: 21,
      expectedMaxLabel: "max 30",
    },
    {
      id: "epic-boon-spell-recall-l19-restricts-to-mental-abilities-up-to-30",
      classId: "cleric",
      currentLevel: 18,
      subclassId: "srd:subclass:life",
      featId: "srd:feat:boon_of_spell_recall",
      initialScores: { str: 14, dex: 10, con: 14, int: 12, wis: 20, cha: 30 },
      expectedOptions: ["int", "wis"],
      pickAbility: "wis" as const,
      expectedFinalScore: 21,
      expectedMaxLabel: "max 30",
    },
  ] as const;

  for (const tc of ABILITY_INCREASE_CASES) {
    it(`[${tc.id}] renders accessible +1 abilityIncrease selector and applies bonus on confirm`, async () => {
      const actor = createDefaultActorData(`actor-${tc.id}`, "Probe");
      actor.classId = tc.classId;
      actor.attributes.level = tc.currentLevel;
      actor.subclassId = tc.subclassId;
      if (tc.classId === "cleric") actor.attributes.casterType = "full";
      for (const [ab, score] of Object.entries(tc.initialScores)) {
        actor.abilities[ab as keyof typeof actor.abilities].score = score;
      }

      let saved: Dnd5eActorData | null = null;
      const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
        isOpen: true,
        actor,
        onClose: () => {},
        onSave: (updated) => {
          saved = updated;
        },
      });

      click(getNextButton());
      click(getNextButton());
      click(container.querySelector("#tab-feat"));

      const featSelect = container.querySelector("#asi-feat-select");
      featSelect.value = tc.featId;
      change(featSelect);

      const abilitySelect = container.querySelector("#feat-ability-increase");
      assert.ok(abilitySelect, "Feat ability increase select must render");
      assert.equal(abilitySelect.getAttribute("aria-label"), null, "Select must rely on <label for>, not aria-label");
      assert.ok(abilitySelect.classList.contains("ds-input"), "Select must use ds-input");
      assert.ok(abilitySelect.classList.contains("atlas-tabular-nums"), "Select must use atlas-tabular-nums");

      const label = container.querySelector("label[for='feat-ability-increase']");
      assert.ok(label, "Visible <label for='feat-ability-increase'> must exist");
      assert.ok(label.textContent.includes(tc.expectedMaxLabel), `Label '${label.textContent}' must state ${tc.expectedMaxLabel}`);

      const offeredAbilities = abilitySelect
        .querySelectorAll("option")
        .map((o: any) => o.value)
        .filter(Boolean);
      assert.deepEqual(offeredAbilities, [...tc.expectedOptions]);

      assert.equal(getNextButton().getAttribute("aria-disabled"), "true", "Next must stay disabled until +1 ability is chosen");

      abilitySelect.value = tc.pickAbility;
      change(abilitySelect);
      assert.equal(getNextButton().getAttribute("aria-disabled"), null, "Next must enable once +1 ability is chosen");

      click(getNextButton());
      click(getConfirmButton());
      await new Promise((r) => setTimeout(r, 10));

      assert.ok(saved, "onSave must receive leveled-up actor");
      assert.equal((saved as Dnd5eActorData).features?.includes(tc.featId), true);
      assert.equal((saved as Dnd5eActorData).abilities[tc.pickAbility].score, tc.expectedFinalScore);

      unmount();
    });
  }

  const SUBCHOICE_CASES = [
    {
      id: "magic-initiate-l4-collects-list-ability-cantrips-and-spell",
      featId: "srd:feat:magic_initiate",
      existingFeatChoices: [],
      existingSkills: [] as Array<keyof Dnd5eActorData["skills"]>,
      existingTools: [] as string[],
      expectAutoSeededSpellList: null as string | null,
      picks: [
        { choiceId: "spell_list", optionId: "cleric" },
        { choiceId: "spellcasting_ability", optionId: "wis" },
        { choiceId: "cantrips", optionId: "srd:spell:guidance" },
        { choiceId: "cantrips", optionId: "srd:spell:sacred_flame" },
        { choiceId: "level_1_spell", optionId: "srd:spell:bless" },
      ],
      verifySaved: (saved: Dnd5eActorData) => {
        const record = saved.featChoices?.find((r) => r.featId === "srd:feat:magic_initiate");
        assert.ok(record, "Magic Initiate FeatChoiceRecord must be saved");
        assert.deepEqual(record.selections, {
          spell_list: ["cleric"],
          spellcasting_ability: ["wis"],
          cantrips: ["srd:spell:guidance", "srd:spell:sacred_flame"],
          level_1_spell: ["srd:spell:bless"],
        });
      },
    },
    {
      id: "magic-initiate-auto-seeds-last-remaining-spell-list",
      featId: "srd:feat:magic_initiate",
      existingFeatChoices: [
        {
          featId: "srd:feat:magic_initiate",
          selections: {
            spell_list: ["cleric"],
            spellcasting_ability: ["wis"],
            cantrips: ["srd:spell:guidance", "srd:spell:sacred_flame"],
            level_1_spell: ["srd:spell:bless"],
          },
        },
        {
          featId: "srd:feat:magic_initiate",
          selections: {
            spell_list: ["druid"],
            spellcasting_ability: ["wis"],
            cantrips: ["srd:spell:guidance", "srd:spell:produce_flame"],
            level_1_spell: ["srd:spell:healing_word"],
          },
        },
      ],
      existingSkills: [] as Array<keyof Dnd5eActorData["skills"]>,
      existingTools: [] as string[],
      expectAutoSeededSpellList: "wizard",
      picks: [
        { choiceId: "spellcasting_ability", optionId: "int" },
        { choiceId: "cantrips", optionId: "srd:spell:fire_bolt" },
        { choiceId: "cantrips", optionId: "srd:spell:mage_hand" },
        { choiceId: "level_1_spell", optionId: "srd:spell:magic_missile" },
      ],
      verifySaved: (saved: Dnd5eActorData) => {
        assert.equal(saved.featChoices?.length, 3, "Must append third Magic Initiate record");
        assert.deepEqual(saved.featChoices?.[2]?.selections, {
          spell_list: ["wizard"],
          spellcasting_ability: ["int"],
          cantrips: ["srd:spell:fire_bolt", "srd:spell:mage_hand"],
          level_1_spell: ["srd:spell:magic_missile"],
        });
      },
    },
    {
      id: "skilled-l4-filters-owned-proficiencies-and-grants-three-picks",
      featId: "srd:feat:skilled",
      existingFeatChoices: [],
      existingSkills: ["stealth"] as Array<keyof Dnd5eActorData["skills"]>,
      existingTools: ["Thieves' Tools"],
      expectAutoSeededSpellList: null as string | null,
      picks: [
        { choiceId: "proficiencies", optionId: "athletics" },
        { choiceId: "proficiencies", optionId: "perception" },
        { choiceId: "proficiencies", optionId: "tool:Herbalism Kit" },
      ],
      verifySaved: (saved: Dnd5eActorData) => {
        assert.equal(saved.skills.athletics.proficiencyRank, 1, "Athletics proficiency must be granted");
        assert.equal(saved.skills.perception.proficiencyRank, 1, "Perception proficiency must be granted");
        assert.equal(saved.proficiencies?.tools.includes("Herbalism Kit"), true, "Herbalism Kit proficiency must be granted");
        const record = saved.featChoices?.find((r) => r.featId === "srd:feat:skilled");
        assert.ok(record, "Skilled FeatChoiceRecord must be saved");
        assert.deepEqual(record.selections.proficiencies, ["athletics", "perception", "tool:Herbalism Kit"]);
      },
    },
  ];

  for (const tc of SUBCHOICE_CASES) {
    it(`[${tc.id}] gates progression until feat sub-choices complete and applies applyFeatChoices`, async () => {
      const actor = createDefaultActorData(`actor-${tc.id}`, "Probe");
      actor.classId = "rogue";
      actor.attributes.level = 3;
      actor.subclassId = "srd:subclass:thief";
      actor.features = tc.existingFeatChoices.map((r) => r.featId);
      actor.featChoices = structuredClone(tc.existingFeatChoices);
      for (const sk of tc.existingSkills) {
        actor.skills[sk].proficiencyRank = 1;
      }
      if (tc.existingTools.length > 0) {
        actor.proficiencies = { armor: [], weapons: [], tools: [...tc.existingTools] };
      }

      let saved: Dnd5eActorData | null = null;
      const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
        isOpen: true,
        actor,
        onClose: () => {},
        onSave: (updated) => {
          saved = updated;
        },
      });

      click(getNextButton());
      click(getNextButton());
      click(container.querySelector("#tab-feat"));

      const featSelect = container.querySelector("#asi-feat-select");
      featSelect.value = tc.featId;
      change(featSelect);

      if (tc.expectAutoSeededSpellList) {
        const seededRadio = container.querySelector(
          `[data-testid='levelup-feat-spell_list-${tc.expectAutoSeededSpellList}']`
        );
        assert.ok(seededRadio?.checked, `Single-option spell_list '${tc.expectAutoSeededSpellList}' must be auto-seeded`);
      }

      if (tc.featId === "srd:feat:skilled") {
        assertAbsent(
          container.querySelector("[data-testid='levelup-feat-proficiencies-stealth']"),
          "Already proficient skill must be excluded from Skilled options"
        );
        assertAbsent(
          container.querySelector("[data-testid=\"levelup-feat-proficiencies-tool:Thieves' Tools\"]"),
          "Already proficient tool must be excluded from Skilled options"
        );
      }

      // Every input in sub-choices must adhere to ds-choice primitive
      for (const input of container.querySelectorAll("input")) {
        assert.ok(input.closest("label")?.classList.contains("ds-choice"), "Feat sub-choice inputs must use ds-choice labels");
      }

      for (let i = 0; i < tc.picks.length; i++) {
        assert.equal(
          getNextButton().getAttribute("aria-disabled"),
          "true",
          `Next must remain disabled before pick ${i + 1}/${tc.picks.length}`
        );
        const { choiceId, optionId } = tc.picks[i];
        const input = container.querySelector(`[data-testid="levelup-feat-${choiceId}-${optionId}"]`);
        assert.ok(input, `Option control levelup-feat-${choiceId}-${optionId} must render`);
        change(input);
      }

      assert.equal(getNextButton().getAttribute("aria-disabled"), null, "Next must become enabled once all sub-choices are complete");

      click(getNextButton());
      assert.equal(getConfirmButton().getAttribute("aria-disabled"), null, "Confirm must be enabled on Step 4");
      click(getConfirmButton());
      await new Promise((r) => setTimeout(r, 10));

      assert.ok(saved, "onSave must receive leveled-up actor with feat choices applied");
      tc.verifySaved(saved as Dnd5eActorData);

      unmount();
    });
  }
});

describe("LevelUpModal: SRD 5.2.1 prepared-caster spell allowances & described L2 choice reminders (Q7, Q11)", () => {
  const click = (el: any) => el.dispatchEvent(new (globalThis as any).Event("click"));
  const change = (el: any) => el.dispatchEvent(new (globalThis as any).Event("change"));

  const ALLOWANCE_CASES = [
    { id: "sorcerer-1-to-2-grants-2-spells", classId: "sorcerer", currentLevel: 1, subclassId: undefined, expectedAllowance: 2, isWizard: false },
    { id: "sorcerer-2-to-3-grants-2-spells", classId: "sorcerer", currentLevel: 2, subclassId: "srd:subclass:draconic", expectedAllowance: 2, isWizard: false },
    { id: "sorcerer-3-to-4-grants-1-spell", classId: "sorcerer", currentLevel: 3, subclassId: "srd:subclass:draconic", expectedAllowance: 1, isWizard: false },
    { id: "bard-1-to-2-grants-1-spell", classId: "bard", currentLevel: 1, subclassId: undefined, expectedAllowance: 1, isWizard: false },
    { id: "warlock-1-to-2-grants-1-spell", classId: "warlock", currentLevel: 1, subclassId: undefined, expectedAllowance: 1, isWizard: false },
    { id: "wizard-1-to-2-grants-2-spellbook-spells", classId: "wizard", currentLevel: 1, subclassId: undefined, expectedAllowance: 2, isWizard: true },
  ] as const;

  for (const tc of ALLOWANCE_CASES) {
    it(`[${tc.id}] derives allowance from SRD 5.2.1 prepared spell counts and caps Step 4 checkboxes`, async () => {
      localeSignal.value = "en";
      const targetLevel = tc.currentLevel + 1;
      assert.equal(getNewSpellsAllowance(tc.classId, targetLevel), tc.expectedAllowance);

      const actor = createDefaultActorData(`actor-${tc.id}`, "Caster");
      actor.classId = tc.classId;
      actor.attributes.level = tc.currentLevel;
      actor.attributes.casterType = tc.classId === "warlock" ? "pact" : "full";
      actor.abilities.dex.score = 14;
      if (tc.subclassId) actor.subclassId = tc.subclassId;

      const { container, getNextButton, getConfirmButton, unmount } = await renderModal({
        isOpen: true,
        actor,
        onClose: () => {},
        onSave: () => {},
      });

      click(getNextButton()); // Step 1 -> 2
      click(getNextButton()); // Step 2 -> 3
      click(getNextButton()); // Step 3 -> 4

      const expectedHeading = tc.isWizard
        ? `Add spells to your spellbook (Required: 0/${tc.expectedAllowance})`
        : `Add new spells (Limit: 0/${tc.expectedAllowance})`;
      assert.ok(
        container.textContent.includes(expectedHeading),
        `Expected '${expectedHeading}' in Step 4 text: ${container.textContent}`
      );

      const checkboxes = container.querySelectorAll("input[type='checkbox']");
      assert.ok(checkboxes.length > tc.expectedAllowance, "Compendium must offer more spells than the cap");

      for (let i = 0; i < tc.expectedAllowance; i++) {
        change(checkboxes[i]);
      }

      assert.equal(checkboxes[tc.expectedAllowance].disabled, true, "Unpicked spells must disable once allowance is reached");
      assert.equal(getConfirmButton().getAttribute("aria-disabled"), null, "Confirm must be enabled at exact allowance");

      unmount();
    });
  }

  const REMINDER_CASES = [
    {
      id: "wizard-l2-scholar-reminder-en",
      locale: "en" as const,
      classId: "wizard",
      currentLevel: 1,
      fightingStylePick: null,
      expectReminder: /Scholar/,
    },
    {
      id: "wizard-l2-scholar-reminder-fr",
      locale: "fr" as const,
      classId: "wizard",
      currentLevel: 1,
      fightingStylePick: null,
      expectReminder: /Rappel \(Scholar\)/,
    },
    {
      id: "ranger-l2-deft-explorer-reminder-en",
      locale: "en" as const,
      classId: "ranger",
      currentLevel: 1,
      fightingStylePick: "srd:feat:archery",
      expectReminder: /Deft Explorer/,
    },
    {
      id: "sorcerer-l2-metamagic-reminder-en",
      locale: "en" as const,
      classId: "sorcerer",
      currentLevel: 1,
      fightingStylePick: null,
      expectReminder: /Metamagic/,
    },
    {
      id: "fighter-l2-no-manual-choice-reminder",
      locale: "en" as const,
      classId: "fighter",
      currentLevel: 1,
      fightingStylePick: null,
      expectReminder: null,
    },
    {
      id: "cleric-l2-no-manual-choice-reminder",
      locale: "en" as const,
      classId: "cleric",
      currentLevel: 1,
      fightingStylePick: null,
      expectReminder: null,
    },
  ];

  for (const tc of REMINDER_CASES) {
    it(`[${tc.id}] renders levelup-manual-feature-reminder iff targetLevel grants Scholar, Deft Explorer, or Metamagic`, async () => {
      localeSignal.value = tc.locale;
      const actor = createDefaultActorData(`actor-${tc.id}`, "Hero");
      actor.classId = tc.classId;
      actor.attributes.level = tc.currentLevel;

      const { container, unmount } = await renderModal({
        isOpen: true,
        actor,
        onClose: () => {},
        onSave: () => {},
      });

      click(container.querySelector(".ds-btn-primary")); // Step 1 -> 2
      click(container.querySelector(".ds-btn-primary")); // Step 2 -> 3
      if (tc.fightingStylePick) {
        const fsSelect = container.querySelector("#fighting-style-select");
        fsSelect.value = tc.fightingStylePick;
        change(fsSelect);
      }
      click(container.querySelector(".ds-btn-primary")); // Step 3 -> 4

      const reminder = container.querySelector("[data-testid='levelup-manual-feature-reminder']");
      if (tc.expectReminder) {
        assert.ok(reminder, "Expected [data-testid='levelup-manual-feature-reminder'] on Step 4");
        assert.match(reminder.textContent, tc.expectReminder);
      } else {
        assertAbsent(reminder, "Expected no manual feature reminder on Step 4");
      }

      unmount();
      localeSignal.value = "en";
    });
  }
});

