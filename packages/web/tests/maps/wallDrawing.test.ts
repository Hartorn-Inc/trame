import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import { localeSignal } from "../../src/i18n/index.ts";
import { MapsStudioTab } from "../../src/maps/MapsStudioTab.tsx";
import type { CampaignMapScene, WallType } from "../../src/maps/types.ts";
import { scenePoint, snapToGridCorner, wallFlagsFor, wallFromDrag } from "../../src/maps/wallDrawing.ts";
import { assertAbsent } from "../helpers/domAssert.ts";
import { mount } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

describe("wallDrawing: screen to scene mapping", () => {
  const cases = [
    {
      id: "a square scene in a square SVG maps proportionally",
      rect: { left: 10, top: 20, width: 100, height: 100 },
      scene: [1000, 1000],
      client: [60, 70],
      expected: { x: 500, y: 500 },
    },
    {
      id: "a square scene letterboxed in a wide SVG removes the side bands",
      rect: { left: 0, top: 0, width: 400, height: 200 },
      scene: [1000, 1000],
      client: [100, 100],
      expected: { x: 0, y: 500 },
    },
    {
      id: "a release past the map edge is clamped onto the map",
      rect: { left: 0, top: 0, width: 100, height: 100 },
      scene: [1000, 1000],
      client: [150, -20],
      expected: { x: 1000, y: 0 },
    },
    { id: "a zero-sized SVG maps nothing", rect: { left: 0, top: 0, width: 0, height: 0 }, scene: [1000, 1000], client: [0, 0], expected: null },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual(scenePoint(c.rect, c.scene[0], c.scene[1], c.client[0], c.client[1]), c.expected));
  }

  const snaps = [
    { id: "a point snaps to the nearest grid corner", point: { x: 110, y: 36 }, cell: 70, expected: { x: 140, y: 70 } },
    { id: "a point near the origin snaps to the origin", point: { x: 20, y: 30 }, cell: 70, expected: { x: 0, y: 0 } },
    { id: "a zero cell size leaves the point as drawn", point: { x: 104, y: 36 }, cell: 0, expected: { x: 104, y: 36 } },
  ];
  for (const c of snaps) {
    it(`snapToGridCorner: ${c.id}`, () => assert.deepEqual(snapToGridCorner(c.point, c.cell), c.expected));
  }
});

describe("wallDrawing: walls from a drag", () => {
  const flags = [
    { id: "a normal wall blocks everything", type: "Normal", expected: [true, true, true, true] },
    { id: "a window blocks bodies and sound, not sight or light", type: "Window", expected: [true, false, false, true] },
    { id: "a terrain wall lets sound through", type: "Terrain", expected: [true, true, true, false] },
    { id: "an illusion blocks sight and light only", type: "Illusion", expected: [false, true, true, false] },
    { id: "a door blocks everything while closed", type: "Door", expected: [true, true, true, true] },
    { id: "a secret door blocks everything while closed", type: "SecretDoor", expected: [true, true, true, true] },
    { id: "a one-way wall blocks everything", type: "OneWay", expected: [true, true, true, true] },
  ] as const;
  for (const c of flags) {
    it(`wallFlagsFor: ${c.id}`, () => {
      const f = wallFlagsFor(c.type as WallType);
      assert.deepEqual([f.blocksMovement, f.blocksVision, f.blocksLight, f.blocksSound], c.expected);
    });
  }

  const doors = [
    { id: "a drawn door starts closed and unlocked", type: "Door", door: { isOpen: false, isLocked: false }, secret: undefined },
    { id: "a drawn secret door starts closed", type: "SecretDoor", door: undefined, secret: { isOpen: false } },
    { id: "a drawn normal wall has no door state", type: "Normal", door: undefined, secret: undefined },
  ] as const;
  for (const c of doors) {
    it(`wallFromDrag: ${c.id}`, () => {
      const wall = wallFromDrag("w1", { x: 0, y: 0 }, { x: 70, y: 0 }, c.type, 0, 10)!;
      assert.deepEqual([wall.wallType, wall.a, wall.b, wall.doorState, wall.secretDoorState], [c.type, { x: 0, y: 0 }, { x: 70, y: 0 }, c.door, c.secret]);
    });
  }

  it("wallFromDrag: a drag whose ends coincide is a click, not a wall", () => {
    assert.equal(wallFromDrag("w1", { x: 70, y: 70 }, { x: 70, y: 70 }, "Normal", 0, 10), null);
  });
});

