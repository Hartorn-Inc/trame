/**
 * ============================================================================
 * REST API & BINARY MESSAGEPACK WEBSOCKET CLIENT (net/wsClient.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Implements the typed REST API helper functions (`apiRegister`, `apiLogin`,
 * `apiFetchMe`, `apiListCampaigns`, `apiCreateCampaign`, `apiGetCampaign`,
 * `apiGenerateStarterMap`, `apiUploadUvttMap`, `apiMintInvite`,
 * `apiRedeemMagicLink`, `apiListNotes`, `apiUpsertNote`, `apiRevealHandout`,
 * `apiUpdateActor`, `apiExportArchive`, `apiImportArchive`) and the binary
 * MessagePack WebSocket client (`TrameWsClient`) decoding `ServerEnvelope`
 * frames into reactive `@preact/signals` state.
 * ============================================================================
 */

import { decode, encode } from '@msgpack/msgpack';
import type { Point2D } from '../engine/wasmBridge.ts';
import {
  activeCampaignSignal,
  activeHandoutModalSignal,
  type AuthUser,
  type CampaignMapRecord,
  type CampaignSummary,
  type HandoutEntryDto,
  type ProjectedDiceRollDto,
  type ProjectedTableStateDto,
  type WikiNoteDto,
  type WireAoeTemplate,
  diceLogSignal,
  lastErrorBannerSignal,
  mapDimensionsSignal,
  mapImageUrlSignal,
  pointerPingsSignal,
  revealedHandoutsSignal,
  tableSeqIdSignal,
  tableStateSignal,
  wsConnectionStateSignal,
  wsRttMsSignal,
} from '../store/signals.ts';

async function parseJsonOrThrow<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) errText = body.error;
    } catch {
      // ignore JSON parse failure
    }
    throw new Error(errText);
  }
  return (await resp.json()) as T;
}

export async function apiFetchMe(): Promise<AuthUser | null> {
  const resp = await fetch('/api/v1/auth/me', { credentials: 'include' });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { user: AuthUser };
  return data.user;
}

export async function apiRegister(email: string, displayName: string, password: string): Promise<AuthUser> {
  const resp = await fetch('/api/v1/auth/register', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, display_name: displayName, password }),
  });
  const data = await parseJsonOrThrow<{ user: AuthUser }>(resp);
  return data.user;
}

export async function apiLogin(email: string, password: string): Promise<AuthUser> {
  const resp = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await parseJsonOrThrow<{ user: AuthUser }>(resp);
  return data.user;
}

export async function apiLogout(): Promise<void> {
  await fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
}

export async function apiRedeemMagicLink(
  token: string,
  nickname?: string,
): Promise<{ user: AuthUser; campaign_id: string; role: string }> {
  const resp = await fetch('/api/v1/auth/magic-link/redeem', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, nickname }),
  });
  return parseJsonOrThrow<{ user: AuthUser; campaign_id: string; role: string }>(resp);
}

export async function apiBindGuestAccount(email: string, password: string): Promise<void> {
  const resp = await fetch('/api/v1/auth/bind-account', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  await parseJsonOrThrow<unknown>(resp);
}

export async function apiListCampaigns(): Promise<CampaignSummary[]> {
  const resp = await fetch('/api/v1/campaigns', { credentials: 'include' });
  const data = await parseJsonOrThrow<{ campaigns: CampaignSummary[] }>(resp);
  return data.campaigns;
}

export async function apiCreateCampaign(name: string, system = 'dnd5e'): Promise<CampaignSummary> {
  const resp = await fetch('/api/v1/campaigns', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, system }),
  });
  const data = await parseJsonOrThrow<{ campaign: CampaignSummary }>(resp);
  return data.campaign;
}

