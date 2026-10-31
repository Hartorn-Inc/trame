# ADR-0035: MobileCompanionView Architecture and Reactive i18n/Units Presentation Layer

## Status
Accepted

## Context
Physical tabletop and mobile participants on smartphones and small viewports (< 768px) require an interface optimized for touch without running WebGL or PixiJS canvas pipelines that drain battery and GPU resources.
Furthermore, international gaming tables require reactive bilingual support (`FR` / `EN`) and metric grid conversions (`5 ft` to `1.5 m (1 case)`) without altering canonical engine calculations or wire formats.

## Decision
1. **Deterministic WebGL Lifecycle Teardown and MobileCompanionView**:
   - `App.tsx` evaluates viewport mode via `shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768)`.
   - When `shouldMountCanvas` evaluates to false, the application destroys the PixiJS canvas instance and mounts `MobileCompanionView` with 5 touch tabs (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).
   - The mobile `Journal` tab renders `DocumentsWorkspaceTab` allowing mobile players to access notes and revealed handouts.
   - When the viewport returns to desktop width, `TableCanvas` re-initializes cleanly.
2. **Reactive i18n and Metric Distance Presentation**:
   - Module `packages/web/src/i18n/` exposes `localeSignal` and `unitSystemSignal` as reactive Preact signals.
   - Function `formatDistanceFt` converts tactical distances into metric representations (`1.5 m (1 case)`, `9 m (6 cases)`).
   - Compendium search queries utilize a bilingual dictionary mapping translated terms to canonical English keys without mutating underlying data packs.

## Consequences
### Positive
- Zero GPU and WebGL resource consumption on mobile devices under 768px.
- Native touch-first workflow for physical table players.
- Clean separation between localized presentation and canonical English game engine slugs.

### Negative
- Switching between desktop and mobile modes requires canvas destruction and re-creation.
- Touch UI components must consume reactive signals and formatting helpers.
