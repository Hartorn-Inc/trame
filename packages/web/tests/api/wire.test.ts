import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decode, encode } from "@msgpack/msgpack";
import {
  bytesToUuid,
  decodeServerEnvelope,
  encodeClientEnvelope,
  toWireClientEnvelope,
  type ClientEnvelope,
} from "../../src/api/wire.ts";

const TOKEN_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/**
 * Encodes `value` the way `rmp_serde` (non-human-readable) does: every listed
 * UUID string, as a map key or a value, becomes a 16-byte `bin8`.
 */
function encodeLikeRmpSerde(value: unknown, uuids: string[]): Uint8Array {
  const placeholders = uuids.map((_, i) => `U${String(i).padStart(15, "0")}`);
  const json = uuids.reduce((acc, id, i) => acc.split(id).join(placeholders[i]), JSON.stringify(value));
  const bytes = Array.from(encode(JSON.parse(json)));
  placeholders.forEach((ph, i) => {
    const needle = [0xb0, ...Array.from(ph, (c) => c.charCodeAt(0))];
    for (let at = 0; at <= bytes.length - needle.length; at++) {
      if (needle.every((b, k) => bytes[at + k] === b)) {
        bytes.splice(at, needle.length, 0xc4, 0x10, ...uuidBytes(uuids[i]));
      }
    }
  });
  return Uint8Array.from(bytes);
}

describe("wire: ClientEnvelope external tagging", () => {
  const cases: Array<{ id: string; envelope: ClientEnvelope; wire: Record<string, unknown> }> = [
    {
      id: "PointerPing is tagged with snake_case color_hex",
      envelope: { type: "PointerPing", pos: { x: 120, y: 64 }, colorHex: "var(--atlas-focus)" },
      wire: { PointerPing: { pos: { x: 120, y: 64 }, color_hex: "var(--atlas-focus)" } },
    },
    {
      id: "SubmitCommand is a newtype variant wrapping the tagged command",
      envelope: { type: "SubmitCommand", command: { AdvanceTurn: {} } },
      wire: { SubmitCommand: { AdvanceTurn: {} } },
    },
    {
      id: "RollDice keeps expression, visibility and reason",
      envelope: { type: "RollDice", expression: "1d20+5", visibility: "GmOnly", reason: "Stealth" },
      wire: { RollDice: { expression: "1d20+5", visibility: "GmOnly", reason: "Stealth" } },
    },
    {
      id: "Ping carries client_time_ms",
      envelope: { type: "Ping", clientTimeMs: 1234 },
      wire: { Ping: { client_time_ms: 1234 } },
    },
    {
      id: "SubmitCommand flattens correlation_id into the internally tagged command map",
      envelope: { type: "SubmitCommand", command: { cmd: "ADVANCE_TURN" }, correlationId: "c-1" },
      wire: { SubmitCommand: { cmd: "ADVANCE_TURN", correlation_id: "c-1" } },
    },
    {
      id: "RollDice carries correlation_id as an extra field",
      envelope: { type: "RollDice", expression: "1d20", visibility: "Public", reason: "", correlationId: "c-2" },
      wire: { RollDice: { expression: "1d20", visibility: "Public", reason: "", correlation_id: "c-2" } },
    },
  ];

  for (const c of cases) {
    it(c.id, () => {
      assert.deepEqual(toWireClientEnvelope(c.envelope), c.wire);
      assert.deepEqual(decode(encodeClientEnvelope(c.envelope)), c.wire);
    });
  }
});

describe("wire: decodeServerEnvelope", () => {
  const state = {
    campaign_id: USER_ID,
    mode: "EXPLORATION",
    tokens: { [TOKEN_ID]: { id: TOKEN_ID, owner_user_id: USER_ID } },
    initiative_order: [TOKEN_ID],
    mcp_staging_proposals: {},
  };

  const cases: Array<{ id: string; frame: Uint8Array; expected: unknown }> = [
    {
      id: "StateSnapshot with binary UUID keys and values decodes to UUID strings",
      frame: encodeLikeRmpSerde({ StateSnapshot: { seq_id: 7, state } }, [TOKEN_ID, USER_ID]),
      expected: { type: "StateSnapshot", seqId: 7, state },
    },
    {
      id: "CommandAccepted exposes seq, events and full state",
      frame: encodeLikeRmpSerde(
        { CommandAccepted: { seq_id: 8, events: [{ TurnAdvanced: { round: 2 } }], state } },
        [TOKEN_ID, USER_ID],
      ),
      expected: { type: "CommandAccepted", seqId: 8, events: [{ TurnAdvanced: { round: 2 } }], state },
    },
    {
      id: "PointerPingBroadcast maps sender and color",
      frame: encodeLikeRmpSerde(
        { PointerPingBroadcast: { sender_user_id: USER_ID, pos: { x: 1, y: 2 }, color_hex: "var(--atlas-info)" } },
        [USER_ID],
      ),
      expected: { type: "PointerPingBroadcast", senderUserId: USER_ID, pos: { x: 1, y: 2 }, colorHex: "var(--atlas-info)" },
    },
    {
      id: "ActorUpdated carries version and data",
      frame: encodeLikeRmpSerde({ ActorUpdated: { actor_id: USER_ID, version: 3, data: { hp: 9 } } }, [USER_ID]),
      expected: { type: "ActorUpdated", actorId: USER_ID, version: 3, data: { hp: 9 } },
    },
    {
      id: "CommandRejected exposes the echoed correlation_id",
      frame: encode({ CommandRejected: { reason: "Not your turn", correlation_id: "c-1" } }),
      expected: { type: "CommandRejected", reason: "Not your turn", correlationId: "c-1" },
    },
    {
      id: "CommandRejected without correlation_id (undecodable frame or older server) decodes to null id",
      frame: encode({ CommandRejected: { reason: "malformed frame" } }),
      expected: { type: "CommandRejected", reason: "malformed frame", correlationId: null },
    },
    {
      id: "unknown variant decodes to null for forward compatibility",
      frame: encode({ FutureVariant: { x: 1 } }),
      expected: null,
    },
    {
      id: "internally tagged object is rejected",
      frame: encode({ type: "StateSnapshot", seq_id: 1 }),
      expected: null,
    },
    {
      id: "truncated bytes decode to null",
      frame: Uint8Array.from([0x81, 0xa3]),
      expected: null,
    },
  ];

  for (const c of cases) {
    it(c.id, () => {
      assert.deepEqual(decodeServerEnvelope(c.frame), c.expected);
    });
  }

  it("bytesToUuid formats 16 bytes as a hyphenated UUID", () => {
    assert.equal(bytesToUuid(uuidBytes(TOKEN_ID)), TOKEN_ID);
  });
});
