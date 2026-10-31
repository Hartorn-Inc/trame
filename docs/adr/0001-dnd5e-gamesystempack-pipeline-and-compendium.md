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
6. Supporting character progression from Level 1 to 20, including subclass milestones, Ability Score Improvement (ASI capped at 20) versus Feat choices, and spell slot progression across full, half, and pact casters.
7. Enforcing server-authoritative dice generation for hit point progression and rest recovery to eliminate client-side `Math.random()` manipulation.
8. Providing dual persistence channels across asynchronous workspace editing (REST) and live table sessions (CQRS WebSocket).
9. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
10. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license, supporting bilingual metadata and extra-dimensional container tare weights.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - Pure synchronous functions in `packages/game-systems/dnd5e/src/rest.ts` govern rest transitions:
     - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
     - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level-Up Progression (Lvl 1-20)**:
   - `packages/game-systems/dnd5e/src/progression.ts` exports `applyLevelUp(actor, options)` enforcing:
     - Single-level increments bounded between 1 and 20 (`1 <= level <= 20`).
     - Hit point gain calculated as `Math.max(1, baseGain + conMod)` (fixed average or certified server roll).
     - Mandatory subclass assignment at class milestone levels (level 1, 2, or 3 depending on class).
     - Ability Score Improvements (`+2` or `+1/+1`) strictly capped at 20 or replacement by a valid SRD feat.
     - Canonical slot reconciliation using exported tables: `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
5. **Server-Authoritative Dice Rolls**:
   - UI components never execute `Math.random()`.
   - Hit point progression rolls and short rest hit dice expenditures invoke the server `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` or WebSocket `TrameCommand::RollDice` (ADR-0003).
   - Every roll records an authoritative `TrameEvent` prior to actor state mutation.
6. **Dual Persistence Channel (CQRS / REST)**:
   - During live table sessions, HUD drawers (`HudDrawers.tsx`) dispatch `TrameCommand::UpdateActorData` over WebSocket for broadcast by `TableRoomActor` and persistence via `SqlxPostgresStore` (ADR-0010).
   - In asynchronous campaign preparation (`CampaignWorkspace`), clients persist actor mutations via REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` (ADR-0007).
7. **3-Tier Hierarchical Compendium, CC-BY-4.0 Attribution, and Internationalization**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the CC-BY-4.0 attribution notice.
   - Compendium entries use canonical untranslated ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`) with optional bilingual metadata (`i18n?: { en: ..., fr: ... }`).
   - Extra-dimensional containers declare `contentWeightMultiplier: 0` to zero contained weight on the outer carrier (ADR-0007).

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Server-side `ChaCha20Rng` guarantees tamper-proof hit point and rest recovery rolls.
- Unified actor data contracts support both live table WebSocket CQRS and offline/preparation REST persistence.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Maintaining dual persistence channels requires injecting persistence adapters based on execution context.
