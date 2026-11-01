# Specification: GM Visual Map Prep Studio (Wall/Light/Audio/Fog Editor) & Player SceneAtlas

## 1. Executive Summary & Scope
This specification defines the functional architecture and normative requirements for the GM Visual Map Prep Studio (`MapsStudioTab`) and the Player `SceneAtlas` within the `CampaignWorkspace` component of TRAME. It covers:
1. **Scene Library Management**: Creating, organizing, duplicating, and deleting campaign map scenes (`CampaignMapScene`).
2. **2.5D Wall Geometry Authoring**: Drawing interactive wall segments (`WallSegmentDto`) with explicit `ElevationFt` bounds (`bottomElevationFt`, `topElevationFt`) and physical occlusion flags (`blocksVision`, `blocksMovement`, `blocksSound`, `blocksLight`).
3. **Dynamic Lighting & Spatial Audio**: Placing radial point lights and spatial audio emitters with `AcousticOcclusion` through sound-blocking walls.
4. **1-Click GM Monster Templates**: Instantly staging ambush monster tokens with `VisibilityChannel::GmHidden` (`CHANNEL_GM_HIDDEN`).
5. **Atomic ActivateScene Table Transition**: Switching the active table scene while deterministically preserving and carrying over player-owned hero tokens (`ownerUserId != null`).
6. **Player SceneAtlas Gallery**: Secure browsing gallery for revealed scenes with zero-trust masking of secret doors and hidden entities.

---

## 2. User Stories & Acceptance Criteria

### US-1: Scene Library & Management
- **Description**: As a Game Master, I can manage a collection of scenes for my campaign, creating blank scenes, loading templates (such as Starter Dungeon), or importing universal maps (`UvttMap`).
- **Acceptance Criteria**:
  1. The GM can create a new scene with specified dimensions (`widthPx`, `heightPx`), grid size (`gridCellSizePx`), and feet-per-cell ratio.
  2. The GM can toggle whether a scene is published to players (`revealedToPlayers`).
  3. Creating a "Starter Dungeon" deterministically provisions entrance spawn points, bounding walls, doors, lights, and staged encounters.

### US-2: WallSegments Authoring with ElevationFt Bounds
- **Description**: As a Game Master, I can draw and edit wall segments with distinct operational behaviors and vertical boundaries.
- **Acceptance Criteria**:
  1. Supported wall types include `Normal`, `Window`, `Terrain`, `OneWay`, `Door`, `SecretDoor`, and `Illusion`.
  2. Each segment records `bottomElevationFt` and `topElevationFt`.
  3. Wall segments enforce non-color redundancy in the editor using distinct stroke widths and dash patterns defined in `SHARED_WALL_KINDS`.
  4. Interactive doors can be toggled (`open` vs. `closed`) and locked (`isLocked`); locked doors cannot be opened without unlocking.
  5. Vector drawings with `hasPhysicalWalls = true` convert into wall segments blocking vision, movement, and sound within their vertical bounds.

### US-3: Dynamic Point Lights & Spatial Audio with AcousticOcclusion
- **Description**: As a Game Master, I can position radial light sources and audio emitters on map scenes.
- **Acceptance Criteria**:
  1. Light sources specify bright radius, dim radius, RGB color, and intensity.
  2. Spatial audio emitters specify audio clip URL, volume, reference distance, maximum distance, and rolloff.
  3. `SpatialAudioManager` calculates 3D Euclidean distance taking into account vertical elevation differences.
  4. Wall segments with `blocksSound = true` within the ray path elevation attenuate audio through low-pass filtering calculated as `20000.0 / (1.0 + 3.5 * nWalls)`.
  5. Occlusion raycasts are capped at `MAX_CONCURRENT_RAYCASTS` (16) per audio evaluation cycle to maintain 60 FPS.

### US-4: 1-Click GM Monster Templates with CHANNEL_GM_HIDDEN
- **Description**: As a Game Master, I can stage encounter monsters from a single-click template palette.
- **Acceptance Criteria**:
  1. Monster templates (`Goblin`, `Bandit`, `Guard`, `Skeleton`, `Wolf`, `Ogre`, `Boss`) spawn at designated scene spawn points.
  2. All staged monsters are assigned `visibilityChannel = 'GmHidden'` (`CHANNEL_GM_HIDDEN`) by default.
  3. Staged monsters do not appear on player views until revealed or activated.

