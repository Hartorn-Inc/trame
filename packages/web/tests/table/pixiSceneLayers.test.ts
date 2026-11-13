import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Container, Texture, TextureSource } from "pixi.js";
import type { ProjectedTableState, WireWallSegment } from "../../src/api/wire.ts";
import { DARK_CANVAS_PALETTE } from "../../src/canvas/CanvasThemePalette.ts";
import { computeTokenVisionPolygon, computeVisibilityPolygon, previewAoeCells } from "../../src/engine/wasmBridge.ts";
import { createSceneLayers, type SceneLayers } from "../../src/table/scene/pixiSceneLayers.ts";
import { buildTableScene, type TableScene } from "../../src/table/scene/tableScene.ts";
import { captureWarnings, danglingResources, displayObjects, installHeadlessPixi, sameObjects } from "../helpers/headlessPixi.ts";
import { GOBLIN, HERO, PLAYER_ID, fullToken, publicToken, tableState } from "../helpers/liveTable.ts";

installHeadlessPixi();

const DOOR = "dddddddd-0000-4000-8000-000000000001";
const TORCH = "eeeeeeee-0000-4000-8000-000000000001";
const AOE = "ffffffff-0000-4000-8000-000000000001";

const door = (isOpen: boolean): WireWallSegment => ({
  id: DOOR,
  a: { x: 300, y: 0 },
  b: { x: 300, y: 400 },
  kind: { kind: "DOOR", is_open: isOpen, is_locked: false },
  blocks_movement: !isOpen,
  blocks_vision: !isOpen,
  blocks_light: !isOpen,
  blocks_sound: !isOpen,
  bottom_elevation_ft: -1000,
  top_elevation_ft: 1000,
});

const torch = { id: TORCH, position: { x: 200, y: 200 }, elevation_ft: 0, bright_radius_ft: 20, dim_radius_ft: 40, color_hex: "#FFAA44", intensity: 1 };
const aoe = { id: AOE, origin: { x: 600, y: 600 }, origin_elevation_ft: 0, shape: { shape: "SPHERE", radius_ft: 10 }, stops_at_walls: false, discretization: "CENTER_POINT" };

const base = (overrides: Partial<ProjectedTableState> = {}, heroAt = { x: 100, y: 100 }): ProjectedTableState =>
  tableState({
    ambient_lighting: "NIGHT_MOONLIGHT",
    tokens: { [HERO]: fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, top_left: heroAt, hp: 12, max_hp: 13 }) },
    public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { top_left: { x: 200, y: 150 } }) },
    walls: [door(false)],
    lights: [torch],
    difficult_terrain: [{ col: 1, row: 4 }],
    persistent_aoes: { [AOE]: aoe },
    ...overrides,
  } as Partial<ProjectedTableState>);

const scene = (state: ProjectedTableState): TableScene =>
  buildTableScene({
    state,
    palette: DARK_CANVAS_PALETTE,
    isGm: false,
    selectedTokenId: null,
    activeTurnTokenId: null,
    previewPlayerView: false,
    reducedMotion: false,
    pings: [],
    nowMs: 0,
    geometry: { visibilityPolygon: computeVisibilityPolygon, tokenVisionPolygon: computeTokenVisionPolygon, aoeCells: previewAoeCells },
  });

const solidTexture = () => new Texture({ source: new TextureSource({ width: 4, height: 4 }) });

