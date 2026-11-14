import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decode } from "@msgpack/msgpack";
import { ApiClient, ApiError, VERSION_CONFLICT } from "../../src/api/client.ts";
import { createSessionState, type SessionState } from "../../src/api/session.ts";
import type { McpStagingProposal, ProjectedTableState, ServerEnvelope, WireTrameEvent } from "../../src/api/wire.ts";
import * as commands from "../../src/table/commands.ts";
import { actorDto, authUserDto, createMockTransport, type RouteReply } from "../helpers/mockTransport.ts";

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL: McpStagingProposal = { proposal_id: "p-1", summary: "Spawn goblins", commands: [] };

function table(overrides: Partial<ProjectedTableState> = {}): ProjectedTableState {
  return {
    campaign_id: CAMPAIGN_ID,
    mode: "EXPLORATION",
    exploration_paused: false,
    ambient_lighting: "DAYLIGHT",
    cell_size_px: 100,
    feet_per_cell: 5,
    tokens: {},
    walls: [],
    persistent_aoes: {},
    initiative_order: [],
    active_turn_index: 0,
    round: 1,
    lights: [],
    fog_overrides: [],
    background_asset_hash: null,
    map_width_px: 1200,
    map_height_px: 800,
    active_reaction_prompts: {},
    mcp_staging_proposals: {},
    ...overrides,
  };
}

function newClient(routes: Record<string, RouteReply> = {}) {
  const transport = createMockTransport(routes);
  const state = createSessionState();
  const client = new ApiClient({ transport, state, wsOrigin: "ws://table.test" });
  return { client, state, transport };
}

describe("ApiClient: server frame reconciliation", () => {
  const cases: Array<{
    id: string;
    frames: ServerEnvelope[];
    check: (s: SessionState, handouts: string[]) => void;
  }> = [
    {
      id: "CommandAccepted replaces the full table state and advances seq",
      frames: [
        { type: "StateSnapshot", seqId: 4, state: table({ round: 1 }) },
        { type: "CommandAccepted", seqId: 5, events: [{ TurnAdvanced: {} }], state: table({ round: 2, tokens: {} }) },
      ],
      check: (s) => {
        assert.equal(s.seqId.value, 5);
        assert.equal(s.table.value?.round, 2);
        assert.deepEqual(s.lastEvents.value, [{ TurnAdvanced: {} }]);
      },
    },
    {
      id: "duplicate or reordered CommandAccepted is ignored",
      frames: [
        { type: "StateSnapshot", seqId: 9, state: table({ round: 3 }) },
        { type: "CommandAccepted", seqId: 9, events: [], state: table({ round: 1 }) },
        { type: "CommandAccepted", seqId: 7, events: [], state: table({ round: 1 }) },
      ],
      check: (s) => {
        assert.equal(s.seqId.value, 9);
        assert.equal(s.table.value?.round, 3);
      },
    },
    {
      id: "ActorUpdated applies newer versions and drops stale ones",
      frames: [
        { type: "ActorUpdated", actorId: "a-1", version: 2, data: { hp: 10 } },
        { type: "ActorUpdated", actorId: "a-1", version: 1, data: { hp: 99 } },
        { type: "ActorUpdated", actorId: "a-1", version: 3, data: { hp: 7 } },
      ],
      check: (s) => assert.deepEqual(s.actors.value["a-1"], { version: 3, data: { hp: 7 } }),
    },
    {
      id: "McpStagingProposed upserts and the next full state drops the committed proposal",
      frames: [
        { type: "McpStagingProposed", proposal: PROPOSAL },
        { type: "StateSnapshot", seqId: 1, state: table() },
      ],
      check: (s) => assert.deepEqual(s.mcpProposals.value, {}),
    },
    {
      id: "McpStagingProposed is visible until state changes",
      frames: [{ type: "McpStagingProposed", proposal: PROPOSAL }],
      check: (s) => assert.deepEqual(s.mcpProposals.value, { "p-1": PROPOSAL }),
    },
    {
      id: "HandoutRevealed stores the handout and notifies the handout modal",
      frames: [
        {
          type: "HandoutRevealed",
          handout: { event: "handout.revealed", handout_id: "h-1", title: "Map", content: "X", revealed_by: "gm", timestamp: 1 },
        },
      ],
      check: (s, handouts) => {
        assert.equal(s.lastHandout.value?.handout_id, "h-1");
        assert.deepEqual(handouts, ["h-1"]);
      },
    },
    {
      id: "CommandRejected records the reason",
      frames: [{ type: "CommandRejected", reason: "Not your turn", correlationId: null }],
      check: (s) => assert.equal(s.lastRejection.value, "Not your turn"),
    },
    {
      id: "an accepted command clears the previous rejection",
      frames: [
        { type: "CommandRejected", reason: "Not your turn", correlationId: null },
        { type: "CommandAccepted", seqId: 1, events: [], state: table() },
      ],
      check: (s) => assert.equal(s.lastRejection.value, null),
    },
    {
      id: "Pong measures round-trip time",
      frames: [{ type: "Pong", clientTimeMs: 1000, serverTimeMs: 1010 }],
      check: (s) => assert.equal(s.rttMs.value, 40),
    },
  ];

  for (const c of cases) {
    it(c.id, () => {
      const { client, state } = newClient();
      const handouts: string[] = [];
      client.onHandoutRevealed = (h) => handouts.push(h.handout_id);
      for (const frame of c.frames) client.applyServerEnvelope(frame, 1040);
      c.check(state, handouts);
    });
  }
});

