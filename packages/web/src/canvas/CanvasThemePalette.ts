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

export type TokenBadgeShape =
  | "shield"
  | "diamond"
  | "corner-chevrons"
  | "chevron-beacon"
  | "circle"
  | "square"
  | "hexagon-bang"
  | "chevron";

export type TokenBadgeGlyph = "" | "!" | "›";

export type TokenRingStrokeStyle = "solid" | "dashed" | "double";

export interface TokenDispositionStyle {
  readonly ringColorHex: number;
  readonly ringColorCss: string;
  readonly ringStrokeStyle: TokenRingStrokeStyle;
  readonly dashPatternPx: readonly [number, number] | null;
  readonly badgeShape: TokenBadgeShape;
  readonly badgeGlyph: TokenBadgeGlyph;
}

export type CanonicalWallKind =
  | "Normal"
  | "Window"
  | "Terrain"
  | "OneWay"
  | "SecretDoor"
  | "Door"
  | "Illusion";

export type WallEndpointMarker = "none" | "square" | "diamond" | "slash" | "chevron";

export interface WallKindVisualStyle {
  readonly strokeColorHex: number;
  readonly strokeColorCss: string;
  readonly strokeWidthPx: number;
  readonly dashPatternPx: readonly [number, number] | null;
  readonly endpointMarker: WallEndpointMarker;
}

export interface McpStagingGhostStyle {
  readonly fillHex: number;
  readonly strokeHex: number;
  readonly fillAlpha: number;
  readonly dashPatternPx: readonly [number, number];
  readonly markerShape?: "crosshair" | "ghost-diamond";
  readonly badgeText: "STAGED";
}

export interface AoeTemplateStyle {
  readonly fillHex: number;
  readonly strokeHex: number;
  readonly fillAlpha: number;
  readonly dashPatternPx: readonly [number, number];
  readonly boundaryDashPx: readonly [number, number];
  readonly markerShape?: "crosshair" | "ghost-diamond";
}

export interface SpatialOverlayStyle {
  readonly fillHex: number;
  readonly strokeHex: number;
  readonly fillAlpha: number;
  readonly dashPatternPx: readonly [number, number];
  readonly markerShape?: "crosshair" | "ghost-diamond";
  readonly badgeText?: string;
  readonly boundaryDashPx?: readonly [number, number];
}

export interface CanvasThemePaletteSpec {
  readonly theme: ResolvedAtlasTheme;
  readonly mapArtFilter: "none";
  readonly canvasVoidHex: number;
  readonly canvasVoidCss: string;
  readonly surfaceHex: number;
  readonly surfaceCss: string;
  readonly surfaceRaisedHex: number;
  readonly surfaceRaisedCss: string;
  readonly textHex: number;
  readonly textCss: string;
  readonly textMutedHex: number;
  readonly textMutedCss: string;
  readonly borderHex: number;
  readonly borderCss: string;
  readonly actionHex: number;
  readonly actionCss: string;
  readonly onActionHex: number;
  readonly onActionCss: string;
  readonly focusHex: number;
  readonly focusCss: string;
  readonly dangerHex: number;
  readonly dangerCss: string;
  readonly gridLineHex: number;
  readonly gridLineAlpha: number;
  readonly fogUnexploredHex: number;
  readonly fogExploredDimAlpha: number;
  readonly rulerStrokeHex: number;
  readonly pointerPingHex: number;
  readonly mcpStagingGhost: McpStagingGhostStyle;
  readonly aoeTemplate: AoeTemplateStyle;
  readonly tokenDispositions: Readonly<Record<TokenDispositionKind, TokenDispositionStyle>>;
  readonly wallKinds: Readonly<Record<CanonicalWallKind, WallKindVisualStyle>>;
}

/**
 * Deep freezes an object recursively to guarantee strict immutability.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Canonical PointerPing radar pulse colors used by `TableClientStore`.
 */
export const CANVAS_RADIAL_PING_COLORS: Readonly<Record<"ALERT" | "ATTENTION" | "QUESTION", string>> =
  deepFreeze({
    ALERT: "#D57973",
    ATTENTION: "#F3BB71",
    QUESTION: "#80CBE2",
  });

