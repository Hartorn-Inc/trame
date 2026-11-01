/**
 * ============================================================================
 * CLIENT SESSION & TABLE SYNC STATE (api/session.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Holds every signal written by `ApiClient`: the authenticated user, the
 * campaign list, the WebSocket connection status, and the reconciled table
 * snapshot. Components read these signals; only the client writes them, so
 * the server stays the single source of truth for table state.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Factory, Not Singleton`:
 *    - `createSessionState()` returns fresh signals so each test and each
 *      `ApiClient` instance can own isolated state; the app uses `session`.
 * 2. `Bounded Logs`:
 *    - Dice and pointer-ping logs are capped (`DICE_LOG_LIMIT`,
 *      `POINTER_PING_LIMIT`) so a long session cannot grow memory unbounded.
 * ============================================================================
 */
import { signal, type Signal } from "@preact/signals";
import type {
  HandoutRevealedBroadcast,
  McpStagingProposal,
  ProjectedDiceRoll,
  ProjectedTableState,
  Uuid,
  WirePoint2D,
  WireTrameEvent,
} from "./wire.ts";

/** Maximum retained dice log entries. */
export const DICE_LOG_LIMIT = 200;
/** Maximum retained pointer pings (they fade client-side within 1.5 s). */
export const POINTER_PING_LIMIT = 32;

/** Authenticated user as returned by `AuthUserDto` (`/api/v1/auth/*`). */
export interface AuthUser {
  id: Uuid;
  email: string;
  displayName: string;
  username: string;
  /** `true` for ephemeral users created by an invite redemption. */
  isGuest: boolean;
  /** Global role; grants nothing by itself (campaign membership decides). */
  role: string;
}

/** Campaign summary (`CampaignDto`) with the caller's membership role. */
export interface Campaign {
  id: Uuid;
  name: string;
  system: string;
  /** Caller's campaign role: `"GM"`, `"PLAYER"`, `"SPECTATOR"`, ... */
  role: string;
  createdAt: string;
  description: string | null;
}

/** Boot phase of the app shell. */
export type SessionStatus = "restoring" | "anonymous" | "authenticated";

/** WebSocket lifecycle for the active campaign room. */
export type ConnectionStatus = "idle" | "connecting" | "open" | "closed";

/** Latest persistent actor payload broadcast by `ActorUpdated` (ADR-0037). */
export interface ActorRecord {
  /** Optimistic-concurrency version (`>= 1`); stale broadcasts are dropped. */
  version: number;
  data: unknown;
}

/** Pointer ping broadcast by another session. */
export interface PointerPing {
  senderUserId: Uuid;
  pos: WirePoint2D;
  colorHex: string;
  /** Local receive time in epoch milliseconds. */
  receivedAtMs: number;
}

/** Every signal written by `ApiClient`. */
export interface SessionState {
  status: Signal<SessionStatus>;
  user: Signal<AuthUser | null>;
  /** Error message from a failed `?invite=` redemption, shown on the auth screen. */
  inviteError: Signal<string | null>;
  campaigns: Signal<Campaign[]>;
  activeCampaignId: Signal<Uuid | null>;
  connection: Signal<ConnectionStatus>;
  /** Highest applied WAL sequence number (`-1` before the first snapshot). */
  seqId: Signal<number>;
  table: Signal<ProjectedTableState | null>;
  /** Events of the most recently applied `CommandAccepted`. */
  lastEvents: Signal<WireTrameEvent[]>;
  actors: Signal<Record<Uuid, ActorRecord>>;
  mcpProposals: Signal<Record<Uuid, McpStagingProposal>>;
  lastHandout: Signal<HandoutRevealedBroadcast | null>;
  diceLog: Signal<ProjectedDiceRoll[]>;
  pointerPings: Signal<PointerPing[]>;
  lastRejection: Signal<string | null>;
  /** Last measured WebSocket round-trip time in milliseconds. */
  rttMs: Signal<number | null>;
}

/** Creates an isolated set of session signals in their initial state. */
export function createSessionState(): SessionState {
  return {
    status: signal<SessionStatus>("restoring"),
    user: signal<AuthUser | null>(null),
    inviteError: signal<string | null>(null),
    campaigns: signal<Campaign[]>([]),
    activeCampaignId: signal<Uuid | null>(null),
    connection: signal<ConnectionStatus>("idle"),
    seqId: signal(-1),
    table: signal<ProjectedTableState | null>(null),
    lastEvents: signal<WireTrameEvent[]>([]),
    actors: signal<Record<Uuid, ActorRecord>>({}),
    mcpProposals: signal<Record<Uuid, McpStagingProposal>>({}),
    lastHandout: signal<HandoutRevealedBroadcast | null>(null),
    diceLog: signal<ProjectedDiceRoll[]>([]),
    pointerPings: signal<PointerPing[]>([]),
    lastRejection: signal<string | null>(null),
    rttMs: signal<number | null>(null),
  };
}

/** Application-wide session state. */
export const session = createSessionState();
