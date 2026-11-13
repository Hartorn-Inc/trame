import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import type { WireWallKind } from "../../src/api/wire.ts";
import { DARK_CANVAS_PALETTE } from "../../src/canvas/CanvasThemePalette.ts";
import { glyphPath, oneWayNormal, wallGlyphs } from "../../src/canvas/wallGlyphs.ts";
import { computeVisibilityPolygon, type Point2D } from "../../src/engine/wasmBridge.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { MapsStudioTab } from "../../src/maps/MapsStudioTab.tsx";
import { mapBackendSceneToFrontend, mapFrontendSceneToBackend } from "../../src/maps/domain.ts";
import type { CampaignMapScene } from "../../src/maps/types.ts";
import { flipOneWay, wallFromDrag } from "../../src/maps/wallDrawing.ts";
import { buildTableScene, isPointUnfogged } from "../../src/table/scene/tableScene.ts";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
import { GM_ID, PLAYER_ID, fullToken, mount, tableState } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const WALL_ID = "77777777-0000-4000-8000-000000000001";

describe("wallGlyphs: one-way normal mirrors the engine", () => {
  const cases = [
    { id: "a stored non-zero normal is kept", a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, stored: { x: 0, y: -1 }, expected: { x: 0, y: -1 } },
    { id: "a zero normal falls back to the left-hand perpendicular (left-to-right blocks going down)", a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, stored: { x: 0, y: 0 }, expected: { x: 0, y: 1 } },
    { id: "no normal on a top-to-bottom wall blocks sight going left", a: { x: 0, y: 0 }, b: { x: 0, y: 50 }, stored: null, expected: { x: -1, y: 0 } },
    { id: "a zero-length wall has no direction", a: { x: 5, y: 5 }, b: { x: 5, y: 5 }, stored: null, expected: { x: 0, y: 0 } },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual(oneWayNormal(c.a, c.b, c.stored), c.expected));
  }
});

describe("wallGlyphs: the one-way arrow points the way the engine lets sight pass", () => {
  const blocker = (a: Point2D, b: Point2D, kind: WireWallKind) => ({ id: WALL_ID, a, b, kind, blocksVision: true, bottomElevationFt: -1000, topElevationFt: 1000 });
  const cases = [
    { id: "editor wall with no stored normal, drawn left to right", a: { x: 0, y: 500 }, b: { x: 1000, y: 500 }, normal: { x: 0, y: 0 } },
    { id: "editor wall with no stored normal, drawn right to left", a: { x: 1000, y: 500 }, b: { x: 0, y: 500 }, normal: { x: 0, y: 0 } },
    { id: "explicit normal pointing up", a: { x: 0, y: 500 }, b: { x: 1000, y: 500 }, normal: { x: 0, y: -1 } },
    { id: "vertical wall with explicit normal pointing right", a: { x: 500, y: 0 }, b: { x: 500, y: 1000 }, normal: { x: 1, y: 0 } },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const [[wingA, tip]] = wallGlyphs("OneWay", c.a, c.b, c.normal);
      const mid = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 };
      const len = Math.hypot(tip.x - mid.x, tip.y - mid.y);
      const pass = { x: (tip.x - mid.x) / len, y: (tip.y - mid.y) / len };
      assert.ok(Math.hypot(wingA.x - mid.x, wingA.y - mid.y) > 0, "arrow has wings");
      const tail = { x: mid.x - pass.x * 100, y: mid.y - pass.y * 100 };
      const head = { x: mid.x + pass.x * 100, y: mid.y + pass.y * 100 };
      const walls = [blocker(c.a, c.b, { kind: "ONE_WAY", normal_x: c.normal.x, normal_y: c.normal.y })];
      const sees = (from: Point2D, to: Point2D) => isPointUnfogged({ color: 0, alpha: 1, vision: [computeVisibilityPolygon(walls, from, 5, 400)], reveal: [], hide: [], memory: [], memoryAlpha: 0 }, to);
      assert.equal(sees(tail, head), true, "from behind the arrow, sight crosses the wall");
      assert.equal(sees(head, tail), false, "from the arrow's side, the wall blocks");
    });
  }

  it("a terrain wall gets two parallel ticks across its middle, other kinds none", () => {
    const ticks = wallGlyphs("Terrain", { x: 0, y: 0 }, { x: 100, y: 0 });
    assert.equal(ticks.length, 2);
    for (const [p, q] of ticks) assert.equal(p.x, q.x, "tick is perpendicular to the wall");
    assert.notEqual(ticks[0][0].x, ticks[1][0].x, "the two ticks are apart");
    assert.deepEqual(wallGlyphs("Normal", { x: 0, y: 0 }, { x: 100, y: 0 }), []);
    assert.deepEqual(wallGlyphs("OneWay", { x: 3, y: 3 }, { x: 3, y: 3 }), []);
  });
});

