// Seam 5: room connection manager (RT11) and command feedback (RT10 / UA16) against a mocked transport and fake timers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { decode } from "@msgpack/msgpack";
import { ApiClient } from "../../src/api/client.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  RECONNECT_MAX_DELAY_MS,
  reconnectDelayMs,
  type NetworkWatcher,
} from "../../src/api/connection.ts";
import { createSessionState, type ConnectionStatus } from "../../src/api/session.ts";
import type { ProjectedTableState, WireTokenState } from "../../src/api/wire.ts";
import * as commands from "../../src/table/commands.ts";
import { createMockTransport, type MockSocket, type RouteReply } from "../helpers/mockTransport.ts";

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ROUTE = `GET /api/v1/campaigns/${CAMPAIGN_ID}`;
const TOKEN_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const TOKEN_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const T0 = 1_000_000;

function token(id: string): WireTokenState {
  return { id, name: id.slice(-1), top_left: { x: 0, y: 0 }, grid_w: 1, grid_h: 1 };
}

function table(overrides: Partial<ProjectedTableState> = {}): ProjectedTableState {
  return {
    campaign_id: CAMPAIGN_ID,
    mode: "EXPLORATION",
    exploration_paused: false,
    ambient_lighting: "DAYLIGHT",
    cell_size_px: 50,
    feet_per_cell: 5,
    tokens: {},
    walls: [],
    persistent_aoes: {},
    initiative_order: [],
    active_turn_index: null,
    round: 1,
    lights: [],
    fog_overrides: [],
    background_asset_hash: null,
    map_width_px: 1000,
    map_height_px: 1000,
    active_reaction_prompts: {},
    mcp_staging_proposals: {},
    ...overrides,
  };
}

/** Controllable `online` / `offline` / visibility hints. */
function fakeNetwork() {
  let handlers: Parameters<NetworkWatcher["watch"]>[0] | null = null;
  const net = {
    online: true,
    isOnline: () => net.online,
    watch(h: Parameters<NetworkWatcher["watch"]>[0]) {
      handlers = h;
      return () => {
        handlers = null;
      };
    },
    goOffline() {
      net.online = false;
      handlers?.offline();
    },
    goOnline() {
      net.online = true;
      handlers?.online();
    },
    becomeVisible() {
      handlers?.visible();
    },
  };
  return net;
}

/** Lets mocked `fetch` promises (the access probe) settle; `setImmediate` is not faked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function setup(routes: Record<string, RouteReply> = { [CAMPAIGN_ROUTE]: { status: 200, body: { campaign: {} } } }) {
  const transport = createMockTransport(routes);
  const network = fakeNetwork();
  const state = createSessionState();
  // random 0.5 => jitter factor 1.0, so delays are exactly 500, 1000, 2000, ... ms.
  const client = new ApiClient({ transport, state, wsOrigin: "ws://table.test", network, random: () => 0.5 });
  const socket = (i: number): MockSocket => transport.sockets[i];
  const latest = (): MockSocket => transport.sockets[transport.sockets.length - 1];
  const snapshot = (s: MockSocket, seq: number, st: ProjectedTableState) => s.receive({ StateSnapshot: { seq_id: seq, state: st } });
  const frames = (s: MockSocket) => s.sent.map((bytes) => decode(bytes) as Record<string, any>);
  return { client, state, transport, network, socket, latest, snapshot, frames };
}

/** Connected client: first socket open with an applied snapshot. */
function connected(routes?: Record<string, RouteReply>) {
  const env = setup(routes);
  env.client.connect(CAMPAIGN_ID);
  env.socket(0).open();
  env.snapshot(env.socket(0), 1, table());
  return env;
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 }));
afterEach(() => mock.timers.reset());

describe("reconnectDelayMs: exponential backoff with jitter", () => {
  const cases = [
    { id: "first retry waits 0.5 s", attempt: 1, random: 0.5, expected: 500 },
    { id: "second retry doubles to 1 s", attempt: 2, random: 0.5, expected: 1000 },
    { id: "fifth retry waits 8 s", attempt: 5, random: 0.5, expected: 8000 },
    { id: "sixth retry is capped at 15 s", attempt: 6, random: 0.5, expected: RECONNECT_MAX_DELAY_MS },
    { id: "lowest jitter shortens by 20 %", attempt: 3, random: 0, expected: 1600 },
    { id: "highest jitter never exceeds the 15 s cap", attempt: 9, random: 0.999, expected: RECONNECT_MAX_DELAY_MS },
  ];
  for (const c of cases) {
    it(c.id, () => assert.equal(reconnectDelayMs(c.attempt, c.random), c.expected));
  }
});

