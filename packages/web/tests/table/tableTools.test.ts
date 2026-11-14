import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_STROKE_CELLS,
  MAX_ZOOM,
  MIN_ZOOM,
  brushCells,
  cellAt,
  clampZoom,
  gridBounds,
  mergeCells,
  pinchFactor,
  rectCells,
  stepCell,
  strokeCapped,
  strokeCells,
  strokeCommands,
  zoomAround,
} from "../../src/table/tableTools.ts";

const key = (cells: { col: number; row: number }[]) => cells.map((c) => `${c.col},${c.row}`);

describe("tableTools: brush cells", () => {
  const bounds = { cols: 10, rows: 8 };
  const cases = [
    { id: "a 1-cell brush covers only the pointer cell", center: { col: 4, row: 4 }, size: 1, expected: ["4,4"] },
    { id: "a 3-cell brush covers the 3x3 block around the pointer", center: { col: 4, row: 4 }, size: 3, expected: ["3,3", "4,3", "5,3", "3,4", "4,4", "5,4", "3,5", "4,5", "5,5"] },
    { id: "a brush on the top-left corner is clipped to the map", center: { col: 0, row: 0 }, size: 3, expected: ["0,0", "1,0", "0,1", "1,1"] },
    { id: "a brush on the bottom-right corner is clipped to the map", center: { col: 9, row: 7 }, size: 3, expected: ["8,6", "9,6", "8,7", "9,7"] },
    { id: "a brush entirely off the map paints nothing", center: { col: 20, row: 20 }, size: 1, expected: [] },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual(key(brushCells(c.center, c.size, bounds)), c.expected));
  }

  const sizes = [
    { id: "partial edge cells count as map cells", width: 1025, height: 1000, cell: 50, expected: { cols: 21, rows: 20 } },
    { id: "a zero cell size never divides by zero", width: 10, height: 10, cell: 0, expected: { cols: 10, rows: 10 } },
  ];
  for (const c of sizes) {
    it(`gridBounds: ${c.id}`, () => assert.deepEqual(gridBounds(c.width, c.height, c.cell), c.expected));
  }

  it("cellAt floors board pixels to the cell under the pointer", () => {
    assert.deepEqual(cellAt({ x: 149.9, y: 50 }, 50), { col: 2, row: 1 });
  });
});

describe("tableTools: keyboard cursor", () => {
  const bounds = { cols: 10, rows: 8 };
  const rects = [
    { id: "corners in any order give the same rectangle", a: { col: 2, row: 1 }, b: { col: 1, row: 0 }, expected: ["1,0", "2,0", "1,1", "2,1"] },
    { id: "a one-cell rectangle is that cell", a: { col: 3, row: 3 }, b: { col: 3, row: 3 }, expected: ["3,3"] },
    { id: "a rectangle past the edge is clipped to the map", a: { col: 8, row: 6 }, b: { col: 12, row: 9 }, expected: ["8,6", "9,6", "8,7", "9,7"] },
  ];
  for (const c of rects) {
    it(`rectCells: ${c.id}`, () => assert.deepEqual(key(rectCells(c.a, c.b, bounds)), c.expected));
  }

  it("rectCells: a whole-map rectangle stops at the stroke cap", () => {
    assert.equal(rectCells({ col: 0, row: 0 }, { col: 99, row: 99 }, { cols: 100, rows: 100 }).length, MAX_STROKE_CELLS);
  });

  const steps = [
    { id: "an arrow moves one cell", cell: { col: 4, row: 4 }, delta: [1, 0] as const, expected: { col: 5, row: 4 } },
    { id: "the cursor stops at the left edge", cell: { col: 0, row: 4 }, delta: [-1, 0] as const, expected: { col: 0, row: 4 } },
    { id: "the cursor stops at the bottom edge", cell: { col: 4, row: 7 }, delta: [0, 1] as const, expected: { col: 4, row: 7 } },
  ];
  for (const c of steps) {
    it(`stepCell: ${c.id}`, () => assert.deepEqual(stepCell(c.cell, c.delta, bounds), c.expected));
  }
});

describe("tableTools: gap-free strokes", () => {
  const cases = [
    { id: "a horizontal drag covers every crossed cell", from: { col: 0, row: 0 }, to: { col: 3, row: 0 }, expected: ["0,0", "1,0", "2,0", "3,0"] },
    { id: "a diagonal drag steps one cell at a time", from: { col: 0, row: 0 }, to: { col: 2, row: 2 }, expected: ["0,0", "1,1", "2,2"] },
    { id: "a backwards drag works the same", from: { col: 2, row: 1 }, to: { col: 0, row: 1 }, expected: ["2,1", "1,1", "0,1"] },
    { id: "a zero-length drag is the start cell", from: { col: 5, row: 5 }, to: { col: 5, row: 5 }, expected: ["5,5"] },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual(key(strokeCells(c.from, c.to)), c.expected));
  }

  it("mergeCells drops duplicates and keeps first-painted order", () => {
    assert.deepEqual(key(mergeCells([{ col: 1, row: 1 }], [{ col: 1, row: 1 }, { col: 2, row: 1 }])), ["1,1", "2,1"]);
  });

  it(`mergeCells caps a stroke at ${MAX_STROKE_CELLS} cells`, () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ col: i % 20, row: Math.floor(i / 20) }));
    assert.equal(mergeCells([], many).length, MAX_STROKE_CELLS);
  });

  const capCases = [
    { id: "a short stroke is not capped", length: 9, capped: false },
    { id: "a stroke one cell under the cap is not capped", length: MAX_STROKE_CELLS - 1, capped: false },
    { id: "a stroke at the cap is reported", length: MAX_STROKE_CELLS, capped: true },
  ];
  for (const c of capCases) {
    it(`strokeCapped: ${c.id}`, () => {
      const cells = Array.from({ length: c.length }, (_, i) => ({ col: i, row: 0 }));
      assert.equal(strokeCapped(cells), c.capped);
    });
  }
});

