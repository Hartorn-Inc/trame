# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME combines a high-frequency 7-layer `PixiJS v8` tactical `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `UndoDrawer`, `DeclarativeSheetRenderer`, and `MobileCompanionLayout`) across live tabletop sessions (`ExplorationMode`, `TurnByTurnMode`) and collaborative notes (`CRDTDocument`).

Without an explicit design system contract and a strict token boundary between DOM CSS and WebGL canvas primitives:
1. Ad-hoc hex colors in DOM components and headless `WidgetRegistry` renderers break daylight readability (`light` mode) and fail WCAG 2.2 AA contrast thresholds.
2. Naively applying CSS theme filters (`invert`, `brightness`) to the canvas corrupts user-uploaded battlemap artwork on the `backgroundMap` layer, while leaving the canvas void unthemed causes jarring contrast in `light` mode.
3. Tactical indicators (Actor token allegiance, active turn badges, `WallSegment` permeability kinds, and `MCP Staging Mode` previews) rely solely on color, impairing color-vision accessibility and blending into saturated map art.
4. Live combat sessions expose Actor sheets to accidental structural edits during roll actions.
5. External Google Fonts CDN requests in the browser leak player IP addresses, break offline Docker parity, and fail in air-gapped `.trame` Archive deployments.
6. CI verification lacks fail-closed linting for WCAG 2.2 AA contrast ratios, raw hex elimination, and Impeccable Craft Floor anti-slop rules.

## Decision
We establish and enforce the **TRAME ATLAS v1.1** design system across all client packages through the following architectural decisions:

1. **ATLAS v1.1 Cartographic Design System (`DESIGN.md` & `.impeccable/design.json`)**:
   - Adopt the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) codified in root `DESIGN.md` (8 canonical Impeccable sections + YAML frontmatter), machine-readable `.impeccable/design.json` (Schema v2 sidecar), `.impeccable/config.json`, and surface contracts (`.impeccable/surfaces/table-operate.md`, `.impeccable/surfaces/campaign-read.md`).
   - Provide dual-theme semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).

2. **Hybrid DOM / PixiJS Token Boundary (`tokens.css` & `CanvasThemePalette`)**:
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` (for DOM CSS custom properties) and `packages/web/src/canvas/CanvasThemePalette.ts` (for typed `PixiJS v8` numeric hex/alpha constants and stroke patterns via `getCanvasThemePalette(mode: ResolvedAtlasTheme)`).
   - Theme changes propagate reactively from `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to the DOM via `<html data-theme="...">` and to PixiJS vector layers via explicit layer style updates.

3. **The Map-Art Independence Rule**:
   - `CanvasThemePalette` switches the empty canvas void (`canvasVoidHex`) and `gridOverlay` lines between dark slate and light parchment while keeping `FogLayer` Layer 0 (`Unexplored`) opaque dark (`0x0f1a25`).
   - The rendering pipeline enforces `mapArtFilter: "none"`, prohibiting CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments so uploaded battlemap artwork is never altered by theme changes.

4. **Non-Color Tactical Redundancy**:
   - Every tactical canvas and HUD state pairs its color token with a unique geometric shape, badge glyph, or stroke dash pattern:
     - Actor token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge.
     - Active turn: highlighted with an amber halo and a directional chevron marker.
     - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` for `Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, and `Illusion`.
     - `MCP Staging Mode`: preview mutations display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.

5. **Actor Sheet Integrity via `PadlockEditMode`**:
   - `DeclarativeSheetRenderer` includes an explicit header toggle `[data-testid="sheet-padlock-toggle"]` controlling `PadlockEditMode`.
   - When locked (`aria-pressed="false"`), the renderer disables or sets `readonly: true` on all structural Actor definitions (name, class, level, ability scores, maximum hit points, skills, equipment modification).
   - Dice roll buttons (`roll-button`) and volatile combat counters (current hit points, temporary hit points, spell slots, death saves, resource pools) remain continuously interactive.

6. **Self-Hosted WOFF2 Typography & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (`500`, `600`) and `IBM Plex Sans` (`400`, `500`, `600`) under `packages/web/public/fonts/` with `OFL-1.1` attribution, eliminating external font CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) on all numeric combat, ruler, dice, and character sheet fields.

7. **In-House SVG Asset Suite**:
   - Deliver SVG components within the web bundle: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines without baked-in `<text>` tags, ensuring localized HTML rendering).

8. **Three-Stage Fail-Closed Governance & Impeccable Gate**:
   - **Stage 1 (Static CI Verification)**: `scripts/check-impeccable-design.mjs` executes under `make lint`. It validates YAML frontmatter, canonical sections in `DESIGN.md`, Schema v2 integrity in `.impeccable/design.json`, mathematical WCAG 2.2 AA contrast ratios (`>= 4.5:1` text, `>= 3.0:1` focus/UI), absence of raw hex literals outside `tokens.css` and `CanvasThemePalette.ts`, absence of font CDN calls, and compliance with Impeccable Craft Floor invariants (`impeccable detect`).
   - **Stage 2 (Behavioral Test Verification)**: Parameterized unit tests in `packages/web/tests/designSystem.test.ts` execute under `make test-web`. They assert WCAG relative luminance calculations, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` field lock transitions.
   - **Stage 3 (EPURE Multi-Agent PR Review)**: Injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences

### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without altering uploaded battlemap artwork.
- Full offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Full tactical accessibility for color-blind players through geometric discriminators across tokens, wall segments, and MCP staging previews.
- Elimination of accidental Actor sheet mutations during live tabletop combat via `PadlockEditMode`.
- Automated, fail-closed prevention of design drift and AI-slop regressions in CI, behavioral unit tests, and EPURE multi-agent reviews.

### Negative & Trade-offs
- New UI components and canvas overlays must consume `--atlas-*` CSS variables or `CanvasThemePalette` entries rather than inline hex literals, enforced by `scripts/check-impeccable-design.mjs`.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.
