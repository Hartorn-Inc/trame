import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { h, render, options } from "preact";
import { signal } from "@preact/signals";
import { createDefaultActorData, type Dnd5eActorData } from "../../../game-systems/dnd5e/src/index.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import {
  CharacterSheetHeader,
  persistActorUpdate,
  handleUpdateActorDataEvent,
} from "../../src/components/character-sheet/CharacterSheetHeader.tsx";
import {
  HudDrawers,
  isSheetDrawerOpenSignal,
  activeHudActorSignal,
} from "../../src/components/hud/HudDrawers.tsx";
import {
  HudDrawers as CanonicalHudDrawers,
  isSheetDrawerOpenSignal as canonicalSheetDrawerOpenSignal,
} from "../../src/hud/HudDrawers.tsx";

import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

async function renderToDom(vnode: any) {
  options.debounceRendering = (cb: () => void) => cb();
  const doc = (globalThis as any).document || setupMockDom();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  render(vnode, container);
  await new Promise((r) => setTimeout(r, 15));

  const unmount = () => {
    render(null, container);
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
    doc.activeElement = null;
  };

  const getElementByTestId = (testId: string): any => {
    return container.querySelector(`[data-testid="${testId}"]`);
  };

  return {
    container,
    unmount,
    getElementByTestId,
    rerender: async (newVnode: any) => {
      render(newVnode, container);
      await new Promise((r) => setTimeout(r, 15));
    },
  };
}

