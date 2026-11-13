import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { h } from "preact";
import { selectedActorIdSignal, selectedCellSignal, selectedTokenIdSignal } from "../../src/api/session.ts";
import type { WireWallSegment } from "../../src/api/wire.ts";
import { CommandFeedbackToasts, rejectionReason } from "../../src/components/RoomConnectionFeedback.tsx";
import { localeSignal } from "../../src/i18n/index.ts";
import { CoverSuggestionPanel } from "../../src/table/CoverSuggestionPanel.tsx";
import { acceptedCoverSignal, targetTokenIdSignal } from "../../src/table/coverState.ts";
import { DeathSaveAnnouncement } from "../../src/table/DeathSaveAnnouncement.tsx";
import { ReactionBanner } from "../../src/table/ReactionBanner.tsx";
import { TableCanvas } from "../../src/table/TableCanvas.tsx";
import { MAX_STROKE_CELLS } from "../../src/table/tableTools.ts";
import { deathSavePhase, listTableTokens } from "../../src/table/tableView.ts";
import { TokenConditionsPanel } from "../../src/table/TokenConditionsPanel.tsx";
import { TokenVitalsPanel } from "../../src/table/TokenVitalsPanel.tsx";
import { CAMPAIGN, GM_ID, GOBLIN, HERO, HERO_ACTOR, PLAYER_ID, fullToken, liveTable, mount, publicToken, tableState } from "../helpers/liveTable.ts";
import { assertAbsent, assertPresent, assertSameNode } from "../helpers/domAssert.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { actorDto, flush } from "../helpers/mockTransport.ts";
import { createDefaultActorData } from "../../../game-systems/dnd5e/src/index.ts";

setupMockDom();
localeSignal.value = "en";

const SCENE = "eeeeeeee-0000-4000-8000-000000000001";
const DOOR = "dddddddd-0000-4000-8000-000000000001";
const PROMPT = "bbbbbbbb-0000-4000-8000-000000000001";

const door = (isOpen: boolean, isLocked: boolean): WireWallSegment => ({
  id: DOOR,
  a: { x: 300, y: 0 },
  b: { x: 300, y: 100 },
  kind: { kind: "DOOR", is_open: isOpen, is_locked: isLocked },
  blocks_movement: !isOpen,
  blocks_vision: !isOpen,
  blocks_light: !isOpen,
  blocks_sound: !isOpen,
  bottom_elevation_ft: -1000,
  top_elevation_ft: 1000,
});

const wallBetween: WireWallSegment = {
  id: DOOR,
  a: { x: 0, y: 200 },
  b: { x: 1000, y: 200 },
  kind: { kind: "NORMAL" },
  blocks_movement: true,
  blocks_vision: true,
  blocks_light: true,
  blocks_sound: true,
  bottom_elevation_ft: -1000,
  top_elevation_ft: 1000,
};

const heroToken = (overrides = {}) => fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, top_left: { x: 100, y: 50 }, hp: 12, max_hp: 13, ...overrides });

const gmView = (overrides = {}, hero = {}, goblin = {}) =>
  tableState({
    tokens: { [HERO]: heroToken(hero), [GOBLIN]: fullToken(GOBLIN, "Goblin", { top_left: { x: 200, y: 300 }, hp: 7, max_hp: 7, ...goblin }) },
    ...overrides,
  });

const playerView = (overrides = {}, hero = {}) =>
  tableState({
    tokens: { [HERO]: heroToken(hero) },
    public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { top_left: { x: 200, y: 300 } }) },
    ...overrides,
  });

const viewer = (role: "GM" | "player") => (role === "GM" ? { userId: GM_ID, isGm: true } : { userId: PLAYER_ID, isGm: false });

/** Places the board at client (10, 20) so board points are `client - (10, 20)` at 100% zoom. */
function pinBoard(ui: ReturnType<typeof mount>): void {
  ui.byTestId("table-board").getBoundingClientRect = () => ({ left: 10, top: 20 });
}

beforeEach(() => {
  selectedTokenIdSignal.value = null;
  selectedActorIdSignal.value = null;
  targetTokenIdSignal.value = null;
  acceptedCoverSignal.value = null;
});

describe("TableCanvas: door handles", () => {
  const cases = [
    { id: "GM opens a locked door", role: "GM", open: false, locked: true, enabled: true, expected: [{ cmd: "TOGGLE_DOOR", wall_id: DOOR, is_open: true }] },
    { id: "player opens an unlocked closed door", role: "player", open: false, locked: false, enabled: true, expected: [{ cmd: "TOGGLE_DOOR", wall_id: DOOR, is_open: true }] },
    { id: "player closes an open door", role: "player", open: true, locked: false, enabled: true, expected: [{ cmd: "TOGGLE_DOOR", wall_id: DOOR, is_open: false }] },
    { id: "player cannot toggle a locked door", role: "player", open: false, locked: true, enabled: false, expected: [] },
  ] as const;
  for (const c of cases) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, (isGm ? gmView : playerView)({ walls: [door(c.open, c.locked)] }));
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }));
      const handle = ui.byTestId(`door-${DOOR}`);
      assert.equal(handle.getAttribute("aria-disabled"), c.enabled ? null : "true");
      assert.equal(handle.disabled, false, "a refused handle stays focusable");
      assert.equal(handle.getAttribute("aria-pressed"), null, "the handle is a plain button named by its action");
      ui.click(`door-${DOOR}`);
      assert.deepEqual(live.commands(), c.expected);
      ui.unmount();
    });
  }

  it("a locked handle says why it does not open", () => {
    const live = liveTable(PLAYER_ID, playerView({ walls: [door(false, true)] }));
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    ui.click(`door-${DOOR}`);
    assert.equal(ui.byTestId("table-door-status").textContent, "This door is locked. Only the Game Master can unlock it.");
    assert.deepEqual(live.commands(), []);
    ui.unmount();
  });

  const blinding: WireWallSegment = { ...wallBetween, id: "dddddddd-0000-4000-8000-000000000002", a: { x: 250, y: -1000 }, b: { x: 250, y: 1000 } };
  const sight = [
    { id: "a player does not get the handle of a door behind a wall", role: "player", walls: [blinding, door(false, false)], fog: [], present: false },
    { id: "a GM reveal cell on the door shows its handle", role: "player", walls: [blinding, door(false, false)], fog: [{ cell_x: 6, cell_y: 1, mode: "REVEAL" }], present: true },
    { id: "a GM hide cell over a seen door hides its handle", role: "player", walls: [door(false, false)], fog: [{ cell_x: 5, cell_y: 1, mode: "HIDE" }, { cell_x: 6, cell_y: 1, mode: "HIDE" }], present: false },
    { id: "the GM gets every handle, fog or not", role: "GM", walls: [blinding, door(false, false)], fog: [], present: true },
  ] as const;
  for (const c of sight) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, (isGm ? gmView : playerView)({ walls: [...c.walls], fog_overrides: [...c.fog] }));
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }));
      assert.equal(ui.byTestId(`door-${DOOR}`) !== null, c.present);
      ui.unmount();
    });
  }

  const locks = [
    { id: "GM locks an unlocked door", locked: false, label: "Lock door", expected: true },
    { id: "GM unlocks a locked door", locked: true, label: "Unlock door", expected: false },
  ];
  for (const c of locks) {
    it(c.id, () => {
      const live = liveTable(GM_ID, gmView({ walls: [door(false, c.locked)] }));
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
      assert.equal(ui.byTestId(`door-lock-${DOOR}`).getAttribute("aria-pressed"), null);
      assert.equal(ui.byTestId(`door-lock-${DOOR}`).getAttribute("aria-label"), c.label);
      ui.click(`door-lock-${DOOR}`);
      assert.deepEqual(live.commands(), [{ cmd: "CONFIGURE_DOOR", wall_id: DOOR, is_open: null, is_locked: c.expected, is_secret: null }]);
      ui.unmount();
    });
  }

  it("players never get the lock toggle", () => {
    const live = liveTable(PLAYER_ID, playerView({ walls: [door(false, false)] }));
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    assertAbsent(ui.byTestId(`door-lock-${DOOR}`), "door-lock");
    ui.unmount();
  });

  const doorNames = [
    { id: "a closed door is named by the action that opens it", locale: "en", open: false, locked: false, label: "Open door" },
    { id: "an open door is named by the action that closes it", locale: "en", open: true, locked: false, label: "Close door" },
    { id: "a locked door names the lock in words", locale: "en", open: false, locked: true, label: "Open door (locked)" },
    { id: "the French name is the French action", locale: "fr", open: false, locked: true, label: "Ouvrir la porte (verrouillée)" },
  ] as const;
  for (const c of doorNames) {
    it(`door label: ${c.id}`, () => {
      localeSignal.value = c.locale;
      const live = liveTable(PLAYER_ID, playerView({ walls: [door(c.open, c.locked)] }));
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
      const label = ui.byTestId(`door-${DOOR}`).getAttribute("aria-label");
      const pressed = ui.byTestId(`door-${DOOR}`).getAttribute("aria-pressed");
      ui.unmount();
      localeSignal.value = "en";
      assert.equal(label, c.label);
      assert.equal(pressed, null, "no aria-pressed state competes with the action name");
    });
  }
});

