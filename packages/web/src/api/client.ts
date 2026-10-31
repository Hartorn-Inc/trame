import { decode, encode } from "@msgpack/msgpack";
import { appSignals, mutateActorPosition } from "../state/appSignals.ts";
import type {
  ActorRecord,
  AuthUser,
  Campaign,
  CampaignInviteResponse,
  CampaignRoomState,
  ClientDiceLogEntry,
  ClientEnvelope,
  CreateCampaignInviteRequest,
  CreateCampaignRequest,
  CreatePatRequest,
  CreatePatResponse,
  HandoutRevealedBroadcast,
  ImportArchiveResult,
  LoginRequest,
  MagicLinkLoginResponse,
  NoteDto,
  PartyJournalEntry,
  PatRecord,
  Point2D,
  RawServerEnvelope,
  RegisterRequest,
  RevealHandoutRequest,
  ServerEnvelope,
  SessionTimelineResponse,
  Token,
  TokenMovedEvent,
  TrameCommand,
  TrameEvent,
} from "../types/index.ts";

export function normalizeAuthUser(raw: Record<string, unknown> | null | undefined): AuthUser {
  if (!raw || typeof raw !== "object") {
    return {
      id: "",
      email: "",
      displayName: "Guest",
      username: "Guest",
      role: "PLAYER",
      isGuest: true,
      isEphemeral: true,
    };
  }
  return {
    id: String(raw.id || ""),
    email: String(raw.email || ""),
    displayName: String(raw.displayName ?? raw.display_name ?? raw.username ?? "Guest"),
    username: String(raw.username ?? raw.displayName ?? raw.display_name ?? "Guest"),
    role: String(raw.role || "PLAYER"),
    isGuest: Boolean(raw.isGuest ?? raw.is_guest ?? raw.isEphemeral ?? raw.is_ephemeral ?? false),
    isEphemeral: Boolean(raw.isEphemeral ?? raw.is_ephemeral ?? raw.isGuest ?? raw.is_guest ?? false),
    mfaEnabled: raw.mfaEnabled !== undefined ? Boolean(raw.mfaEnabled) : (raw.mfa_enabled !== undefined ? Boolean(raw.mfa_enabled) : undefined),
  };
}

export function normalizeCampaign(raw: Record<string, unknown> | null | undefined): Campaign {
  if (!raw || typeof raw !== "object") {
    return {
      id: "",
      name: "",
      system: "dnd5e",
      role: "PLAYER",
      createdAt: new Date().toISOString(),
    };
  }
  return {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    system: String(raw.system ?? raw.system_id ?? "dnd5e"),
    role: String(raw.role || "PLAYER"),
    createdAt: String(raw.createdAt ?? raw.created_at ?? new Date().toISOString()),
    description: (raw.description ?? null) as string | null,
    activeMapHash: (raw.activeMapHash ?? raw.active_map_hash ?? null) as string | null,
    actors: Array.isArray(raw.actors) ? (raw.actors as import("../types/index.ts").ActorRecord[]) : undefined,
  };
}

export function normalizeToken(id: string, raw: Record<string, unknown>): Token {
  const rawTopLeft = (raw.topLeft || raw.top_left) as { x?: number; y?: number } | undefined;
  const topLeft = { x: rawTopLeft?.x ?? 0, y: rawTopLeft?.y ?? 0 };
  return {
    id: String(raw.id || id),
    name: String(raw.name || "Token"),
    ownerUserId: (raw.ownerUserId ?? raw.owner_user_id ?? null) as string | null,
    topLeft,
    gridW: Number(raw.gridW ?? raw.grid_w ?? 1),
    gridH: Number(raw.gridH ?? raw.grid_h ?? 1),
    isSqueezing: Boolean(raw.isSqueezing ?? raw.is_squeezing ?? false),
    elevationFt: Number(raw.elevationFt ?? raw.elevation_ft ?? 0),
    heightFt: Number(raw.heightFt ?? raw.height_ft ?? 5),
    visibilityChannel: Number(raw.visibilityChannel ?? raw.visibility_channel ?? 1),
    invisible: Boolean(raw.invisible ?? false),
    hp: Number(raw.hp ?? 20),
    maxHp: Number(raw.maxHp ?? raw.max_hp ?? 20),
    tempHp: Number(raw.tempHp ?? raw.temp_hp ?? 0),
    speedMaxFt: Number(raw.speedMaxFt ?? raw.speed_max_ft ?? 30),
    speedRemainingFt: Number(raw.speedRemainingFt ?? raw.speed_remaining_ft ?? 30),
    hasAction: Boolean(raw.hasAction ?? raw.has_action ?? true),
    hasBonusAction: Boolean(raw.hasBonusAction ?? raw.has_bonus_action ?? true),
    hasReaction: Boolean(raw.hasReaction ?? raw.has_reaction ?? true),
    concentratingOnAoeId: (raw.concentratingOnAoeId ?? raw.concentrating_on_aoe_id ?? null) as string | null,
  };
}