describe("MapsStudioTab: drawing walls on the canvas", () => {
  const scene: CampaignMapScene = {
    id: "studio-scene-1",
    campaignId: "camp-1",
    title: "Crypt",
    revealedToPlayers: false,
    gridCellSizePx: 70,
    feetPerCell: 5,
    widthPx: 1000,
    heightPx: 1000,
    defaultGroundElevationFt: 0,
    spawnPoints: [],
    walls: [],
    lights: [],
    audioEmitters: [],
    stagedTokens: [],
  };

  const drags = [
    { id: "a drag draws a snapped wall of the selected kind", kind: "Window", path: [[10, 10], [50, 10]], expected: /Window.*\(70,70\) → \(490,70\)/ },
    { id: "Alt draws without snapping", kind: "Normal", path: [[10, 10], [50, 10]], alt: true, expected: /Normal.*\(100,100\) → \(500,100\)/ },
    { id: "a tap without movement draws nothing", kind: "Normal", path: [[10, 10]], expected: /No wall segments yet/ },
  ];
  for (const c of drags) {
    it(c.id, () => {
      const ui = mount(h(MapsStudioTab, { campaignId: "camp-1", userRole: "GM", initialScenes: [scene] }));
      ui.input("wall-type-select", c.kind, "change");
      const svg = ui.byTestId("studio-canvas");
      svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
      const at = ([x, y]: number[]) => ({ clientX: x, clientY: y, altKey: c.alt ?? false });
      svg.dispatchEvent({ type: "pointerdown", ...at(c.path[0]) });
      for (const point of c.path.slice(1)) svg.dispatchEvent({ type: "pointermove", ...at(point) });
      svg.dispatchEvent({ type: "pointerup" });
      assert.match(ui.byTestId("all-walls-list").textContent, c.expected);
      ui.unmount();
    });
  }

  const endings = [
    { id: "pointerup after a captured drag adds the wall", end: "pointerup", expected: /Normal.*\(70,70\) → \(490,70\)/ },
    { id: "pointercancel drops the drag without a wall", end: "pointercancel", expected: /No wall segments yet/ },
  ];
  for (const c of endings) {
    it(c.id, () => {
      const ui = mount(h(MapsStudioTab, { campaignId: "camp-1", userRole: "GM", initialScenes: [scene] }));
      const svg = ui.byTestId("studio-canvas");
      const captured: number[] = [];
      svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
      svg.setPointerCapture = (id: number) => captured.push(id);
      svg.dispatchEvent({ type: "pointerdown", clientX: 10, clientY: 10, pointerId: 7 });
      svg.dispatchEvent({ type: "pointermove", clientX: 50, clientY: 10, pointerId: 7 });
      svg.dispatchEvent({ type: c.end, pointerId: 7 });
      assert.deepEqual(captured, [7]);
      assertAbsent(ui.byTestId("canvas-wall-preview"), "wall preview");
      assert.match(ui.byTestId("all-walls-list").textContent, c.expected);
      ui.unmount();
    });
  }

  it("the reveal toggle keeps its name and reports its state with aria-pressed", () => {
    const ui = mount(h(MapsStudioTab, { campaignId: "camp-1", userRole: "GM", initialScenes: [scene] }));
    for (const pressed of ["false", "true", "false"]) {
      const toggle = ui.byTestId("toggle-revealed-btn");
      assert.equal(toggle.textContent, "Revealed to players");
      assert.equal(toggle.getAttribute("aria-pressed"), pressed);
      ui.click("toggle-revealed-btn");
    }
    ui.unmount();
  });

  const zoomControls = [
    { id: "zoom out is an ATLAS ghost button", testId: "studio-zoom-out", classes: ["ds-btn", "ds-btn-ghost", "ds-btn-sm"] },
    { id: "zoom in is an ATLAS ghost button", testId: "studio-zoom-in", classes: ["ds-btn", "ds-btn-ghost", "ds-btn-sm"] },
    { id: "the zoom level is tabular meta text", testId: "studio-zoom-level", classes: ["ds-meta", "atlas-tabular-nums"] },
  ];
  for (const c of zoomControls) {
    it(`studio zoom: ${c.id} with no inline style`, () => {
      const ui = mount(h(MapsStudioTab, { campaignId: "camp-1", userRole: "GM", initialScenes: [scene] }));
      const node = ui.byTestId(c.testId);
      const classes = (node.getAttribute("class") ?? "").split(/\s+/);
      for (const name of c.classes) assert.ok(classes.includes(name), `${c.testId} has ${name}`);
      assert.ok(!node.getAttribute("style"), `${c.testId} has no inline style`);
      ui.unmount();
    });
  }

  it("the studio no longer fakes a fog brush and points to the live table brushes", () => {
    const ui = mount(h(MapsStudioTab, { campaignId: "camp-1", userRole: "GM", initialScenes: [scene] }));
    assertAbsent(ui.byTestId("paint-fog-btn"), "paint-fog-btn");
    assert.match(ui.byTestId("studio-live-brushes-hint").textContent, /painted on the live table/);
    ui.unmount();
  });
});