describe("TableCanvas: token actions menu", () => {
  const entries = [
    { id: "GM gets every entry on an NPC", role: "GM", token: GOBLIN, present: ["disengage", "visibility", "teleport", "speed", "remove"], absent: [] },
    { id: "player gets only Disengage on their own token", role: "player", token: HERO, present: ["disengage"], absent: ["visibility", "teleport", "speed", "remove"] },
    { id: "player gets no action on a public token", role: "player", token: GOBLIN, present: [], absent: ["disengage", "visibility", "teleport", "remove"] },
  ] as const;
  for (const c of entries) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, isGm ? gmView() : playerView());
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }));
      ui.key(`token-${c.token}`, "ContextMenu");
      assertPresent(ui.byTestId("token-menu"), "token-menu");
      for (const name of c.present) assertPresent(ui.byTestId(`token-menu-${name}`), name);
      for (const name of c.absent) assertAbsent(ui.byTestId(`token-menu-${name}`), name);
      ui.unmount();
    });
  }

  const commands = [
    { id: "Disengage sends SET_DISENGAGED", role: "player", token: HERO, act: "token-menu-disengage", expected: { cmd: "SET_DISENGAGED", token_id: HERO, disengaged: true } },
    { id: "Hide from players sends SET_TOKEN_VISIBILITY gm_hidden", role: "GM", token: GOBLIN, act: "token-menu-visibility", expected: { cmd: "SET_TOKEN_VISIBILITY", token_id: GOBLIN, gm_hidden: true, invisible: false } },
    { id: "Remove then confirm sends REMOVE_TOKEN", role: "GM", token: GOBLIN, act: ["token-menu-remove", "token-menu-remove-confirm"], expected: { cmd: "REMOVE_TOKEN", token_id: GOBLIN } },
  ] as const;
  for (const c of commands) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, isGm ? gmView() : playerView());
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }));
      ui.click(`token-${c.token}`);
      ui.click("table-token-menu-open");
      for (const act of typeof c.act === "string" ? [c.act] : c.act) ui.click(act);
      assert.deepEqual(live.commands(), [c.expected]);
      assertAbsent(ui.byTestId("token-menu"), "menu closes after the action");
      ui.unmount();
    });
  }

  it("Remove asks first and Keep the token sends nothing", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    ui.key(`token-${GOBLIN}`, "ContextMenu");
    ui.click("token-menu-remove");
    assert.deepEqual(live.commands(), []);
    assert.equal(ui.byTestId("token-menu-remove-question").textContent, "Remove Goblin from the table? Its initiative entry goes too.");
    assertSameNode((globalThis as any).document.activeElement, ui.byTestId("token-menu-remove-confirm"), "focus moves to the confirm button");
    ui.click("token-menu-remove-cancel");
    assert.deepEqual(live.commands(), []);
    assertSameNode((globalThis as any).document.activeElement, ui.byTestId("token-menu-remove"), "focus returns to Remove");
    ui.unmount();
  });

  it("a GM-hidden token offers Reveal and is labelled hidden", () => {
    const live = liveTable(GM_ID, gmView({}, {}, { visibility_channel: 0b101 }));
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    assert.match(ui.byTestId(`token-${GOBLIN}`).getAttribute("aria-label"), /hidden from players/);
    ui.key(`token-${GOBLIN}`, "ContextMenu");
    ui.click("token-menu-visibility");
    assert.deepEqual(live.commands(), [{ cmd: "SET_TOKEN_VISIBILITY", token_id: GOBLIN, gm_hidden: false, invisible: false }]);
    ui.unmount();
  });

  it("GM speed override sends GM_OVERRIDE_TOKEN_RESOURCES with only the speed", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    ui.key(`token-${GOBLIN}`, "ContextMenu");
    ui.input("token-menu-speed", "15");
    ui.click("token-menu-speed-apply");
    assert.deepEqual(live.commands(), [
      { cmd: "GM_OVERRIDE_TOKEN_RESOURCES", token_id: GOBLIN, hp: null, temp_hp: null, speed_remaining_ft: 15, has_action: null, has_bonus_action: null, has_reaction: null },
    ]);
    ui.unmount();
  });

  it("GM teleport arms the board; the next click moves with gm_teleport", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    ui.key(`token-${GOBLIN}`, "ContextMenu");
    ui.click("token-menu-teleport");
    assert.match(ui.byTestId("table-teleport-armed").textContent, /teleport Goblin/);
    pinBoard(ui);
    ui.click("table-board", { clientX: 10 + 333, clientY: 20 + 260 });
    assert.deepEqual(live.commands(), [{ cmd: "MOVE_TOKEN", token_id: GOBLIN, to_top_left: { x: 300, y: 250 }, to_elevation_ft: null, gm_teleport: true }]);
    assertAbsent(ui.byTestId("table-teleport-armed"), "teleport disarms after one move");
    ui.unmount();
  });

  const press = (ui: ReturnType<typeof mount>, id: string, key: string, extra: Record<string, unknown> = {}) =>
    ui.byTestId(id).dispatchEvent({ type: "keydown", key, ...extra });
  const doc = () => (globalThis as any).document;

  it("Shift+F10 on a token opens its action menu", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    press(ui, `token-${GOBLIN}`, "F10", { shiftKey: true });
    assertPresent(ui.byTestId("token-menu"), "token-menu");
    assert.equal(selectedTokenIdSignal.value, GOBLIN);
    ui.unmount();
  });

  it("P on a token pings its centre", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    press(ui, `token-${HERO}`, "p");
    assert.deepEqual(live.frames().find((f) => f.PointerPing)?.PointerPing.pos, { x: 125, y: 75 });
    assert.equal(live.commands().length, 0);
    ui.unmount();
  });

  /** Arms the GM teleport of the goblin from its menu. */
  function armTeleport() {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    ui.key(`token-${GOBLIN}`, "ContextMenu");
    ui.click("token-menu-teleport");
    return { live, ui };
  }

  it("teleport focuses a cell cursor on the token; Escape cancels and returns focus", () => {
    const { live, ui } = armTeleport();
    assertSameNode(doc().activeElement, ui.byTestId("table-cell-cursor"), "focus moves to the destination cursor");
    assert.equal(ui.byTestId("table-cursor-status").textContent, "Column 5, row 7.");
    press(ui, "table-cell-cursor", "Escape");
    assertAbsent(ui.byTestId("table-teleport-armed"), "teleport cancelled");
    assertAbsent(ui.byTestId("table-cell-cursor"), "cursor gone");
    assertSameNode(doc().activeElement, ui.byTestId(`token-${GOBLIN}`), "focus returns to the token");
    assert.deepEqual(live.commands(), []);
    ui.unmount();
  });

  it("teleport from the keyboard: arrow keys move the cursor and Enter teleports", () => {
    const { live, ui } = armTeleport();
    press(ui, "table-cell-cursor", "ArrowRight");
    press(ui, "table-cell-cursor", "ArrowRight");
    press(ui, "table-cell-cursor", "ArrowUp");
    press(ui, "table-cell-cursor", "Enter");
    assert.deepEqual(live.commands(), [{ cmd: "MOVE_TOKEN", token_id: GOBLIN, to_top_left: { x: 300, y: 250 }, to_elevation_ft: null, gm_teleport: true }]);
    assertAbsent(ui.byTestId("table-teleport-armed"), "teleport disarms after one move");
    ui.unmount();
  });
});

