/**
 * ============================================================================
 * REST + WEBSOCKET API CLIENT (api/client.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Single gateway between the browser and `trame-server`: cookie-session REST
 * calls under `/api/v1` and the binary MessagePack campaign WebSocket. Every
 * server frame is reconciled into `SessionState` signals so components never
 * talk to the network or hold their own copy of table state.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `No Query Identity (G4)`:
 *    - Identity comes only from the `HttpOnly` session cookie
 *      (`credentials: "include"`). The WebSocket URL carries no `user_id`,
 *      `role`, or token query parameter.
 * 2. `Full-State Reconciliation`:
 *    - `StateSnapshot` and `CommandAccepted` both carry the complete
 *      recipient projection; the client replaces `table` wholesale instead of
 *      replaying events, so a missed or filtered event cannot desync the view.
 *    - A `CommandAccepted` whose `seq_id` is not greater than the applied one
 *      is a duplicate or reordered frame and is ignored.
 * 3. `Versioned Actor Updates (ADR-0037)`:
 *    - `ActorUpdated` is applied only when its `version` is newer than the
 *      stored one, so a late broadcast cannot roll a sheet back.
 * 4. `Authoritative MCP Proposals`:
 *    - `McpStagingProposed` upserts a proposal; every full state replaces the
 *      proposal map from `mcp_staging_proposals`, which drops committed or
 *      rejected proposals.
 * 5. `REST For Sheets, Socket For The Table`:
 *    - Actor sheets are read and written over REST with `expected_version`
 *      (`updateActor`); a stale write surfaces as `ApiError` code
 *      `VERSION_CONFLICT` instead of silently overwriting another edit.
 *    - The scene list is versioned the same way: `getMaps` returns `version`,
 *      `saveMaps` sends it as `expected_version` and returns the new one.
 *    - Sheet rolls use `rollDiceRest`; table-tray rolls use the `RollDice`
 *      socket frame. Both end up in `diceLog` through `DiceRolled`.
 * 6. `Injectable Transport`:
 *    - `fetch` and the socket factory are constructor inputs so the app seam
 *      tests run against a mocked transport.
 * 7. `Reconnect And Resync (RT11)`:
 *    - `ConnectionManager` (`connection.ts`) reconnects with backoff and a
 *      heartbeat. Across a reconnect the stale `table` stays visible under
 *      the connection banner; the first `StateSnapshot` on the new socket
 *      replaces it and resets every derived signal (initiative totals,
 *      events, prompt closures, pings), so nothing from before the drop is
 *      merged into the fresh state.
 * 8. `Every Failed Action Is Reported (RT10 / UA16)`:
 *    - Each `SubmitCommand` / `RollDice` carries a fresh `correlation_id`;
 *      `CommandRejected` is matched back to the action (`PendingCommands`)
 *      and pushed to `commandFeedback`. Submitting while the socket is not
 *      open sends nothing, queues nothing, and pushes `notConnected`.
 *    - When an open socket dies, every action still unanswered becomes a
 *      `maybeLost` notice ("may not have been applied, check the table"):
 *      its answer can never arrive on the next socket.
 * 9. `GM-Only Quarantine Notice (ADR-0040, D4)`:
 *    - `WalEntriesQuarantined` fills `walQuarantine`; the server unicasts it
 *      to Game Masters on every attach while the recovering room lives, so
 *      once the GM dismisses a notice, the same entries are not shown again
 *      for that campaign on reconnect.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `connect(campaignId)`
 * ├── 1. Reset table signals, start the room connection (binary socket on
 * │      `/api/v1/campaigns/{id}/ws`, reconnecting on its own).
 * ├── 2. Each frame -> `decodeServerEnvelope` -> `applyServerEnvelope`.
 * └── 3. `submitCommand` / `rollDice` / `sendPointerPing` / `ping` encode
 *        externally tagged `ClientEnvelope`s while the socket is open.
 * ============================================================================
 */
import {
  decodeServerEnvelope,
  encodeClientEnvelope,
  type ClientEnvelope,
  type HandoutRevealedBroadcast,
  type ProjectedDiceRoll,
  type ProjectedTableState,
  type ReactionPromptCloseReason,
  type ServerEnvelope,
  type Uuid,
  type WirePoint2D,
  type WireRollVisibility,
  type WireTrameCommand,
  type WireTrameEvent,
} from "./wire.ts";
import {
  COMMAND_FEEDBACK_LIMIT,
  DICE_LOG_LIMIT,
  POINTER_PING_LIMIT,
  session as defaultSession,
  type AuthUser,
  type Campaign,
  type InstanceRole,
  type CampaignMember,
  type CommandFeedback,
  type SessionState,
} from "./session.ts";
import { ConnectionManager, type AccessProbeResult, type NetworkWatcher, type SocketLike } from "./connection.ts";
import { PendingCommands, newCorrelationId } from "./pendingCommands.ts";

export type { SocketLike } from "./connection.ts";

/** `CommandFeedback.action` for table dice rolls (`RollDice` is not a `TrameCommand`). */
export const ROLL_DICE_ACTION = "ROLL_DICE";

/** Network seam: REST `fetch` and the WebSocket factory. */
export interface Transport {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Opens a WebSocket offering the subprotocols `protocols` (`trame.v1+deflate`, D24). */
  openSocket(url: string, protocols: string[]): SocketLike;
}

/** Construction options for `ApiClient`. */
export interface ApiClientOptions {
  /** Network seam; defaults to the browser `fetch` and `WebSocket`. */
  transport?: Transport;
  /** Signals to write; defaults to the app-wide `session`. */
  state?: SessionState;
  /** REST origin prefix; empty string means same origin (Vite proxy in dev). */
  baseUrl?: string;
  /** WebSocket origin (`ws(s)://host`); defaults to the page origin. */
  wsOrigin?: string;
  /** Connectivity hints for reconnects; defaults to the browser's `online`/`offline`/visibility. */
  network?: NetworkWatcher;
  /** Uniform random source in `[0, 1)` for reconnect jitter; defaults to `Math.random`. */
  random?: () => number;
}