### US-5: Atomic ActivateScene Transition with Hero Token Carryover
- **Description**: As a Game Master, I can activate a prepared scene on the live table room without disrupting player character state.
- **Acceptance Criteria**:
  1. When `activateSceneTransition` executes, all player-owned tokens (`ownerUserId != null`) carry over from the current table state.
  2. Dynamic token attributes (current HP, max HP, temporary HP, conditions, inventory) are strictly preserved.
  3. Hero tokens are repositioned onto scene `spawnPoints` cyclically (`index % spawnPoints.length`) and adopt the scene `defaultGroundElevationFt`.
  4. Existing unowned monster/NPC tokens from the previous scene are removed.
  5. Staged tokens from the target scene are loaded onto the active table.

### US-6: Player SceneAtlas Gallery & Zero-Trust Secret Masking
- **Description**: As a player, I can browse revealed campaign maps in a dedicated gallery view without gaining access to GM secrets.
- **Acceptance Criteria**:
  1. Players only see scenes where `revealedToPlayers = true`; unrevealed scenes are omitted.
  2. Closed secret doors (`WallType::SecretDoor`) are masked and serialized as `Normal` walls without door controls.
  3. Staged tokens with `GmHidden` visibility are omitted from the player payload.
  4. Audio emitters marked `gmOnly = true` are omitted from the player payload.
  5. An empty gallery displays `EmptyMapAtlasSvg` with accessible semantic messaging.

---

## 3. Data Contract & Domain Models

```typescript
export interface Point2D {
  x: number;
  y: number;
}

export type WallType = 'Normal' | 'Window' | 'Terrain' | 'OneWay' | 'Door' | 'SecretDoor' | 'Illusion';

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
  doorState?: { isOpen: boolean; isLocked?: boolean };
  secretDoorState?: { isOpen: boolean };
}

export interface StudioLightSource {
  id: string;
  origin: Point2D;
  brightRadiusFt: number;
  dimRadiusFt: number;
  colorHex: string;
  intensity: number;
  elevationFt?: number;
}

export interface StagedToken {
  id: string;
  name: string;
  templateKey?: 'Goblin' | 'Bandit' | 'Guard' | 'Skeleton' | 'Wolf' | 'Ogre' | 'Boss';
  x: number;
  y: number;
  elevationFt: number;
  visibilityChannel: 'Public' | 'GmHidden';
  ownerUserId?: string | null;
  hpCurrent?: number;
  hpMax?: number;
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
  defaultGroundElevationFt?: number;
  spawnPoints?: Array<{ id: string; name: string; x: number; y: number }>;
  spawnPoint?: { x: number; y: number };
  walls: StudioWallSegment[];
  lights: StudioLightSource[];
  audioEmitters: AudioEmitterConfig[];
  stagedTokens: StagedToken[];
  exploredFogTexture?: number[];
}
```

---

## 4. Test Verification Suite
1. **UVTT Import & Geometry**: Validates `.uvtt` parsing into walls, portals, and lights (`packages/web/tests/maps/MapsStudioTab.test.ts`).
2. **Wall Occlusion Flags & Elevation**: Verifies movement, vision, light, and sound permeability flags across all wall types.
3. **Interactive Doors**: Validates `toggleDoorState` behavior, lock enforcement, and permeability changes.
4. **DualBufferFogOfWar & Rollback**: Verifies fog exploration tracking and snapshot rollback.
5. **Spatial Audio Occlusion**: Verifies 3D distance calculation, sound-blocking wall counts, and low-pass filter cutoff frequencies.
6. **Role-Based Filtering & Masking**: Verifies unrevealed scene filtering, secret door masking to `Normal`, and `GmHidden` token stripping.
7. **Scene Activation & Token Carryover**: Verifies hero carryover, spawn point distribution, ground elevation adoption, and staged monster instantiation.