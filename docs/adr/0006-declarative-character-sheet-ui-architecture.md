# ADR-0006: Declarative Character Sheet UI Architecture and Widget Registry

## Status
Accepted

## Context
TRAME requires character sheets to adapt dynamically to distinct game systems without hardcoding game-specific JSX components in `packages/web`. The D&D 5e character sheet renders entirely from `dnd5e/system.json` layout declarations while maintaining strict separation between layout presentation and reactive `Actor` state.

## Decision
We implement the character sheet UI through a declarative layout abstract syntax tree (AST) processed by `DeclarativeSheetRenderer`:
1. **Declarative Layout AST (`DND5E_CHARACTER_SHEET_LAYOUT`)**: Game system manifests declare layout trees using container nodes (`tabs`, `tab`, `grid`, `section`) and 11 canonical widget types:
   - `stat-block-6`
   - `skill-proficiency-list`
   - `resource-bar`
   - `hit-dice-tracker`
   - `death-saves-box`
   - `InventoryGrid`
   - `spellbook-table`
   - `attacks-list`
   - `conditions-bar`
   - `active-effects-panel`
   - `roll-button`
2. **Deterministic Data Binding**: `DeclarativeSheetRenderer` resolves values from the `Actor` record (`Dnd5eActorData`) and its evaluated `derivedDAG` attributes (`AbilityModifier`, `ProficiencyBonus`, Armor Class, Spell Save DC).
3. **Interactive Roll & Mutation Dispatch**: Clicking any `roll-button` widget constructs the appropriate dice formula (`1d20 + mod` or weapon/spell expression) and dispatches a `RollDice` envelope over the WebSocket, while sheet edits dispatch `UpdateActorField` / `UpsertActor` mutations.

## Consequences
### Positive
- Game system packages own their sheet layout specifications declaratively.
- Preact drawer components render any `DeclarativeSheetRenderer` view-model reactively via `PreactSignalState`.

### Negative
- Adding a new atomic widget primitive requires registering its view-model builder and Preact renderer.
