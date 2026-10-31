# ADR-0006: Declarative Character Sheet UI Architecture, Widget Registry, and CoreBuildLock

## Status
Accepted

## Context
TRAME requires character sheets to adapt dynamically to distinct game systems without hardcoding game-specific JSX components in `packages/web`. The D&D 5e character sheet layout is declared in `DND5E_SHEET_LAYOUT` within `@trame/game-system-dnd5e`, while maintaining strict separation between layout presentation and reactive `Actor` state.

Historically, `HudDrawers.tsx` rendered a hardcoded sheet subset containing only AC, Initiative, Speed, and raw ability score inputs. Players could not interact with saving throws, skills, death saving throws, condition badges, attacks, spell slots, nested inventory containers, features, or character notes.

Additionally, live tabletop play requires dual operational modes:
1. Play Mode: Ability scores, saving throws, skills, attacks, and spells must function as single-click `RollDice` triggers dispatching authoritative server rolls without focusing text fields or risking accidental stat modification.
2. Edit Mode: When preparing or leveling a character, players require numeric steppers, proficiency toggles, and direct field editing.

Finally, Game Masters must retain authoritative control to freeze character build stats during sessions to prevent mid-combat cheating.

## Decision
1. **Declarative Layout AST and Unified View (`DeclarativeSheetView`)**:
   - Implement `DeclarativeSheetView` in `packages/web` as the unified Preact component that traverses `DND5E_SHEET_LAYOUT`.
   - `DeclarativeSheetView` delegates widget rendering to Preact components registered in `WidgetRegistry`.
   - The view renders identically in both the Live Table drawer (`HudDrawers.tsx`) and `CampaignWorkspace`.
2. **Canonical 12-Widget Registry (`WidgetRegistry`)**:
   Register interactive Preact component implementations for all 12 declarative widgets:
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
3. **CoreBuildLock Security Hierarchy**:
   - Server-authoritative `gm_core_locked` takes precedence over client-side `coreStatsLocked`.
   - IF `gm_core_locked === true`, THEN `isLocked` evaluates to `true`, and the client padlock toggle button is disabled.
   - WHEN `isLocked === true`, THEN all core build elements render as single-click `RollDice` triggers.
   - WHEN `isLocked === false`, THEN core build elements render inline numeric steppers and cyclic `ProficiencyRank` selectors.
   - Active play state (current HP, temporary HP, `DeathSaveCounters`, spell slots, ammunition, currency, items, notes) remains mutable at all times by the actor owner and GM regardless of lock state.
4. **Deterministic Data Binding and Surgical Signals Reactivity (`PreactSignalState`)**:
   - Connect `DeclarativeSheetView` and widget view-models to `@preact/signals` slices from `tableStore`.
   - `DeclarativeSheetView` resolves computed values from the `Actor` record (`Dnd5eActorData`) and its evaluated `derivedDAG` attributes (`AbilityModifier`, `ProficiencyBonus`, Armor Class, Spell Save DC).
   - Signal updates mutate DOM text nodes surgically without full sheet re-rendering, maintaining 60 FPS UI performance.

## Consequences
### Positive
- Game system packages own their sheet layout specifications declaratively in `DND5E_SHEET_LAYOUT`.
- All 12 widgets in `DND5E_SHEET_LAYOUT` are fully functional and interactive across Live Table drawers and `CampaignWorkspace`.
- Single-click roll triggers eliminate accidental stat modifications during combat.
- Server authority strictly governs GM build locking via `CoreBuildLock`.
- Granular `@preact/signals` subscriptions maintain 60 FPS performance during frequent HP and spell slot mutations.

### Negative
- Adding a new atomic widget primitive requires registering its view-model builder and Preact renderer in `WidgetRegistry`.
- Requires comprehensive automated test suites covering both locked and unlocked modes across all 12 widgets.
