import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
