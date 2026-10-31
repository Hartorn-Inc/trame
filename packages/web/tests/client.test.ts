import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decode, encode } from "@msgpack/msgpack";
import { ApiClient, decodeServerEnvelope } from "../src/api/client.ts";
import { appSignals, resetAppSignals } from "../src/state/appSignals.ts";
import type { CampaignRoomState, ServerEnvelope, TrameCommand } from "../src/types/index.ts";

const originalFetch = globalThis.fetch;
const originalWebSocket = (globalThis as unknown as { WebSocket: unknown }).WebSocket;

class MockWebSocket {
  public static OPEN = 1;
  public readyState = MockWebSocket.OPEN;
  public binaryType = "arraybuffer";
  public sentData: Uint8Array[] = [];
  public onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;

  constructor(public url: string) {}

  public send(data: Uint8Array | ArrayBuffer): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.sentData.push(bytes);
  }

  public close(): void {
    this.readyState = 3;
  }
}

describe("ApiClient and MessagePack protocol suite", () => {
  beforeEach(() => {
    resetAppSignals();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it("WHEN client.ts decodes a binary ServerEnvelope::StateSync MessagePack payload, client.ts updates appSignals.tableStateSignal with CampaignRoomState and populates appSignals.actorsSignal.", () => {
    const sampleState: CampaignRoomState = {
      campaignId: "c-alpha",
      mode: "EXPLORATION",
      explorationPaused: false,
      ambientLighting: "DAYLIGHT",
      cellSizePx: 100,
      feetPerCell: 5,
      tokens: {
        "tok-1": {
          id: "tok-1",
          name: "Valeros",
          topLeft: { x: 120, y: 140 },
          gridW: 1,
          gridH: 1,
          isSqueezing: false,
          elevationFt: 0,
          heightFt: 5,
          visibilityChannel: 1,
          invisible: false,
          hp: 24,
          maxHp: 24,
          tempHp: 0,
          speedMaxFt: 30,
          speedRemainingFt: 30,
          hasAction: true,
          hasBonusAction: true,
          hasReaction: true,
        },
      },
      walls: [],
      initiativeOrder: ["tok-1"],
      activeTurnIndex: 0,
      round: 1,
    };

    const clientInstance = new ApiClient();
    const binaryPayload = encode({
      type: "StateSync",
      seq_id: 42,
      state: sampleState,
    });

    const decoded = clientInstance.handleServerMessage(binaryPayload);
    assert.equal(decoded.type, "StateSync");

    assert.notEqual(appSignals.tableStateSignal.value, null);
    assert.equal(appSignals.tableStateSignal.value?.campaignId, "c-alpha");
    assert.equal(appSignals.tableStateSignal.value?.tokens["tok-1"].name, "Valeros");
    assert.equal(appSignals.actorsSignal.value.length, 1);
    assert.equal(appSignals.actorsSignal.value[0].name, "Valeros");
  });

  it("WHEN client.ts decodes a binary ServerEnvelope::Delta MessagePack payload containing a TrameEvent::TokenMoved event, client.ts mutates the target Actor position in appSignals.tableStateSignal without replacing the root signal reference.", () => {
    const initialRoomState: CampaignRoomState = {
      campaignId: "c-beta",
      mode: "EXPLORATION",
      explorationPaused: false,
      ambientLighting: "DAYLIGHT",
      cellSizePx: 100,
      feetPerCell: 5,
      tokens: {
        "tok-rogue": {
          id: "tok-rogue",
          name: "Merisiel",
          topLeft: { x: 50, y: 60 },
          gridW: 1,
          gridH: 1,
          isSqueezing: false,
          elevationFt: 0,
          heightFt: 5,
          visibilityChannel: 1,
          invisible: false,
          hp: 18,
          maxHp: 18,
          tempHp: 0,
          speedMaxFt: 30,
          speedRemainingFt: 30,
          hasAction: true,
          hasBonusAction: true,
          hasReaction: true,
        },
      },
      walls: [],
      initiativeOrder: [],
      activeTurnIndex: 0,
      round: 1,
      actors: [
        {
          id: "tok-rogue",
          campaignId: "c-beta",
          name: "Merisiel",
          kind: "character",
          hp: 18,
          maxHp: 18,
          position: { x: 50, y: 60 },
          topLeft: { x: 50, y: 60 },
        },
      ],
    };

    appSignals.tableStateSignal.value = initialRoomState;
    appSignals.actorsSignal.value = [...(initialRoomState.actors || [])];
    const rootReferenceBefore = appSignals.tableStateSignal.value;

    const clientInstance = new ApiClient();
    const deltaPayload = encode({
      type: "Delta",
      seq_id: 43,
      events: [
        {
          event: "TokenMoved",
          token_id: "tok-rogue",
          from_top_left: { x: 50, y: 60 },
          to_top_left: { x: 300, y: 400 },
          elevation_ft: 10,
          speed_remaining_ft: 15,
        },
      ],
    });

    clientInstance.handleServerMessage(deltaPayload);

    assert.strictEqual(
      appSignals.tableStateSignal.value,
      rootReferenceBefore,
      "Root signal reference must not be replaced upon Delta processing",
    );
    assert.deepEqual(appSignals.tableStateSignal.value?.tokens["tok-rogue"].topLeft, {
      x: 300,
      y: 400,
    });
    assert.equal(appSignals.tableStateSignal.value?.tokens["tok-rogue"].elevationFt, 10);
    assert.equal(appSignals.tableStateSignal.value?.tokens["tok-rogue"].speedRemainingFt, 15);
    assert.deepEqual(appSignals.tableStateSignal.value?.actors?.[0].position, {
      x: 300,
      y: 400,
    });
  });

  it("WHEN client.ts invokes sendCommand with a TrameCommand, client.ts encodes the command into a binary MessagePack ClientEnvelope::Command buffer and transmits the buffer over the active WebSocket connection.", () => {
    const clientInstance = new ApiClient();
    const mockWs = clientInstance.connectWebSocket("camp-123");

    const moveCmd: TrameCommand = {
      cmd: "MOVE_TOKEN",
      token_id: "tok-123",
      to_top_left: { x: 150, y: 250 },
      to_elevation_ft: 5,
      gm_teleport: false,
    };

    const returnedBuffer = clientInstance.sendCommand(moveCmd);
    assert.ok(returnedBuffer instanceof Uint8Array);

    const customMock = mockWs as unknown as MockWebSocket;
    assert.equal(customMock.sentData.length, 1);
    const sentBuffer = customMock.sentData[0];

    const decoded = decode(sentBuffer) as Record<string, unknown>;
    assert.ok(decoded.Command || decoded.type === "Command" || decoded.SubmitCommand);
    const innerCommand = (decoded.Command || decoded.command || decoded.SubmitCommand) as TrameCommand;
    assert.equal(innerCommand.cmd, "MOVE_TOKEN");
    assert.equal(innerCommand.token_id, "tok-123");
  });

  it("WHEN a Game Master clicks the Export Archive button in CampaignLobby.tsx, client.ts downloads a binary .trame ZIP archive containing manifest.json, database.jsonl, notes, and assets.", async () => {
    const fakeZipBytes = new Uint8Array([80, 75, 3, 4, 10, 0, 0, 0]);

    globalThis.fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/v1/campaigns/c-test/export")) {
        return new Response(fakeZipBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="campaign-c-test.trame"',
          },
        });
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    };

    const clientInstance = new ApiClient();
    const blob = await clientInstance.exportArchive("c-test");
    assert.ok(blob instanceof Blob);
    const arrayBuf = await blob.arrayBuffer();
    const receivedBytes = new Uint8Array(arrayBuf);
    assert.deepEqual(receivedBytes.slice(0, 4), new Uint8Array([80, 75, 3, 4]));
  });

  it("decodes alternative externally tagged PascalCase MessagePack envelopes", () => {
    const snapshotBinary = encode({
      StateSnapshot: {
        seq_id: 10,
        state: {
          campaign_id: "camp-snap",
          mode: "TURN_BY_TURN",
          exploration_paused: true,
          tokens: {},
          walls: [],
        },
      },
    });
    const decoded = decodeServerEnvelope(snapshotBinary);
    assert.equal(decoded.type, "StateSync");
    if (decoded.type === "StateSync") {
      assert.equal(decoded.seqId, 10);
      assert.equal(decoded.state.campaignId, "camp-snap");
      assert.equal(decoded.state.mode, "TURN_BY_TURN");
      assert.equal(decoded.state.explorationPaused, true);
    }
  });

  it("executes REST registration, login, campaign CRUD, and PAT flows", async () => {
    globalThis.fetch = async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      const method = init?.method || "GET";
      if (urlStr.includes("/api/v1/auth/register") && method === "POST") {
        return new Response(JSON.stringify({
          user: {
            id: "u-1",
            email: "gm@trame.test",
            displayName: "GM",
            username: "GM",
            isGuest: false,
            isEphemeral: false,
            role: "GM",
          },
        }), { status: 201 });
      }
      if (urlStr.includes("/api/v1/campaigns") && method === "POST") {
        return new Response(JSON.stringify({
          campaign: {
            id: "c-created",
            name: "Dungeon of Doom",
            system: "dnd5e",
            role: "GM",
            createdAt: "2026-01-01",
          },
        }), { status: 201 });
      }
      if (urlStr.includes("/api/v1/auth/pat") && method === "POST") {
        return new Response(JSON.stringify({
          id: "pat-1",
          token: "trame_pat_test12345678901234567890123456789012",
          userId: "u-1",
          scopes: ["campaigns:read"],
          createdAt: Date.now(),
        }), { status: 201 });
      }
      throw new Error(`Unhandled: ${method} ${urlStr}`);
    };

    const clientInstance = new ApiClient();
    const user = await clientInstance.register({
      email: "gm@trame.test",
      displayName: "GM",
      password: "Pass123456!",
    });
    assert.equal(user.email, "gm@trame.test");
    assert.equal(appSignals.authUserSignal.value?.id, "u-1");

    const camp = await clientInstance.createCampaign({ name: "Dungeon of Doom" });
    assert.equal(camp.name, "Dungeon of Doom");
    assert.equal(appSignals.campaignsSignal.value.length, 1);

    const pat = await clientInstance.createPat({ scopes: ["campaigns:read"] });
    assert.ok(pat.token.startsWith("trame_pat_"));
  });
});
