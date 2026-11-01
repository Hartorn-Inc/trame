import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { h } from "preact";
import type { CampaignNote } from "../../src/api/client.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { MapsWorkspaceTab } from "../../src/maps/MapsWorkspaceTab.tsx";
import { CampaignDocumentsTab, nodeToPutNote, noteToNode } from "../../src/workspace/CampaignDocumentsTab.tsx";
import {
  activeHandoutModalSignal,
  documentsHandoutsSignal,
  documentsNotesSignal,
  noteScopeFilterSignal,
  selectedNoteIdSignal,
  type NoteHierarchyNode,
} from "../../src/workspace/DocumentsWorkspaceTab.tsx";
import { CAMPAIGN, GM_ID, PLAYER_ID, liveTable, mount } from "../helpers/liveTable.ts";
import { flush, type RouteReply } from "../helpers/mockTransport.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const BASE = `/api/v1/campaigns/${CAMPAIGN}`;
const NOTES = `GET ${BASE}/notes`;
const JOURNAL = `GET ${BASE}/journal`;
const MAPS_GET = `GET ${BASE}/maps`;
const MAPS_PUT = `PUT ${BASE}/maps`;
const SCENE_ID = "dddddddd-0000-4000-8000-000000000001";

const HANDOUT = `:::handout{id="h-map" title="Torn Map" revealed="false"}\nThe road ends at the falls.\n:::`;
const noteDto = (slug: string, overrides: Record<string, unknown> = {}) => ({
  slug,
  id: `00000000-0000-4000-8000-${slug.padStart(12, "0").slice(-12)}`,
  title: `Note ${slug}`,
  content_markdown: "Lore",
  min_role: "PLAYER",
  folder: null,
  ...overrides,
});
const entryDto = { handout_id: "h-old", campaign_id: CAMPAIGN, title: "Old Letter", content: "Dear party", revealed_at: 1000, revealed_by: GM_ID };
const broadcast = { event: "handout.revealed", handout_id: "h-map", title: "Torn Map", content: "The road ends at the falls.", revealed_by: GM_ID, timestamp: 2000 };
const ok = (body: unknown): RouteReply => ({ status: 200, body });
const backendScene = { id: SCENE_ID, campaign_id: CAMPAIGN, name: "Crypt", grid_size_px: 50, width_px: 1000, height_px: 1000, wall_segments: [], light_sources: [], spatial_audio_emitters: [], staged_tokens: [], spawn_points: [] };

beforeEach(() => {
  documentsNotesSignal.value = [];
  documentsHandoutsSignal.value = [];
  selectedNoteIdSignal.value = null;
  activeHandoutModalSignal.value = null;
  noteScopeFilterSignal.value = "ALL";
});

async function mountDocuments(isGm: boolean, routes: Record<string, RouteReply>) {
  const table = liveTable(isGm ? GM_ID : PLAYER_ID, null, routes);
  const ui = mount(h(CampaignDocumentsTab, { campaignId: CAMPAIGN, client: table.client, isGm }));
  await flush();
  return { ...table, ui };
}

describe("CampaignDocumentsTab: loading, empty and error states", () => {
  const cases = [
    {
      id: "notes and journal load into the tree and the handout gallery",
      routes: { [NOTES]: ok({ notes: [noteDto("lore")] }), [JOURNAL]: ok({ entries: [entryDto] }) },
      present: ["note-item-lore", "handout-card-h-old"],
      absent: ["documents-error", "documents-loading"],
    },
    {
      id: "an empty campaign shows the empty hints",
      routes: { [NOTES]: ok({ notes: [] }), [JOURNAL]: ok({ entries: [] }) },
      present: ["empty-notes-hint", "empty-handouts-hint"],
      absent: ["documents-error"],
    },
    {
      id: "a failed notes request shows an alert with a retry",
      routes: { [NOTES]: { status: 500, body: { code: "STORAGE", error: "down" } }, [JOURNAL]: ok({ entries: [] }) },
      present: ["documents-error", "documents-retry"],
      absent: ["notes-hierarchy-tree"],
    },
    {
      id: "a failed journal request also shows the alert",
      routes: { [NOTES]: ok({ notes: [] }), [JOURNAL]: { status: 403, body: { code: "FORBIDDEN", error: "no" } } },
      present: ["documents-error"],
      absent: ["notes-hierarchy-tree"],
    },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { ui } = await mountDocuments(false, c.routes);
      for (const id of c.present) assert.ok(ui.byTestId(id), `${id} present`);
      for (const id of c.absent) assert.equal(ui.byTestId(id), null, `${id} absent`);
      ui.unmount();
    });
  }

  it("retry re-reads the notes after a failure", async () => {
    const { ui, transport } = await mountDocuments(false, { [NOTES]: { status: 500, body: { error: "down" } }, [JOURNAL]: ok({ entries: [] }) });
    transport.routes[NOTES] = ok({ notes: [noteDto("lore")] });
    ui.click("documents-retry");
    await flush();
    assert.ok(ui.byTestId("note-item-lore"));
    assert.equal(transport.calls.filter((c) => c.url === `${BASE}/notes`).length, 2);
    ui.unmount();
  });
});

