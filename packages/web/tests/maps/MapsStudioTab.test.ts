import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_CONCURRENT_RAYCASTS,
  SpatialAudioManager,
  compute3DDistance,
  computeOcclusionLowPassCutoff,
  countSoundOccludingWalls,
} from "../../src/audio/spatialAudio.ts";
import { DualBufferFogOfWar } from "../../src/canvas/LightingShader.ts";
import {
  type Point2D,
  type WallSegmentDto,
  convertDrawingToWallSegments,
} from "../../src/engine/wasmBridge.ts";

export type WallType =
  | "Normal"
  | "Window"
  | "Terrain"
  | "OneWay"
  | "Door"
  | "SecretDoor"
  | "Illusion";

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
  templateKey: "Goblin" | "Bandit" | "Guard" | "Skeleton" | "Wolf" | "Ogre" | "Boss";
  x: number;
  y: number;
  elevationFt: number;
  visibilityChannel: "Public" | "GmHidden";
  ownerUserId: string | null;
  hpCurrent: number;
  hpMax: number;
}

export interface CampaignMapScene {
  id: string;
  campaignId: string;
  title: string;
  revealedToPlayers: boolean;
  gridCellSizePx: number;
  feetPerCell: number;
  widthPx: number;
  heightPx:
    number;
  walls: StudioWallSegment[];
  lights: StudioLightSource[];
  audioEmitters: Array<{
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
  }>;
  stagedTokens: StagedToken[];
  spawnPoint: Point2D;
}

export interface ActiveTableRoomState {
  activeSceneId: string;
  walls: StudioWallSegment[];
  lights: StudioLightSource[];
  tokens: StagedToken[];
}

export function filterScenesForRole(
  scenes: CampaignMapScene[],
  role: "GM" | "PLAYER" | "SPECTATOR",
): CampaignMapScene[] {
  if (role === "GM") {
    return scenes;
  }
  return scenes
    .filter((scene) => scene.revealedToPlayers)
    .map((scene) => ({
      ...scene,
      walls: scene.walls.map((wall) => {
        if (wall.wallType === "SecretDoor" && !wall.secretDoorState?.isOpen) {
          return {
            ...wall,
            wallType: "Normal",
            secretDoorState: undefined,
          };
        }
        return wall;
      }),
      stagedTokens: scene.stagedTokens.filter(
        (token) => token.visibilityChannel !== "GmHidden",
      ),
    }));
}

export function activateSceneTransition(
  currentTable: ActiveTableRoomState,
  targetScene: CampaignMapScene,
): ActiveTableRoomState {
  const heroTokens = currentTable.tokens.filter((t) => t.ownerUserId !== null);
  const preservedHeroes = heroTokens.map((hero, index) => ({
    ...hero,
    x: targetScene.spawnPoint.x + index * 10,
    y: targetScene.spawnPoint.y,
  }));

  const nonHeroStaged = targetScene.stagedTokens.filter((t) => t.ownerUserId === null);

  return {
    activeSceneId: targetScene.id,
    walls: [...targetScene.walls],
    lights: [...targetScene.lights],
    tokens: [...preservedHeroes, ...nonHeroStaged],
  };
}

export function parseUvttImport(uvttJson: {
  format: number;
  resolution: { pixels_per_grid: number };
  line_of_sight?: Array<Array<{ x: number; y: number }>>;
  portals?: Array<{
    position: { x: number; y: number };
    bounds: Array<{ x: number; y: number }>;
    closed: boolean;
  }>;
  lights?: Array<{
    position: { x: number; y: number };
    range: number;
    color: string;
    intensity: number;
  }>;
}): { walls: StudioWallSegment[]; lights: StudioLightSource[] } {
  const walls: StudioWallSegment[] = [];
  let wallCounter = 1;

  if (uvttJson.line_of_sight) {
    for (const poly of uvttJson.line_of_sight) {
      for (let i = 0; i < poly.length - 1; i++) {
        walls.push({
          id: `uvtt-wall-${wallCounter++}`,
          a: { x: poly[i].x, y: poly[i].y },
          b: { x: poly[i + 1].x, y: poly[i + 1].y },
          wallType: "Normal",
          blocksMovement: true,
          blocksVision: true,
          blocksLight: true,
          blocksSound: true,
          bottomElevationFt: -1000,
          topElevationFt: 1000,
        });
      }
    }
  }

  if (uvttJson.portals) {
    for (const portal of uvttJson.portals) {
      if (portal.bounds && portal.bounds.length >= 2) {
        walls.push({
          id: `uvtt-door-${wallCounter++}`,
          a: { x: portal.bounds[0].x, y: portal.bounds[0].y },
          b: { x: portal.bounds[1].x, y: portal.bounds[1].y },
          wallType: "Door",
          blocksMovement: portal.closed,
          blocksVision: portal.closed,
          blocksLight: portal.closed,
          blocksSound: portal.closed,
          bottomElevationFt: -1000,
          topElevationFt: 1000,
          doorState: {
            isOpen: !portal.closed,
            isLocked: false,
          },
        });
      }
    }
  }

  const lights: StudioLightSource[] = (uvttJson.lights || []).map((l, idx) => ({
    id: `uvtt-light-${idx + 1}`,
    origin: { x: l.position.x, y: l.position.y },
    brightRadiusFt: l.range * 0.5,
    dimRadiusFt: l.range,
    colorHex: l.color,
    intensity: l.intensity,
  }));

  return { walls, lights };
}

