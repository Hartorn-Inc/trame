/**
 * ============================================================================
 * TRAME HYBRID CANVAS THEME PALETTE (CanvasThemePalette.ts)
 * ============================================================================
 *
 * Single authoritative registry of WebGL / PixiJS v8 colors and non-color
 * geometric stroke discriminators for the 7-layer tactical SceneGraph.
 *
 * INVARIANTS (DESIGN.md & ADR-0011):
 *   1. The Map-Art Independence Rule: `mapArtFilter` is strictly `"none"` in
 *      both `dark` and `light` themes so uploaded battlemap art on
 *      `backgroundMap` is never inverted, dimmed, or altered.
 *   2. Unexplored Fog (`FogLayer` Layer 0) remains opaque dark (`0x0f1a25`)
 *      in both themes while the canvas void (`canvasVoidHex`) and grid lines
 *      (`gridLineHex`) adapt to the active theme.
 *   3. The Non-Color Redundancy Rule: Every token disposition (`ally`,
 *      `hostile`, `selected`, `activeTurn`) and every `WallSegment` kind
 *      (`Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`,
 *      `Illusion`) pairs its color with a unique geometric shape, badge
 *      glyph, or stroke dash pattern.
 * ============================================================================
 */

export type AtlasThemeMode = "dark" | "light" | "system";
export type ResolvedAtlasTheme = "dark" | "light";

export type TokenDispositionKind = "ally" | "hostile" | "selected" | "activeTurn";

export interface TokenDispositionStyle {
  ringColorHex: number;
  ringColorCss: string;
  ringStrokeStyle: "solid" | "dashed" | "double";
  dashPatternPx: readonly [number, number] | null;
  badgeShape: "circle" | "square" | "hexagon-bang" | "chevron";
  badgeGlyph: "" | "!" | "›";
}

export type CanonicalWallKind =
  | "Normal"
  | "Window"
  | "Terrain"
  | "OneWay"
  | "SecretDoor"
  | "Door"
  | "Illusion";

export interface WallKindVisualStyle {
  strokeColorHex: number;
  strokeColorCss: string;
  strokeWidthPx: number;
  dashPatternPx: readonly [number, number] | null;
  endpointMarker: "none" | "square" | "diamond" | "slash" | "chevron";
}

export interface SpatialOverlayStyle {
  fillHex: number;
  strokeHex: number;
  fillAlpha: number;
  dashPatternPx: readonly [number, number];
  markerShape: "crosshair" | "ghost-diamond";
}

export interface CanvasThemePaletteSpec {
  theme: ResolvedAtlasTheme;
  mapArtFilter: "none";
  canvasVoidHex: number;
  canvasVoidCss: string;
  surfaceHex: number;
  surfaceCss: string;
  surfaceRaisedHex: number;
  surfaceRaisedCss: string;
  textHex: number;
  textCss: string;
  textMutedHex: number;
  textMutedCss: string;
  borderHex: number;
  borderCss: string;
  actionHex: number;
  actionCss: string;
  onActionHex: number;
  onActionCss: string;
  focusHex: number;
  focusCss: string;
  dangerHex: number;
  dangerCss: string;
  gridLineHex: number;
  gridLineAlpha: number;
  fogUnexploredHex: number;
  fogExploredDimAlpha: number;
  rulerStrokeHex: number;
  pointerPingHex: number;
  mcpStagingGhost: SpatialOverlayStyle;
  aoeTemplate: SpatialOverlayStyle;
  tokenDispositions: Record<TokenDispositionKind, TokenDispositionStyle>;
  wallKinds: Record<CanonicalWallKind, WallKindVisualStyle>;
}

/**
 * Canonical PointerPing radar pulse colors used by `TableClientStore`.
 */
export const CANVAS_RADIAL_PING_COLORS: Record<"ALERT" | "ATTENTION" | "QUESTION", string> = {
  ALERT: "#D57973",
  ATTENTION: "#F3BB71",
  QUESTION: "#80CBE2",
};

