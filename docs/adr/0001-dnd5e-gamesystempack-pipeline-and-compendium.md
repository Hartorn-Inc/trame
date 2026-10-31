# ADR-0001: D&D 5e GameSystemPack Architecture, Multi-Type Damage Pipeline, Deterministic Rests, and 3-Tier Compendium

## Status
Accepted

## Context
The TRAME V1 milestone requires a complete game system pack for Dungeons & Dragons 5e (SRD 5.1 licensed under Creative Commons CC-BY-4.0).
The core engine `crates/trame-engine` (Rust/WASM) provides generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase `ActiveEffect` manager, and the elementary mitigation primitive `resolve_damage_application`.

SRD 5.1 combat and progression rules introduce specific requirements for D&D 5e:
1. Computing multiple simultaneous damage instances with distinct `DamageType` categories.
2. Enforcing a strict absorption sequence: absorption by `TempHP` (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing `InstantDeath` rules when excess damage equals or exceeds maximum HP (`hp.max`), and automatically recording `DeathSavingThrow` failures when an actor at 0 HP takes damage.
4. Deterministically emitting a `ConcentrationCheckPrompt` with a Difficulty Class calculated as `Math.max(10, Math.floor(damageTaken / 2))` whenever a concentrating actor takes damage.
5. Deterministically managing `ShortRest` and `LongRest`, including hit dice spending, `ResourcePool` resets, half-max hit dice recovery, and caster spell slot recovery.
6. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`).
7. Implementing full character progression (levels 1-20) in `packages/game-systems/dnd5e/src/progression.ts`, including subclass milestones, Ability Score Improvement (ASI capped at 20) versus feats, and spell slot progressions (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
8. Enforcing server-authoritative randomness (`ChaCha20Rng`) for hit points and hit dice rolls to eliminate client tampering.
9. Supporting dual persistence channels: WebSocket CQRS (`TrameCommand::UpdateActorData`) in live table rooms and REST (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`) in `CampaignWorkspace`.
10. Providing a 3-tier hierarchical compendium (`CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`) with bilingual `i18n` support, universal ASCII slugs, and zero-weight containers (`contentWeightMultiplier: 0`).

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary & Modular Structure**:
   - `crates/trame-engine` remains agnostic to D&D 5e rules and provides the generic `derivedDAG` engine and `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` 0.5x -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Character Progression (Levels 1-20)**:
   - `applyLevelUp(actor, options)` in `progression.ts` validates that target level equals current level plus 1 (up to level 20).
   - The engine computes HP gain via fixed average (`Math.floor(hitDie / 2) + 1 + conMod`, minimum 1 HP) or verified server-rolled HP.
   - The engine validates mandatory subclass selection at class milestone levels.
   - The engine validates ASI constraints (bonus sum of 2, no score exceeding 20) or feat selection from `SystemSRD`.
   - The engine reconciles spell slot capacities via `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, or `PACT_MAGIC_SPELL_SLOTS`, and recalculates `ProficiencyBonus`.
4. **Deterministic Resource Pools and Rests (`rest.ts`)**:
   - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, minimum 1 HP), validates spend count against `hitDice.current`, resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
5. **Server-Authoritative Randomness & Dual Persistence Channels**:
   - Client interfaces never execute `Math.random()`. Hit dice and level-up HP rolls use server-authoritative `ChaCha20Rng` via `POST /api/v1/campaigns/{id}/dice/roll` (outside active sessions) or `TrameCommand::RollDice` (in active table sessions), emitting a signed `TrameEvent`.
   - Live table mutations persist via WebSocket CQRS (`TrameCommand::UpdateActorData`) in `TableRoomActor`. Workspace mutations persist via REST (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`).
6. **3-Tier Hierarchical Compendium, CC-BY-4.0 License, and Internationalization**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use universal ASCII slugs, support optional bilingual metadata (`i18n?: { en: ..., fr: ... }`), and magical containers specify `contentWeightMultiplier: 0`.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e progression, combat, and rest rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Server-authoritative `ChaCha20Rng` prevents client-side tampering during rests and level-ups.
- Unified mutation handling supports live table sessions and offline workspace preparation.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Dual persistence channels require UI components to delegate mutations through an injected persistence adapter.
