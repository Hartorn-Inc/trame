import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { h } from "preact";
import { SRD_521_ATTRIBUTION } from "../../../game-systems/dnd5e/src/index.ts";
import { selectedActorIdSignal, selectedTokenIdSignal } from "../../src/api/session.ts";
import { isSheetDrawerOpenSignal } from "../../src/hud/HudDrawers.tsx";
import { localeSignal } from "../../src/i18n/index.ts";
import { MapsWorkspaceTab, sceneNameFromFile, upsertScene } from "../../src/maps/MapsWorkspaceTab.tsx";
import type { CampaignMapScene } from "../../src/maps/types.ts";
import {
  activeCompanionTabSignal,
  companionActorId,
  MobileCompanionView,
  type MobileCompanionTab,
} from "../../src/mobile/MobileCompanionView.tsx";
import { firstFreeCell } from "../../src/table/tableView.ts";
import { ActorsTab } from "../../src/workspace/ActorsTab.tsx";
import { CampaignWorkspace, nextTabIndex, WORKSPACE_TABS, type WorkspaceTabId } from "../../src/workspace/CampaignWorkspace.tsx";
import { CAMPAIGN, GM_ID, HERO, HERO_ACTOR, OTHER_PLAYER_ID, PLAYER_ID, fullToken, liveTable, mount, tableState } from "../helpers/liveTable.ts";
import { actorDto, flush } from "../helpers/mockTransport.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const ACTORS_URL = `/api/v1/campaigns/${CAMPAIGN}/actors`;
const ACTOR_URL = `${ACTORS_URL}/${HERO_ACTOR}`;
const ASSETS_URL = `/api/v1/campaigns/${CAMPAIGN}/assets`;
const MAPS_URL = `/api/v1/campaigns/${CAMPAIGN}/maps`;
const SCENE_ID = "dddddddd-0000-4000-8000-000000000001";
const ASSET_KEY = `instances/i/campaigns/${CAMPAIGN}/assets/abc123.webp`;

const heroSheet = { name: "Brakka", abilities: { dex: { score: 14, saveProficiency: false } }, attributes: { hp: { current: 12, max: 13 }, baseArmorAC: 14, shieldBonus: 2, speedFt: 30 } };
const heroDto = (overrides: Record<string, unknown> = {}) => actorDto({ id: HERO_ACTOR, owner_user_id: PLAYER_ID, version: 4, data: heroSheet, ...overrides });
const assetReply = { status: 201, body: { hash: "abc123", key: ASSET_KEY, url: "https://signed", expires_in_secs: 300 } };
const backendScene = { id: SCENE_ID, campaign_id: CAMPAIGN, name: "Crypt", grid_size_px: 50, width_px: 1000, height_px: 1000, wall_segments: [], light_sources: [], spatial_audio_emitters: [], staged_tokens: [], spawn_points: [] };

/** Simulates choosing `file` in a file input. */
function chooseFile(el: any, file: File) {
  el.files = [file];
  el.dispatchEvent({ type: "change", target: el });
}

beforeEach(() => {
  selectedActorIdSignal.value = null;
  selectedTokenIdSignal.value = null;
  isSheetDrawerOpenSignal.value = false;
  activeCompanionTabSignal.value = "sheet";
});

