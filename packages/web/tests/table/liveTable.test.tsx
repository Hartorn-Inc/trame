import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { h } from "preact";
import { selectedActorIdSignal, selectedTokenIdSignal } from "../../src/api/session.ts";
import { isSheetDrawerOpenSignal } from "../../src/hud/HudDrawers.tsx";
import { localeSignal } from "../../src/i18n/index.ts";
import { CombatTrackerBar } from "../../src/table/CombatTrackerBar.tsx";
import { DiceTray } from "../../src/table/DiceTray.tsx";
import { GmOverrideToolbar } from "../../src/table/GmOverrideToolbar.tsx";
import { ReactionBanner } from "../../src/table/ReactionBanner.tsx";
import { TableCanvas } from "../../src/table/TableCanvas.tsx";
import { initiativeEntries, listTableTokens, promptsForUser, snapToCell } from "../../src/table/tableView.ts";
import { TokenVitalsPanel } from "../../src/table/TokenVitalsPanel.tsx";
import {
  CAMPAIGN,
  GM_ID,
  GOBLIN,
  HERO,
  HERO_ACTOR,
  OTHER_PLAYER_ID,
  PLAYER_ID,
  fullToken,
  liveTable,
  mount,
  publicToken,
  tableState,
} from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const PROMPT = "bbbbbbbb-0000-4000-8000-000000000001";
const PROPOSAL = "cccccccc-0000-4000-8000-000000000001";

/** GM projection: every token is full. */
const gmView = (overrides = {}) =>
  tableState({
    tokens: {
      [HERO]: fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, actor_id: HERO_ACTOR, top_left: { x: 100, y: 50 }, hp: 12, max_hp: 13 }),
      [GOBLIN]: fullToken(GOBLIN, "Goblin", { top_left: { x: 200, y: 200 }, hp: 7, max_hp: 7 }),
    },
    ...overrides,
  });

/** Player projection: own hero full, goblin reduced to a health tier. */
const playerView = (overrides = {}) =>
  tableState({
    tokens: { [HERO]: fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, actor_id: HERO_ACTOR, top_left: { x: 100, y: 50 }, hp: 12, max_hp: 13 }) },
    public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { top_left: { x: 200, y: 200 }, bloodied: "BLOODIED" }) },
    ...overrides,
  });

beforeEach(() => {
  selectedTokenIdSignal.value = null;
  selectedActorIdSignal.value = null;
  isSheetDrawerOpenSignal.value = false;
});

describe("tableView: projection-driven selectors", () => {
  const snaps = [
    { id: "a point inside a cell snaps to its top-left corner", point: { x: 123, y: 77 }, cell: 50, expected: { x: 100, y: 50 } },
    { id: "a point on a cell edge stays on that edge", point: { x: 150, y: 0 }, cell: 50, expected: { x: 150, y: 0 } },
    { id: "a zero cell size never divides by zero", point: { x: 7.5, y: 3.2 }, cell: 0, expected: { x: 7, y: 3 } },
  ];
  for (const c of snaps) {
    it(`snapToCell: ${c.id}`, () => assert.deepEqual(snapToCell(c.point, c.cell), c.expected));
  }

  const views = [
    { id: "GM controls every token and sees exact HP", state: gmView(), controlled: [HERO, GOBLIN], goblinHp: 7, goblinTier: null },
    { id: "player controls only their hero and sees the goblin's tier, not its HP", state: playerView(), controlled: [HERO], goblinHp: null, goblinTier: "BLOODIED" },
  ];
  for (const c of views) {
    it(`listTableTokens: ${c.id}`, () => {
      const tokens = listTableTokens(c.state);
      assert.deepEqual(tokens.filter((tok) => tok.controlled).map((tok) => tok.id).sort(), [...c.controlled].sort());
      const goblin = tokens.find((tok) => tok.id === GOBLIN)!;
      assert.equal(goblin.hp, c.goblinHp);
      assert.equal(goblin.bloodied, c.goblinTier);
    });
  }

  const prompts = [
    { id: "the reactor's owner sees the prompt", userId: PLAYER_ID, isGm: false, count: 1 },
    { id: "another player does not", userId: OTHER_PLAYER_ID, isGm: false, count: 0 },
    { id: "the GM sees every prompt", userId: GM_ID, isGm: true, count: 1 },
  ];
  for (const c of prompts) {
    it(`promptsForUser: ${c.id}`, () => {
      const state = playerView({
        active_reaction_prompts: { [PROMPT]: { prompt_id: PROMPT, reactor_actor_id: HERO, trigger_token_id: GOBLIN, reactor_owner_user_id: PLAYER_ID } },
      });
      assert.equal(promptsForUser(state, c.userId, c.isGm).length, c.count);
    });
  }

  it("initiativeEntries is empty outside combat and follows the engine order inside it", () => {
    assert.deepEqual(initiativeEntries(gmView(), {}), []);
    const entries = initiativeEntries(gmView({ mode: "TURN_BY_TURN", initiative_order: [GOBLIN, HERO], active_turn_index: 1 }), { [GOBLIN]: 18 });
    assert.deepEqual(entries.map((e) => [e.name, e.total, e.isActive]), [["Goblin", 18, false], ["Brakka", null, true]]);
  });
});

