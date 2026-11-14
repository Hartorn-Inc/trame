import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import { localeSignal } from "../../src/i18n/index.ts";
import { DeclarativeSheetView } from "../../src/sheet/DeclarativeSheetView.tsx";
import { CompendiumDrawer } from "../../src/compendium/CompendiumDrawer.tsx";
import { assertAbsent } from "../helpers/domAssert.ts";
import { mount } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

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