describe("ApiClient: campaign WebSocket", () => {
  it("connects to the campaign route without any identity query parameter", () => {
    const { client, state, transport } = newClient();
    client.connect(CAMPAIGN_ID);
    const socket = transport.sockets[0];
    assert.equal(socket.url, `ws://table.test/api/v1/campaigns/${CAMPAIGN_ID}/ws`);
    assert.equal(socket.binaryType, "arraybuffer");
    assert.equal(state.connection.value, "connecting");
    socket.open();
    assert.equal(state.connection.value, "open");
  });

  it("drops outbound frames until the socket is open", () => {
    const { client, transport } = newClient();
    client.connect(CAMPAIGN_ID);
    assert.equal(client.sendPointerPing({ x: 1, y: 2 }, "var(--atlas-info)"), false);
    transport.sockets[0].open();
    assert.equal(client.sendPointerPing({ x: 1, y: 2 }, "var(--atlas-info)"), true);
    assert.deepEqual(decode(transport.sockets[0].sent[0]), {
      PointerPing: { pos: { x: 1, y: 2 }, color_hex: "var(--atlas-info)" },
    });
  });

  it("applies binary frames received on the socket", () => {
    const { client, state, transport } = newClient();
    client.connect(CAMPAIGN_ID);
    transport.sockets[0].receive({ StateSnapshot: { seq_id: 3, state: table({ round: 4 }) } });
    assert.equal(state.seqId.value, 3);
    assert.equal(state.table.value?.round, 4);
  });

  it("reconnecting closes the previous socket and resets table state", () => {
    const { client, state, transport } = newClient();
    client.connect(CAMPAIGN_ID);
    transport.sockets[0].receive({ StateSnapshot: { seq_id: 3, state: table() } });
    client.connect("other-campaign");
    assert.equal(transport.sockets[0].closed, true);
    assert.equal(state.seqId.value, -1);
    assert.equal(state.table.value, null);
  });
});

