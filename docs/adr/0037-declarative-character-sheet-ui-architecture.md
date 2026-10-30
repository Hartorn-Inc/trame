# ADR-0037: Declarative Character Sheet UI Architecture and Widget Registry

## Status
Accepted

## Context
Trame requires character sheets to adapt dynamically to distinct game systems without hardcoding game-specific JSX components in `packages/web`. Issue #9 specifies that the D&D 5e character sheet must render entirely from `dnd5e/system.json` declarations.
The rendering pipeline must satisfy four non-negotiable requirements:
1. Zero D&D 5e game rules or hardcoded JSX layouts inside `packages/web`.
2. Strict separation between layout presentation and reactive Actor state.
3. Type-safe and deterministic resolution of dynamic data binding paths (`DataBindingPath`).
4. Strict adherence to Node 24 native test runner (`node:test`) without heavy browser mock libraries (`@testing-library/react`, Vitest).

## Decision
We implement the character sheet UI through a declarative layout abstract syntax tree (AST) processed by `DeclarativeSheetRenderer`:
1. **`SheetLayoutTree` AST**: Game system manifests declare layout trees using five distinct `LayoutNodeKind` values: `section`, `column`, `row`, `tabs`, and `widget`.
2. **`WidgetRegistry`**: A frozen registry maps canonical widget type names to atomic widget implementations. The registry contains exactly 12 canonical atomic widgets:
   - `StatBlock6`
   - `ResourceBar`
   - `SavingThrowList`
   - `SkillCheckList`
   - `ArmorInitiativeSpeed`
   - `HitDiceAndDeathSaves`
   - `AttackActionTable`
   - `SpellbookAccordion`
   - `InventoryContainerTree`
   - `FeatureTraitList`
   - `ConditionBadgeStrip`
   - `NotesMarkdownPane`
3. **Deterministic Data Binding**: A `BindingResolver` extracts values from the Actor record `{ sheet, derived }` via dot-separated paths. IF a path does not resolve, THEN `BindingResolver` returns `null` without throwing an exception.
4. **Event Dispatching**: Atomic widgets do not modify state directly. Widgets emit canonical `TrameCommand` payloads (`RollDice`, `ProjectAoE`, `UpdateActorSheet`, `DropCompendiumEntry`) through an injected command dispatcher callback.
5. **Duplicate ID Validation**: When `DeclarativeSheetRenderer` parses a `SheetLayoutTree`, it asserts that all node identifiers are globally unique across the tree. IF a duplicate node ID is encountered, THEN `DeclarativeSheetRenderer` throws `DuplicateNodeIdError`.

## Consequences
- System packages (`@trame/dnd5e-game-system`) fully own their sheet layout specifications in JSON.
- New game systems can define distinct layouts without modifying `packages/web`.
- Testing remains fast and headless via `node:test` and `node:assert/strict` by asserting AST generation, data binding resolution, and command dispatch without DOM overhead.
