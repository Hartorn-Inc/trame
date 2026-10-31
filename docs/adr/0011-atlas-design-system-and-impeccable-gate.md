# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME operates across live tabletop sessions (`ExplorationMode`, `TurnByTurnMode`), campaign preparation (`CampaignLobby`, `CampaignWorkspace`), declarative Actor sheets (`DeclarativeSheetRenderer`), collaborative notes (`CRDTDocument`), and smartphone companion screens (`MobileCompanionLayout`). The tactical table combines a high-frequency 7-layer `PixiJS v8` `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `UndoDrawer`, `DeclarativeSheetRenderer`, `MobileCompanionLayout`).

Without an explicit design system contract and a strict token boundary between DOM CSS and WebGL canvas primitives:
1. Ad-hoc inline hex colors in Preact views and `WidgetRegistry` renderers break daylight readability (`light` mode) and fail WCAG 2.2 AA contrast thresholds.
2. Naively applying CSS theme filters (`invert`, `brightness`) or WebGL color transformations to the canvas corrupts user-uploaded battlemap textures on Layer 0 (`backgroundMap`), while an unthemed canvas void causes jarring contrast when panning across empty space in `light` mode.
3. Tactical indicators (Actor token allegiance, active turn badges, `WallSegment` permeability kinds, and `MCP Staging Mode` ghost previews) relying solely on color fail accessibility for color-blind users and blend into saturated map art.
4. Live combat sessions risk accidental structural edits to Actor sheet definitions during dice rolls.
5. Web fonts loaded from external CDNs (Google Fonts) leak user IP addresses and fail in offline Docker and air-gapped `.trame` Archive deployments.
6. The CI pipeline lacked fail-closed linting for WCAG 2.2 AA contrast ratios, zero raw hex leakage, and Impeccable Craft Floor invariants.

## Decision
We establish and enforce the **TRAME ATLAS v1.1** design system across all client packages through the following architectural decisions:

1. **ATLAS v1.1 Cartographic Design System (`DESIGN.md` & `.impeccable/design.json`)**:
   - Codify the visual system (*"The Map Is the Workspace"*) in root `DESIGN.md` conforming strictly to the 8 canonical sections required by Impeccable standards (`## Overview`, `## Colors`, `## Typography`, `## Layout`, `## Elevation & Depth`, `## Shapes`, `## Components`, `## Do's and Don'ts`).
   - Pair `DESIGN.md` with the machine-readable `.impeccable/design.json` Schema v2 sidecar, `.impeccable/config.json`, and surface contracts.
   - Provide dual-theme semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).

2. **Hybrid DOM / PixiJS Token Boundary (`tokens.css` & `CanvasThemePalette`)**:
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` (for DOM CSS custom properties) and `packages/web/src/canvas/CanvasThemePalette.ts` (for typed `PixiJS v8` numeric hex/alpha constants and stroke patterns).
   - Theme changes propagate reactively from `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to the DOM via `<html data-theme="...">` and to PixiJS vector layers via `getCanvasThemePalette(mode: ResolvedAtlasTheme)`.

3. **The Map-Art Independence Rule**:
   - Uploaded battlemap textures on Layer 0 (`backgroundMap`) maintain `mapArtFilter: 'none'` with `filters = []`. The pipeline prohibits CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments on battlemap textures.
   - `CanvasThemePalette` switches empty canvas void (`canvasVoidHex`) and `gridOverlay` lines between dark slate and light parchment.
   - `FogLayer` Layer 0 (`Unexplored`) remains permanently opaque dark `#0F1A25` (`0x0f1a25`) in all themes to preserve optical dynamic range and 2.5D lighting fidelity.

4. **Non-Color Tactical Redundancy**:
   - Every tactical canvas and HUD state pairs color with a distinct geometric shape, badge glyph, or stroke dash pattern:
     - Token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge and `!`; `selected` uses a double ring with corner chevrons; `activeTurn` uses an amber halo with a directional chevron marker and `›`.
     - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` for `Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, and `Illusion`.
     - `MCP Staging Mode`: preview mutations display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.

5. **Actor Sheet Integrity via `PadlockEditMode`**:
   - `DeclarativeSheetRenderer` includes an explicit header toggle `[data-testid="sheet-padlock-toggle"]` controlling `PadlockEditMode`.
   - When locked (`aria-pressed="false"`), the renderer sets `readonly: true` or `disabled: true` on all 12 categories of structural Actor definitions (name, class, level, ability scores, maximum hit points, skills, saving throw proficiencies, inventory items, spells, feature descriptions).
   - Operational combat controls (dice roll buttons, current HP, temporary HP, death saves, spell slots, resource pools, condition toggles, inspiration, rest triggers) remain continuously interactive.

6. **Total Offline Font Self-Hosting & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (weights 500, 600) and `IBM Plex Sans` (weights 400, 500, 600) directly under `packages/web/public/fonts/` with `OFL-1.1` attribution, eliminating external font CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) on all numeric combat, ruler, dice, and character sheet fields.

7. **In-House SVG Asset Suite**:
   - Deliver SVG components within the web bundle: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines without baked-in `<text>` tags, ensuring localized HTML rendering).

8. **Two-Stage Fail-Closed Governance**:
   - **Static CI Verification**: `scripts/check-impeccable-design.mjs` executes under `make lint` alongside `impeccable detect` (`engine-v0.1.18`). It validates YAML frontmatter, canonical sections in `DESIGN.md`, Schema v2 integrity in `.impeccable/design.json`, mathematical WCAG 2.2 AA contrast ratios (`>= 4.5:1` text, `>= 3.0:1` focus/UI), absence of raw hex literals outside `tokens.css` and `CanvasThemePalette.ts`, absence of font CDN calls, and compliance with Impeccable Craft Floor invariants.
   - **Behavioral Test Verification**: Parameterized unit tests in `packages/web/tests/designSystem.test.ts` execute under `make test-web` to assert WCAG relative luminance calculations, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` field lock transitions.

## Consequences
### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without altering uploaded battlemap artwork.
- Preserves artistic integrity of battlemaps by strictly enforcing `mapArtFilter: 'none'`.
- Delivers full tactical accessibility for color-blind players through geometric discriminators.
- Prevents accidental Actor sheet mutation during live tabletop combat via `PadlockEditMode`.
- Full offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Automated, fail-closed prevention of design drift and AI-slop regressions in CI.

### Negative & Trade-offs
- New UI components and canvas overlays must consume `--atlas-*` CSS variables or `CanvasThemePalette` entries rather than inline hex literals.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.