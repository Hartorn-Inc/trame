# ADR-0038: Client-Side Character Builder State Machine and Interactive Drag-and-Drop

## Status
Accepted

## Context
Character creation and sheet population require two workflows:
1. A dual character creation pipeline: a multi-step guided wizard (*Ancestry* -> *Class* -> *Ability Scores* -> *Equipment* -> *Review*) and a fast freeform creation mode for NPCs.
2. Interactive drag-and-drop of items, spells, and traits from the compendium into character sheets, including nested container hierarchies.

Transient wizard edits must not flood the shared CRDT network channel or generate intermediate invalid actors on the table. In addition, container drag-and-drop operations must reject circular nesting and calculate container tare and multiplier weights deterministically.

## Decision
1. **Isolated Draft Store**: `CharacterBuilderWizard` operates exclusively on `BuilderDraftStore`, an in-memory draft state machine. It does not dispatch network commands or synchronize CRDT nodes during intermediate steps.
2. **Atomic Actor Instantiation**: The wizard dispatches exactly one `TrameCommand.CreateActor` payload upon submission of the final `review` step. Cancelling the wizard resets `BuilderDraftStore` to `null`.
3. **System-Agnostic Generation Rules**: `CharacterBuilderWizard` reads ability score configuration from `GameSystemPack.characterCreation.abilityGeneration`. For D&D 5e, it supports Standard Array (`[15, 14, 13, 12, 10, 8]`) and 27-Point Buy with standard costs (`{8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9}`).
4. **Container Hierarchy Validation**: `CompendiumDragDropManager` validates item movement. IF a drop target container is equal to the source item or is a descendant of the source item, THEN the drop is rejected and returns `false`.
5. **Container Weight Calculation**: `ContainerWeightCalculator` evaluates total container weight deterministically: `tareWeight + sum(child.unitWeight * child.quantity * container.weightMultiplier)`. A *Bag of Holding* (`weightMultiplier: 0.0`) adds zero child weight to parent encumbrance.
6. **Authoritative Engine Calculation**: Client-side drag-and-drop does not calculate 5-phase `ActiveEffect` derivations. The client dispatches `TrameCommand.DropCompendiumEntry` or `TrameCommand.UpdateActorSheet`, and `trame-engine` computes derived values authoritatively.

## Consequences
- Network traffic during character creation is reduced to a single transaction.
- Invalid intermediate actor states cannot persist to the shared game session.
- Circular container structures are rejected prior to command emission.
- Engine authority over modifier pipelines is preserved without client-side rule divergence.
