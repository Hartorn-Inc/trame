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
 *    - Dice and pointer-ping logs and command feedback toasts are capped
 *      (`DICE_LOG_LIMIT`, `POINTER_PING_LIMIT`, `COMMAND_FEEDBACK_LIMIT`) so a
 *      long session cannot grow memory unbounded.
 * 3. `Initiative Totals Seeded From State`:
 *    - Every projected state carries `initiative_totals` (visible combatants
 *      only), so a late join or reconnect seeds `initiativeTotals` from it;
 *      `INITIATIVE_UPDATED` events and `Initiative: {name}` dice rolls apply on
 *      top, and the map is cleared when combat ends.
 * ============================================================================
 */
import { signal, type Signal } from "@preact/signals";
import type {
  HandoutRevealedBroadcast,
  McpStagingProposal,
  ProjectedDiceRoll,
  ProjectedTableState,
  ReactionPromptCloseReason,
  Uuid,
  WirePoint2D,
  WireTrameEvent,
} from "./wire.ts";

/** Maximum retained dice log entries. */
export const DICE_LOG_LIMIT = 200;
/** Maximum retained pointer pings (they fade client-side within 1.5 s). */
export const POINTER_PING_LIMIT = 32;

/**
 * Instance-wide account role (ADR-0039), independent of the campaign role:
 * `OWNER` administers accounts, `HOST` and `OWNER` may create campaigns,
 * `MEMBER` joins campaigns through invites only.
 */
export type InstanceRole = "OWNER" | "HOST" | "MEMBER";

/** Authenticated user as returned by `AuthUserDto` (`/api/v1/auth/*`). */
export interface AuthUser {
  id: Uuid;
  email: string;
  displayName: string;
  username: string;
  /** `true` for a legacy guest session without credentials; the lobby shows the bind prompt. */
  isGuest: boolean;
  /** Global role; grants nothing by itself (campaign membership decides). */
  role: string;
  /** Instance-wide role; unknown server values fall back to `MEMBER` (least privilege). */
  instanceRole: InstanceRole;
  /** `true` once TOTP is enabled; account settings recommend it otherwise. */
  totpEnabled: boolean;
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

/**
 * WebSocket lifecycle for the active campaign room (`api/connection.ts`):
 * - `idle`: no campaign opened yet.
 * - `connecting`: first attempt for the opened campaign.
 * - `open`: socket open; the room snapshot arrives first.
 * - `reconnecting`: connection lost; a retry is scheduled or in flight.
 * - `offline`: the browser reports no network; retries resume on `online`.
 * - `signedOut`: the session expired (`401` / close `4401`); no retry.
 * - `forbidden`: no campaign access (`403` / close `1008` / `4403`); no retry.
 * - `closed`: the campaign was left on purpose.
 */
export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "offline"
  | "signedOut"
  | "forbidden"
  | "closed";

/** Backoff progress shown by the connection banner. */
export interface ReconnectInfo {
  /** Failed attempts since the room was last healthy (`0` when connected). */
  attempt: number;
  /** Epoch milliseconds of the next scheduled retry; `null` while a retry is in flight or none is planned. */
  nextRetryAtMs: number | null;
}

/** Maximum command feedback toasts kept on screen; older ones are dropped first. */
export const COMMAND_FEEDBACK_LIMIT = 3;

/** Feedback for a table action that did not reach or was refused by the room. */
export interface CommandFeedback {
  /** Local toast id (unique per client). */
  id: number;
  /** `rejected`: the server answered `CommandRejected`; `notConnected`: nothing was sent. */
  kind: "rejected" | "notConnected";
  /** `TrameCommand` tag (`"MOVE_TOKEN"`, ...) or `"ROLL_DICE"`; `null` when no pending action matched. */
  action: string | null;
  /** Server rejection reason (`rejected` only). */
  reason: string | null;
}

/**
 * Latest persistent actor sheet known to the client, from the REST actor routes
 * or an `ActorUpdated` broadcast (ADR-0037).
 */
export interface ActorRecord {
  /** Optimistic-concurrency version (`>= 1`); stale broadcasts are dropped. */
  version: number;
  /** Sheet payload (`Dnd5eActorData` for D&D 5e campaigns). */
  data: unknown;
  /** Display name; absent when only a broadcast has been seen. */
  name?: string;
  /** Owning player, `null` for GM-owned sheets; absent when only a broadcast has been seen. */
  ownerUserId?: Uuid | null;
}

/** Campaign member (`GET /api/v1/campaigns/{id}/members`). */
export interface CampaignMember {
  userId: Uuid;
  displayName: string;
  /** Campaign role: `"GM"`, `"PLAYER"`, `"SPECTATOR"`. */
  role: string;
}

/** Last reaction prompt closed without a `Pass` (`REACTION_PROMPT_CLOSED`). */
export interface ClosedReactionPrompt {
  promptId: Uuid;
  reason: ReactionPromptCloseReason;
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
  campaigns: Signal<Campaign[]>;
  activeCampaignId: Signal<Uuid | null>;
  connection: Signal<ConnectionStatus>;
  /** Reconnect attempt and next retry time (see `ConnectionStatus`). */
  reconnect: Signal<ReconnectInfo>;
  /** Visible action failure toasts, oldest first, at most `COMMAND_FEEDBACK_LIMIT`. */
  commandFeedback: Signal<CommandFeedback[]>;
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
  /** Initiative totals keyed by token UUID (see invariant 3). */
  initiativeTotals: Signal<Record<Uuid, number>>;
  /** Most recent `REACTION_PROMPT_CLOSED` event, e.g. `UNDONE` after a GM undo. */
  lastClosedPrompt: Signal<ClosedReactionPrompt | null>;
}

/** Creates an isolated set of session signals in their initial state. */
export function createSessionState(): SessionState {
  return {
    status: signal<SessionStatus>("restoring"),
    user: signal<AuthUser | null>(null),
    campaigns: signal<Campaign[]>([]),
    activeCampaignId: signal<Uuid | null>(null),
    connection: signal<ConnectionStatus>("idle"),
    reconnect: signal<ReconnectInfo>({ attempt: 0, nextRetryAtMs: null }),
    commandFeedback: signal<CommandFeedback[]>([]),
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
    initiativeTotals: signal<Record<Uuid, number>>({}),
    lastClosedPrompt: signal<ClosedReactionPrompt | null>(null),
  };
}

/** Application-wide session state. */
export const session = createSessionState();

/** Actor sheet opened by the last token click or actor-list selection (`null` = none). */
export const selectedActorIdSignal = signal<Uuid | null>(null);

/** Token selected on the table canvas; target of move, damage, and heal controls. */
export const selectedTokenIdSignal = signal<Uuid | null>(null);
