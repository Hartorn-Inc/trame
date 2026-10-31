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
8. Executing character progression (levels 1-20), including subclass specialization at milestone levels, Ability Score Improvement (ASI capped at 20) versus Feat dilemmas, spell learning constraints, and spell slot progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
9. Guaranteeing authoritative dice roll generation for hit point increases and hit dice recovery to eliminate client-side manipulation.
10. Synchronizing actor mutations through dual persistence channels: real-time WebSocket CQRS commands during live table sessions and standard HTTP REST endpoints outside active sessions.
11. Supporting bilingual localization (`en` / `fr`) and container tare/content weight multipliers (`contentWeightMultiplier: 0` for extradimensional storage) within the compendium.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - Pure functions reside in `packages/game-systems/dnd5e/src/rest.ts`.
   - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level Progression (Levels 1-20)**:
   - Pure functions reside in `packages/game-systems/dnd5e/src/progression.ts`.
   - `applyLevelUp(actor, options)` validates level increments (`targetLevel === actor.system.level + 1`, capped at 20), enforces subclass selection at class milestones, validates ASI (`+2` or `+1/+1` capped at 20) or Feat selections, and assigns hit point gains (`Math.max(1, baseGain + conMod)`).
   - Exports canonical progression tables `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS` for spell slot reconciliation.
5. **Authoritative Server Dice Authority**:
   - UI components never execute `Math.random()`.
   - Hit points and hit dice recovery rolls use server-authoritative `ChaCha20Rng` generation via `POST /api/v1/campaigns/{id}/dice/roll` (outside active session) or `TrameCommand::RollDice` (during active WebSocket session), consigning signed `TrameEvent` records to the timeline.
6. **Dual Persistence Channels (CQRS & REST)**:
   - When triggered from the live table HUD (`HudDrawers.tsx`), mutations dispatch `TrameCommand::UpdateActorData` via WebSocket to `TableRoomActor` and persist to `SqlxPostgresStore`.
   - When triggered outside active sessions (`CampaignWorkspace`), mutations dispatch `PUT /api/v1/campaigns/{id}/actors/{actor_id}` via HTTP REST.
7. **3-Tier Hierarchical Compendium, Bilingual i18n, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use canonical ASCII slugs (`srd:item:bag_of_holding`, `srd:spell:fireball`), support optional bilingual metadata (`i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`), and implement `contentWeightMultiplier: 0` for weightless storage containers.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Cryptographic `ChaCha20Rng` server rolls prevent client dice tampering during level-up and rests.
- State persistence remains unified across active table sessions and offline workspace preparation.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Level-up and rest modals require asynchronous server roundtrips to obtain authoritative dice rolls.