describe("ApiClient: session restore", () => {
  const cases: Array<{ id: string; reply: RouteReply; status: string; throws: boolean }> = [
    { id: "200 from /auth/me authenticates", reply: { status: 200, body: { user: authUserDto() } }, status: "authenticated", throws: false },
    { id: "401 from /auth/me means anonymous", reply: { status: 401, body: { code: "UNAUTHORIZED", error: "no session" } }, status: "anonymous", throws: false },
    { id: "500 from /auth/me surfaces as ApiError", reply: { status: 500, body: { code: "STORAGE_ERROR", error: "db down" } }, status: "restoring", throws: true },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client, state, transport } = newClient({ "GET /api/v1/auth/me": c.reply });
      if (c.throws) {
        await assert.rejects(client.restoreSession(), (err: unknown) => err instanceof ApiError && err.code === "STORAGE_ERROR");
      } else {
        await client.restoreSession();
      }
      assert.equal(state.status.value, c.status);
      assert.equal(transport.calls[0].credentials, "include");
    });
  }

  it("register sends display_name and stores the returned user", async () => {
    const { client, state, transport } = newClient({
      "POST /api/v1/auth/register": { status: 201, body: { user: authUserDto({ display_name: "Ada" }) } },
    });
    await client.register({ email: "ada@example.test", displayName: "Ada", password: "correct horse" });
    assert.deepEqual(transport.calls[0].body, { email: "ada@example.test", display_name: "Ada", password: "correct horse" });
    assert.equal(state.user.value?.displayName, "Ada");
  });
});

const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const ACTORS = `/api/v1/campaigns/${CAMPAIGN_ID}/actors`;