describe("TableCanvas: token selection and movement", () => {
  it("clicking a token selects it and its linked actor sheet", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    ui.click(`token-${HERO}`);
    assert.equal(selectedTokenIdSignal.value, HERO);
    assert.equal(selectedActorIdSignal.value, HERO_ACTOR);
    assert.equal(ui.byTestId(`token-${HERO}`).getAttribute("aria-pressed"), "true");
    assert.equal(live.commands().length, 0, "selecting is local; it sends nothing");
    ui.unmount();
  });

  const arrows = [
    { id: "ArrowRight moves the hero one cell east", key: "ArrowRight", to: { x: 150, y: 50 } },
    { id: "ArrowUp moves the hero one cell north", key: "ArrowUp", to: { x: 100, y: 0 } },
  ];
  for (const c of arrows) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView());
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
      ui.key(`token-${HERO}`, c.key);
      assert.deepEqual(live.commands(), [{ cmd: "MOVE_TOKEN", token_id: HERO, to_top_left: c.to, to_elevation_ft: null, gm_teleport: false }]);
      ui.unmount();
    });
  }

  it("a player cannot move a public (uncontrolled) token", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    ui.key(`token-${GOBLIN}`, "ArrowRight");
    assert.equal(live.commands().length, 0);
    assert.match(ui.byTestId(`token-${GOBLIN}`).getAttribute("aria-label"), /Goblin, Bloodied/);
    ui.unmount();
  });

  it("clicking the board with a controlled token selected moves it to the snapped cell", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    ui.click(`token-${GOBLIN}`);
    ui.byTestId("table-board").getBoundingClientRect = () => ({ left: 10, top: 20 });
    ui.click("table-board", { clientX: 10 + 333, clientY: 20 + 260 });
    assert.deepEqual(live.commands().at(-1)?.to_top_left, { x: 300, y: 250 });
    ui.unmount();
  });

  it("an accepted move re-renders the token from the server snapshot", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: 5,
      events: [{ event: "TOKEN_MOVED", token_id: HERO }],
      state: playerView({ tokens: { [HERO]: fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, top_left: { x: 150, y: 50 } }) } }),
    });
    assert.equal(ui.byTestId(`token-${HERO}`).style.left, "150px");
    ui.unmount();
  });
});

describe("TableCanvas: renderer shell", () => {
  const toggles = [
    { id: "the GM gets the player-vision preview toggle", userId: GM_ID, isGm: true, state: gmView(), toggle: true },
    { id: "a player never gets the preview toggle", userId: PLAYER_ID, isGm: false, state: playerView(), toggle: false },
  ];
  for (const c of toggles) {
    it(c.id, () => {
      const live = liveTable(c.userId, c.state);
      const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: c.isGm }));
      const toggle = ui.byTestId("table-preview-player-view");
      assert.equal(toggle !== null, c.toggle);
      if (toggle) {
        ui.click("table-preview-player-view");
        assert.equal(ui.byTestId("table-preview-player-view").getAttribute("aria-pressed"), "true");
      }
      ui.unmount();
    });
  }

  it("without WebGL the labelled canvas stays hidden and the token buttons remain", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    const canvas = ui.byTestId("table-render");
    assert.equal(canvas.getAttribute("role"), "img");
    assert.ok(canvas.getAttribute("aria-label"));
    assert.ok(canvas.hasAttribute("hidden"));
    assert.ok(ui.byTestId(`token-${HERO}`));
    assert.ok(ui.byTestId(`token-${GOBLIN}`));
    ui.unmount();
  });
});

