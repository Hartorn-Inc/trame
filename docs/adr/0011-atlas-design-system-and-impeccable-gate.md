# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME operates across live tabletop sessions (`ExplorationMode`, `TurnByTurnMode`), campaign preparation (`CampaignLobby`, `CampaignWorkspace`), declarative Actor sheets (`DeclarativeSheetRenderer`), collaborative notes (`CRDTDocument`), and smartphone companion screens (`MobileCompanionLayout`). The system requires a coherent, accessible, and mechanically governed visual design system.

Without an explicit design system contract and a strict token boundary between DOM CSS and WebGL canvas primitives:
1. Preact view components and headless `WidgetRegistry` renderers contained raw inline hex color literals and lacked unified theme adaptability between dark and light ambient environments.
2. The 7-layer `PixiJS v8` tactical `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) rendered WebGL canvas elements alongside DOM chrome without a typed palette contract. The system lacked an explicit guarantee that user-uploaded battlemap textures remain untouched by theme adjustments.
3. Tactical indicators (Actor token allegiance, active turn badges, `WallSegment` permeability kinds, and `MCP Staging Mode` previews) relied heavily on color alone, impairing accessibility for color-blind users.
4. Live combat sessions exposed Actor sheets to accidental structural edits during roll actions.
5. External Google Fonts CDN requests in the browser leaked player IP addresses and failed in offline Docker or air-gapped `.trame` Archive deployments.
6. Automated pull request verification lacked fail-closed linting for WCAG 2.2 AA contrast ratios, raw hex elimination, and anti-slop design invariants.

## Decision
We establish and enforce the **TRAME ATLAS v1.1** design system across all client packages through the following architectural decisions:

1. **ATLAS v1.1 Cartographic Design System (`DESIGN.md` & `.impeccable/design.json`)**:
   - Adopt the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) codified in root `DESIGN.md` (8 canonical Impeccable sections + YAML frontmatter), machine-readable `.impeccable/design.json` (Schema v2 sidecar), `.impeccable/config.json`, and surface contracts (`.impeccable/surfaces/table-operate.md`, `.impeccable/surfaces/campaign-read.md`).
   - Provide dual-theme semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).

2. **Hybrid DOM / PixiJS Token Boundary (`tokens.css` & `CanvasThemePalette`)**:
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` (for Preact DOM chrome semantic CSS custom properties) and `packages/web/src/canvas/CanvasThemePalette.ts` (for typed `PixiJS v8` numeric hex/alpha constants and stroke patterns via `getCanvasThemePalette(mode: ResolvedAtlasTheme)`).
   - Theme changes propagate reactively from `@preact/signals` (`themeModeSignal`, `resolvedThemeSignal`) to the DOM via `<html data-theme="...">` and to PixiJS vector layers via explicit layer style updates.

3. **The Map-Art Independence Rule**:
   - Uploaded battlemap textures on Layer 0 (`backgroundMap`) maintain `mapArtFilter: 'none'`. The rendering pipeline prohibits CSS filters (`filter: invert()`, `filter: brightness()`) and WebGL color adjustments on battlemap textures.
   - Unexplored fog on `FogLayer` Layer 0 (`Unexplored`) remains permanently opaque `#0F1A25` (`0x0f1a25`) in all themes to preserve optical dynamic range and 2.5D lighting fidelity.
   - The empty canvas void `canvasVoidHex` and `gridOverlay` lines switch between dark slate and light parchment.

4. **Non-Color Tactical Redundancy**:
   - Every tactical state in `CanvasThemePalette` pairs its color token with a distinct geometric shape, badge glyph, or stroke dash pattern:
     - Actor token allegiance: `ally` uses a solid ring with a shield badge; `hostile` uses a dashed ring (`[6, 4]`) with a diamond badge and `"!"` glyph; `selected` uses a double ring with corner chevrons; `activeTurn` uses an amber halo with a directional chevron marker (`"›"`).
     - `WallSegment` kinds: 7 distinct combinations of `dashPatternPx` and `endpointMarker` for `Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, and `Illusion`.
     - `MCP Staging Mode`: preview mutations display an amber dashed outline (`[4, 4]`) and a text badge `STAGED`.

5. **Actor Sheet Integrity via `PadlockEditMode`**:
   - `DeclarativeSheetRenderer` includes an explicit header toggle `[data-testid="sheet-padlock-toggle"]` controlling `PadlockEditMode`.
   - When locked (`aria-pressed="false"`), the renderer disables or sets `readonly: true` on all 12 structural Actor definitions (name, class, level, ability scores, maximum hit points, skills, saving throws, inventory, spells, feature descriptions).
   - Dice roll buttons (`roll-button`) and volatile combat counters (current hit points, temporary hit points, spell slots, death saves, resources, condition badges, rests) remain continuously interactive.

6. **Self-Hosted WOFF2 Typography & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (weights 500, 600) and `IBM Plex Sans` (weights 400, 500, 600) directly under `packages/web/public/fonts/` alongside their `OFL-1.1.txt` license, eliminating external font CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) on all numeric combat, ruler, dice, and character sheet fields.

7. **In-House SVG Asset Suite**:
   - Deliver SVG components within the web bundle: `TrameLogo.tsx` (cartographic T mark), `AtlasIcons.tsx` (34 named tabletop and UI icons with `stroke-width="1.75"` and `currentColor`), and `AtlasEmptyStates.tsx` (4 illustrations using contour lines without baked-in `<text>` tags, ensuring localized HTML rendering).

8. **Three-Stage Fail-Closed Governance**:
   - Seam 1 (Static CI Verification): `scripts/check-impeccable-design.mjs` executes under `make lint`. It validates YAML frontmatter, canonical sections in `DESIGN.md`, Schema v2 integrity in `.impeccable/design.json`, mathematical WCAG 2.2 AA contrast ratios (`>= 4.5:1` text, `>= 3.0:1` focus/UI), absence of raw hex literals outside `tokens.css` and `CanvasThemePalette.ts`, absence of font CDN calls, and compliance with all 62 Impeccable Craft Floor anti-slop rules (`impeccable detect`).
   - Seam 2 (Behavioral Test Verification): Parameterized unit tests in `packages/web/tests/designSystem.test.ts` execute under `make test-web`, asserting WCAG relative luminance calculations, geometric injectivity of canvas palettes, SVG accessibility attributes, and `PadlockEditMode` field lock transitions.
   - Seam 3 (Multi-Agent PR Review): EPURE `multi-agent-pr-review` injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences
### Positive
- Eliminates visual design drift and inconsistent inline styling across client views.
- Guarantees high-contrast readability and WCAG 2.2 AA compliance across `dark`, `light`, and `system` themes without altering uploaded battlemap artwork.
- Preserves artistic integrity of battlemaps by enforcing `mapArtFilter: 'none'`.
- Delivers full tactical accessibility for color-blind players through geometric discriminators.
- Prevents accidental Actor sheet mutation during live tabletop combat via `PadlockEditMode`.
- Ensures zero external network dependencies, guaranteeing offline Docker parity and strict privacy.
- Enforces deterministic, automated verification before pull requests merge into `dev`.

### Negative
- New UI components and canvas overlays must consume `--atlas-*` CSS variables or `CanvasThemePalette` entries rather than inline hex literals, enforced by `scripts/check-impeccable-design.mjs`.
- Developers cannot use ad-hoc inline styles or raw hex values in Preact components.
- Adding new Actor sheet fields requires explicit categorization into locked structural fields or active combat fields.