describe("CampaignWorkspace: five tabs", () => {
  const panels: Array<{ id: string; tab: WorkspaceTabId; role: "GM" | "PLAYER"; inner: string }> = [
    { id: "Table tab mounts the live table", tab: "table", role: "GM", inner: "table-tab" },
    { id: "Maps tab gives the GM the studio", tab: "maps", role: "GM", inner: "maps-workspace" },
    { id: "Maps tab gives a player the read-only atlas", tab: "maps", role: "PLAYER", inner: "scene-atlas" },
    { id: "Actors tab lists the sheets", tab: "actors", role: "PLAYER", inner: "actors-tab" },
    { id: "Documents tab shows the notes tree", tab: "documents", role: "PLAYER", inner: "notes-hierarchy-tree" },
    { id: "Compendium tab shows the SRD browser", tab: "compendium", role: "PLAYER", inner: "compendium-drawer" },
  ];
  for (const c of panels) {
    it(c.id, () => {
      const { client } = liveTable(c.role === "GM" ? GM_ID : PLAYER_ID, tableState());
      const ui = mount(h(CampaignWorkspace, { campaignId: CAMPAIGN, userRole: c.role, client }));
      ui.click(`workspace-tab-${c.tab}`);
      assert.equal(ui.byTestId(`workspace-tab-${c.tab}`).getAttribute("aria-selected"), "true");
      assert.ok(ui.byTestId(`workspace-panel-${c.tab}`), "panel rendered");
      assert.ok(ui.byTestId(c.inner), `${c.inner} rendered`);
      ui.unmount();
    });
  }

  it("renders all five tabs with a single tab stop", () => {
    const { client } = liveTable(GM_ID, tableState());
    const ui = mount(h(CampaignWorkspace, { campaignId: CAMPAIGN, userRole: "GM", client }));
    const stops = WORKSPACE_TABS.filter((id) => ui.byTestId(`workspace-tab-${id}`).getAttribute("tabindex") === "0");
    assert.deepEqual(stops, ["table"]);
    ui.unmount();
  });

  it("shows the SRD 5.2.1 notice verbatim on the Compendium tab", () => {
    const { client } = liveTable(PLAYER_ID, null);
    const ui = mount(h(CampaignWorkspace, { campaignId: CAMPAIGN, userRole: "PLAYER", client, activeTab: "compendium" }));
    assert.ok(ui.byTestId("srd-attribution").textContent.includes(SRD_521_ATTRIBUTION));
    ui.unmount();
  });

  const keys = [
    { id: "ArrowRight moves to the next tab", index: 0, key: "ArrowRight", expected: 1 },
    { id: "ArrowRight wraps from the last tab", index: 4, key: "ArrowRight", expected: 0 },
    { id: "ArrowLeft wraps from the first tab", index: 0, key: "ArrowLeft", expected: 4 },
    { id: "Home jumps to the first tab", index: 3, key: "Home", expected: 0 },
    { id: "End jumps to the last tab", index: 1, key: "End", expected: 4 },
    { id: "other keys are ignored", index: 2, key: "Enter", expected: null },
  ];
  for (const c of keys) {
    it(`nextTabIndex: ${c.id}`, () => assert.equal(nextTabIndex(c.index, c.key, WORKSPACE_TABS.length), c.expected));
  }
});

describe("ActorsTab: create, open, place, portrait", () => {
  it("lists the sheets returned by the server", async () => {
    const { client } = liveTable(PLAYER_ID, null, { [`GET ${ACTORS_URL}`]: { status: 200, body: { actors: [heroDto()] } } });
    const ui = mount(h(ActorsTab, { campaignId: CAMPAIGN, client, isGm: false }));
    await flush();
    assert.ok(ui.byTestId(`actor-${HERO_ACTOR}`));
    ui.unmount();
  });

  const placeCases = [
    { id: "GM gets a Place on table button", isGm: true, visible: true },
    { id: "player does not", isGm: false, visible: false },
  ];
  for (const c of placeCases) {
    it(`place control: ${c.id}`, async () => {
      const { client } = liveTable(c.isGm ? GM_ID : PLAYER_ID, tableState(), { [`GET ${ACTORS_URL}`]: { status: 200, body: { actors: [heroDto()] } } });
      const ui = mount(h(ActorsTab, { campaignId: CAMPAIGN, client, isGm: c.isGm }));
      await flush();
      assert.equal(Boolean(ui.byTestId(`actor-place-${HERO_ACTOR}`)), c.visible);
      ui.unmount();
    });
  }

  it("GM placement spawns a linked token on the first free cell with the sheet's vitals", async () => {
    const occupied = tableState({ tokens: { [HERO]: fullToken(HERO, "Other", { top_left: { x: 0, y: 0 } }) } });
    const table = liveTable(GM_ID, occupied, { [`GET ${ACTORS_URL}`]: { status: 200, body: { actors: [heroDto()] } } });
    const ui = mount(h(ActorsTab, { campaignId: CAMPAIGN, client: table.client, isGm: true }));
    await flush();
    ui.click(`actor-place-${HERO_ACTOR}`);
    const spawn = table.commands().find((c) => c.cmd === "SPAWN_TOKEN");
    assert.ok(spawn, "SPAWN_TOKEN sent");
    assert.equal(spawn.token.actor_id, HERO_ACTOR);
    assert.equal(spawn.token.owner_user_id, PLAYER_ID);
    assert.deepEqual(spawn.token.top_left, { x: 50, y: 0 });
    assert.equal(spawn.token.hp, 12);
    assert.equal(spawn.token.max_hp, 13);
    ui.unmount();
  });

  it("opens the sheet drawer for the chosen actor", async () => {
    const { client } = liveTable(PLAYER_ID, null, { [`GET ${ACTORS_URL}`]: { status: 200, body: { actors: [heroDto()] } } });
    const ui = mount(h(ActorsTab, { campaignId: CAMPAIGN, client, isGm: false }));
    await flush();
    ui.click(`actor-open-${HERO_ACTOR}`);
    assert.equal(selectedActorIdSignal.value, HERO_ACTOR);
    assert.equal(isSheetDrawerOpenSignal.value, true);
    ui.unmount();
  });

  it("opens the character-creation modal", () => {
    const { client } = liveTable(PLAYER_ID, null);
    const ui = mount(h(ActorsTab, { campaignId: CAMPAIGN, client, isGm: false }));
    ui.click("actors-new");
    assert.ok(ui.container.querySelector('[role="dialog"]'), "modal open");
    ui.unmount();
  });

  const portraits = [
    { id: "stored version is sent and the key is saved", reply: { status: 200, body: { actor: heroDto({ version: 5 }) } }, alert: false },
    { id: "a stale sheet surfaces a conflict alert", reply: { status: 409, body: { code: "VERSION_CONFLICT", error: "stale", current_version: 9 } }, alert: true },
  ];
  for (const c of portraits) {
    it(`portrait upload: ${c.id}`, async () => {
      const table = liveTable(PLAYER_ID, null, {
        [`GET ${ACTORS_URL}`]: { status: 200, body: { actors: [heroDto()] } },
        [`POST ${ASSETS_URL}`]: assetReply,
        [`PUT ${ACTOR_URL}`]: c.reply,
      });
      const ui = mount(h(ActorsTab, { campaignId: CAMPAIGN, client: table.client, isGm: false }));
      await flush();
      chooseFile(ui.byTestId(`actor-portrait-${HERO_ACTOR}`), new File([new Uint8Array([1])], "hero.png", { type: "image/png" }));
      await flush();
      const put = table.transport.calls.find((call) => call.method === "PUT");
      assert.ok(table.transport.calls.some((call) => call.method === "POST" && call.url === ASSETS_URL), "asset uploaded");
      assert.equal((put?.body as any).expected_version, 4);
      assert.equal((put?.body as any).data.portraitAssetKey, ASSET_KEY);
      assert.equal(Boolean(ui.byTestId("actors-error")), c.alert);
      ui.unmount();
    });
  }
});

