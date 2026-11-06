import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectedTableState, WireTokenState, WireWallSegment } from "../../src/api/wire.ts";
import { DARK_CANVAS_PALETTE, LIGHT_CANVAS_PALETTE } from "../../src/canvas/CanvasThemePalette.ts";
import { computeTokenVisionPolygon, computeVisibilityPolygon, previewAoeCells, type Point2D } from "../../src/engine/wasmBridge.ts";
import {
  buildTableScene,
  dashPolyline,
  pingRing,
  PING_DURATION_MS,
  engineWalls,
  type SceneGeometry,
  type TableSceneInput,
} from "../../src/table/scene/tableScene.ts";
import { GOBLIN, HERO, PLAYER_ID, fullToken, publicToken, tableState } from "../helpers/liveTable.ts";

const WALL_ID = "dddddddd-0000-4000-8000-000000000001";

const wall = (kind: WireWallSegment["kind"], a: Point2D = { x: 0, y: 300 }, b: Point2D = { x: 1000, y: 300 }): WireWallSegment => ({
  id: WALL_ID,
  a,
  b,
  kind,
  blocks_movement: true,
  blocks_vision: true,
  blocks_light: true,
  blocks_sound: true,
  bottom_elevation_ft: -1000,
  top_elevation_ft: 1000,
});

const engine: SceneGeometry = {
  visibilityPolygon: computeVisibilityPolygon,
  tokenVisionPolygon: computeTokenVisionPolygon,
  aoeCells: previewAoeCells,
};

const hero = fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, top_left: { x: 100, y: 100 }, hp: 12, max_hp: 13 });

const input = (state: ProjectedTableState | null, overrides: Partial<TableSceneInput> = {}): TableSceneInput => ({
  state,
  palette: DARK_CANVAS_PALETTE,
  isGm: false,
  selectedTokenId: null,
  activeTurnTokenId: null,
  previewPlayerView: false,
  reducedMotion: false,
  pings: [],
  nowMs: 10_000,
  geometry: engine,
  ...overrides,
});

/** Ray-casting point-in-polygon test. */
function inside(polygon: Point2D[], p: Point2D): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

describe("buildTableScene: walls follow the projection", () => {
  const cases = [
    {
      id: "GM sees a closed secret door with the secret-door style",
      isGm: true,
      walls: [wall({ kind: "SECRET_DOOR", is_open: false })],
      expected: [{ kind: "SecretDoor", color: DARK_CANVAS_PALETTE.wallKinds.SecretDoor.strokeColorHex }],
    },
    {
      id: "player gets the server-masked NORMAL wall and draws it as plain masonry",
      isGm: false,
      walls: [wall({ kind: "NORMAL" })],
      expected: [{ kind: "Normal", color: DARK_CANVAS_PALETTE.wallKinds.Normal.strokeColorHex }],
    },
    { id: "a wall absent from the player projection is never drawn", isGm: false, walls: [], expected: [] },
    {
      id: "an open door is drawn at half alpha",
      isGm: false,
      walls: [wall({ kind: "DOOR", is_open: true, is_locked: false })],
      expected: [{ kind: "Door", color: DARK_CANVAS_PALETTE.wallKinds.Door.strokeColorHex }],
    },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const scene = buildTableScene(input(tableState({ walls: c.walls }), { isGm: c.isGm }));
      assert.deepEqual(
        scene.walls.map((w) => ({ kind: w.kind, color: w.color })),
        c.expected,
      );
    });
  }

  it("light theme swaps wall colours but keeps the dash pattern", () => {
    const scene = buildTableScene(input(tableState({ walls: [wall({ kind: "WINDOW" })] }), { palette: LIGHT_CANVAS_PALETTE }));
    assert.equal(scene.walls[0].color, LIGHT_CANVAS_PALETTE.wallKinds.Window.strokeColorHex);
    assert.deepEqual(scene.walls[0].dash, DARK_CANVAS_PALETTE.wallKinds.Window.dashPatternPx);
  });
});

