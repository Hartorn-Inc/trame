import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { h } from "preact";
import type { ProjectedTableState, WireWallSegment } from "../../src/api/wire.ts";
import { DARK_CANVAS_PALETTE } from "../../src/canvas/CanvasThemePalette.ts";
import { computeTokenVisionPolygon, computeVisibilityPolygon, previewAoeCells } from "../../src/engine/wasmBridge.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { TableCanvas } from "../../src/table/TableCanvas.tsx";
import { decodeCells, encodeCells, exploreCells, fogGrid, fogMemoryKey, loadFogMemory, saveFogMemory } from "../../src/table/fogMemory.ts";
import { buildTableScene } from "../../src/table/scene/tableScene.ts";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
import { CAMPAIGN, GM_ID, GOBLIN, HERO, PLAYER_ID, fullToken, liveTable, mount, publicToken, tableState } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const SCENE = "99999999-0000-4000-8000-000000000001";
const GRID = fogGrid(1000, 1000, 50);
const key = (col: number, row: number) => row * GRID.cols + col;
/** Lets Preact flush `useEffect` callbacks (scheduled on a timer in tests). */
const effects = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("fogMemory: cells explored by vision polygons", () => {
  const square = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const cases = [
    { id: "a polygon covering two cell centres explores both", explored: [], vision: [square(0, 0, 100, 50)], expected: [key(0, 0), key(1, 0)] },
    { id: "a polygon that misses every centre explores nothing", explored: [], vision: [square(0, 0, 20, 20)], expected: [] },
    { id: "cells off the map are ignored", explored: [], vision: [square(950, 950, 1100, 1100)], expected: [key(19, 19)] },
    { id: "new cells are added to what was already explored", explored: [key(5, 5)], vision: [square(0, 0, 50, 50)], expected: [key(5, 5), key(0, 0)] },
    { id: "degenerate polygons are skipped", explored: [], vision: [[{ x: 0, y: 0 }, { x: 100, y: 100 }]], expected: [] },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual([...exploreCells(new Set(c.explored), c.vision, GRID)].sort((a, b) => a - b), [...c.expected].sort((a, b) => a - b)));
  }

  it("nothing new returns the very same set, so callers skip saving", () => {
    const explored = new Set([key(0, 0)]);
    assert.ok(exploreCells(explored, [square(0, 0, 50, 50)], GRID) === explored);
  });
});

describe("fogMemory: storage encoding", () => {
  const cases = [
    { id: "a round trip keeps every cell", stored: (cells: Set<number>) => encodeCells(cells, GRID), grid: GRID, expected: [0, 7, 8, key(19, 19)] },
    { id: "a value saved for another grid size starts unexplored", stored: (cells: Set<number>) => encodeCells(cells, fogGrid(500, 500, 50)), grid: GRID, expected: [] },
    { id: "garbage starts unexplored", stored: () => "v1:20x20:not base64!", grid: GRID, expected: [] },
    { id: "a truncated bitset starts unexplored", stored: () => "v1:20x20:AA==", grid: GRID, expected: [] },
    { id: "a missing value starts unexplored", stored: () => null, grid: GRID, expected: [] },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual([...decodeCells(c.stored(new Set([0, 7, 8, key(19, 19)])), c.grid)], c.expected));
  }

  it("storage failures are swallowed: load returns nothing, save does not throw", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    assert.equal(loadFogMemory(broken, "k", GRID).size, 0);
    saveFogMemory(broken, "k", new Set([1]), GRID);
  });

  it("keys separate players, campaigns and maps", () => {
    const keys = new Set([fogMemoryKey("u1", "c1", "s1"), fogMemoryKey("u2", "c1", "s1"), fogMemoryKey("u1", "c2", "s1"), fogMemoryKey("u1", "c1", "s2")]);
    assert.equal(keys.size, 4);
  });
});

const divider: WireWallSegment = {
  id: "dddddddd-0000-4000-8000-0000000000aa",
  a: { x: 500, y: 0 },
  b: { x: 500, y: 1000 },
  kind: { kind: "NORMAL" },
  blocks_movement: true,
  blocks_vision: true,
  blocks_light: true,
  blocks_sound: true,
  bottom_elevation_ft: -1000,
  top_elevation_ft: 1000,
};

