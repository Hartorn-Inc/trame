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
7. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license, canonical ASCII slugs, and optional bilingual metadata (`i18n`).
8. Managing Level 1-20 character progression (`applyLevelUp`), including subclass selection milestones, Ability Score Improvement (ASI) limits (`AbilityScore <= 20`) versus Feats, spell slot progression tables, and server-authoritative random number generation (`ChaCha20Rng`) without client-side `Math.random()`.
9. Supporting dual persistence channels: real-time WebSocket CQRS commands for active table sessions and REST endpoints for workspace preparation.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary and Modular Split**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - Encapsulated in `packages/game-systems/dnd5e/src/rest.ts`.
   - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level 1-20 Progression and Spell Slot Reconciliation**:
   - Encapsulated in `packages/game-systems/dnd5e/src/progression.ts`.
   - `applyLevelUp(actor, options)` validates level limits (`1 <= level <= 20`), computes HP gain (`Math.max(1, baseGain + conMod)` in fixed mode or server-rolled mode), assigns subclass at class milestone levels, and processes ASI vs. Feats.
   - ASI choices enforce `AbilityScore <= 20` (+2 to one score or +1 to two distinct scores).
   - Spell slots reconcile via `reconcileSlots` using canonical tables: `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
5. **Server-Authoritative Dice Rolling and Dual Persistence Channels**:
   - Zero UI components use `Math.random()`. Hit point rolls and hit dice expenditures query server-authoritative `ChaCha20Rng` producing signed `TrameEvent` records.
   - Live session updates dispatch CQRS `TrameCommand::UpdateActorData` over WebSocket to `TableRoomActor` and persist via `SqlxPostgresStore`.
   - Off-session updates in `CampaignWorkspace` submit REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.
6. **3-Tier Hierarchical Compendium, Bilingual i18n, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use universal canonical ASCII slugs (`srd:item:*`, `srd:spell:*`, `srd:feat:*`, `srd:monster:*`) with optional bilingual metadata `i18n?: { en: { name, description }, fr: { name, description } }`.
   - Magical containers support `contentWeightMultiplier: 0` to negate content weight.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Cryptographic dice rolls via `ChaCha20Rng` prevent client-side manipulation.
- Character progression (Level 1-20) and rests are deterministic, testable, and strictly bound by SRD 5.1 rules.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- UI components must maintain dual persistence adapters (REST for workspace, WebSocket CQRS for active table).
