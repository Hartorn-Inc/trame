import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import {
  applyClassChoices,
  createDefaultActorData,
  getClassChoices,
  type Dnd5eActorData,
} from "../../../game-systems/dnd5e/src/index.ts";
import { ApiClient, VERSION_CONFLICT } from "../../src/api/client.ts";
import { createSessionState } from "../../src/api/session.ts";
import { CompendiumDrawer } from "../../src/compendium/CompendiumDrawer.tsx";
import { HudDrawers, isCompendiumDrawerOpenSignal, isSheetDrawerOpenSignal } from "../../src/hud/HudDrawers.tsx";
import { localeSignal } from "../../src/i18n/index.ts";
import { ActorSheetPanel } from "../../src/sheet/ActorSheetPanel.tsx";
import { DeclarativeSheetView, nextSheetTabIndex } from "../../src/sheet/DeclarativeSheetView.tsx";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
import { mount } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { actorDto, createMockTransport, flush } from "../helpers/mockTransport.ts";

setupMockDom();
localeSignal.value = "en";

describe("DeclarativeSheetView: padlock toggle keeps a stable name", () => {
  const cases = [
    { id: "a locked sheet: Edit Mode not pressed", props: { coreStatsLocked: true }, pressed: "false", gmHint: false },
    { id: "an unlocked sheet: Edit Mode pressed", props: { coreStatsLocked: false }, pressed: "true", gmHint: false },
    { id: "a GM-locked sheet: Edit Mode disabled and described by the GM lock", props: { gm_core_locked: true, coreStatsLocked: false }, pressed: "false", gmHint: true },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const ui = mount(h(DeclarativeSheetView, { actorState: { sheet: {} }, ...c.props }));
      const toggle = ui.byTestId("sheet-padlock-toggle");
      assert.equal(toggle.textContent, "Edit Mode");
      assert.equal(toggle.getAttribute("aria-label"), null);
      assert.equal(toggle.getAttribute("aria-pressed"), c.pressed);
      if (c.gmHint) {
        assert.equal(toggle.getAttribute("aria-describedby"), "sheet-gm-locked-hint");
        assert.equal(ui.byTestId("sheet-gm-locked").textContent, "GM Locked");
      } else {
        assertAbsent(ui.byTestId("sheet-gm-locked"), "GM lock hint");
      }
      ui.unmount();
    });
  }

  it("toggling keeps the name and flips aria-pressed", () => {
    const ui = mount(h(DeclarativeSheetView, { actorState: { sheet: {} } }));
    ui.click("sheet-padlock-toggle");
    const toggle = ui.byTestId("sheet-padlock-toggle");
    assert.equal(toggle.textContent, "Edit Mode");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    ui.unmount();
  });
});