export async function apiGetCampaign(campaignId: string): Promise<CampaignSummary> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}`, { credentials: 'include' });
  const data = await parseJsonOrThrow<{ campaign: CampaignSummary }>(resp);
  return data.campaign;
}

export interface ImportedMapDto {
  image_asset_key: string;
  thumbnail_asset_key: string;
  sha256_hash: string;
  width_px: number;
  height_px: number;
  pixels_per_grid: number;
}

export async function apiPresignAssetUrl(campaignId: string, sha256Hash: string): Promise<string> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/assets/${sha256Hash}/presign`, {
    credentials: 'include',
  });
  const data = await parseJsonOrThrow<{ url: string }>(resp);
  return data.url;
}

export async function apiGenerateStarterMap(campaignId: string): Promise<ImportedMapDto> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/maps/starter`, {
    method: 'POST',
    credentials: 'include',
  });
  const imported = await parseJsonOrThrow<ImportedMapDto>(resp);
  const url = await apiPresignAssetUrl(campaignId, imported.sha256_hash);
  mapDimensionsSignal.value = { width: imported.width_px, height: imported.height_px };
  mapImageUrlSignal.value = url;
  return imported;
}

export async function apiUploadUvttMap(campaignId: string, rawBytes: ArrayBuffer): Promise<ImportedMapDto> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/maps/import-uvtt`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: rawBytes,
  });
  const imported = await parseJsonOrThrow<ImportedMapDto>(resp);
  const url = await apiPresignAssetUrl(campaignId, imported.sha256_hash);
  mapDimensionsSignal.value = { width: imported.width_px, height: imported.height_px };
  mapImageUrlSignal.value = url;
  return imported;
}

export async function apiMintInvite(
  campaignId: string,
  role = 'PLAYER',
): Promise<{ invite_url: string; token: string }> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/invites`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  return parseJsonOrThrow<{ invite_url: string; token: string }>(resp);
}

export async function apiListNotes(
  campaignId: string,
): Promise<{ notes: WikiNoteDto[]; handouts: HandoutEntryDto[] }> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/notes`, { credentials: 'include' });
  return parseJsonOrThrow<{ notes: WikiNoteDto[]; handouts: HandoutEntryDto[] }>(resp);
}

export async function apiUpsertNote(
  campaignId: string,
  slug: string,
  title: string,
  contentMarkdown: string,
  folder?: string,
): Promise<WikiNoteDto> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/notes/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, folder: folder ?? null, content_markdown: contentMarkdown }),
  });
  const data = await parseJsonOrThrow<{ note: WikiNoteDto }>(resp);
  return data.note;
}

export async function apiRevealHandout(
  campaignId: string,
  handoutId: string,
  title: string,
  content: string,
): Promise<void> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/handouts/reveal`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handout_id: handoutId, title, content, session_num: 1 }),
  });
  await parseJsonOrThrow<unknown>(resp);
}

export async function apiUpdateActor(
  campaignId: string,
  actorId: string,
  payload: {
    name: string;
    hp?: number;
    max_hp?: number;
    owner_user_id?: string | null;
    kind?: string;
    gm_core_locked?: boolean;
    attributes?: Record<string, number>;
    sheet?: Record<string, unknown>;
    spawn_on_map?: boolean;
  },
): Promise<void> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/actors/${actorId}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await parseJsonOrThrow<unknown>(resp);
}

export async function apiListMaps(
  campaignId: string,
): Promise<{ maps: CampaignMapRecord[] }> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/maps`, { credentials: 'include' });
  return parseJsonOrThrow<{ maps: CampaignMapRecord[] }>(resp);
}