describe("CampaignDocumentsTab: role-gated controls", () => {
  const routes = { [NOTES]: ok({ notes: [noteDto("lore", { content_markdown: HANDOUT })] }), [JOURNAL]: ok({ entries: [] }) };
  const cases = [
    { id: "GM sees the GM-only filter and the reveal button", isGm: true, gmOnly: true },
    { id: "player sees neither", isGm: false, gmOnly: false },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { ui } = await mountDocuments(c.isGm, routes);
      ui.click("note-item-lore");
      assert.equal(Boolean(ui.byTestId("filter-dm-only")), c.gmOnly);
      assert.equal(Boolean(ui.byTestId("btn-reveal-handout")), c.gmOnly);
      assert.equal(ui.byTestId("filter-private"), null, "no private scope on the server");
      assert.ok(ui.byTestId("save-note-btn"), "both roles may save party notes");
      ui.unmount();
    });
  }
});

describe("CampaignDocumentsTab: save and reveal", () => {
  const saves = [
    { id: "a party note saves with min_role PLAYER", isGm: false, minRole: "PLAYER", scope: null },
    { id: "a GM-only note saves with min_role GM", isGm: true, minRole: "GM", scope: "DM_ONLY" },
  ];
  for (const c of saves) {
    it(`save: ${c.id}`, async () => {
      const { ui, transport } = await mountDocuments(c.isGm, {
        [NOTES]: ok({ notes: [noteDto("lore")] }),
        [JOURNAL]: ok({ entries: [] }),
        [`PUT ${BASE}/notes/lore`]: ok({ note: noteDto("lore", { title: "Renamed", min_role: c.minRole }) }),
      });
      ui.click("note-item-lore");
      ui.input("note-title-input", "Renamed");
      if (c.scope) ui.input("note-scope-select", c.scope, "change");
      ui.click("save-note-btn");
      await flush();
      const put = transport.calls.find((call) => call.method === "PUT");
      assert.deepEqual(put?.body, { title: "Renamed", content_markdown: "Lore", folder: null, min_role: c.minRole });
      assert.match(ui.byTestId("documents-status").textContent, /Renamed saved/);
      ui.unmount();
    });
  }

  it("save: a rejected save shows the server error", async () => {
    const { ui } = await mountDocuments(false, {
      [NOTES]: ok({ notes: [noteDto("lore")] }),
      [JOURNAL]: ok({ entries: [] }),
      [`PUT ${BASE}/notes/lore`]: { status: 404, body: { code: "NOT_FOUND", error: "note not found" } },
    });
    ui.click("note-item-lore");
    ui.click("save-note-btn");
    await flush();
    assert.match(ui.byTestId("documents-action-error").textContent, /note not found/);
    ui.unmount();
  });

  const reveals = [
    { id: "a revealed handout opens the modal and joins the gallery", reply: ok({ handout: broadcast }), revealed: true },
    { id: "a missing handout surfaces the server error", reply: { status: 404, body: { code: "NOT_FOUND", error: "handout not found in campaign notes" } }, revealed: false },
  ];
  for (const c of reveals) {
    it(`reveal: ${c.id}`, async () => {
      const { ui, transport } = await mountDocuments(true, {
        [NOTES]: ok({ notes: [noteDto("lore", { content_markdown: HANDOUT })] }),
        [JOURNAL]: ok({ entries: [] }),
        [`PUT ${BASE}/notes/lore`]: ok({ note: noteDto("lore", { content_markdown: HANDOUT }) }),
        [`POST ${BASE}/handouts/h-map/reveal`]: c.reply,
      });
      ui.click("note-item-lore");
      ui.click("btn-reveal-handout");
      await flush();
      const order = transport.calls.filter((call) => call.method !== "GET").map((call) => call.method);
      assert.deepEqual(order, ["PUT", "POST"], "the open note is saved before the reveal");
      assert.equal(activeHandoutModalSignal.value?.handoutId === "h-map", c.revealed);
      assert.equal(Boolean(ui.byTestId("handout-card-h-map")), c.revealed);
      assert.equal(Boolean(ui.byTestId("documents-action-error")), !c.revealed);
      ui.unmount();
    });
  }
});