describe("TableCanvas: compendium spawn cell", () => {
  const cases = [
    { id: "GM click on an empty cell selects it for spawns", role: "GM", expected: { x: 300, y: 250 }, hint: true },
    { id: "player click selects nothing", role: "player", expected: null, hint: false },
  ] as const;
  for (const c of cases) {
    it(c.id, () => {
      selectedCellSignal.value = null;
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, isGm ? gmView() : playerView());
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }));
      pinBoard(ui);
      ui.click("table-board", { clientX: 10 + 333, clientY: 20 + 260 });
      assert.deepEqual(selectedCellSignal.value, c.expected);
      assert.deepEqual(live.commands(), []);
      if (c.hint) assert.match(ui.byTestId("table-selected-cell").textContent, /column 7, row 6/);
      else assertAbsent(ui.byTestId("table-selected-cell"), "selected-cell hint");
      ui.unmount();
      selectedCellSignal.value = null;
    });
  }
});

describe("TableCanvas: saving live terrain and fog to the scene", () => {
  const rulingsRoute = `POST /api/v1/campaigns/${CAMPAIGN}/maps/${SCENE}/table-rulings`;
  const presence = [
    { id: "the GM gets the save button while a scene is active", role: "GM", scene: SCENE, present: true },
    { id: "the GM gets no save button without an active scene", role: "GM", scene: null, present: false },
    { id: "a player never gets the save button", role: "player", scene: SCENE, present: false },
  ] as const;
  for (const c of presence) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, (isGm ? gmView : playerView)({ active_scene_id: c.scene }));
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }));
      if (c.present) assertPresent(ui.byTestId("table-save-rulings"), c.id);
      else assertAbsent(ui.byTestId("table-save-rulings"), c.id);
      ui.unmount();
    });
  }

  const outcomes = [
    {
      id: "a saved set tells the GM the next activation loads it",
      reply: { status: 200, body: { scenes: [], version: 4 } },
      status: "Difficult terrain and fog rulings saved to the scene. Activating it again loads them.",
    },
    {
      id: "a scene that is no longer active says nothing was saved",
      reply: { status: 409, body: { code: "SCENE_NOT_ACTIVE", error: "scene is not the scene active on the table" } },
      status: "This scene is no longer active on the table, so nothing was saved.",
    },
    {
      id: "a version conflict asks the GM to try again",
      reply: { status: 409, body: { code: "VERSION_CONFLICT", error: "stale" } },
      status: "Terrain and fog were not saved. Try again in a moment.",
    },
  ];
  for (const c of outcomes) {
    it(c.id, async () => {
      const live = liveTable(GM_ID, gmView({ active_scene_id: SCENE }), { [rulingsRoute]: c.reply });
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
      ui.click("table-save-rulings");
      await flush();
      assert.deepEqual(
        live.transport.calls.filter((call) => call.method === "POST").map((call) => call.url),
        [`/api/v1/campaigns/${CAMPAIGN}/maps/${SCENE}/table-rulings`],
      );
      assert.equal(ui.byTestId("table-save-rulings-status").textContent, c.status);
      assert.equal(live.commands().length, 0, "saving sends no table command");
      ui.unmount();
    });
  }
});