/**
 * Canonical AmbientPreset lighting tint colors used by `GmOverrideToolbarManager`.
 */
export const CANVAS_AMBIENT_TINTS: Record<
  "DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS",
  string
> = {
  DAYLIGHT: "#ffffff",
  DUSK: "#F3BB71",
  NIGHT_MOONLIGHT: "#203243",
  PITCH_DARKNESS: "#0F1A25",
};

export const SHARED_WALL_KINDS: Record<CanonicalWallKind, WallKindVisualStyle> = {
  Normal: {
    strokeColorHex: 0xf1f4f3,
    strokeColorCss: "#F1F4F3",
    strokeWidthPx: 3,
    dashPatternPx: null,
    endpointMarker: "square",
  },
  Window: {
    strokeColorHex: 0x80cbe2,
    strokeColorCss: "#80CBE2",
    strokeWidthPx: 2.5,
    dashPatternPx: [8, 4],
    endpointMarker: "diamond",
  },
  Terrain: {
    strokeColorHex: 0x67b587,
    strokeColorCss: "#67B587",
    strokeWidthPx: 2.5,
    dashPatternPx: [10, 3],
    endpointMarker: "slash",
  },
  OneWay: {
    strokeColorHex: 0xf3bb71,
    strokeColorCss: "#F3BB71",
    strokeWidthPx: 2.5,
    dashPatternPx: [6, 3],
    endpointMarker: "chevron",
  },
  SecretDoor: {
    strokeColorHex: 0xb794f4,
    strokeColorCss: "#B794F4",
    strokeWidthPx: 3,
    dashPatternPx: [4, 4],
    endpointMarker: "diamond",
  },
  Door: {
    strokeColorHex: 0xf3bb71,
    strokeColorCss: "#F3BB71",
    strokeWidthPx: 3.5,
    dashPatternPx: null,
    endpointMarker: "slash",
  },
  Illusion: {
    strokeColorHex: 0x9f7aea,
    strokeColorCss: "#9F7AEA",
    strokeWidthPx: 2,
    dashPatternPx: [2, 4],
    endpointMarker: "none",
  },
};

export const DARK_CANVAS_PALETTE: CanvasThemePaletteSpec = {
  theme: "dark",
  mapArtFilter: "none",
  canvasVoidHex: 0x0f1a25,
  canvasVoidCss: "#0F1A25",
  surfaceHex: 0x182736,
  surfaceCss: "#182736",
  surfaceRaisedHex: 0x203243,
  surfaceRaisedCss: "#203243",
  textHex: 0xf1f4f3,
  textCss: "#F1F4F3",
  textMutedHex: 0xb8c7d1,
  textMutedCss: "#B8C7D1",
  borderHex: 0x405466,
  borderCss: "#405466",
  actionHex: 0xf3bb71,
  actionCss: "#F3BB71",
  onActionHex: 0x172535,
  onActionCss: "#172535",
  focusHex: 0x80cbe2,
  focusCss: "#80CBE2",
  dangerHex: 0xd57973,
  dangerCss: "#D57973",
  gridLineHex: 0xb8c7d1,
  gridLineAlpha: 0.16,
  fogUnexploredHex: 0x0f1a25,
  fogExploredDimAlpha: 0.58,
  rulerStrokeHex: 0x80cbe2,
  pointerPingHex: 0xf3bb71,
  mcpStagingGhost: {
    fillHex: 0x9f7aea,
    strokeHex: 0xd6bcfa,
    fillAlpha: 0.28,
    dashPatternPx: [5, 5],
    markerShape: "ghost-diamond",
  },
  aoeTemplate: {
    fillHex: 0x80cbe2,
    strokeHex: 0xf3bb71,
    fillAlpha: 0.22,
    dashPatternPx: [8, 4],
    markerShape: "crosshair",
  },
  tokenDispositions: {
    ally: {
      ringColorHex: 0x80cbe2,
      ringColorCss: "#80CBE2",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "circle",
      badgeGlyph: "",
    },
    hostile: {
      ringColorHex: 0xd57973,
      ringColorCss: "#D57973",
      ringStrokeStyle: "dashed",
      dashPatternPx: [6, 4],
      badgeShape: "hexagon-bang",
      badgeGlyph: "!",
    },
    selected: {
      ringColorHex: 0xf1f4f3,
      ringColorCss: "#F1F4F3",
      ringStrokeStyle: "double",
      dashPatternPx: null,
      badgeShape: "square",
      badgeGlyph: "",
    },
    activeTurn: {
      ringColorHex: 0xf3bb71,
      ringColorCss: "#F3BB71",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "chevron",
      badgeGlyph: "›",
    },
  },
  wallKinds: SHARED_WALL_KINDS,
};

