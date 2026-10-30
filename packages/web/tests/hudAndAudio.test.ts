import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_CONCURRENT_RAYCASTS,
  SpatialAudioManager,
  compute3DDistance,
  computeDistanceAttenuation,
  computeOcclusionLowPassCutoff,
  countSoundOccludingWalls,
} from "../src/audio/spatialAudio.ts";
import { DualBufferFogOfWar } from "../src/canvas/LightingShader.ts";
import { measureRulerWaypointsFt } from "../src/canvas/SceneGraph.ts";
import { type DrawingEntity, convertDrawingToWallSegments } from "../src/engine/wasmBridge.ts";
import {
  CombatTrackerManager,
  type CombatTokenState,
  computeServerTimeOffset,
} from "../src/hud/combatTracker.ts";
import { AMBIENT_PRESETS, GmOverrideToolbarManager } from "../src/hud/gmOverrideToolbar.ts";
import { TableClientStore } from "../src/store/tableStore.ts";

describe("[E4] 3D Spatial Audio & Wall Occlusion Low-Pass Cutoff", () => {
  it("Test 6.1.1: computes 3D Euclidean distance with elevation Delta Z", () => {
    const cases = [
      { emitter: { x: 0, y: 0, elevationFt: 0 }, listener: { x: 30, y: 40, elevationFt: 120 }, expected: 130 },
      { emitter: { x: 10, y: 20, elevationFt: 5 }, listener: { x: 10, y: 20, elevationFt: 35 }, expected: 30 },
      { emitter: { x: 0, y: 0, elevationFt: 10 }, listener: { x: 6, y: 8, elevationFt: 10 }, expected: 10 },
    ];

    for (const tc of cases) {
      const dist = compute3DDistance(tc.emitter, tc.listener);
      assert.equal(Math.round(dist * 100) / 100, tc.expected);
    }
  });

  it("Test 6.1.2: computes free-field inverse distance attenuation gain", () => {
    const cases = [
      { dist: 10, ref: 10, rolloff: 1, expected: 1.0 },
      { dist: 5, ref: 10, rolloff: 1, expected: 1.0 },
      { dist: 50, ref: 10, rolloff: 1, expected: 0.2 },
      { dist: 100, ref: 20, rolloff: 2, expected: 20 / (20 + 2 * 80) },
    ];

    for (const tc of cases) {
      const gain = computeDistanceAttenuation(tc.dist, tc.ref, tc.rolloff);
      assert.ok(Math.abs(gain - tc.expected) < 1e-6, `Gain mismatch: got ${gain}, expected ${tc.expected}`);
    }
  });

  it("Test 6.1.3: verifies deterministic low-pass cutoff frequencies by wall count", () => {
    const cases = [
      { walls: 0, expected: 20000.0 },
      { walls: 1, expected: 4444.44 },
      { walls: 2, expected: 2500.0 },
      { walls: 4, expected: 1333.33 },
    ];

    for (const tc of cases) {
      const cutoff = computeOcclusionLowPassCutoff(tc.walls);
      assert.equal(cutoff, tc.expected, `Cutoff for ${tc.walls} walls should equal ${tc.expected}`);
    }
  });

  it("Test 6.1.4: caps concurrent acoustic raycasts at 16 emitters", () => {
    const manager = new SpatialAudioManager();
    manager.updateListener({ x: 0, y: 0, elevationFt: 0 });

    for (let i = 0; i < 20; i++) {
      manager.upsertEmitter({
        id: `emitter-${i}`,
        url: `sound-${i}.mp3`,
        x: 10 * (i + 1),
        y: 10 * (i + 1),
        elevationFt: 0,
        maxDistanceFt: 200,
        refDistanceFt: 10,
        rolloff: 1.0,
        loopPlayback: true,
        volume: 0.8,
      });
    }

    assert.equal(manager.getEmitters().length, 20);
    assert.equal(MAX_CONCURRENT_RAYCASTS, 16);

    const testWall = {
      id: "wall-1",
      a: { x: 5, y: -50 },
      b: { x: 5, y: 50 },
      blocksVision: true,
      blocksSound: true,
      bottomElevationFt: -100,
      topElevationFt: 100,
    };

    manager.updateOcclusionAndAttenuation([testWall]);
    assert.equal(manager.getLastCycleRaycastCount(), 16);

    const emitter19 = manager.getEmitterState("emitter-19");
    assert.ok(emitter19 !== undefined);
    assert.ok(emitter19.cutoffFrequency > 0);
  });

  it("prioritizes nearest 16 emitters by distance and keeps cached cutoff for subsequent emitters", () => {
    const manager = new SpatialAudioManager();
    manager.updateListener({ x: 0, y: 0, elevationFt: 0 });

    manager.upsertEmitter({
      id: "emitter-far-early",
      url: "far.mp3",
      x: 500,
      y: 0,
      elevationFt: 0,
      maxDistanceFt: 1000,
      refDistanceFt: 10,
      rolloff: 1.0,
      loopPlayback: true,
      volume: 1.0,
    });

    for (let i = 0; i < 16; i++) {
      manager.upsertEmitter({
        id: `emitter-near-${i}`,
        url: `near-${i}.mp3`,
        x: 10 * (i + 1),
        y: 0,
        elevationFt: 0,
        maxDistanceFt: 200,
        refDistanceFt: 10,
        rolloff: 1.0,
        loopPlayback: true,
        volume: 0.8,
      });
    }

    const wall = {
      id: "wall-occlude",
      a: { x: 5, y: -50 },
      b: { x: 5, y: 50 },
      blocksVision: true,
      blocksSound: true,
      bottomElevationFt: -100,
      topElevationFt: 100,
    };

    manager.updateOcclusionAndAttenuation([wall]);
    assert.equal(manager.getLastCycleRaycastCount(), 16);

    for (let i = 0; i < 16; i++) {
      const state = manager.getEmitterState(`emitter-near-${i}`);
      assert.equal(state?.cutoffFrequency, 4444.44);
    }

    const farState = manager.getEmitterState("emitter-far-early");
    assert.equal(farState?.cutoffFrequency, 20000.0);
  });
});