const playerState = (heroAt: { x: number; y: number }, extra: Partial<ProjectedTableState> = {}) =>
  tableState({
    active_scene_id: SCENE,
    walls: [divider],
    tokens: { [HERO]: fullToken(HERO, "Brakka", { owner_user_id: PLAYER_ID, top_left: heroAt }) },
    ...extra,
  });

describe("tableScene: remembered cells and live tokens", () => {
  const geometry = { visibilityPolygon: computeVisibilityPolygon, tokenVisionPolygon: computeTokenVisionPolygon, aoeCells: previewAoeCells };
  const scene = (state: ProjectedTableState, isGm: boolean, explored: number[]) =>
    buildTableScene({ state, palette: DARK_CANVAS_PALETTE, isGm, selectedTokenId: null, activeTurnTokenId: null, previewPlayerView: false, reducedMotion: false, pings: [], nowMs: 0, geometry, exploredCells: new Set(explored) });
  const goblinLeft = { public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { top_left: { x: 200, y: 500 } }) } };

  const cases = [
    { id: "a remembered cell out of sight is dimmed memory", heroAt: { x: 700, y: 100 }, explored: [key(4, 10)], memory: 1, goblin: false },
    { id: "a remembered cell in sight is not memory, it is seen", heroAt: { x: 100, y: 100 }, explored: [key(4, 10)], memory: 0, goblin: true },
    { id: "nothing explored leaves only opaque fog", heroAt: { x: 700, y: 100 }, explored: [], memory: 0, goblin: false },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const s = scene(playerState(c.heroAt, goblinLeft), false, c.explored);
      assert.equal(s.fog!.memory.length, c.memory);
      assert.equal(s.fog!.memoryAlpha, DARK_CANVAS_PALETTE.fogExploredDimAlpha);
      assert.equal(s.tokens.some((t) => t.id === GOBLIN), c.goblin, "another player's or a monster token shows only in sight");
      assert.ok(s.tokens.some((t) => t.id === HERO), "own token always shows");
    });
  }

  it("the GM sees everything: no fog, no memory, every token", () => {
    const s = scene(playerState({ x: 700, y: 100 }, goblinLeft), true, [key(4, 10)]);
    assert.equal(s.fog, null);
    assert.ok(s.tokens.some((t) => t.id === GOBLIN));
  });
});

describe("TableCanvas: a player's fog memory persists per map", () => {
  const store = new Map<string, string>();
  let original: unknown;
  before(() => {
    original = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  });
  after(() => {
    (globalThis as Record<string, unknown>).localStorage = original;
  });

  it("cells seen before a move stay explored after it and survive a reload", async () => {
    store.clear();
    const storageKey = fogMemoryKey(PLAYER_ID, CAMPAIGN, SCENE);
    const live = liveTable(PLAYER_ID, playerState({ x: 100, y: 100 }));
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client }));
    await effects();
    assert.ok(decodeCells(store.get(storageKey) ?? null, GRID).has(key(2, 2)), "the hero's own area is explored");
    live.snapshot(playerState({ x: 700, y: 100 }, { public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { top_left: { x: 200, y: 500 } }) } }));
    await effects();
    const after = decodeCells(store.get(storageKey) ?? null, GRID);
    assert.ok(after.has(key(2, 2)), "the left room stays explored after the hero left it");
    assert.ok(after.has(key(14, 2)), "the right room is now explored too");
    assertAbsent(ui.byTestId(`token-${GOBLIN}`), "no live token button inside remembered fog");
    assertPresent(ui.byTestId(`token-${HERO}`), "own token");
    ui.unmount();

    const reloaded = liveTable(PLAYER_ID, playerState({ x: 700, y: 100 }));
    const ui2 = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: reloaded.client }));
    await effects();
    assert.ok(decodeCells(store.get(storageKey) ?? null, GRID).has(key(2, 2)), "memory loaded from storage is kept");
    ui2.unmount();
  });

  it("the GM keeps no fog memory", async () => {
    store.clear();
    const live = liveTable(GM_ID, playerState({ x: 100, y: 100 }));
    const ui = mount(h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm: true }));
    await effects();
    assert.equal(store.size, 0);
    ui.unmount();
  });
});