export async function apiUpsertMap(
  campaignId: string,
  mapId: string,
  payload: {
    name: string;
    sha256_hash?: string;
    width_px?: number;
    height_px?: number;
    pixels_per_grid?: number;
    revealed_to_players?: boolean;
    walls?: Array<Record<string, unknown>>;
    lights?: Array<Record<string, unknown>>;
    push_to_live_table?: boolean;
  },
): Promise<{ status: string; map: CampaignMapRecord }> {
  const resp = await fetch(`/api/v1/campaigns/${campaignId}/maps/${mapId}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow<{ status: string; map: CampaignMapRecord }>(resp);
}

export async function apiImportArchive(zipBytes: ArrayBuffer, remapIds = true): Promise<{ campaign_id: string; name: string }> {
  const resp = await fetch(`/api/v1/campaigns/import?remap_ids=${remapIds ? 'true' : 'false'}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/zip' },
    body: zipBytes,
  });
  return parseJsonOrThrow<{ campaign_id: string; name: string }>(resp);
}

// ============================================================================
// Binary MessagePack WebSocket Client
// ============================================================================

export type TrameCommandPayload =
  | {
      cmd: 'MOVE_TOKEN';
      token_id: string;
      to_top_left: Point2D;
      to_elevation_ft: number | null;
      gm_teleport: boolean;
    }
  | {
      cmd: 'TOGGLE_SQUEEZE';
      token_id: string;
      is_squeezing: boolean;
    }
  | {
      cmd: 'TOGGLE_DOOR';
      wall_id: string;
      is_open: boolean;
    }
  | {
      cmd: 'SET_TABLE_MODE';
      mode: 'EXPLORATION' | 'TURN_BY_TURN';
      exploration_paused: boolean;
      initiative_order: string[];
    }
  | {
      cmd: 'ADVANCE_TURN';
    }
  | {
      cmd: 'APPLY_DAMAGE';
      token_id: string;
      raw_damage: number;
      affinity: 'Normal' | 'Resistant' | 'Vulnerable' | 'Immune';
    }
  | {
      cmd: 'GM_OVERRIDE_TOKEN_RESOURCES';
      token_id: string;
      hp: number | null;
      temp_hp: number | null;
      speed_remaining_ft: number | null;
      has_action: boolean | null;
      has_bonus_action: boolean | null;
      has_reaction: boolean | null;
    }
  | {
      cmd: 'PROJECT_AOE';
      template: WireAoeTemplate;
      persist_zone: boolean;
    }
  | {
      cmd: 'BREAK_CONCENTRATION';
      caster_token_id: string;
    }
  | {
      cmd: 'SET_AMBIENT_LIGHTING';
      preset: 'DAYLIGHT' | 'DUSK' | 'NIGHT_MOONLIGHT' | 'PITCH_DARKNESS';
    }
  | {
      cmd: 'SPAWN_TOKEN';
      token: {
        id: string;
        name: string;
        owner_user_id: string | null;
        top_left: Point2D;
        grid_w: number;
        grid_h: number;
        is_squeezing: boolean;
        elevation_ft: number;
        height_ft: number;
        visibility_channel: number;
        invisible: boolean;
        senses: {
          darkvision_range_ft: number;
          blindsight_range_ft: number;
          tremorsense_range_ft: number;
          truesight_range_ft: number;
          devils_sight_range_ft: number;
        };
        hp: number;
        max_hp: number;
        temp_hp: number;
        speed_max_ft: number;
        speed_remaining_ft: number;
        has_action: boolean;
        has_bonus_action: boolean;
        has_reaction: boolean;
        concentrating_on_aoe_id: string | null;
        active_effects: Array<Record<string, unknown>>;
      };
    }
  | {
      cmd: 'REMOVE_TOKEN';
      token_id: string;
    }
  | {
      cmd: 'SET_TOKEN_VISIBILITY';
      token_id: string;
      gm_hidden: boolean;
      invisible: boolean;
    }
  | {
      cmd: 'ASSIGN_TOKEN_OWNER';
      token_id: string;
      owner_user_id: string | null;
    }
  | {
      cmd: 'CONFIGURE_DOOR';
      wall_id: string;
      is_open: boolean | null;
      is_locked: boolean | null;
      is_secret: boolean | null;
    }
  | {
      cmd: 'UNDO_LAST_ACTION';
    };

