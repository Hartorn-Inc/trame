export interface Point2D {
  x: number;
  y: number;
}

export interface Token {
  id: string;
  name: string;
  ownerUserId?: string | null;
  topLeft: Point2D;
  gridW: number;
  gridH: number;
  isSqueezing: boolean;
  elevationFt: number;
  heightFt: number;
  visibilityChannel: number;
  invisible: boolean;
  hp: number;
  maxHp: number;
  tempHp: number;
  speedMaxFt: number;
  speedRemainingFt: number;
  hasAction: boolean;
  hasBonusAction: boolean;
  hasReaction: boolean;
  concentratingOnAoeId?: string | null;
  activeEffects?: unknown[];
}

export interface ActorRecord {
  id: string;
  campaignId: string;
  ownerUserId?: string | null;
  name: string;
  kind: string;
  hp: number;
  maxHp: number;
  gmCoreLocked?: boolean;
  attributes?: Record<string, number>;
  sheet?: Record<string, unknown>;
  position?: Point2D;
  topLeft?: Point2D;
  elevationFt?: number;
}

export type TableMode = "EXPLORATION" | "TURN_BY_TURN";

export type AmbientPreset = "DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS";

export interface WallSegment {
  id: string;
  a: Point2D;
  b: Point2D;
  blocksMovement: boolean;
  blocksVision: boolean;
  blocksLight: boolean;
  blocksSound: boolean;
  bottomElevationFt: number;
  topElevationFt: number;
  kind?: unknown;
}

export interface CampaignRoomState {
  campaignId: string;
  mode: TableMode;
  explorationPaused: boolean;
  ambientLighting: AmbientPreset;
  cellSizePx: number;
  feetPerCell: number;
  tokens: Record<string, Token>;
  walls: WallSegment[];
  persistentAoes?: Record<string, unknown>;
  initiativeOrder: string[];
  activeTurnIndex: number;
  round: number;
  backgroundAssetHash?: string | null;
  mapWidthPx?: number;
  mapHeightPx?: number;
  actors?: ActorRecord[];
}

export interface Campaign {
  id: string;
  name: string;
  system: string;
  role: string;
  createdAt: string;
  description?: string | null;
  activeMapHash?: string | null;
  actors?: ActorRecord[];
}

export interface CreateCampaignRequest {
  name: string;
  system?: string;
  description?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  username: string;
  isGuest: boolean;
  isEphemeral: boolean;
  role: string;
  mfaEnabled?: boolean;
}

