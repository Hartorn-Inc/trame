# ADR-0006: Declarative Character Sheet UI Architecture and Widget Registry

## Status
Accepted

## Context
TRAME requires character sheets to adapt dynamically to distinct game systems without hardcoding game-specific JSX components in `packages/web`. The D&D 5e character sheet renders entirely from `dnd5e/system.json` layout declarations (`DND5E_SHEET_LAYOUT`) while maintaining strict separation between layout presentation and reactive `Actor` state.

Live tabletop play requires two distinct operational modes:
1. Play Mode: Ability scores, saving throws, skills, attacks, and spells function as single-click roll triggers dispatching authoritative server rolls. This prevents accidental modifications during combat.
2. Edit Mode: When preparing or leveling a character, players require numeric steppers, proficiency toggles, and direct field editing.

Game Masters require authoritative control to freeze character build stats during sessions to prevent mid-combat cheating.

## Decision
1. **Declarative Layout AST (`DND5E_SHEET_LAYOUT`) & `DeclarativeSheetView`**:
   `DeclarativeSheetView` traverses `DND5E_SHEET_LAYOUT` and delegates widget rendering to components registered in `WidgetRegistry`.
2. **Registry of 12 Declarative Widgets**:
   `WidgetRegistry` registers interactive Preact implementations for all 12 declarative widgets:
   - `StatBlock6Widget`
   - `ResourceBarWidget`
   - `ArmorInitiativeSpeedWidget`
   - `SavingThrowListWidget`
   - `SkillCheckListWidget`
   - `HitDiceAndDeathSavesWidget`
   - `ConditionBadgeStripWidget`
   - `AttackActionTableWidget`
   - `SpellbookAccordionWidget`
   - `InventoryContainerTreeWidget`
   - `FeatureTraitListWidget`
   - `NotesMarkdownPaneWidget`
3. **CoreBuildLock Hierarchy**:
   - Server-authoritative `gm_core_locked` takes precedence over client-side `coreStatsLocked`.
   - IF `gm_core_locked === true`, THEN `isLocked` evaluates to `true` and the system disables the client padlock toggle.
   - WHEN `isLocked === true`, THEN all core build elements render as single-click `RollDice` triggers.
   - WHEN `isLocked === false`, THEN core build elements render inline numeric steppers and cyclic `ProficiencyRank` selectors.
   - Active play state (`hp.current`, `hp.temp`, `DeathSaveCounters`, spell slots, ammunition, currency, items, notes) remains mutable by actor owners and Game Masters regardless of lock state.
4. **Deterministic Data Binding & Reactivity**:
   `DeclarativeSheetView` connects to `@preact/signals` (`PreactSignalState`) slices from `tableStore` and `Actor` records (`Dnd5eActorData`) with evaluated `derivedDAG` attributes (`AbilityModifier`, `ProficiencyBonus`, Armor Class, Spell Save DC).
   Clicking roll triggers dispatches authoritative `RollDice` envelopes over WebSocket. Direct edits dispatch `UpdateActorField` or `UpsertActor` mutations.

## Consequences
### Positive
- Game system packages own their sheet layout specifications declaratively.
- All 12 widgets in `DND5E_SHEET_LAYOUT` operate interactively in both Live Table drawers and `CampaignWorkspace`.
- Single-click roll triggers eliminate accidental stat modifications during combat.
- Server enforces Game Master locking authority strictly via `gm_core_locked`.
- Granular `@preact/signals` subscriptions maintain 60 FPS performance without full-tree Virtual DOM re-renders.

### Negative
- Component maintenance footprint increases across locked and unlocked operational modes.
- Registering a new widget requires adding its view-model factory and Preact renderer to `WidgetRegistry`.