export function buildDefaultSpawnTokenPayload(params: {
  id: string;
  name: string;
  owner_user_id: string | null;
  top_left: Point2D;
  hp: number;
  max_hp: number;
  visibility_channel?: number;
}): Extract<TrameCommandPayload, { cmd: 'SPAWN_TOKEN' }>['token'] {
  return {
    id: params.id,
    name: params.name,
    owner_user_id: params.owner_user_id,
    top_left: params.top_left,
    grid_w: 1,
    grid_h: 1,
    is_squeezing: false,
    elevation_ft: 0,
    height_ft: 5,
    visibility_channel: params.visibility_channel ?? 1,
    invisible: false,
    senses: {
      darkvision_range_ft: 60,
      blindsight_range_ft: 0,
      tremorsense_range_ft: 0,
      truesight_range_ft: 0,
      devils_sight_range_ft: 0,
    },
    hp: params.hp,
    max_hp: params.max_hp,
    temp_hp: 0,
    speed_max_ft: 30,
    speed_remaining_ft: 30,
    has_action: true,
    has_bonus_action: true,
    has_reaction: true,
    concentrating_on_aoe_id: null,
    active_effects: [],
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.byteLength; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const clean = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function normalizeDecodedMsgpack(val: unknown): unknown {
  if (val instanceof Uint8Array) {
    if (val.byteLength === 16) {
      return bytesToUuid(val);
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(normalizeDecodedMsgpack);
  }
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = normalizeDecodedMsgpack(v);
    }
    return out;
  }
  return val;
}

function prepareForMsgpackEncode(val: unknown): unknown {
  if (typeof val === 'string' && UUID_REGEX.test(val)) {
    return uuidToBytes(val);
  }
  if (Array.isArray(val)) {
    return val.map(prepareForMsgpackEncode);
  }
  if (val !== null && typeof val === 'object' && !(val instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = prepareForMsgpackEncode(v);
    }
    return out;
  }
  return val;
}

export class TrameWsClient {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;

  public connect(campaignId: string, userId: string, role: string): void {
    this.disconnect();
    wsConnectionStateSignal.value = 'connecting';

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const roleParam = role.toLowerCase();
    const url = `${proto}//${window.location.host}/ws/campaigns/${campaignId}?user_id=${encodeURIComponent(userId)}&role=${encodeURIComponent(roleParam)}`;

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      wsConnectionStateSignal.value = 'connected';
      this.sendPing();
      this.pingTimer = window.setInterval(() => this.sendPing(), 10_000);
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      try {
        const rawDecoded = decode(new Uint8Array(ev.data), {
          mapKeyConverter: (key: unknown) => {
            if (typeof key === 'string' || typeof key === 'number') {
              return key;
            }
            if (key instanceof Uint8Array && key.byteLength === 16) {
              return bytesToUuid(key);
            }
            return String(key);
          },
        });
        const decoded = normalizeDecodedMsgpack(rawDecoded) as Record<string, unknown>;
        this.handleServerEnvelope(decoded);
      } catch (err) {
        console.error('Failed to decode MessagePack frame:', err);
      }
    };

    socket.onclose = () => {
      wsConnectionStateSignal.value = 'disconnected';
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    };

    socket.onerror = () => {
      wsConnectionStateSignal.value = 'disconnected';
    };
  }

  public disconnect(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    wsConnectionStateSignal.value = 'disconnected';
  }

  public submitCommand(command: TrameCommandPayload): void {
    this.sendEnvelope({ SubmitCommand: command });
  }

  public rollDice(
    expression: string,
    visibility: 'Public' | 'GmOnly' | 'BlindGm' = 'Public',
    reason = 'Ability Check',
  ): void {
    this.sendEnvelope({
      RollDice: {
        expression,
        visibility,
        reason,
      },
    });
  }

  public sendPointerPing(pos: Point2D, colorHex = '#ffaa00'): void {
    this.sendEnvelope({
      PointerPing: {
        pos,
        color_hex: colorHex,
      },
    });
  }

  public sendPing(): void {
    this.sendEnvelope({
      Ping: {
        client_time_ms: Date.now(),
      },
    });
  }

  private sendEnvelope(envelope: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const packed = encode(prepareForMsgpackEncode(envelope));
    this.ws.send(packed);
  }

  private syncBackgroundAsset(state: ProjectedTableStateDto): void {
    if (state.map_width_px && state.map_height_px && state.map_width_px > 0 && state.map_height_px > 0) {
      mapDimensionsSignal.value = {
        width: state.map_width_px,
        height: state.map_height_px,
      };
    }
    const hash = state.background_asset_hash ?? null;
    const campaignId = activeCampaignSignal.value?.id;
    if (hash && campaignId) {
      void apiPresignAssetUrl(campaignId, hash)
        .then((url) => {
          if (mapImageUrlSignal.value !== url) {
            mapImageUrlSignal.value = url;
          }
        })
        .catch(() => {
          // Ignore presign failure if asset is not cached locally
        });
    }
  }

  private handleServerEnvelope(env: Record<string, unknown>): void {
    if ('StateSnapshot' in env && env.StateSnapshot) {
      const snap = env.StateSnapshot as { seq_id: number; state: ProjectedTableStateDto };
      tableSeqIdSignal.value = snap.seq_id;
      tableStateSignal.value = snap.state;
      this.syncBackgroundAsset(snap.state);
      return;
    }
    if ('CommandAccepted' in env && env.CommandAccepted) {
      const acc = env.CommandAccepted as { seq_id: number; state: ProjectedTableStateDto };
      tableSeqIdSignal.value = acc.seq_id;
      tableStateSignal.value = acc.state;
      lastErrorBannerSignal.value = null;
      this.syncBackgroundAsset(acc.state);
      return;
    }
    if ('CommandRejected' in env && env.CommandRejected) {
      const rej = env.CommandRejected as { reason: string };
      lastErrorBannerSignal.value = rej.reason;
      return;
    }
    if ('DiceRolled' in env && env.DiceRolled) {
      const roll = env.DiceRolled as ProjectedDiceRollDto;
      diceLogSignal.value = [roll, ...diceLogSignal.value].slice(0, 50);
      return;
    }
    if ('PointerPingBroadcast' in env && env.PointerPingBroadcast) {
      const ping = env.PointerPingBroadcast as {
        sender_user_id: string;
        pos: Point2D;
        color_hex: string;
      };
      const item = {
        id: `${Date.now()}-${Math.random()}`,
        sender_user_id: ping.sender_user_id,
        pos: ping.pos,
        color_hex: ping.color_hex,
        timestamp_ms: Date.now(),
      };
      pointerPingsSignal.value = [...pointerPingsSignal.value, item];
      return;
    }
    if ('HandoutRevealed' in env && env.HandoutRevealed) {
      const handout = env.HandoutRevealed as {
        handout_id: string;
        title: string;
        content: string;
        revealed_at_ms: number;
      };
      const entry: HandoutEntryDto = {
        handout_id: handout.handout_id,
        campaign_id: activeCampaignSignal.value?.id ?? '',
        title: handout.title,
        content: handout.content,
        revealed_at: handout.revealed_at_ms,
        revealed_by: 'GM',
      };
      const existing = revealedHandoutsSignal.value.filter(
        (h) => h.handout_id !== entry.handout_id,
      );
      revealedHandoutsSignal.value = [entry, ...existing];
      activeHandoutModalSignal.value = entry;
      return;
    }
    if ('Pong' in env && env.Pong) {
      const pong = env.Pong as { client_time_ms: number; server_time_ms: number };
      wsRttMsSignal.value = Math.max(0, Date.now() - pong.client_time_ms);
    }
  }
}

export const globalWsClient = new TrameWsClient();
