# ADR-0038: Declarative Character Sheet Preact Binding & CoreBuildLock

## Status
Accepted

## Context
The `@trame/game-system-dnd5e` package defines the complete declarative AST layout for D&D 5e character sheets in `DND5E_SHEET_LAYOUT`. Furthermore, `@trame/web` implements 12 headless widget view-model factories in `packages/web/src/sheet/widgets/`. However, the live user interface in `HudDrawers.tsx` historically rendered a hardcoded subset containing only AC, Initiative, Speed, and 6 raw ability score inputs. Players could not interact with saving throws, skills, death saving throws, condition badges, attacks, spell slots, nested inventory containers, features, or character notes.

Additionally, live tabletop play requires dual operational modes:
1. Play Mode: Ability scores, saving throws, skills, attacks, and spells must function as single-click roll triggers dispatching authoritative server rolls without focusing text fields or risking accidental stat modification.
2. Edit Mode: When preparing or leveling a character, players require numeric steppers, proficiency toggles, and direct field editing.

Finally, Game Masters must retain the authority to freeze character build stats during sessions to prevent mid-combat cheating.

## Decision
1. Implement a unified Preact component `DeclarativeSheetView` that traverses `DND5E_SHEET_LAYOUT` and delegates widget rendering to components registered in `WidgetRegistry`.
2. Register interactive Preact implementations for all 12 declarative widgets:
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
3. Establish the `CoreBuildLock` hierarchy:
   - Server-authoritative `gm_core_locked` takes precedence over client-side `coreStatsLocked`.
   - If `gm_core_locked === true`, `isLocked` evaluates to `true`, and the client padlock toggle is disabled.
   - If `isLocked === true`, all core build elements render as single-click `RollDice` triggers.
   - If `isLocked === false`, core build elements render inline numeric steppers and cyclic `ProficiencyRank` selectors.
   - Active play state (current HP, temporary HP, DeathSaveCounters, spell slots, ammunition, currency, items, notes) remains mutable at all times by the actor owner and GM regardless of lock state.
4. Connect `DeclarativeSheetView` to `@preact/signals` slices from `tableStore` to eliminate full sheet re-renders on incremental state changes.

## Consequences
- Positive: All 12 widgets in `DND5E_SHEET_LAYOUT` are fully functional and interactive in both Live Table drawers and `CampaignWorkspace`.
- Positive: Zero accidental stat modifications during combat via single-click roll triggers.
- Positive: Strict server authority enforcement for GM locking.
- Positive: Granular signal subscriptions maintain 60 FPS UI performance during frequent HP or slot updates.
- Negative: Increased component footprint requiring rigorous automated testing across both locked and unlocked modes.