describe("ApiClient: campaign REST routes", () => {
  const cases: Array<{
    id: string;
    routes: Record<string, RouteReply>;
    run: (c: ApiClient) => Promise<unknown>;
    method: string;
    url: string;
    body?: unknown;
    check?: (s: SessionState, result: unknown) => void;
  }> = [
    {
      id: "listActors replaces the actor store with the readable sheets",
      routes: { [`GET ${ACTORS}`]: { status: 200, body: { actors: [actorDto({ version: 4 })] } } },
      run: (c) => c.listActors(CAMPAIGN_ID),
      method: "GET",
      url: ACTORS,
      check: (s) => assert.deepEqual(s.actors.value[ACTOR_ID], { version: 4, data: {}, name: "Brakka", ownerUserId: null }),
    },
    {
      id: "createActor posts name, owner and data and stores the 201 actor",
      routes: { [`POST ${ACTORS}`]: { status: 201, body: { actor: actorDto({ owner_user_id: "u-1" }) } } },
      run: (c) => c.createActor(CAMPAIGN_ID, { name: "Brakka", ownerUserId: "u-1", data: { level: 1 } }),
      method: "POST",
      url: ACTORS,
      body: { name: "Brakka", owner_user_id: "u-1", data: { level: 1 } },
      check: (s) => assert.equal(s.actors.value[ACTOR_ID]?.ownerUserId, "u-1"),
    },
    {
      id: "updateActor wraps the sheet in { expected_version, data } and stores the new version",
      routes: { [`PUT ${ACTORS}/${ACTOR_ID}`]: { status: 200, body: { actor: actorDto({ version: 3, data: { hp: 9 } }) } } },
      run: (c) => c.updateActor(CAMPAIGN_ID, ACTOR_ID, { expectedVersion: 2, data: { hp: 9 } }),
      method: "PUT",
      url: `${ACTORS}/${ACTOR_ID}`,
      body: { expected_version: 2, data: { hp: 9 } },
      check: (s) => assert.equal(s.actors.value[ACTOR_ID]?.version, 3),
    },
    {
      id: "rollDiceRest posts the expression with optional visibility and reason",
      routes: { [`POST /api/v1/campaigns/${CAMPAIGN_ID}/dice/roll`]: { status: 200, body: { roll: { total: 17 } } } },
      run: (c) => c.rollDiceRest(CAMPAIGN_ID, "1d20+4", { reason: "Stealth" }),
      method: "POST",
      url: `/api/v1/campaigns/${CAMPAIGN_ID}/dice/roll`,
      body: { expression: "1d20+4", reason: "Stealth" },
      check: (_s, roll) => assert.equal((roll as { total: number }).total, 17),
    },
    {
      id: "putSettings sends mcp_staging_mode in snake_case",
      routes: { [`PUT /api/v1/campaigns/${CAMPAIGN_ID}/settings`]: { status: 200, body: { mcp_staging_mode: true } } },
      run: (c) => c.putSettings(CAMPAIGN_ID, { mcpStagingMode: true }),
      method: "PUT",
      url: `/api/v1/campaigns/${CAMPAIGN_ID}/settings`,
      body: { mcp_staging_mode: true },
      check: (_s, res) => assert.deepEqual(res, { mcpStagingMode: true }),
    },
    {
      id: "importMap sends the raw UVTT body with the scene name in the query",
      routes: { [`POST /api/v1/campaigns/${CAMPAIGN_ID}/maps/import?name=Crypt%20A`]: { status: 201, body: { scene: { id: "s-1" } } } },
      run: (c) => c.importMap(CAMPAIGN_ID, new Uint8Array([123, 125]), "Crypt A"),
      method: "POST",
      url: `/api/v1/campaigns/${CAMPAIGN_ID}/maps/import?name=Crypt%20A`,
      body: new Uint8Array([123, 125]),
      check: (_s, scene) => assert.deepEqual(scene, { id: "s-1" }),
    },
    {
      id: "uploadAsset sends raw image bytes and returns the stable key",
      routes: {
        [`POST /api/v1/campaigns/${CAMPAIGN_ID}/assets`]: {
          status: 201,
          body: { hash: "ab", key: "instances/i/campaigns/c/assets/ab.webp", url: "https://s3/x", expires_in_secs: 900 },
        },
      },
      run: (c) => c.uploadAsset(CAMPAIGN_ID, new Uint8Array([0x89, 0x50]), "image/png"),
      method: "POST",
      url: `/api/v1/campaigns/${CAMPAIGN_ID}/assets`,
      body: new Uint8Array([0x89, 0x50]),
      check: (_s, res) => assert.equal((res as { key: string }).key, "instances/i/campaigns/c/assets/ab.webp"),
    },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client, state, transport } = newClient(c.routes);
      const result = await c.run(client);
      assert.equal(transport.calls[0].method, c.method);
      assert.equal(transport.calls[0].url, c.url);
      assert.equal(transport.calls[0].credentials, "include");
      if (c.body !== undefined) assert.deepEqual(transport.calls[0].body, c.body);
      c.check?.(state, result);
    });
  }

  const errors: Array<{ id: string; reply: RouteReply; code: string; currentVersion: unknown }> = [
    {
      id: "stale expected_version surfaces VERSION_CONFLICT with current_version",
      reply: { status: 409, body: { code: VERSION_CONFLICT, error: "stale", current_version: 5 } },
      code: VERSION_CONFLICT,
      currentVersion: 5,
    },
    {
      id: "missing expected_version surfaces MISSING_EXPECTED_VERSION",
      reply: { status: 400, body: { code: "MISSING_EXPECTED_VERSION", error: "required" } },
      code: "MISSING_EXPECTED_VERSION",
      currentVersion: undefined,
    },
  ];

  for (const e of errors) {
    it(`updateActor: ${e.id} and keeps the stored sheet`, async () => {
      const { client, state } = newClient({ [`PUT ${ACTORS}/${ACTOR_ID}`]: e.reply });
      state.actors.value = { [ACTOR_ID]: { version: 2, data: { hp: 3 } } };
      await assert.rejects(
        client.updateActor(CAMPAIGN_ID, ACTOR_ID, { expectedVersion: 2, data: { hp: 9 } }),
        (err: unknown) => err instanceof ApiError && err.code === e.code && err.body.current_version === e.currentVersion,
      );
      assert.deepEqual(state.actors.value[ACTOR_ID], { version: 2, data: { hp: 3 } });
    });
  }
});

