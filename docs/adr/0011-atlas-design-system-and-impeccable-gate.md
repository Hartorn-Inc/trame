# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME combines a high-frequency 7-layer `PixiJS v8` tactical `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `UndoDrawer`, `DeclarativeSheetRenderer`, `MobileCompanionLayout`, and `CRDTDocument`). Without an explicit design system contract and a strict token boundary between DOM CSS and WebGL canvas primitives:
1. Ad-hoc hex colors in DOM components and `WidgetRegistry` renderers break daylight readability (`light` mode) and fail WCAG 2.2 AA contrast thresholds.
2. Naively applying CSS theme filters (`invert`, `brightness`) to the canvas corrupts user-uploaded battlemap artwork on the `backgroundMap` layer, while leaving the canvas unthemed causes jarring contrast when panning across empty canvas void in `light` mode.
3. Relying solely on color to distinguish token allegiance (`ally` vs. `hostile`), active turns, `WallSegment` permeability kinds (`Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, `Illusion`), or `MCP Staging Mode` preview ghosts fails color-vision accessibility and blends into saturated map art.
4. Live combat sessions expose Actor sheets to accidental structural edits during roll actions.
5. Web fonts loaded from external CDNs leak player IP addresses and fail in offline Docker or air-gapped `.trame` Archive deployments.
6. Automated pull request verification lacks fail-closed linting for WCAG 2.2 AA contrast ratios, raw hex elimination, and anti-slop design invariants.

## Decision
We establish and enforce the **TRAME ATLAS v1.1** design system across all client packages through the following architectural decisions:

1. **ATLAS v1.1 Cartographic Design System (`DESIGN.md` & `.impeccable/design.json`)**:
   - Codify the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) in root `DESIGN.md` (8 canonical sections + YAML frontmatter) and `.impeccable/design.json` (Schema v2 sidecar) alongside surface contracts (`.impeccable/surfaces/table-operate.md`, `.impeccable/surfaces/campaign-read.md`).
   - Provide dual-theme semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).
   - Propagate theme state reactively via `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to the DOM via `<html data-theme="...">` and to PixiJS vector layers via explicit layer style updates.

2. **Hybrid DOM / PixiJS Token Boundary (`tokens.css` & `CanvasThemePalette`)**:
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` (for DOM CSS custom properties) and `packages/web/src/canvas/CanvasThemePalette.ts` (for typed `PixiJS v8` numeric hex/alpha constants and stroke patterns via `getCanvasThemePalette`).
   - Prohibit raw hex, `rgb()`, or `hsl()` literals outside these two files across all web packages.

3. **The Map-Art Independence Rule**:
   - `CanvasThemePalette` switches the empty canvas void and `gridOverlay` lines between dark slate and light parchment while enforcing `mapArtFilter: 'none'` on Layer 0 (`backgroundMap`).
   - Prohibit CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments on battlemap textures.
   - Keep `FogLayer` Layer 0 (`Unexplored`) permanently opaque dark slate `#0F1A25` (`0x0f1a25`) in all themes to preserve optical dynamic range and 2.5D lighting fidelity.

4. **Non-Color Tactical Redundancy**:
   - Every tactical canvas and HUD state pairs color with a unique geometric shape, badge glyph, or stroke dash pattern:
     - Actor token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge and `!` glyph; `selected` uses a double ring with corner chevrons; `activeTurn` uses an amber halo with a directional chevron beacon.
     - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` for `Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, and `Illusion`.
     - `MCP Staging Mode`: preview mutations display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.

5. **Actor Sheet Integrity via `PadlockEditMode`**:
   - Guard structural Actor sheet edits behind `PadlockEditMode` controlled by `[data-testid="sheet-padlock-toggle"]` in `DeclarativeSheetRenderer`.
   - When locked (`aria-pressed="false"`), disable or set `readonly: true` on all 12 structural definition categories (name, class, level, ability scores, max HP, base AC, speeds, skills, saving throws, inventory modification, spell lists, feature descriptions).
   - Keep operational combat controls continuously interactive (roll buttons, current HP, temp HP, death saves, spell slots, resource counters, condition badges, inspiration, rest triggers).

6. **Self-Hosted WOFF2 Typography & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (weights 500, 600) and `IBM Plex Sans` (weights 400, 500, 600) directly in `packages/web/public/fonts/` alongside their `OFL-1.1.txt` license, prohibiting font CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) across all numeric combat counters, roll outputs, ruler measurements, and sheet statistics.

7. **In-House SVG Asset Suite**:
   - Deliver SVG components within the web bundle: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines and geometric hatching without baked-in `<text>` tags).
   - Enforce minimum touch target dimensions of 44x44 px on mobile (`MobileCompanionLayout`) and 40 px on desktop.

8. **Two-Stage Fail-Closed Governance**:
   - **Seam 1 (Static CI Verification)**: `scripts/check-impeccable-design.mjs` executes under `make lint` alongside `impeccable detect` (`engine-v0.1.18`) to verify WCAG 2.2 AA contrast ratios (`>= 4.5:1` text, `>= 3.0:1` focus/UI), absence of raw hex literals outside `tokens.css` and `CanvasThemePalette.ts`, absence of font CDN calls, and compliance with all 62 Impeccable Craft Floor anti-slop rules.
   - **Seam 2 (Behavioral Test Verification)**: Parameterized unit tests in `packages/web/tests/designSystem.test.ts` execute under `make test-web`. They assert WCAG relative luminance calculations, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` field lock transitions.
   - **Stage 3 EPURE Review**: Multi-agent review injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences

### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without altering battlemap artwork.
- Full offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Guaranteed tactical accessibility for color-blind users through geometric discriminators.
- Prevention of accidental Actor sheet mutation during live tabletop combat.
- Automated, fail-closed prevention of design drift and AI-slop regressions across CI and EPURE multi-agent reviews.

### Negative & Trade-offs
- Adding new colors requires declaring them in `tokens.css` and updating `CanvasThemePalette.ts`.
- Developers cannot use ad-hoc inline styles or raw hex values in Preact components.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.