describe("TableCanvas: GM map brushes", () => {
  const visibility = [
    { id: "the GM gets the brush toolbar", role: "GM", present: true },
    { id: "a player never gets the brush toolbar", role: "player", present: false },
  ] as const;
  for (const c of visibility) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, isGm ? gmView() : playerView());
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }));
      assert.equal(ui.byTestId("table-tool-fogReveal") !== null, c.present);
      assert.equal(ui.byTestId("table-tool-terrainPaint") !== null, c.present);
      ui.unmount();
    });
  }

  const strokes = [
    {
      id: "a terrain drag paints every crossed cell in one command",
      tool: "terrainPaint",
      path: [[60, 60], [160, 60]],
      expected: [{ cmd: "SET_DIFFICULT_TERRAIN", cells: [{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }], difficult: true }],
    },
    {
      id: "a fog hide tap rules on the tapped cell",
      tool: "fogHide",
      path: [[60, 110]],
      expected: [{ cmd: "SET_FOG_OVERRIDES", mode: "HIDE", cells: [{ col: 1, row: 2 }] }],
    },
    {
      id: "a fog reveal drag is one command for every crossed cell",
      tool: "fogReveal",
      path: [[60, 60], [160, 60]],
      expected: [{ cmd: "SET_FOG_OVERRIDES", mode: "REVEAL", cells: [{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }] }],
    },
  ] as const;
  for (const c of strokes) {
    it(c.id, () => {
      const live = liveTable(GM_ID, gmView());
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
      ui.click(`table-tool-${c.tool}`);
      pinBoard(ui);
      const board = ui.byTestId("table-board");
      const at = ([x, y]: readonly number[]) => ({ clientX: 10 + x, clientY: 20 + y, pointerType: "mouse" });
      board.dispatchEvent({ type: "pointerdown", ...at(c.path[0]) });
      for (const point of c.path.slice(1)) board.dispatchEvent({ type: "pointermove", ...at(point) });
      board.dispatchEvent({ type: "pointerup" });
      ui.click("table-board", at(c.path[0]));
      assert.deepEqual(live.commands(), c.expected, "the trailing click paints nothing more and moves nothing");
      assertAbsent(ui.byTestId("table-stroke-capped"), "short strokes show no cap notice");
      ui.unmount();
    });
  }

  const keyboard = [
    {
      id: "Enter paints the brush at the keyboard cursor",
      tool: "terrainPaint",
      keys: [["ArrowRight"], ["ArrowDown"], ["Enter"]],
      expected: [{ cmd: "SET_DIFFICULT_TERRAIN", cells: [{ col: 1, row: 1 }], difficult: true }],
    },
    {
      id: "Shift+arrows mark a rectangle that Enter paints in one command",
      tool: "fogReveal",
      keys: [["ArrowRight", true], ["ArrowRight", true], ["ArrowDown", true], ["Enter"]],
      expected: [
        {
          cmd: "SET_FOG_OVERRIDES",
          mode: "REVEAL",
          cells: [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }],
        },
      ],
    },
    {
      id: "Escape drops the rectangle, so Enter paints one cell",
      tool: "fogHide",
      keys: [["ArrowRight", true], ["Escape"], ["Enter"]],
      expected: [{ cmd: "SET_FOG_OVERRIDES", mode: "HIDE", cells: [{ col: 1, row: 0 }] }],
    },
  ] as const;
  for (const c of keyboard) {
    it(`keyboard brush: ${c.id}`, () => {
      const live = liveTable(GM_ID, gmView());
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
      ui.click(`table-tool-${c.tool}`);
      for (const [key, shiftKey = false] of c.keys) ui.byTestId("table-cell-cursor").dispatchEvent({ type: "keydown", key, shiftKey });
      assert.deepEqual(live.commands(), c.expected);
      ui.unmount();
    });
  }

  it("keyboard brush: the status names the rectangle and Escape without one leaves the brush", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    ui.click("table-tool-terrainPaint");
    ui.byTestId("table-cell-cursor").dispatchEvent({ type: "keydown", key: "ArrowDown", shiftKey: true });
    assert.equal(ui.byTestId("table-cursor-status").textContent, "Column 1, row 2. Rectangle of 1 by 2 cells.");
    ui.byTestId("table-cell-cursor").dispatchEvent({ type: "keydown", key: "Escape" });
    ui.byTestId("table-cell-cursor").dispatchEvent({ type: "keydown", key: "Escape" });
    assertAbsent(ui.byTestId("table-cell-cursor"), "cursor gone with the brush");
    assert.equal(ui.byTestId("table-tool-select").getAttribute("aria-pressed"), "true");
    ui.unmount();
  });

  it("a 5x5 fog drag that hits the cell cap is one command and tells the GM", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    ui.click("table-tool-fogReveal");
    ui.input("table-brush-size", "5", "change");
    pinBoard(ui);
    const board = ui.byTestId("table-board");
    const at = (x: number, y: number) => ({ clientX: 10 + x, clientY: 20 + y, pointerType: "mouse" });
    board.dispatchEvent({ type: "pointerdown", ...at(160, 160) });
    board.dispatchEvent({ type: "pointermove", ...at(560, 160) });
    board.dispatchEvent({ type: "pointerup" });
    const commands = live.commands();
    assert.equal(commands.length, 1);
    assert.equal(commands[0].cmd, "SET_FOG_OVERRIDES");
    assert.equal(commands[0].cells.length, MAX_STROKE_CELLS);
    assert.equal(
      ui.byTestId("table-stroke-capped").textContent,
      `That stroke reached the ${MAX_STROKE_CELLS}-cell limit, so the rest of the drag was not painted. Paint another stroke to continue.`,
    );
    ui.unmount();
  });
});

describe("TableCanvas: zoom, pan and pings", () => {
  it("zoom in scales the board and board clicks are divided by the zoom", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    ui.click("table-zoom-in");
    assert.equal(ui.byTestId("table-zoom-reset").textContent, "125%");
    assert.equal(ui.byTestId("table-board").style.transform, "scale(1.25)");
    const canvas = ui.byTestId("table-render");
    assertSameNode(canvas.parentNode, ui.byTestId("table-board").parentNode, "the canvas sits beside the CSS-scaled board, not inside it");
    ui.click(`token-${GOBLIN}`);
    pinBoard(ui);
    ui.click("table-board", { clientX: 10 + 500, clientY: 20 + 250 });
    assert.deepEqual(live.commands().at(-1)?.to_top_left, { x: 400, y: 200 });
    ui.click("table-zoom-reset");
    assert.equal(ui.byTestId("table-zoom-reset").textContent, "100%");
    ui.unmount();
  });

  it("the zoom anchor scroll is applied once the board has its zoomed size", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    const scroller = ui.byTestId("table-scroller");
    const writes: Array<[number, string]> = [];
    let left = 0;
    Object.assign(scroller, { clientWidth: 200, clientHeight: 100, scrollTop: 0 });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = value;
        writes.push([value, ui.byTestId("table-board").style.transform]);
      },
    });
    ui.click("table-zoom-in");
    assert.deepEqual(writes, [[25, "scale(1.25)"]]);
    assert.equal(scroller.scrollTop, 12.5);
    ui.unmount();
  });

  const pings = [
    { id: "Alt+click pings the cell with the active scene id", scene: SCENE, expectedScene: SCENE },
    { id: "before any scene is active the ping carries no scene id", scene: null, expectedScene: undefined },
  ];
  for (const c of pings) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView({ active_scene_id: c.scene }));
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
      pinBoard(ui);
      ui.click("table-board", { clientX: 10 + 120, clientY: 20 + 80, altKey: true });
      const ping = live.frames().find((f) => f.PointerPing)?.PointerPing;
      assert.deepEqual([ping?.pos, ping?.scene_id], [{ x: 120, y: 80 }, c.expectedScene]);
      assert.equal(live.commands().length, 0, "a ping never moves a token");
      ui.unmount();
    });
  }
});

describe("Selected token panels: no local state carries over between tokens", () => {
  const cases = [
    {
      id: "vitals: a typed amount, type and critical flag reset on the next token",
      panel: TokenVitalsPanel,
      edit: (ui: ReturnType<typeof mount>) => {
        ui.input("vitals-amount", "6");
        ui.input("vitals-damage-type", "fire", "change");
        ui.click("vitals-critical");
      },
      read: (ui: ReturnType<typeof mount>) => [ui.byTestId("vitals-amount").value, ui.byTestId("vitals-damage-type").value, ui.byTestId("vitals-critical").getAttribute("aria-pressed")],
      fresh: ["", "", "false"],
    },
    {
      id: "cover: a picked level resets on the next attacker",
      panel: CoverSuggestionPanel,
      edit: (ui: ReturnType<typeof mount>) => {
        ui.input("cover-target", GOBLIN, "change");
        ui.input("cover-choice", "THREE_QUARTERS", "change");
      },
      read: (ui: ReturnType<typeof mount>) => [ui.byTestId("cover-choice").value],
      fresh: ["NONE"],
    },
  ] as const;
  for (const c of cases) {
    it(c.id, () => {
      const live = liveTable(GM_ID, gmView());
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(c.panel, { client: live.client, isGm: true }));
      c.edit(ui);
      selectedTokenIdSignal.value = GOBLIN;
      targetTokenIdSignal.value = HERO;
      assert.deepEqual(c.read(ui), c.fresh);
      ui.unmount();
    });
  }
});