describe("Note mapping between the server and the view", () => {
  const note = (overrides: Partial<CampaignNote> = {}): CampaignNote => ({ slug: "s", id: "i", title: "T", contentMarkdown: "C", minRole: "PLAYER", folder: null, ...overrides });
  const toView = [
    { id: "a PLAYER note is a party note keyed by slug", note: note(), expected: { id: "s", visibility: "PARTY", folder: "" } },
    { id: "a GM note is GM-only", note: note({ minRole: "GM", folder: "Lore" }), expected: { id: "s", visibility: "DM_ONLY", folder: "Lore" } },
  ];
  for (const c of toView) {
    it(`noteToNode: ${c.id}`, () => {
      const node = noteToNode(c.note);
      assert.deepEqual({ id: node.id, visibility: node.visibility, folder: node.folder }, c.expected);
    });
  }

  const node = (overrides: Partial<NoteHierarchyNode> = {}): NoteHierarchyNode => ({ id: "s", title: "T", folder: "", visibility: "PARTY", ownerUserId: "", content: "C", ...overrides });
  const toServer = [
    { id: "the default Root folder is sent as no folder", node: node({ folder: "Root" }), folder: null, minRole: "PLAYER" },
    { id: "a blank folder is sent as no folder", node: node({ folder: "  " }), folder: null, minRole: "PLAYER" },
    { id: "a named folder is trimmed", node: node({ folder: " Quests " }), folder: "Quests", minRole: "PLAYER" },
    { id: "GM-only maps to min_role GM", node: node({ visibility: "DM_ONLY" }), folder: null, minRole: "GM" },
  ];
  for (const c of toServer) {
    it(`nodeToPutNote: ${c.id}`, () => {
      const body = nodeToPutNote(c.node);
      assert.equal(body.folder, c.folder);
      assert.equal(body.minRole, c.minRole);
    });
  }
});

describe("MapsWorkspaceTab: scene-list version", () => {
  async function mountMaps(routes: Record<string, RouteReply>) {
    const table = liveTable(GM_ID, null, { [MAPS_GET]: ok({ scenes: [backendScene], version: 3 }), ...routes });
    const ui = mount(h(MapsWorkspaceTab, { campaignId: CAMPAIGN, client: table.client, isGm: true }));
    await flush();
    return { ...table, ui };
  }
  const puts = (transport: { calls: Array<{ method: string; url: string; body: unknown }> }) =>
    transport.calls.filter((c) => c.method === "PUT" && c.url === `${BASE}/maps`).map((c) => (c.body as any).expected_version);

  it("each save sends the version from the previous read or save", async () => {
    const { ui, transport } = await mountMaps({ [MAPS_PUT]: ok({ scenes: [backendScene], version: 4 }) });
    ui.click("save-scene-btn");
    await flush();
    transport.routes[MAPS_PUT] = ok({ scenes: [backendScene], version: 5 });
    ui.click("save-scene-btn");
    await flush();
    assert.deepEqual(puts(transport), [3, 4]);
    ui.unmount();
  });

  it("an import re-reads the list so the next save uses the bumped version", async () => {
    const { ui, transport } = await mountMaps({
      [`POST ${BASE}/maps/import?name=Crypt`]: { status: 201, body: { scene: backendScene } },
      [MAPS_PUT]: ok({ scenes: [backendScene], version: 6 }),
    });
    transport.routes[MAPS_GET] = ok({ scenes: [backendScene], version: 5 });
    const input = ui.byTestId("maps-import-uvtt");
    input.files = [new File(["{}"], "Crypt.uvtt")];
    input.dispatchEvent({ type: "change", target: input });
    await flush();
    ui.click("save-scene-btn");
    await flush();
    assert.deepEqual(puts(transport), [5]);
    ui.unmount();
  });

  const stale = { status: 409, body: { code: "VERSION_CONFLICT", error: "stale", current_version: 9 } };
  const resolutions = [
    { id: "overwrite resends the same list at current_version", button: "maps-conflict-overwrite", expectedPuts: [3, 9], expectedGets: 1 },
    { id: "reload re-reads the latest list and sends nothing", button: "maps-conflict-reload", expectedPuts: [3], expectedGets: 2 },
  ];
  for (const c of resolutions) {
    it(`conflict: ${c.id}`, async () => {
      const { ui, transport, commands } = await mountMaps({ [MAPS_PUT]: stale });
      ui.click("activate-scene-btn");
      await flush();
      assert.ok(ui.byTestId("maps-version-conflict"), "conflict panel shown");
      assert.equal(ui.byTestId("maps-error"), null, "no generic error");
      assert.equal(commands().filter((cmd) => cmd.cmd === "ACTIVATE_SCENE").length, 0, "a stale save never activates");
      transport.routes[MAPS_PUT] = ok({ scenes: [backendScene], version: 10 });
      ui.click(c.button);
      await flush();
      assert.deepEqual(puts(transport), c.expectedPuts);
      assert.equal(transport.calls.filter((call) => call.method === "GET" && call.url === `${BASE}/maps`).length, c.expectedGets);
      assert.equal(ui.byTestId("maps-version-conflict"), null, "panel closed");
      ui.unmount();
    });
  }
});
