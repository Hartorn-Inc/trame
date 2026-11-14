// Map studio difficult-terrain brush: cell math, mouse and keyboard painting, and saving with the scene.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import type { GridCell } from "../../src/engine/wasmBridge.ts";
import { mapFrontendSceneToBackend } from "../../src/maps/domain.ts";
import { MapsStudioTab } from "../../src/maps/MapsStudioTab.tsx";
import { applyTerrainBrush, cellAtPoint, moveTerrainCursor, type TerrainBrushMode } from "../../src/maps/terrainBrush.ts";
import type { CampaignMapScene } from "../../src/maps/types.ts";
import { mount } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";

setupMockDom();

describe("terrain brush cell math", () => {
  const cellCases: Array<{ id: string; p: { x: number; y: number }; expected: GridCell | null }> = [
    { id: "origin-is-cell-0-0", p: { x: 0, y: 0 }, expected: { col: 0, row: 0 } },
    { id: "inside-second-column-third-row", p: { x: 75, y: 145 }, expected: { col: 1, row: 2 } },
    { id: "past-the-right-edge-is-off-map", p: { x: 700, y: 10 }, expected: null },
    { id: "negative-is-off-map", p: { x: -1, y: 10 }, expected: null },
  ];
  for (const tc of cellCases) {
    it(`[cell-at-${tc.id}]`, () => {
      assert.deepEqual(cellAtPoint(tc.p, 70, 10, 10), tc.expected);
    });
  }

  const brushCases: Array<{ id: string; cells: GridCell[]; mode: TerrainBrushMode; expected: GridCell[]; same: boolean }> = [
    { id: "paint-adds-a-bare-cell", cells: [], mode: "paint", expected: [{ col: 2, row: 3 }], same: false },
    { id: "paint-on-painted-cell-keeps-the-array", cells: [{ col: 2, row: 3 }], mode: "paint", expected: [{ col: 2, row: 3 }], same: true },
    { id: "erase-removes-the-cell", cells: [{ col: 2, row: 3 }, { col: 0, row: 0 }], mode: "erase", expected: [{ col: 0, row: 0 }], same: false },
    { id: "erase-on-bare-cell-keeps-the-array", cells: [{ col: 0, row: 0 }], mode: "erase", expected: [{ col: 0, row: 0 }], same: true },
  ];
  for (const tc of brushCases) {
    it(`[brush-${tc.id}]`, () => {
      const next = applyTerrainBrush(tc.cells, { col: 2, row: 3 }, tc.mode);
      assert.deepEqual(next, tc.expected);
      assert.equal(next === tc.cells, tc.same);
    });
  }

  const cursorCases: Array<{ id: string; from: GridCell; key: string; expected: GridCell | null }> = [
    { id: "arrow-right-moves-one-column", from: { col: 0, row: 0 }, key: "ArrowRight", expected: { col: 1, row: 0 } },
    { id: "arrow-up-clamps-at-the-top", from: { col: 3, row: 0 }, key: "ArrowUp", expected: { col: 3, row: 0 } },
    { id: "end-jumps-to-the-last-column", from: { col: 3, row: 4 }, key: "End", expected: { col: 9, row: 4 } },
    { id: "letters-are-not-cursor-keys", from: { col: 3, row: 4 }, key: "a", expected: null },
  ];
  for (const tc of cursorCases) {
    it(`[cursor-${tc.id}]`, () => {
      assert.deepEqual(moveTerrainCursor(tc.from, tc.key, 10, 10), tc.expected);
    });
  }
});

describe("MapsStudioTab terrain painting", () => {
  const scene: CampaignMapScene = {
    id: "8a6f0b38-7c55-4d5e-9a63-0f1b8b3c2a11",
    campaignId: "5b1f6c7e-4d2a-4f4e-8a8b-1c2d3e4f5a6b",
    title: "Bog",
    revealedToPlayers: false,
    gridCellSizePx: 70,
    feetPerCell: 5,
    widthPx: 700,
    heightPx: 700,
    walls: [],
    lights: [],
    audioEmitters: [],
    stagedTokens: [],
  };

  function studio() {
    const saved: CampaignMapScene[] = [];
    const view = mount(
      h(MapsStudioTab, {
        campaignId: scene.campaignId,
        userRole: "GM",
        initialScenes: [scene],
        onSaveScene: async (s: CampaignMapScene) => {
          saved.push(s);
        },
      }),
    );
    const pick = (tool: string) => view.byTestId(`studio-tool-${tool}`).dispatchEvent({ type: "change" });
    return { view, saved, pick };
  }

  it("[keyboard-paints-erases-and-saves] arrows + Space paint a cell, Delete erases another, Save sends difficult_terrain", async () => {
    const { view, saved, pick } = studio();
    pick("paint");
    // SVG attribute names keep their case in the mock DOM.
    assert.equal(view.byTestId("studio-canvas").getAttribute("tabIndex"), "0");
    view.key("studio-canvas", "ArrowRight");
    view.key("studio-canvas", "ArrowDown");
    view.key("studio-canvas", " ");
    assertPresent(view.byTestId("canvas-terrain-1-1"), "painted cell rendered (hatched)");
    assert.equal(view.byTestId("studio-terrain-status").textContent, "Cursor on column 2, row 2: difficult terrain. 1 cells marked.");
    view.key("studio-canvas", "ArrowRight");
    view.key("studio-canvas", "Enter");
    view.key("studio-canvas", "Delete");
    assertAbsent(view.byTestId("canvas-terrain-2-1"), "Delete erased the cursor cell");
    view.click("save-scene-btn");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(saved.length, 1);
    assert.deepEqual(mapFrontendSceneToBackend(saved[0]).difficult_terrain, [{ col: 1, row: 1 }]);
  });

  it("[mouse-drag-paints-then-erase-tool-clears] a pointer drag paints every crossed cell; the erase tool and Clear all remove them", () => {
    const { view, pick } = studio();
    pick("paint");
    const canvas = view.byTestId("studio-canvas");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 700 });
    canvas.dispatchEvent({ type: "pointerdown", clientX: 10, clientY: 10, pointerId: 1 });
    canvas.dispatchEvent({ type: "pointermove", clientX: 80, clientY: 10, pointerId: 1 });
    canvas.dispatchEvent({ type: "pointerup", clientX: 80, clientY: 10, pointerId: 1 });
    canvas.dispatchEvent({ type: "pointermove", clientX: 150, clientY: 10, pointerId: 1 });
    assertPresent(view.byTestId("canvas-terrain-0-0"), "first cell painted");
    assertPresent(view.byTestId("canvas-terrain-1-0"), "dragged cell painted");
    assertAbsent(view.byTestId("canvas-terrain-2-0"), "moving after pointerup paints nothing");
    pick("erase");
    canvas.dispatchEvent({ type: "pointerdown", clientX: 10, clientY: 10, pointerId: 2 });
    canvas.dispatchEvent({ type: "pointerup", clientX: 10, clientY: 10, pointerId: 2 });
    assertAbsent(view.byTestId("canvas-terrain-0-0"), "erase tool cleared the cell");
    view.click("studio-clear-terrain");
    assertAbsent(view.byTestId("canvas-terrain-1-0"), "Clear all removed the rest");
    pick("walls");
    assert.equal(view.byTestId("studio-canvas").getAttribute("role"), "img");
  });
});