describe("TokenVitalsPanel: typed damage, concentration and death saving throws", () => {
  const damage = [
    { id: "untyped damage keeps damage_type null", type: "", critical: false, expected: { damage_type: null, is_critical: false } },
    { id: "a fire hit sends the damage type so affinities apply", type: "fire", critical: false, expected: { damage_type: "fire", is_critical: false } },
    { id: "a critical slashing hit sets is_critical", type: "slashing", critical: true, expected: { damage_type: "slashing", is_critical: true } },
  ];
  for (const c of damage) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView());
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenVitalsPanel, { client: live.client }));
      ui.input("vitals-amount", "6");
      ui.input("vitals-damage-type", c.type, "change");
      if (c.critical) ui.click("vitals-critical");
      ui.click("vitals-damage");
      assert.deepEqual(live.commands(), [{ cmd: "APPLY_DAMAGE", token_id: HERO, raw_damage: 6, affinity: "NORMAL", ...c.expected }]);
      assert.equal(ui.byTestId("vitals-critical").getAttribute("aria-pressed"), "false", "critical resets after each hit");
      ui.unmount();
    });
  }

  const concentration = [
    { id: "a token not concentrating starts concentrating", concentrating: false, expected: true },
    { id: "a concentrating token ends concentration", concentrating: true, expected: false },
  ];
  for (const c of concentration) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView({}, { concentrating: c.concentrating }));
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenVitalsPanel, { client: live.client }));
      ui.click("vitals-concentration");
      assert.deepEqual(live.commands(), [{ cmd: "SET_CONCENTRATION", token_id: HERO, concentrating: c.expected }]);
      ui.unmount();
    });
  }

  const deathControls = [
    { id: "a dying player's token offers a server roll and no die entry", role: "player", hero: { hp: 0 }, roll: true, die: false, state: /Dying/ },
    { id: "the GM may also record a physical die", role: "GM", hero: { hp: 0 }, roll: true, die: true, state: /Dying/ },
    { id: "a stable token rolls no more", role: "player", hero: { hp: 0, is_stable: true }, roll: false, die: false, state: /Stable/ },
    { id: "a dead token rolls no more", role: "player", hero: { hp: 0, is_dead: true }, roll: false, die: false, state: /Dead/ },
  ] as const;
  for (const c of deathControls) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, isGm ? gmView({}, c.hero) : playerView({}, c.hero));
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenVitalsPanel, { client: live.client, isGm }));
      assert.match(ui.byTestId("vitals-death-state").textContent, c.state);
      assert.equal(ui.byTestId("vitals-death-roll") !== null, c.roll);
      assert.equal(ui.byTestId("vitals-death-die") !== null, c.die);
      ui.unmount();
    });
  }

  it("rolling sends RECORD_DEATH_SAVE with d20 null so the server rolls", () => {
    const live = liveTable(PLAYER_ID, playerView({}, { hp: 0, death_save_successes: 1, death_save_failures: 2 }));
    selectedTokenIdSignal.value = HERO;
    const ui = mount(h(TokenVitalsPanel, { client: live.client }));
    assert.equal(ui.byTestId("vitals-death-counters").textContent, "Successes 1 of 3, failures 2 of 3");
    ui.click("vitals-death-roll");
    assert.deepEqual(live.commands(), [{ cmd: "RECORD_DEATH_SAVE", token_id: HERO, d20: null }]);
    ui.unmount();
  });

  const dice = [
    { id: "a valid physical die is sent as d20", value: "17", enabled: true },
    { id: "a die above 20 is refused", value: "21", enabled: false },
    { id: "a die of 0 is refused", value: "0", enabled: false },
  ];
  for (const c of dice) {
    it(`GM: ${c.id}`, () => {
      const live = liveTable(GM_ID, gmView({}, { hp: 0 }));
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenVitalsPanel, { client: live.client, isGm: true }));
      ui.input("vitals-death-die", c.value);
      assert.equal(ui.byTestId("vitals-death-record").disabled, !c.enabled);
      if (c.enabled) {
        ui.click("vitals-death-record");
        assert.deepEqual(live.commands(), [{ cmd: "RECORD_DEATH_SAVE", token_id: HERO, d20: 17 }]);
      }
      ui.unmount();
    });
  }

  it("a token carrying a stat block copy names it", () => {
    const live = liveTable(GM_ID, gmView({}, {}, { stat_block: { name: "Goblin Warrior", ac: 15 } }));
    selectedTokenIdSignal.value = GOBLIN;
    const ui = mount(h(TokenVitalsPanel, { client: live.client, isGm: true }));
    assert.equal(ui.byTestId("vitals-stat-block").textContent, "Stat block: Goblin Warrior");
    ui.unmount();
  });
});

describe("DeathSaveAnnouncement: the room's death saving throw, announced", () => {
  const outcome = (over = {}) => ({ successes: 0, failures: 0, regains_hp: false, stable: false, dead: false, ...over });
  const cases = [
    { id: "the controller hears the roll and both counters", role: "player", d20: 14, outcome: outcome({ successes: 2, failures: 1 }), text: "Brakka rolled 14 on a death saving throw. Successes 2 of 3, failures 1 of 3" },
    { id: "the controller hears Stable", role: "player", d20: 12, outcome: outcome({ stable: true }), text: "Brakka rolled 12 on a death saving throw. Brakka is Stable." },
    { id: "the controller hears the regained hit point on a 20", role: "player", d20: 20, outcome: outcome({ regains_hp: true }), text: "Brakka rolled 20 on a death saving throw. Brakka regains 1 Hit Point and wakes up." },
    { id: "the controller hears death", role: "player", d20: 1, outcome: outcome({ failures: 3, dead: true }), text: "Brakka rolled 1 on a death saving throw. Brakka dies." },
    { id: "another player hears only the roll (redacted counters)", role: "other", d20: 14, outcome: outcome(), text: "Brakka rolled 14 on a death saving throw." },
    { id: "another player still hears death", role: "other", d20: 3, outcome: outcome({ dead: true }), text: "Brakka rolled 3 on a death saving throw. Brakka dies." },
  ] as const;
  for (const c of cases) {
    it(c.id, () => {
      const state =
        c.role === "player"
          ? playerView()
          : tableState({ tokens: {}, public_tokens: { [HERO]: publicToken(HERO, "Brakka", { top_left: { x: 100, y: 50 } }) } });
      const live = liveTable(PLAYER_ID, state);
      const ui = mount(h(DeathSaveAnnouncement, { client: live.client }));
      assert.equal(ui.byTestId("death-save-result").textContent, "");
      live.client.applyServerEnvelope({ type: "CommandAccepted", seqId: 10, state, events: [{ event: "DEATH_SAVE_RECORDED", token_id: HERO, d20: c.d20, outcome: c.outcome }] } as any);
      assert.equal(ui.byTestId("death-save-result").textContent, c.text);
      assert.equal(ui.byTestId("death-save-result").getAttribute("role"), "status");
      live.client.applyServerEnvelope({ type: "CommandAccepted", seqId: 11, state, events: [{ event: "TOKEN_MOVED" }] } as any);
      assert.equal(ui.byTestId("death-save-result").textContent, c.text, "kept across later table events");
      ui.unmount();
    });
  }
});