describe("CombatTrackerBar: initiative totals and turn commands", () => {
  it("GM starts combat with an empty order so the server rolls initiative", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(CombatTrackerBar, { client: live.client, isGm: true }));
    ui.click("combat-start");
    assert.deepEqual(live.commands(), [{ cmd: "START_TURN_BY_TURN", initiative_order: [], initiative_totals: {} }]);
    ui.unmount();
  });

  it("server initiative rolls fill the totals shown next to each combatant", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const roll = (reason: string, total: number) =>
      live.client.applyServerEnvelope({
        type: "DiceRolled",
        roll: { roll_id: reason, roller_user_id: GM_ID, expression: "1d20", visibility: "Public", reason, blind_masked: false, terms: [], flat_modifier: 0, total, is_critical_success: false, is_critical_failure: false },
      });
    roll("Initiative: Brakka", 17);
    roll("Initiative: Goblin", 9);
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: 9,
      events: [{ event: "TABLE_MODE_CHANGED", mode: "TURN_BY_TURN" }],
      state: playerView({ mode: "TURN_BY_TURN", initiative_order: [HERO, GOBLIN], active_turn_index: 0 }),
    });
    const ui = mount(h(CombatTrackerBar, { client: live.client, isGm: false }));
    assert.equal(ui.byTestId(`initiative-value-${HERO}`).textContent, "17");
    assert.equal(ui.byTestId(`initiative-value-${GOBLIN}`).textContent, "9");
    assert.equal(ui.byTestId(`initiative-${HERO}`).getAttribute("aria-current"), "true");
    assert.match(ui.byTestId("combat-active").textContent, /Brakka's turn/);
    ui.unmount();
  });

  const turnButtons = [
    { id: "the player owning the active token can end their turn", userId: PLAYER_ID, active: 0, next: true },
    { id: "a player cannot advance someone else's turn", userId: PLAYER_ID, active: 1, next: false },
  ];
  for (const c of turnButtons) {
    it(c.id, () => {
      const live = liveTable(c.userId, playerView({ mode: "TURN_BY_TURN", initiative_order: [HERO, GOBLIN], active_turn_index: c.active }));
      const ui = mount(h(CombatTrackerBar, { client: live.client, isGm: false }));
      assert.equal(Boolean(ui.byTestId("combat-next")), c.next);
      assert.equal(ui.byTestId("combat-end"), null);
      ui.unmount();
    });
  }

  const gmActions = [
    { id: "Next turn sends ADVANCE_TURN", act: (ui: any) => ui.click("combat-next"), expected: { cmd: "ADVANCE_TURN" } },
    { id: "End combat sends END_TURN_BY_TURN", act: (ui: any) => ui.click("combat-end"), expected: { cmd: "END_TURN_BY_TURN" } },
    {
      id: "editing a total sends SET_INITIATIVE_TOTAL",
      act: (ui: any) => ui.input(`initiative-total-${GOBLIN}`, "21", "change"),
      expected: { cmd: "SET_INITIATIVE_TOTAL", token_id: GOBLIN, total: 21 },
    },
  ];
  for (const c of gmActions) {
    it(`GM: ${c.id}`, () => {
      const live = liveTable(GM_ID, gmView({ mode: "TURN_BY_TURN", initiative_order: [HERO, GOBLIN], active_turn_index: 0 }));
      const ui = mount(h(CombatTrackerBar, { client: live.client, isGm: true }));
      c.act(ui);
      assert.deepEqual(live.commands(), [c.expected]);
      ui.unmount();
    });
  }
});