describe("reconnects_after_1001_with_backoff", () => {
  const cases = [
    { id: "reconnects_after_1001_with_backoff: deploy / shutdown Going Away", code: 1001 },
    { id: "reconnects_after_1001_with_backoff: network drop (1006)", code: 1006 },
    { id: "reconnects_after_1001_with_backoff: server error (1011)", code: 1011 },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { client, state, transport, latest, snapshot } = connected();

      latest().serverClose(c.code);
      assert.equal(state.connection.value, "reconnecting");
      assert.deepEqual(state.reconnect.value, { attempt: 1, nextRetryAtMs: T0 + 500 });

      mock.timers.tick(499);
      assert.equal(transport.sockets.length, 1, "no retry before the 0.5 s backoff");
      mock.timers.tick(1);
      assert.equal(transport.sockets.length, 2);
      assert.deepEqual(state.reconnect.value, { attempt: 1, nextRetryAtMs: null }, "retry in flight");

      latest().serverClose(1006); // the restarted server is not up yet: refused handshake
      await settle();
      assert.deepEqual(state.reconnect.value, { attempt: 2, nextRetryAtMs: T0 + 500 + 1000 });
      mock.timers.tick(999);
      assert.equal(transport.sockets.length, 2, "second retry waits 1 s");
      mock.timers.tick(1);
      assert.equal(transport.sockets.length, 3);

      latest().open();
      assert.equal(state.connection.value, "open");
      snapshot(latest(), 2, table());
      assert.deepEqual(state.reconnect.value, { attempt: 0, nextRetryAtMs: null }, "snapshot resets the backoff");
      client.disconnect();
    });
  }

  it("reconnects_after_1001_with_backoff: leaving the campaign never reconnects", () => {
    const { client, state, transport } = connected();
    client.disconnect();
    mock.timers.tick(60_000);
    assert.equal(transport.sockets.length, 1);
    assert.equal(transport.sockets[0].closed, true);
    assert.equal(state.connection.value, "closed");
  });
});

describe("no_reconnect_on_policy_close", () => {
  const cases: Array<{ id: string; opened: boolean; code: number; probe?: RouteReply; expected: ConnectionStatus }> = [
    { id: "no_reconnect_on_policy_close: 1008 policy violation -> forbidden", opened: true, code: 1008, expected: "forbidden" },
    { id: "no_reconnect_on_policy_close: 4401 -> signedOut", opened: true, code: 4401, expected: "signedOut" },
    { id: "no_reconnect_on_policy_close: 4403 -> forbidden", opened: true, code: 4403, expected: "forbidden" },
    {
      id: "no_reconnect_on_policy_close: refused handshake + 401 probe -> signedOut",
      opened: false,
      code: 1006,
      probe: { status: 401, body: { code: "UNAUTHORIZED", error: "valid authentication credentials required" } },
      expected: "signedOut",
    },
    {
      id: "no_reconnect_on_policy_close: refused handshake + 403 probe -> forbidden",
      opened: false,
      code: 1006,
      probe: { status: 403, body: { code: "FORBIDDEN", error: "user is not an active member of this campaign" } },
      expected: "forbidden",
    },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { client, state, transport, socket } = setup(c.probe ? { [CAMPAIGN_ROUTE]: c.probe } : {});
      client.connect(CAMPAIGN_ID);
      if (c.opened) socket(0).open();
      socket(0).serverClose(c.code);
      await settle();
      mock.timers.tick(5 * 60_000);
      await settle();
      assert.equal(state.connection.value, c.expected);
      assert.equal(transport.sockets.length, 1, "no reconnect loop");
    });
  }

  it("no_reconnect_on_policy_close: refused handshake with a healthy 200 probe retries", async () => {
    const { client, state, transport, socket } = setup();
    client.connect(CAMPAIGN_ID);
    socket(0).serverClose(1006);
    await settle();
    assert.equal(state.connection.value, "reconnecting");
    mock.timers.tick(500);
    assert.equal(transport.sockets.length, 2);
    client.disconnect();
  });
});