/** REST failure carrying the HTTP status and the server's `{ code, error }` body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** Full error body, e.g. `current_version` on `409 VERSION_CONFLICT`. */
  readonly body: Record<string, unknown>;

  constructor(status: number, code: string | null, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Server error code for a stale `expected_version` on `PUT .../actors/{id}`. */
export const VERSION_CONFLICT = "VERSION_CONFLICT";

/** Actor sheet as returned by the actor routes (`ActorDto`). */
export interface CampaignActor {
  id: Uuid;
  campaignId: Uuid;
  /** Owning player; `null` for GM-owned NPC sheets. */
  ownerUserId: Uuid | null;
  name: string;
  /** Optimistic-concurrency version (`>= 1`). */
  version: number;
  /** Sheet payload (`Dnd5eActorData` for D&D 5e campaigns). */
  data: unknown;
}

/** Body of `POST /api/v1/campaigns/{id}/actors`. */
export interface CreateActorInput {
  /** Client-chosen actor UUID (the sheet id); the server generates one otherwise. */
  id?: Uuid;
  name: string;
  /** Owner (honored for GMs only; players always own what they create). */
  ownerUserId?: Uuid | null;
  data: unknown;
}

/** Body of `PUT /api/v1/campaigns/{id}/actors/{actorId}` (ADR-0037). */
export interface UpdateActorInput {
  /** Version the client last read; a stale value yields `409 VERSION_CONFLICT`. */
  expectedVersion: number;
  name?: string;
  /** Full replacement sheet payload. */
  data: unknown;
}

/** Content-addressed upload result (`POST /api/v1/campaigns/{id}/assets`). */
export interface UploadedAsset {
  /** SHA-256 hex digest of the stored WebP. */
  hash: string;
  /** Stable object key; persist this, not `url`. */
  key: string;
  /** Presigned download URL, valid for `expiresInSecs` seconds. */
  url: string;
  expiresInSecs: number;
}

/** Campaign scenes with their list version (`GET /api/v1/campaigns/{id}/maps`). */
export interface CampaignMaps {
  /** Scenes in backend (snake_case) shape. */
  scenes: Record<string, unknown>[];
  /** Optimistic-concurrency version of the whole scene list; send it back as `expected_version`. */
  version: number;
}

/** Note as returned by the note routes (`NoteDto`), content filtered for the caller's role. */
export interface CampaignNote {
  /** URL-safe key (`[A-Za-z0-9_-]{1,128}`), unique within the campaign. */
  slug: string;
  id: Uuid;
  title: string;
  contentMarkdown: string;
  /** Lowest role able to read the note. */
  minRole: "PLAYER" | "GM";
  folder: string | null;
}

/** Body of `PUT /api/v1/campaigns/{id}/notes/{slug}`. */
export interface PutNoteInput {
  title: string;
  contentMarkdown: string;
  folder?: string | null;
  /** Honored for GMs only; players always write `PLAYER` notes. */
  minRole?: "PLAYER" | "GM";
}

/** Revealed handout in the party journal (`GET /api/v1/campaigns/{id}/journal`). */
export interface JournalEntry {
  handoutId: string;
  title: string;
  content: string;
  /** User id of the GM who revealed it. */
  revealedBy: string;
  /** UNIX epoch milliseconds. */
  revealedAt: number;
}

/** Credentials for `POST /api/v1/auth/register`. */
export interface RegisterInput {
  email: string;
  /** 2-100 characters. */
  displayName: string;
  password: string;
}

/** Credentials for `POST /api/v1/auth/login`. */
export interface LoginInput {
  email: string;
  password: string;
  /** 6-digit TOTP code, required when MFA is enabled. */
  totpCode?: string;
}

/** `POST /api/v1/auth/login` code: the account has TOTP on and the request carried no `totp_code`. */
export const MFA_REQUIRED = "MFA_REQUIRED";
/** `POST /api/v1/auth/login` code: the `totp_code` is wrong or expired. */
export const INVALID_TOTP_CODE = "INVALID_TOTP_CODE";

/** Pending TOTP enrollment returned by `POST /api/v1/auth/totp/setup`. */
export interface TotpEnrollment {
  /** Base32 shared secret for manual entry in an authenticator app. */
  secret: string;
  /** `otpauth://totp/...` URI (issuer, account, 6 digits, 30 s period). */
  otpauthUrl: string;
}

/** Public instance facts (`GET /api/v1/instance`). */
export interface InstanceInfo {
  /** `POST /api/v1/auth/register` is accepted (only under `TRAME_ENV=dev`). */
  registrationOpen: boolean;
  /** An `Owner` has claimed the instance. */
  ownerClaimed: boolean;
}

/** Setup token state: `invalid` covers unknown, used, and replaced tokens. */
export type SetupTokenStatus = "valid" | "expired" | "invalid";

/** Result of `POST /api/v1/instance/bootstrap/status`. */
export interface SetupTokenCheck {
  status: SetupTokenStatus;
  /** `TRAME_BOOTSTRAP_OWNER_EMAIL` when the token is valid and an email is locked. */
  lockedEmail: string | null;
}

/** Body of `POST /api/v1/instance/bootstrap` (claims the instance as its `Owner`). */
export interface OwnerBootstrapInput {
  /** Raw setup token from the logged setup URL. */
  token: string;
  email: string;
  /** Verified for an existing account, hashed for a new one. */
  password: string;
  /** 2-100 characters; ignored when the email already has an account. */
  displayName: string;
}

/** Result of `POST /api/v1/auth/password-reset/status`; `invalid` covers unknown, used, and replaced links. */
export interface PasswordResetCheck {
  status: SetupTokenStatus;
  /** Email of the account the link resets; only present while `valid`. */
  email: string | null;
}

/** One-time password reset link minted by the `Owner` (`POST /api/v1/instance/users/{id}/password-reset`). */
export interface PasswordResetLink {
  /** `{TRAME_PUBLIC_ORIGIN}/reset-password?token={token}`; shown once, never stored in clear. */
  resetUrl: string;
  /** UNIX epoch seconds (24 h after minting). */
  expiresAt: number;
}

/** Body of `POST /api/v1/auth/password` (signed-in password change). */
export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  /** 6-digit code; required when the account has TOTP enabled. */
  totpCode?: string;
}

/** One account in the Owner-only list (`GET /api/v1/instance/users`). */
export interface InstanceUser {
  id: Uuid;
  email: string;
  displayName: string;
  instanceRole: InstanceRole;
  /** Legacy guest account with no credentials bound yet. */
  isGuest: boolean;
  totpEnabled: boolean;
  /** Creation time, UNIX epoch seconds. */
  createdAt: number;
}

/** `CampaignInvite` state at read time. */
export type InviteStatus = "active" | "revoked" | "expired" | "exhausted";

/** Options for `POST /api/v1/campaigns/{id}/invites` (GM of that campaign only). */
export interface CreateInviteInput {
  /** Lifetime in seconds; the server clamps it to `1..=604800` (7 days) and defaults to 7 days. */
  ttlSeconds?: number;
  /** Redemptions allowed, `1..=100`; the server defaults to 8. */
  maxUses?: number;
}