describe("DeclarativeSheetView Component & CoreBuildLock", () => {
  it("evaluates isLocked = true when gm_core_locked is true", () => {
    const vnode = DeclarativeSheetView({
      actorState: { sheet: { abilities: { str: 16 } } },
      gm_core_locked: true,
      coreStatsLocked: false,
    });
    assert.ok(vnode);
    assert.equal(vnode.props['data-testid'], 'declarative-sheet-view');
  });

  it("falls back cleanly when sheetLayout has null root without throwing exceptions", () => {
    const vnode = DeclarativeSheetView({
      actorState: { sheet: {} },
      sheetLayout: { systemId: 'dnd5e', version: '1.0.0', root: null },
    });
    assert.ok(vnode);
    assert.equal(vnode.props['data-testid'], 'declarative-sheet-view');
  });

  it("CompendiumDrawer exposes tablist role, tabpanel, and programmatic selection state on category buttons", () => {
    const drawer = CompendiumDrawer({
      isOpen: true,
      onClose: () => {},
      systemId: 'dnd5e',
    });
    assert.ok(drawer);
    const tabsContainer = drawer.props.children[2];
    assert.equal(tabsContainer.props.role, 'tablist');
    const firstTab = tabsContainer.props.children[0];
    assert.equal(firstTab.props.role, 'tab');
    assert.equal(firstTab.props['aria-selected'], 'true');
    assert.equal(firstTab.props['aria-controls'], 'compendium-tabpanel');
    const secondTab = tabsContainer.props.children[1];
    assert.equal(secondTab.props.role, 'tab');
    assert.equal(secondTab.props['aria-selected'], 'false');
    const tabPanel = drawer.props.children[3];
    assert.equal(tabPanel.props.role, 'tabpanel');
  });

  it("CompendiumDrawer dispatches DropCompendiumEntry command when clicking [ Add ]", () => {
    const dispatched: any[] = [];
    const drawer = CompendiumDrawer({
      isOpen: true,
      onClose: () => {},
      systemId: 'dnd5e',
      actorId: 'pc-warrior-1',
      dispatchCommand: (cmd) => dispatched.push(cmd),
      entries: [
        {
          id: 'item-longsword',
          slug: 'longsword',
          name: 'Longsword',
          entityType: 'item',
          tier: 'SYSTEM_SRD',
          data: { weight: 3 },
        },
      ],
    });
    assert.ok(drawer);
    const tabPanel = drawer.props.children[3];
    const list = tabPanel.props.children;
    const itemCard = list.props.children[0];
    const addButton = itemCard.props.children[3];
    assert.equal(addButton.props['data-testid'], 'btn-add-entry-longsword');
    addButton.props.onClick({ stopPropagation: () => {} });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, 'DROP_COMPENDIUM_ENTRY');
    assert.equal(dispatched[0].actorId, 'pc-warrior-1');
    assert.equal(dispatched[0].entryRef, 'item-longsword');
    assert.equal(dispatched[0].targetContainerId, null);
  });

  it("CompendiumDrawer dispatches DropCompendiumEntry with targetContainerId when targetContainerId prop is provided", () => {
    const dispatched: any[] = [];
    const drawer = CompendiumDrawer({
      isOpen: true,
      onClose: () => {},
      systemId: 'dnd5e',
      actorId: 'pc-warrior-1',
      targetContainerId: 'backpack-main',
      dispatchCommand: (cmd) => dispatched.push(cmd),
      entries: [
        {
          id: 'item-longsword',
          slug: 'longsword',
          name: 'Longsword',
          entityType: 'item',
          tier: 'SYSTEM_SRD',
          data: { weight: 3 },
        },
      ],
    });
    assert.ok(drawer);
    const tabPanel = drawer.props.children[3];
    const list = tabPanel.props.children;
    const itemCard = list.props.children[0];
    const addButton = itemCard.props.children[3];
    addButton.props.onClick({ stopPropagation: () => {} });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].cmd, 'DROP_COMPENDIUM_ENTRY');
    assert.equal(dispatched[0].actorId, 'pc-warrior-1');
    assert.equal(dispatched[0].entryRef, 'item-longsword');
    assert.equal(dispatched[0].targetContainerId, 'backpack-main');
  });
});

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_URL = `/api/v1/campaigns/${CAMPAIGN_ID}/actors/${ACTOR_ID}`;

function createBarbarianActor(level = 2, activeFeatureIds: string[] = []): Dnd5eActorData {
  const base = createDefaultActorData(ACTOR_ID, "Brakka");
  const choices = getClassChoices("barbarian", { actor: base });
  const selections = Object.fromEntries(choices.map((c) => [c.id, c.options.slice(0, c.count).map((o) => o.id)]));
  const chosen = applyClassChoices(base, "barbarian", selections);
  return {
    ...chosen,
    attributes: {
      ...chosen.attributes,
      level,
    },
    activeFeatureIds,
  };
}