export function normalizeCampaignRoomState(raw: Record<string, unknown> | null | undefined): CampaignRoomState {
  if (!raw || typeof raw !== "object") {
    return {
      campaignId: "",
      mode: "EXPLORATION",
      explorationPaused: false,
      ambientLighting: "DAYLIGHT",
      cellSizePx: 100,
      feetPerCell: 5,
      tokens: {},
      walls: [],
      initiativeOrder: [],
      activeTurnIndex: 0,
      round: 1,
      actors: [],
    };
  }

  const campaignId = String(raw.campaignId || raw.campaign_id || "");
  const mode = String(raw.mode || "EXPLORATION").toUpperCase() === "TURN_BY_TURN" ? "TURN_BY_TURN" : "EXPLORATION";
  const explorationPaused = Boolean(raw.explorationPaused ?? raw.exploration_paused ?? false);
  const ambientLighting = (raw.ambientLighting || raw.ambient_lighting || "DAYLIGHT") as CampaignRoomState["ambientLighting"];
  const cellSizePx = Number(raw.cellSizePx ?? raw.cell_size_px ?? 100);
  const feetPerCell = Number(raw.feetPerCell ?? raw.feet_per_cell ?? 5);
  const initiativeOrder = Array.isArray(raw.initiativeOrder || raw.initiative_order)
    ? (raw.initiativeOrder || raw.initiative_order) as string[]
    : [];
  const activeTurnIndex = Number(raw.activeTurnIndex ?? raw.active_turn_index ?? 0);
  const round = Number(raw.round ?? 1);
  const backgroundAssetHash = (raw.backgroundAssetHash ?? raw.background_asset_hash ?? null) as string | null;
  const mapWidthPx = Number(raw.mapWidthPx ?? raw.map_width_px ?? 1200);
  const mapHeightPx = Number(raw.mapHeightPx ?? raw.map_height_px ?? 800);
  const walls = (Array.isArray(raw.walls) ? raw.walls : []) as CampaignRoomState["walls"];

  const tokens: Record<string, Token> = {};
  if (raw.tokens) {
    if (raw.tokens instanceof Map) {
      for (const [id, tok] of raw.tokens.entries()) {
        tokens[String(id)] = normalizeToken(String(id), tok as Record<string, unknown>);
      }
    } else if (typeof raw.tokens === "object") {
      for (const [id, tok] of Object.entries(raw.tokens as Record<string, unknown>)) {
        tokens[id] = normalizeToken(id, tok as Record<string, unknown>);
      }
    }
  }

  let actors: ActorRecord[] = [];
  if (Array.isArray(raw.actors) && raw.actors.length > 0) {
    actors = (raw.actors as Record<string, unknown>[]).map((a) => ({
      id: String(a.id),
      campaignId: String(a.campaignId || a.campaign_id || campaignId),
      ownerUserId: (a.ownerUserId ?? a.owner_user_id ?? null) as string | null,
      name: String(a.name || "Actor"),
      kind: String(a.kind || "character"),
      hp: Number(a.hp ?? 20),
      maxHp: Number(a.maxHp ?? a.max_hp ?? 20),
      gmCoreLocked: Boolean(a.gmCoreLocked ?? a.gm_core_locked ?? false),
      attributes: (a.attributes || {}) as Record<string, number>,
      sheet: (a.sheet || {}) as Record<string, unknown>,
      position: (a.position || a.topLeft || a.top_left || { x: 0, y: 0 }) as { x: number; y: number },
      topLeft: (a.topLeft || a.top_left || a.position || { x: 0, y: 0 }) as { x: number; y: number },
      elevationFt: Number(a.elevationFt ?? a.elevation_ft ?? 0),
    }));
  } else {
    actors = Object.values(tokens).map((tok) => ({
      id: tok.id,
      campaignId,
      ownerUserId: tok.ownerUserId ?? null,
      name: tok.name,
      kind: "token",
      hp: tok.hp,
      maxHp: tok.maxHp,
      position: { ...tok.topLeft },
      topLeft: { ...tok.topLeft },
      elevationFt: tok.elevationFt,
    }));
  }

  return {
    campaignId,
    mode,
    explorationPaused,
    ambientLighting,
    cellSizePx,
    feetPerCell,
    tokens,
    walls,
    persistentAoes: (raw.persistentAoes || raw.persistent_aoes) as Record<string, unknown> | undefined,
    initiativeOrder,
    activeTurnIndex,
    round,
    backgroundAssetHash,
    mapWidthPx,
    mapHeightPx,
    actors,
  };
}

