# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME operates across live tabletop sessions (`ExplorationMode`, `TurnByTurnMode`), campaign preparation (`CampaignLobby`, `CampaignWorkspace`), declarative Actor sheets (`DeclarativeSheetRenderer`), collaborative notes (`CRDTDocument`), and smartphone companion screens (`MobileCompanionLayout`).
Tactical rendering combines a 7-layer `PixiJS v8` `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays.
Prior implementations suffered from several architectural defects:
1. Preact view components and headless `WidgetRegistry` renderers contained raw inline hex color literals and lacked unified theme adaptability between dark and light ambient environments.
2. The 7-layer PixiJS v8 `SceneGraph` rendered WebGL canvas elements alongside DOM chrome without a typed palette contract. Applying CSS theme filters corrupted user-uploaded battlemap textures on Layer 0 (`backgroundMap`).
3. Tactical indicators (Actor token allegiance, active turn badges, `WallSegment` permeability kinds, and `MCPStagingMode` ghost previews) relied solely on color, impairing accessibility for color-blind users.
4. Live combat sessions exposed Actor sheets to accidental structural edits during roll actions.
5. Web fonts loaded from external CDNs, violating offline parity in Docker containers and leaking user network requests.
6. Automated pull request verification lacked fail-closed linting for WCAG 2.2 AA contrast ratios, raw hex elimination, and anti-slop design invariants.

## Decision
We establish and enforce the **TRAME ATLAS v1.1** design system across all client packages through the following architectural decisions:

1. **ATLAS v1.1 Cartographic Design System (`DESIGN.md` & `.impeccable/design.json`)**:
   - Adopt the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) codified in root `DESIGN.md` (8 canonical Impeccable sections + YAML frontmatter) paired with `.impeccable/design.json` (Schema v2 sidecar), `.impeccable/config.json`, and surface contracts (`.impeccable/surfaces/table-operate.md`, `.impeccable/surfaces/campaign-read.md`).
   - Define semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).

2. **Separation of DOM and Canvas Token Ownership (`tokens.css` & `CanvasThemePalette`)**:
   - Strictly isolate raw color declarations to two files in `packages/web`: `packages/web/src/styles/tokens.css` for DOM CSS custom properties and `packages/web/src/canvas/CanvasThemePalette.ts` for typed numeric hex/alpha constants and stroke patterns (`getCanvasThemePalette`).
   - Propagate theme transitions reactively from `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to the DOM via `<html data-theme="...">` and to PixiJS vector layers without WebGL context reconstruction.

3. **The Map-Art Independence Rule**:
   - Textures on Layer 0 (`backgroundMap`) maintain `mapArtFilter: "none"`. The pipeline prohibits CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments on battlemap textures.
   - Unexplored fog on `FogLayer` Layer 0 (`Unexplored`) remains permanently opaque `#0F1A25` (`0x0f1a25`) in all themes to preserve optical dynamic range and 2.5D lighting fidelity.
   - Empty canvas void (`canvasVoidHex`) and `gridOverlay` lines switch between dark slate and light parchment.

4. **Non-Color Tactical Redundancy**:
   - Pair every tactical state in `CanvasThemePalette` and HUD with unique geometric stroke patterns and glyphs:
     - Token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge; `selected` uses a double ring with corner chevrons; `activeTurn` uses an amber halo with a directional chevron marker.
     - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` for `Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, and `Illusion`.
     - `MCPStagingMode`: preview mutations display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.

5. **Actor Sheet Integrity via `PadlockEditMode`**:
   - Guard `DeclarativeSheetRenderer` with an explicit header toggle `[data-testid="sheet-padlock-toggle"]` controlling `PadlockEditMode`.
   - When locked (`aria-pressed="false"`), the renderer sets `readonly: true` or `disabled: true` on structural Actor definitions (name, class, level, ability scores, maximum hit points, skills, inventory).
   - Combat controls (dice roll buttons, current and temporary hit points, death saves, spell slots, resource pools) remain continuously interactive.

6. **Self-Hosted WOFF2 Typography & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (weights `500`, `600`) and `IBM Plex Sans` (weights `400`, `500`, `600`) under `packages/web/public/fonts/` with `OFL-1.1` attribution, eliminating external font CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) on all numeric combat, ruler, dice, and character sheet fields.

7. **In-House SVG Asset Suite**:
   - Deliver SVG components within the web bundle: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines without baked-in `<text>` tags, ensuring localized HTML rendering).

8. **Two-Stage Fail-Closed Governance**:
   - Stage 1 CI runs `scripts/check-impeccable-design.mjs` under `make lint` alongside `impeccable detect` (`engine-v0.1.18`) to verify WCAG 2.2 AA contrast ratios, zero raw hex leakage, font CDN absence, and 62 Craft Floor anti-slop rules.
   - Stage 2 unit tests in `packages/web/tests/designSystem.test.ts` assert luminance math, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` transitions.
   - Stage 3 EPURE `multi-agent-pr-review` injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences

### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without ever altering uploaded battlemap artwork.
- Full tactical accessibility for color-blind players through geometric discriminators.
- `PadlockEditMode` prevents accidental Actor sheet mutations during live tabletop combat.
- Total offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Automated, fail-closed prevention of design drift and AI-slop regressions in CI and EPURE multi-agent reviews.

### Negative
- New UI components and canvas overlays must consume `--atlas-*` CSS variables or `CanvasThemePalette` entries rather than inline hex literals, enforced by `scripts/check-impeccable-design.mjs`.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.