describe("GmOverrideToolbar: lighting, undo, and MCP staging review", () => {
  it("renders nothing for a player", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const ui = mount(h(GmOverrideToolbar, { client: live.client, isGm: false }));
    assert.equal(ui.byTestId("gm-toolbar"), null);
    ui.unmount();
  });

  const actions = [
    { id: "Commit all applies the staged batch", button: `mcp-commit-${PROPOSAL}`, expected: { cmd: "COMMIT_MCP_STAGING", proposal_id: PROPOSAL } },
    { id: "Reject discards the staged batch", button: `mcp-reject-${PROPOSAL}`, expected: { cmd: "REJECT_MCP_STAGING", proposal_id: PROPOSAL } },
    { id: "Undo sends UNDO_LAST_ACTION", button: "gm-undo", expected: { cmd: "UNDO_LAST_ACTION" } },
  ];
  for (const c of actions) {
    it(c.id, () => {
      const proposal = { proposal_id: PROPOSAL, summary: "Spawn two wolves", commands: [{ cmd: "SPAWN_TOKEN" }, { cmd: "SPAWN_TOKEN" }] };
      const live = liveTable(GM_ID, gmView({ mcp_staging_proposals: { [PROPOSAL]: proposal } }));
      const ui = mount(h(GmOverrideToolbar, { client: live.client, isGm: true }));
      assert.match(ui.byTestId(`mcp-proposal-${PROPOSAL}`).textContent, /Spawn two wolves.*2 commands: SPAWN_TOKEN, SPAWN_TOKEN/);
      ui.click(c.button);
      assert.deepEqual(live.commands(), [c.expected]);
      ui.unmount();
    });
  }

  it("changing the lighting preset sends SET_AMBIENT_LIGHTING", () => {
    const live = liveTable(GM_ID, gmView());
    const ui = mount(h(GmOverrideToolbar, { client: live.client, isGm: true }));
    ui.input("gm-lighting", "PITCH_DARKNESS", "change");
    assert.deepEqual(live.commands(), [{ cmd: "SET_AMBIENT_LIGHTING", preset: "PITCH_DARKNESS" }]);
    ui.unmount();
  });
});

describe("TokenVitalsPanel: damage and heal controls", () => {
  const cases = [
    { id: "Deal damage sends APPLY_DAMAGE with the raw amount", button: "vitals-damage", expected: { cmd: "APPLY_DAMAGE", token_id: HERO, raw_damage: 5, affinity: "NORMAL", is_critical: false, damage_type: null } },
    { id: "Heal sends HEAL_ACTOR with the amount", button: "vitals-heal", expected: { cmd: "HEAL_ACTOR", token_id: HERO, amount: 5 } },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView());
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenVitalsPanel, { client: live.client }));
      assert.match(ui.byTestId("vitals-hp").textContent, /HP 12 \/ 13/);
      ui.input("vitals-amount", "5");
      ui.click(c.button);
      assert.deepEqual(live.commands(), [c.expected]);
      ui.unmount();
    });
  }

  const invalid = [
    { id: "an empty amount", value: "" },
    { id: "zero", value: "0" },
    { id: "a negative amount", value: "-4" },
    { id: "a fraction", value: "2.5" },
  ];
  for (const c of invalid) {
    it(`buttons stay disabled for ${c.id}`, () => {
      const live = liveTable(PLAYER_ID, playerView());
      selectedTokenIdSignal.value = HERO;
      const ui = mount(h(TokenVitalsPanel, { client: live.client }));
      ui.input("vitals-amount", c.value);
      assert.equal(ui.byTestId("vitals-damage").disabled, true);
      assert.equal(ui.byTestId("vitals-heal").disabled, true);
      ui.unmount();
    });
  }

  it("a public token shows its tier and no controls", () => {
    const live = liveTable(PLAYER_ID, playerView());
    selectedTokenIdSignal.value = GOBLIN;
    const ui = mount(h(TokenVitalsPanel, { client: live.client }));
    assert.equal(ui.byTestId("vitals-hp").textContent, "Bloodied");
    assert.equal(ui.byTestId("vitals-damage"), null);
    ui.unmount();
  });

  it("Open sheet selects the linked actor and opens the drawer when the sheet is loaded", () => {
    const live = liveTable(PLAYER_ID, playerView());
    live.client.state.actors.value = { [HERO_ACTOR]: { version: 1, data: {} } };
    selectedTokenIdSignal.value = HERO;
    const ui = mount(h(TokenVitalsPanel, { client: live.client }));
    ui.click("vitals-open-sheet");
    assert.equal(selectedActorIdSignal.value, HERO_ACTOR);
    assert.equal(isSheetDrawerOpenSignal.value, true);
    ui.unmount();
  });
});

