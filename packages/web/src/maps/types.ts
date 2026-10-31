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
}

export interface StudioLightSource {
  id: string;
  origin: Point2D;
  brightRadiusFt: number;
  dimRadiusFt: number;
  colorHex: string;
  intensity: number;
}

export interface StagedToken {
  id: string;
  name: string;
  templateKey: 'Goblin' | 'Bandit' | 'Guard' | 'Skeleton' | 'Wolf' | 'Ogre' | 'Boss';
  x: number;
  y: number;
  elevationFt: number;
  visibilityChannel: 'Public' | 'GmHidden';
  ownerUserId: string | null;
  hpCurrent: number;
  hpMax: number;
}

export interface AudioEmitterConfig {
  id: string;
  url: string;
  x: number;
  y: number;
  elevationFt: number;
  refDistanceFt: number;
  maxDistanceFt: number;
  rolloff: number;
  loopPlayback: boolean;
  volume: number;
  gmOnly?: boolean;
}

export interface CampaignMapScene {
  id: string;
  campaignId: string;
  title: string;
  revealedToPlayers: boolean;
  gridCellSizePx: number;
  feetPerCell: number;
  widthPx: number;
  heightPx: number;
  walls: StudioWallSegment[];
  lights: StudioLightSource[];
  audioEmitters: AudioEmitterConfig[];
  stagedTokens: StagedToken[];
  spawnPoint: Point2D;
}

export interface ActiveTableRoomState {
  activeSceneId: string;
  walls: StudioWallSegment[];
  lights: StudioLightSource[];
  tokens: StagedToken[];
}

export type UserRole = 'GM' | 'PLAYER' | 'SPECTATOR';
