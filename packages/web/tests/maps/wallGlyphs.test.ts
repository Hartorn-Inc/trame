import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import type { WireWallKind } from "../../src/api/wire.ts";
import { DARK_CANVAS_PALETTE } from "../../src/canvas/CanvasThemePalette.ts";
import { glyphPath, oneWayNormal, wallGlyphs } from "../../src/canvas/wallGlyphs.ts";
import { computeVisibilityPolygon, type Point2D } from "../../src/engine/wasmBridge.ts";
import { localeSignal, unitSystemSignal, type LocaleCode, type UnitSystem } from "../../src/i18n/index.ts";
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
    assert.equal(ui.byTestId(`flip-wall-${WALL_ID}`).getAttribute("aria-label"), "Flip the direction of one-way wall #1");
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

  describe("UUID-free studio & atlas labels (UA #14)", () => {
    const CAMPAIGN_UUID = "11111111-2222-4333-8444-555555555555";
    const DOOR_UUID = "88888888-0000-4000-8000-000000000002";

    const studioScene = (): CampaignMapScene => ({
      ...scene({ x: 0, y: 1 }),
      campaignId: CAMPAIGN_UUID,
      revealedToPlayers: true,
      walls: [
        ...scene({ x: 0, y: 1 }).walls,
        {
          id: DOOR_UUID,
          a: { x: 140, y: 70 },
          b: { x: 210, y: 70 },
          wallType: "Door",
          blocksMovement: true,
          blocksVision: true,
          blocksLight: true,
          blocksSound: true,
          bottomElevationFt: 0,
          topElevationFt: 10,
          doorState: { isOpen: false, isLocked: false },
        },
      ],
    });

    const cases = [
      {
        id: "gm-en-named-campaign",
        locale: "en" as const,
        role: "GM" as const,
        campaignName: "Sunless Citadel",
        expectedCampaign: "Campaign: Sunless Citadel",
        expectedFlip: "Flip the direction of one-way wall #1",
        expectedDeleteWall: "Delete wall segment #1",
        expectedDoorStatus: "Door #1: Closed",
        expectedDeleteDoor: "Delete door #1",
      },
      {
        id: "gm-fr-unnamed-campaign-fallback",
        locale: "fr" as const,
        role: "GM" as const,
        campaignName: undefined,
        expectedCampaign: "Campagne active",
        expectedFlip: "Inverser le sens du mur à sens unique n° 1",
        expectedDeleteWall: "Supprimer le segment de mur n° 1",
        expectedDoorStatus: "Porte n° 1 : Fermée",
        expectedDeleteDoor: "Supprimer la porte n° 1",
      },
      {
        id: "player-atlas-named-campaign",
        locale: "en" as const,
        role: "PLAYER" as const,
        campaignName: "Curse of Strahd",
        expectedCampaign: "Campaign: Curse of Strahd",
      },
      {
        id: "player-atlas-unnamed-fallback",
        locale: "fr" as const,
        role: "PLAYER" as const,
        campaignName: undefined,
        expectedCampaign: "Campagne active",
      },
    ];

    for (const tc of cases) {
      it(`[${tc.id}] renders human-friendly labels without raw UUIDs`, () => {
        localeSignal.value = tc.locale;
        try {
          const ui = mount(
            h(MapsStudioTab, {
              campaignId: CAMPAIGN_UUID,
              campaignName: tc.campaignName,
              userRole: tc.role,
              initialScenes: [studioScene()],
            }),
          );
          assert.equal(ui.byTestId("maps-campaign-label").textContent, tc.expectedCampaign);
          assert.doesNotMatch(ui.container.textContent, new RegExp(CAMPAIGN_UUID));

          if (tc.role === "GM") {
            assert.equal(ui.byTestId(`flip-wall-${WALL_ID}`).getAttribute("aria-label"), tc.expectedFlip);
            assert.equal(ui.byTestId(`delete-wall-${WALL_ID}`).getAttribute("aria-label"), tc.expectedDeleteWall);
            const doorsList = ui.byTestId("doors-list");
            assert.match(doorsList.textContent, new RegExp(tc.expectedDoorStatus!));
            const deleteDoorBtn = ui.byTestId(`delete-door-${DOOR_UUID}`);
            assert.equal(deleteDoorBtn.getAttribute("aria-label"), tc.expectedDeleteDoor);
            assert.doesNotMatch(ui.byTestId("all-walls-list").textContent, new RegExp(WALL_ID));
            assert.doesNotMatch(doorsList.textContent, new RegExp(DOOR_UUID));
          }
          ui.unmount();
        } finally {
          localeSignal.value = "en";
        }
      });
    }
  });

  describe("Studio coordinate captions, indexed door labels, delete-door testid, and localized wall elevations (F7, F8)", () => {
    const DOOR_1 = "88888888-0000-4000-8000-000000000011";
    const DOOR_2 = "88888888-0000-4000-8000-000000000012";

    const buildF7F8Scene = (): CampaignMapScene => ({
      ...scene({ x: 0, y: 1 }),
      walls: [
        {
          id: WALL_ID,
          a: { x: 0, y: 70 },
          b: { x: 140, y: 70 },
          wallType: "Normal",
          blocksMovement: true,
          blocksVision: true,
          blocksLight: true,
          blocksSound: true,
          bottomElevationFt: 0,
          topElevationFt: 10,
        },
        {
          id: DOOR_1,
          a: { x: 140, y: 70 },
          b: { x: 210, y: 70 },
          wallType: "Door",
          blocksMovement: true,
          blocksVision: true,
          blocksLight: true,
          blocksSound: true,
          bottomElevationFt: 0,
          topElevationFt: 10,
          doorState: { isOpen: false, isLocked: false },
        },
        {
          id: DOOR_2,
          a: { x: 210, y: 70 },
          b: { x: 280, y: 70 },
          wallType: "SecretDoor",
          blocksMovement: true,
          blocksVision: true,
          blocksLight: true,
          blocksSound: true,
          bottomElevationFt: 5,
          topElevationFt: 15,
          secretDoorState: { isOpen: false },
        },
      ],
    });

    const coordCases: Array<{
      id: string;
      locale: LocaleCode;
      expectedCaptions: string[];
      expectedInputArias: Record<string, string>;
    }> = [
      {
        id: "F7-studio-coords-en",
        locale: "en",
        expectedCaptions: ["P1:", "P2:", "Light X,Y:", "Audio X,Y:"],
        expectedInputArias: {
          "wall-p1x-input": "P1 X coordinate",
          "wall-p1y-input": "P1 Y coordinate",
          "wall-p2x-input": "P2 X coordinate",
          "wall-p2y-input": "P2 Y coordinate",
          "light-x-input": "Light X coordinate",
          "light-y-input": "Light Y coordinate",
          "audio-x-input": "Audio X coordinate",
          "audio-y-input": "Audio Y coordinate",
        },
      },
      {
        id: "F7-studio-coords-fr",
        locale: "fr",
        expectedCaptions: ["P1 :", "P2 :", "Lumière X,Y :", "Audio X,Y :"],
        expectedInputArias: {
          "wall-p1x-input": "Coordonnée X de P1",
          "wall-p1y-input": "Coordonnée Y de P1",
          "wall-p2x-input": "Coordonnée X de P2",
          "wall-p2y-input": "Coordonnée Y de P2",
          "light-x-input": "Coordonnée X de la lumière",
          "light-y-input": "Coordonnée Y de la lumière",
          "audio-x-input": "Coordonnée X de l'audio",
          "audio-y-input": "Coordonnée Y de l'audio",
        },
      },
    ];

    for (const tc of coordCases) {
      it(`[${tc.id}] replaces X/Y pair <label for> conflicts with <span> captions while preserving single-control <label for> associations`, () => {
        localeSignal.value = tc.locale;
        try {
          const ui = mount(h(MapsStudioTab, { campaignId: "c1", userRole: "GM", initialScenes: [buildF7F8Scene()] }));

          for (const pairId of ["wall-p1x", "wall-p2x", "light-x", "audio-x"]) {
            assertAbsent(ui.container.querySelector(`label[for="${pairId}"]`), `conflicting label[for="${pairId}"]`);
            assertAbsent(ui.container.querySelector(`label[htmlfor="${pairId}"]`), `conflicting label[htmlFor="${pairId}"]`);
          }
          for (const singleId of ["studio-wall-type", "wall-bottom-elevation", "wall-top-elevation", "light-radius"]) {
            const label = ui.container.querySelector(`label[for="${singleId}"]`);
            assertPresent(label, `single-input label[for="${singleId}"]`);
            const target = ui.container.querySelector(`#${singleId}`);
            assertPresent(target, `target #${singleId}`);
            assert.equal(target.hasAttribute("aria-label"), false, `#${singleId} must not override its <label> with aria-label`);
          }

          const spanTexts = ui.container.querySelectorAll("span").map((s: any) => s.textContent);
          for (const caption of tc.expectedCaptions) {
            assert.ok(spanTexts.includes(caption), `expected span caption '${caption}'`);
          }
          for (const [testId, expectedAria] of Object.entries(tc.expectedInputArias)) {
            assert.equal(ui.byTestId(testId).getAttribute("aria-label"), expectedAria);
          }

          ui.unmount();
        } finally {
          localeSignal.value = "en";
        }
      });
    }

    const doorCases: Array<{
      id: string;
      locale: LocaleCode;
      lockAria1: string;
      unlockAria1: string;
      toggleAria1: string;
      toggleAria2: string;
      deleteWallAria2: string;
      deleteDoorAria1: string;
    }> = [
      {
        id: "F8-studio-doors-en",
        locale: "en",
        lockAria1: "Lock door #1",
        unlockAria1: "Unlock door #1",
        toggleAria1: "Toggle Door #1",
        toggleAria2: "Toggle Door #2",
        deleteWallAria2: "Delete wall segment #2",
        deleteDoorAria1: "Delete door #1",
      },
      {
        id: "F8-studio-doors-fr",
        locale: "fr",
        lockAria1: "Verrouiller la porte n° 1",
        unlockAria1: "Déverrouiller la porte n° 1",
        toggleAria1: "Ouvrir/fermer la porte n° 1",
        toggleAria2: "Ouvrir/fermer la porte n° 2",
        deleteWallAria2: "Supprimer le segment de mur n° 2",
        deleteDoorAria1: "Supprimer la porte n° 1",
      },
    ];

    for (const tc of doorCases) {
      it(`[${tc.id}] exposes indexed WCAG 2.5.3 door button aria-labels and unique delete-door-<id> testids`, () => {
        localeSignal.value = tc.locale;
        try {
          const ui = mount(h(MapsStudioTab, { campaignId: "c1", userRole: "GM", initialScenes: [buildF7F8Scene()] }));

          const lockBtn = ui.byTestId(`toggle-lock-${DOOR_1}`);
          assert.equal(lockBtn.getAttribute("aria-label"), tc.lockAria1);
          assert.ok(lockBtn.getAttribute("aria-label").startsWith(lockBtn.textContent), "lock aria-label starts with visible text");

          ui.click(`toggle-lock-${DOOR_1}`);
          const unlockBtn = ui.byTestId(`toggle-lock-${DOOR_1}`);
          assert.equal(unlockBtn.getAttribute("aria-label"), tc.unlockAria1);
          assert.ok(unlockBtn.getAttribute("aria-label").startsWith(unlockBtn.textContent), "unlock aria-label starts with visible text");

          const toggle1 = ui.byTestId(`toggle-door-${DOOR_1}`);
          const toggle2 = ui.byTestId(`toggle-door-${DOOR_2}`);
          assert.equal(toggle1.getAttribute("aria-label"), tc.toggleAria1);
          assert.equal(toggle2.getAttribute("aria-label"), tc.toggleAria2);
          assert.ok(toggle1.getAttribute("aria-label").startsWith(toggle1.textContent), "toggle #1 aria-label starts with visible text");
          assert.ok(toggle2.getAttribute("aria-label").startsWith(toggle2.textContent), "toggle #2 aria-label starts with visible text");

          assert.equal(ui.container.querySelectorAll(`[data-testid="delete-wall-${DOOR_1}"]`).length, 1);
          assert.equal(ui.container.querySelectorAll(`[data-testid="delete-door-${DOOR_1}"]`).length, 1);
          assert.equal(ui.byTestId(`delete-wall-${DOOR_1}`).getAttribute("aria-label"), tc.deleteWallAria2);
          assert.equal(ui.byTestId(`delete-door-${DOOR_1}`).getAttribute("aria-label"), tc.deleteDoorAria1);

          ui.click(`delete-door-${DOOR_1}`);
          assertAbsent(ui.byTestId(`delete-door-${DOOR_1}`), "deleted door button");

          ui.unmount();
        } finally {
          localeSignal.value = "en";
        }
      });
    }

    const elevationCases: Array<{
      id: string;
      locale: LocaleCode;
      units: UnitSystem;
      expectedWall1: string;
      expectedWall3: string;
    }> = [
      {
        id: "F8-wall-elevation-imperial-en",
        locale: "en",
        units: "imperial_ft",
        expectedWall1: "[0 ft .. 10 ft]",
        expectedWall3: "[5 ft .. 15 ft]",
      },
      {
        id: "F8-wall-elevation-metric-en",
        locale: "en",
        units: "metric_m",
        expectedWall1: "[0 m (0 squares) .. 3 m (2 squares)]",
        expectedWall3: "[1.5 m (1 square) .. 4.5 m (3 squares)]",
      },
      {
        id: "F8-wall-elevation-metric-fr",
        locale: "fr",
        units: "metric_m",
        expectedWall1: "[0 m (0 case) .. 3 m (2 cases)]",
        expectedWall3: "[1,5 m (1 case) .. 4,5 m (3 cases)]",
      },
    ];

    for (const tc of elevationCases) {
      it(`[${tc.id}] formats studio wall elevations through formatDistanceFt()`, () => {
        localeSignal.value = tc.locale;
        unitSystemSignal.value = tc.units;
        try {
          const ui = mount(h(MapsStudioTab, { campaignId: "c1", userRole: "GM", initialScenes: [buildF7F8Scene()] }));
          const wallsText = ui.byTestId("all-walls-list").textContent;
          assert.ok(wallsText.includes(tc.expectedWall1), `expected '${tc.expectedWall1}' in '${wallsText}'`);
          assert.ok(wallsText.includes(tc.expectedWall3), `expected '${tc.expectedWall3}' in '${wallsText}'`);
          ui.unmount();
        } finally {
          unitSystemSignal.value = "imperial_ft";
          localeSignal.value = "en";
        }
      });
    }
  });
});