describe("[E4] 3D Elevation Ruler Non-Blocking Calculations", () => {
  it("Test 6.2.1: measures 5-5-5 metric (Chebyshev 3D)", () => {
    const dist = measureRulerWaypointsFt(
      [
        { x: 0, y: 0, elevationFt: 0 },
        { x: 15, y: 25, elevationFt: 40 },
      ],
      1,
      1,
      "FIVE_FIVE_FIVE",
    );
    assert.equal(dist, 40.0);
  });

  it("Test 6.2.2: measures 5-10-5 metric with 3D hypotenuse", () => {
    const dist = measureRulerWaypointsFt(
      [
        { x: 0, y: 0, elevationFt: 0 },
        { x: 10, y: 10, elevationFt: 20 },
      ],
      1,
      1,
      "5-10-5",
    );
    assert.equal(dist, 25.0);
  });

  it("Test 6.2.3: measures 3D Euclidean metric", () => {
    const dist = measureRulerWaypointsFt(
      [
        { x: 0, y: 0, elevationFt: 0 },
        { x: 6, y: 8, elevationFt: 24 },
      ],
      1,
      1,
      "EUCLIDEAN",
    );
    assert.equal(dist, 26.0);
  });
});

describe("[E4] Combat Tracker, Action Economy & 5-Second Reaction Window", () => {
  it("progresses initiative turns, tracks action badges, and increments round", () => {
    const tracker = new CombatTrackerManager();
    const paladin: CombatTokenState = {
      id: "tok-paladin",
      name: "Paladin",
      initiative: 18,
      elevationFt: 0,
      actionAvailable: true,
      bonusActionAvailable: true,
      reactionAvailable: true,
      speedRemainingFt: 30,
      speedMaxFt: 30,
    };
    const goblin: CombatTokenState = {
      id: "tok-goblin",
      name: "Goblin",
      initiative: 12,
      elevationFt: 0,
      actionAvailable: true,
      bonusActionAvailable: true,
      reactionAvailable: true,
      speedRemainingFt: 30,
      speedMaxFt: 30,
    };

    tracker.setTableMode("TURN_BY_TURN");
    tracker.setInitiativeOrder([goblin, paladin]);

    assert.equal(tracker.getState().mode, "TURN_BY_TURN");
    assert.equal(tracker.getState().activeTokenId, "tok-paladin");
    assert.equal(tracker.getState().round, 1);

    assert.equal(tracker.spendAction("tok-paladin", "ACTION"), true);
    assert.equal(tracker.spendAction("tok-paladin", "ACTION"), false);
    assert.equal(tracker.spendAction("tok-paladin", "MOVEMENT", -10), false);
    assert.equal(tracker.spendAction("tok-paladin", "MOVEMENT", 15), true);

    const stateAfterSpend = tracker.getState();
    const paladinAfter = stateAfterSpend.tokens.find((t) => t.id === "tok-paladin");
    assert.equal(paladinAfter?.actionAvailable, false);
    assert.equal(paladinAfter?.speedRemainingFt, 15);

    tracker.nextTurn();
    assert.equal(tracker.getState().activeTokenId, "tok-goblin");
    assert.equal(tracker.getState().round, 1);

    tracker.nextTurn();
    assert.equal(tracker.getState().activeTokenId, "tok-paladin");
    assert.equal(tracker.getState().round, 2);

    const paladinRefreshed = tracker.getState().tokens.find((t) => t.id === "tok-paladin");
    assert.equal(paladinRefreshed?.actionAvailable, true);
    assert.equal(paladinRefreshed?.speedRemainingFt, 30);

    tracker.spendAction("tok-paladin", "ACTION");
    tracker.spendAction("tok-paladin", "MOVEMENT", 20);
    tracker.syncToken({ id: "tok-paladin", actionAvailable: true, speedRemainingFt: 30 });
    const paladinSynced = tracker.getState().tokens.find((t) => t.id === "tok-paladin");
    assert.equal(paladinSynced?.actionAvailable, true);
    assert.equal(paladinSynced?.speedRemainingFt, 30);
  });

  it("Test 6.3.1: manages 5-second reaction window countdown decay and timeout", () => {
    const tracker = new CombatTrackerManager();
    const now = 1_000_000;
    tracker.openReaction({
      triggerId: 101,
      actorId: "tok-rogue",
      reactionType: "UncannyDodge",
      expiresAtMs: now + 5000,
      reachDistanceFt: 5,
    });

    assert.equal(tracker.getRemainingReactionMs(now, 0), 5000);
    assert.equal(tracker.getRemainingReactionMs(now + 2000, 0), 3000);
    assert.equal(tracker.getRemainingReactionMs(now + 5000, 0), 0);
    assert.equal(tracker.getActiveReaction(), null);
    assert.equal(tracker.declareReaction(101, true).wasInterrupted, false);
    assert.equal(tracker.toggleReactionPause(101, now + 5000, 0), false);
  });

  it("Test 6.3.2: resolves reaction immediately upon GM force, dismiss, or server event", () => {
    const tracker = new CombatTrackerManager();
    const now = 500_000;
    tracker.openReaction({
      triggerId: 202,
      actorId: "tok-fighter",
      reactionType: "OpportunityAttack",
      expiresAtMs: now + 5000,
    });

    assert.ok(tracker.getActiveReaction() !== null);
    const result = tracker.forceReaction(202);
    assert.equal(result.wasInterrupted, true);
    assert.equal(tracker.getActiveReaction(), null);

    tracker.openReaction({
      triggerId: 203,
      actorId: "tok-wizard",
      reactionType: "Shield",
      expiresAtMs: now + 5000,
    });
    tracker.handleServerInterruptResolved(203, false);
    assert.equal(tracker.getActiveReaction(), null);
    assert.equal(tracker.declareReaction(203, true).wasInterrupted, false);
    assert.equal(tracker.toggleReactionPause(203, now + 1000, 0), false);
  });

  it("computes server time offset for client synchronization", () => {
    const clientSend = 1000;
    const serverRecv = 1050;
    const serverSend = 1055;
    const clientRecv = 1105;
    const offset = computeServerTimeOffset(clientSend, serverRecv, serverSend, clientRecv);
    assert.equal(offset, 0);
  });
});

