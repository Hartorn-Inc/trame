import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DND5E_2024_MANIFEST,
  SRD_STARTER_ACTIONS,
  applyLongRest,
  applyShortRest,
  computeDnd5eSheetDerived,
  createAdultRedDragonSheet,
  resolveActionPipeline,
  rollDeathSavingThrow,
  tryRechargeMonsterAbility,
} from "../src/systems/dnd5e/index.ts";
import {
  DualBufferFogOfWar,
  RADIAL_LIGHT_GLSL_FRAG,
  RADIAL_LIGHT_WGSL_FRAG,
  packLightUniformBuffer,
} from "../src/canvas/LightingShader.ts";
import {
  TACTICAL_SCENE_LAYERS,
  ViewportCamera,
  measureRulerWaypointsFt,
} from "../src/canvas/SceneGraph.ts";
import {
  computeVisibilityPolygon,
  previewSphereAoeCells,
} from "../src/engine/wasmBridge.ts";
import { TableClientStore } from "../src/store/tableStore.ts";

describe("[F3] @trame/game-system-dnd5e canonical rules & pipeline", () => {
  it("computes derived stats, skill expertise, and exhaustion penalties across parameterized levels", () => {
    const cases = [
      { level: 1, exhaustion: 0, expectedPb: 2, expectedPerception: 15, expectedDc: 15 },
      { level: 5, exhaustion: 0, expectedPb: 3, expectedPerception: 17, expectedDc: 16 },
      { level: 17, exhaustion: 2, expectedPb: 6, expectedPerception: 19, expectedDc: 15 },
    ];

    for (const tc of cases) {
      const dragon = createAdultRedDragonSheet();
      dragon.level = tc.level;
      dragon.exhaustionLevel = tc.exhaustion;
      const derived = computeDnd5eSheetDerived(dragon);

      assert.equal(derived.proficiencyBonus, tc.expectedPb);
      assert.equal(derived.passivePerception, tc.expectedPerception);
      assert.equal(derived.spellSaveDc, tc.expectedDc);
      assert.equal(DND5E_2024_MANIFEST.skills.length, 18);
    }
  });

  it("executes Fireball upcasting, Legendary Resistance auto-success, and Monster Recharge 5-6", () => {
    const wizard = createAdultRedDragonSheet("wizard-1");
    wizard.spellcastingAbility = "int";
    wizard.abilities.int = 20; // +5 mod
    wizard.level = 9; // +4 PB -> DC 17
    wizard.resources.spell_slot_3 = {
      id: "spell_slot_3",
      label: "3rd-Level Slot",
      current: 2,
      max: 3,
      recovery: "long_rest",
    };

    const dragonTarget = createAdultRedDragonSheet("dragon-boss");
    dragonTarget.tempHp = 10;

    // Dragon rolls a 2 on DEX save (+6 DEX save = 8 < DC 17), but spends 1 Legendary Resistance!
    const outcomes = resolveActionPipeline(
      wizard,
      SRD_STARTER_ACTIONS.fireball,
      [
        {
          target: dragonTarget,
          saveD20Roll: 2,
          useLegendaryResistanceIfFailed: true,
        },
      ],
      5, // Upcast at 5th level (+7 base damage -> 35 total, half on save = 17)
    );

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].usedLegendaryResistance, true);
    assert.equal(outcomes[0].hitOrFailedSave, false);
    assert.equal(outcomes[0].damageApplied, 17);
    assert.equal(dragonTarget.resources.legendary_resistance.current, 2);
    // 10 absorbed by tempHp, 7 applied to HP (256 - 7 = 249)
    assert.equal(dragonTarget.tempHp, 0);
    assert.equal(dragonTarget.hpCurrent, 249);

    // Spend Fire Breath and test Recharge 5-6
    dragonTarget.resources.fire_breath.current = 0;
    assert.equal(tryRechargeMonsterAbility(dragonTarget.resources.fire_breath, 4), false);
    assert.equal(tryRechargeMonsterAbility(dragonTarget.resources.fire_breath, 5), true);
    assert.equal(dragonTarget.resources.fire_breath.current, 1);
  });

  it("handles Short Rest, Long Rest hit dice recovery, and Death Saving Throws", () => {
    const fighter = createAdultRedDragonSheet("fighter-1");
    fighter.hpMax = 100;
    fighter.hpCurrent = 40;
    fighter.hitDiceMax = 8;
    fighter.hitDiceCurrent = 2;
    fighter.exhaustionLevel = 2;

    const shortRes = applyShortRest(fighter, [8, 6]);
    assert.equal(shortRes.hitDiceSpent, 2);
    assert.ok(shortRes.hpRecovered > 0);
    assert.equal(fighter.hitDiceCurrent, 0);

    const longRes = applyLongRest(fighter);
    assert.equal(fighter.hpCurrent, 100);
    assert.equal(longRes.hitDiceRecovered, 4); // half of 8
    assert.equal(fighter.exhaustionLevel, 1);

    // Death save parameterized checks: nat 1 -> 2 failures, nat 20 -> 1 HP conscious
    fighter.hpCurrent = 0;
    rollDeathSavingThrow(fighter, 1);
    assert.equal(fighter.deathSaves.failures, 2);
    rollDeathSavingThrow(fighter, 20);
    assert.equal(fighter.hpCurrent, 1);
    assert.equal(fighter.deathSaves.isStable, true);
  });
});

