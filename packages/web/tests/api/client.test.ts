import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decode } from "@msgpack/msgpack";
import { ApiClient, ApiError } from "../../src/api/client.ts";
import { createSessionState, type SessionState } from "../../src/api/session.ts";
import type { McpStagingProposal, ProjectedTableState, ServerEnvelope } from "../../src/api/wire.ts";
import { authUserDto, createMockTransport, type RouteReply } from "../helpers/mockTransport.ts";

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
      frames: [{ type: "CommandRejected", reason: "Not your turn" }],
      check: (s) => assert.equal(s.lastRejection.value, "Not your turn"),
    },
    {
      id: "an accepted command clears the previous rejection",
      frames: [
        { type: "CommandRejected", reason: "Not your turn" },
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
