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
 * 2. `Optional Correlation Id (RT10)`:
 *    - `SubmitCommand` adds `correlation_id` as an extra key of the command
 *      map itself (`{ SubmitCommand: { cmd, ..., correlation_id } }`, the
 *      server's `#[serde(flatten)]` `CommandSubmission`); `RollDice` adds it
 *      as a field. Serde ignores unknown keys here, so an older server that
 *      does not know the field still accepts the frame. `CommandRejected`
 *      echoes it back, or omits it when the frame could not be decoded.
 * 3. `UUID Normalization`:
 *    - `rmp_serde` is not human-readable, so `Uuid` values (including
 *      `BTreeMap<Uuid, _>` keys) arrive as 16-byte binaries. Every 16-byte
 *      `Uint8Array` is rewritten to its canonical hyphenated string before the
 *      payload reaches application code. No other 16-byte binary field exists
 *      in `ServerEnvelope`.
 * 4. `Forward-Compatible Decoding`:
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
import type { AoeTemplateDto, GridCell } from "../engine/wasmBridge.ts";

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
 * Internally tagged `TrameCommand` (`{ cmd: "MOVE_TOKEN", token_id, ... }`,
 * `#[serde(tag = "cmd", rename_all = "SCREAMING_SNAKE_CASE")]`). Typed builders
 * live in `table/commands.ts`; the transport only forwards the map inside the
 * externally tagged `SubmitCommand` envelope.
 */
export type WireTrameCommand = Record<string, unknown>;

/** Internally tagged `TrameEvent` (`{ event: "TOKEN_MOVED", ... }`) inside `CommandAccepted.events`. */
export type WireTrameEvent = Record<string, unknown>;

/** Coarse health tier sent for tokens the recipient does not control (`BloodiedState`). */
export type WireBloodiedState = "UNHURT" | "BLOODIED" | "DOWN";

/**
 * Token entry of `ProjectedTableState.tokens` (full `TokenState`, owned or GM)
 * or `public_tokens` (reduced `PublicTokenView`). Vitals and action economy
 * are only present on full tokens.
 */
export interface WireTokenState {
  /** Token UUID; equals its key in `tokens` / `public_tokens`. */
  id: Uuid;
  /** Display name. */
  name?: string;
  /** Controlling user, `null` for GM-controlled NPCs. */
  owner_user_id?: Uuid | null;
  /** Linked persistent actor sheet (ADR-0037), when any. */
  actor_id?: Uuid | null;
  /** Top-left footprint coordinate in canvas pixels (`px`). */
  top_left?: WirePoint2D;
  /** Footprint width in grid cells (`>= 1`). */
  grid_w?: number;
  /** Footprint height in grid cells (`>= 1`). */
  grid_h?: number;
  /** Base elevation in feet (`ft`). */
  elevation_ft?: number;
  /** Stature in feet (`ft`, full tokens only); eye height for vision. */
  height_ft?: number;
  /** Sense ranges (full tokens only); drive the recipient's vision. */
  senses?: WireSenseProfile;
  /** Current hit points (full tokens only). */
  hp?: number;
  /** Maximum hit points (full tokens only). */
  max_hp?: number;
  /** Temporary hit points (full tokens only). */
  temp_hp?: number;
  /** Health tier (public tokens only). */
  bloodied?: WireBloodiedState;
  /** Visible condition labels. */
  conditions?: string[];
  /** GM `ConditionOverride` rulings (full tokens only). */
  condition_overrides?: { subject: "CONDITION" | "EFFECT"; id: string; mode: "FORCE" | "REMOVE" }[];
  /** Concentrating without a zone (`SetConcentration`); omitted when `false`. */
  concentrating?: boolean;
  /** Persistent AoE the token concentrates on, when any. */
  concentrating_on_aoe_id?: Uuid | null;
  /** Death saving throw counters `0..=3` (full tokens only). */
  death_save_successes?: number;
  death_save_failures?: number;
  /** Stable at 0 HP after three successes; omitted when `false`. */
  is_stable?: boolean;
  is_dead?: boolean;
  /** Disengage taken this turn. */
  disengaged?: boolean;
  /** Visibility channel bitmask (`0b100` = hidden from players by the GM). */
  visibility_channel?: number;
  invisible?: boolean;
  /** Walking speed in feet (`ft`, full tokens only; remaining is `0` for non-controllers). */
  speed_max_ft?: number;
  speed_remaining_ft?: number;
  /**
   * Server-validated monster or actor-template stat block copy (full tokens only); the
   * source of the token's HP, AC, speed, senses, reach and damage affinities. Absent for
   * plain and sheet-linked tokens.
   */
  stat_block?: Record<string, unknown>;
  [field: string]: unknown;
}

/** Token sense ranges (`SenseProfile`), all in feet (`ft`). */
export interface WireSenseProfile {
  normal_range_ft: number;
  darkvision_range_ft: number;
  truesight_range_ft: number;
  devils_sight: boolean;
  [field: string]: unknown;
}

/**
 * Wall classification (`WallKind`, tagged by `kind`). Non-GM projections never
 * carry a closed `SECRET_DOOR` or an `ILLUSION`: the server rewrites both to
 * `NORMAL` (`mask_wall_for_player`).
 */
export type WireWallKind =
  | { kind: "NORMAL" }
  | { kind: "WINDOW" }
  | { kind: "TERRAIN" }
  | { kind: "ONE_WAY"; normal_x: number; normal_y: number }
  | { kind: "DOOR"; is_open: boolean; is_locked: boolean }
  | { kind: "SECRET_DOOR"; is_open: boolean }
  | { kind: "ILLUSION"; pierced_by_truesight: boolean };

/** Wall segment (`WallSegment`); endpoints in canvas pixels (`px`), elevations in feet (`ft`). */
export interface WireWallSegment {
  id: Uuid;
  a: WirePoint2D;
  b: WirePoint2D;
  kind: WireWallKind;
  blocks_movement: boolean;
  blocks_vision: boolean;
  blocks_light: boolean;
  blocks_sound: boolean;
  bottom_elevation_ft: number;
  top_elevation_ft: number;
}

/** Point light (`LightSource`); radii in feet (`ft`), `intensity` in `0..=1`. */
export interface WireLightSource {
  id: Uuid;
  /** Emitter position in canvas pixels (`px`). */
  position: WirePoint2D;
  elevation_ft: number;
  bright_radius_ft: number;
  dim_radius_ft: number;
  /** `#RRGGBB`. */
  color_hex: string;
  intensity: number;
}

/** Manual GM fog override on one grid cell (`FogOverrideCell`). */
export interface WireFogOverrideCell {
  cell_x: number;
  cell_y: number;
  mode: "REVEAL" | "HIDE" | "CLEAR";
}

/** Persistent AoE template (`AoeTemplate`); same shape the WASM bridge accepts. */
export type WireAoeTemplate = AoeTemplateDto;

/** Ambient lighting preset (`AmbientLightingPreset`). */
export type WireAmbientLighting = "DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS";

/** `ReactionPromptCloseReason` (engine): why a prompt left `active_reaction_prompts`. */
export type ReactionPromptCloseReason = "RESOLVED" | "STALE" | "UNDONE";

/**
 * Tactical reaction window (`ReactionPrompt`). Prompts never expire on a timer
 * (G2): they stay until `DecideReaction`, `ResolveReaction`, or a close event.
 */
export interface WireReactionPrompt {
  /** Prompt UUID used by `DecideReaction` / `ResolveReaction`. */
  prompt_id: Uuid;
  /** Token allowed to spend its reaction. */
  reactor_actor_id: Uuid;
  /** Token whose movement opened the window. */
  trigger_token_id: Uuid;
  /** User who must decide; `null` means the GM decides. */
  reactor_owner_user_id?: Uuid | null;
  /** `true` after `Trigger`: waiting for `ResolveReaction`. */
  awaiting_resolution?: boolean;
  /** Mover's intended destination (px); `null` for players who cannot see the mover. */
  pending_destination?: WirePoint2D | null;
  /** Reactors already resolved on this trigger; always empty for players. */
  resolved_reactor_ids?: Uuid[];
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
  /** Full tokens the recipient controls (every token for GMs), keyed by token UUID. */
  tokens: Record<Uuid, WireTokenState>;
  /** Reduced views of visible tokens the recipient does not control (always empty for GMs). */
  public_tokens?: Record<Uuid, WireTokenState>;
  walls: WireWallSegment[];
  /** Active AoE zones; `concentration_caster_id` is `null` when the recipient cannot see the caster. */
  persistent_aoes: Record<Uuid, WireAoeTemplate>;
  initiative_order: Uuid[];
  /** Totals keyed by token id, limited to `initiative_order` (no hidden combatant's total). */
  initiative_totals?: Record<Uuid, number>;
  /** Index into `initiative_order`; `null` when the active combatant is hidden or the order is empty. */
  active_turn_index: number | null;
  round: number;
  lights: WireLightSource[];
  fog_overrides: WireFogOverrideCell[];
  /** Difficult terrain cells of the active map (entering one costs double movement). */
  difficult_terrain?: GridCell[];
  background_asset_hash: string | null;
  /** Battlemap width in canvas pixels (`px`). */
  map_width_px: number;
  /** Battlemap height in canvas pixels (`px`). */
  map_height_px: number;
  /**
   * Open reaction prompts. Players only receive the prompts of reactors they own or
   * control, never the prompts their own movement triggered.
   */
  active_reaction_prompts: Record<Uuid, WireReactionPrompt>;
  /** Scene shown on the table (`null` before the first scene); echoed in `PointerPing.sceneId`. */
  active_scene_id?: Uuid | null;
  /** Pending MCP proposals; always empty for non-GM recipients. */
  mcp_staging_proposals: Record<Uuid, McpStagingProposal>;
  /**
   * Server-rolled actions waiting for their Apply (ADR-0042): every one for GMs, only the
   * recipient's own for players, with the d20s and totals of targets they do not control removed.
   */
  pending_resolutions?: Record<Uuid, WirePendingResolution>;
  /** Open Concentration check DCs (oldest first) by token: every token for GMs, controlled ones otherwise. */
  pending_concentration_checks?: Record<Uuid, number[]>;
}

/** Advantage state of a server d20 roll (`RollMode` in `resolution.rs`). */
export type WireRollMode = "NORMAL" | "ADVANTAGE" | "DISADVANTAGE";

/** Cover accepted for a target (`CoverLevel`). */
export type WireCoverLevel = "NONE" | "HALF" | "THREE_QUARTERS" | "TOTAL";

/** How the targets of an action are checked (`ResolutionCheck`, tagged by `kind`). */
export type WireResolutionCheck =
  /** One attack roll per target against its AC; `attack_bonus` in `-10..=30`, `critical_range` in `18..=20`. */
  | { kind: "ATTACK"; attack_bonus: number; critical_range: number }
  /** One save per target against `dc` (`1..=30`); damage rolled once. */
  | { kind: "SAVE"; ability: string; dc: number; half_on_success: boolean }
  /** Every target takes the damage (Magic Missile). */
  | { kind: "AUTOMATIC" };

/** One target of a `RESOLVE_ACTION` request (`ActionTargetRequest`). */
export interface WireActionTargetRequest {
  token_id: Uuid;
  /** Client-computed advantage state; the server ignores it for saves of targets the issuer does not control. */
  roll_mode: WireRollMode;
  cover: WireCoverLevel;
}

/** What the client asks the server to roll (`ActionRequest`). */
export interface WireActionRequest {
  /** Client-chosen UUID; the card follows the `ACTION_RESOLVED` event carrying it. */
  resolution_id: Uuid;
  /** Attacker or caster token (`null`: none on the table, no automatic critical hit). */
  attacker_token_id: Uuid | null;
  /** `1..=120` characters. */
  action_name: string;
  check: WireResolutionCheck;
  /** Dice terms only (`"2d6"`, `"1d8+1d6"`), `""` for none. */
  damage_dice: string;
  /** Flat damage added once (`-20..=50`). */
  damage_modifier: number;
  /** Lowercase SRD damage type, `null` for untyped damage. */
  damage_type: string | null;
  /** Further damage parts with their own type (`0..=3`), rolled like the primary part. */
  extra_damage: WireDamageComponentRequest[];
  /** `1..=32` distinct targets. */
  targets: WireActionTargetRequest[];
}

/** One extra damage part of an action (`DamageComponentRequest`). */
export interface WireDamageComponentRequest {
  /** Dice terms only (`"2d6"`), `""` for flat damage. */
  dice: string;
  /** Flat damage added once (`-20..=50`). */
  modifier: number;
  /** Lowercase SRD damage type, `null` for untyped damage. */
  damage_type: string | null;
}

/** Extra damage part of a pending resolution (`ExtraDamage`). */
export interface WireExtraDamage {
  damage_type: string | null;
  /** Expression rolled before critical doubling (`"2d6"`). */
  expression: string;
}

/** Result of one target (`TargetOutcome`). */
export type WireTargetOutcome = "HIT" | "CRITICAL" | "MISS" | "BLOCKED" | "SAVE_SUCCESS" | "SAVE_FAILURE";

/** Server-rolled result of one target (`ResolvedTarget`). */
export interface WireResolvedTarget {
  token_id: Uuid;
  roll_mode: WireRollMode;
  outcome: WireTargetOutcome;
  /** Natural d20s; empty when nothing was rolled or the recipient may not see them (hidden numbers). */
  d20_rolls: number[];
  /** Attack or save total; `null` when nothing was rolled or hidden from the recipient. */
  total: number | null;
  /** Damage to apply (`>= 0`), after save-for-half and before the target's affinity. */
  damage: number;
  /** Damage of each `extra_damage` part of the resolution, same order (absent or empty: single type). */
  extra_damage?: number[];
  is_critical: boolean;
  /** Already applied (or nothing to apply); never applied twice. */
  applied: boolean;
}

/** Server-held result waiting for `APPLY_RESOLUTION` (`PendingResolution`, ADR-0042). */
export interface WirePendingResolution {
  id: Uuid;
  /** User who requested it; they may apply it as rolled. */
  issuer_user_id: Uuid;
  attacker_token_id: Uuid | null;
  action_name: string;
  check: WireResolutionCheck;
  damage_type: string | null;
  /** Damage expression rolled (`"1d8+3"`; critical hits doubled the dice). */
  damage_expression: string;
  /** Extra damage parts with their own type (absent or empty: single type). */
  extra_damage?: WireExtraDamage[];
  targets: WireResolvedTarget[];
  /** Creation order on the table. */
  sequence: number;
}

/** Game Master changes before applying (`ResolutionAdjustment`); every field optional. */
export interface WireResolutionAdjustment {
  /** New amount (`>= 0`); only with a single target. */
  damage?: number | null;
  /** New damage type; `""` makes the damage untyped. */
  damage_type?: string | null;
  is_critical?: boolean | null;
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

/**
 * Game Master-facing summary of a WAL entry set aside during room recovery
 * (`QuarantinedWalSummary` in `sync.rs`, ADR-0040). Carries no command payload.
 */
export interface QuarantinedWalSummary {
  /** Original WAL sequence number. */
  seq_id: number;
  /** Command label, e.g. `"UNDO_LAST_ACTION"`, `"MOVE_TOKEN"`, `"MCP_STAGING"`, or `"UNDECODABLE"`. */
  command_kind: string;
  /** Replay error, or a note naming the failing `seq_id` for later entries. */
  error: string;
  /** UNIX epoch milliseconds (`ms`) when the entry was quarantined. */
  quarantined_at_ms: number;
}

/**
 * Stable code and numbers of an engine refusal (Rust `RejectionDetail`), so the client
 * explains it in the reader's language instead of showing the English `reason`.
 */
export interface WireRejectionDetail {
  /** One of the engine `COMMAND_ERROR_CODES` (`"WALL_COLLISION"`, ...). */
  code: string;
  /** `INSUFFICIENT_MOVEMENT`: movement the move needed, in feet (`ft`). */
  neededFt: number | null;
  /** `INSUFFICIENT_MOVEMENT`: movement left this turn, in feet (`ft`). */
  remainingFt: number | null;
  /** `CONDITION_IMMUNE`: SRD condition id (`"paralyzed"`). */
  condition: string | null;
}

/** Outbound frames, discriminated by `type` on the client side only. */
export type ClientEnvelope =
  | { type: "SubmitCommand"; command: WireTrameCommand; correlationId?: string }
  | { type: "RollDice"; expression: string; visibility: WireRollVisibility; reason: string; correlationId?: string }
  /**
   * Dropped by the server unless `pos` is finite and on the map, `colorHex` is a palette
   * color, and `sceneId` (when sent) is `active_scene_id`; at most one ping per 250 ms.
   */
  | { type: "PointerPing"; pos: WirePoint2D; colorHex: string; sceneId?: Uuid }
  | { type: "Ping"; clientTimeMs: number };

/** Inbound frames after external-tag unwrapping. */
export type ServerEnvelope =
  | { type: "StateSnapshot"; seqId: number; state: ProjectedTableState }
  | { type: "CommandAccepted"; seqId: number; events: WireTrameEvent[]; state: ProjectedTableState }
  | {
      type: "CommandRejected";
      reason: string;
      /** `null` for server-side refusals (permissions, validation, storage). */
      detail: WireRejectionDetail | null;
      correlationId: string | null;
    }
  | { type: "WalEntriesQuarantined"; entries: QuarantinedWalSummary[] }
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
      return {
        SubmitCommand: envelope.correlationId
          ? { ...envelope.command, correlation_id: envelope.correlationId }
          : envelope.command,
      };
    case "RollDice":
      return {
        RollDice: {
          expression: envelope.expression,
          visibility: envelope.visibility,
          reason: envelope.reason,
          ...(envelope.correlationId ? { correlation_id: envelope.correlationId } : {}),
        },
      };
    case "PointerPing":
      return {
        PointerPing: {
          pos: envelope.pos,
          color_hex: envelope.colorHex,
          ...(envelope.sceneId ? { scene_id: envelope.sceneId } : {}),
        },
      };
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
      return {
        type: "CommandRejected",
        reason: String(p.reason ?? ""),
        detail: decodeRejectionDetail(p.detail),
        correlationId: typeof p.correlation_id === "string" ? p.correlation_id : null,
      };
    case "WalEntriesQuarantined":
      return {
        type: "WalEntriesQuarantined",
        entries: ((p.entries as Record<string, unknown>[] | undefined) ?? []).map((e) => ({
          seq_id: Number(e.seq_id),
          command_kind: String(e.command_kind ?? ""),
          error: String(e.error ?? ""),
          quarantined_at_ms: Number(e.quarantined_at_ms ?? 0),
        })),
      };
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

function decodeRejectionDetail(raw: unknown): WireRejectionDetail | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.code !== "string") return null;
  return {
    code: d.code,
    neededFt: typeof d.needed_ft === "number" ? d.needed_ft : null,
    remainingFt: typeof d.remaining_ft === "number" ? d.remaining_ft : null,
    condition: typeof d.condition === "string" ? d.condition : null,
  };
}
