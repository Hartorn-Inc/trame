# ADR-0007: Client-Side Character Builder State Machine and Interactive Drag-and-Drop

## Status
Accepted

## Context
Character creation, progression, and sheet population require three distinct workflows:
1. A 5-step guided creation wizard (`CharacterBuilderWizard`: `Ancestry` -> `Class` -> `Ability Scores` -> `Background & Skills` -> `Starting Equipment`) located in the `CampaignWorkspace` (`Characters & Party` tab, outside the Live Table HUD so the live tabletop remains uncluttered), alongside quick Game Master monster/NPC templates for table spawning.
2. Direct character sheet editing protected by `CoreBuildLock` (client padlock toggle `coreStatsLocked` + optional server-enforced `gm_core_locked`) and a focused 4-step `LevelUpModal` (`Class & Subclass` -> `HP Gain` -> `Class Features & ASI/Feat` -> `New Spells & Slots`) accessible on the sheet both outside and inside the Live Table.
3. Interactive drag-and-drop of items, spells, and feats from the SRD 5.1 compendium onto character sheets, including nested container hierarchies.

Transient wizard edits must not flood the WebSocket network channel or persist incomplete actors until finalized. Container drag-and-drop operations must reject circular nesting and calculate container tare and multiplier weights deterministically.

## Decision
1. **Isolated Draft State Machine**: `CharacterBuilderWizard` operates on an in-memory draft state across the 5 canonical steps (`ancestry`, `class`, `abilities`, `background`, `equipment`) without dispatching network traffic during intermediate steps.
2. **Atomic Actor Finalization**: Completing the wizard produces a validated `Dnd5eActorData` record persisted atomically to the campaign (`PUT /api/v1/campaigns/{id}/actors/{actor_id}` and `UpsertActor` / `SpawnToken`).
3. **SRD 5.1 Generation Rules**: `CharacterBuilderWizard` supports Standard Array (`[15, 14, 13, 12, 10, 8]`), 27-Point Buy (`{8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9}`), and manual/rolled assignment.
4. **Acyclic Container Validation & Weight Calculation**: `CompendiumDragDropManager` rejects circular container drops (dropping a container into itself or any of its descendants) and computes total weight deterministically: `tareWeight + sum(child.weight * child.quantity) * contentWeightMultiplier` (so a *Bag of Holding* with `contentWeightMultiplier: 0` adds only its own tare weight).

## Consequences
### Positive
- Network traffic during character creation is reduced to a single atomic submission upon completion.
- Circular container structures are rejected deterministically on the client and server.

### Negative
- Unsaved wizard drafts exist only in client memory until the final step is submitted.