describe("firstFreeCell", () => {
  const cases = [
    { id: "empty board drops at the origin", state: tableState(), expected: { x: 0, y: 0 } },
    { id: "occupied origin moves one cell right", state: tableState({ tokens: { [HERO]: fullToken(HERO, "A") } }), expected: { x: 50, y: 0 } },
    { id: "a full first row wraps to the next row", state: tableState({ map_width_px: 100, tokens: { a: fullToken("a", "A"), b: fullToken("b", "B", { top_left: { x: 50, y: 0 } }) } }), expected: { x: 0, y: 50 } },
    { id: "no table falls back to the origin", state: null, expected: { x: 0, y: 0 } },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual(firstFreeCell(c.state), c.expected));
  }
});

describe("MapsWorkspaceTab: import, background, activation", () => {
  const mapRoutes = (extra = {}) => ({
    [`GET ${MAPS_URL}`]: { status: 200, body: [backendScene] },
    [`PUT ${MAPS_URL}`]: { status: 200, body: {} },
    ...extra,
  });

  it("GM imports a Universal VTT file as a named scene", async () => {
    const table = liveTable(GM_ID, null, mapRoutes({ [`POST ${MAPS_URL}/import?name=Crypt%20B`]: { status: 201, body: { scene: { ...backendScene, id: "s-2", name: "Crypt B" } } } }));
    const ui = mount(h(MapsWorkspaceTab, { campaignId: CAMPAIGN, client: table.client, isGm: true }));
    await flush();
    chooseFile(ui.byTestId("maps-import-uvtt"), new File(["{}"], "Crypt B.uvtt"));
    await flush();
    assert.ok(table.transport.calls.some((c) => c.method === "POST" && c.url === `${MAPS_URL}/import?name=Crypt%20B`));
    assert.match(ui.byTestId("maps-status").textContent, /Crypt B imported/);
    ui.unmount();
  });

  it("GM background upload stores the asset key on the scene and saves every scene", async () => {
    const table = liveTable(GM_ID, null, mapRoutes({ [`POST ${ASSETS_URL}`]: assetReply }));
    const ui = mount(h(MapsWorkspaceTab, { campaignId: CAMPAIGN, client: table.client, isGm: true }));
    await flush();
    ui.input("maps-background-scene", SCENE_ID, "change");
    chooseFile(ui.byTestId("maps-upload-background"), new File([new Uint8Array([1])], "crypt.png", { type: "image/png" }));
    await flush();
    const put = table.transport.calls.find((c) => c.method === "PUT" && c.url === MAPS_URL);
    assert.equal((put?.body as any).scenes.length, 1);
    assert.equal((put?.body as any).scenes[0].background_image_url, ASSET_KEY);
    ui.unmount();
  });

  it("GM activation saves the scene, then sends ACTIVATE_SCENE with only its id", async () => {
    const table = liveTable(GM_ID, null, mapRoutes());
    const ui = mount(h(MapsWorkspaceTab, { campaignId: CAMPAIGN, client: table.client, isGm: true }));
    await flush();
    ui.click("activate-scene-btn");
    await flush();
    assert.ok(table.transport.calls.some((c) => c.method === "PUT" && c.url === MAPS_URL), "saved first");
    assert.deepEqual(table.commands().filter((c) => c.cmd === "ACTIVATE_SCENE"), [{ cmd: "ACTIVATE_SCENE", scene_id: SCENE_ID }]);
    ui.unmount();
  });

  it("player gets the atlas and no upload controls", async () => {
    const table = liveTable(PLAYER_ID, null, mapRoutes());
    const ui = mount(h(MapsWorkspaceTab, { campaignId: CAMPAIGN, client: table.client, isGm: false }));
    await flush();
    assert.ok(ui.byTestId("scene-atlas"));
    assert.equal(ui.byTestId("maps-import-uvtt"), null);
    ui.unmount();
  });

  const scene = (id: string, title: string) => ({ id, title }) as CampaignMapScene;
  const upserts = [
    { id: "replaces a scene with the same id", list: [scene("a", "A"), scene("b", "B")], next: scene("b", "B2"), titles: ["A", "B2"] },
    { id: "appends an unknown scene", list: [scene("a", "A")], next: scene("c", "C"), titles: ["A", "C"] },
  ];
  for (const c of upserts) {
    it(`upsertScene: ${c.id}`, () => assert.deepEqual(upsertScene(c.list, c.next).map((s) => s.title), c.titles));
  }

  const names = [
    { id: "strips the extension", file: "Crypt.uvtt", expected: "Crypt" },
    { id: "keeps inner dots", file: "Level.2.dd2vtt", expected: "Level.2" },
    { id: "keeps a dotfile name", file: ".uvtt", expected: ".uvtt" },
  ];
  for (const c of names) {
    it(`sceneNameFromFile: ${c.id}`, () => assert.equal(sceneNameFromFile(c.file), c.expected));
  }
});

