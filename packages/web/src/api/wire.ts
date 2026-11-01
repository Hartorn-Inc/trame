/**
 * ============================================================================
 * MESSAGEPACK WIRE CODEC FOR THE CAMPAIGN WEBSOCKET (api/wire.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Mirrors the Rust `ClientEnvelope` / `ServerEnvelope` enums in
 * `crates/trame-server/src/sync.rs` byte-for-byte. Serde serializes those enums
 * with EXTERNAL tagging (`{ "PointerPing": { pos, color_hex } }`), so a client
 * that sends `{ type: "PointerPing", ... }` is silently rejected by
 * `decode_client_envelope`. This module is the only place that knows the wire
 * shape; the rest of the app works with the tagged unions declared here.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `External Tagging`:
 *    - Outbound envelopes are encoded as a single-key map
 *      `{ Variant: payload }` with snake_case field names
 *      (`SubmitCommand` is a newtype variant: `{ SubmitCommand: <command> }`).
 * 2. `UUID Normalization`:
 *    - `rmp_serde` is not human-readable, so `Uuid` values (including
 *      `BTreeMap<Uuid, _>` keys) arrive as 16-byte binaries. Every 16-byte
 *      `Uint8Array` is rewritten to its canonical hyphenated string before the
 *      payload reaches application code. No other 16-byte binary field exists
 *      in `ServerEnvelope`.
 * 3. `Forward-Compatible Decoding`:
 *    - Unknown or malformed frames decode to `null` instead of throwing, so a
 *      newer server variant never tears down the socket handler.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `decodeServerEnvelope(bytes)`
 * ├── 1. msgpack `decode` with `mapKeyConverter` (binary UUID keys -> strings).
 * ├── 2. Deep-rewrite 16-byte binaries to UUID strings.
 * └── 3. Unwrap the single external tag into a `ServerEnvelope` union member.
 * ============================================================================
 */
import { Decoder, encode } from "@msgpack/msgpack";

/** Canonical hyphenated UUID string (`8-4-4-4-12` lowercase hex). */
export type Uuid = string;

/** Canvas coordinate in pixels (`px`). */
export interface WirePoint2D {
  /** Horizontal coordinate in canvas pixels. */
  x: number;
  /** Vertical coordinate in canvas pixels. */
  y: number;
}

/** Dice roll privacy scope (`RollVisibility` in `dice.rs`). */
export type WireRollVisibility = "Public" | "GmOnly" | "BlindGm";

/**
 * Externally tagged `TrameCommand` (`{ MoveToken: { token_id, ... } }`).
 * Command payload typing belongs to the engine bridge; the transport only
 * forwards the tagged map.
 */
export type WireTrameCommand = Record<string, unknown>;

/** Externally tagged `TrameEvent` as emitted inside `CommandAccepted.events`. */
export type WireTrameEvent = Record<string, unknown>;

/** Token entry of `ProjectedTableState.tokens` (fields beyond `id` are engine-owned). */
export interface WireTokenState {
  /** Token UUID; equals its key in `tokens`. */
  id: Uuid;
  [field: string]: unknown;
}

/** Staged MCP batch awaiting `CommitMcpStaging` / `RejectMcpStaging` (GM-only). */
export interface McpStagingProposal {
  /** Proposal UUID used by commit/reject commands. */
  proposal_id: Uuid;
  /** Human-readable summary of the batch. */
  summary: string;
  /** Ordered, externally tagged commands applied atomically on commit. */
  commands: WireTrameCommand[];
}

/** Recipient-filtered table snapshot (`ProjectedTableState` in `sync.rs`). */
export interface ProjectedTableState {
  campaign_id: Uuid;
  /** `"EXPLORATION"` or `"TURN_BY_TURN"`. */
  mode: string;
  exploration_paused: boolean;
  ambient_lighting: string;
  /** Grid cell size in canvas pixels (`px`). */
  cell_size_px: number;
  /** Tactical distance per grid cell in feet (`ft`). */
  feet_per_cell: number;
  /** Tokens visible to this recipient, keyed by token UUID. */
  tokens: Record<Uuid, WireTokenState>;
  walls: unknown[];
  persistent_aoes: Record<Uuid, unknown>;
  initiative_order: Uuid[];
  active_turn_index: number;
  round: number;
  lights: unknown[];
  fog_overrides: unknown[];
  background_asset_hash: string | null;
  /** Battlemap width in canvas pixels (`px`). */
  map_width_px: number;
  /** Battlemap height in canvas pixels (`px`). */
  map_height_px: number;
  active_reaction_prompts: Record<Uuid, unknown>;
  /** Pending MCP proposals; always empty for non-GM recipients. */
  mcp_staging_proposals: Record<Uuid, McpStagingProposal>;
}

/** Recipient-projected dice roll (`ProjectedDiceRoll` in `dice.rs`). */
export interface ProjectedDiceRoll {
  roll_id: Uuid;
  roller_user_id: Uuid;
  expression: string;
  visibility: WireRollVisibility;
  reason: string;
  /** `true` when a `BlindGm` roll is echoed to its roller with results stripped. */
  blind_masked: boolean;
  terms: unknown[];
  flat_modifier: number;
  /** `null` when `blind_masked`. */
  total: number | null;
  is_critical_success: boolean | null;
  is_critical_failure: boolean | null;
}