describe("tableView: death saving throw phase", () => {
  const cases = [
    { id: "above 0 HP the token is conscious", token: { hp: 5 }, expected: "conscious" },
    { id: "at 0 HP the token is dying", token: { hp: 0 }, expected: "dying" },
    { id: "three successes leave it stable at 0 HP", token: { hp: 0, death_save_successes: 3, is_stable: true }, expected: "stable" },
    { id: "three failures leave it dead", token: { hp: 0, death_save_failures: 3, is_dead: true }, expected: "dead" },
    { id: "a natural 20 brings it back to 1 HP", token: { hp: 1, death_save_successes: 0, death_save_failures: 0 }, expected: "conscious" },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const [token] = listTableTokens(tableState({ tokens: { [HERO]: fullToken(HERO, "Brakka", c.token) } }));
      assert.equal(deathSavePhase(token), c.expected);
    });
  }

  it("a public token's phase is unknown (its HP is not projected)", () => {
    const [token] = listTableTokens(tableState({ public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin") } }));
    assert.equal(deathSavePhase(token), "unknown");
  });
});

describe("TokenConditionsPanel: conditions, rulings and automated effects", () => {
  const toggles = [
    { id: "player adds Grappled to their own token", role: "player", conditions: [], toggle: "grappled", expected: ["grappled"] },
    { id: "player removes Prone and keeps the rest", role: "player", conditions: ["prone", "poisoned"], toggle: "prone", expected: ["poisoned"] },
    { id: "GM adds Restrained to any token", role: "GM", conditions: [], toggle: "restrained", expected: ["restrained"] },
  ] as const;
  for (const c of toggles) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, isGm ? gmView({}, { conditions: [...c.conditions] }) : playerView({}, { conditions: [...c.conditions] }));
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenConditionsPanel, { client: live.client, isGm }));
      ui.click(`condition-${c.toggle}`);
      assert.deepEqual(live.commands(), [{ cmd: "SET_TOKEN_CONDITIONS", token_id: HERO, conditions: c.expected }]);
      ui.unmount();
    });
  }

  const rulings = [
    { id: "a player gets no rulings", role: "player", present: false },
    { id: "the GM gets the rulings", role: "GM", present: true },
  ] as const;
  for (const c of rulings) {
    it(c.id, () => {
      const { userId, isGm } = viewer(c.role);
      const live = liveTable(userId, isGm ? gmView() : playerView());
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenConditionsPanel, { client: live.client, isGm }));
      assert.equal(ui.byTestId("conditions-rulings") !== null, c.present);
      ui.unmount();
    });
  }

  const overrides = [
    { id: "forcing a condition sends FORCE", testId: "ruling-condition-prone", value: "FORCE", existing: [], expected: { subject: "CONDITION", id: "prone", mode: "FORCE" } },
    { id: "clearing a ruling sends mode null", testId: "ruling-condition-prone", value: "", existing: [{ subject: "CONDITION", id: "prone", mode: "FORCE" }], expected: { subject: "CONDITION", id: "prone", mode: null } },
    {
      id: "removing one automated effect sends an EFFECT ruling",
      testId: "ruling-effect-grappled.speed_zero",
      value: "REMOVE",
      existing: [],
      expected: { subject: "EFFECT", id: "grappled.speed_zero", mode: "REMOVE" },
    },
  ] as const;
  for (const c of overrides) {
    it(`GM: ${c.id}`, () => {
      const live = liveTable(GM_ID, gmView({}, { conditions: ["grappled"], condition_overrides: [...c.existing] }));
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenConditionsPanel, { client: live.client, isGm: true }));
      ui.input(c.testId, c.value, "change");
      assert.deepEqual(live.commands(), [{ cmd: "CONDITION_OVERRIDE", token_id: HERO, ...c.expected }]);
      ui.unmount();
    });
  }

  const effects = [
    { id: "Grappled shows Speed 0", conditions: ["grappled"], overrides: [], expected: /Speed 0/ },
    { id: "Paralyzed shows incapacitated and automatic save failures", conditions: ["paralyzed"], overrides: [], expected: /Incapacitated.*Strength and Dexterity saving throws fail/ },
    { id: "Petrified shows resistance to all damage", conditions: ["petrified"], overrides: [], expected: /Resistance to all damage/ },
    { id: "Exhaustion is reported as applying", conditions: ["exhaustion"], overrides: [], expected: /Exhaustion applies/ },
    { id: "a GM ruling removing Speed 0 lifts it", conditions: ["grappled"], overrides: [{ subject: "EFFECT", id: "grappled.speed_zero", mode: "REMOVE" }], expected: /^(?!.*Speed 0)/ },
    { id: "Poisoned lists its disadvantage sources by name", conditions: ["poisoned"], overrides: [], expected: /Poisoned: disadvantage on its attack rolls.*Poisoned: disadvantage on ability checks/ },
    { id: "Invisible lists advantage on attacks and Initiative", conditions: ["invisible"], overrides: [], expected: /Invisible: advantage on its attack rolls.*Invisible: attack rolls against it have disadvantage.*Invisible: advantage on Initiative/ },
    { id: "a removed roll-mode effect is not listed", conditions: ["poisoned"], overrides: [{ subject: "EFFECT", id: "poisoned.check_disadvantage", mode: "REMOVE" }], expected: /^(?!.*ability checks).*attack rolls/ },
  ] as const;
  for (const c of effects) {
    it(`effects: ${c.id}`, () => {
      const live = liveTable(GM_ID, gmView({}, { conditions: [...c.conditions], condition_overrides: [...c.overrides] }));
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenConditionsPanel, { client: live.client, isGm: true }));
      assert.match(ui.byTestId("conditions-effects").textContent, c.expected);
      ui.unmount();
    });
  }

  it("the GM ruling list names effects instead of raw ids", () => {
    const live = liveTable(GM_ID, gmView({}, { conditions: ["grappled"] }));
    selectedTokenIdSignal.value = HERO;
    const ui = mount(h(TokenConditionsPanel, { client: live.client, isGm: true }));
    assert.equal(ui.byTestId("ruling-effect-grappled.speed_zero").getAttribute("aria-label"), "Ruling for Grappled: Speed 0");
    ui.unmount();
  });

  const ACTOR_URL = `PUT /api/v1/campaigns/${CAMPAIGN}/actors/${HERO_ACTOR}`;
  const linkedHero = (level: number, conditions: string[]) => {
    const live = liveTable(PLAYER_ID, playerView({}, { actor_id: HERO_ACTOR, conditions }), {
      [ACTOR_URL]: { status: 200, body: { actor: actorDto({ id: HERO_ACTOR, version: 2 }) } },
    });
    live.client.state.actors.value = { [HERO_ACTOR]: { id: HERO_ACTOR, version: 1, data: { attributes: { exhaustion: level } } } as any };
    selectedTokenIdSignal.value = HERO;
    return live;
  };
  const steps = [
    { id: "raising from 0 saves level 1 and adds the Exhaustion condition", level: 0, conditions: [], button: "exhaustion-increase", saved: 1, commands: [{ cmd: "SET_TOKEN_CONDITIONS", token_id: HERO, conditions: ["exhaustion"] }] },
    { id: "raising from 2 saves level 3 and keeps the condition", level: 2, conditions: ["exhaustion"], button: "exhaustion-increase", saved: 3, commands: [] },
    { id: "lowering to 0 saves level 0 and removes the condition", level: 1, conditions: ["prone", "exhaustion"], button: "exhaustion-decrease", saved: 0, commands: [{ cmd: "SET_TOKEN_CONDITIONS", token_id: HERO, conditions: ["prone"] }] },
  ];
  for (const c of steps) {
    it(`exhaustion stepper: ${c.id}`, async () => {
      const live = linkedHero(c.level, c.conditions);
      const ui = mount(h(TokenConditionsPanel, { client: live.client, campaignId: CAMPAIGN }));
      ui.click(c.button);
      await flush(4);
      const put = live.transport.calls.find((call) => call.method === "PUT")?.body as Record<string, any>;
      assert.equal(put.data.attributes.exhaustion, c.saved);
      assert.deepEqual(live.commands(), c.commands);
      ui.unmount();
    });
  }

  const derivedSteps = [
    { id: "raising 1 to 2 saves a derived speed of 20 ft (30 - 10)", level: 1, button: "exhaustion-increase", speed: 20 },
    { id: "lowering 2 to 1 saves a derived speed of 25 ft", level: 2, button: "exhaustion-decrease", speed: 25 },
    { id: "raising 5 to 6 saves a derived speed of 0 ft", level: 5, button: "exhaustion-increase", speed: 0 },
  ];
  for (const c of derivedSteps) {
    it(`exhaustion stepper: ${c.id}`, async () => {
      const live = linkedHero(c.level, ["exhaustion"]);
      const sheet = { ...createDefaultActorData(HERO_ACTOR, "Brakka"), derived: { speed: 999 } };
      sheet.attributes.exhaustion = c.level;
      live.client.state.actors.value = { [HERO_ACTOR]: { id: HERO_ACTOR, version: 1, data: sheet } as any };
      const ui = mount(h(TokenConditionsPanel, { client: live.client, campaignId: CAMPAIGN }));
      ui.click(c.button);
      await flush(4);
      const put = live.transport.calls.find((call) => call.method === "PUT")?.body as Record<string, any>;
      assert.equal(put.data.derived.speed, c.speed);
      ui.unmount();
    });
  }

  const bounds = [
    { id: "level 0 cannot go lower", level: 0, decrease: true, increase: false },
    { id: "level 6 cannot go higher", level: 6, decrease: false, increase: true },
  ];
  for (const c of bounds) {
    it(`exhaustion stepper: ${c.id}`, () => {
      const ui = mount(h(TokenConditionsPanel, { client: linkedHero(c.level, c.level > 0 ? ["exhaustion"] : []).client, campaignId: CAMPAIGN }));
      assert.equal(ui.byTestId("exhaustion-decrease").disabled, c.decrease);
      assert.equal(ui.byTestId("exhaustion-increase").disabled, c.increase);
      assert.equal(ui.byTestId("exhaustion-level").textContent, `${c.level} / 6`);
      ui.unmount();
    });
  }

  const penalties = [
    { id: "level 2 shows -4 to d20 tests and -10 ft of Speed", level: 2, expected: /Exhaustion level 2: -4 to d20 tests, Speed -10 ft\./ },
    { id: "level 6 says the creature dies", level: 6, expected: /Exhaustion level 6: -12 to d20 tests, Speed -30 ft\..*the creature dies/ },
  ];
  for (const c of penalties) {
    it(`exhaustion summary: ${c.id}`, () => {
      const ui = mount(h(TokenConditionsPanel, { client: linkedHero(c.level, ["exhaustion"]).client, campaignId: CAMPAIGN }));
      assert.match(ui.byTestId("conditions-effects").textContent, c.expected);
      ui.unmount();
    });
  }

  it("a player sees a public token's conditions read-only", () => {
    const live = liveTable(PLAYER_ID, tableState({ public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { conditions: ["prone"] }) } }));
    selectedTokenIdSignal.value = GOBLIN;
    const ui = mount(h(TokenConditionsPanel, { client: live.client }));
    assert.equal(ui.byTestId("conditions-readonly").textContent, "Prone");
    assertAbsent(ui.byTestId("condition-prone"), "condition-prone");
    ui.unmount();
  });
});

