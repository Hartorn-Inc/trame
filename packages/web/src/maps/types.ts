import type { Point2D } from '../engine/wasmBridge.ts';

export type WallType =
  | 'Normal'
  | 'Window'
  | 'Terrain'
  | 'OneWay'
  | 'Door'
  | 'SecretDoor'
  | 'Illusion';

export interface StudioWallSegment {
  id: string;
  a: Point2D;
  b: Point2D;
  wallType: WallType;
  blocksMovement: boolean;
  blocksVision: boolean;
  blocksLight: boolean;
  blocksSound: boolean;
  bottomElevationFt: number;
  topElevationFt: number;
  doorState?: {
    isOpen: boolean;
    isLocked: boolean;
  };
  secretDoorState?: {
    isOpen: boolean;
  };
  p1?: Point2D;
  p2?: Point2D;
  wall_type?: WallType;
  door_state?: 'Open' | 'Closed' | 'Locked' | null;
  bottom_elevation_ft?: number;
  top_elevation_ft?: number;
  blocks_light?: boolean;
  blocks_movement?: boolean;
  blocks_sound?: boolean;
  blocks_vision?: boolean;
}

export interface StudioLightSource {
  id: string;
  origin: Point2D;
  brightRadiusFt: number;
  dimRadiusFt: number;
  colorHex: string;
  intensity: number;
  elevationFt?: number;
  x?: number;
  y?: number;
  radius_ft?: number;
  color_hex?: string;
  elevation_ft?: number;
}

export interface StagedToken {
  id: string;
  name: string;
  templateKey?: 'Goblin' | 'Bandit' | 'Guard' | 'Skeleton' | 'Wolf' | 'Ogre' | 'Boss' | string;
  monsterTemplateId?: string;
  x: number;
  y: number;
  elevationFt: number;
  visibilityChannel: 'Public' | 'GmHidden';
  ownerUserId: string | null;
  hpCurrent?: number;
  hpMax?: number;
  sizeCells?: number;
  tokenAvatarUrl?: string;
  monster_template_id?: string | null;
  elevation_ft?: number;
  size_cells?: number;
  token_avatar_url?: string | null;
  visibility?: 'Public' | 'GmHidden';
}

export interface AudioEmitterConfig {
  id: string;
  url: string;
  x: number;
  y: number;
  elevationFt: number;
  refDistanceFt?: number;
  maxDistanceFt: number;
  rolloff?: number;
  loopPlayback?: boolean;
  volume: number;
  gmOnly?: boolean;
  audio_clip_url?: string;
  elevation_ft?: number;
  radius_ft?: number;
  looping?: boolean;
  gm_only?: boolean;
}

export interface SpawnPointConfig {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface CampaignMapScene {
  id: string;
  campaignId: string;
  title: string;
  revealedToPlayers: boolean;
  gridType?: string;
  gridCellSizePx: number;
  feetPerCell: number;
  widthPx: number;
  heightPx: number;
  backgroundImageUrl?: string;
  defaultGroundElevationFt?: number;
  spawnPoint?: Point2D;
  spawnPoints?: SpawnPointConfig[];
  walls: StudioWallSegment[];
  lights: StudioLightSource[];
  audioEmitters: AudioEmitterConfig[];
  stagedTokens: StagedToken[];
  exploredFogTexture?: number[];
  name?: string;
  campaign_id?: string;
  revealed_to_players?: boolean;
  grid_type?: string;
  grid_size_px?: number;
  grid_cell_distance_ft?: number;
  width_px?: number;
  height_px?: number;
  background_image_url?: string;
  default_ground_elevation_ft?: number;
  spawn_points?: SpawnPointConfig[];
  wall_segments?: StudioWallSegment[];
  light_sources?: StudioLightSource[];
  spatial_audio_emitters?: AudioEmitterConfig[];
  staged_tokens?: StagedToken[];
  explored_fog_texture?: number[];
}

export interface ActiveTableRoomState {
  activeSceneId: string;
  walls: StudioWallSegment[];
  lights: StudioLightSource[];
  tokens: StagedToken[];
}

export type UserRole = 'GM' | 'PLAYER' | 'SPECTATOR';