describe("buildTableScene: token rings", () => {
  const cases = [
    { id: "UNHURT public token gets a solid focus ring", tier: "UNHURT", color: DARK_CANVAS_PALETTE.focusHex, style: "solid" },
    { id: "BLOODIED public token gets a dashed action ring", tier: "BLOODIED", color: DARK_CANVAS_PALETTE.actionHex, style: "dashed" },
    { id: "DOWN public token gets a double danger ring", tier: "DOWN", color: DARK_CANVAS_PALETTE.dangerHex, style: "double" },
  ] as const;
  for (const c of cases) {
    it(c.id, () => {
      const state = tableState({
        tokens: { [HERO]: hero },
        public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { bloodied: c.tier }) },
      });
      const goblin = buildTableScene(input(state)).tokens.find((tok) => tok.id === GOBLIN)!;
      assert.deepEqual([goblin.ring.color, goblin.ring.style, goblin.healthTier], [c.color, c.style, c.tier]);
    });
  }

  const owned = [
    { id: "player's own token gets the ally ring and no tier", isGm: false, owner: PLAYER_ID, ring: "ally" },
    { id: "GM sees a player-owned token as ally", isGm: true, owner: PLAYER_ID, ring: "ally" },
    { id: "GM sees an unowned NPC as hostile", isGm: true, owner: null, ring: "hostile" },
  ] as const;
  for (const c of owned) {
    it(c.id, () => {
      const state = tableState({ tokens: { [HERO]: { ...hero, owner_user_id: c.owner } } });
      const token = buildTableScene(input(state, { isGm: c.isGm })).tokens[0];
      assert.equal(token.ring.color, DARK_CANVAS_PALETTE.tokenDispositions[c.ring].ringColorHex);
      assert.equal(token.healthTier, null);
    });
  }

  const highlights = [
    { id: "selected token gets the selected ring", selected: HERO, active: null, kind: "selected" },
    { id: "active-turn token gets the active-turn ring", selected: null, active: HERO, kind: "activeTurn" },
    { id: "selection wins over the active turn", selected: HERO, active: HERO, kind: "selected" },
    { id: "no highlight otherwise", selected: null, active: null, kind: null },
  ] as const;
  for (const c of highlights) {
    it(c.id, () => {
      const token = buildTableScene(input(tableState({ tokens: { [HERO]: hero } }), { selectedTokenId: c.selected, activeTurnTokenId: c.active })).tokens[0];
      assert.equal(token.highlight?.color ?? null, c.kind ? DARK_CANVAS_PALETTE.tokenDispositions[c.kind].ringColorHex : null);
    });
  }
});

describe("buildTableScene: fog of war", () => {
  const cases = [
    { id: "GM sees the whole map", isGm: true, preview: false, fog: false, alpha: null, viewers: 0 },
    { id: "GM player-view preview dims with the players' fog", isGm: true, preview: true, fog: true, alpha: DARK_CANVAS_PALETTE.fogExploredDimAlpha, viewers: 1 },
    { id: "player gets opaque fog with one vision polygon per controlled token", isGm: false, preview: false, fog: true, alpha: 1, viewers: 1 },
    { id: "a player cannot request the GM's unfogged view", isGm: false, preview: true, fog: true, alpha: 1, viewers: 1 },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const npc = fullToken(GOBLIN, "Goblin", { top_left: { x: 500, y: 500 } });
      const tokens: Record<string, WireTokenState> = c.isGm ? { [HERO]: hero, [GOBLIN]: npc } : { [HERO]: hero };
      const fog = buildTableScene(input(tableState({ tokens }), { isGm: c.isGm, previewPlayerView: c.preview })).fog;
      assert.equal(fog !== null, c.fog);
      assert.equal(fog?.alpha ?? null, c.alpha);
      assert.equal(fog?.vision.length ?? 0, c.viewers);
    });
  }

  const sight = [
    { id: "a cell in the open room is visible", point: { x: 400, y: 150 }, visible: true },
    { id: "a cell behind the wall stays fogged", point: { x: 125, y: 500 }, visible: false },
  ];
  for (const c of sight) {
    it(`vision polygon from the controlled token (WASM): ${c.id}`, () => {
      const state = tableState({ tokens: { [HERO]: hero }, walls: [wall({ kind: "NORMAL" })] });
      const [polygon] = buildTableScene(input(state)).fog!.vision;
      assert.equal(inside(polygon, c.point), c.visible);
    });
  }

  it("without the engine a player sees only the token footprint (fail closed)", () => {
    const [polygon] = buildTableScene(input(tableState({ tokens: { [HERO]: hero } }), { geometry: null })).fog!.vision;
    assert.deepEqual(polygon, [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 150 }, { x: 100, y: 150 }]);
  });

  it("GM reveal / hide overrides become cell rectangles", () => {
    const state = tableState({
      tokens: { [HERO]: hero },
      fog_overrides: [
        { cell_x: 2, cell_y: 3, mode: "REVEAL" },
        { cell_x: 4, cell_y: 0, mode: "HIDE" },
        { cell_x: 9, cell_y: 9, mode: "CLEAR" },
      ],
    });
    const fog = buildTableScene(input(state)).fog!;
    assert.deepEqual([fog.reveal, fog.hide], [[{ x: 100, y: 150, w: 50, h: 50 }], [{ x: 200, y: 0, w: 50, h: 50 }]]);
  });
});