describe("CoverSuggestionPanel: suggested, never applied", () => {
  const suggestions = [
    { id: "open ground suggests no cover", walls: [], expected: /Suggested cover: No cover/ },
    { id: "a wall across the line of fire suggests three-quarters cover, never total", walls: [wallBetween], expected: /Suggested cover: Three-quarters cover \(\+5 to AC/ },
  ];
  for (const c of suggestions) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView({ walls: c.walls }));
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(CoverSuggestionPanel, { client: live.client }));
      ui.input("cover-target", GOBLIN, "change");
      assert.match(ui.byTestId("cover-suggestion").textContent, c.expected);
      assert.equal(acceptedCoverSignal.value, null, "a suggestion alone changes nothing");
      ui.unmount();
    });
  }

  const accepts = [
    { id: "accepting keeps the suggested level", choice: null, expected: { cover: "NONE", bonus: 0 } },
    { id: "the user may pick another level before accepting", choice: "HALF", expected: { cover: "HALF", bonus: 2 } },
  ];
  for (const c of accepts) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView());
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(CoverSuggestionPanel, { client: live.client }));
      ui.input("cover-target", GOBLIN, "change");
      if (c.choice) ui.input("cover-choice", c.choice, "change");
      ui.click("cover-accept");
      assert.deepEqual(acceptedCoverSignal.value, { attackerId: HERO, targetId: GOBLIN, ...c.expected });
      assert.match(ui.byTestId("cover-accepted").textContent, /Cover in use/);
      assert.equal(live.commands().length, 0, "cover is local until an attack uses it");
      ui.unmount();
    });
  }

  const totalChoice = [
    { id: "a player cannot rule total cover", userId: PLAYER_ID, isGm: false, offered: false },
    { id: "the GM may rule total cover", userId: GM_ID, isGm: true, offered: true },
  ];
  for (const c of totalChoice) {
    it(c.id, () => {
      const live = liveTable(c.userId, c.isGm ? gmView() : playerView());
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(CoverSuggestionPanel, { client: live.client, isGm: c.isGm }));
      ui.input("cover-target", GOBLIN, "change");
      assert.equal(/Total cover/.test(ui.byTestId("cover-choice").textContent ?? ""), c.offered);
      assert.match(ui.byTestId("cover-choice").textContent ?? "", /Three-quarters cover/);
      ui.unmount();
    });
  }

  it("selecting a token the user does not control shows no targeting", () => {
    const live = liveTable(PLAYER_ID, playerView());
    selectedTokenIdSignal.value = GOBLIN;
    const ui = mount(h(CoverSuggestionPanel, { client: live.client }));
    assertAbsent(ui.byTestId("cover-panel"), "cover-panel");
    ui.unmount();
  });
});

