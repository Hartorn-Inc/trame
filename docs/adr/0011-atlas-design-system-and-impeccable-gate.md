# ADR-0011: ATLAS v1.1 Design System, Hybrid Canvas Theme Palette, and Impeccable Gate

## Status
Accepted

## Context
TRAME combines a high-frequency 7-layer `PixiJS v8` tactical `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) with Preact DOM overlays (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `UndoDrawer`, `DeclarativeSheetRenderer`, and `MobileCompanionLayout`). Without an explicit design system contract and a strict token boundary between DOM CSS and WebGL canvas primitives:
1. Ad-hoc hex colors in DOM components break daylight readability (`light` mode) and fail WCAG 2.2 AA contrast thresholds.
2. Naively applying CSS theme filters (`invert`, `brightness`) to the canvas corrupts user-uploaded battlemap artwork on the `backgroundMap` layer, while leaving the canvas completely unthemed causes jarring contrast when panning across empty canvas void in `light` mode.
3. Relying solely on color to distinguish token allegiance (`ally` vs. `hostile`), active turns, `WallSegment` permeability kinds (`SecretDoor`, `Illusion`), or `MCP Staging Mode` previews fails color-vision accessibility and blends into saturated map art.
4. External Google Fonts CDN requests in the browser leak player IP addresses and fail in offline Docker or air-gapped `.trame` Archive deployments.

## Decision
1. **ATLAS v1.1 Cartographic Design System (`DESIGN.md` & `.impeccable/design.json`)**:
   - Adopt the ATLAS v1.1 visual system (*"The Map Is the Workspace"*) codified in root `DESIGN.md` (8 canonical Impeccable sections + YAML frontmatter) and `.impeccable/design.json` (Schema v2 sidecar).
   - Provide dual-theme semantic CSS custom properties (`--atlas-bg`, `--atlas-surface`, `--atlas-surface-raised`, `--atlas-text`, `--atlas-text-muted`, `--atlas-border`, `--atlas-action`, `--atlas-on-action`, `--atlas-focus`, `--atlas-danger`, `--atlas-grid`, `--atlas-shadow`) across `dark` (default `#0F1A25` slate), `light` (`#F4F7F9` parchment), and `system` (`prefers-color-scheme`).
2. **Hybrid DOM / PixiJS Token Boundary (`tokens.css` & `CanvasThemePalette`)**:
   - Only two files in `packages/web` may declare raw color literals: `packages/web/src/styles/tokens.css` (for DOM CSS custom properties) and `packages/web/src/canvas/CanvasThemePalette.ts` (for typed `PixiJS v8` numeric hex/alpha constants and stroke patterns).
   - **The Map-Art Independence Rule**: `CanvasThemePalette` switches the empty canvas void and `gridOverlay` lines between dark slate and light parchment while keeping `FogLayer` Layer 0 (`Unexplored`) opaque dark (`0x0f1a25`) and enforcing `mapArtFilter: "none"` so uploaded battlemap art is never mutated by theme changes.
   - **The Non-Color Redundancy Rule**: Every tactical state in `CanvasThemePalette` (`ally`, `hostile`, `selected`, `activeTurn`, the 7 `WallSegment` kinds, `AoETemplate` footprints, and `MCP Staging Mode` translucent purple ghost previews) pairs its color token with a distinct geometric shape, badge glyph, or stroke dash pattern.
3. **Self-Hosted WOFF2 Typography & `tabular-nums` Invariant**:
   - Bundle subsetted WOFF2 font files for `Space Grotesk` (`500`, `600`) and `IBM Plex Sans` (`400`, `500`, `600`) under `packages/web/public/fonts/` with `OFL-1.1` attribution, eliminating external font CDN requests.
   - Enforce `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`) on all numeric combat, ruler, dice, and character sheet fields, and guard structural character sheet edits behind `PadlockEditMode` (`aria-pressed` padlock toggle in `DeclarativeSheetRenderer`).
4. **Two-Stage Fail-Closed Impeccable Enforcement**:
   - Stage 1/2 CI runs `scripts/check-impeccable-design.mjs` alongside `impeccable detect` (`engine-v0.1.18`) to verify WCAG 2.2 AA contrast ratios, zero raw hex leakage, and all 62 Impeccable Craft Floor anti-slop rules.
   - Stage 3 EPURE `multi-agent-pr-review` injects `DESIGN.md` and `.cursor/agents/{design,accessibility,frontend}-reviewer.md` into the blocking `impeccable-gate` check run.

## Consequences
### Positive
- Complete visual, typographic, and WCAG 2.2 AA contrast consistency across `dark`, `light`, and `system` themes without ever altering uploaded battlemap artwork.
- Full offline typography and vector asset self-containment inside Docker and `.trame` Archive deployments.
- Automated, fail-closed prevention of design drift and AI-slop regressions in both CI and EPURE multi-agent reviews.

### Negative
- New UI components and canvas overlays must consume `--atlas-*` CSS variables or `CanvasThemePalette` entries rather than inline hex literals, enforced by `scripts/check-impeccable-design.mjs`.