describe("[E4] GM Override Toolbar, Day/Night Presets & 1-Click Undo", () => {
  it("overrides HP, temp HP, spell slots, death saves, and refunds action resources", () => {
    const toolbar = new GmOverrideToolbarManager();
    const token = {
      hp: 20,
      maxHp: 30,
      tempHp: 5,
      spellSlots: [4, 3, 2],
      deathSaves: { successes: 0, failures: 0 },
    };

    toolbar.overrideHpAndResources(token, {
      hp: 35,
      tempHp: 10,
      spellSlotsDelta: [-1, 0, 1],
      deathSaves: { successes: 2, failures: 1 },
    });

    assert.equal(token.hp, 30);
    assert.equal(token.tempHp, 10);
    assert.deepEqual(token.spellSlots, [3, 3, 3]);
    assert.deepEqual(token.deathSaves, { successes: 2, failures: 1 });

    const economyToken = {
      actionAvailable: false,
      bonusActionAvailable: false,
      reactionAvailable: false,
      speedRemainingFt: 10,
      speedMaxFt: 30,
    };
    toolbar.refundAction(economyToken, "ACTION");
    toolbar.refundAction(economyToken, "MOVEMENT", 20);
    assert.equal(economyToken.actionAvailable, true);
    assert.equal(economyToken.speedRemainingFt, 30);
  });

  it("teleports tokens without movement penalty and cycles Day/Night presets", () => {
    const toolbar = new GmOverrideToolbarManager();
    const token = { topLeft: { x: 50, y: 50 }, elevationFt: 0 };
    const { prevPos, newPos } = toolbar.teleportToken(token, 200, 300, 15);

    assert.deepEqual(prevPos, { x: 50, y: 50 });
    assert.deepEqual(newPos, { x: 200, y: 300 });
    assert.equal(token.elevationFt, 15);

    assert.equal(toolbar.setAmbientPreset("DUSK").ambientLight, 0.45);
    assert.equal(toolbar.setAmbientPreset("NIGHT_MOONLIGHT").ambientLight, 0.15);
    assert.equal(toolbar.setAmbientPreset("PITCH_DARKNESS").ambientLight, 0.0);
    assert.equal(toolbar.setAmbientPreset("DAYLIGHT").ambientLight, 1.0);
    assert.equal(AMBIENT_PRESETS.DAYLIGHT.tint, "#ffffff");
  });

  it("Test 6.4.1: manages 50-entry bounded undo ring buffer and restores token state", () => {
    const store = new TableClientStore();
    store.applySnapshot(1, [
      { id: "tok-rogue", name: "Rogue", topLeft: { x: 0, y: 0 }, hp: 20, maxHp: 20, speedRemainingFt: 30 },
    ]);
    const tracker = store.getCombatTracker();
    tracker.setInitiativeOrder([
      {
        id: "tok-rogue",
        name: "Rogue",
        initiative: 15,
        elevationFt: 0,
        actionAvailable: true,
        bonusActionAvailable: true,
        reactionAvailable: true,
        speedRemainingFt: 30,
        speedMaxFt: 30,
      },
    ]);

    store.pushUndo({
      snapshotId: "snap-1",
      description: "Move Rogue 30ft",
      author: "Player",
      timestamp: 1000,
    });
    assert.equal(store.getGmOverride().canUndo(), true);

    store.beginOptimisticTokenMove("tok-rogue", { x: 30, y: 0 });
    tracker.spendAction("tok-rogue", "MOVEMENT", 30);
    assert.deepEqual(store.getToken("tok-rogue")?.topLeft, { x: 30, y: 0 });
    assert.equal(tracker.getState().tokens[0].speedRemainingFt, 0);

    store.applyActionUndone("snap-1", [
      { id: "tok-rogue", name: "Rogue", topLeft: { x: 0, y: 0 }, hp: 20, maxHp: 20, speedRemainingFt: 30 },
    ]);
    assert.deepEqual(store.getToken("tok-rogue")?.topLeft, { x: 0, y: 0 });
    assert.equal(store.getToken("tok-rogue")?.speedRemainingFt, 30);
    assert.equal(tracker.getState().tokens[0].speedRemainingFt, 30);

    for (let i = 0; i < 60; i++) {
      store.pushUndo({
        snapshotId: `snap-${i}`,
        description: `Action ${i}`,
        author: "GM",
        timestamp: 2000 + i,
      });
    }
    assert.equal(store.getGmOverride().getUndoHistory().length, 50);
  });

  it("Test 6.4.2: executes transactional rollback of DualBufferFogOfWar FBO on undo", () => {
    const fog = new DualBufferFogOfWar();
    const store = new TableClientStore();
    store.setFogOfWar(fog);

    fog.captureSnapshot("pre-move-snap");
    assert.equal(fog.getCellOverlayAlpha(5, 5), 1.0);

    fog.updateVisibleCells([{ col: 5, row: 5 }]);
    assert.equal(fog.getCellOverlayAlpha(5, 5), 0.0);

    store.applyActionUndone("pre-move-snap");
    assert.equal(fog.getCellState(5, 5), "UNEXPLORED");
    assert.equal(fog.getCellOverlayAlpha(5, 5), 1.0);
  });
});

