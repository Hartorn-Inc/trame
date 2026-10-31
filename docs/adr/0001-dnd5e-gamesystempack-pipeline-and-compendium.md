# ADR-0001: D&D 5e GameSystemPack Architecture, Multi-Type Damage Pipeline, Progression & Rests, and 3-Tier Compendium

## Status
Accepted

## Context
The TRAME V1 milestone requires a complete, out-of-the-box game system pack for Dungeons & Dragons 5e (SRD 5.1 licensed under Creative Commons CC-BY-4.0).
The core engine `crates/trame-engine` (Rust/WASM) provides the generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase `ActiveEffect` manager, and the single-instance mitigation primitive `resolve_damage_application`.

However, the full combat and progression rules of SRD 5.1 introduce requirements specific to D&D 5e:
1. Computing multiple simultaneous damage instances with distinct `DamageType` categories (for example, bludgeoning weapon damage + radiant damage).
2. Enforcing a strict absorption sequence: absorption by `TempHP` (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing `InstantDeath` rules when excess damage equals or exceeds maximum HP (`hp.max`), and automatically recording `DeathSavingThrow` failures when an `Actor` at 0 HP takes damage (adding 2 failures on a critical hit).
4. Deterministically emitting a `ConcentrationCheckPrompt` with a Difficulty Class (DC) calculated as `Math.max(10, Math.floor(damageTaken / 2))` whenever an `Actor` maintaining concentration takes damage.
5. Deterministically managing `ShortRest` and `LongRest`, including spending hit dice, resetting `ResourcePool` counters, recovering half of maximum hit dice on a long rest, and handling spell slots according to caster type (standard spellcasting vs. Warlock Pact Magic).
6. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
7. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license.
8. Enforcing character progression from level 1 to 20, including subclass selection at canonical class levels, Ability Score Improvement (`AbilityScore` cap of 20) vs. Feat selection, and deterministic spell slot progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
9. Enforcing server-authoritative randomness via `ChaCha20Rng` for hit point gains and hit dice recovery rolls during progression and rests.
10. Providing dual-channel state persistence reconciling active WebSocket CQRS table mutations with offline REST workspace updates.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `packages/game-systems/dnd5e/src/rest.ts` encapsulates pure synchronous functions `applyShortRest(actor, options)` and `applyLongRest(actor)`.
   - `applyShortRest` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Character Progression (Lvl 1-20)**:
   - `packages/game-systems/dnd5e/src/progression.ts` encapsulates `applyLevelUp(actor, options)` with strict validation for maximum level (20) and `AbilityScore` ceiling (20) during Ability Score Improvements.
   - The module exports canonical spell progression tables: `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
   - The module derives `ProficiencyBonus` deterministically from character level (`Math.floor((level - 1) / 4) + 2`).
5. **Server-Authoritative Dice Rolling and Dual Persistence Channels**:
   - Client interfaces never use `Math.random()`.
   - Hit point gains and hit dice recovery rolls execute through the server-authoritative `ChaCha20Rng` service via REST (`POST /api/v1/campaigns/{id}/dice/roll`) or WebSocket CQRS (`TrameCommand::RollDice`).
   - Every roll produces a signed `TrameEvent` appended to the session timeline.
   - During live table sessions, HUD drawers dispatch `TrameCommand::UpdateActorData` via WebSocket to `TableRoomActor`, which persists state via `SqlxPostgresStore`.
   - Outside active sessions, workspace forms dispatch REST requests (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`).
6. **3-Tier Hierarchical Compendium, Internationalization, and Licensing**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use universal ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Each entry in `compendium.ts` supports an optional bilingual block `i18n?: { en: LocalizedDisplayMetadata, fr: LocalizedDisplayMetadata }`.
   - Magic containers declare `contentWeightMultiplier: 0` to nullify content weight.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Cryptographic dice rolls via `ChaCha20Rng` eliminate client-side roll falsification.
- Dual persistence channels support both real-time collaborative play and offline campaign preparation.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Client view-models must support both WebSocket CQRS and HTTP REST dispatch adapters depending on active session presence.