describe("engineWalls: every projected wall reaches the engine with its kind", () => {
  it("keeps windows and open doors instead of pre-filtering them", () => {
    const walls = [wall({ kind: "WINDOW" }), wall({ kind: "DOOR", is_open: true, is_locked: false })];
    assert.deepEqual(engineWalls(walls, "vision").map((w) => w.kind?.kind), ["WINDOW", "DOOR"]);
  });

  it("the light channel reads blocks_light as the opaque flag", () => {
    const [dto] = engineWalls([{ ...wall({ kind: "NORMAL" }), blocks_vision: true, blocks_light: false }], "light");
    assert.equal(dto.blocksVision, false);
  });
});

describe("buildTableScene: the engine resolves wall kinds and senses (WASM)", () => {
  const behind = { x: 125, y: 500 };
  const kinds = [
    { id: "a normal wall hides the far side", kind: { kind: "NORMAL" }, truesight: 0, visible: false },
    { id: "a window lets sight through", kind: { kind: "WINDOW" }, truesight: 0, visible: true },
    { id: "a closed door hides the far side", kind: { kind: "DOOR", is_open: false, is_locked: false }, truesight: 0, visible: false },
    { id: "an open door lets sight through", kind: { kind: "DOOR", is_open: true, is_locked: false }, truesight: 0, visible: true },
    { id: "an illusion blocks without truesight", kind: { kind: "ILLUSION", pierced_by_truesight: true }, truesight: 0, visible: false },
    { id: "truesight pierces a pierceable illusion", kind: { kind: "ILLUSION", pierced_by_truesight: true }, truesight: 120, visible: true },
  ] as const;
  for (const c of kinds) {
    it(c.id, () => {
      const senses = { normal_range_ft: 120, darkvision_range_ft: 0, blindsight_range_ft: 0, tremorsense_range_ft: 0, truesight_range_ft: c.truesight, devils_sight: false, see_invisibility: false };
      const state = tableState({ tokens: { [HERO]: { ...hero, senses } }, walls: [wall(c.kind)] });
      const [polygon] = buildTableScene(input(state)).fog!.vision;
      assert.equal(inside(polygon, behind), c.visible);
    });
  }

  const darkness = [
    { id: "pitch darkness without darkvision sees nothing beyond the token", darkvision: 0, point: { x: 400, y: 150 }, visible: false },
    { id: "pitch darkness with the token's own 60 ft darkvision sees nearby cells", darkvision: 60, point: { x: 400, y: 150 }, visible: true },
  ];
  for (const c of darkness) {
    it(c.id, () => {
      const senses = { normal_range_ft: 120, darkvision_range_ft: c.darkvision, blindsight_range_ft: 0, tremorsense_range_ft: 0, truesight_range_ft: 0, devils_sight: false, see_invisibility: false };
      const state = tableState({ ambient_lighting: "PITCH_DARKNESS", tokens: { [HERO]: { ...hero, senses } } });
      const [polygon] = buildTableScene(input(state)).fog!.vision;
      assert.equal(inside(polygon, c.point), c.visible);
    });
  }
});

