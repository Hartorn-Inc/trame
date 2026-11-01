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
 *    - Sheet rolls use `rollDiceRest`; table-tray rolls use the `RollDice`
 *      socket frame. Both end up in `diceLog` through `DiceRolled`.
 * 6. `Injectable Transport`:
 *    - `fetch` and the socket factory are constructor inputs so the app seam
 *      tests run against a mocked transport.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `connect(campaignId)`
 * ├── 1. Reset table signals, open `/api/v1/campaigns/{id}/ws` (binary).
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
  DICE_LOG_LIMIT,
  POINTER_PING_LIMIT,
  session as defaultSession,
  type AuthUser,
  type Campaign,
  type CampaignMember,
  type SessionState,
} from "./session.ts";

/** `WebSocket.OPEN` without depending on a global `WebSocket` in tests. */
const SOCKET_OPEN = 1;

/** Minimal socket surface used by the client (satisfied by `WebSocket`). */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Network seam: REST `fetch` and the WebSocket factory. */
export interface Transport {
  fetch(url: string, init: RequestInit): Promise<Response>;
  openSocket(url: string): SocketLike;
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

/** Result of redeeming an invite (`MagicLinkLoginResponse`). */
export interface InviteRedemption {
  user: AuthUser;
  campaignId: Uuid;
  role: string;
  characterId: Uuid | null;
}

/** Options for `POST /api/v1/campaigns/{id}/invites` (GM of that campaign only). */
export interface CreateInviteInput {
  /** Granted role; the server defaults to `"PLAYER"`. */
  role?: string;
  /** Character pre-assigned to the invited player. */
  characterId?: Uuid;
  /** Invite lifetime in seconds; the server defaults to 7 days. */
  ttlSeconds?: number;
}

/** Minted invite (`CampaignInviteResponse`). */
export interface CampaignInvite {
  inviteUrl: string;
  token: string;
  /** Expiry as UNIX epoch seconds. */
  expiresAt: number;
  campaignId: Uuid;
  role: string;
}

type Json = Record<string, unknown>;

function toAuthUser(raw: Json): AuthUser {
  return {
    id: String(raw.id),
    email: String(raw.email ?? ""),
    displayName: String(raw.display_name ?? raw.username ?? ""),
    username: String(raw.username ?? ""),
    isGuest: Boolean(raw.is_guest),
    role: String(raw.role ?? "PLAYER"),
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

function campaignPath(campaignId: Uuid, suffix = ""): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`;
}

function browserTransport(): Transport {
  return {
    fetch: (url, init) => fetch(url, init),
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
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
  private socket: SocketLike | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.transport = options.transport ?? browserTransport();
    this.state = options.state ?? defaultSession;
    this.baseUrl = options.baseUrl ?? "";
    this.wsOrigin = options.wsOrigin ?? defaultWsOrigin();
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
   * Redeems a `?invite=` token (`GuestSessionUpgrade`). The server reuses an
   * existing session cookie when present, otherwise it creates a guest user.
   */
  async redeemInvite(token: string, nickname?: string): Promise<InviteRedemption> {
    const res = await this.request("POST", "/api/v1/auth/magic-link/redeem", {
      token,
      ...(nickname ? { nickname } : {}),
    });
    const user = toAuthUser(res.user as Json);
    this.setUser(user);
    const campaignId = String(res.campaign_id);
    this.state.activeCampaignId.value = campaignId;
    return {
      user,
      campaignId,
      role: String(res.role ?? "PLAYER"),
      characterId: typeof res.character_id === "string" ? res.character_id : null,
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

  /** Mints an invite link; only the campaign's GM is authorized by the server. */
  async createCampaignInvite(campaignId: Uuid, input: CreateInviteInput = {}): Promise<CampaignInvite> {
    const res = await this.request("POST", `/api/v1/campaigns/${encodeURIComponent(campaignId)}/invites`, {
      ...(input.role ? { role: input.role } : {}),
      ...(input.characterId ? { character_id: input.characterId } : {}),
      ...(input.ttlSeconds ? { ttl_seconds: input.ttlSeconds } : {}),
    });
    return {
      inviteUrl: String(res.invite_url),
      token: String(res.token),
      expiresAt: Number(res.expires_at),
      campaignId: String(res.campaign_id),
      role: String(res.role),
    };
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

  /** Reads the campaign scenes in backend shape (`GET .../maps`, role-filtered). */
  async getMaps(campaignId: Uuid): Promise<Record<string, unknown>[]> {
    const res = await this.execute(campaignPath(campaignId, "/maps"), { method: "GET", credentials: "include" });
    return Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
  }

  /** Replaces every campaign scene (`PUT .../maps`, GM only). */
  async saveMaps(campaignId: Uuid, scenes: Record<string, unknown>[]): Promise<void> {
    await this.request("PUT", campaignPath(campaignId, "/maps"), { scenes });
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

  /** Opens the campaign room socket, replacing any previous connection. */
  connect(campaignId: Uuid): void {
    this.disconnect();
    const s = this.state;
    s.seqId.value = -1;
    s.table.value = null;
    s.lastEvents.value = [];
    s.mcpProposals.value = {};
    s.initiativeTotals.value = {};
    s.lastClosedPrompt.value = null;
    s.connection.value = "connecting";

    const socket = this.transport.openSocket(
      `${this.wsOrigin}/api/v1/campaigns/${encodeURIComponent(campaignId)}/ws`,
    );
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.socket === socket) s.connection.value = "open";
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
        s.connection.value = "closed";
      }
    };
    socket.onmessage = (ev) => {
      const bytes = frameBytes(ev.data);
      const envelope = bytes ? decodeServerEnvelope(bytes) : null;
      if (envelope) this.applyServerEnvelope(envelope);
    };
    this.socket = socket;
  }

  /** Closes the room socket, if any. */
  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.close();
      this.state.connection.value = "closed";
    }
  }

  private send(envelope: ClientEnvelope): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    this.socket.send(encodeClientEnvelope(envelope));
    return true;
  }

  /** Submits an externally tagged `TrameCommand`; `false` when the socket is not open. */
  submitCommand(command: WireTrameCommand): boolean {
    return this.send({ type: "SubmitCommand", command });
  }

  /** Requests a server-side table roll (`RollDice`). */
  rollDice(expression: string, visibility: WireRollVisibility, reason: string): boolean {
    return this.send({ type: "RollDice", expression, visibility, reason });
  }

  /** Broadcasts an ephemeral pointer ping at a canvas position (`px`). */
  sendPointerPing(pos: WirePoint2D, colorHex: string): boolean {
    return this.send({ type: "PointerPing", pos, colorHex });
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
        s.seqId.value = envelope.seqId;
        s.table.value = envelope.state;
        s.mcpProposals.value = envelope.state.mcp_staging_proposals ?? {};
        return;
      case "CommandAccepted":
        if (envelope.seqId <= s.seqId.value) return;
        s.seqId.value = envelope.seqId;
        s.table.value = envelope.state;
        s.lastEvents.value = envelope.events;
        s.mcpProposals.value = envelope.state.mcp_staging_proposals ?? {};
        s.lastRejection.value = null;
        this.applyEvents(envelope.events, envelope.state);
        return;
      case "CommandRejected":
        s.lastRejection.value = envelope.reason;
        return;
      case "DiceRolled":
        s.diceLog.value = [...s.diceLog.value, envelope.roll].slice(-DICE_LOG_LIMIT);
        return;
      case "PointerPingBroadcast":
        s.pointerPings.value = [
          ...s.pointerPings.value,
          { senderUserId: envelope.senderUserId, pos: envelope.pos, colorHex: envelope.colorHex, receivedAtMs: nowMs },
        ].slice(-POINTER_PING_LIMIT);
        return;
      case "Pong":
        s.rttMs.value = Math.max(0, nowMs - envelope.clientTimeMs);
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

  /** Folds the event-only facts (initiative totals, prompt closures) into session signals. */
  private applyEvents(events: WireTrameEvent[], state: ProjectedTableState): void {
    const s = this.state;
    for (const ev of events) {
      if (ev.event === "INITIATIVE_UPDATED") {
        s.initiativeTotals.value = { ...((ev.initiative_totals as Record<Uuid, number>) ?? {}) };
      } else if (ev.event === "TABLE_MODE_CHANGED" && ev.mode === "EXPLORATION") {
        s.initiativeTotals.value = {};
      } else if (ev.event === "REACTION_PROMPT_CLOSED") {
        s.lastClosedPrompt.value = {
          promptId: String(ev.prompt_id),
          reason: ev.reason as ReactionPromptCloseReason,
        };
      }
    }
    if (state.mode !== "TURN_BY_TURN" && Object.keys(s.initiativeTotals.value).length > 0) {
      s.initiativeTotals.value = {};
    }
  }
}

/** Application-wide client bound to the browser transport and `session`. */
export const apiClient = new ApiClient();