/** `CampaignInvite` as returned to the Game Master. */
export interface CampaignInvite {
  id: Uuid;
  campaignId: Uuid;
  /** `{TRAME_PUBLIC_ORIGIN}/?invite={token}`; only present right after creation. */
  inviteUrl: string | null;
  /** Raw token; only present right after creation (storage keeps its hash). */
  token: string | null;
  /** UNIX epoch seconds. */
  createdAt: number;
  /** UNIX epoch seconds. */
  expiresAt: number;
  maxUses: number;
  useCount: number;
  /** UNIX epoch seconds, or `null` while not revoked. */
  revokedAt: number | null;
  status: InviteStatus;
}

/** One redemption of a campaign's invites (`GET .../invites/redemptions`). */
export interface InviteRedemptionRecord {
  inviteId: Uuid;
  campaignId: Uuid;
  userId: Uuid;
  displayName: string;
  /** UNIX epoch seconds. */
  redeemedAt: number;
}

/** Where an invite leads (`POST /api/v1/invites/preview`), shown before any credential is asked. */
export interface InvitePreview {
  campaignId: Uuid;
  /** `null` when the campaign metadata could not be loaded. */
  campaignName: string | null;
  status: InviteStatus;
  /** UNIX epoch seconds. */
  expiresAt: number;
}

/** New-account credentials for an unauthenticated `InviteRedemption`. */
export interface RedeemInviteAccount {
  email: string;
  password: string;
  /** 2-100 characters. */
  displayName: string;
}

/** Result of `POST /api/v1/invites/redeem`. */
export interface InviteRedemption {
  campaignId: Uuid;
  /** Campaign role after redemption (`PLAYER`, or the existing role). */
  role: string;
  /** The account was already a member; no use was consumed. */
  alreadyMember: boolean;
  /** The redemption created the account (and set the session cookie). */
  accountCreated: boolean;
  user: AuthUser;
}

/** Result of `DELETE /api/v1/campaigns/{id}/members/{userId}`. */
export interface MemberRemoval {
  removed: boolean;
  /** Live table sockets of that user closed by the server (WS close code 4403). */
  disconnectedSessions: number;
}

type Json = Record<string, unknown>;

const INSTANCE_ROLES: readonly InstanceRole[] = ["OWNER", "HOST", "MEMBER"];
const INVITE_STATUSES: readonly InviteStatus[] = ["active", "revoked", "expired", "exhausted"];

function toInstanceRole(raw: unknown): InstanceRole {
  const role = String(raw ?? "").toUpperCase() as InstanceRole;
  return INSTANCE_ROLES.includes(role) ? role : "MEMBER";
}

function toInviteStatus(raw: unknown): InviteStatus {
  const status = String(raw ?? "").toLowerCase() as InviteStatus;
  return INVITE_STATUSES.includes(status) ? status : "revoked";
}

function toAuthUser(raw: Json): AuthUser {
  return {
    id: String(raw.id),
    email: String(raw.email ?? ""),
    displayName: String(raw.display_name ?? raw.username ?? ""),
    username: String(raw.username ?? ""),
    isGuest: Boolean(raw.is_guest),
    role: String(raw.role ?? "PLAYER"),
    instanceRole: toInstanceRole(raw.instance_role),
    totpEnabled: Boolean(raw.totp_enabled),
  };
}

function toInstanceUser(raw: Json): InstanceUser {
  return {
    id: String(raw.id),
    email: String(raw.email ?? ""),
    displayName: String(raw.display_name ?? ""),
    instanceRole: toInstanceRole(raw.instance_role),
    isGuest: Boolean(raw.is_guest),
    totpEnabled: Boolean(raw.totp_enabled),
    createdAt: Number(raw.created_at ?? 0),
  };
}

function toCampaignInvite(raw: Json): CampaignInvite {
  return {
    id: String(raw.id),
    campaignId: String(raw.campaign_id),
    inviteUrl: typeof raw.invite_url === "string" ? raw.invite_url : null,
    token: typeof raw.token === "string" ? raw.token : null,
    createdAt: Number(raw.created_at ?? 0),
    expiresAt: Number(raw.expires_at ?? 0),
    maxUses: Number(raw.max_uses ?? 0),
    useCount: Number(raw.use_count ?? 0),
    revokedAt: typeof raw.revoked_at === "number" ? raw.revoked_at : null,
    status: toInviteStatus(raw.status),
  };
}

function toCampaign(raw: Json): Campaign {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    system: String(raw.system ?? "dnd5e"),
    role: String(raw.role ?? "PLAYER"),
    createdAt: String(raw.created_at ?? ""),
    description: typeof raw.description === "string" ? raw.description : null,
  };
}

function toCampaignActor(raw: Json): CampaignActor {
  return {
    id: String(raw.id),
    campaignId: String(raw.campaign_id ?? ""),
    ownerUserId: typeof raw.owner_user_id === "string" ? raw.owner_user_id : null,
    name: String(raw.name ?? ""),
    version: Number(raw.version ?? 1),
    data: raw.data ?? {},
  };
}

function toCampaignMember(raw: Json): CampaignMember {
  const userId = String(raw.user_id ?? raw.id ?? "");
  return {
    userId,
    displayName: String(raw.display_name ?? raw.username ?? userId),
    role: String(raw.role ?? "PLAYER"),
  };
}

function toCampaignNote(raw: Json): CampaignNote {
  return {
    slug: String(raw.slug),
    id: String(raw.id),
    title: String(raw.title),
    contentMarkdown: String(raw.content_markdown ?? ""),
    minRole: String(raw.min_role).toUpperCase() === "GM" ? "GM" : "PLAYER",
    folder: typeof raw.folder === "string" ? raw.folder : null,
  };
}