describe("tableTools: stroke commands", () => {
  const cells = [{ col: 1, row: 2 }, { col: 2, row: 2 }];
  const cases = [
    { id: "fog reveal sends one SET_FOG_OVERRIDES for the whole stroke", tool: "fogReveal", expected: [{ cmd: "SET_FOG_OVERRIDES", mode: "REVEAL", cells }] },
    { id: "fog hide sends one HIDE command for the stroke", tool: "fogHide", expected: [{ cmd: "SET_FOG_OVERRIDES", mode: "HIDE", cells }] },
    { id: "fog clear sends one CLEAR command for the stroke", tool: "fogClear", expected: [{ cmd: "SET_FOG_OVERRIDES", mode: "CLEAR", cells }] },
    { id: "terrain paint sends one SET_DIFFICULT_TERRAIN for the stroke", tool: "terrainPaint", expected: [{ cmd: "SET_DIFFICULT_TERRAIN", cells, difficult: true }] },
    { id: "terrain erase removes the stroke's cells", tool: "terrainErase", expected: [{ cmd: "SET_DIFFICULT_TERRAIN", cells, difficult: false }] },
    { id: "the select tool sends nothing", tool: "select", expected: [] },
  ] as const;
  for (const c of cases) {
    it(c.id, () => assert.deepEqual(strokeCommands(c.tool, [...cells]), c.expected));
  }

  it("an empty stroke sends nothing (the engine rejects an empty cell list)", () => {
    assert.deepEqual(strokeCommands("terrainPaint", []), []);
  });
});

describe("tableTools: zoom and pan", () => {
  const clamps = [
    { id: "a zoom inside the bounds is kept", zoom: 1.5, expected: 1.5 },
    { id: "a zoom below the minimum is raised", zoom: 0.01, expected: MIN_ZOOM },
    { id: "a zoom above the maximum is lowered", zoom: 99, expected: MAX_ZOOM },
    { id: "a non-finite zoom resets to 100%", zoom: Number.NaN, expected: 1 },
  ];
  for (const c of clamps) {
    it(`clampZoom: ${c.id}`, () => assert.equal(clampZoom(c.zoom), c.expected));
  }

  const anchors = [
    {
      id: "zooming in around the origin keeps the scroll at zero",
      view: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
      factor: 2,
      anchor: { x: 0, y: 0 },
      expected: { zoom: 2, scrollLeft: 0, scrollTop: 0 },
    },
    {
      id: "zooming in around the viewport centre keeps that board point centred",
      view: { zoom: 1, scrollLeft: 100, scrollTop: 50 },
      factor: 2,
      anchor: { x: 200, y: 150 },
      expected: { zoom: 2, scrollLeft: 400, scrollTop: 250 },
    },
    {
      id: "zooming out never scrolls before the board's origin",
      view: { zoom: 2, scrollLeft: 0, scrollTop: 0 },
      factor: 0.5,
      anchor: { x: 200, y: 150 },
      expected: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
    },
    {
      id: "a zoom past the maximum anchors on the clamped zoom",
      view: { zoom: 4, scrollLeft: 0, scrollTop: 0 },
      factor: 2,
      anchor: { x: 100, y: 100 },
      expected: { zoom: 4, scrollLeft: 0, scrollTop: 0 },
    },
  ];
  for (const c of anchors) {
    it(`zoomAround: ${c.id}`, () => assert.deepEqual(zoomAround(c.view, c.factor, c.anchor), c.expected));
  }

  const pinches = [
    { id: "fingers moving apart zoom in", before: [{ x: 0, y: 0 }, { x: 100, y: 0 }], after: [{ x: 0, y: 0 }, { x: 150, y: 0 }], expected: 1.5 },
    { id: "fingers moving together zoom out", before: [{ x: 0, y: 0 }, { x: 100, y: 0 }], after: [{ x: 25, y: 0 }, { x: 75, y: 0 }], expected: 0.5 },
    { id: "coincident fingers never divide by zero", before: [{ x: 5, y: 5 }, { x: 5, y: 5 }], after: [{ x: 0, y: 0 }, { x: 10, y: 0 }], expected: 1 },
  ] as const;
  for (const c of pinches) {
    it(`pinchFactor: ${c.id}`, () => assert.equal(pinchFactor([c.before[0], c.before[1]], [c.after[0], c.after[1]]), c.expected));
  }
});
