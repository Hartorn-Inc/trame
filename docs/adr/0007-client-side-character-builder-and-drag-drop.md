# ADR-0007: Client-Side Character Builder State Machine and Interactive Drag-and-Drop

## Status
Accepted

## Context
Character creation and sheet population require two workflows:
1. A 5-step guided wizard (`Ancestry` -> `Class` -> `Ability Scores` -> `Background & Skills` -> `Starting Equipment`) and fast NPC creation.
2. A searchable `CompendiumDrawer` with bilingual support (`EN` and `FR`) across three priority tiers (`CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`) and interactive drag-and-drop of items, containers, spells, and features onto character sheets.

Transient wizard edits must not flood the WebSocket network channel or persist incomplete actors until finalized.
Container drag-and-drop operations must reject circular nesting, enforce the 3-item attunement limit, calculate container tare and multiplier weights deterministically, and avoid speculative client cache drift.

## Decision
1. **Isolated Draft State Machine**: `CharacterBuilderWizard` operates on an in-memory draft state across the 5 canonical steps (`ancestry`, `class`, `abilities`, `background`, `equipment`) without dispatching network traffic during intermediate steps.
2. **Atomic Actor Finalization**: Completing the wizard produces a validated `Dnd5eActorData` record persisted atomically to the campaign (`PUT /api/v1/campaigns/{id}/actors/{actor_id}` and `UpsertActor` / `SpawnToken`).
3. **SRD 5.1 Generation Rules**: `CharacterBuilderWizard` supports Standard Array (`[15, 14, 13, 12, 10, 8]`), 27-Point Buy (`{8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9}`), and manual/rolled assignment.
4. **Searchable CompendiumDrawer**: Implement `CompendiumDrawer` featuring instant dual-language (`EN` and `FR`) fuzzy search across all compendium tiers (`CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`).
5. **Stateless CompendiumDragDropManager & Invariant Validation**:
   Implement `CompendiumDragDropManager` as a stateless client coordinator that handles native drag-and-drop events between compendium entries and sheet drop targets:
   - Acyclic container validation: Reject any container drop where the destination container is an ancestor of or identical to the source container.
   - Attunement cap enforcement: Reject attunement of a 4th item with a warning notification.
   - Deterministic tare and weight calculation: Recursively compute total carried weight using `tareWeight + sum(child.weight * child.quantity) * contentWeightMultiplier` (containers with `contentWeightMultiplier: 0` add only tare weight).
   - Direct CQRS dispatch: Dispatch standard commands (`UpdateActorField`, `UpsertActor`) directly to `tableStore` without secondary staging queues or speculative client caches.
   - Visual feedback: Highlight active drop zones and display error toast notifications upon invalid drop attempts.

## Consequences
### Positive
- Character creation network traffic is reduced to a single atomic submission upon completion.
- Bilingual `CompendiumDrawer` and drag-and-drop provide fast character creation and equipment management.
- Tree cycle immunity, attunement cap compliance, and exact tare weight calculations protect data integrity.
- Stateless design eliminates cache drift and maintains clean CQRS boundaries.

### Negative
- Unsaved wizard drafts exist only in client memory until the final step is submitted.
- Automated integration test suites require synthetic drag-and-drop event simulation.