# ADR-0035: MobileCompanionView Architecture and Reactive i18n Presentation Layer

- **Status**: Accepted
- **Date**: 2025-05-18
- **Authors**: TRAME Architecture Team
- **Context**: Issue #80, ADR-0009

## Context

Mobile devices on viewports under 768px require a touch interface that bypasses WebGL initialization to conserve battery and GPU memory. Furthermore, bilingual tables require localized labels (`FR` and `EN`) and metric tactical measurement formatting without altering underlying English rule slugs or network protocol identifiers.

## Decision

1. **Responsive Viewport Decoupling**:
   - `App.tsx` evaluates viewport width and `mobileCompanionOverrideSignal`.
   - Viewports under 768px or with active override mount `MobileCompanionView` with dedicated tabs (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).

2. **Reactive i18n Presentation Layer**:
   - `packages/web/src/i18n/index.ts` provides `localeSignal` (`'en' | 'fr'`) and `unitSystemSignal` (`'imperial_ft' | 'metric_m'`).
   - `formatDistanceFt` converts distances into metric values with grid square counts while network payloads remain in imperial feet.
   - Compendium search queries map bilingual French terms to canonical English keys.

## Consequences

### Positive
- Zero WebGL resource consumption on mobile screens.
- Clean localization presentation decoupled from core engine computation.

### Negative
- Switching between desktop and mobile modes reconstructs the WebGL context.