describe("[F4] @trame/web PixiJS v8 SceneGraph, Shaders, WASM Bridge & Optimistic Store", () => {
  it("computes client-side visibility polygons and wall-clipped AoE discretization", () => {
    const walls = [
      {
        id: "wall-1",
        a: { x: 150, y: 0 },
        b: { x: 150, y: 300 },
        blocksVision: true,
        bottomElevationFt: 0,
        topElevationFt: 10,
      },
    ];

    const poly = computeVisibilityPolygon(walls, { x: 50, y: 150 }, 5, 400);
    assert.ok(poly.length >= 36);
    // Every vertex to the right of x=150 must have been clipped at x <= 150.001
    for (const pt of poly) {
      if (Math.abs(pt.y - 150) < 40 && pt.x > 50) {
        assert.ok(pt.x <= 150.01, `Ray leaked past wall: x=${pt.x}`);
      }
    }

    const cellsClipped = previewSphereAoeCells(
      { x: 100, y: 150 },
      20,
      100,
      5,
      "CENTER_POINT",
      true,
      walls,
    );
    assert.ok(cellsClipped.every((c) => c.col < 2), "Wall at x=150 blocks col >= 2 centers");
  });

  it("maintains 7-layer scene graph order, zoom-at-cursor invariant, and dual-buffer Fog of War", () => {
    assert.equal(TACTICAL_SCENE_LAYERS.length, 7);
    assert.equal(TACTICAL_SCENE_LAYERS[0], "backgroundMap");
    assert.equal(TACTICAL_SCENE_LAYERS[6], "uiControlHud");

    const cam = new ViewportCamera();
    const cursor = { x: 400, y: 300 };
    const worldBefore = cam.screenToWorld(cursor);
    cam.zoomAtCursor(2.0, cursor.x, cursor.y);
    const worldAfter = cam.screenToWorld(cursor);
    assert.ok(Math.abs(worldBefore.x - worldAfter.x) < 1e-6);
    assert.ok(Math.abs(worldBefore.y - worldAfter.y) < 1e-6);

    assert.equal(
      measureRulerWaypointsFt(
        [
          { x: 0, y: 0 },
          { x: 300, y: 400 },
        ],
        100,
        5,
        true,
      ),
      50, // 5 cells * 5ft * 2 (squeezing) = 50 ft
    );

    const fog = new DualBufferFogOfWar();
    assert.equal(fog.getCellOverlayAlpha(1, 1), 1.0);
    fog.updateVisibleCells([{ col: 1, row: 1 }]);
    assert.equal(fog.getCellOverlayAlpha(1, 1), 0.0);
    fog.updateVisibleCells([{ col: 2, row: 2 }]);
    assert.equal(fog.getCellOverlayAlpha(1, 1), 0.65);

    const ubo = packLightUniformBuffer({
      origin: { x: 120, y: 240 },
      brightRadiusPx: 200,
      dimRadiusPx: 400,
      rgb: [1.0, 0.85, 0.6],
      intensity: 1.0,
      isDarkvisionMonochrome: false,
    });
    assert.equal(ubo.length, 8);
    assert.ok(RADIAL_LIGHT_GLSL_FRAG.includes("smoothstep"));
    assert.ok(RADIAL_LIGHT_WGSL_FRAG.includes("smoothstep"));
  });

  it("rolls back optimistic token movement when server rejects a command", () => {
    const store = new TableClientStore();
    store.applySnapshot(1, [
      { id: "tok-1", name: "Rogue", topLeft: { x: 100, y: 100 }, hp: 25, maxHp: 25 },
    ]);

    store.beginOptimisticTokenMove("tok-1", { x: 500, y: 100 });
    assert.deepEqual(store.getToken("tok-1")?.topLeft, { x: 500, y: 100 });

    store.rollbackRejectedCommand("movement blocked by wall");
    assert.deepEqual(store.getToken("tok-1")?.topLeft, { x: 100, y: 100 });
    assert.equal(store.getLastRejectionReason(), "movement blocked by wall");
  });
});