describe("tableScene: wall glyphs are drawn for the GM only", () => {
  const cases = [
    { id: "the GM sees the one-way arrow", isGm: true, kind: { kind: "ONE_WAY", normal_x: 0, normal_y: 0 } as WireWallKind, glyphs: 2 },
    { id: "the GM sees the terrain ticks", isGm: true, kind: { kind: "TERRAIN" } as WireWallKind, glyphs: 2 },
    { id: "a player sees the styled stroke without the arrow", isGm: false, kind: { kind: "ONE_WAY", normal_x: 0, normal_y: 0 } as WireWallKind, glyphs: 0 },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const state = tableState({
        tokens: { a: fullToken("a", "Hero", { owner_user_id: c.isGm ? GM_ID : PLAYER_ID }) },
        walls: [{ id: WALL_ID, a: { x: 0, y: 100 }, b: { x: 200, y: 100 }, kind: c.kind, blocks_movement: true, blocks_vision: true, blocks_light: true, blocks_sound: true, bottom_elevation_ft: -1000, top_elevation_ft: 1000 }],
      });
      const scene = buildTableScene({ state, palette: DARK_CANVAS_PALETTE, isGm: c.isGm, selectedTokenId: null, activeTurnTokenId: null, previewPlayerView: false, reducedMotion: false, pings: [], nowMs: 0, geometry: null });
      assert.equal(scene.walls[0].glyphs.length, c.glyphs);
    });
  }
});

describe("maps studio: one-way walls keep the direction the GM sees", () => {
  it("a drawn one-way wall stores the engine default normal and flipping negates it", () => {
    const wall = wallFromDrag("w1", { x: 0, y: 0 }, { x: 70, y: 0 }, "OneWay", 0, 10)!;
    assert.deepEqual(wall.oneWayNormal, { x: 0, y: 1 });
    assert.deepEqual(flipOneWay(wall).oneWayNormal, { x: 0, y: -1 });
    assert.equal(wallFromDrag("w2", { x: 0, y: 0 }, { x: 70, y: 0 }, "Normal", 0, 10)!.oneWayNormal, undefined);
  });

  const scene = (normal?: Point2D): CampaignMapScene => ({
    id: "s1",
    campaignId: "c1",
    title: "Cliff",
    revealedToPlayers: false,
    gridCellSizePx: 70,
    feetPerCell: 5,
    widthPx: 700,
    heightPx: 700,
    walls: [{ id: WALL_ID, a: { x: 0, y: 70 }, b: { x: 140, y: 70 }, wallType: "OneWay", blocksMovement: true, blocksVision: true, blocksLight: true, blocksSound: true, bottomElevationFt: 0, topElevationFt: 10, oneWayNormal: normal }],
    lights: [],
    audioEmitters: [],
    stagedTokens: [],
  });

  const saves = [
    { id: "a flipped wall is saved with its explicit normal", normal: { x: 0, y: -1 }, expected: { kind: "ONE_WAY", normal_x: 0, normal_y: -1 } },
    { id: "a wall without a stored normal is saved with the drawn direction's normal", normal: undefined, expected: { kind: "ONE_WAY", normal_x: 0, normal_y: 1 } },
  ];
  for (const c of saves) {
    it(c.id, () => {
      const dto = mapFrontendSceneToBackend(scene(c.normal));
      assert.deepEqual(dto.wall_segments[0].kind, c.expected);
      assert.deepEqual(mapBackendSceneToFrontend(dto).walls[0].oneWayNormal, { x: c.expected.normal_x, y: c.expected.normal_y });
    });
  }

  it("the studio canvas draws the arrow and the Flip button turns it around", () => {
    const ui = mount(h(MapsStudioTab, { campaignId: "c1", userRole: "GM", initialScenes: [scene({ x: 0, y: 1 })] }));
    const before = ui.byTestId(`canvas-wall-glyph-${WALL_ID}`).getAttribute("d");
    assert.equal(before, glyphPath(wallGlyphs("OneWay", { x: 0, y: 70 }, { x: 140, y: 70 }, { x: 0, y: 1 })));
    assert.equal(ui.byTestId(`flip-wall-${WALL_ID}`).getAttribute("aria-label"), `Flip the direction of one-way wall ${WALL_ID}`);
    ui.click(`flip-wall-${WALL_ID}`);
    assert.equal(ui.byTestId(`canvas-wall-glyph-${WALL_ID}`).getAttribute("d"), glyphPath(wallGlyphs("OneWay", { x: 0, y: 70 }, { x: 140, y: 70 }, { x: 0, y: -1 })));
    assertPresent(ui.byTestId("studio-wall-glyph-hint"), "glyph legend");
    ui.unmount();
  });

  it("a normal wall has no glyph and no Flip button", () => {
    const s = scene();
    s.walls[0] = { ...s.walls[0], wallType: "Normal", oneWayNormal: undefined };
    const ui = mount(h(MapsStudioTab, { campaignId: "c1", userRole: "GM", initialScenes: [s] }));
    assertAbsent(ui.byTestId(`canvas-wall-glyph-${WALL_ID}`), "glyph");
    assertAbsent(ui.byTestId(`flip-wall-${WALL_ID}`), "flip button");
    ui.unmount();
  });
});