describe("[E4] Table Tools: Radar Pings & Vector Drawing Walls", () => {
  it("emits radar pings with 1.5s lifespan and exponential opacity falloff", () => {
    const store = new TableClientStore();
    const now = 10_000;
    const ping = store.addRadarPing({
      x: 150,
      y: 250,
      pingType: "Alert",
      timestamp: now,
    });

    assert.equal(ping.pingType, "ALERT");
    assert.equal(store.getActiveRadarPings(now).length, 1);
    assert.ok(Math.abs(store.getRadarPingOpacity(ping, now) - 1.0) < 1e-4);
    assert.ok(store.getRadarPingOpacity(ping, now + 750) < 0.3);
    assert.equal(store.getRadarPingOpacity(ping, now + 1500), 0.0);
    assert.equal(store.getActiveRadarPings(now + 1501).length, 0);
  });

  it("converts vector drawings with has_physical_walls into sound and vision blocking walls", () => {
    const drawing: DrawingEntity = {
      id: "poly-wall",
      points: [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      color: "#ff0000",
      lineWidth: 2,
      isClosed: true,
      hasPhysicalWalls: true,
    };

    const wallSegments = convertDrawingToWallSegments(drawing, 0, 15);
    assert.equal(wallSegments.length, 3);
    for (const w of wallSegments) {
      assert.equal(w.blocksVision, true);
      assert.equal(w.blocksMovement, true);
      assert.equal(w.blocksSound, true);
      assert.equal(w.bottomElevationFt, 0);
      assert.equal(w.topElevationFt, 15);
    }

    const nonPhysicalDrawing: DrawingEntity = {
      ...drawing,
      id: "poly-decor",
      hasPhysicalWalls: false,
    };
    assert.equal(convertDrawingToWallSegments(nonPhysicalDrawing).length, 0);
  });
});