/**
 * Canonical AmbientPreset lighting tint colors used by `GmOverrideToolbarManager`.
 */
export const CANVAS_AMBIENT_TINTS: Readonly<
  Record<"DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS", string>
> = deepFreeze({
  DAYLIGHT: "#ffffff",
  DUSK: "#F3BB71",
  NIGHT_MOONLIGHT: "#203243",
  PITCH_DARKNESS: "#0F1A25",
});

const SHARED_WALL_KINDS: Readonly<Record<CanonicalWallKind, WallKindVisualStyle>> = deepFreeze({
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
});

export const DARK_CANVAS_PALETTE: CanvasThemePaletteSpec = deepFreeze({
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
    fillAlpha: 0.55,
    dashPatternPx: [4, 4] as const,
    markerShape: "ghost-diamond",
    badgeText: "STAGED",
  },
  aoeTemplate: {
    fillHex: 0x80cbe2,
    strokeHex: 0xf3bb71,
    fillAlpha: 0.22,
    dashPatternPx: [8, 4] as const,
    boundaryDashPx: [8, 4] as const,
    markerShape: "crosshair",
  },
  tokenDispositions: {
    ally: {
      ringColorHex: 0x80cbe2,
      ringColorCss: "#80CBE2",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "shield",
      badgeGlyph: "",
    },
    hostile: {
      ringColorHex: 0xd57973,
      ringColorCss: "#D57973",
      ringStrokeStyle: "dashed",
      dashPatternPx: [6, 4] as const,
      badgeShape: "diamond",
      badgeGlyph: "!",
    },
    selected: {
      ringColorHex: 0xf1f4f3,
      ringColorCss: "#F1F4F3",
      ringStrokeStyle: "double",
      dashPatternPx: null,
      badgeShape: "corner-chevrons",
      badgeGlyph: "",
    },
    activeTurn: {
      ringColorHex: 0xf59e0b,
      ringColorCss: "#F59E0B",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "chevron-beacon",
      badgeGlyph: "›",
    },
  },
  wallKinds: SHARED_WALL_KINDS,
});

export const LIGHT_CANVAS_PALETTE: CanvasThemePaletteSpec = deepFreeze({
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
    fillAlpha: 0.55,
    dashPatternPx: [4, 4] as const,
    markerShape: "ghost-diamond",
    badgeText: "STAGED",
  },
  aoeTemplate: {
    fillHex: 0x155d77,
    strokeHex: 0x995817,
    fillAlpha: 0.2,
    dashPatternPx: [8, 4] as const,
    boundaryDashPx: [8, 4] as const,
    markerShape: "crosshair",
  },
  tokenDispositions: {
    ally: {
      ringColorHex: 0x155d77,
      ringColorCss: "#155D77",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "shield",
      badgeGlyph: "",
    },
    hostile: {
      ringColorHex: 0xa3333b,
      ringColorCss: "#A3333B",
      ringStrokeStyle: "dashed",
      dashPatternPx: [6, 4] as const,
      badgeShape: "diamond",
      badgeGlyph: "!",
    },
    selected: {
      ringColorHex: 0x1c3041,
      ringColorCss: "#1C3041",
      ringStrokeStyle: "double",
      dashPatternPx: null,
      badgeShape: "corner-chevrons",
      badgeGlyph: "",
    },
    activeTurn: {
      ringColorHex: 0xf59e0b,
      ringColorCss: "#F59E0B",
      ringStrokeStyle: "solid",
      dashPatternPx: null,
      badgeShape: "chevron-beacon",
      badgeGlyph: "›",
    },
  },
  wallKinds: SHARED_WALL_KINDS,
});

/**
 * Resolves `AtlasThemeMode` (`dark`, `light`, `system`) into a concrete
 * `CanvasThemePaletteSpec`.
 */
export function getCanvasThemePalette(
  mode: AtlasThemeMode | ResolvedAtlasTheme = "dark",
  systemPrefersLight = false,
): CanvasThemePaletteSpec {
  const resolved: ResolvedAtlasTheme =
    mode === "system" ? (systemPrefersLight ? "light" : "dark") : mode;
  return resolved === "light" ? LIGHT_CANVAS_PALETTE : DARK_CANVAS_PALETTE;
}