describe("buildTableScene: difficult terrain and redacted fields", () => {
  it("difficult terrain cells become hatched cell rectangles", () => {
    const scene = buildTableScene(input(tableState({ difficult_terrain: [{ col: 1, row: 2 }] })));
    assert.deepEqual(scene.terrain.cells, [{ x: 50, y: 100, w: 50, h: 50 }]);
  });

  it("an AoE whose caster is hidden (concentration_caster_id: null) still renders", () => {
    const aoe = {
      id: WALL_ID,
      origin: { x: 100, y: 100 },
      origin_elevation_ft: 0,
      shape: { shape: "SPHERE", radius_ft: 10 },
      stops_at_walls: false,
      discretization: "CENTER_POINT",
      concentration_caster_id: null,
    };
    const scene = buildTableScene(input(tableState({ persistent_aoes: { [WALL_ID]: aoe } } as Partial<ProjectedTableState>)));
    assert.equal(scene.aoes.length, 1);
  });
});

describe("buildTableScene: ambient lighting and lights", () => {
  const light = { id: WALL_ID, position: { x: 500, y: 100 }, elevation_ft: 0, bright_radius_ft: 10, dim_radius_ft: 20, color_hex: "#FFAA44", intensity: 0.8 };
  const cases = [
    { id: "daylight draws no darkness and no lights", preset: "DAYLIGHT", alpha: 0, lights: 0 },
    { id: "pitch darkness draws a heavy overlay and the lights", preset: "PITCH_DARKNESS", alpha: 0.8, lights: 1 },
    { id: "an unknown preset falls back to daylight", preset: "ECLIPSE", alpha: 0, lights: 0 },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const scene = buildTableScene(input(tableState({ ambient_lighting: c.preset, lights: [light] })));
      assert.deepEqual([scene.ambient.alpha, scene.lights.length], [c.alpha, c.lights]);
    });
  }

  it("a light converts feet to pixels and is clipped by walls", () => {
    const scene = buildTableScene(input(tableState({ ambient_lighting: "NIGHT_MOONLIGHT", lights: [light], walls: [wall({ kind: "NORMAL" }, { x: 0, y: 150 }, { x: 1000, y: 150 })] })));
    const [lit] = scene.lights;
    assert.deepEqual([lit.brightPx, lit.dimPx, lit.rgb], [100, 200, [1, 0xaa / 255, 0x44 / 255]]);
    assert.ok(lit.polygon && lit.polygon.every((p) => p.y <= 150 + 1e-6), "light stops at the wall");
  });
});

describe("pings and reduced motion", () => {
  const ping = { senderUserId: PLAYER_ID, pos: { x: 10, y: 10 }, colorHex: "#80CBE2", receivedAtMs: 10_000 };
  const cases = [
    { id: "pulse starts small", now: 10_000, reduced: false, expected: { radiusPx: 12.5, alpha: 1 } },
    { id: "pulse grows and fades halfway", now: 10_000 + PING_DURATION_MS / 2, reduced: false, expected: { radiusPx: 43.75, alpha: 0.5 } },
    { id: "reduced motion holds a static ring", now: 10_000 + PING_DURATION_MS / 2, reduced: true, expected: { radiusPx: 37.5, alpha: 1 } },
    { id: "expired ping is invisible", now: 10_000 + PING_DURATION_MS, reduced: false, expected: { radiusPx: 0, alpha: 0 } },
  ];
  for (const c of cases) {
    it(`pingRing: ${c.id}`, () => {
      const [scenePing] = buildTableScene(input(tableState(), { pings: [ping], nowMs: 10_000 })).pings;
      assert.deepEqual(pingRing(scenePing, c.now, 50, c.reduced), c.expected);
    });
  }

  it("expired pings are dropped from the scene", () => {
    assert.equal(buildTableScene(input(tableState(), { pings: [ping], nowMs: 10_000 + PING_DURATION_MS })).pings.length, 0);
  });
});

describe("dashPolyline", () => {
  const cases = [
    { id: "a 20 px line with [5, 5] gives two dashes", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }], closed: false, expected: [[0, 5], [10, 15]] },
    { id: "the phase carries across a vertex", points: [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 20, y: 0 }], closed: false, expected: [[0, 5], [10, 15]] },
    { id: "a single point draws nothing", points: [{ x: 0, y: 0 }], closed: false, expected: [] },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const segments = dashPolyline(c.points, [5, 5], c.closed);
      const merged: number[][] = [];
      for (const [a, b] of segments) {
        const last = merged.at(-1);
        if (last && Math.abs(last[1] - a.x) < 1e-9) last[1] = b.x;
        else merged.push([a.x, b.x]);
      }
      assert.deepEqual(merged, c.expected);
    });
  }
});
