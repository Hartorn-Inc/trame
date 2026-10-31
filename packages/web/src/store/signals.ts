/**
 * ============================================================================
 * REACTIVE PREACT SIGNALS APPLICATION STATE (store/signals.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Centralizes reactive `@preact/signals` state (`PreactSignalState`) for
 * authentication, campaign lobby, active tabletop session, tokens, walls,
 * AoE templates, dice log, wiki notes, handouts, and HUD drawers.
 * ============================================================================
 */

import { computed, signal } from '@preact/signals';
import type { Point2D, WallSegmentDto } from '../engine/wasmBridge.ts';

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  username: string;
  is_guest: boolean;
  is_ephemeral: boolean;
  role: string;
}

export interface CampaignActorRecord {
  id: string;
  campaign_id: string;
  owner_user_id?: string;
  name: string;
  kind?: string;
  hp: number;
  max_hp: number;
  gm_core_locked?: boolean;
  attributes?: Record<string, number>;
  sheet?: Record<string, unknown>;
}

export interface CampaignMapRecord {
  id: string;
  campaign_id: string;
  name: string;
  sha256_hash: string;
  width_px: number;
  height_px: number;
  pixels_per_grid: number;
  revealed_to_players?: boolean;
  walls?: WallSegmentDto[];
  lights?: Array<Record<string, unknown>>;
}

export interface CampaignSummary {
  id: string;
  name: string;
  system: string;
  role: string;
  created_at: string;
  description?: string;
  active_map_hash?: string;
  actors?: CampaignActorRecord[];
}

export interface WireTokenState {
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
    normal_range_ft: number;
    darkvision_range_ft: number;
    blindsight_range_ft: number;
    tremorsense_range_ft: number;
    truesight_range_ft: number;
    devils_sight: boolean;
    see_invisibility: boolean;
    ethereal_sight: boolean;
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
  active_effects: Array<{ id: string; name: string }>;
}

export interface WireAoeTemplate {
  id: string;
  caster_token_id: string | null;
  requires_concentration: boolean;
  elevation_ft: number;
  height_ft: number;
  shape:
    | { shape: 'SPHERE'; origin: Point2D; radius_ft: number }
    | { shape: 'CUBE'; origin: Point2D; size_ft: number }
    | { shape: 'CONE'; origin: Point2D; direction_rad: number; length_ft: number }
    | { shape: 'LINE'; origin: Point2D; end: Point2D; width_ft: number };
}

export interface ProjectedTableStateDto {
  campaign_id: string;
  mode: 'EXPLORATION' | 'TURN_BY_TURN';
  exploration_paused: boolean;
  ambient_lighting: 'DAYLIGHT' | 'DUSK' | 'NIGHT_MOONLIGHT' | 'PITCH_DARKNESS';
  cell_size_px: number;
  feet_per_cell: number;
  tokens: Record<string, WireTokenState>;
  walls: WallSegmentDto[];
  persistent_aoes: Record<string, WireAoeTemplate>;
  initiative_order: string[];
  active_turn_index: number;
  round: number;
  background_asset_hash?: string | null;
  map_width_px?: number;
  map_height_px?: number;
}

export interface DiceRollTermDto {
  faces: number;
  rolls: number[];
  kept_indices: number[];
}

export interface ProjectedDiceRollDto {
  roll_id: string;
  roller_user_id: string;
  expression: string;
  reason: string;
  visibility: 'Public' | 'GmOnly' | 'BlindGm';
  blind_masked: boolean;
  total: number | null;
  terms: DiceRollTermDto[];
  modifier: number;
  timestamp_ms: number;
}

export interface WikiNoteDto {
  id: string;
  slug: string;
  title: string;
  folder?: string | null;
  content_markdown: string;
  updated_at: string;
}

export interface HandoutEntryDto {
  handout_id: string;
  campaign_id: string;
  title: string;
  content: string;
  revealed_at: number;
  revealed_by: string;
}

export interface PointerPingItem {
  id: string;
  sender_user_id: string;
  pos: Point2D;
  color_hex: string;
  timestamp_ms: number;
}

export type ActiveHudDrawer = 'none' | 'sheet' | 'wizard' | 'combat' | 'dice' | 'notes';
export type ActiveToolMode = 'select' | 'ping' | 'aoe_sphere' | 'aoe_cone' | 'aoe_line';
export type ActiveWorkspaceTab = 'characters' | 'maps' | 'documents' | 'table';
export type CombatAutomationMode = 'ASSISTED_DM_CONFIRM' | 'FULL_AUTOMATION' | 'MANUAL_CLASSIC';

export const currentUserSignal = signal<AuthUser | null>(null);
export const campaignsSignal = signal<CampaignSummary[]>([]);
export const activeCampaignSignal = signal<CampaignSummary | null>(null);
export const activeWorkspaceTabSignal = signal<ActiveWorkspaceTab>('table');
export const coreStatsLockedSignal = signal<boolean>(true);
export const combatAutomationModeSignal = signal<CombatAutomationMode>('ASSISTED_DM_CONFIRM');
export const wsConnectionStateSignal = signal<'disconnected' | 'connecting' | 'connected'>('disconnected');
export const wsRttMsSignal = signal<number>(0);

export const tableSeqIdSignal = signal<number>(0);
export const tableStateSignal = signal<ProjectedTableStateDto | null>(null);
export const selectedTokenIdSignal = signal<string | null>(null);
export const activeToolSignal = signal<ActiveToolMode>('select');
export const activeDrawerSignal = signal<ActiveHudDrawer>('combat');

export const mapImageUrlSignal = signal<string | null>(null);
export const mapDimensionsSignal = signal<{ width: number; height: number }>({ width: 1200, height: 800 });
export const preparedMapsSignal = signal<CampaignMapRecord[]>([]);

export const diceLogSignal = signal<ProjectedDiceRollDto[]>([]);
export const pointerPingsSignal = signal<PointerPingItem[]>([]);
export const wikiNotesSignal = signal<WikiNoteDto[]>([]);
export const revealedHandoutsSignal = signal<HandoutEntryDto[]>([]);
export const activeHandoutModalSignal = signal<HandoutEntryDto | null>(null);
export const lastErrorBannerSignal = signal<string | null>(null);
export const mobileCompanionOverrideSignal = signal<boolean>(false);

export const isGmSignal = computed<boolean>(() => {
  const camp = activeCampaignSignal.value;
  if (!camp) return false;
  return camp.role.toUpperCase() === 'GM' || camp.role.toUpperCase() === 'GAME_MASTER';
});

export const selectedTokenSignal = computed<WireTokenState | null>(() => {
  const st = tableStateSignal.value;
  const selId = selectedTokenIdSignal.value;
  if (!st) return null;
  if (selId && st.tokens[selId]) {
    return st.tokens[selId];
  }
  const user = currentUserSignal.value;
  if (user) {
    const owned = Object.values(st.tokens).find((t) => t.owner_user_id === user.id);
    if (owned) return owned;
  }
  const first = Object.values(st.tokens)[0];
  return first ?? null;
});
