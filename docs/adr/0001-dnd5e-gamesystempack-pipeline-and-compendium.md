# ADR-0001: D&D 5e GameSystemPack Architecture, Multi-Type Damage Pipeline, Deterministic Rests, and 3-Tier Compendium

## Status
Accepted

## Context
The TRAME V1 milestone requires a complete game system pack for Dungeons & Dragons 5e under Creative Commons CC-BY-4.0.
`crates/trame-engine` provides generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase `ActiveEffect` manager, and the elementary `resolve_damage_application` primitive.

However, the combat, rest, and progression rules of SRD 5.1 introduce requirements specific to D&D 5e:
1. Computing multiple simultaneous damage instances with distinct `DamageType` categories.
2. Enforcing a strict absorption sequence: absorption by `TempHP` (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing `InstantDeath` rules when excess damage equals or exceeds maximum HP (`hp.max`), and recording `DeathSavingThrow` failures when an `Actor` at 0 HP takes damage.
4. Deterministically emitting a `ConcentrationCheckPrompt` with Difficulty Class `Math.max(10, Math.floor(damageTaken / 2))` whenever an `Actor` maintaining concentration takes damage.
5. Deterministically managing `ShortRest` and `LongRest`, including spending hit dice, resetting `ResourcePool` counters, recovering half of maximum hit dice on a long rest, and restoring spell slots according to caster type.
6. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn `Actor`.
7. Advancing `Actor` level from 1 to 20 (`applyLevelUp`) with strict validation: subclass selection at required class tier, Ability Score Improvement (ASI: `+2` or `+1/+1`) capped at 20 versus feat selection, and spell slot progression across full-caster, half-caster, and pact magic classes.
8. Enforcing server-authoritative randomness (`ChaCha20Rng`) for hit dice and hit point rolls without client `Math.random()`, dispatching signed events.
9. Supporting dual-channel `Actor` persistence across live sessions (`TrameCommand::UpdateActorData` via WebSocket to `TableRoomActor` and `SqlxPostgresStore`) and preparation mode (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`).
10. Providing an expanded 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with CC-BY-4.0, supporting canonical ASCII slugs, optional bilingual localization (`i18n`), and zero-weight containers (`contentWeightMultiplier: 0`).

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests (`rest.ts`)**:
   - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level-Up Progression (Levels 1-20 in `progression.ts`)**:
   - `applyLevelUp(actor, options)` strictly validates single-level increments up to level 20, enforces subclass selection milestones, caps ASI ability scores at 20, validates feat selection, and reconciles spell slots against `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
5. **Server-Authoritative Dice Authority and Dual Persistence**:
   - Client components never invoke `Math.random()`. Hit point and hit dice rolls query the server-authoritative `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` or WebSocket `TrameCommand::RollDice`.
   - Table mutations in active sessions dispatch `TrameCommand::UpdateActorData` via WebSocket to `TableRoomActor` and persist to `SqlxPostgresStore`. Out-of-session edits dispatch REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.
6. **3-Tier Hierarchical Compendium, Bilingual Localization, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use universal ASCII slugs (`srd:item:bag_of_holding`), support optional bilingual metadata (`i18n?: { en: ..., fr: ... }`), and support magical containers with `contentWeightMultiplier: 0`.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- Server-authoritative `ChaCha20Rng` eliminates cheating on hit dice and level-up hit point rolls.
- Unified state persistence supports both live table play (`HudDrawers.tsx`) and offline preparation (`CampaignWorkspace`).
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Supporting dual persistence channels requires maintaining both REST and CQRS WebSocket adapters in client UI components.