describe("MobileCompanionView: five live tabs", () => {
  const tabs: Array<{ id: string; tab: MobileCompanionTab; inner: string }> = [
    { id: "sheet shows the stored sheet panel", tab: "sheet", inner: "actor-sheet-panel" },
    { id: "dice shows the table dice tray", tab: "dice", inner: "dice-tray" },
    { id: "inventory shows the sheet panel with the inventory layout", tab: "inventory", inner: "actor-sheet-panel" },
    { id: "tracker shows the combat tracker", tab: "tracker", inner: "combat-tracker" },
    { id: "journal shows the notes tree", tab: "journal", inner: "notes-hierarchy-tree" },
  ];
  for (const c of tabs) {
    it(c.id, () => {
      const inCombat = tableState({
        mode: "TURN_BY_TURN",
        tokens: { [HERO]: fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, actor_id: HERO_ACTOR }) },
        initiative_order: [HERO],
        active_turn_index: 0,
      });
      const { client } = liveTable(PLAYER_ID, inCombat);
      client.state.actors.value = { [HERO_ACTOR]: { version: 4, data: heroSheet, name: "Brakka", ownerUserId: PLAYER_ID } };
      const ui = mount(h(MobileCompanionView, { campaignId: CAMPAIGN, client }));
      ui.click(`nav-${c.tab}`);
      assert.ok(ui.byTestId(`tab-${c.tab}`));
      assert.ok(ui.byTestId(c.inner), `${c.inner} rendered`);
      ui.unmount();
    });
  }

  const resolution = [
    { id: "the selected actor wins", selected: "other", expected: "other" },
    { id: "otherwise the caller's own sheet", selected: null, expected: HERO_ACTOR },
    { id: "a selection the caller cannot read falls back to their own sheet", selected: "hidden", expected: HERO_ACTOR },
  ];
  for (const c of resolution) {
    it(`companionActorId: ${c.id}`, () => {
      const { client } = liveTable(PLAYER_ID, null);
      client.state.actors.value = {
        other: { version: 1, data: {}, ownerUserId: OTHER_PLAYER_ID },
        [HERO_ACTOR]: { version: 1, data: {}, ownerUserId: PLAYER_ID },
      };
      selectedActorIdSignal.value = c.selected;
      assert.equal(companionActorId(client), c.expected);
    });
  }
});
