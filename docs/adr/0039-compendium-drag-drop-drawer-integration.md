# ADR-0039: Compendium Drawer & Stateless Drag-and-Drop Coordinator

## Status
Accepted

## Context
Creating and equipping characters in TR-AME previously required manual text entry for items, weapons, spells, and features. A comprehensive compendium exists across three priority tiers (`CAMPAIGN_HOMEBREW > INSTANCE_LIBRARY > SYSTEM_SRD`) with bilingual support (`EN` and `FR`). However, players had no visual compendium browser or drag-and-drop mechanism to populate character sheets directly.

Naively implementing drag-and-drop poses several architectural risks:
1. State corruption: Dropping a container into itself or one of its descendants creates circular references (`A -> B -> A`) that crash tree traversal algorithms.
2. Rule exploits: Equipping more than 3 attuned items violates the D&D 5e attunement limit.
3. Encumbrance errors: Weight-altering containers (such as the *Bag of Holding*) must set nested content weight to 0 while maintaining fixed container tare weight.
4. Architectural bloat: Introducing speculative client staging queues or secondary cache layers creates synchronization drift and race conditions with the authoritative server state.

## Decision
1. Implement `CompendiumDrawer` featuring instant dual-language (`EN` + `FR`) fuzzy search across all compendium entities.
2. Implement `CompendiumDragDropManager` as a stateless client coordinator that handles native drag-and-drop events between compendium entries and sheet drop targets.
3. Enforce deterministic validation invariants prior to dispatching mutations:
   - Circular reference detection: Reject any container drop where the target container is an ancestor or identical to the source container.
   - Attunement cap enforcement: Reject attunement of a 4th item with a warning notification.
   - Tare and multiplier calculation: Recursively compute carried weight using `contentWeightMultiplier = 0` for zero-weight containers.
4. Dispatch standard CQRS commands (`UpdateActorField`, `UpsertActor`) directly to `tableStore` without secondary staging queues.
5. Provide instant visual feedback: Highlight active drop zones and display error toast notifications upon invalid drop attempts.

## Consequences
- Positive: Fast, intuitive character creation and equipment management via drag-and-drop.
- Positive: Tree cycle immunity and automated compliance with attunement limits.
- Positive: Stateless design maintains clean CQRS boundaries without cache drift.
- Negative: Requires synthetic drag-and-drop event simulation in integration test suites.