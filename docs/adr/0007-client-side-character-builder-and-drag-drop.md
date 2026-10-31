# ADR-0007: Client-Side Character Builder State Machine, Compendium Drawer, and Interactive Drag-and-Drop

## Status
Accepted

## Context
Character creation and character sheet population in TRAME require two interconnected workflows:
1. A 5-step guided wizard (`Ancestry` -> `Class` -> `Ability Scores` -> `Background & Skills` -> `Starting Equipment`) and fast NPC generation.
2. Interactive drag-and-drop of items, spells, and features from the hierarchical compendium onto character sheets, including nested container hierarchies.

Naively implementing character generation and drag-and-drop introduces critical architectural risks:
1. Intermediate draft mutations can flood the WebSocket network channel and persist incomplete actors to the campaign database.
2. Dropping a container into itself or one of its descendants creates circular references (`A -> B -> A`) that crash tree traversal algorithms.
3. Equipping more than 3 attuned items violates the D&D 5e attunement limit.
4. Weight-altering containers (such as the *Bag of Holding*) require calculating container tare weight while setting nested item effective weight to zero.
5. Introducing speculative client staging queues or secondary cache layers creates synchronization drift and race conditions with authoritative server state.

## Decision
1. **Isolated Draft State Machine (`CharacterBuilderWizard`)**:
   `CharacterBuilderWizard` operates on an in-memory draft state across the 5 canonical steps (`ancestry`, `class`, `abilities`, `background`, `equipment`) without dispatching network mutations during intermediate steps.
2. **Atomic Actor Finalization**:
   Completing the wizard produces a validated `Dnd5eActorData` record persisted atomically to the campaign via `PUT /api/v1/campaigns/{id}/actors/{actor_id}` and `UpsertActor` / `SpawnToken`.
3. **SRD 5.1 Generation Rules**:
   `CharacterBuilderWizard` supports Standard Array (`[15, 14, 13, 12, 10, 8]`), 27-Point Buy (`{8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9}`), and manual score assignment.
4. **Searchable Dual-Language Compendium Drawer (`CompendiumDrawer`)**:
   `CompendiumDrawer` executes instant bilingual (`EN` + `FR`) fuzzy search across all three hierarchical compendium tiers (`CAMPAIGN_HOMEBREW > INSTANCE_LIBRARY > SYSTEM_SRD`) with categorized navigation for items, spells, feats, and monsters.
5. **Stateless Drag-and-Drop Coordinator (`CompendiumDragDropManager`)**:
   `CompendiumDragDropManager` coordinates HTML5 native drag-and-drop between compendium drawer entries and sheet drop targets (`InventoryContainerTree`, `SpellbookAccordion`, `FeatureTraitList`). It enforces deterministic validation invariants before dispatching mutations:
   - *Acyclic Container Validation*: Reject any container drop when the target container is identical to or an existing descendant of the source container.
   - *Attunement Limit Enforcement*: Reject an attunement attempt for a fourth item when attuned items count equals 3, and emit a warning notification.
   - *Tare and Multiplier Weight Calculation*: Compute total carried weight as `tareWeight + sum(child.weight * child.quantity) * contentWeightMultiplier` (setting multiplier to 0 for weight-altering containers like *Bag of Holding*).
   - *Direct CQRS Command Dispatch*: Dispatch standard `UpdateActorField` or `UpsertActor` commands directly to `tableStore` without secondary staging queues or speculative caches.
   - *Visual Feedback*: Highlight active drop zones and display error toast notifications upon invalid drop attempts.

## Consequences
### Positive
- Network traffic during character creation is reduced to a single atomic submission upon wizard completion.
- Fast, intuitive character creation and equipment management via native drag-and-drop.
- Circular container structures are deterministically rejected on both client and server.
- Automated compliance with the D&D 5e attunement limit.
- Stateless design maintains clean CQRS boundaries without cache drift.

### Negative
- Unsaved wizard drafts exist only in client memory until the final step is submitted.
- Testing drag-and-drop interactions requires synthetic event simulation in automated test suites.