export const LIGHT_CANVAS_PALETTE: CanvasThemePaletteSpec = {
  theme: "light",
  mapArtFilter: "none",
  canvasVoidHex: 0xf4f7f9,
  canvasVoidCss: "#F4F7F9",
  surfaceHex: 0xffffff,
  surfaceCss: "#FFFFFF",
  surfaceRaisedHex: 0xe8eff3,
  surfaceRaisedCss: "#E8EFF3",
  textHex: 0x1c3041,
  textCss: "#1C3041",
  textMutedHex: 0x465d6d,
  textMutedCss: "#465D6D",
  borderHex: 0xacbfcb,
  borderCss: "#ACBFCB",
  actionHex: 0x995817,
  actionCss: "#995817",
  onActionHex: 0xffffff,
  onActionCss: "#FFFFFF",
  focusHex: 0x155d77,
  focusCss: "#155D77",
  dangerHex: 0xa3333b,
  dangerCss: "#A3333B",
  gridLineHex: 0x1c3041,
  gridLineAlpha: 0.14,
  fogUnexploredHex: 0x0f1a25,
  fogExploredDimAlpha: 0.58,
  rulerStrokeHex: 0x155d77,
  pointerPingHex: 0x995817,
  mcpStagingGhost: {
    fillHex: 0x6b46c1,
    strokeHex: 0x553c9a,
    fillAlpha: 0.24,
    dashPatternPx: [5, 5],
    markerShape: "ghost-diamond",
  },
  aoeTemplate: {
    fillHex: 0x155d77,
    strokeHex: 0x995817,
    fillAlpha: 0.2,
    dashPatternPx: [8, 4],
    markerShape: "crosshair",
  },
  tokenDispositions: {
    ally: {
      ringColorHex: 0x155d77,
      ringColorCss: "#155D77",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "circle",
      badgeGlyph: "",
    },
    hostile: {
      ringColorHex: 0xa3333b,
      ringColorCss: "#A3333B",
      ringStrokeStyle: "dashed",
      dashPatternPx: [6, 4],
      badgeShape: "hexagon-bang",
      badgeGlyph: "!",
    },
    selected: {
      ringColorHex: 0x1c3041,
      ringColorCss: "#1C3041",
      ringStrokeStyle: "double",
      dashPatternPx: null,
      badgeShape: "square",
      badgeGlyph: "",
    },
    activeTurn: {
      ringColorHex: 0x995817,
      ringColorCss: "#995817",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "chevron",
      badgeGlyph: "›",
    },
  },
  wallKinds: SHARED_WALL_KINDS,
};

/**
 * Resolves `AtlasThemeMode` (`dark`, `light`, `system`) into a concrete
 * `CanvasThemePaletteSpec`.
 */
export function getCanvasThemePalette(
  mode: AtlasThemeMode = "dark",
  systemPrefersLight = false,
): CanvasThemePaletteSpec {
  const resolved: ResolvedAtlasTheme =
    mode === "system" ? (systemPrefersLight ? "light" : "dark") : mode;
  return resolved === "light" ? LIGHT_CANVAS_PALETTE : DARK_CANVAS_PALETTE;
}
