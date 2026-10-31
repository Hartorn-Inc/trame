# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME combines a high-frequency 7-layer `PixiJS v8` tactical `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `UndoDrawer`, `DeclarativeSheetRenderer`, and `MobileCompanionLayout`). The system operates across live tabletop sessions (`ExplorationMode`, `TurnByTurnMode`), campaign preparation, declarative Actor sheets, collaborative notes (`CRDTDocument`), and smartphone companion screens (`MobileCompanionLayout`).

Prior implementations suffered from several architectural defects:
1. Preact view components and headless `WidgetRegistry` renderers contained raw inline hex color literals and lacked unified theme adaptability between dark and light ambient environments.
2. The 7-layer PixiJS v8 `SceneGraph` rendered WebGL canvas elements alongside DOM chrome without a typed palette contract. The system lacked an explicit guarantee that user-uploaded battlemap textures remain untouched by theme adjustments, while naively applying CSS theme filters (`invert`, `brightness`) corrupts battlemap artwork.
3. Tactical indicators (Actor token allegiance `ally` vs. `hostile`, active turn badges, `WallSegment` permeability kinds, and `MCPStagingMode` ghost previews) relied heavily on color alone, impairing accessibility for color-blind users and blending into map art.
4. Live combat sessions exposed Actor sheets to accidental structural edits during roll actions.
5. Web fonts loaded from external Google Fonts CDNs, violating offline parity in Docker containers and `.trame` Archive deployments while leaking user IP addresses.
6. Automated pull request verification lacked fail-closed linting for WCAG 2.2 AA contrast ratios, raw hex elimination, and anti-slop design invariants.

## Decision
We establish and enforce the **TRAME ATLAS v1.1** design system across all client packages through the following architectural decisions:

1. **Canonical Design Contracts & Sidecar Specifications**:
   Adopt the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) codified in root `DESIGN.md` (8 canonical Impeccable sections + YAML frontmatter) paired with `.impeccable/design.json` (Schema v2 sidecar), `.impeccable/config.json`, and surface contracts (`.impeccable/surfaces/table-operate.md`, `.impeccable/surfaces/campaign-read.md`).

2. **Hybrid DOM / PixiJS Token Boundary**:
   - Preact DOM chrome consumes semantic CSS custom properties defined in `packages/web/src/styles/tokens.css` (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`).
   - The PixiJS v8 `SceneGraph` consumes typed numeric color and stroke values through `packages/web/src/canvas/CanvasThemePalette.ts` via `getCanvasThemePalette(mode: ResolvedAtlasTheme)`.
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` and `packages/web/src/canvas/CanvasThemePalette.ts`.
   - Theme changes propagate reactively from `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to the DOM via `<html data-theme="...">` and to PixiJS vector layers via explicit layer style updates.

3. **The Map-Art Independence Rule**:
   Uploaded battlemap textures on Layer 0 (`backgroundMap`) maintain `mapArtFilter: 'none'`. The rendering pipeline prohibits CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments on battlemap textures. Unexplored fog on `FogLayer` Layer 0 (`Unexplored`) remains permanently opaque `#0F1A25` (`0x0f1a25`) in all themes to preserve optical dynamic range and 2.5D lighting fidelity.

4. **Non-Color Tactical Redundancy**:
   All tactical canvas and HUD states pair color with unique geometric stroke patterns and glyphs:
   - Actor token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge; `selected` uses a double ring with corner chevrons.
   - Active turn: highlighted with an amber halo and a directional chevron beacon marker (`›`).
   - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` for `Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, and `Illusion`.
   - `AoETemplate` footprints and `MCPStagingMode` preview mutations: display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.

5. **Actor Sheet Integrity via `PadlockEditMode`**:
   `DeclarativeSheetRenderer` includes an explicit header toggle `[data-testid="sheet-padlock-toggle"]` controlling `PadlockEditMode`. When locked (`aria-pressed="false"`), the renderer disables or sets `readonly: true` on all structural Actor definitions (name, class, level, ability scores, maximum hit points, skills, equipment modification). Dice roll buttons (`roll-button`) and volatile combat counters (current hit points, temporary hit points, spell slots, death saves) remain continuously interactive.

6. **Total Offline Font Self-Hosting & `tabular-nums` Invariant**:
   Bundle subsetted WOFF2 font files for `Space Grotesk` (weights 500, 600) and `IBM Plex Sans` (weights 400, 500, 600) directly under `packages/web/public/fonts/` alongside their `OFL-1.1` license. The build pipeline and runtime prohibit external network requests to Google Fonts or third-party font CDNs. All numeric combat counters, roll outputs, and sheet statistics enforce `font-variant-numeric: tabular-nums` via `.atlas-tabular-nums`.

7. **In-House SVG Asset Suite**:
   Deliver SVG components within the web bundle: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines without baked-in `<text>` tags, ensuring localized HTML rendering).

8. **Multi-Stage Fail-Closed Governance**:
   - **Seam 1 (Static CI Verification)**: `scripts/check-impeccable-design.mjs` executes under `make lint`. It validates YAML frontmatter, canonical sections in `DESIGN.md`, Schema v2 integrity in `.impeccable/design.json`, mathematical WCAG 2.2 AA contrast ratios (`>= 4.5:1` text, `>= 3.0:1` focus/UI), absence of raw hex literals outside `tokens.css` and `CanvasThemePalette.ts`, absence of font CDN calls, and compliance with Impeccable Craft Floor invariants (`impeccable detect`).
   - **Seam 2 (Behavioral Test Verification)**: Parameterized unit tests in `packages/web/tests/designSystem.test.ts` execute under `make test-web`. They assert WCAG relative luminance calculations, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` field lock transitions.
   - **Seam 3 (EPURE Multi-Agent Review Gate)**: EPURE `multi-agent-pr-review` injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences

### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without altering battlemap artwork.
- Full offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Full tactical accessibility for color-blind players through geometric discriminators.
- Prevents accidental Actor sheet mutations during live tabletop combat via `PadlockEditMode`.
- Automated, fail-closed prevention of design drift and regressions in CI, unit test suites, and EPURE reviews.

### Negative & Trade-offs
- Adding new colors requires declaring them in `tokens.css` and updating `CanvasThemePalette.ts`.
- Developers cannot use ad-hoc inline styles or raw hex values in Preact components, enforced by `scripts/check-impeccable-design.mjs`.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.