describe("F1: DEFAULT_DND5E_SHEET_LAYOUT binds sheet.activeFeatureIds on FeatureTraitList", () => {
  const cases = [
    {
      id: "f1-activate-reckless-preserves-rage",
      initialActive: ["barbarian:rage"],
      buttonTestId: "btn-feature-toggle-barbarian:reckless_attack",
      expectedActive: ["barbarian:rage", "barbarian:reckless_attack"],
    },
    {
      id: "f1-deactivate-reckless-preserves-rage",
      initialActive: ["barbarian:rage", "barbarian:reckless_attack"],
      buttonTestId: "btn-feature-toggle-barbarian:reckless_attack",
      expectedActive: ["barbarian:rage"],
    },
    {
      id: "f1-deactivate-rage-preserves-reckless",
      initialActive: ["barbarian:rage", "barbarian:reckless_attack"],
      buttonTestId: "btn-feature-toggle-barbarian:rage",
      expectedActive: ["barbarian:reckless_attack"],
    },
  ];

  for (const scenario of cases) {
    it(`[${scenario.id}] toggling a class feature preserves remaining activeFeatureIds`, async () => {
      localeSignal.value = "en";
      const actor = createBarbarianActor(2, scenario.initialActive);
      const transport = createMockTransport({
        [`PUT ${ACTOR_URL}`]: { status: 200, body: { actor: actorDto({ version: 2, data: actor }) } },
      });
      const state = createSessionState();
      state.actors.value = { [ACTOR_ID]: { version: 1, data: actor } as any };
      const client = new ApiClient({ transport, state });

      const ui = mount(h(ActorSheetPanel, { campaignId: CAMPAIGN_ID, client, actorId: ACTOR_ID, context: "hud_drawer" }));
      ui.click("tab-btn-tab-features");
      ui.click(scenario.buttonTestId);
      await flush(4);

      const puts = transport.calls.filter((c) => c.method === "PUT");
      assert.equal(puts.length, 1);
      assert.deepEqual((puts[0].body as Record<string, any>).data.activeFeatureIds, scenario.expectedActive);
      ui.unmount();
    });
  }
});

describe("F4: Character sheet tablist roving tabIndex, keyboard navigation, and ATLAS .ds-tablist/.ds-tab primitives", () => {
  const indexCases = [
    { id: "f4-index-arrow-right-next", index: 0, key: "ArrowRight", count: 5, expected: 1 },
    { id: "f4-index-arrow-right-wrap", index: 4, key: "ArrowRight", count: 5, expected: 0 },
    { id: "f4-index-arrow-left-wrap", index: 0, key: "ArrowLeft", count: 5, expected: 4 },
    { id: "f4-index-home-first", index: 3, key: "Home", count: 5, expected: 0 },
    { id: "f4-index-end-last", index: 1, key: "End", count: 5, expected: 4 },
    { id: "f4-index-unrelated-key-ignored", index: 2, key: "Enter", count: 5, expected: null },
  ];

  for (const c of indexCases) {
    it(`[${c.id}] nextSheetTabIndex(${c.index}, ${c.key}, ${c.count}) -> ${c.expected}`, () => {
      assert.equal(nextSheetTabIndex(c.index, c.key, c.count), c.expected);
    });
  }

  const domScenarios = [
    {
      id: "f4-dom-arrow-right-from-combat-to-spells",
      isOwner: true,
      startClick: null as string | null,
      key: "ArrowRight",
      expectedActive: "tab-spells",
      visibleTabs: ["tab-combat", "tab-spells", "tab-inventory", "tab-features", "tab-bio"],
    },
    {
      id: "f4-dom-arrow-left-wraps-first-to-bio-for-owner",
      isOwner: true,
      startClick: null,
      key: "ArrowLeft",
      expectedActive: "tab-bio",
      visibleTabs: ["tab-combat", "tab-spells", "tab-inventory", "tab-features", "tab-bio"],
    },
    {
      id: "f4-dom-arrow-right-wraps-features-to-combat-for-public-viewer",
      isOwner: false,
      startClick: "tab-btn-tab-features",
      key: "ArrowRight",
      expectedActive: "tab-combat",
      visibleTabs: ["tab-combat", "tab-spells", "tab-inventory", "tab-features"],
    },
    {
      id: "f4-dom-end-jumps-to-last-tab",
      isOwner: true,
      startClick: null,
      key: "End",
      expectedActive: "tab-bio",
      visibleTabs: ["tab-combat", "tab-spells", "tab-inventory", "tab-features", "tab-bio"],
    },
    {
      id: "f4-dom-home-jumps-to-first-tab",
      isOwner: true,
      startClick: "tab-btn-tab-inventory",
      key: "Home",
      expectedActive: "tab-combat",
      visibleTabs: ["tab-combat", "tab-spells", "tab-inventory", "tab-features", "tab-bio"],
    },
  ];

  for (const scenario of domScenarios) {
    it(`[${scenario.id}] updates roving tabIndex, focus, aria-selected, and tabpanel linkage`, () => {
      localeSignal.value = "en";
      const viewer = scenario.isOwner
        ? { viewerId: "u1", isGm: false, isOwner: true }
        : { viewerId: "u2", isGm: false, isOwner: false };
      const ui = mount(h(DeclarativeSheetView, { actorState: { sheet: {}, derived: {} }, viewer }));

      const tablist = ui.byTestId("sheet-tablist");
      assertPresent(tablist, "sheet-tablist");
      assert.equal(tablist.getAttribute("role"), "tablist");
      assert.ok(tablist.classList.contains("ds-tablist"), "tablist uses .ds-tablist");

      const initialTabId = scenario.startClick ?? "tab-btn-tab-combat";
      if (scenario.startClick) {
        ui.click(scenario.startClick);
      }

      ui.key(initialTabId, scenario.key);

      for (const tabId of scenario.visibleTabs) {
        const btn = ui.byTestId(`tab-btn-${tabId}`);
        assertPresent(btn, `tab-btn-${tabId}`);
        assert.ok(btn.classList.contains("ds-tab"), `${tabId} uses .ds-tab`);
        assert.equal(btn.getAttribute("aria-controls"), `tab-body-${tabId}`);
        const isExpected = tabId === scenario.expectedActive;
        assert.equal(btn.getAttribute("aria-selected"), isExpected ? "true" : "false");
        assert.equal(btn.getAttribute("tabIndex"), isExpected ? "0" : "-1");
      }

      assert.equal((globalThis as any).document.activeElement?.id, `tab-btn-${scenario.expectedActive}`);
      const panel = ui.byTestId(`tab-body-${scenario.expectedActive}`);
      assertPresent(panel, `tab-body-${scenario.expectedActive}`);
      assert.equal(panel.getAttribute("role"), "tabpanel");
      assert.equal(panel.getAttribute("aria-labelledby"), `tab-btn-${scenario.expectedActive}`);

      ui.unmount();
    });
  }
});

