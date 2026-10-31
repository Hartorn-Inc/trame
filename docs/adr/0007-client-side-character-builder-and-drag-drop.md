# ADR-0007: Client-Side Character Builder State Machine and Interactive Drag-and-Drop

## Status
Accepted

## Context
Character creation and sheet population require two workflows:
1. A 5-step guided wizard (`Ancestry` -> `Class` -> `Ability Scores` -> `Background & Skills` -> `Starting Equipment`) and fast NPC creation.
2. Interactive drag-and-drop of items, spells, and feats from the SRD 5.1 compendium onto character sheets, including nested container hierarchies.

A comprehensive compendium exists across three priority tiers (`CAMPAIGN_HOMEBREW > INSTANCE_LIBRARY > SYSTEM_SRD`) with bilingual support (`EN` and `FR`). Transient wizard edits must not flood the WebSocket network channel or persist incomplete actors until finalized.

Naively implementing drag-and-drop poses several architectural risks:
1. State corruption: Dropping a container into itself or one of its descendants creates circular references (`A -> B -> A`) that crash tree traversal algorithms.
2. Rule exploits: Equipping more than 3 attuned items violates the D&D 5e attunement limit.
3. Encumbrance errors: Weight-altering containers (such as the *Bag of Holding*) must set nested content weight to 0 while maintaining fixed container tare weight.
4. Architectural bloat: Introducing speculative client staging queues or secondary cache layers creates synchronization drift and race conditions with the authoritative server state.

## Decision
1. **Isolated Draft State Machine**: `CharacterBuilderWizard` operates on an in-memory draft state across the 5 canonical steps (`ancestry`, `class`, `abilities`, `background`, `equipment`) without dispatching network traffic during intermediate steps.
2. **Atomic Actor Finalization**: Completing the wizard produces a validated `Dnd5eActorData` record persisted atomically to the campaign (`PUT /api/v1/campaigns/{id}/actors/{actor_id}` and `UpsertActor` / `SpawnToken`).
3. **SRD 5.1 Generation Rules**: `CharacterBuilderWizard` supports Standard Array (`[15, 14, 13, 12, 10, 8]`), 27-Point Buy (`{8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9}`), and manual/rolled assignment.
4. **CompendiumDrawer & Stateless Drag-and-Drop Coordinator**:
   - Implement `CompendiumDrawer` featuring instant dual-language (`EN` + `FR`) fuzzy search across all compendium entities.
   - Implement `CompendiumDragDropManager` as a stateless client coordinator that handles native drag-and-drop events between compendium entries and sheet drop targets.
   - Dispatch standard CQRS commands (`UpdateActorField`, `UpsertActor`) directly to `tableStore` without secondary staging queues.
   - Provide instant visual feedback: highlight active drop zones and display error toast notifications upon invalid drop attempts.
5. **Acyclic Container Validation & Attunement Enforcement**:
   - Circular reference detection: Reject any container drop where the target container is an ancestor or identical to the source container.
   - Attunement cap enforcement: Reject attunement of a 4th item with a warning notification.
   - Tare and multiplier calculation: Recursively compute carried weight using `tareWeight + sum(child.weight * child.quantity) * contentWeightMultiplier` (so a *Bag of Holding* with `contentWeightMultiplier: 0` adds only its own tare weight).

## Consequences
### Positive
- Network traffic during character creation is reduced to a single atomic submission upon completion.
- Fast, intuitive character creation and equipment management via drag-and-drop.
- Circular container structures are rejected deterministically on the client and server.
- Tree cycle immunity and automated compliance with attunement limits.
- Stateless design maintains clean CQRS boundaries without cache drift.

### Negative
- Unsaved wizard drafts exist only in client memory until the final step is submitted.
- Requires synthetic drag-and-drop event simulation in integration test suites.
