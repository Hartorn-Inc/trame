# ADR-0035: MobileCompanionView Architecture and Reactive i18n / Unit Presentation Layer

- **Status**: Accepted
- **Date**: 2026-10-31
- **Context**: Issue #80, ADR-0009

## Context

Smartphones and small tablets (`< 768px`) require a touch-first companion UI that does not allocate a WebGL/PixiJS context, preserving battery life and GPU memory. Furthermore, bilingual tables (`en` / `fr`) require reactive UI localization and imperial/metric distance formatting (`5 ft` vs `1.5 m`) without altering canonical Rust engine rules or network payloads.

## Decision

1. **WebGL Lifecycle and `MobileCompanionView` Mounting**:
   - `App.tsx` computes `shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768)`.
   - When `shouldMountCanvas.value === false`, `TableCanvas` is unmounted (destroying the PixiJS application) and `MobileCompanionView` is mounted with 5 touch tabs (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).
2. **Reactive Presentation-Layer i18n and Distance Conversion**:
   - `packages/web/src/i18n/index.ts` exposes `localeSignal` (`'en' | 'fr'`), `unitSystemSignal` (`'imperial_ft' | 'metric_m'`), `t(key, vars)`, `formatDistanceFt(feet)`, and bilingual compendium search resolution.
   - All Rust engine calculations and WebSocket envelopes remain strictly in canonical English and feet.

## Consequences

- Zero WebGL memory overhead on `< 768px` companion devices.
- Seamless runtime switching between English/French and imperial/metric display units.