describe("pixiSceneLayers: a scripted session stays incremental and never leaves a destroyed resource bound", () => {
  const stage = new Container({ label: "stage" });
  let layers: SceneLayers;
  let warnings: ReturnType<typeof captureWarnings>;
  const mapA = solidTexture();
  const mapB = solidTexture();

  before(() => {
    warnings = captureWarnings();
    layers = createSceneLayers(stage, "sans-serif");
  });

  after(() => {
    mapB.destroy(true);
  });

  const steps: Array<{
    id: string;
    state: ProjectedTableState;
    texture: Texture | null;
    /** Texture the caller destroys right after this sync, as the renderer does with a replaced battlemap. */
    release?: Texture;
    layers: string[];
    tokens: { added: string[]; changed: string[]; removed: string[] };
    lights: { added: string[]; changed: string[]; removed: string[] };
    mapChanged: boolean;
    /** No display object was created or destroyed by this step. */
    reused: boolean;
  }> = [
    {
      id: "first scene draws every layer, both tokens and the torch",
      state: base(),
      texture: mapA,
      layers: ["grid", "terrain", "walls", "aoes", "darkness", "fog"],
      tokens: { added: [HERO, GOBLIN], changed: [], removed: [] },
      lights: { added: [TORCH], changed: [], removed: [] },
      mapChanged: true,
      reused: false,
    },
    {
      id: "an identical scene (a re-render for an unrelated signal) redraws nothing",
      state: base(),
      texture: mapA,
      layers: [],
      tokens: { added: [], changed: [], removed: [] },
      lights: { added: [], changed: [], removed: [] },
      mapChanged: false,
      reused: true,
    },
    {
      id: "the hero moving one cell updates its token in place and the fog only",
      state: base({}, { x: 150, y: 100 }),
      texture: mapA,
      layers: ["fog"],
      tokens: { added: [], changed: [HERO], removed: [] },
      lights: { added: [], changed: [], removed: [] },
      mapChanged: false,
      reused: true,
    },
    {
      id: "opening the door redraws walls and fog and rebuilds the torch it now lights through",
      state: base({ walls: [door(true)] }, { x: 150, y: 100 }),
      texture: mapA,
      layers: ["walls", "fog"],
      tokens: { added: [], changed: [], removed: [] },
      lights: { added: [], changed: [TORCH], removed: [] },
      mapChanged: false,
      reused: false,
    },
    {
      id: "a new battlemap swaps the sprite texture before the old one is destroyed",
      state: base({ walls: [door(true)] }, { x: 150, y: 100 }),
      texture: mapB,
      release: mapA,
      layers: [],
      tokens: { added: [], changed: [], removed: [] },
      lights: { added: [], changed: [], removed: [] },
      mapChanged: true,
      reused: true,
    },
    {
      id: "the goblin leaving sight and the torch going out release only their objects",
      state: base({ walls: [door(true)], public_tokens: {}, lights: [] }, { x: 150, y: 100 }),
      texture: mapB,
      layers: ["darkness"],
      tokens: { added: [], changed: [], removed: [GOBLIN] },
      lights: { added: [], changed: [], removed: [TORCH] },
      mapChanged: false,
      reused: false,
    },
  ];

  for (const step of steps) {
    it(step.id, () => {
      const objectsBefore = displayObjects(stage);
      const report = layers.sync(scene(step.state), step.texture);
      step.release?.destroy(true);
      assert.deepEqual(report.layers, step.layers);
      assert.deepEqual(report.tokens, step.tokens);
      assert.deepEqual(report.lights, step.lights);
      assert.equal(report.mapChanged, step.mapChanged);
      if (step.reused) assert.ok(sameObjects(objectsBefore, displayObjects(stage)), "no display object was recreated");
      assert.deepEqual(danglingResources(stage), []);
    });
  }

  it("destroy releases the display list and PixiJS logged no warning during the whole session", () => {
    layers.destroy();
    assert.equal(stage.children.length, 0);
    assert.deepEqual(warnings.stop(), []);
  });
});

describe("headless harness: it catches the bug the old adapter had", () => {
  it("destroying the battlemap texture while the sprite still shows it is reported", () => {
    installHeadlessPixi();
    const stage = new Container({ label: "stage" });
    const layers = createSceneLayers(stage, "sans-serif");
    const texture = solidTexture();
    layers.sync(scene(base()), texture);
    texture.destroy(true);
    assert.deepEqual(danglingResources(stage), ["stage/backgroundMap/battlemap: sprite texture destroyed"]);
    layers.sync(scene(base()), null);
    assert.deepEqual(danglingResources(stage), []);
    layers.destroy();
  });
});