export function normalizeServerEnvelopeObject(raw: Record<string, unknown>): ServerEnvelope {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid MessagePack server envelope: expected object");
  }

  if (raw.StateSync) {
    const payload = raw.StateSync as Record<string, unknown>;
    return {
      type: "StateSync",
      seqId: Number(payload.seq_id ?? payload.seqId ?? 0),
      state: normalizeCampaignRoomState(payload.state as Record<string, unknown>),
    };
  }
  if (raw.StateSnapshot) {
    const payload = raw.StateSnapshot as Record<string, unknown>;
    return {
      type: "StateSync",
      seqId: Number(payload.seq_id ?? payload.seqId ?? 0),
      state: normalizeCampaignRoomState(payload.state as Record<string, unknown>),
    };
  }
  if (raw.Delta) {
    const payload = raw.Delta as Record<string, unknown>;
    return {
      type: "Delta",
      seqId: Number(payload.seq_id ?? payload.seqId ?? 0),
      events: (payload.events as TrameEvent[]) || [],
      state: payload.state as Partial<CampaignRoomState> | undefined,
    };
  }
  if (raw.CommandAccepted) {
    const payload = raw.CommandAccepted as Record<string, unknown>;
    return {
      type: "Delta",
      seqId: Number(payload.seq_id ?? payload.seqId ?? 0),
      events: (payload.events as TrameEvent[]) || [],
      state: payload.state as Partial<CampaignRoomState> | undefined,
    };
  }
  if (raw.type === "StateSync" || raw.type === "StateSnapshot") {
    return {
      type: "StateSync",
      seqId: Number(raw.seqId ?? raw.seq_id ?? 0),
      state: normalizeCampaignRoomState(raw.state as Record<string, unknown>),
    };
  }
  if (raw.type === "Delta" || raw.type === "CommandAccepted") {
    return {
      type: "Delta",
      seqId: Number(raw.seqId ?? raw.seq_id ?? 0),
      events: (raw.events as TrameEvent[]) || [],
      state: payloadState(raw),
    };
  }
  if (raw.CommandRejected || raw.type === "CommandRejected") {
    const payload = (raw.CommandRejected || raw) as Record<string, unknown>;
    return { type: "CommandRejected", reason: String(payload.reason || "Rejected") };
  }
  if (raw.DiceRolled !== undefined || raw.type === "DiceRolled") {
    return { type: "DiceRolled", roll: raw.DiceRolled ?? raw.roll };
  }
  if (raw.HandoutRevealed || raw.type === "HandoutRevealed") {
    const payload = (raw.HandoutRevealed || raw.handout || raw) as HandoutRevealedBroadcast;
    return { type: "HandoutRevealed", handout: payload };
  }
  if (raw.PointerPingBroadcast || raw.type === "PointerPingBroadcast") {
    const payload = (raw.PointerPingBroadcast || raw) as Record<string, unknown>;
    return {
      type: "PointerPingBroadcast",
      senderUserId: String(payload.sender_user_id || payload.senderUserId || ""),
      pos: (payload.pos || { x: 0, y: 0 }) as { x: number; y: number },
      colorHex: String(payload.color_hex || payload.colorHex || "#ffffff"),
    };
  }
  if (raw.Pong || raw.type === "Pong") {
    const payload = (raw.Pong || raw) as Record<string, unknown>;
    return {
      type: "Pong",
      clientTimeMs: Number(payload.client_time_ms ?? payload.clientTimeMs ?? 0),
      serverTimeMs: Number(payload.server_time_ms ?? payload.serverTimeMs ?? 0),
    };
  }

  return raw as unknown as ServerEnvelope;
}

function payloadState(raw: Record<string, unknown>): Partial<CampaignRoomState> | undefined {
  return raw.state as Partial<CampaignRoomState> | undefined;
}

export function decodeServerEnvelope(bytes: Uint8Array | ArrayBuffer): ServerEnvelope {
  const raw = decode(bytes as unknown as Uint8Array) as Record<string, unknown>;
  return normalizeServerEnvelopeObject(raw);
}

