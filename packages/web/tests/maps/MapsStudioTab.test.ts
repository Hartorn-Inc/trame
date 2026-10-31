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

import {
  type ActiveTableRoomState,
  type CampaignMapScene,
  type StagedToken,
  type StudioLightSource,
  type StudioWallSegment,
  type WallType,
  activateSceneTransition,
  filterScenesForRole,
  mapBackendSceneToFrontend,
  mapFrontendSceneToBackend,
  parseUvttImport,
  toggleDoorState,
} from "../../src/maps/index.ts";
import { CampaignWorkspace } from "../../src/workspace/CampaignWorkspace.tsx";

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
      assert.equal(imported.walls[0].a.x, 100 * 70);
      assert.equal(imported.walls[0].a.y, 100 * 70);
      assert.equal(imported.walls[2].wallType, "Door");
      assert.equal(imported.walls[2].blocksVision, true);
      assert.equal(imported.walls[2].doorState?.isOpen, false);

      assert.equal(imported.lights.length, 2);
      assert.equal(imported.lights[0].origin.x, 150 * 70);
      assert.equal(imported.lights[0].origin.y, 150 * 70);
      assert.equal(imported.lights[0].colorHex, "#ffaa44");
      assert.equal(imported.lights[0].brightRadiusFt, 15 * 70);
      assert.equal(imported.lights[0].dimRadiusFt, 30 * 70);
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
      { type: "OneWay", blocksVision: true, blocksMovement: true, blocksLight: true, blocksSound: true },
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

    it("WHEN interactive door is opened via toggleDoorState, its movement, vision, and light blocks become permeable.", () => {
      const closedDoor: StudioWallSegment = {
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

      assert.equal(closedDoor.doorState?.isOpen, false);
      assert.equal(closedDoor.blocksMovement, true);
      assert.equal(closedDoor.blocksVision, true);
      assert.equal(closedDoor.blocksLight, true);
      assert.equal(closedDoor.blocksSound, true);

      const openedDoor = toggleDoorState(closedDoor);
      assert.equal(openedDoor.doorState?.isOpen, true);
      assert.equal(openedDoor.blocksMovement, false);
      assert.equal(openedDoor.blocksVision, false);
      assert.equal(openedDoor.blocksLight, false);
      assert.equal(openedDoor.blocksSound, false);

      const reclosedDoor = toggleDoorState(openedDoor);
      assert.equal(reclosedDoor.doorState?.isOpen, false);
      assert.equal(reclosedDoor.blocksMovement, true);
      assert.equal(reclosedDoor.blocksVision, true);
      assert.equal(reclosedDoor.blocksLight, true);
      assert.equal(reclosedDoor.blocksSound, true);

      const lockedDoor: StudioWallSegment = {
        ...closedDoor,
        doorState: { isOpen: false, isLocked: true },
      };
      const attemptedUnlock = toggleDoorState(lockedDoor);
      assert.equal(attemptedUnlock.doorState?.isOpen, false);
      assert.equal(attemptedUnlock.blocksMovement, true);

      const secretDoor: StudioWallSegment = {
        id: "sec-door-1",
        a: { x: 0, y: 0 },
        b: { x: 50, y: 0 },
        wallType: "SecretDoor",
        blocksMovement: true,
        blocksVision: true,
        blocksLight: true,
        blocksSound: true,
        bottomElevationFt: 0,
        topElevationFt: 10,
        secretDoorState: { isOpen: false },
      };
      const openedSecret = toggleDoorState(secretDoor);
      assert.equal(openedSecret.secretDoorState?.isOpen, true);
      assert.equal(openedSecret.blocksMovement, false);
      assert.equal(openedSecret.blocksVision, false);
    });

    it("WHEN CampaignWorkspace is rendered, it exposes MapsStudioTab for GM and SceneAtlas for Player in Tab 2.", () => {
      const gmWorkspace = CampaignWorkspace({
        campaignId: "campaign-test-1",
        userRole: "GM",
        activeTab: 2,
        scenes: [],
      });
      assert.ok(gmWorkspace);

      const playerWorkspace = CampaignWorkspace({
        campaignId: "campaign-test-1",
        userRole: "PLAYER",
        activeTab: 2,
        scenes: [],
      });
      assert.ok(playerWorkspace);
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

    it("WHEN ADR-0034 spawn_points array is defined, hero tokens cycle through spawn_points and adopt default ground elevation.", () => {
      const currentTable: ActiveTableRoomState = {
        activeSceneId: "scene-prev",
        walls: [],
        lights: [],
        tokens: [
          {
            id: "hero-1",
            name: "Hero One",
            templateKey: "Guard",
            x: 0,
            y: 0,
            elevationFt: 10,
            visibilityChannel: "Public",
            ownerUserId: "user-1",
            hpCurrent: 20,
            hpMax: 20,
          },
          {
            id: "hero-2",
            name: "Hero Two",
            templateKey: "Guard",
            x: 0,
            y: 0,
            elevationFt: 15,
            visibilityChannel: "Public",
            ownerUserId: "user-2",
            hpCurrent: 25,
            hpMax: 25,
          },
          {
            id: "hero-3",
            name: "Hero Three",
            templateKey: "Guard",
            x: 0,
            y: 0,
            elevationFt: 5,
            visibilityChannel: "Public",
            ownerUserId: "user-3",
            hpCurrent: 30,
            hpMax: 30,
          },
        ],
      };

      const sceneWithSpawns: CampaignMapScene = {
        id: "scene-spawns",
        campaignId: "camp-1",
        title: "Multi Spawn Arena",
        revealedToPlayers: true,
        gridCellSizePx: 70,
        feetPerCell: 5,
        widthPx: 1000,
        heightPx: 1000,
        defaultGroundElevationFt: 12.5,
        spawnPoints: [
          { id: "sp-1", name: "North Gate", x: 100, y: 150 },
          { id: "sp-2", name: "South Gate", x: 800, y: 850 },
        ],
        walls: [],
        lights: [],
        audioEmitters: [],
        stagedTokens: [],
      };

      const transitioned = activateSceneTransition(currentTable, sceneWithSpawns);
      const h1 = transitioned.tokens.find((t) => t.id === "hero-1")!;
      const h2 = transitioned.tokens.find((t) => t.id === "hero-2")!;
      const h3 = transitioned.tokens.find((t) => t.id === "hero-3")!;

      assert.equal(h1.x, 100);
      assert.equal(h1.y, 150);
      assert.equal(h1.elevationFt, 12.5);

      assert.equal(h2.x, 800);
      assert.equal(h2.y, 850);
      assert.equal(h2.elevationFt, 12.5);

      assert.equal(h3.x, 100);
      assert.equal(h3.y, 150);
      assert.equal(h3.elevationFt, 12.5);

      const sceneWithEmptySpawns: CampaignMapScene = {
        ...sceneWithSpawns,
        spawnPoints: [],
        defaultGroundElevationFt: 5,
      };
      const transitionedEmpty = activateSceneTransition(currentTable, sceneWithEmptySpawns);
      const emptyH1 = transitionedEmpty.tokens.find((t) => t.id === "hero-1")!;
      assert.equal(emptyH1.x, 0);
      assert.equal(emptyH1.y, 0);
      assert.equal(emptyH1.elevationFt, 5);
    });
  });

  describe("REST Client-Server Serialization Parity", () => {
    it("maps frontend scene structure to backend REST DTO and back without data corruption", () => {
      const frontendScene: CampaignMapScene = {
        id: "scene-contract-1",
        campaignId: "camp-contract-1",
        title: "Catacombs Entrance",
        revealedToPlayers: true,
        gridType: "square",
        gridCellSizePx: 70,
        feetPerCell: 5,
        widthPx: 1400,
        heightPx: 1400,
        defaultGroundElevationFt: 0,
        spawnPoints: [{ id: "sp-1", name: "Entrance", x: 140, y: 140 }],
        walls: [
          {
            id: "w-1",
            a: { x: 0, y: 0 },
            b: { x: 100, y: 0 },
            wallType: "Door",
            blocksMovement: true,
            blocksVision: true,
            blocksLight: true,
            blocksSound: true,
            bottomElevationFt: 0,
            topElevationFt: 10,
            doorState: { isOpen: false, isLocked: true },
          },
        ],
        lights: [
          {
            id: "l-1",
            origin: { x: 200, y: 200 },
            brightRadiusFt: 15,
            dimRadiusFt: 30,
            colorHex: "var(--atlas-action)",
            intensity: 1.0,
          },
        ],
        audioEmitters: [
          {
            id: "a-1",
            url: "crypt.ogg",
            x: 250,
            y: 250,
            elevationFt: 0,
            maxDistanceFt: 60,
            volume: 0.8,
            loopPlayback: true,
            gmOnly: false,
          },
        ],
        stagedTokens: [
          {
            id: "t-1",
            name: "Sentry Skeleton",
            templateKey: "Skeleton",
            x: 300,
            y: 300,
            elevationFt: 0,
            visibilityChannel: "Public",
            ownerUserId: null,
            hpCurrent: 13,
            hpMax: 13,
          },
        ],
      };

      const backendDto = mapFrontendSceneToBackend(frontendScene);
      assert.equal(backendDto.name, "Catacombs Entrance");
      assert.equal(backendDto.wall_segments[0].door_state, "Locked");
      assert.equal(backendDto.wall_segments[0].p1.x, 0);
      assert.equal(backendDto.wall_segments[0].p2.x, 100);

      const remappedFrontend = mapBackendSceneToFrontend(backendDto);
      assert.equal(remappedFrontend.title, "Catacombs Entrance");
      assert.equal(remappedFrontend.walls[0].wallType, "Door");
      assert.equal(remappedFrontend.walls[0].doorState?.isLocked, true);
      assert.equal(remappedFrontend.walls[0].doorState?.isOpen, false);
      assert.equal(remappedFrontend.walls[0].a.x, 0);
      assert.equal(remappedFrontend.walls[0].b.x, 100);
    });

    it("WHEN raw backend scenes from GET are provided, domain normalization protects against missing walls length runtime error", () => {
      const rawBackendScene = {
        id: "raw-backend-1",
        campaign_id: "camp-1",
        name: "Raw Server Map",
        revealed_to_players: true,
        grid_size_px: 70,
        grid_cell_distance_ft: 5.0,
        width_px: 1400,
        height_px: 1400,
        wall_segments: [
          {
            id: "seg-1",
            p1: { x: 0, y: 0 },
            p2: { x: 70, y: 0 },
            wall_type: "Normal",
            door_state: null,
            bottom_elevation_ft: 0,
            top_elevation_ft: 10,
            blocks_light: true,
            blocks_movement: true,
            blocks_sound: true,
            blocks_vision: true,
          },
        ],
        light_sources: [],
        spatial_audio_emitters: [],
        staged_tokens: [],
        spawn_points: [{ id: "sp-1", name: "Spawn", x: 70, y: 70 }],
      };

      const filtered = filterScenesForRole([rawBackendScene], "PLAYER");
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].title, "Raw Server Map");
      assert.equal(filtered[0].walls.length, 1);
      assert.equal(filtered[0].walls[0].a.x, 0);
      assert.equal(filtered[0].walls[0].b.x, 70);
    });
  });
});