describe("ReactionBanner: prompts, decisions, and undo", () => {
  const prompt = (awaiting: boolean) => ({
    [PROMPT]: { prompt_id: PROMPT, reactor_actor_id: HERO, trigger_token_id: GOBLIN, reactor_owner_user_id: PLAYER_ID, awaiting_resolution: awaiting },
  });

  const decisions = [
    { id: "Use reaction sends DECIDE_REACTION TRIGGER", awaiting: false, button: `reaction-trigger-${PROMPT}`, expected: { cmd: "DECIDE_REACTION", prompt_id: PROMPT, actor_id: HERO, decision: { decision: "TRIGGER", ability_id: null } } },
    { id: "Pass sends DECIDE_REACTION PASS", awaiting: false, button: `reaction-pass-${PROMPT}`, expected: { cmd: "DECIDE_REACTION", prompt_id: PROMPT, actor_id: HERO, decision: { decision: "PASS" } } },
    { id: "a triggered prompt offers RESOLVE_REACTION", awaiting: true, button: `reaction-resolve-${PROMPT}`, expected: { cmd: "RESOLVE_REACTION", prompt_id: PROMPT } },
  ];
  for (const c of decisions) {
    it(c.id, () => {
      const live = liveTable(PLAYER_ID, playerView({ active_reaction_prompts: prompt(c.awaiting) }));
      const ui = mount(h(ReactionBanner, { client: live.client, isGm: false }));
      assert.match(ui.byTestId(`reaction-${PROMPT}`).textContent, /Brakka can make an opportunity attack against Goblin/);
      ui.click(c.button);
      assert.deepEqual(live.commands(), [c.expected]);
      ui.unmount();
    });
  }

  it("undo withdraws the prompt with UNDONE and re-opening it brings the prompt back", () => {
    const live = liveTable(PLAYER_ID, playerView({ active_reaction_prompts: prompt(false) }));
    const ui = mount(h(ReactionBanner, { client: live.client, isGm: false }));
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: 10,
      events: [{ event: "ACTION_UNDONE" }, { event: "REACTION_PROMPT_CLOSED", prompt_id: PROMPT, reason: "UNDONE" }],
      state: playerView(),
    });
    assert.equal(ui.byTestId(`reaction-${PROMPT}`), null);
    assert.match(ui.byTestId("reaction-undone").textContent, /withdrawn by the GM's undo/);
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: 11,
      events: [{ event: "ACTION_UNDONE" }, { event: "REACTION_PROMPT_OPENED", prompt: prompt(false)[PROMPT] }],
      state: playerView({ active_reaction_prompts: prompt(false) }),
    });
    assert.ok(ui.byTestId(`reaction-${PROMPT}`));
    assert.equal(ui.byTestId("reaction-undone").textContent, "");
    ui.unmount();
  });
});

describe("DiceTray: WebSocket table rolls", () => {
  it("Roll sends a RollDice envelope with the chosen visibility", () => {
    const live = liveTable(PLAYER_ID, playerView());
    const ui = mount(h(DiceTray, { client: live.client }));
    ui.input("tray-expression", "2d6+3");
    ui.input("tray-visibility", "GmOnly", "change");
    ui.byTestId("tray-roll").closest("form").dispatchEvent({ type: "submit" });
    assert.deepEqual(live.frames(), [{ RollDice: { expression: "2d6+3", visibility: "GmOnly", reason: "" } }]);
    ui.unmount();
  });

  it("a closed socket refuses the roll with an alert", () => {
    const live = liveTable(PLAYER_ID, playerView());
    live.client.disconnect();
    const ui = mount(h(DiceTray, { client: live.client }));
    ui.byTestId("tray-roll").closest("form").dispatchEvent({ type: "submit" });
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /Not connected/);
    ui.unmount();
  });

  const logs = [
    { id: "a public roll shows its total", total: 14 as number | null, expected: /1d20 = 14/ },
    { id: "a masked blind roll shows a hidden result", total: null, expected: /Hidden result/ },
  ];
  for (const c of logs) {
    it(`log: ${c.id}`, () => {
      const live = liveTable(PLAYER_ID, playerView());
      live.client.applyServerEnvelope({
        type: "DiceRolled",
        roll: { roll_id: "r1", roller_user_id: GM_ID, expression: "1d20", visibility: "Public", reason: "", blind_masked: c.total === null, terms: [], flat_modifier: 0, total: c.total, is_critical_success: null, is_critical_failure: null },
      });
      const ui = mount(h(DiceTray, { client: live.client }));
      assert.match(ui.byTestId("tray-log").textContent, c.expected);
      ui.unmount();
    });
  }
});