describe("F2: ActorSheetPanel and HudDrawers surface 409 conflicts (with server re-sync) and network errors", () => {
  const conflictAndErrorCases = [
    {
      id: "f2-actor-sheet-panel-409-conflict-en-resyncs-and-clears-on-save",
      surface: "panel" as const,
      locale: "en" as const,
      putReply: {
        status: 409,
        body: { code: VERSION_CONFLICT, error: "version conflict", current_version: 5 },
      },
      expectedAlertSubstring: "version 5",
      expectGetResync: true,
      clearMode: "next-save" as const,
    },
    {
      id: "f2-hud-drawers-409-conflict-fr-resyncs-and-dismisses",
      surface: "hud" as const,
      locale: "fr" as const,
      putReply: {
        status: 409,
        body: { code: VERSION_CONFLICT, error: "version conflict", current_version: 3 },
      },
      expectedAlertSubstring: "version 3",
      expectGetResync: true,
      clearMode: "dismiss" as const,
    },
    {
      id: "f2-actor-sheet-panel-500-error-surfaces-alert",
      surface: "panel" as const,
      locale: "en" as const,
      putReply: {
        status: 500,
        body: { code: "INTERNAL_ERROR", error: "Database offline" },
      },
      expectedAlertSubstring: "Database offline",
      expectGetResync: false,
      clearMode: "dismiss" as const,
    },
  ];

  for (const scenario of conflictAndErrorCases) {
    it(`[${scenario.id}] surfaces accessible role="alert" and handles recovery`, async () => {
      localeSignal.value = scenario.locale;
      const staleActor = createBarbarianActor(2, []);
      const serverSyncedVersion = (scenario.putReply.body as any).current_version ?? 5;
      const syncedActor: Dnd5eActorData = {
        ...staleActor,
        attributes: {
          ...staleActor.attributes,
          hp: { ...staleActor.attributes.hp, current: 7 },
        },
      };

      const transport = createMockTransport({
        [`PUT ${ACTOR_URL}`]: scenario.putReply,
        [`GET ${ACTOR_URL}`]: {
          status: 200,
          body: { actor: actorDto({ id: ACTOR_ID, campaign_id: CAMPAIGN_ID, version: serverSyncedVersion, data: syncedActor }) },
        },
      });
      const state = createSessionState();
      state.actors.value = { [ACTOR_ID]: { id: ACTOR_ID, campaignId: CAMPAIGN_ID, version: 1, data: staleActor } as any };
      const client = new ApiClient({ transport, state });

      isSheetDrawerOpenSignal.value = scenario.surface === "hud";
      const ui =
        scenario.surface === "hud"
          ? mount(h(HudDrawers, { campaignId: CAMPAIGN_ID, client, actorId: ACTOR_ID }))
          : mount(h(ActorSheetPanel, { campaignId: CAMPAIGN_ID, client, actorId: ACTOR_ID, context: "hud_drawer" }));

      ui.click("tab-btn-tab-features");
      ui.click("btn-feature-toggle-barbarian:rage");
      await flush(6);

      const alertBanner = ui.byTestId("sheet-persistence-alert");
      assertPresent(alertBanner, "sheet-persistence-alert");
      assert.equal(alertBanner.getAttribute("role"), "alert");
      assert.ok(
        alertBanner.textContent.includes(scenario.expectedAlertSubstring),
        `Expected alert "${alertBanner.textContent}" to include "${scenario.expectedAlertSubstring}"`,
      );

      const getCalls = transport.calls.filter((c) => c.method === "GET" && c.url === ACTOR_URL);
      if (scenario.expectGetResync) {
        assert.equal(getCalls.length, 1, "409 conflict must re-read the latest actor sheet via GET");
        assert.equal(state.actors.value[ACTOR_ID]?.version, serverSyncedVersion);
        assert.equal((state.actors.value[ACTOR_ID]?.data as Dnd5eActorData).attributes.hp.current, 7);
      } else {
        assert.equal(getCalls.length, 0);
      }

      if (scenario.clearMode === "dismiss") {
        ui.click("btn-dismiss-sheet-alert");
        assertAbsent(ui.byTestId("sheet-persistence-alert"), "dismissed sheet-persistence-alert");
      } else {
        transport.routes[`PUT ${ACTOR_URL}`] = {
          status: 200,
          body: { actor: actorDto({ id: ACTOR_ID, campaign_id: CAMPAIGN_ID, version: serverSyncedVersion + 1, data: syncedActor }) },
        };
        ui.click("btn-feature-toggle-barbarian:rage");
        await flush(6);
        assertAbsent(ui.byTestId("sheet-persistence-alert"), "cleared sheet-persistence-alert after successful save");
      }

      isSheetDrawerOpenSignal.value = false;
      localeSignal.value = "en";
      ui.unmount();
    });
  }

  it("[f2-hud-drawers-dispatcher-conflict] HudDrawers own command dispatcher refreshes actor and surfaces hud-persistence-alert", async () => {
    localeSignal.value = "en";
    const staleActor = createBarbarianActor(2, []);
    const syncedActor = createBarbarianActor(2, ["barbarian:rage"]);
    const transport = createMockTransport({
      [`PUT ${ACTOR_URL}`]: {
        status: 409,
        body: { code: VERSION_CONFLICT, error: "conflict", current_version: 4 },
      },
      [`GET ${ACTOR_URL}`]: {
        status: 200,
        body: { actor: actorDto({ id: ACTOR_ID, campaign_id: CAMPAIGN_ID, version: 4, data: syncedActor }) },
      },
    });
    const state = createSessionState();
    state.actors.value = { [ACTOR_ID]: { id: ACTOR_ID, campaignId: CAMPAIGN_ID, version: 1, data: staleActor } as any };
    const client = new ApiClient({ transport, state });

    isSheetDrawerOpenSignal.value = false;
    isCompendiumDrawerOpenSignal.value = false;
    const vnode = HudDrawers({ campaignId: CAMPAIGN_ID, client, actorId: ACTOR_ID });
    const compendiumVNode = vnode.props.children.find((child: any) => child?.type === CompendiumDrawer);
    assert.ok(compendiumVNode?.props?.dispatchCommand, "HudDrawers wires dispatchCommand to CompendiumDrawer");

    const ui = mount(h(HudDrawers, { campaignId: CAMPAIGN_ID, client, actorId: ACTOR_ID }));
    // Trigger an UPDATE_ACTOR_SHEET through HudDrawers' wired dispatcher via re-rendered CompendiumDrawer prop:
    compendiumVNode.props.dispatchCommand({ cmd: "UPDATE_ACTOR_SHEET", path: "notes", value: "Updated note" });
    await flush(6);

    assert.equal(transport.calls.filter((c) => c.method === "GET" && c.url === ACTOR_URL).length, 1);
    assert.equal(state.actors.value[ACTOR_ID]?.version, 4);
    ui.unmount();
  });
});