function campaignPath(campaignId: Uuid, suffix = ""): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`;
}

function browserTransport(): Transport {
  return {
    fetch: (url, init) => fetch(url, init),
    openSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
  };
}

function defaultWsOrigin(): string {
  if (typeof location === "undefined") return "";
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
}

function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/** REST + WebSocket gateway writing into `SessionState`. */
export class ApiClient {
  readonly state: SessionState;
  /** Invoked for every `HandoutRevealed` frame (wired to the handout modal by `App`). */
  onHandoutRevealed: ((handout: HandoutRevealedBroadcast) => void) | null = null;

  private readonly transport: Transport;
  private readonly baseUrl: string;
  private readonly wsOrigin: string;
  private readonly room: ConnectionManager;
  private readonly pending = new PendingCommands();
  /** Campaign of the room connection, used by the access probe. */
  private roomCampaignId: Uuid | null = null;
  /** `true` from a socket opening until its `StateSnapshot` (invariant 7). */
  private awaitingSnapshot = false;
  private nextFeedbackId = 1;
  /** `{campaignId}:{seq ids}` of the quarantine notice the GM dismissed (invariant 9). */
  private dismissedQuarantineKey: string | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.transport = options.transport ?? browserTransport();
    this.state = options.state ?? defaultSession;
    this.baseUrl = options.baseUrl ?? "";
    this.wsOrigin = options.wsOrigin ?? defaultWsOrigin();
    this.room = new ConnectionManager({
      state: this.state,
      openSocket: (url, protocols) => this.transport.openSocket(url, protocols),
      onFrame: (data) => {
        const bytes = frameBytes(data);
        const envelope = bytes ? decodeServerEnvelope(bytes) : null;
        if (envelope) this.applyServerEnvelope(envelope);
      },
      onOpen: () => {
        this.awaitingSnapshot = true;
        this.pending.clear();
      },
      onSocketLost: () => {
        for (const action of this.pending.drain()) this.pushFeedback({ kind: "maybeLost", action, reason: null });
      },
      probeAccess: () => this.probeRoomAccess(),
      encodePing: (nowMs) => encodeClientEnvelope({ type: "Ping", clientTimeMs: nowMs }),
      network: options.network,
      random: options.random,
    });
  }

  private request(method: string, path: string, body?: unknown): Promise<Json> {
    const init: RequestInit = { method, credentials: "include", headers: {} };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return this.execute(path, init);
  }

  /** Sends a raw (non-JSON) body such as an image or a `.uvtt` file. */
  private requestRaw(method: string, path: string, body: Blob | Uint8Array, contentType: string): Promise<Json> {
    return this.execute(path, {
      method,
      credentials: "include",
      headers: { "Content-Type": contentType },
      body: body as BodyInit,
    });
  }

  private async execute(path: string, init: RequestInit): Promise<Json> {
    const res = await this.transport.fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let payload: Json = {};
    if (text) {
      try {
        payload = JSON.parse(text) as Json;
      } catch {
        payload = { error: text };
      }
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        typeof payload.code === "string" ? payload.code : null,
        typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`,
        payload,
      );
    }
    return payload;
  }

  private storeActor(actor: CampaignActor): void {
    this.state.actors.value = {
      ...this.state.actors.value,
      [actor.id]: { version: actor.version, data: actor.data, name: actor.name, ownerUserId: actor.ownerUserId },
    };
  }

  private setUser(user: AuthUser | null): void {
    this.state.user.value = user;
    this.state.status.value = user ? "authenticated" : "anonymous";
  }

  /** Creates an account and signs in (`POST /api/v1/auth/register`). */
  async register(input: RegisterInput): Promise<AuthUser> {
    const res = await this.request("POST", "/api/v1/auth/register", {
      email: input.email,
      display_name: input.displayName,
      password: input.password,
    });
    const user = toAuthUser(res.user as Json);
    this.setUser(user);
    return user;
  }

  /** Signs in with email and password (`POST /api/v1/auth/login`). */
  async login(input: LoginInput): Promise<AuthUser> {
    const res = await this.request("POST", "/api/v1/auth/login", {
      email: input.email,
      password: input.password,
      ...(input.totpCode ? { totp_code: input.totpCode } : {}),
    });
    const user = toAuthUser(res.user as Json);
    this.setUser(user);
    return user;
  }

  /**
   * Starts TOTP enrollment (`POST /api/v1/auth/totp/setup`). The returned secret is
   * stored as pending and protects nothing until `enableTotp` confirms a code.
   */
  async setupTotp(): Promise<TotpEnrollment> {
    const res = await this.request("POST", "/api/v1/auth/totp/setup");
    return { secret: String(res.secret_base32 ?? res.secret ?? ""), otpauthUrl: String(res.otpauth_url ?? "") };
  }

  /**
   * Confirms enrollment with a 6-digit code from the authenticator
   * (`POST /api/v1/auth/totp/enable`; `401` for a wrong code) and marks the
   * signed-in user as TOTP-enabled.
   */
  async enableTotp(code: string): Promise<void> {
    await this.request("POST", "/api/v1/auth/totp/enable", { code });
    const user = this.state.user.value;
    if (user) this.state.user.value = { ...user, totpEnabled: true };
  }

  /** Ends the session and clears all user-scoped state. */
  async logout(): Promise<void> {
    await this.request("POST", "/api/v1/auth/logout");
    this.disconnect();
    this.state.campaigns.value = [];
    this.state.activeCampaignId.value = null;
    this.setUser(null);
  }

  /**
   * Restores the cookie session (`GET /api/v1/auth/me`).
   * A `401` means "not signed in" and resolves to `null`; other failures throw.
   */
  async restoreSession(): Promise<AuthUser | null> {
    try {
      const res = await this.request("GET", "/api/v1/auth/me");
      const user = toAuthUser(res.user as Json);
      this.setUser(user);
      return user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.setUser(null);
        return null;
      }
      throw err;
    }
  }

  /**
   * Binds email + password to a legacy guest session (`POST /api/v1/auth/bind`),
   * then re-reads `/auth/me` because the bind response carries no `user`.
   */
  async bindGuestAccount(input: { email: string; password: string }): Promise<AuthUser | null> {
    await this.request("POST", "/api/v1/auth/bind", { email: input.email, password: input.password });
    return this.restoreSession();
  }

  /** Reads the public registration mode and whether an `Owner` exists (`GET /api/v1/instance`). */
  async getInstanceInfo(): Promise<InstanceInfo> {
    const res = await this.request("GET", "/api/v1/instance");
    return { registrationOpen: Boolean(res.registration_open), ownerClaimed: Boolean(res.owner_claimed) };
  }

  /** Checks a setup token before showing the owner form (`POST /api/v1/instance/bootstrap/status`). */
  async getSetupTokenStatus(token: string): Promise<SetupTokenCheck> {
    const res = await this.request("POST", "/api/v1/instance/bootstrap/status", { token });
    const status = String(res.status);
    return {
      status: status === "valid" || status === "expired" ? status : "invalid",
      lockedEmail: typeof res.locked_email === "string" ? res.locked_email : null,
    };
  }

  /** Claims the instance as its `Owner` and signs in (`POST /api/v1/instance/bootstrap`). */
  async bootstrapOwner(input: OwnerBootstrapInput): Promise<AuthUser> {
    const res = await this.request("POST", "/api/v1/instance/bootstrap", {
      token: input.token,
      email: input.email,
      password: input.password,
      display_name: input.displayName,
    });
    const user = toAuthUser(res.user as Json);
    this.setUser(user);
    return user;
  }

  /** Lists every account, oldest first (`GET /api/v1/instance/users`, Owner only). */
  async listInstanceUsers(): Promise<InstanceUser[]> {
    const res = await this.request("GET", "/api/v1/instance/users");
    return ((res.users as Json[]) ?? []).map(toInstanceUser);
  }

  /**
   * Promotes an account to `HOST` or demotes it to `MEMBER`
   * (`PUT /api/v1/instance/users/{id}/role`, Owner only; `409 CANNOT_CHANGE_OWNER` for the Owner).
   */
  async setInstanceRole(userId: Uuid, role: "HOST" | "MEMBER"): Promise<InstanceUser> {
    const res = await this.request("PUT", `/api/v1/instance/users/${encodeURIComponent(userId)}/role`, {
      instance_role: role,
    });
    return toInstanceUser(res.user as Json);
  }

  /**
   * Mints a one-time password reset link for an account
   * (`POST /api/v1/instance/users/{id}/password-reset`, Owner only; `409 GUEST_ACCOUNT` for guests).
   * Minting again replaces the previous link.
   */
  async mintPasswordReset(userId: Uuid): Promise<PasswordResetLink> {
    const res = await this.request("POST", `/api/v1/instance/users/${encodeURIComponent(userId)}/password-reset`);
    return { resetUrl: String(res.reset_url ?? ""), expiresAt: Number(res.expires_at ?? 0) };
  }

  /** Checks a reset token before showing the new-password form (`POST /api/v1/auth/password-reset/status`). */
  async getPasswordResetStatus(token: string): Promise<PasswordResetCheck> {
    const res = await this.request("POST", "/api/v1/auth/password-reset/status", { token });
    const status = String(res.status);
    return {
      status: status === "valid" || status === "expired" ? status : "invalid",
      email: typeof res.email === "string" ? res.email : null,
    };
  }

  /**
   * Sets a new password from a reset link (`POST /api/v1/auth/password-reset`). Every session of the
   * account is revoked and none is issued: the caller signs in with the new password.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.request("POST", "/api/v1/auth/password-reset", { token, new_password: newPassword });
  }

  /**
   * Changes the signed-in user's password (`POST /api/v1/auth/password`). Other sessions are
   * revoked; this one stays signed in.
   */
  async changePassword(input: ChangePasswordInput): Promise<void> {
    await this.request("POST", "/api/v1/auth/password", {
      current_password: input.currentPassword,
      new_password: input.newPassword,
      ...(input.totpCode ? { totp_code: input.totpCode } : {}),
    });
  }

  /** Shows where an invite leads before any credential is asked (`POST /api/v1/invites/preview`). */
  async previewInvite(token: string): Promise<InvitePreview> {
    const res = await this.request("POST", "/api/v1/invites/preview", { token });
    return {
      campaignId: String(res.campaign_id),
      campaignName: typeof res.campaign_name === "string" ? res.campaign_name : null,
      status: toInviteStatus(res.status),
      expiresAt: Number(res.expires_at ?? 0),
    };
  }

  /**
   * `InviteRedemption` (`POST /api/v1/invites/redeem`). Without a session,
   * `account` creates a `Member` account (the server sets the session cookie);
   * with a session, only the membership is added. Either way the returned user
   * becomes `session.user` and the joined campaign becomes active.
   */
  async redeemInvite(token: string, account?: RedeemInviteAccount): Promise<InviteRedemption> {
    const res = await this.request("POST", "/api/v1/invites/redeem", {
      token,
      ...(account ? { email: account.email, password: account.password, display_name: account.displayName } : {}),
    });
    const user = toAuthUser(res.user as Json);
    const campaignId = String(res.campaign_id);
    this.setUser(user);
    this.state.activeCampaignId.value = campaignId;
    return {
      campaignId,
      role: String(res.role ?? "PLAYER"),
      alreadyMember: Boolean(res.already_member),
      accountCreated: Boolean(res.account_created),
      user,
    };
  }

  /** Lists campaigns the caller belongs to (`GET /api/v1/campaigns`). */
  async listCampaigns(): Promise<Campaign[]> {
    const res = await this.request("GET", "/api/v1/campaigns");
    const campaigns = ((res.campaigns as Json[]) ?? []).map(toCampaign);
    this.state.campaigns.value = campaigns;
    return campaigns;
  }

  /** Creates a campaign owned by the caller as GM (`POST /api/v1/campaigns`). */
  async createCampaign(input: { name: string; system?: string; description?: string }): Promise<Campaign> {
    const res = await this.request("POST", "/api/v1/campaigns", input);
    const campaign = toCampaign(res.campaign as Json);
    this.state.campaigns.value = [...this.state.campaigns.value, campaign];
    return campaign;
  }

  /**
   * Mints the campaign's invite link (`POST .../invites`, GM only). Minting
   * revokes the previous link; the URL and token are only returned here.
   */
  async createCampaignInvite(campaignId: Uuid, input: CreateInviteInput = {}): Promise<CampaignInvite> {
    const res = await this.request("POST", campaignPath(campaignId, "/invites"), {
      ...(input.ttlSeconds !== undefined ? { ttl_seconds: input.ttlSeconds } : {}),
      ...(input.maxUses !== undefined ? { max_uses: input.maxUses } : {}),
    });
    return toCampaignInvite(res.invite as Json);
  }

  /** Reads the unrevoked invite, if any, without its URL (`GET .../invites/active`, GM only). */
  async getActiveInvite(campaignId: Uuid): Promise<CampaignInvite | null> {
    const res = await this.request("GET", campaignPath(campaignId, "/invites/active"));
    return res.invite ? toCampaignInvite(res.invite as Json) : null;
  }

  /** Revokes the unrevoked invite (`DELETE .../invites/active`, GM only; `404 NO_ACTIVE_INVITE`). */
  async revokeCampaignInvite(campaignId: Uuid): Promise<CampaignInvite> {
    const res = await this.request("DELETE", campaignPath(campaignId, "/invites/active"));
    return toCampaignInvite(res.invite as Json);
  }

  /** Lists who redeemed the campaign's invites and when (`GET .../invites/redemptions`, GM only). */
  async listInviteRedemptions(campaignId: Uuid): Promise<InviteRedemptionRecord[]> {
    const res = await this.request("GET", campaignPath(campaignId, "/invites/redemptions"));
    return ((res.redemptions as Json[]) ?? []).map((r) => ({
      inviteId: String(r.invite_id),
      campaignId: String(r.campaign_id),
      userId: String(r.user_id),
      displayName: String(r.display_name ?? ""),
      redeemedAt: Number(r.redeemed_at ?? 0),
    }));
  }

  /** Removes a member and closes their live sockets (`DELETE .../members/{userId}`, GM only). */
  async removeCampaignMember(campaignId: Uuid, userId: Uuid): Promise<MemberRemoval> {
    const res = await this.request("DELETE", campaignPath(campaignId, `/members/${encodeURIComponent(userId)}`));
    return { removed: Boolean(res.removed), disconnectedSessions: Number(res.disconnected_sessions ?? 0) };
  }

  /** Lists campaign members (`GET .../members`). */
  async listMembers(campaignId: Uuid): Promise<CampaignMember[]> {
    const res = await this.request("GET", campaignPath(campaignId, "/members"));
    return ((res.members as Json[]) ?? []).map(toCampaignMember);
  }

  /**
   * Lists the actor sheets the caller may read (players see only their own)
   * and replaces `state.actors` with them.
   */
  async listActors(campaignId: Uuid): Promise<CampaignActor[]> {
    const res = await this.request("GET", campaignPath(campaignId, "/actors"));
    const actors = ((res.actors as Json[]) ?? []).map(toCampaignActor);
    this.state.actors.value = Object.fromEntries(
      actors.map((a) => [a.id, { version: a.version, data: a.data, name: a.name, ownerUserId: a.ownerUserId }]),
    );
    return actors;
  }

  /** Reads one actor sheet (`GET .../actors/{id}`) and stores it. */
  async getActor(campaignId: Uuid, actorId: Uuid): Promise<CampaignActor> {
    const res = await this.request("GET", campaignPath(campaignId, `/actors/${encodeURIComponent(actorId)}`));
    const actor = toCampaignActor(res.actor as Json);
    this.storeActor(actor);
    return actor;
  }

  /** Creates an actor sheet (`POST .../actors`) and stores it. */
  async createActor(campaignId: Uuid, input: CreateActorInput): Promise<CampaignActor> {
    const res = await this.request("POST", campaignPath(campaignId, "/actors"), {
      ...(input.id ? { id: input.id } : {}),
      name: input.name,
      ...(input.ownerUserId !== undefined ? { owner_user_id: input.ownerUserId } : {}),
      data: input.data,
    });
    const actor = toCampaignActor(res.actor as Json);
    this.storeActor(actor);
    return actor;
  }

  /**
   * Replaces an actor sheet with optimistic concurrency (`PUT .../actors/{id}`).
   * A stale `expectedVersion` rejects with `ApiError` code `VERSION_CONFLICT`
   * and `body.current_version`; nothing is stored in that case.
   */
  async updateActor(campaignId: Uuid, actorId: Uuid, input: UpdateActorInput): Promise<CampaignActor> {
    const res = await this.request("PUT", campaignPath(campaignId, `/actors/${encodeURIComponent(actorId)}`), {
      expected_version: input.expectedVersion,
      ...(input.name !== undefined ? { name: input.name } : {}),
      data: input.data,
    });
    const actor = toCampaignActor(res.actor as Json);
    this.storeActor(actor);
    return actor;
  }

  /** Deletes an actor sheet (`DELETE .../actors/{id}`). */
  async deleteActor(campaignId: Uuid, actorId: Uuid): Promise<void> {
    await this.request("DELETE", campaignPath(campaignId, `/actors/${encodeURIComponent(actorId)}`));
    const { [actorId]: _removed, ...rest } = this.state.actors.value;
    this.state.actors.value = rest;
  }

  /**
   * Rolls dice over REST (`POST .../dice/roll`); used by sheet widgets so a roll
   * works whether or not the room socket is open. The server also fans the
   * roll out to the live table, which appends it to `diceLog` via `DiceRolled`.
   */
  async rollDiceRest(
    campaignId: Uuid,
    expression: string,
    options: { visibility?: WireRollVisibility; reason?: string } = {},
  ): Promise<ProjectedDiceRoll> {
    const res = await this.request("POST", campaignPath(campaignId, "/dice/roll"), {
      expression,
      ...(options.visibility ? { visibility: options.visibility } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
    return res.roll as ProjectedDiceRoll;
  }

  /** Reads campaign settings (`GET .../settings`). */
  async getSettings(campaignId: Uuid): Promise<{ mcpStagingMode: boolean }> {
    const res = await this.request("GET", campaignPath(campaignId, "/settings"));
    return { mcpStagingMode: Boolean(res.mcp_staging_mode) };
  }

  /** Writes campaign settings (`PUT .../settings`, GM only). */
  async putSettings(campaignId: Uuid, settings: { mcpStagingMode: boolean }): Promise<{ mcpStagingMode: boolean }> {
    const res = await this.request("PUT", campaignPath(campaignId, "/settings"), {
      mcp_staging_mode: settings.mcpStagingMode,
    });
    return { mcpStagingMode: Boolean(res.mcp_staging_mode) };
  }

  /** Uploads a raw image (`POST .../assets`); the server transcodes it to WebP. */
  async uploadAsset(campaignId: Uuid, file: Blob | Uint8Array, contentType: string): Promise<UploadedAsset> {
    const res = await this.requestRaw("POST", campaignPath(campaignId, "/assets"), file, contentType);
    return {
      hash: String(res.hash),
      key: String(res.key),
      url: String(res.url),
      expiresInSecs: Number(res.expires_in_secs ?? 0),
    };
  }

  /** Mints a fresh presigned download URL for a stored asset hash. */
  async presignAsset(campaignId: Uuid, hash: string): Promise<string> {
    const res = await this.request("GET", campaignPath(campaignId, `/assets/${encodeURIComponent(hash)}/presign`));
    return String(res.url);
  }

  /** Reads the campaign scenes in backend shape and their list version (`GET .../maps`, role-filtered). */
  async getMaps(campaignId: Uuid): Promise<CampaignMaps> {
    const res = await this.request("GET", campaignPath(campaignId, "/maps"));
    return { scenes: (res.scenes as Json[]) ?? [], version: Number(res.version) };
  }

  /**
   * Replaces every campaign scene (`PUT .../maps`, GM only) and returns the new
   * list version. A stale `expectedVersion` rejects with `ApiError` code
   * `VERSION_CONFLICT` and `body.current_version`.
   */
  async saveMaps(campaignId: Uuid, scenes: Record<string, unknown>[], expectedVersion: number): Promise<number> {
    const res = await this.request("PUT", campaignPath(campaignId, "/maps"), { expected_version: expectedVersion, scenes });
    return Number(res.version);
  }

  /**
   * Copies the live table's difficult terrain and fog rulings into the stored scene
   * `sceneId` (`POST .../maps/{sceneId}/table-rulings`, GM only), so the next activation
   * loads them, and returns the new scene-list version. Rejects with `ApiError` code
   * `SCENE_NOT_ACTIVE` when `sceneId` is no longer the table's active scene.
   */
  async saveTableRulings(campaignId: Uuid, sceneId: Uuid): Promise<number> {
    const res = await this.request("POST", campaignPath(campaignId, `/maps/${encodeURIComponent(sceneId)}/table-rulings`));
    return Number(res.version);
  }

  /** Lists the notes the caller may read, content already role-filtered (`GET .../notes`). */
  async listNotes(campaignId: Uuid): Promise<CampaignNote[]> {
    const res = await this.request("GET", campaignPath(campaignId, "/notes"));
    return ((res.notes as Json[]) ?? []).map(toCampaignNote);
  }

  /**
   * Creates or replaces a note (`PUT .../notes/{slug}`). Players may only edit
   * party notes; the server merges their text so GM-only blocks survive.
   */
  async putNote(campaignId: Uuid, slug: string, input: PutNoteInput): Promise<CampaignNote> {
    const res = await this.request("PUT", campaignPath(campaignId, `/notes/${encodeURIComponent(slug)}`), {
      title: input.title,
      content_markdown: input.contentMarkdown,
      folder: input.folder,
      min_role: input.minRole,
    });
    return toCampaignNote(res.note as Json);
  }

  /** Lists revealed handouts, newest first (`GET .../journal`). */
  async listJournal(campaignId: Uuid): Promise<JournalEntry[]> {
    const res = await this.request("GET", campaignPath(campaignId, "/journal"));
    return ((res.entries as Json[]) ?? []).map((e) => ({
      handoutId: String(e.handout_id),
      title: String(e.title),
      content: String(e.content),
      revealedBy: String(e.revealed_by),
      revealedAt: Number(e.revealed_at),
    }));
  }

  /**
   * Reveals a `:::handout{id=...}` block from the campaign notes to the party
   * (`POST .../handouts/{id}/reveal`, GM only). Connected players receive the
   * same payload as a `HandoutRevealed` frame.
   */
  async revealHandout(campaignId: Uuid, handoutId: string): Promise<HandoutRevealedBroadcast> {
    const res = await this.request("POST", campaignPath(campaignId, `/handouts/${encodeURIComponent(handoutId)}/reveal`));
    return res.handout as HandoutRevealedBroadcast;
  }

  /** Imports a `.uvtt` / `.dd2vtt` file as a new scene (`POST .../maps/import`, GM only). */
  async importMap(campaignId: Uuid, file: Blob | Uint8Array, name: string): Promise<Record<string, unknown>> {
    const res = await this.requestRaw(
      "POST",
      campaignPath(campaignId, `/maps/import?name=${encodeURIComponent(name)}`),
      file,
      "application/json",
    );
    return res.scene as Record<string, unknown>;
  }

  /** Opens the campaign room connection (reconnecting on its own), replacing any previous one. */
  connect(campaignId: Uuid): void {
    this.disconnect();
    const s = this.state;
    s.seqId.value = -1;
    s.table.value = null;
    s.lastEvents.value = [];
    s.mcpProposals.value = {};
    s.initiativeTotals.value = {};
    s.lastClosedPrompt.value = null;
    s.commandFeedback.value = [];
    s.walQuarantine.value = [];
    this.roomCampaignId = campaignId;
    this.room.start(`${this.wsOrigin}/api/v1/campaigns/${encodeURIComponent(campaignId)}/ws`);
  }

  /** Closes the room connection for good, if any. */
  disconnect(): void {
    this.room.stop();
    this.roomCampaignId = null;
    this.pending.clear();
  }

  /** Retries the room connection now instead of waiting for the backoff delay. */
  reconnectNow(): void {
    this.room.reconnectNow();
  }

  /**
   * Leaves the expired session for the sign-in screen (connection banner,
   * `signedOut`). The active campaign is kept so signing in returns to it.
   */
  signInAgain(): void {
    this.disconnect();
    this.setUser(null);
  }

  /** Removes one toast from `commandFeedback`. */
  dismissFeedback(id: number): void {
    this.state.commandFeedback.value = this.state.commandFeedback.value.filter((f) => f.id !== id);
  }

  /** Hides the quarantine notice; the same entries stay hidden on reconnect (invariant 9). */
  dismissWalQuarantine(): void {
    this.dismissedQuarantineKey = this.quarantineKey(this.state.walQuarantine.value);
    this.state.walQuarantine.value = [];
  }

  private quarantineKey(entries: { seq_id: number }[]): string {
    return `${this.roomCampaignId}:${entries.map((e) => e.seq_id).join(",")}`;
  }

  /** Classifies a refused room handshake through the member-only campaign route. */
  private async probeRoomAccess(): Promise<AccessProbeResult> {
    if (this.roomCampaignId === null) return "unreachable";
    try {
      await this.request("GET", campaignPath(this.roomCampaignId));
      return "ok";
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return "signedOut";
      if (err instanceof ApiError && err.status === 403) return "forbidden";
      return "unreachable";
    }
  }

  private pushFeedback(feedback: Omit<CommandFeedback, "id">): void {
    this.state.commandFeedback.value = [
      ...this.state.commandFeedback.value,
      { id: this.nextFeedbackId++, ...feedback },
    ].slice(-COMMAND_FEEDBACK_LIMIT);
  }

  private send(envelope: ClientEnvelope): boolean {
    return this.room.send(encodeClientEnvelope(envelope));
  }

  /**
   * Sends a tracked action with a fresh `correlation_id` (invariant 8).
   * Returns `false`, sends nothing, and reports `notConnected` when the socket is not open.
   */
  private sendTracked(action: string, build: (correlationId: string) => ClientEnvelope): boolean {
    const correlationId = newCorrelationId();
    if (!this.send(build(correlationId))) {
      this.pushFeedback({ kind: "notConnected", action, reason: null });
      return false;
    }
    this.pending.add(correlationId, action);
    return true;
  }

  /** Submits an externally tagged `TrameCommand`; `false` when the socket is not open. */
  submitCommand(command: WireTrameCommand): boolean {
    const action = typeof command.cmd === "string" ? command.cmd : "";
    return this.sendTracked(action, (correlationId) => ({ type: "SubmitCommand", command, correlationId }));
  }

  /** Requests a server-side table roll (`RollDice`); `false` when the socket is not open. */
  rollDice(expression: string, visibility: WireRollVisibility, reason: string): boolean {
    return this.sendTracked(ROLL_DICE_ACTION, (correlationId) => ({
      type: "RollDice",
      expression,
      visibility,
      reason,
      correlationId,
    }));
  }

  /**
   * Broadcasts an ephemeral pointer ping at a canvas position (`px`), tagged with the
   * projection's `active_scene_id` so the server drops pings aimed at a scene the table left.
   */
  sendPointerPing(pos: WirePoint2D, colorHex: string): boolean {
    const sceneId = this.state.table.value?.active_scene_id ?? undefined;
    return this.send({ type: "PointerPing", pos, colorHex, ...(sceneId ? { sceneId } : {}) });
  }

  /** Sends an RTT probe; the `Pong` updates `rttMs`. */
  ping(nowMs: number = Date.now()): boolean {
    return this.send({ type: "Ping", clientTimeMs: nowMs });
  }

  /** Reconciles one decoded server frame into `SessionState`. */
  applyServerEnvelope(envelope: ServerEnvelope, nowMs: number = Date.now()): void {
    const s = this.state;
    switch (envelope.type) {
      case "StateSnapshot":
        if (this.awaitingSnapshot) {
          this.awaitingSnapshot = false;
          s.initiativeTotals.value = {};
          s.lastEvents.value = [];
          s.lastClosedPrompt.value = null;
          s.pointerPings.value = [];
          s.lastRejection.value = null;
          this.room.markHealthy();
        }
        s.seqId.value = envelope.seqId;
        s.table.value = envelope.state;
        s.mcpProposals.value = envelope.state.mcp_staging_proposals ?? {};
        this.seedInitiativeTotals(envelope.state);
        return;
      case "CommandAccepted":
        if (envelope.seqId <= s.seqId.value) return;
        s.seqId.value = envelope.seqId;
        s.table.value = envelope.state;
        s.lastEvents.value = envelope.events;
        s.mcpProposals.value = envelope.state.mcp_staging_proposals ?? {};
        s.lastRejection.value = null;
        this.seedInitiativeTotals(envelope.state);
        this.applyEvents(envelope.events);
        return;
      case "CommandRejected":
        s.lastRejection.value = envelope.reason;
        this.pushFeedback({
          kind: "rejected",
          action: this.pending.take(envelope.correlationId, nowMs),
          reason: envelope.reason,
          detail: envelope.detail,
        });
        return;
      case "WalEntriesQuarantined":
        if (this.quarantineKey(envelope.entries) !== this.dismissedQuarantineKey) s.walQuarantine.value = envelope.entries;
        return;
      case "DiceRolled":
        s.diceLog.value = [...s.diceLog.value, envelope.roll].slice(-DICE_LOG_LIMIT);
        this.applyInitiativeRoll(envelope.roll);
        return;
      case "PointerPingBroadcast":
        s.pointerPings.value = [
          ...s.pointerPings.value,
          { senderUserId: envelope.senderUserId, pos: envelope.pos, colorHex: envelope.colorHex, receivedAtMs: nowMs },
        ].slice(-POINTER_PING_LIMIT);
        return;
      case "Pong":
        s.rttMs.value = Math.max(0, nowMs - envelope.clientTimeMs);
        this.pending.resolveSentBefore(envelope.clientTimeMs);
        this.room.notePong();
        return;
      case "ActorUpdated": {
        const known = s.actors.value[envelope.actorId];
        if (known && known.version >= envelope.version) return;
        s.actors.value = {
          ...s.actors.value,
          [envelope.actorId]: { ...known, version: envelope.version, data: envelope.data },
        };
        return;
      }
      case "McpStagingProposed":
        s.mcpProposals.value = {
          ...s.mcpProposals.value,
          [envelope.proposal.proposal_id]: envelope.proposal,
        };
        return;
      case "HandoutRevealed":
        s.lastHandout.value = envelope.handout;
        this.onHandoutRevealed?.(envelope.handout);
        return;
    }
  }

  /**
   * Records the total of a server initiative roll (`Initiative: {token name}`).
   * The roll names the token, not its id, so the first visible token with that
   * name and no recorded total receives it; masked rolls carry no total.
   */
  private applyInitiativeRoll(roll: ProjectedDiceRoll): void {
    const prefix = "Initiative: ";
    const table = this.state.table.value;
    if (!table || roll.total === null || !roll.reason.startsWith(prefix)) return;
    const name = roll.reason.slice(prefix.length);
    const totals = this.state.initiativeTotals.value;
    const candidates = [...Object.values(table.tokens), ...Object.values(table.public_tokens ?? {})];
    const token = candidates.find((tok) => tok.name === name && totals[tok.id] === undefined);
    if (token) this.state.initiativeTotals.value = { ...totals, [token.id]: roll.total };
  }

  /**
   * Overlays the projected state's `initiative_totals` on the known totals, so a
   * late join or reconnect (which starts from `{}` in `connect`) shows the
   * tracker totals without replaying events. Roll-derived totals the server
   * does not know yet are kept; outside combat everything is cleared.
   */
  private seedInitiativeTotals(state: ProjectedTableState): void {
    const s = this.state;
    s.initiativeTotals.value =
      state.mode === "TURN_BY_TURN" ? { ...s.initiativeTotals.value, ...(state.initiative_totals ?? {}) } : {};
  }

  /** Folds the event-only facts (initiative totals, prompt closures) into session signals. */
  private applyEvents(events: WireTrameEvent[]): void {
    const s = this.state;
    for (const ev of events) {
      if (ev.event === "INITIATIVE_UPDATED") {
        s.initiativeTotals.value = { ...((ev.initiative_totals as Record<Uuid, number>) ?? {}) };
      } else if (ev.event === "REACTION_PROMPT_CLOSED") {
        s.lastClosedPrompt.value = {
          promptId: String(ev.prompt_id),
          reason: ev.reason as ReactionPromptCloseReason,
        };
      }
    }
  }
}

/** Application-wide client bound to the browser transport and `session`. */
export const apiClient = new ApiClient();
