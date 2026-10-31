# ADR-0006: Declarative Character Sheet UI Architecture and Widget Registry

## Status
Accepted

## Context
TRAME requires character sheets to adapt dynamically to distinct game systems without hardcoding game-specific JSX components in `packages/web`. The D&D 5e character sheet renders entirely from `dnd5e/system.json` layout declarations (`DND5E_SHEET_LAYOUT`) while maintaining strict separation between layout presentation and reactive `Actor` state.

However, the live user interface in `HudDrawers.tsx` historically rendered a hardcoded subset containing only AC, Initiative, Speed, and 6 raw ability score inputs. Players could not interact with saving throws, skills, death saving throws, condition badges, attacks, spell slots, nested inventory containers, features, or character notes.

Additionally, live tabletop play requires dual operational modes:
1. Play Mode: Ability scores, saving throws, skills, attacks, and spells must function as single-click roll triggers dispatching authoritative server rolls without focusing text fields or risking accidental stat modification.
2. Edit Mode: When preparing or leveling a character, players require numeric steppers, proficiency toggles, and direct field editing.

Finally, Game Masters must retain the authority to freeze character build stats during sessions to prevent mid-combat cheating.

## Decision
1. **Declarative Layout AST & DeclarativeSheetView**:
   - Game system manifests declare layout trees using container nodes (`tabs`, `tab`, `grid`, `section`).
   - Implement a unified Preact component `DeclarativeSheetView` that traverses `DND5E_SHEET_LAYOUT` and delegates widget rendering to components registered in `WidgetRegistry`.
2. **Canonical 12 Interactive Widgets**:
   - Register interactive Preact implementations for all 12 declarative widgets:
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
   - If `gm_core_locked === true`, `isLocked` evaluates to `true`, and the client padlock toggle is disabled.
   - If `isLocked === true`, all core build elements render as single-click `RollDice` triggers.
   - If `isLocked === false`, core build elements render inline numeric steppers and cyclic `ProficiencyRank` selectors.
   - Active play state (current HP, temporary HP, DeathSaveCounters, spell slots, ammunition, currency, items, notes) remains mutable at all times by the actor owner and GM regardless of lock state.
4. **Deterministic Data Binding & Signal Reactivity**:
   - `DeclarativeSheetView` resolves values from the `Actor` record (`Dnd5eActorData`) and its evaluated `derivedDAG` attributes (`AbilityModifier`, `ProficiencyBonus`, Armor Class, Spell Save DC).
   - Connect `DeclarativeSheetView` to `@preact/signals` slices from `tableStore` to eliminate full sheet re-renders on incremental state changes.
5. **Interactive Roll & Mutation Dispatch**:
   - Clicking any roll trigger constructs the appropriate dice formula (`1d20 + mod` or weapon/spell expression) and dispatches a `RollDice` envelope over the WebSocket, while sheet edits dispatch `UpdateActorField` / `UpsertActor` mutations.

## Consequences
### Positive
- Game system packages own their sheet layout specifications declaratively.
- All 12 widgets in `DND5E_SHEET_LAYOUT` are fully functional and interactive in both Live Table drawers and `CampaignWorkspace`.
- Zero accidental stat modifications during combat via single-click roll triggers.
- Strict server authority enforcement for GM locking.
- Granular `@preact/signals` subscriptions maintain 60 FPS UI performance during frequent HP or slot updates.

### Negative
- Adding a new atomic widget primitive requires registering its view-model builder and Preact renderer.
- Increased component footprint requiring rigorous automated testing across both locked and unlocked modes.
