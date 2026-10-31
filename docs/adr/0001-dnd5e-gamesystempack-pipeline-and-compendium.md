# ADR-0001: D&D 5e GameSystemPack Architecture, Multi-Type Damage Pipeline, Deterministic Rests, and 3-Tier Compendium

## Status
Accepted

## Context
The TRAME V1 milestone requires a complete, out-of-the-box game system pack for Dungeons & Dragons 5e (SRD 5.1 licensed under Creative Commons CC-BY-4.0).
The core engine `crates/trame-engine` (Rust/WASM) provides the generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase `ActiveEffect` manager, and the single-instance mitigation primitive `resolve_damage_application`.

However, the full combat, progression, and rest rules of SRD 5.1 introduce requirements specific to D&D 5e:
1. Computing multiple simultaneous damage instances with distinct `DamageType` categories (for example, bludgeoning weapon damage + radiant damage).
2. Enforcing a strict absorption sequence: absorption by `TempHP` (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing `InstantDeath` rules when excess damage equals or exceeds maximum HP (`hp.max`), and automatically recording `DeathSavingThrow` failures when an actor at 0 HP takes damage (adding 2 failures on a critical hit).
4. Deterministically emitting a `ConcentrationCheckPrompt` with a Difficulty Class (DC) calculated as `Math.max(10, Math.floor(damageTaken / 2))` whenever an actor maintaining concentration takes damage.
5. Deterministically managing `ShortRest` and `LongRest`, including spending hit dice, resetting `ResourcePool` counters, recovering half of maximum hit dice on a long rest, and handling spell slots according to caster type (standard spellcasting vs. Warlock Pact Magic).
6. Deterministically managing character level advancement (`applyLevelUp`) from level 1 to 20, including hit point progression (fixed average vs. server-rolled), subclass milestone selections, Ability Score Improvements (`AbilityScore` capped at 20) versus feat selections, and spell slot progression across caster archetypes (`FULL_CASTER`, `HALF_CASTER`, `PACT_MAGIC`).
7. Enforcing server-authoritative dice rolling (`ChaCha20Rng`) without client-side `Math.random()` manipulation for level-up hit points and short rest recovery.
8. Supporting dual-channel actor persistence: CQRS WebSocket commands (`TrameCommand::UpdateActorData`) handled by `TableRoomActor` during live tabletop sessions, alongside HTTP REST mutations (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`) during offline preparation in `CampaignWorkspace`.
9. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
10. Providing an expanded 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) with canonical ASCII identifier slugs, bilingual localization (`i18n?: { en, fr }`), container tare/capacity multipliers (`contentWeightMultiplier`), and CC-BY-4.0 legal attribution.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary and Modular Split**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules:
     - `manifest.ts` and `system.json`: Declarative definitions and layout descriptors.
     - `pipeline.ts`: Pure damage pipeline functions (`resolveDamagePipeline`).
     - `progression.ts`: Character level advancement (`applyLevelUp`), spell slot progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`), and slot reconciliation (`reconcileSlots`).
     - `rest.ts`: Deterministic rest transitions (`applyShortRest`, `applyLongRest`).
     - `compendium.ts`: Static SRD 5.1 entries with bilingual metadata and container specifications.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level Advancement (Lvl 1-20)**:
   - `applyLevelUp(actor, options)` validates target level increment (`targetLevel === actor.system.level + 1`) bounded to level 20 (`1 <= level <= 20`).
   - Calculates hit point gain using fixed mode (`Math.floor(hitDieSize / 2) + 1 + conMod`) or server-rolled mode, bounded by a minimum gain of 1 HP (`Math.max(1, baseGain + conMod)`).
   - Validates mandatory subclass selection at class milestone levels.
   - Validates Ability Score Improvements (`+2` to one score or `+1` to two scores, strictly enforcing `score <= 20`) or feat selection from `SystemSRD`.
   - Reconciles spell slot maximums and currents via `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, or `PACT_MAGIC_SPELL_SLOTS`.
5. **Server-Authoritative Dice Rolling and Dual-Channel Persistence**:
   - Client UI components never invoke `Math.random()`. Hit dice and level-up hit point rolls require server-verified rolls generated via `ChaCha20Rng`.
   - Outside active sessions, clients request rolls via `POST /api/v1/campaigns/{id}/dice/roll` and persist mutations via `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.
   - During active tabletop sessions, clients dispatch CQRS commands (`TrameCommand::RollDice` and `TrameCommand::UpdateActorData`) over WebSocket to `TableRoomActor`, broadcasting state deltas and persisting them to PostgreSQL via `SqlxPostgresStore`.
6. **3-Tier Hierarchical Compendium, Bilingual Localization, and CC-BY-4.0 Attribution**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority cascade.
   - Compendium entries use immutable canonical ASCII slugs (`srd:item:bag_of_holding`, `srd:spell:fireball`) with optional bilingual metadata `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
   - Container entries specify `contentWeightMultiplier: 0` for weightless containers (e.g., Bag of Holding).
   - Exposes mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e progression, combat, and rest rules execute as pure, deterministic functions verified under `node --test`.
- Server-authoritative dice rolling (`ChaCha20Rng`) eliminates client-side RNG tampering.
- Unified actor persistence supports both offline preparation (`CampaignWorkspace`) and live table sessions (`HudDrawers.tsx`).
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Supporting dual persistence channels requires UI modal adapters to handle both REST and WebSocket persistence strategies.
