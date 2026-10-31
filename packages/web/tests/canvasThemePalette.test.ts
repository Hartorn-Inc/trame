import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AtlasThemeMode,
  type CanonicalWallKind,
  type CanvasThemePaletteSpec,
  DARK_CANVAS_PALETTE,
  getCanvasThemePalette,
  LIGHT_CANVAS_PALETTE,
  type ResolvedAtlasTheme,
  type TokenDispositionKind,
} from "../src/canvas/CanvasThemePalette.ts";

describe("Ticket #105 — CanvasThemePalette & Geometric Discriminators", () => {
  describe("Acceptance Criterion 1: Map-Art Independence and Fog Invariance", () => {
    const resolvedThemes: readonly ResolvedAtlasTheme[] = ["dark", "light"];

    for (const theme of resolvedThemes) {
      it(`WHEN getCanvasThemePalette executes with resolved theme '${theme}', the function returns mapArtFilter set to 'none' and fogUnexploredHex set to 0x0f1a25`, () => {
        const palette = getCanvasThemePalette(theme);
        assert.equal(palette.mapArtFilter, "none");
        assert.equal(palette.fogUnexploredHex, 0x0f1a25);
      });
    }

    it("WHEN getCanvasThemePalette executes with default parameter, the function returns dark theme with mapArtFilter 'none' and fogUnexploredHex 0x0f1a25", () => {
      const palette = getCanvasThemePalette();
      assert.equal(palette.theme, "dark");
      assert.equal(palette.mapArtFilter, "none");
      assert.equal(palette.fogUnexploredHex, 0x0f1a25);
    });

    it("WHEN getCanvasThemePalette executes with 'system', the function respects systemPrefersLight flag", () => {
      const darkSystem = getCanvasThemePalette("system", false);
      assert.equal(darkSystem.theme, "dark");
      assert.equal(darkSystem.mapArtFilter, "none");
      assert.equal(darkSystem.fogUnexploredHex, 0x0f1a25);

      const lightSystem = getCanvasThemePalette("system", true);
      assert.equal(lightSystem.theme, "light");
      assert.equal(lightSystem.mapArtFilter, "none");
      assert.equal(lightSystem.fogUnexploredHex, 0x0f1a25);
    });
  });

  describe("Acceptance Criterion 2: Dark Theme Canvas Void and Grid Lines", () => {
    it("WHEN getCanvasThemePalette executes with 'dark', the function returns canvasVoidHex equal to 0x0f1a25 and gridLineHex equal to 0xb8c7d1 with gridLineAlpha equal to 0.16", () => {
      const palette = getCanvasThemePalette("dark");
      assert.equal(palette.canvasVoidHex, 0x0f1a25);
      assert.equal(palette.canvasVoidCss, "#0F1A25");
      assert.equal(palette.gridLineHex, 0xb8c7d1);
      assert.equal(palette.gridLineAlpha, 0.16);
    });
  });

  describe("Acceptance Criterion 3: Light Theme Canvas Void and Grid Lines", () => {
    it("WHEN getCanvasThemePalette executes with 'light', the function returns canvasVoidHex equal to 0xf4f7f9 and gridLineHex equal to 0x1c3041 with gridLineAlpha equal to 0.14", () => {
      const palette = getCanvasThemePalette("light");
      assert.equal(palette.canvasVoidHex, 0xf4f7f9);
      assert.equal(palette.canvasVoidCss, "#F4F7F9");
      assert.equal(palette.gridLineHex, 0x1c3041);
      assert.equal(palette.gridLineAlpha, 0.14);
    });
  });

  describe("Acceptance Criterion 4: Token Dispositions Non-Color Geometric Discriminators", () => {
    const testPalettes: ReadonlyArray<{ name: string; palette: CanvasThemePaletteSpec }> = [
      { name: "DARK_CANVAS_PALETTE", palette: DARK_CANVAS_PALETTE },
      { name: "LIGHT_CANVAS_PALETTE", palette: LIGHT_CANVAS_PALETTE },
    ];

    for (const { name, palette } of testPalettes) {
      it(`WHEN a test inspects tokenDispositions in ${name}, ally returns ringStrokeStyle 'solid' with badgeShape 'shield'`, () => {
        const ally = palette.tokenDispositions.ally;
        assert.equal(ally.ringStrokeStyle, "solid");
        assert.equal(ally.badgeShape, "shield");
      });

      it(`WHEN a test inspects tokenDispositions in ${name}, hostile returns ringStrokeStyle 'dashed' with badgeShape 'diamond' and badgeGlyph '!'`, () => {
        const hostile = palette.tokenDispositions.hostile;
        assert.equal(hostile.ringStrokeStyle, "dashed");
        assert.equal(hostile.badgeShape, "diamond");
        assert.equal(hostile.badgeGlyph, "!");
      });

      it(`WHEN a test inspects tokenDispositions in ${name}, selected returns ringStrokeStyle 'double' with badgeShape 'corner-chevrons'`, () => {
        const selected = palette.tokenDispositions.selected;
        assert.equal(selected.ringStrokeStyle, "double");
        assert.equal(selected.badgeShape, "corner-chevrons");
      });

      it(`WHEN a test inspects tokenDispositions in ${name}, activeTurn returns ringColorHex 0xf59e0b with badgeShape 'chevron-beacon' and badgeGlyph '›'`, () => {
        const activeTurn = palette.tokenDispositions.activeTurn;
        assert.equal(activeTurn.ringColorHex, 0xf59e0b);
        assert.equal(activeTurn.badgeShape, "chevron-beacon");
        assert.equal(activeTurn.badgeGlyph, "›");
      });

      it(`WHEN a test evaluates all 4 dispositions in ${name}, each presents a unique geometric non-color signature`, () => {
        const kinds: TokenDispositionKind[] = ["ally", "hostile", "selected", "activeTurn"];
        const signatures = new Set<string>();
        for (const kind of kinds) {
          const style = palette.tokenDispositions[kind];
          const sig = `${style.ringStrokeStyle}:${style.badgeShape}:${style.badgeGlyph}:${JSON.stringify(style.dashPatternPx)}`;
          assert.equal(
            signatures.has(sig),
            false,
            `Duplicate geometric signature detected for disposition '${kind}' in ${name}`,
          );
          signatures.add(sig);
        }
        assert.equal(signatures.size, 4);
      });
    }
  });

  describe("Acceptance Criterion 5: Wall Kinds Strict Injective Geometry", () => {
    const canonicalKinds: readonly CanonicalWallKind[] = [
      "Normal",
      "Window",
      "Terrain",
      "OneWay",
      "SecretDoor",
      "Door",
      "Illusion",
    ];

    const testPalettes: ReadonlyArray<{ name: string; palette: CanvasThemePaletteSpec }> = [
      { name: "DARK_CANVAS_PALETTE", palette: DARK_CANVAS_PALETTE },
      { name: "LIGHT_CANVAS_PALETTE", palette: LIGHT_CANVAS_PALETTE },
    ];

    for (const { name, palette } of testPalettes) {
      it(`WHEN a test inspects wallKinds in ${name}, each of the 7 wall kinds presents a distinct tuple of dashPatternPx and endpointMarker`, () => {
        const tuples = new Set<string>();
        for (const kind of canonicalKinds) {
          const wall = palette.wallKinds[kind];
          assert.ok(wall, `WallKind '${kind}' must exist in ${name}`);
          const tupleKey = `${JSON.stringify(wall.dashPatternPx)}|${wall.endpointMarker}`;
          assert.equal(
            tuples.has(tupleKey),
            false,
            `WallKind '${kind}' in ${name} shares non-color tuple ${tupleKey} with another wall kind`,
          );
          tuples.add(tupleKey);
        }
        assert.equal(tuples.size, 7);
      });
    }
  });

  describe("Acceptance Criterion 6: MCP Staging Ghost Visual Specification", () => {
    const testPalettes: ReadonlyArray<{ name: string; palette: CanvasThemePaletteSpec }> = [
      { name: "DARK_CANVAS_PALETTE", palette: DARK_CANVAS_PALETTE },
      { name: "LIGHT_CANVAS_PALETTE", palette: LIGHT_CANVAS_PALETTE },
    ];

    for (const { name, palette } of testPalettes) {
      it(`WHEN a test inspects mcpStagingGhost in ${name}, the configuration returns fillAlpha 0.55, dashPatternPx [4, 4], and badgeText 'STAGED'`, () => {
        const ghost = palette.mcpStagingGhost;
        assert.equal(ghost.fillAlpha, 0.55);
        assert.deepEqual(ghost.dashPatternPx, [4, 4]);
        assert.equal(ghost.badgeText, "STAGED");
      });
    }
  });

  describe("Immutability & Safety Floor Guards", () => {
    it("enforces immutable frozen specification on DARK_CANVAS_PALETTE and LIGHT_CANVAS_PALETTE", () => {
      assert.ok(Object.isFrozen(DARK_CANVAS_PALETTE));
      assert.ok(Object.isFrozen(LIGHT_CANVAS_PALETTE));
      assert.ok(Object.isFrozen(DARK_CANVAS_PALETTE.tokenDispositions));
      assert.ok(Object.isFrozen(LIGHT_CANVAS_PALETTE.tokenDispositions));
      assert.ok(Object.isFrozen(DARK_CANVAS_PALETTE.tokenDispositions.ally));
      assert.ok(Object.isFrozen(DARK_CANVAS_PALETTE.mcpStagingGhost));
      assert.ok(Object.isFrozen(DARK_CANVAS_PALETTE.wallKinds));
      assert.ok(Object.isFrozen(DARK_CANVAS_PALETTE.aoeTemplate));
    });

    it("rejects runtime property mutations on frozen palette instances", () => {
      assert.throws(() => {
        // @ts-expect-error mutating frozen object
        DARK_CANVAS_PALETTE.mapArtFilter = "invert";
      }, TypeError);

      assert.throws(() => {
        // @ts-expect-error mutating frozen nested object
        DARK_CANVAS_PALETTE.tokenDispositions.ally.badgeShape = "circle";
      }, TypeError);

      assert.throws(() => {
        // @ts-expect-error mutating frozen nested object
        DARK_CANVAS_PALETTE.mcpStagingGhost.badgeText = "MUTATED";
      }, TypeError);
    });

    it("verifies AoE template geometry configuration in both palettes", () => {
      for (const palette of [DARK_CANVAS_PALETTE, LIGHT_CANVAS_PALETTE]) {
        const aoe = palette.aoeTemplate;
        assert.ok(aoe.fillAlpha > 0);
        assert.ok(Array.isArray(aoe.dashPatternPx));
        assert.ok(Array.isArray(aoe.boundaryDashPx));
        assert.equal(aoe.markerShape, "crosshair");
      }
    });
  });
});
