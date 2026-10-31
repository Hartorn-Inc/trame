# ADR-0001: D&D 5e GameSystemPack Architecture, Multi-Type Damage Pipeline, Deterministic Rests, and 3-Tier Compendium

## Status
Accepted

## Context
The TRAME V1 milestone requires a complete, out-of-the-box game system pack for Dungeons & Dragons 5e (SRD 5.1 licensed under Creative Commons CC-BY-4.0).
The core engine `crates/trame-engine` (Rust/WASM) provides the generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase `ActiveEffect` manager, and the single-instance mitigation primitive `resolve_damage_application`.

However, the full combat and progression rules of SRD 5.1 introduce requirements specific to D&D 5e:
1. Computing multiple simultaneous damage instances with distinct `DamageType` categories (for example, bludgeoning weapon damage + radiant damage).
2. Enforcing a strict absorption sequence: absorption by `TempHP` (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing `InstantDeath` rules when excess damage equals or exceeds maximum HP (`hp.max`), and automatically recording `DeathSavingThrow` failures when an actor at 0 HP takes damage (adding 2 failures on a critical hit).
4. Deterministically emitting a `ConcentrationCheckPrompt` with a Difficulty Class (DC) calculated as `Math.max(10, Math.floor(damageTaken / 2))` whenever an actor maintaining concentration takes damage.
5. Deterministically managing `ShortRest` and `LongRest`, including spending hit dice, resetting `ResourcePool` counters, recovering half of maximum hit dice on a long rest, and handling spell slots according to caster type (standard spellcasting vs. Warlock Pact Magic).
6. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
7. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license.
8. Deterministically evaluating character progression from level 1 to 20 (`applyLevelUp`), including subclass selection, Ability Score Improvement (ASI) limits, feat selection, and spell slot progression tables.
9. Enforcing server-authoritative randomness (`ChaCha20Rng`) for hit point rolls and hit dice recovery during rests, disallowing client-side `Math.random()`.
10. Supporting bilingual compendium localization (`i18n` with English and French) with canonical ASCII slugs and weightless magical containers (`contentWeightMultiplier: 0`).

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests (`packages/game-systems/dnd5e/src/rest.ts`)**:
   - Pure functions `applyShortRest(actor, options)` and `applyLongRest(actor)` reside in `packages/game-systems/dnd5e/src/rest.ts`.
   - `applyShortRest` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **3-Tier Hierarchical Compendium and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries maintain canonical untranslated ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Entries support optional bilingual metadata (`i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`).
   - Magical containers set `contentWeightMultiplier: 0` to negate content weight.
5. **Deterministic Level 1-20 Progression (`packages/game-systems/dnd5e/src/progression.ts`)**:
   - `applyLevelUp(actor, options)` validates level progression from 1 to 20 (`1 <= level <= 20`).
   - The engine caps ability scores at 20 when applying Ability Score Improvements (`ASI`).
   - The engine enforces subclass selection at class milestone levels.
   - The engine reconciles spell slots using canonical `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS` tables.
6. **Server-Authoritative Dice Rolling and Dual Persistence Channels**:
   - Client components never invoke `Math.random()`.
   - Level-up HP rolls and short rest hit dice recovery request the server-authoritative `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` or WebSocket `TrameCommand::RollDice`.
   - Every dice roll generates a signed `TrameEvent` logged in the session timeline.
   - Live session sheet mutations dispatch `TrameCommand::UpdateActorData` over WebSocket to `TableRoomActor` backed by `SqlxPostgresStore`.
   - Workspace mutations outside active sessions dispatch HTTP `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Server-authoritative `ChaCha20Rng` eliminates client-side dice tampering during rests and level-ups.
- Compendium entries support bilingual localization while preserving canonical ASCII identifiers.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Client components must support dual persistence paths (WebSocket CQRS in live sessions vs. HTTP REST in workspace).