describe("CharacterSheetHeader & HudDrawers REST/CQRS Dual Persistence Suite (#87)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    isSheetDrawerOpenSignal.value = false;
    activeHudActorSignal.value = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    isSheetDrawerOpenSignal.value = false;
    activeHudActorSignal.value = null;
  });

  it("WHEN an Actor sheet renders in CampaignWorkspace, CharacterSheetHeader displays compact '[Level Up (Lvl N -> N+1)]', '[Short Rest]', and '[Long Rest]' action buttons (AC1)", async () => {
    const actor = createDefaultActorData("actor-warrior", "Thorin");
    actor.classId = "fighter";
    actor.attributes.level = 3;

    const { getElementByTestId, unmount } = await renderToDom(
      h(CharacterSheetHeader, {
        actor,
        campaignId: "campaign-101",
        context: "campaign_workspace",
      })
    );

    const levelUpBtn = getElementByTestId("btn-level-up");
    const shortRestBtn = getElementByTestId("btn-short-rest");
    const longRestBtn = getElementByTestId("btn-long-rest");
    const nameEl = getElementByTestId("sheet-actor-name");
    const summaryEl = getElementByTestId("sheet-actor-summary");

    assert.ok(levelUpBtn, "btn-level-up must be mounted");
    assert.ok(shortRestBtn, "btn-short-rest must be mounted");
    assert.ok(longRestBtn, "btn-long-rest must be mounted");
    assert.equal(nameEl?.textContent, "Thorin");
    assert.equal(summaryEl?.textContent, "Level 3 fighter");
    assert.equal(levelUpBtn.textContent, "Level Up (Lvl 3 -> 4)");
    assert.equal(shortRestBtn.textContent, "Short Rest");
    assert.equal(longRestBtn.textContent, "Long Rest");
    assert.equal(levelUpBtn.getAttribute("aria-label"), "Level Up (Lvl 3 -> 4)");
    assert.equal(levelUpBtn.disabled, false);

    unmount();
  });

  it("WHEN user clicks '[Level Up]' in CampaignWorkspace, LevelUpModal opens and onSave persists the updated actor via PUT /api/v1/campaigns/{campaign_id}/actors/{actor_id} (AC2)", async () => {
    const actor = createDefaultActorData("actor-mage", "Elminster");
    actor.classId = "wizard";
    actor.attributes.level = 1;
    actor.attributes.casterType = "full";

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = null;
    let capturedContentType = "";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      capturedContentType = (init?.headers as Record<string, string>)?.[ "Content-Type" ] ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    let savedActor = null as Dnd5eActorData | null;
    const { getElementByTestId, container, unmount } = await renderToDom(
      h(CharacterSheetHeader, {
        actor,
        campaignId: "camp-xyz-9",
        context: "campaign_workspace",
        onSave: (updated) => {
          savedActor = updated;
        },
      })
    );

    const levelUpBtn = getElementByTestId("btn-level-up");
    assert.ok(levelUpBtn, "Level Up button must be present");

    // Click to open LevelUpModal
    levelUpBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 15));

    const modalEl = container.querySelector("[data-testid='level-up-modal']");
    assert.ok(modalEl, "LevelUpModal should be mounted in DOM upon click");

    // Persist actor update using the REST channel contract
    const updatedActor: Dnd5eActorData = {
      ...actor,
      attributes: { ...actor.attributes, level: 2 },
    };

    await persistActorUpdate(updatedActor, {
      campaignId: "camp-xyz-9",
      isLiveTable: false,
      onSave: (res) => {
        savedActor = res;
      },
    });

    assert.equal(capturedUrl, "/api/v1/campaigns/camp-xyz-9/actors/actor-mage");
    assert.equal(capturedMethod, "PUT");
    assert.equal(capturedContentType, "application/json");
    assert.equal(capturedBody?.attributes?.level, 2);
    assert.equal(savedActor?.attributes.level, 2);

    unmount();
  });

  it("WHEN an Actor sheet renders in Live Table HudDrawers, CharacterSheetHeader displays compact '[Level Up]', '[Short Rest]', and '[Long Rest]' buttons (AC3)", async () => {
    const actor = createDefaultActorData("actor-cleric", "Kyra");
    actor.classId = "cleric";
    actor.attributes.level = 5;

    const { getElementByTestId, unmount } = await renderToDom(
      h(CharacterSheetHeader, {
        actor,
        context: "hud_drawer",
        isLiveTable: true,
      })
    );

    const levelUpBtn = getElementByTestId("btn-level-up");
    const shortRestBtn = getElementByTestId("btn-short-rest");
    const longRestBtn = getElementByTestId("btn-long-rest");

    assert.ok(levelUpBtn);
    assert.ok(shortRestBtn);
    assert.ok(longRestBtn);
    assert.equal(levelUpBtn.textContent, "Level Up", "Live Table mode must render compact 'Level Up' text");
    assert.equal(shortRestBtn.textContent, "Short Rest");
    assert.equal(longRestBtn.textContent, "Long Rest");

    unmount();
  });

  it("WHEN user completes LevelUp or Rest from HudDrawers during an active table session, onSave dispatches a WebSocket UpdateActorData TrameCommand to TableRoomActor (AC4)", async () => {
    const actor = createDefaultActorData("actor-rogue", "Merisiel");
    actor.classId = "rogue";
    actor.attributes.level = 4;

    const dispatchedCommands: any[] = [];
    const dispatchCommand = (cmd: any) => {
      dispatchedCommands.push(cmd);
    };

    let fetchInvoked = false;
    globalThis.fetch = (async () => {
      fetchInvoked = true;
      return new Response("{}", { status: 200 });
    }) as any;

    const actorSig = signal<Dnd5eActorData>(actor);

    const { getElementByTestId, container, unmount } = await renderToDom(
      h(CharacterSheetHeader, {
        actor,
        actorSignal: actorSig,
        context: "hud_drawer",
        isLiveTable: true,
        tableSessionActive: true,
        dispatchCommand,
      })
    );

    // Test Short Rest modal opening
    const shortRestBtn = getElementByTestId("btn-short-rest");
    shortRestBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(container.querySelector("[data-testid='rest-modal']"), "Short Rest modal must open");

    // Test dual persistence contract for live table
    const updatedActor: Dnd5eActorData = {
      ...actor,
      attributes: { ...actor.attributes, level: 5 },
    };

    await persistActorUpdate(updatedActor, {
      isLiveTable: true,
      tableSessionActive: true,
      dispatchCommand,
      actorSignal: actorSig,
    });

    assert.equal(fetchInvoked, false, "WebSocket CQRS mode must bypass HTTP REST fetch");
    assert.equal(dispatchedCommands.length, 1, "Must dispatch exactly 1 UpdateActorData command");
    assert.equal(dispatchedCommands[0].type, "UpdateActorData");
    assert.equal(dispatchedCommands[0].actorId, "actor-rogue");
    assert.equal(dispatchedCommands[0].actor.attributes.level, 5);
    assert.equal(actorSig.value.attributes.level, 5);

    unmount();
  });

  it("WHEN table clients receive an UpdateActorData event, Preact signals update the actor sheet reactively across all connected clients (AC5)", async () => {
    const initialActor = createDefaultActorData("actor-barbarian", "Krag");
    initialActor.classId = "barbarian";
    initialActor.attributes.level = 2;

    const actorSignal = signal<Dnd5eActorData>(initialActor);

    const { getElementByTestId, unmount } = await renderToDom(
      h(CharacterSheetHeader, {
        actor: initialActor,
        actorSignal,
        context: "live_table",
        isLiveTable: true,
      })
    );

    const summaryEl = getElementByTestId("sheet-actor-summary");
    assert.equal(summaryEl?.textContent, "Level 2 barbarian");

    // Simulate remote server WebSocket broadcast received by table client
    const remoteUpdatedActor: Dnd5eActorData = {
      ...initialActor,
      name: "Krag the Victorious",
      attributes: { ...initialActor.attributes, level: 3 },
    };

    handleUpdateActorDataEvent(
      { type: "UpdateActorData", actor: remoteUpdatedActor },
      actorSignal
    );

    await new Promise((r) => setTimeout(r, 15));

    assert.equal(actorSignal.value.name, "Krag the Victorious");
    assert.equal(actorSignal.value.attributes.level, 3);

    const nameEl = getElementByTestId("sheet-actor-name");
    assert.equal(nameEl?.textContent, "Krag the Victorious");
    assert.equal(getElementByTestId("sheet-actor-summary")?.textContent, "Level 3 barbarian");

    // Test alternative event envelope: { event: 'ActorUpdated', payload: ... }
    handleUpdateActorDataEvent(
      {
        event: "ActorUpdated",
        payload: { ...remoteUpdatedActor, name: "Krag Chieftain" },
      },
      actorSignal
    );
    assert.equal(actorSignal.value.name, "Krag Chieftain");

    unmount();
  });

  it("handleUpdateActorDataEvent ignores events targeting other actors without clobbering local actorSignal (AC5)", () => {
    const localActor = createDefaultActorData("actor-local-1", "Local Hero");
    const actorSignal = signal<Dnd5eActorData>(localActor);

    // Incoming event for a foreign actor with mismatched event.actorId
    handleUpdateActorDataEvent(
      {
        type: "UpdateActorData",
        actorId: "actor-foreign-99",
        actor: { ...localActor, id: "actor-foreign-99", name: "Foreign Intruder" },
      },
      actorSignal
    );
    assert.equal(actorSignal.value.id, "actor-local-1");
    assert.equal(actorSignal.value.name, "Local Hero", "Foreign event must not clobber local actor name");

    // Incoming event with mismatched actor_id
    handleUpdateActorDataEvent(
      {
        event: "ActorUpdated",
        actor_id: "actor-foreign-99",
        payload: { ...localActor, id: "actor-foreign-99", name: "Foreign Intruder 2" },
      },
      actorSignal
    );
    assert.equal(actorSignal.value.id, "actor-local-1");
    assert.equal(actorSignal.value.name, "Local Hero");

    // Incoming event with mismatched data.id only
    handleUpdateActorDataEvent(
      {
        type: "UpdateActorData",
        data: { ...localActor, id: "actor-foreign-99", name: "Foreign Intruder 3" },
      },
      actorSignal
    );
    assert.equal(actorSignal.value.id, "actor-local-1");
    assert.equal(actorSignal.value.name, "Local Hero");

    // Incoming event matching local actorId updates actorSignal
    handleUpdateActorDataEvent(
      {
        type: "UpdateActorData",
        actorId: "actor-local-1",
        actor: { ...localActor, name: "Local Hero Promoted" },
      },
      actorSignal
    );
    assert.equal(actorSignal.value.name, "Local Hero Promoted");

    // Incoming event with matching envelope actorId but conflicting data.id does not clobber
    handleUpdateActorDataEvent(
      {
        type: "UpdateActorData",
        actorId: "actor-local-1",
        actor: { ...localActor, id: "actor-foreign-different", name: "Spoofed Actor" },
      },
      actorSignal
    );
    assert.equal(actorSignal.value.name, "Local Hero Promoted");

    // Incoming event with missing IDs does not clobber local actor
    handleUpdateActorDataEvent(
      {
        type: "UpdateActorData",
        actor: { name: "Anonymous Update" } as any,
      },
      actorSignal
    );
    assert.equal(actorSignal.value.name, "Local Hero Promoted");
  });

  it("displays explicit business guardrails with full keyboard and ARIA accessibility (WCAG 2.1 AA) (AC6)", async () => {
    const maxLevelActor = createDefaultActorData("actor-paladin", "Seelah");
    maxLevelActor.classId = "paladin";
    maxLevelActor.attributes.level = 20;

    const { container, getElementByTestId, unmount } = await renderToDom(
      h(CharacterSheetHeader, {
        actor: maxLevelActor,
        context: "campaign_workspace",
      })
    );

    const headerEl = getElementByTestId("character-sheet-header");
    assert.equal(headerEl?.getAttribute("role"), "region");
    assert.equal(headerEl?.getAttribute("aria-label"), "Character Sheet Actions");

    const toolbar = container.querySelector("[role='toolbar']");
    assert.ok(toolbar, "Progression actions must be wrapped in role='toolbar'");
    assert.equal(toolbar.getAttribute("aria-label"), "Progression and Rest Actions");

    const levelUpBtn = getElementByTestId("btn-level-up");
    assert.ok(levelUpBtn);
    assert.equal(levelUpBtn.disabled, true, "Level 20 actor must have disabled Level Up button");
    assert.equal(levelUpBtn.getAttribute("aria-disabled"), "true");
    assert.equal(
      levelUpBtn.getAttribute("aria-label"),
      "Level Up disabled: Maximum Level 20 reached"
    );
    assert.equal(levelUpBtn.getAttribute("title"), "Maximum level reached (20)");

    // Verify clicking disabled button does not open LevelUpModal
    levelUpBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(container.querySelector("[data-testid='level-up-modal']"), null);

    // Verify Short and Long Rest buttons provide accessible labels
    const shortRestBtn = getElementByTestId("btn-short-rest");
    const longRestBtn = getElementByTestId("btn-long-rest");
    assert.equal(shortRestBtn.getAttribute("aria-label"), "Short Rest");
    assert.equal(longRestBtn.getAttribute("aria-label"), "Long Rest");

    unmount();
  });

  it("HudDrawers mounts CharacterSheetHeader in drawer and emits UpdateActorData on drawer save", async () => {
    const liveActor = createDefaultActorData("actor-hud-1", "Live Champion");
    liveActor.classId = "fighter";
    liveActor.attributes.level = 2;

    const dispatched: any[] = [];
    const dispatch = (cmd: any) => dispatched.push(cmd);

    // Open drawer via signal
    isSheetDrawerOpenSignal.value = true;

    const { container, unmount } = await renderToDom(
      h(HudDrawers, {
        actor: liveActor,
        actorId: liveActor.id,
        dispatchCommand: dispatch,
        isLiveTable: true,
        tableSessionActive: true,
      })
    );

    const drawerEl = container.querySelector("[data-testid='hud-sheet-drawer']");
    assert.ok(drawerEl, "Sheet drawer must be rendered when isSheetDrawerOpenSignal is true");

    const headerEl = container.querySelector("[data-testid='character-sheet-header']");
    assert.ok(headerEl, "CharacterSheetHeader must be rendered inside HudDrawers sheet drawer");

    const levelUpBtn = container.querySelector("[data-testid='btn-level-up']");
    assert.ok(levelUpBtn);
    assert.equal(levelUpBtn.textContent, "Level Up", "In HudDrawers, button text must be 'Level Up'");

    // Verify Long Rest save in HudDrawers dispatches exactly one UpdateActorData command
    const longRestBtn = container.querySelector("[data-testid='btn-long-rest']");
    assert.ok(longRestBtn, "Long Rest button must be present in sheet header");
    longRestBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 15));

    const restModal = container.querySelector("[data-testid='rest-modal']");
    assert.ok(restModal, "RestModal must open upon clicking Long Rest");

    const buttons = restModal.querySelectorAll("button");
    const confirmBtn: any = Array.from(buttons).find((b: any) =>
      b.textContent?.includes("Confirm Long Rest")
    );
    assert.ok(confirmBtn, "Confirm Long Rest button must be rendered in RestModal");
    confirmBtn.dispatchEvent(new (globalThis as any).Event("click"));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(dispatched.length, 1, "Must dispatch exactly one UpdateActorData command without duplicates");
    assert.equal(dispatched[0].type, "UpdateActorData");
    assert.equal(dispatched[0].actorId, "actor-hud-1");

    // Verify Escape key closes the sheet drawer
    drawerEl.dispatchEvent(new (globalThis as any).Event("keydown", { key: "Escape" }));
    assert.equal(isSheetDrawerOpenSignal.value, false, "Escape key must close sheet drawer");

    unmount();
  });

  it("canonical packages/web/src/hud/HudDrawers.tsx mounts CharacterSheetHeader and shares reactive signals", async () => {
    assert.equal(canonicalSheetDrawerOpenSignal, isSheetDrawerOpenSignal, "Drawer signals must be singletons");

    canonicalSheetDrawerOpenSignal.value = true;
    const actor = createDefaultActorData("actor-can-1", "Canonical Hero");
    const { container, unmount } = await renderToDom(
      h(CanonicalHudDrawers, {
        actor,
        actorId: actor.id,
      })
    );

    const headerEl = container.querySelector("[data-testid='character-sheet-header']");
    assert.ok(headerEl, "CharacterSheetHeader must be rendered inside canonical HudDrawers");
    assert.ok(container.querySelector("[data-testid='btn-level-up']"), "Level Up button must be mounted");
    assert.ok(container.querySelector("[data-testid='btn-short-rest']"), "Short Rest button must be mounted");
    assert.ok(container.querySelector("[data-testid='btn-long-rest']"), "Long Rest button must be mounted");

    canonicalSheetDrawerOpenSignal.value = false;
    unmount();
  });
});