describe("Rejections and redacted wire fields", () => {
  const reasons = [
    { id: "SpeedZero gets a plain-language explanation", reason: "speed is 0: a condition prevents this token from moving", expected: /Speed is 0 because of a condition/ },
    { id: "DoorLocked explains who can open it", reason: "door is locked", expected: /Only the Game Master can open it/ },
    {
      id: "DoorOutOfReach asks for a token next to the door",
      reason: "door is out of reach: none of your tokens is within 5 ft and can see it",
      expected: /^none of your creatures is within 5 ft of the door with a clear view of it/,
    },
    { id: "an unknown server-side reason is shown as sent", reason: "campaign is archived", expected: /^campaign is archived$/ },
  ];
  for (const c of reasons) {
    it(`rejectionReason: ${c.id}`, () => assert.match(rejectionReason(c.reason), c.expected));
  }

  const detail = (code: string, neededFt: number | null = null, remainingFt: number | null = null) => ({
    code,
    neededFt,
    remainingFt,
    condition: null,
  });
  const coded = [
    {
      id: "wall collision in English names no coordinates",
      locale: "en",
      detail: detail("WALL_COLLISION"),
      expected: /^a wall blocks that path\. Go around it or through an open door\.$/,
    },
    { id: "wall collision in French", locale: "fr", detail: detail("WALL_COLLISION"), expected: /^un mur bloque ce chemin/ },
    {
      id: "insufficient movement in English gives both distances in feet",
      locale: "en",
      detail: detail("INSUFFICIENT_MOVEMENT", 35, 12.5),
      expected: /^this move costs 35 ft but only 12\.5 ft of movement is left this turn/,
    },
    {
      id: "insufficient movement in French uses the French decimal comma",
      locale: "fr",
      detail: detail("INSUFFICIENT_MOVEMENT", 35, 12.5),
      expected: /^ce déplacement coûte 35 ft mais il ne reste que 12,5 ft de mouvement/,
    },
    {
      id: "insufficient movement without numbers falls back to a generic sentence",
      locale: "en",
      detail: detail("INSUFFICIENT_MOVEMENT"),
      expected: /^this move costs more movement than is left this turn/,
    },
    { id: "not your turn in English", locale: "en", detail: detail("NOT_ACTIVE_TURN"), expected: /^it is not your turn/ },
    { id: "paused table in French", locale: "fr", detail: detail("EXPLORATION_PAUSED"), expected: /^le MJ a mis les déplacements en pause/ },
    { id: "empty undo in English", locale: "en", detail: detail("NOTHING_TO_UNDO"), expected: /^there is nothing left to undo\.$/ },
    { id: "pending reaction in English", locale: "en", detail: detail("REACTION_PENDING"), expected: /^this token is waiting for a reaction decision/ },
    { id: "an unknown future code shows the server text", locale: "en", detail: detail("SOMETHING_NEW"), expected: /^raw text$/ },
  ] as const;
  for (const c of coded) {
    it(`rejectionReason with detail: ${c.id}`, () => {
      localeSignal.value = c.locale;
      const text = rejectionReason(c.id === "an unknown future code shows the server text" ? "raw text" : "movement blocked by a wall", c.detail);
      localeSignal.value = "en";
      assert.match(text, c.expected);
    });
  }

  const localized = [
    { id: "English", locale: "en", expected: /^Open or close door was refused: none of your creatures is within 5 ft/ },
    { id: "French", locale: "fr", expected: /aucune de vos créatures n'est à 5 ft ou moins de la porte/ },
  ] as const;
  for (const c of localized) {
    it(`a refused door toggle explains the reach rule in ${c.id}`, () => {
      localeSignal.value = c.locale;
      const live = liveTable(PLAYER_ID, playerView());
      live.client.state.commandFeedback.value = [
        { id: 1, kind: "rejected", action: "TOGGLE_DOOR", reason: "door is out of reach: none of your tokens is within 5 ft and can see it" },
      ];
      const ui = mount(h(CommandFeedbackToasts, { client: live.client }));
      assert.match(ui.byTestId("command-feedback-item").textContent, c.expected);
      ui.unmount();
      localeSignal.value = "en";
    });
  }

  const serverLimits = [
    {
      id: "rate limit toast in English",
      locale: "en",
      action: "MOVE_TOKEN",
      reason: "rate limited: too many table actions, wait a moment",
      expected: /^Move token was refused: too many table actions in a short time\. Wait a moment/,
    },
    {
      id: "rate limit toast in French",
      locale: "fr",
      action: "MOVE_TOKEN",
      reason: "rate limited: too many table actions, wait a moment",
      expected: /trop d'actions sur la table en peu de temps/,
    },
    {
      id: "condition immunity toast in English",
      locale: "en",
      action: "SET_TOKEN_CONDITIONS",
      reason: "condition immunity: this creature is immune to paralyzed",
      expected: /^Change conditions was refused: this creature is immune to that condition\. The Game Master can still force it/,
    },
    {
      id: "condition immunity toast in French",
      locale: "fr",
      action: "SET_TOKEN_CONDITIONS",
      reason: "condition immunity: this creature is immune to paralyzed",
      expected: /^Action refusée \(Modifier les états\) : cette créature est immunisée contre cet état/,
    },
  ] as const;
  for (const c of serverLimits) {
    it(c.id, () => {
      localeSignal.value = c.locale;
      const live = liveTable(PLAYER_ID, playerView());
      live.client.state.commandFeedback.value = [{ id: 1, kind: "rejected", action: c.action, reason: c.reason }];
      const ui = mount(h(CommandFeedbackToasts, { client: live.client }));
      assert.match(ui.byTestId("command-feedback-item").textContent, c.expected);
      ui.unmount();
      localeSignal.value = "en";
    });
  }

  it("a refused move with an engine code explains it in the toast, in feet", () => {
    const live = liveTable(PLAYER_ID, playerView());
    live.client.state.commandFeedback.value = [
      {
        id: 1,
        kind: "rejected",
        action: "MOVE_TOKEN",
        reason: "insufficient movement budget: need 35.0 ft, have 10.0 ft",
        detail: { code: "INSUFFICIENT_MOVEMENT", neededFt: 35, remainingFt: 10, condition: null },
      },
    ];
    const ui = mount(h(CommandFeedbackToasts, { client: live.client }));
    assert.match(ui.byTestId("command-feedback-item").textContent, /^Move token was refused: this move costs 35 ft but only 10 ft/);
    ui.unmount();
  });

  it("a refused move shows the SpeedZero explanation in the toast", () => {
    const live = liveTable(PLAYER_ID, playerView());
    live.client.state.commandFeedback.value = [{ id: 1, kind: "rejected", action: "MOVE_TOKEN", reason: "speed is 0: a condition prevents this token from moving" }];
    const ui = mount(h(CommandFeedbackToasts, { client: live.client }));
    assert.match(ui.byTestId("command-feedback-item").textContent, /^Move token was refused: this creature's Speed is 0/);
    ui.unmount();
  });

  it("a redacted reaction prompt (no destination, no resolved reactors) still renders", () => {
    const prompt = {
      prompt_id: PROMPT,
      reactor_actor_id: HERO,
      trigger_token_id: GOBLIN,
      reactor_owner_user_id: PLAYER_ID,
      pending_destination: null,
      resolved_reactor_ids: [],
    };
    const live = liveTable(PLAYER_ID, playerView({ active_reaction_prompts: { [PROMPT]: prompt } }));
    const ui = mount(h(ReactionBanner, { client: live.client, isGm: false }));
    assert.match(ui.byTestId(`reaction-${PROMPT}`).textContent, /Brakka can make an opportunity attack against Goblin/);
    ui.unmount();
  });
});
