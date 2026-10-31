# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME combines a high-frequency 7-layer `PixiJS v8` tactical `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `UndoDrawer`, `DeclarativeSheetRenderer`, and `MobileCompanionLayout`). Without an explicit design system contract and a strict token boundary between DOM CSS and WebGL canvas primitives:
1. Ad-hoc hex colors in DOM components break daylight readability (`light` mode) and fail WCAG 2.2 AA contrast thresholds.
2. Naively applying CSS theme filters (`invert`, `brightness`) to the canvas corrupts user-uploaded battlemap artwork on the `backgroundMap` layer, while leaving the canvas completely unthemed causes jarring contrast when panning across empty canvas void in `light` mode.
3. Relying solely on color to distinguish token allegiance (`ally` vs. `hostile`), active turns, `WallSegment` permeability kinds (`SecretDoor`, `Illusion`), or `MCP Staging Mode` previews fails color-vision accessibility and blends into saturated map art.
4. Live combat sessions expose Actor sheets to accidental structural edits during roll actions.
5. External Google Fonts CDN requests in the browser leak player IP addresses and fail in offline Docker or air-gapped `.trame` Archive deployments.
6. Automated pull request verification lacked fail-closed linting for WCAG 2.2 AA contrast ratios, raw hex elimination, and anti-slop design invariants.

## Decision
1. **ATLAS v1.1 Cartographic Design System (`DESIGN.md` & `.impeccable/design.json`)**:
   - Adopt the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) codified in root `DESIGN.md` (8 canonical Impeccable sections + YAML frontmatter), machine-readable `.impeccable/design.json` (Schema v2 sidecar), `.impeccable/config.json`, and surface contracts (`.impeccable/surfaces/table-operate.md`, `.impeccable/surfaces/campaign-read.md`).
   - Provide dual-theme semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).
2. **Hybrid DOM / PixiJS Token Boundary (`tokens.css` & `CanvasThemePalette`)**:
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` (for DOM CSS custom properties) and `packages/web/src/canvas/CanvasThemePalette.ts` (for typed `PixiJS v8` numeric hex/alpha constants and stroke patterns).
   - Theme changes propagate reactively via `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to `<html data-theme="...">` and to PixiJS vector layers via `getCanvasThemePalette(resolvedThemeSignal.value)`.
   - **The Map-Art Independence Rule**: `CanvasThemePalette` switches the empty canvas void and `gridOverlay` lines between dark slate and light parchment while keeping `FogLayer` Layer 0 (`Unexplored`) permanently opaque `#0F1A25` (`0x0f1a25`) in all themes. Uploaded battlemap textures on Layer 0 (`backgroundMap`) maintain `mapArtFilter: "none"`, prohibiting CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments.
   - **The Non-Color Redundancy Rule**: Every tactical canvas and HUD state pairs its color token with a unique geometric shape, badge glyph, or stroke dash pattern:
     - Actor token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge.
     - Active turn: highlighted with an amber halo and directional chevron marker (`›`).
     - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` (`Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, `Illusion`).
     - `MCP Staging Mode`: preview mutations display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.
3. **Actor Sheet Integrity via `PadlockEditMode`**:
   - `DeclarativeSheetRenderer` includes an explicit header toggle `[data-testid="sheet-padlock-toggle"]` controlling `PadlockEditMode`.
   - When locked (`aria-pressed="false"`), the renderer disables or sets `readonly: true` on all structural Actor definitions (name, class, level, ability scores, maximum hit points, skills, saving throw proficiencies, inventory modifications, known/prepared spells, feature descriptions).
   - Roll triggers (`roll-button`) and volatile combat counters (current hit points, temporary hit points, spell slots, death saves, resources, condition badges, inspiration) remain continuously interactive.
4. **Self-Hosted WOFF2 Typography & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (`500`, `600`) and `IBM Plex Sans` (`400`, `500`, `600`) directly in `packages/web/public/fonts/` with `OFL-1.1` attribution, eliminating external Google Fonts CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) on all numeric combat, ruler, dice, and character sheet fields.
5. **In-House SVG Asset Suite**:
   - Deliver vector components within the web package: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines without baked-in `<text>` tags, ensuring localized HTML rendering).
6. **Multi-Stage Fail-Closed Governance & Impeccable Gate**:
   - **Seam 1 (Static CI Verification)**: `scripts/check-impeccable-design.mjs` executes under `make lint` alongside `impeccable detect` (`engine-v0.1.18`) to verify YAML frontmatter, 8 canonical sections in `DESIGN.md`, Schema v2 integrity in `.impeccable/design.json`, WCAG 2.2 AA contrast ratios (`>= 4.5:1` text, `>= 3.0:1` focus/UI), absence of raw hex literals outside `tokens.css` and `CanvasThemePalette.ts`, absence of font CDN calls, and compliance with all 62 Impeccable Craft Floor anti-slop rules.
   - **Seam 2 (Behavioral Test Verification)**: Parameterized unit tests in `packages/web/tests/designSystem.test.ts` execute under `make test-web` to assert WCAG relative luminance calculations, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` field lock transitions.
   - **Stage 3 EPURE Multi-Agent Review**: EPURE `multi-agent-pr-review` injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences
### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without altering uploaded battlemap artwork.
- Full tactical accessibility for color-blind players through geometric discrimination across tokens, turns, and wall segments.
- Accidental Actor sheet mutation during live tabletop combat is eliminated via `PadlockEditMode`.
- Full offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Automated, fail-closed prevention of design drift and AI-slop regressions across CI, unit tests, and EPURE multi-agent reviews.

### Negative
- New UI components and canvas overlays must consume `--atlas-*` CSS variables or `CanvasThemePalette` entries rather than inline hex literals, enforced by `scripts/check-impeccable-design.mjs`.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.