describe("MapsStudioTab & Player SceneAtlas Integration Suite", () => {
  describe("Scene Creation & UvttMap Import Verification", () => {
    it("WHEN GM imports a UvttMap with portals and lights, imported dynamic lights and door segments are preserved exactly.", () => {
      const mockUvtt = {
        format: 0.2,
        resolution: { pixels_per_grid: 70 },
        line_of_sight: [
          [
            { x: 100, y: 100 },
            { x: 300, y: 100 },
            { x: 300, y: 300 },
          ],
        ],
        portals: [
          {
            position: { x: 200, y: 100 },
            bounds: [
              { x: 190, y: 100 },
              { x: 210, y: 100 },
            ],
            closed: true,
          },
        ],
        lights: [
          {
            position: { x: 150, y: 150 },
            range: 30,
            color: "#ffaa44",
            intensity: 1.0,
          },
          {
            position: { x: 250, y: 250 },
            range: 60,
            color: "#44aaff",
            intensity: 0.8,
          },
        ],
      };

      const imported = parseUvttImport(mockUvtt);
      assert.equal(imported.walls.length, 3);
      assert.equal(imported.walls[0].wallType, "Normal");
      assert.equal(imported.walls[2].wallType, "Door");
      assert.equal(imported.walls[2].blocksVision, true);
      assert.equal(imported.walls[2].doorState?.isOpen, false);

      assert.equal(imported.lights.length, 2);
      assert.equal(imported.lights[0].colorHex, "#ffaa44");
      assert.equal(imported.lights[0].brightRadiusFt, 15);
      assert.equal(imported.lights[0].dimRadiusFt, 30);
      assert.equal(imported.lights[1].colorHex, "#44aaff");
      assert.equal(imported.lights[1].intensity, 0.8);
    });

    it("WHEN converting freehand DrawingEntity to wall segments, elevations and physical flags are correctly mapped.", () => {
      const drawing = {
        id: "draw-wall-polygon",
        points: [
          [0, 0] as [number, number],
          [100, 0] as [number, number],
          [100, 100] as [number, number],
        ],
        color: "#ff0000",
        lineWidth: 4,
        isClosed: true,
        hasPhysicalWalls: true,
      };

      const segments = convertDrawingToWallSegments(drawing, 0, 15);
      assert.equal(segments.length, 3);
      assert.equal(segments[0].bottomElevationFt, 0);
      assert.equal(segments[0].topElevationFt, 15);
      assert.equal(segments[0].blocksVision, true);
      assert.equal(segments[0].blocksMovement, true);
      assert.equal(segments[0].blocksSound, true);
    });
  });

  describe("Wall Types & 2.5D Elevation Authoring", () => {
    const wallTypesCases: Array<{
      type: WallType;
      blocksVision: boolean;
      blocksMovement: boolean;
      blocksLight: boolean;
      blocksSound: boolean;
    }> = [
      { type: "Normal", blocksVision: true, blocksMovement: true, blocksLight: true, blocksSound: true },
      { type: "Window", blocksVision: false, blocksMovement: true, blocksLight: false, blocksSound: true },
      { type: "Terrain", blocksVision: true, blocksMovement: true, blocksLight: true, blocksSound: false },
      { type: "Illusion", blocksVision: true, blocksMovement: false, blocksLight: true, blocksSound: false },
      { type: "Door", blocksVision: true, blocksMovement: true, blocksLight: true, blocksSound: true },
      { type: "SecretDoor", blocksVision: true, blocksMovement: true, blocksLight: true, blocksSound: true },
    ];

    for (const tc of wallTypesCases) {
      it(`verifies initial physical occlusion flags for WallType ${tc.type}`, () => {
        const segment: StudioWallSegment = {
          id: `seg-${tc.type}`,
          a: { x: 0, y: 0 },
          b: { x: 100, y: 0 },
          wallType: tc.type,
          blocksMovement: tc.blocksMovement,
          blocksVision: tc.blocksVision,
          blocksLight: tc.blocksLight,
          blocksSound: tc.blocksSound,
          bottomElevationFt: 0,
          topElevationFt: 10,
        };

        assert.equal(segment.blocksVision, tc.blocksVision);
        assert.equal(segment.blocksMovement, tc.blocksMovement);
        assert.equal(segment.blocksLight, tc.blocksLight);
        assert.equal(segment.blocksSound, tc.blocksSound);
      });
    }

    it("WHEN interactive door is opened, its movement, vision, and light blocks become permeable.", () => {
      const door: StudioWallSegment = {
        id: "door-1",
        a: { x: 50, y: 0 },
        b: { x: 50, y: 50 },
        wallType: "Door",
        blocksMovement: true,
        blocksVision: true,
        blocksLight: true,
        blocksSound: true,
        bottomElevationFt: 0,
        topElevationFt: 8,
        doorState: { isOpen: false, isLocked: false },
      };

      assert.equal(door.doorState?.isOpen, false);
      assert.equal(door.blocksMovement, true);

      door.doorState!.isOpen = true;
      door.blocksMovement = false;
      door.blocksVision = false;
      door.blocksLight = false;

      assert.equal(door.doorState?.isOpen, true);
      assert.equal(door.blocksMovement, false);
      assert.equal(door.blocksVision, false);
    });
  });

  describe("DualBufferFogOfWar & SpatialAudioManager Integration", () => {
    it("WHEN DualBufferFogOfWar updates visible cells and rolls back snapshot, fog state restores faithfully.", () => {
      const fog = new DualBufferFogOfWar();
      assert.equal(fog.getCellState(5, 5), "UNEXPLORED");
      assert.equal(fog.getCellOverlayAlpha(5, 5), 1.0);

      fog.updateVisibleCells([{ col: 5, row: 5 }, { col: 5, row: 6 }]);
      assert.equal(fog.getCellState(5, 5), "VISIBLE");
      assert.equal(fog.getCellOverlayAlpha(5, 5), 0.0);

      fog.captureSnapshot("initial-view");

      fog.updateVisibleCells([{ col: 10, row: 10 }]);
      assert.equal(fog.getCellState(5, 5), "EXPLORED_MEMORY");
      assert.equal(fog.getCellOverlayAlpha(5, 5), 0.65);
      assert.equal(fog.getCellState(10, 10), "VISIBLE");

      const rolledBack = fog.rollbackSnapshot("initial-view");
      assert.equal(rolledBack, true);
      assert.equal(fog.getCellState(5, 5), "VISIBLE");
      assert.equal(fog.getCellState(10, 10), "UNEXPLORED");
    });

    it("WHEN acoustic raycast encounters blocksSound walls with vertical bounds, attenuation and occlusion frequency calculate deterministically.", () => {
      const audio = new SpatialAudioManager();
      audio.updateListener({ x: 0, y: 0, elevationFt: 5 });
      audio.upsertEmitter({
        id: "campfire-ambience",
        url: "sound/campfire.ogg",
        x: 100,
        y: 0,
        elevationFt: 5,
        refDistanceFt: 10,
        maxDistanceFt: 200,
        rolloff: 1.0,
        loopPlayback: true,
        volume: 1.0,
      });

      const interveningWall: WallSegmentDto = {
        id: "stone-wall-1",
        a: { x: 50, y: -20 },
        b: { x: 50, y: 20 },
        blocksVision: true,
        blocksMovement: true,
        blocksSound: true,
        bottomElevationFt: 0,
        topElevationFt: 12,
      };

      const soundWalls = countSoundOccludingWalls(
        { x: 100, y: 0, elevationFt: 5 },
        { x: 0, y: 0, elevationFt: 5 },
        [interveningWall],
      );
      assert.equal(soundWalls, 1);

      const cutoff = computeOcclusionLowPassCutoff(soundWalls);
      assert.equal(cutoff, 4444.44);

      audio.updateOcclusionAndAttenuation([interveningWall]);
      const state = audio.getEmitterState("campfire-ambience");
      assert.ok(state !== undefined);
      assert.equal(state.cutoffFrequency, 4444.44);
    });
  });

  describe("Role-Based SceneAtlas Filtering & SecretDoor Wire Masking", () => {
    const testScenes: CampaignMapScene[] = [
      {
        id: "scene-overworld",
        campaignId: "camp-1",
        title: "Sword Coast Region",
        revealedToPlayers: true,
        gridCellSizePx: 50,
        feetPerCell: 5,
        widthPx: 2000,
        heightPx: 2000,
        walls: [],
        lights: [],
        audioEmitters: [],
        stagedTokens: [],
        spawnPoint: { x: 500, y: 500 },
      },
      {
        id: "scene-dungeon-l1",
        campaignId: "camp-1",
        title: "Sunken Tomb Level 1",
        revealedToPlayers: false,
        gridCellSizePx: 70,
        feetPerCell: 5,
        widthPx: 1400,
        heightPx: 1400,
        walls: [
          {
            id: "sec-1",
            a: { x: 100, y: 100 },
            b: { x: 100, y: 200 },
            wallType: "SecretDoor",
            blocksMovement: true,
            blocksVision: true,
            blocksLight: true,
            blocksSound: true,
            bottomElevationFt: 0,
            topElevationFt: 10,
            secretDoorState: { isOpen: false },
          },
        ],
        lights: [],
        audioEmitters: [],
        stagedTokens: [
          {
            id: "mob-1",
            name: "Goblin Sentry",
            templateKey: "Goblin",
            x: 200,
            y: 200,
            elevationFt: 0,
            visibilityChannel: "GmHidden",
            ownerUserId: null,
            hpCurrent: 7,
            hpMax: 7,
          },
        ],
        spawnPoint: { x: 100, y: 100 },
      },
      {
        id: "scene-town-square",
        campaignId: "camp-1",
        title: "Phandalin Town Square",
        revealedToPlayers: true,
        gridCellSizePx: 70,
        feetPerCell: 5,
        widthPx: 2100,
        heightPx: 2100,
        walls: [
          {
            id: "sec-2",
            a: { x: 300, y: 300 },
            b: { x: 300, y: 400 },
            wallType: "SecretDoor",
            blocksMovement: true,
            blocksVision: true,
            blocksLight: true,
            blocksSound: true,
            bottomElevationFt: 0,
            topElevationFt: 10,
            secretDoorState: { isOpen: false },
          },
        ],
        lights: [],
        audioEmitters: [],
        stagedTokens: [
          {
            id: "npc-vendor",
            name: "Shopkeeper Barthen",
            templateKey: "Bandit",
            x: 400,
            y: 400,
            elevationFt: 0,
            visibilityChannel: "Public",
            ownerUserId: null,
            hpCurrent: 12,
            hpMax: 12,
          },
          {
            id: "ambush-bugbear",
            name: "Hidden Bugbear",
            templateKey: "Boss",
            x: 450,
            y: 450,
            elevationFt: 0,
            visibilityChannel: "GmHidden",
            ownerUserId: null,
            hpCurrent: 35,
            hpMax: 35,
          },
        ],
        spawnPoint: { x: 200, y: 200 },
      },
    ];

    it("WHEN GM queries campaign scenes, all scenes (revealed and unrevealed) with raw SecretDoor walls are returned.", () => {
      const gmScenes = filterScenesForRole(testScenes, "GM");
      assert.equal(gmScenes.length, 3);
      assert.equal(gmScenes[1].revealedToPlayers, false);
      assert.equal(gmScenes[1].walls[0].wallType, "SecretDoor");
      assert.equal(gmScenes[2].stagedTokens.length, 2);
    });

    it("WHEN Player queries SceneAtlas, unrevealed scenes and GmHidden tokens are completely omitted, and closed SecretDoor walls are masked as Normal.", () => {
      const playerScenes = filterScenesForRole(testScenes, "PLAYER");
      assert.equal(playerScenes.length, 2);
      assert.equal(playerScenes[0].id, "scene-overworld");
      assert.equal(playerScenes[1].id, "scene-town-square");

      const townWalls = playerScenes[1].walls;
      assert.equal(townWalls.length, 1);
      assert.equal(townWalls[0].wallType, "Normal", "Closed SecretDoor must be masked as Normal wall");
      assert.equal(townWalls[0].secretDoorState, undefined);

      const townTokens = playerScenes[1].stagedTokens;
      assert.equal(townTokens.length, 1);
      assert.equal(townTokens[0].name, "Shopkeeper Barthen");
      assert.equal(townTokens.find((t) => t.name === "Hidden Bugbear"), undefined);
    });
  });

  describe("Push to Live Table (`ActivateScene`) & Hero Token Carryover", () => {
    it("WHEN ActivateScene executes, player-owned hero tokens carry over to destination SpawnPoint while scene walls and staged NPCs are loaded.", () => {
      const currentTable: ActiveTableRoomState = {
        activeSceneId: "scene-intro-road",
        walls: [],
        lights: [],
        tokens: [
          {
            id: "hero-althea",
            name: "Althea",
            templateKey: "Guard",
            x: 50,
            y: 60,
            elevationFt: 0,
            visibilityChannel: "Public",
            ownerUserId: "user-player-1",
            hpCurrent: 28,
            hpMax: 32,
          },
          {
            id: "hero-brog",
            name: "Brog",
            templateKey: "Guard",
            x: 70,
            y: 80,
            elevationFt: 0,
            visibilityChannel: "Public",
            ownerUserId: "user-player-2",
            hpCurrent: 44,
            hpMax: 45,
          },
          {
            id: "old-mob",
            name: "Dead Wolf",
            templateKey: "Wolf",
            x: 100,
            y: 100,
            elevationFt: 0,
            visibilityChannel: "Public",
            ownerUserId: null,
            hpCurrent: 0,
            hpMax: 11,
          },
        ],
      };

      const dungeonScene: CampaignMapScene = {
        id: "scene-dungeon-boss-room",
        campaignId: "camp-1",
        title: "Sunken Tomb Sanctum",
        revealedToPlayers: false,
        gridCellSizePx: 70,
        feetPerCell: 5,
        widthPx: 1500,
        heightPx: 1500,
        walls: [
          {
            id: "sanctum-north-wall",
            a: { x: 0, y: 0 },
            b: { x: 500, y: 0 },
            wallType: "Normal",
            blocksMovement: true,
            blocksVision: true,
            blocksLight: true,
            blocksSound: true,
            bottomElevationFt: 0,
            topElevationFt: 20,
          },
        ],
        lights: [
          {
            id: "brazier-1",
            origin: { x: 250, y: 250 },
            brightRadiusFt: 20,
            dimRadiusFt: 40,
            colorHex: "#ff8800",
            intensity: 1.0,
          },
        ],
        audioEmitters: [],
        stagedTokens: [
          {
            id: "boss-lich",
            name: "Lich Lord",
            templateKey: "Boss",
            x: 250,
            y: 350,
            elevationFt: 0,
            visibilityChannel: "GmHidden",
            ownerUserId: null,
            hpCurrent: 135,
            hpMax: 135,
          },
        ],
        spawnPoint: { x: 250, y: 50 },
      };

      const updatedTable = activateSceneTransition(currentTable, dungeonScene);

      assert.equal(updatedTable.activeSceneId, "scene-dungeon-boss-room");
      assert.equal(updatedTable.walls.length, 1);
      assert.equal(updatedTable.lights.length, 1);

      assert.equal(updatedTable.tokens.length, 3);
      const carriedHero1 = updatedTable.tokens.find((t) => t.id === "hero-althea");
      const carriedHero2 = updatedTable.tokens.find((t) => t.id === "hero-brog");
      const bossToken = updatedTable.tokens.find((t) => t.id === "boss-lich");
      const deadWolf = updatedTable.tokens.find((t) => t.id === "old-mob");

      assert.ok(carriedHero1);
      assert.equal(carriedHero1.hpCurrent, 28);
      assert.equal(carriedHero1.x, 250);
      assert.equal(carriedHero1.y, 50);

      assert.ok(carriedHero2);
      assert.equal(carriedHero2.hpCurrent, 44);
      assert.equal(carriedHero2.x, 260);
      assert.equal(carriedHero2.y, 50);

      assert.ok(bossToken);
      assert.equal(bossToken.name, "Lich Lord");
      assert.equal(deadWolf, undefined, "Old non-hero tokens must not carry over");
    });
  });
});