export interface RegisterRequest {
  email: string;
  displayName: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthUserEnvelope {
  user: AuthUser;
}

export interface MagicLinkLoginRequest {
  token: string;
  nickname?: string;
}

export interface MagicLinkLoginResponse {
  userId: string;
  username: string;
  campaignId: string;
  characterId?: string | null;
  role: string;
  sessionId: string;
  user: AuthUser;
}

export interface CreateCampaignInviteRequest {
  characterId?: string;
  role?: string;
  ttlSeconds?: number;
  durationSeconds?: number;
}

export interface CampaignInviteResponse {
  inviteUrl: string;
  token: string;
  expiresAt: number;
  campaignId: string;
  role: string;
  characterId?: string;
}

export interface PatRecord {
  id: string;
  userId: string;
  campaignId?: string | null;
  tokenHash?: string;
  scopes: string[];
  name?: string | null;
  createdAt: number;
  expiresAt?: number | null;
}

export interface CreatePatRequest {
  scopes: string[];
  campaignId?: string;
  name?: string;
  expiresAt?: number;
  expiresInSeconds?: number;
}

export interface CreatePatResponse {
  id: string;
  token: string;
  userId: string;
  campaignId?: string | null;
  scopes: string[];
  name?: string | null;
  createdAt: number;
  expiresAt?: number | null;
}

export interface ImportArchiveResult {
  campaign_id: string;
  name: string;
  actors_restored: number;
  scenes_restored: number;
  notes_restored: number;
  assets_restored: number;
}

export interface NoteDto {
  id: string;
  slug: string;
  title: string;
  folder?: string | null;
  contentMarkdown: string;
  updatedAt: string;
}

export interface PartyJournalEntry {
  handoutId: string;
  campaignId: string;
  title: string;
  content: string;
  revealedAt: number;
  revealedBy: string;
}

export interface RevealHandoutRequest {
  handoutId: string;
  title: string;
  content: string;
  sessionNum?: number;
}

export interface HandoutRevealedBroadcast {
  event: string;
  handoutId: string;
  title: string;
  content: string;
  revealedBy: string;
  timestamp: number;
}

export interface SessionTimelineEvent {
  seqId: number;
  timestamp: number;
  eventType: string;
  actorId?: string | null;
  payload: unknown;
}

export interface SessionTimelineResponse {
  campaignId: string;
  sessionNum: number;
  sessionId: string;
  events: SessionTimelineEvent[];
  hasMore: boolean;
}

export interface ClientDiceLogEntry {
  rollId: string;
  rollerUserId: string;
  expression: string;
  reason: string;
  blindMasked: boolean;
  total: number | null;
}

export interface RadarPing {
  id: string;
  x: number;
  y: number;
  pingType: string;
  userId: string;
  color: string;
  timestamp: number;
}

export type TrameCommand =
  | {
      cmd: "MOVE_TOKEN";
      token_id: string;
      to_top_left: Point2D;
      to_elevation_ft?: number;
      gm_teleport: boolean;
    }
  | {
      cmd: "TOGGLE_DOOR";
      wall_id: string;
      is_open: boolean;
    }
  | {
      cmd: "TOGGLE_SQUEEZE";
      token_id: string;
      is_squeezing: boolean;
    }
  | {
      cmd: "SET_TABLE_MODE";
      mode: TableMode;
      exploration_paused: boolean;
      initiative_order: string[];
    }
  | {
      cmd: "ADVANCE_TURN";
    }
  | {
      cmd: "APPLY_DAMAGE";
      token_id: string;
      raw_damage: number;
      affinity: string;
    }
  | {
      cmd: "GM_OVERRIDE_TOKEN_RESOURCES";
      token_id: string;
      hp?: number;
      temp_hp?: number;
      speed_remaining_ft?: number;
      has_action?: boolean;
      has_bonus_action?: boolean;
      has_reaction?: boolean;
    }
  | {
      cmd: "PROJECT_AOE";
      template: unknown;
      persist_zone: boolean;
    }
  | {
      cmd: "BREAK_CONCENTRATION";
      caster_token_id: string;
    }
  | {
      cmd: "SET_AMBIENT_LIGHTING";
      preset: AmbientPreset;
    }
  | {
      cmd: "LOAD_SCENE";
      scene_id: string;
      map_asset_id: string;
      width_px: number;
      height_px: number;
      pixels_per_grid: number;
      walls: unknown[];
    }
  | {
      cmd: "SPAWN_TOKEN";
      token: Token;
    }
  | {
      cmd: "REMOVE_TOKEN";
      token_id: string;
    }
  | {
      cmd: "SET_TOKEN_VISIBILITY";
      token_id: string;
      gm_hidden: boolean;
      invisible: boolean;
    }
  | {
      cmd: "ASSIGN_TOKEN_OWNER";
      token_id: string;
      owner_user_id?: string | null;
    }
  | {
      cmd: "CONFIGURE_DOOR";
      wall_id: string;
      is_open?: boolean;
      is_locked?: boolean;
      is_secret?: boolean;
    }
  | {
      cmd: "UNDO_LAST_ACTION";
    }
  | {
      [key: string]: unknown;
    };

export interface TokenMovedEvent {
  event: "TOKEN_MOVED" | "TokenMoved";
  token_id?: string;
  tokenId?: string;
  from_top_left?: Point2D;
  fromTopLeft?: Point2D;
  to_top_left?: Point2D;
  toTopLeft?: Point2D;
  elevation_ft?: number;
  elevationFt?: number;
  speed_remaining_ft?: number;
  speedRemainingFt?: number;
  [key: string]: unknown;
}

export type TrameEvent =
  | TokenMovedEvent
  | {
      event: string;
      [key: string]: unknown;
    };

export type ClientEnvelope =
  | { type: "Command"; command: TrameCommand; Command?: TrameCommand; SubmitCommand?: TrameCommand }
  | { Command: TrameCommand }
  | { SubmitCommand: TrameCommand }
  | { type: "RollDice"; expression: string; visibility: string; reason: string }
  | { type: "PointerPing"; pos: Point2D; colorHex: string }
  | { type: "Ping"; clientTimeMs: number };

export type ServerEnvelope =
  | { type: "StateSync"; seqId?: number; seq_id?: number; state: CampaignRoomState }
  | { StateSync: { seq_id?: number; seqId?: number; state: CampaignRoomState } }
  | { StateSnapshot: { seq_id?: number; seqId?: number; state: CampaignRoomState } }
  | { type: "Delta"; seqId?: number; seq_id?: number; events: TrameEvent[]; state?: Partial<CampaignRoomState> }
  | { Delta: { seq_id?: number; seqId?: number; events: TrameEvent[]; state?: Partial<CampaignRoomState> } }
  | { CommandAccepted: { seq_id?: number; seqId?: number; events: TrameEvent[]; state: CampaignRoomState } }
  | { type: "CommandRejected"; reason: string }
  | { CommandRejected: { reason: string } }
  | { type: "DiceRolled"; roll: unknown }
  | { DiceRolled: unknown }
  | { type: "HandoutRevealed"; handout: HandoutRevealedBroadcast }
  | { HandoutRevealed: HandoutRevealedBroadcast }
  | { type: "PointerPingBroadcast"; senderUserId?: string; sender_user_id?: string; pos: Point2D; colorHex?: string; color_hex?: string }
  | { PointerPingBroadcast: { sender_user_id?: string; pos: Point2D; color_hex?: string } }
  | { type: "Pong"; clientTimeMs?: number; client_time_ms?: number; serverTimeMs?: number; server_time_ms?: number }
  | { Pong: { client_time_ms: number; server_time_ms: number } };