describe("missing_pong_triggers_reconnect", () => {
  const cases = [
    { id: "missing_pong_triggers_reconnect: no Pong within 10 s drops the socket", pong: false },
    { id: "missing_pong_triggers_reconnect: a timely Pong keeps the socket", pong: true },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const { client, state, transport, socket, frames } = connected();
      mock.timers.tick(HEARTBEAT_INTERVAL_MS);
      const ping = frames(socket(0)).at(-1);
      assert.deepEqual(ping, { Ping: { client_time_ms: T0 + HEARTBEAT_INTERVAL_MS } });
      if (c.pong) socket(0).receive({ Pong: { client_time_ms: T0 + HEARTBEAT_INTERVAL_MS, server_time_ms: 1 } });

      mock.timers.tick(PONG_TIMEOUT_MS);
      assert.equal(socket(0).closed, !c.pong);
      assert.equal(state.connection.value, c.pong ? "open" : "reconnecting");
      mock.timers.tick(500);
      assert.equal(transport.sockets.length, c.pong ? 1 : 2);
      client.disconnect();
    });
  }
});

describe("browser network hints", () => {
  it("offline drops the socket and pauses retries; online retries at once", () => {
    const { client, state, transport, network, latest } = connected();
    network.goOffline();
    assert.equal(state.connection.value, "offline");
    assert.equal(transport.sockets[0].closed, true);
    mock.timers.tick(60_000);
    assert.equal(transport.sockets.length, 1, "no retries while offline");
    network.goOnline();
    assert.equal(transport.sockets.length, 2, "online retries without waiting for the backoff");
    assert.equal(state.connection.value, "reconnecting");
    latest().open();
    assert.equal(state.connection.value, "open");
    client.disconnect();
  });

  it("a visible page skips the remaining backoff", () => {
    const { client, transport, network, latest } = connected();
    latest().serverClose(1001);
    network.becomeVisible();
    assert.equal(transport.sockets.length, 2);
    client.disconnect();
  });

  it("a visible page with an open socket sends a heartbeat at once", () => {
    const { client, network, socket, frames } = connected();
    network.becomeVisible();
    assert.deepEqual(frames(socket(0)).at(-1), { Ping: { client_time_ms: T0 } });
    client.disconnect();
  });
});

describe("snapshot_replaces_state_after_reconnect", () => {
  it("snapshot_replaces_state_after_reconnect: stale table stays until the new snapshot, which replaces everything", () => {
    const { client, state, latest, snapshot } = connected();
    snapshot(latest(), 5, table({ mode: "TURN_BY_TURN", tokens: { [TOKEN_A]: token(TOKEN_A) }, initiative_totals: { [TOKEN_A]: 15 } }));
    latest().receive({ CommandAccepted: { seq_id: 6, events: [{ event: "TOKEN_MOVED" }], state: table({ mode: "TURN_BY_TURN", tokens: { [TOKEN_A]: token(TOKEN_A) } }) } });
    client.submitCommand(commands.advanceTurn());
    assert.deepEqual(state.initiativeTotals.value, { [TOKEN_A]: 15 });

    latest().serverClose(1001);
    mock.timers.tick(500);
    latest().open();
    assert.ok(state.table.value?.tokens[TOKEN_A], "stale table stays visible under the banner until the snapshot");

    // After a restart (or WAL quarantine) the server's seq may be lower than the stale one.
    snapshot(latest(), 3, table({ mode: "TURN_BY_TURN", tokens: { [TOKEN_B]: token(TOKEN_B) }, initiative_totals: {} }));
    assert.deepEqual(Object.keys(state.table.value?.tokens ?? {}), [TOKEN_B]);
    assert.equal(state.seqId.value, 3);
    assert.deepEqual(state.initiativeTotals.value, {}, "pre-drop totals are not merged into the fresh state");
    assert.deepEqual(state.lastEvents.value, []);

    latest().receive({ CommandRejected: { reason: "late" } });
    assert.equal(state.commandFeedback.value.at(-1)?.action, null, "pending commands from the dead socket were discarded");
    client.disconnect();
  });
});

