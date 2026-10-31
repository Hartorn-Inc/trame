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
7. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license, supporting bilingual localization metadata (`en`/`fr`) and magical container tare multipliers.
8. Supporting complete character progression from levels 1 through 20 (`applyLevelUp`), including subclass selection at designated class thresholds, Ability Score Improvements (ASI capped at 20) versus Feat selection, spell learning, and canonical spell slot progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
9. Providing server-authoritative dice rolling for level-up hit point increases and rest recovery using a cryptographically secure random number generator (`ChaCha20Rng`), eliminating unverified client-side `Math.random()`.
10. Supporting dual persistence channels: real-time WebSocket CQRS commands (`TrameCommand::UpdateActorData`) dispatched to `TableRoomActor` during live tabletop sessions, and REST endpoints (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`) during asynchronous campaign preparation in `CampaignWorkspace`.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary and Modular Organization**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `rest.ts`, `progression.ts`, and `compendium.ts`.
   - `packages/game-systems/dnd5e/src/rest.ts` encapsulates pure synchronous rest functions: `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData`.
   - `packages/game-systems/dnd5e/src/progression.ts` encapsulates character leveling `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` enforcing the maximum level ceiling (20), the 20-point attribute ceiling during ASI, mandatory subclass selection, and exports canonical matrices `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `applyShortRest` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **3-Tier Hierarchical Compendium, Bilingual i18n, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use universal ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`) and support optional bilingual metadata `i18n?: { en: { name: string; description: string }; fr: { name: string; description: string } }`.
   - Magical containers declare `contentWeightMultiplier: 0` to negate content weight calculation in inventory hierarchies.
5. **Server-Authoritative Dice Rolling (`ChaCha20Rng`)**:
   - Web clients do not generate dice outcomes using `Math.random()`.
   - Hit point gains and hit dice recovery rolls evaluate on the server via `ChaCha20Rng` through REST `POST /api/v1/campaigns/{id}/dice/roll` (outside active sessions) or WebSocket CQRS `TrameCommand::RollDice` (on live tables), emitting signed `TrameEvent` records to the public session timeline.
6. **Dual Persistence Channels (CQRS / REST)**:
   - When an actor level-up or rest is triggered during a live session (`HudDrawers.tsx`), the client dispatches `TrameCommand::UpdateActorData` over WebSocket. `TableRoomActor` processes the mutation, broadcasts state updates to connected peers, and commits to `SqlxPostgresStore`.
   - When triggered outside an active session (`CampaignWorkspace`), the client dispatches `PUT /api/v1/campaigns/{id}/actors/{actor_id}` over HTTP REST.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Server-authoritative `ChaCha20Rng` generation prevents client-side roll tampering.
- User experience remains uniform between asynchronous prep (`CampaignWorkspace`) and live sessions (`HudDrawers.tsx`).

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Client UI components must maintain an environment adapter to route mutations between REST and CQRS channels.