export class ApiClient {
  public baseUrl: string;
  private ws: WebSocket | null = null;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData || init.body instanceof Blob || init.body instanceof ArrayBuffer || init.body instanceof Uint8Array)) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(url, {
      ...init,
      headers,
      credentials: init.credentials ?? "include",
    });
    if (!res.ok) {
      let errorText = `HTTP ${res.status}`;
      try {
        const errJson = await res.json() as Record<string, unknown>;
        if (typeof errJson.error === "string") {
          errorText = errJson.error;
        }
      } catch {
        // fallback to status code
      }
      throw new Error(errorText);
    }
    return (await res.json()) as T;
  }

  public async register(data: RegisterRequest): Promise<AuthUser> {
    const payload = {
      email: data.email,
      display_name: data.displayName ?? (data as unknown as Record<string, unknown>).display_name,
      displayName: data.displayName,
      password: data.password,
    };
    const res = await this.requestJson<Record<string, unknown>>(`${this.baseUrl}/api/v1/auth/register`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const rawUser = (res.user || res) as Record<string, unknown>;
    const normalized = normalizeAuthUser(rawUser);
    appSignals.authUserSignal.value = normalized;
    return normalized;
  }

  public async login(data: LoginRequest): Promise<AuthUser> {
    const res = await this.requestJson<Record<string, unknown>>(`${this.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    const rawUser = (res.user || res) as Record<string, unknown>;
    const normalized = normalizeAuthUser(rawUser);
    appSignals.authUserSignal.value = normalized;
    return normalized;
  }

  public async logout(): Promise<void> {
    await this.requestJson<{ status: string }>(`${this.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
    });
    appSignals.authUserSignal.value = null;
  }

  public async getMe(): Promise<AuthUser> {
    const res = await this.requestJson<Record<string, unknown>>(`${this.baseUrl}/api/v1/auth/me`, {
      method: "GET",
    });
    const rawUser = (res.user || res) as Record<string, unknown>;
    const normalized = normalizeAuthUser(rawUser);
    appSignals.authUserSignal.value = normalized;
    return normalized;
  }

  public async redeemMagicLink(token: string, nickname?: string): Promise<MagicLinkLoginResponse> {
    const raw = await this.requestJson<Record<string, unknown>>(`${this.baseUrl}/api/v1/auth/magic-link/redeem`, {
      method: "POST",
      body: JSON.stringify({ token, nickname }),
    });
    const rawUser = (raw.user || {}) as Record<string, unknown>;
    const user: AuthUser = normalizeAuthUser(rawUser);
    const res: MagicLinkLoginResponse = {
      userId: String(raw.userId ?? raw.user_id ?? user.id),
      username: String(raw.username ?? user.username),
      campaignId: String(raw.campaignId ?? raw.campaign_id ?? ""),
      characterId: (raw.characterId ?? raw.character_id ?? null) as string | null,
      role: String(raw.role ?? user.role),
      sessionId: String(raw.sessionId ?? raw.session_id ?? ""),
      user,
    };
    appSignals.authUserSignal.value = res.user;
    return res;
  }

  public async listCampaigns(): Promise<Campaign[]> {
    const res = await this.requestJson<{ campaigns: Record<string, unknown>[] }>(`${this.baseUrl}/api/v1/campaigns`, {
      method: "GET",
    });
    const normalized = (res.campaigns || []).map((c) => normalizeCampaign(c));
    appSignals.campaignsSignal.value = normalized;
    return normalized;
  }

  public async createCampaign(data: CreateCampaignRequest): Promise<Campaign> {
    const res = await this.requestJson<{ campaign: Record<string, unknown> }>(`${this.baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    const normalized = normalizeCampaign(res.campaign);
    appSignals.campaignsSignal.value = [...appSignals.campaignsSignal.value, normalized];
    return normalized;
  }

  public async getCampaign(campaignId: string): Promise<Campaign> {
    const res = await this.requestJson<{ campaign: Record<string, unknown> }>(`${this.baseUrl}/api/v1/campaigns/${campaignId}`, {
      method: "GET",
    });
    const normalized = normalizeCampaign(res.campaign);
    appSignals.activeCampaignSignal.value = normalized;
    return normalized;
  }

  public async createCampaignInvite(
    campaignId: string,
    req: CreateCampaignInviteRequest = {},
  ): Promise<CampaignInviteResponse> {
    const raw = await this.requestJson<Record<string, unknown>>(`${this.baseUrl}/api/v1/campaigns/${campaignId}/invites`, {
      method: "POST",
      body: JSON.stringify({
        ...req,
        ttl_seconds: req.ttlSeconds,
      }),
    });
    return {
      inviteUrl: String(raw.inviteUrl ?? raw.invite_url ?? ""),
      token: String(raw.token ?? ""),
      expiresAt: Number(raw.expiresAt ?? raw.expires_at ?? 0),
      campaignId: String(raw.campaignId ?? raw.campaign_id ?? campaignId),
      role: String(raw.role ?? req.role ?? "PLAYER"),
    };
  }

  public async loadStarterDungeon(campaignId: string): Promise<unknown> {
    return this.requestJson<unknown>(`${this.baseUrl}/api/v1/campaigns/${campaignId}/maps/starter`, {
      method: "POST",
    });
  }

  public async importUvttMap(
    campaignId: string,
    data: Uint8Array | ArrayBuffer | Blob,
  ): Promise<unknown> {
    const bodyInit: BodyInit = data instanceof Blob ? data : new Blob([data as unknown as BlobPart]);
    const res = await fetch(`${this.baseUrl}/api/v1/campaigns/${campaignId}/maps/import-uvtt`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bodyInit,
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`UVTT upload failed with HTTP ${res.status}`);
    }
    return res.json();
  }

  public async updateActor(
    campaignId: string,
    actorId: string,
    data: Partial<ActorRecord> & { spawnOnMap?: boolean },
  ): Promise<ActorRecord> {
    const res = await this.requestJson<{ actor: ActorRecord }>(
      `${this.baseUrl}/api/v1/campaigns/${campaignId}/actors/${actorId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    );
    return res.actor;
  }

  public async listNotes(
    campaignId: string,
  ): Promise<{ notes: NoteDto[]; handouts: PartyJournalEntry[] }> {
    const res = await this.requestJson<{ notes: NoteDto[]; handouts: PartyJournalEntry[] }>(
      `${this.baseUrl}/api/v1/campaigns/${campaignId}/notes`,
      {\method: "GET" },
    );
    appSignals.notesSignal.value = res.notes;
    return res;
  }

  public async upsertNote(
    campaignId: string,
    slug: string,
    data: { title: string; contentMarkdown: string; folder?: string },
  ): Promise<NoteDto> {
    const res = await this.requestJson<{ note: NoteDto }>(
      `${this.baseUrl}/api/v1/campaigns/${campaignId}/notes/${slug}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    );
    return res.note;
  }

  public async revealHandout(
    campaignId: string,
    data: RevealHandoutRequest,
  ): Promise<HandoutRevealedBroadcast> {
    return this.requestJson<HandoutRevealedBroadcast>(
      `${this.baseUrl}/api/v1/campaigns/${campaignId}/handouts/reveal`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  }

  public async getSessionTimeline(
    campaignId: string,
    sessionNum = 1,
    after = 0,
    limit = 50,
  ): Promise<SessionTimelineResponse> {
    return this.requestJson<SessionTimelineResponse>(
      `${this.baseUrl}/api/v1/campaigns/${campaignId}/sessions/${sessionNum}/timeline?after=${after}&limit=${limit}`,
      { method: "GET" },
    );
  }

  public async exportArchive(campaignId: string, filename?: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/v1/campaigns/${campaignId}/export`, {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`Export failed with HTTP ${res.status}`);
    }
    const blob = await res.blob();
    if (typeof document !== "undefined") {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || `campaign-${campaignId}.trame`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    return blob;
  }

  public async importArchive(
    archiveData: Blob | Uint8Array | ArrayBuffer,
    remapIds = false,
  ): Promise<ImportArchiveResult> {
    const bodyInit: BodyInit = archiveData instanceof Blob ? archiveData : new Blob([archiveData as unknown as BlobPart]);
    const res = await fetch(`${this.baseUrl}/api/v1/campaigns/import?remap_ids=${remapIds}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: bodyInit,
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`Import failed with HTTP ${res.status}`);
    }
    return (await res.json()) as ImportArchiveResult;
  }

  public async createPat(data: CreatePatRequest): Promise<CreatePatResponse> {
    return this.requestJson<CreatePatResponse>(`${this.baseUrl}/api/v1/auth/pat`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  public async listPats(): Promise<PatRecord[]> {
    return this.requestJson<PatRecord[]>(`${this.baseUrl}/api/v1/auth/pat`, {
      method: "GET",
    });
  }

  public connectWebSocket(
    campaignId: string,
    options: { wsUrl?: string; role?: string; token?: string; userId?: string } = {},
  ): WebSocket {
    if (this.ws) {
      this.ws.close();
    }
    const protocol = (typeof window !== "undefined" && window.location.protocol === "https:") ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:4000";
    const wsBase = options.wsUrl || `${protocol}//${host}`;
    const params = new URLSearchParams();
    if (options.role) params.set("role", options.role);
    if (options.userId) params.set("user_id", options.userId);
    if (options.token) params.set("token", options.token);
    const queryStr = params.toString() ? `?${params.toString()}` : "";
    const fullUrl = `${wsBase}/ws/campaigns/${campaignId}${queryStr}`;

    const ws = new WebSocket(fullUrl);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      const buffer = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new Uint8Array((event.data as ArrayBufferView).buffer, (event.data as ArrayBufferView).byteOffset, (event.data as ArrayBufferView).byteLength);
      this.handleServerMessage(buffer);
    };
    this.ws = ws;
    return ws;
  }

  public disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public sendCommand(command: TrameCommand): Uint8Array {
    const envelope: ClientEnvelope = {
      type: "Command",
      command,
      Command: command,
      SubmitCommand: command,
    };
    const buffer = encode(envelope);
    if (this.ws && this.ws.readyState === (typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1)) {
      this.ws.send(buffer);
    }
    return buffer;
  }

  public sendPointerPing(pos: Point2D, colorHex = "#f59e0b"): Uint8Array {
    const envelope: ClientEnvelope = {
      type: "PointerPing",
      pos,
      colorHex,
    };
    const buffer = encode(envelope);
    if (this.ws && this.ws.readyState === (typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1)) {
      this.ws.send(buffer);
    }
    return buffer;
  }

  public handleServerMessage(
    bytesOrEnvelope: Uint8Array | ArrayBuffer | RawServerEnvelope,
  ):
    ServerEnvelope {
    const envelope: ServerEnvelope = bytesOrEnvelope instanceof Uint8Array || bytesOrEnvelope instanceof ArrayBuffer
      ? decodeServerEnvelope(bytesOrEnvelope)
      : normalizeServerEnvelopeObject(bytesOrEnvelope as Record<string, unknown>);

    if (envelope.type === "StateSync") {
      appSignals.tableStateSignal.value = envelope.state;
      appSignals.actorsSignal.value = envelope.state.actors || [];
    } else if (envelope.type === "Delta") {
      for (const ev of envelope.events || []) {
        const evType = String((ev as Record<string, unknown>).event || (ev as Record<string, unknown>).type || "").toUpperCase();
        if (evType === "TOKEN_MOVED" || evType === "TOKENMOVED") {
          const moved = ev as TokenMovedEvent;
          const tokenId = String(moved.token_id || moved.tokenId || (ev as Record<string, unknown>).target_id || "");
          const rawPos = (moved.to_top_left || moved.toTopLeft || (ev as Record<string, unknown>).position || (ev as Record<string, unknown>).newPos) as { x?: number; y?: number } | undefined;
          const toPos = rawPos ? { x: Number(rawPos.x || 0), y: Number(rawPos.y || 0) } : undefined;
          const elevationFt = moved.elevation_ft ?? moved.elevationFt;
          const speedRemainingFt = moved.speed_remaining_ft ?? moved.speedRemainingFt;
          if (tokenId && toPos) {
            mutateActorPosition(tokenId, toPos, elevationFt, speedRemainingFt);
          }
        }
      }
    } else if (envelope.type === "DiceRolled") {
      if (envelope.roll) {
        appSignals.diceLogSignal.value = [
          ...appSignals.diceLogSignal.value,
          envelope.roll as ClientDiceLogEntry,
        ];
      }
    } else if (envelope.type === "HandoutRevealed") {
      appSignals.revealedHandoutSignal.value = envelope.handout;
    }

    return envelope;
  }
}

export const client = new ApiClient();
export const apiClient = client;
export const sendCommand = (cmd: TrameCommand): Uint8Array => client.sendCommand(cmd);
export const sendPointerPing = (pos: Point2D, colorHex = "#f59e0b"): Uint8Array => client.sendPointerPing(pos, colorHex);
export const handleServerMessage = (
  msg: Uint8Array | ArrayBuffer | RawServerEnvelope,
): ServerEnvelope => client.handleServerMessage(msg);
export const exportArchive = (campaignId: string, filename?: string): Promise<Blob> =>
  client.exportArchive(campaignId, filename);