describe("rejected_command_toast_matches_correlation_id", () => {
  const cases: Array<{ id: string; rejectWith: (ids: string[]) => string | undefined; expected: string | null }> = [
    { id: "rejected_command_toast_matches_correlation_id: exact id picks the matching action", rejectWith: (ids) => ids[0], expected: "MOVE_TOKEN" },
    { id: "rejected_command_toast_matches_correlation_id: RollDice ids are tracked too", rejectWith: (ids) => ids[2], expected: "ROLL_DICE" },
    { id: "rejected_command_toast_matches_correlation_id: no id falls back to the most recent pending", rejectWith: () => undefined, expected: "ROLL_DICE" },
    { id: "rejected_command_toast_matches_correlation_id: unknown id matches nothing", rejectWith: () => "not-sent-by-this-client", expected: null },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const { client, state, socket, frames } = connected();
      client.submitCommand(commands.moveToken(TOKEN_A, { x: 50, y: 50 }));
      client.submitCommand(commands.advanceTurn());
      client.rollDice("1d20", "Public", "");
      const ids = frames(socket(0)).map((f) => String((f.SubmitCommand ?? f.RollDice).correlation_id));
      assert.equal(new Set(ids).size, 3, "every frame carries a distinct correlation id");

      const correlationId = c.rejectWith(ids);
      socket(0).receive({ CommandRejected: { reason: "Not your turn", ...(correlationId ? { correlation_id: correlationId } : {}) } });
      assert.deepEqual(state.commandFeedback.value, [{ id: 1, kind: "rejected", action: c.expected, reason: "Not your turn" }]);
      assert.equal(state.lastRejection.value, "Not your turn");
      client.disconnect();
    });
  }

  it("rejected_command_toast_matches_correlation_id: only the 3 newest toasts are kept and dismiss removes one", () => {
    const { client, state, socket } = connected();
    for (const reason of ["r1", "r2", "r3", "r4"]) socket(0).receive({ CommandRejected: { reason } });
    assert.deepEqual(state.commandFeedback.value.map((f) => f.reason), ["r2", "r3", "r4"]);
    client.dismissFeedback(state.commandFeedback.value[0].id);
    assert.deepEqual(state.commandFeedback.value.map((f) => f.reason), ["r3", "r4"]);
    client.disconnect();
  });
});

describe("submit_while_offline_shows_feedback", () => {
  const cases: Array<{ id: string; arrange: (env: ReturnType<typeof setup>) => void; submit: (c: ApiClient) => boolean; action: string }> = [
    {
      id: "submit_while_offline_shows_feedback: before the socket opens",
      arrange: ({ client }) => client.connect(CAMPAIGN_ID),
      submit: (c) => c.submitCommand(commands.advanceTurn()),
      action: "ADVANCE_TURN",
    },
    {
      id: "submit_while_offline_shows_feedback: while reconnecting after a drop",
      arrange: ({ client, socket }) => {
        client.connect(CAMPAIGN_ID);
        socket(0).open();
        socket(0).serverClose(1001);
      },
      submit: (c) => c.submitCommand(commands.moveToken(TOKEN_A, { x: 0, y: 0 })),
      action: "MOVE_TOKEN",
    },
    {
      id: "submit_while_offline_shows_feedback: browser offline, dice roll",
      arrange: ({ client, socket, network }) => {
        client.connect(CAMPAIGN_ID);
        socket(0).open();
        network.goOffline();
      },
      submit: (c) => c.rollDice("1d20", "Public", ""),
      action: "ROLL_DICE",
    },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const env = setup();
      c.arrange(env);
      assert.equal(c.submit(env.client), false);
      assert.deepEqual(env.transport.sockets.flatMap((s) => s.sent), [], "nothing is sent or queued");
      assert.deepEqual(env.state.commandFeedback.value, [{ id: 1, kind: "notConnected", action: c.action, reason: null }]);
      env.latest().open();
      assert.deepEqual(env.latest().sent, [], "nothing is replayed after reconnecting");
      env.client.disconnect();
    });
  }
});