describe("ApiClient: event-only facts from CommandAccepted", () => {
  const cases: Array<{ id: string; events: WireTrameEvent[]; mode: string; totals: Record<string, number>; closed: unknown }> = [
    {
      id: "INITIATIVE_UPDATED replaces the initiative totals",
      events: [{ event: "INITIATIVE_UPDATED", initiative_order: ["t-1"], initiative_totals: { "t-1": 18 } }],
      mode: "TURN_BY_TURN",
      totals: { "t-1": 18 },
      closed: null,
    },
    {
      id: "returning to exploration clears the initiative totals",
      events: [{ event: "TABLE_MODE_CHANGED", mode: "EXPLORATION", exploration_paused: false, round: 0 }],
      mode: "EXPLORATION",
      totals: {},
      closed: null,
    },
    {
      id: "REACTION_PROMPT_CLOSED with UNDONE is recorded for the prompt banner",
      events: [{ event: "REACTION_PROMPT_CLOSED", prompt_id: "rp-1", reason: "UNDONE" }],
      mode: "TURN_BY_TURN",
      totals: { "t-1": 12 },
      closed: { promptId: "rp-1", reason: "UNDONE" },
    },
  ];

  for (const c of cases) {
    it(c.id, () => {
      const { client, state } = newClient();
      state.initiativeTotals.value = { "t-1": 12 };
      client.applyServerEnvelope({ type: "CommandAccepted", seqId: 1, events: c.events, state: table({ mode: c.mode }) });
      assert.deepEqual(state.initiativeTotals.value, c.totals);
      assert.deepEqual(state.lastClosedPrompt.value, c.closed);
    });
  }
});

describe("table command builders", () => {
  const cases: Array<{ id: string; command: Record<string, unknown>; expected: Record<string, unknown> }> = [
    {
      id: "moveToken sends the internally tagged MOVE_TOKEN with explicit optional fields",
      command: commands.moveToken("t-1", { x: 100, y: 200 }),
      expected: { cmd: "MOVE_TOKEN", token_id: "t-1", to_top_left: { x: 100, y: 200 }, to_elevation_ft: null, gm_teleport: false },
    },
    {
      id: "applyDamage truncates to a non-negative integer",
      command: commands.applyDamage("t-1", 7.9),
      expected: { cmd: "APPLY_DAMAGE", token_id: "t-1", raw_damage: 7, affinity: "NORMAL", is_critical: false, damage_type: null },
    },
    {
      id: "healActor clamps negative healing to zero",
      command: commands.healActor("t-1", -4),
      expected: { cmd: "HEAL_ACTOR", token_id: "t-1", amount: 0 },
    },
    {
      id: "activateScene sends only the scene id",
      command: commands.activateScene("s-1"),
      expected: { cmd: "ACTIVATE_SCENE", scene_id: "s-1" },
    },
    {
      id: "decideReaction PASS uses the internally tagged decision",
      command: commands.decideReaction("rp-1", "t-2", false),
      expected: { cmd: "DECIDE_REACTION", prompt_id: "rp-1", actor_id: "t-2", decision: { decision: "PASS" } },
    },
    {
      id: "startTurnByTurn carries the initial order and totals",
      command: commands.startTurnByTurn(["t-1", "t-2"]),
      expected: { cmd: "START_TURN_BY_TURN", initiative_order: ["t-1", "t-2"], initiative_totals: {} },
    },
  ];

  for (const c of cases) {
    it(c.id, () => assert.deepEqual(c.command, c.expected));
  }

  it("submitCommand wraps the command in the external SubmitCommand tag with a UUID correlation_id", () => {
    const { client, transport } = newClient();
    client.connect(CAMPAIGN_ID);
    transport.sockets[0].open();
    client.submitCommand(commands.advanceTurn());
    const { SubmitCommand } = decode(transport.sockets[0].sent[0]) as { SubmitCommand: Record<string, unknown> };
    const { correlation_id, ...command } = SubmitCommand;
    assert.deepEqual(command, { cmd: "ADVANCE_TURN" });
    assert.match(String(correlation_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
