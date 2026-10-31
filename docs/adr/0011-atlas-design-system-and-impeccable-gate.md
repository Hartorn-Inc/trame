# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME combines a high-frequency 7-layer `PixiJS v8` tactical `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `UndoDrawer`, `DeclarativeSheetRenderer`, and `MobileCompanionLayout`). Without an explicit design system contract and a strict token boundary between DOM CSS and WebGL canvas primitives:
1. Ad-hoc hex colors in DOM components break daylight readability (`light` mode) and fail WCAG 2.2 AA contrast thresholds.
2. Naively applying CSS theme filters (`invert`, `brightness`) to the canvas corrupts user-uploaded battlemap artwork on the `backgroundMap` layer, while leaving the canvas completely unthemed causes jarring contrast when panning across empty canvas void in `light` mode.
3. Tactical indicators (Actor token allegiance, active turn badges, `WallSegment` permeability kinds, and `MCPStagingMode` ghosts) rely solely on color, impairing accessibility for color-blind users.
4. Live combat sessions expose Actor sheets to accidental structural edits during roll actions.
5. External Google Fonts CDN requests in the browser leak player IP addresses and fail in offline Docker or air-gapped `.trame` Archive deployments.
6. Automated pull request verification lacks fail-closed linting for WCAG 2.2 AA contrast ratios, raw hex elimination, and anti-slop design invariants.

## Decision
1. **Canonical Design Contracts & Sidecar Specifications (`DESIGN.md` & `.impeccable/design.json`)**:
   - Adopt the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) codified in root `DESIGN.md` (8 canonical Impeccable sections + YAML frontmatter) and `.impeccable/design.json` (Schema v2 sidecar).
   - Pair `DESIGN.md` with `.impeccable/config.json` and surface contracts (`.impeccable/surfaces/table-operate.md`, `.impeccable/surfaces/campaign-read.md`).
   - Provide dual-theme semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).
2. **Hybrid DOM / PixiJS Token Boundary (`tokens.css` & `CanvasThemePalette`)**:
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` (for DOM CSS custom properties) and `packages/web/src/canvas/CanvasThemePalette.ts` (for typed `PixiJS v8` numeric hex/alpha constants and stroke patterns).
   - Theme changes propagate reactively from `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to the DOM via `<html data-theme="...">` and to PixiJS vector layers via explicit layer style updates.
3. **The Map-Art Independence Rule**:
   - `CanvasThemePalette` and Layer 0 (`backgroundMap`) enforce `mapArtFilter: "none"`.
   - The rendering pipeline prohibits CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments on battlemap textures.
   - `FogLayer` Layer 0 (`Unexplored`) remains permanently opaque `#0F1A25` (`0x0f1a25`) in all themes to preserve optical dynamic range and 2.5D lighting fidelity.
   - `canvasVoidHex` switches between `0x0f1a25` (dark) and `0xf4f7f9` (light).
4. **Non-Color Tactical Redundancy**:
   - Every tactical canvas and HUD state pairs color with a distinct geometric shape, badge glyph, or stroke dash pattern:
     - Actor token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge and `!` glyph; `selected` uses a double ring with corner chevrons; `activeTurn` uses an amber halo with a directional chevron marker (`›` glyph).
     - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` for `Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, and `Illusion`.
     - `MCPStagingMode`: preview mutations display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.
5. **Actor Sheet Integrity via `PadlockEditMode`**:
   - `DeclarativeSheetRenderer` includes header toggle `[data-testid="sheet-padlock-toggle"]` controlling `PadlockEditMode`.
   - When locked (`aria-pressed="false"`), renderer disables or sets `readonly: true` on all 12 structural Actor definition categories (name, class, level, ability scores, max HP, skills, equipment, spells, features).
   - Operational combat controls (dice roll buttons, current HP, temp HP, death saves, spell slots, resource counters, condition badges, inspiration, rests) remain continuously interactive.
6. **Total Offline Font Self-Hosting & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (weights 500, 600) and `IBM Plex Sans` (weights 400, 500, 600) directly under `packages/web/public/fonts/` alongside `OFL-1.1.txt` attribution, eliminating external font CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) on all numeric combat, ruler, dice, and character sheet fields.
7. **In-House SVG Asset Suite**:
   - Deliver bundled SVG components: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines without baked-in `<text>` tags, ensuring localized HTML rendering).
8. **Three-Stage Fail-Closed Governance**:
   - Stage 1 (Static CI Verification): `scripts/check-impeccable-design.mjs` executes under `make lint`. Validates YAML frontmatter, canonical sections in `DESIGN.md`, Schema v2 in `.impeccable/design.json`, mathematical WCAG 2.2 AA contrast ratios, zero raw hex outside `tokens.css` and `CanvasThemePalette.ts`, zero font CDN calls, and compliance with all 62 Impeccable Craft Floor rules (`impeccable detect`).
   - Stage 2 (Behavioral Test Verification): Parameterized unit tests in `packages/web/tests/designSystem.test.ts` execute under `make test-web`. Asserts WCAG relative luminance calculations, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` field lock transitions.
   - Stage 3 (EPURE Multi-Agent Review Gate): EPURE multi-agent PR review injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences
### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without altering uploaded battlemap artwork.
- Tactical accessibility guaranteed for color-blind players through geometric discriminators.
- Protection against accidental Actor sheet mutations during live tabletop combat via `PadlockEditMode`.
- Full offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Automated, fail-closed prevention of design drift and AI-slop regressions in CI and EPURE multi-agent reviews.

### Negative
- New UI components and canvas overlays must consume `--atlas-*` CSS variables or `CanvasThemePalette` entries rather than inline hex literals, enforced by `scripts/check-impeccable-design.mjs`.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.
