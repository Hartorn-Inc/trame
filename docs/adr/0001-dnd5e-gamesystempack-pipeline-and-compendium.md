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
8. Deterministically evaluating character level advancement from level 1 to 20 (`applyLevelUp`), including subclass selection, Ability Score Improvements (capped at 20) versus feats, and progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
9. Eliminating client-side `Math.random()` by requiring server-authoritative `ChaCha20Rng` dice roll evaluations for HP advancement and rest recoveries.
10. Unifying actor sheet mutations across live table sessions (`TrameCommand::UpdateActorData` via WebSocket to `TableRoomActor`) and out-of-session preparation (`CampaignWorkspace` via REST).
11. Supporting bilingual localization (`en`/`fr`) and weightless magical containers (`contentWeightMultiplier: 0`) within the compendium schema.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary and Module Layout**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests (`packages/game-systems/dnd5e/src/rest.ts`)**:
   - Pure, synchronous rest functions reside in `packages/game-systems/dnd5e/src/rest.ts`.
   - `applyShortRest(actor, options)` validates available hit dice, computes HP recovery per die as `Math.max(1, roll + conMod)`, resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores HP to `hp.max`, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Progression Engine (`packages/game-systems/dnd5e/src/progression.ts`)**:
   - `applyLevelUp(actor, options)` advances actor level incrementally up to maximum level 20 (`1 <= level <= 20`).
   - Validates mandatory subclass selection at designated class milestone levels.
   - Validates Ability Score Improvements (`+2` or `+1/+1`), capping scores strictly at 20, or attaches valid feat identifiers from `SystemSRD`.
   - Exports canonical progression tables: `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`, reconciling current and max slot capacities via `reconcileSlots`.
5. **Server-Authoritative Dice Rolls and Dual Persistence Channels**:
   - UI components never use `Math.random()`. Hit points advancement and hit dice recovery query the server-authoritative `ChaCha20Rng` service via REST (`POST /api/v1/campaigns/{id}/dice/roll`) outside active sessions or CQRS command (`TrameCommand::RollDice`) in active table rooms.
   - Every roll produces a signed `TrameEvent` appended to the public session timeline.
   - Character sheet updates dispatch `TrameCommand::UpdateActorData` over WebSocket to `TableRoomActor` (`SqlxPostgresStore`) during live sessions, or `PUT /api/v1/campaigns/{id}/actors/{actor_id}` when editing in `CampaignWorkspace`.
6. **3-Tier Hierarchical Compendium, Bilingual i18n, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Canonical compendium keys maintain universal ASCII slugs (e.g., `srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Compendium entries support optional bilingual metadata (`i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`).
   - Magic container items define `contentWeightMultiplier: 0` to negate content weight calculation in container hierarchies.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Server-authoritative `ChaCha20Rng` eliminates dice roll tampering for character advancement and recovery.
- State persistence guarantees consistency across live table sessions and offline workspace preparation.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Client components must support dual persistence channels depending on live room connection status.