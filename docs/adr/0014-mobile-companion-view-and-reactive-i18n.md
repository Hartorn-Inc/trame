# ADR-0014: Mobile Companion View Decoupling and Reactive Bilingual Localization

## Status
Accepted

## Context
TRAME supports desktop browser play with a full WebGL PixiJS tactical battlemap canvas. However, players at physical tables or with mobile devices require access to their character sheet, dice roller, inventory, and notes without the memory, battery, and rendering overhead of WebGL. Additionally, the application requires seamless bilingual support (`en` / `fr`) with dynamic imperial/metric tactical distance formatting.

## Decision
1. **Mobile Companion Mode Threshold (< 768px)**:
   - For viewports strictly under 768px (`windowWidth < 768`) or when manually toggled via `mobileCompanionOverrideSignal`, `TrameAppRoot` renders `MobileCompanionView`.
   - WebGL / PixiJS canvas initialization is bypassed completely, eliminating GPU memory allocation on mobile viewports.
   - Provides a touch-friendly 5-tab interface: Character Sheet, Dice Tray, Inventory, Combat Tracker, and Journal.
2. **Reactive Bilingual Localization (`localeSignal`)**:
   - UI labels are managed via reactive `@preact/signals` state (`localeSignal`), switching instantly between English and French without page reload.
   - Compendium search queries resolve through a bilingual mapping table (`resolveCompendiumSearchQuery`) matching both French localized terms and canonical English identifiers.
3. **Tactical Unit Formatting (`unitSystemSignal`)**:
   - Distances format reactively based on `unitSystemSignal`: imperial feet (`"30 ft"`) or metric meters with tactical cell counts (`"9 m (6 cases)"`).

## Consequences
### Positive
- Lightweight, battery-efficient mobile companion experience for in-person and hybrid sessions.
- Zero WebGL crashes or GPU memory pressure on low-end mobile devices.
- Instant client-side localization and unit conversion without backend roundtrips.

### Negative
- Mobile viewports cannot view or interact with the tactical map without toggling desktop view or rotating the screen.