/** Handout broadcast payload (`HandoutRevealedBroadcast` in `notes.rs`). */
export interface HandoutRevealedBroadcast {
  event: string;
  handout_id: string;
  title: string;
  content: string;
  revealed_by: string;
  /** UNIX epoch milliseconds. */
  timestamp: number;
}

/** Outbound frames, discriminated by `type` on the client side only. */
export type ClientEnvelope =
  | { type: "SubmitCommand"; command: WireTrameCommand }
  | { type: "RollDice"; expression: string; visibility: WireRollVisibility; reason: string }
  | { type: "PointerPing"; pos: WirePoint2D; colorHex: string }
  | { type: "Ping"; clientTimeMs: number };

/** Inbound frames after external-tag unwrapping. */
export type ServerEnvelope =
  | { type: "StateSnapshot"; seqId: number; state: ProjectedTableState }
  | { type: "CommandAccepted"; seqId: number; events: WireTrameEvent[]; state: ProjectedTableState }
  | { type: "CommandRejected"; reason: string }
  | { type: "DiceRolled"; roll: ProjectedDiceRoll }
  | { type: "PointerPingBroadcast"; senderUserId: Uuid; pos: WirePoint2D; colorHex: string }
  | { type: "Pong"; clientTimeMs: number; serverTimeMs: number }
  | { type: "ActorUpdated"; actorId: Uuid; version: number; data: unknown }
  | { type: "McpStagingProposed"; proposal: McpStagingProposal }
  | { type: "HandoutRevealed"; handout: HandoutRevealedBroadcast };

/** Converts a client envelope into the serde externally tagged map. */
export function toWireClientEnvelope(envelope: ClientEnvelope): Record<string, unknown> {
  switch (envelope.type) {
    case "SubmitCommand":
      return { SubmitCommand: envelope.command };
    case "RollDice":
      return {
        RollDice: {
          expression: envelope.expression,
          visibility: envelope.visibility,
          reason: envelope.reason,
        },
      };
    case "PointerPing":
      return { PointerPing: { pos: envelope.pos, color_hex: envelope.colorHex } };
    case "Ping":
      return { Ping: { client_time_ms: envelope.clientTimeMs } };
  }
}

/** Encodes a client envelope as a MessagePack binary frame. */
export function encodeClientEnvelope(envelope: ClientEnvelope): Uint8Array {
  return encode(toWireClientEnvelope(envelope));
}

const UUID_BYTE_LENGTH = 16;

/** Formats 16 raw bytes as a hyphenated lowercase UUID string. */
export function bytesToUuid(bytes: Uint8Array): Uuid {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeUuids(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return value.length === UUID_BYTE_LENGTH ? bytesToUuid(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeUuids);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeUuids(v);
    }
    return out;
  }
  return value;
}

const decoder = new Decoder({
  mapKeyConverter: (key: unknown): string | number => {
    if (key instanceof Uint8Array && key.length === UUID_BYTE_LENGTH) {
      return bytesToUuid(key);
    }
    if (typeof key === "string" || typeof key === "number") {
      return key;
    }
    throw new TypeError("Unsupported MessagePack map key type");
  },
});

function unwrapExternalTag(raw: unknown): [string, Record<string, unknown>] | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return null;
  const payload = (raw as Record<string, unknown>)[keys[0]];
  if (payload === null || typeof payload !== "object") return null;
  return [keys[0], payload as Record<string, unknown>];
}

/** Converts an already-decoded, UUID-normalized server map into a `ServerEnvelope`. */
export function parseServerEnvelope(raw: unknown): ServerEnvelope | null {
  const tagged = unwrapExternalTag(raw);
  if (!tagged) return null;
  const [tag, p] = tagged;
  switch (tag) {
    case "StateSnapshot":
      return { type: "StateSnapshot", seqId: Number(p.seq_id), state: p.state as ProjectedTableState };
    case "CommandAccepted":
      return {
        type: "CommandAccepted",
        seqId: Number(p.seq_id),
        events: (p.events as WireTrameEvent[]) ?? [],
        state: p.state as ProjectedTableState,
      };
    case "CommandRejected":
      return { type: "CommandRejected", reason: String(p.reason ?? "") };
    case "DiceRolled":
      return { type: "DiceRolled", roll: p as unknown as ProjectedDiceRoll };
    case "PointerPingBroadcast":
      return {
        type: "PointerPingBroadcast",
        senderUserId: String(p.sender_user_id),
        pos: p.pos as WirePoint2D,
        colorHex: String(p.color_hex),
      };
    case "Pong":
      return { type: "Pong", clientTimeMs: Number(p.client_time_ms), serverTimeMs: Number(p.server_time_ms) };
    case "ActorUpdated":
      return { type: "ActorUpdated", actorId: String(p.actor_id), version: Number(p.version), data: p.data };
    case "McpStagingProposed":
      return { type: "McpStagingProposed", proposal: p.proposal as McpStagingProposal };
    case "HandoutRevealed":
      return { type: "HandoutRevealed", handout: p as unknown as HandoutRevealedBroadcast };
    default:
      return null;
  }
}

/** Decodes a binary WebSocket frame; returns `null` for malformed or unknown frames. */
export function decodeServerEnvelope(bytes: Uint8Array): ServerEnvelope | null {
  let raw: unknown;
  try {
    raw = decoder.decode(bytes);
  } catch {
    return null;
  }
  return parseServerEnvelope(normalizeUuids(raw));
}
