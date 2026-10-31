# ADR-0001: D&D 5e GameSystemPack Architecture, Multi-Type Damage Pipeline, Deterministic Rests, and 3-Tier Compendium

## Status
Accepted

## Context
The TRAME V1 milestone requires a complete game system pack for Dungeons & Dragons 5e (SRD 5.1 licensed under Creative Commons CC-BY-4.0).
The core engine `crates/trame-engine` (Rust/WASM) provides the generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase `ActiveEffect` manager, and the single-instance mitigation primitive `resolve_damage_application`.

However, the combat and progression rules of SRD 5.1 introduce requirements specific to D&D 5e:
1. Computing multiple simultaneous damage instances with distinct `DamageType` categories.
2. Enforcing a strict absorption sequence: absorption by `TempHP` (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing `InstantDeath` rules when excess damage equals or exceeds maximum hit points (`hp.max`), and automatically recording `DeathSavingThrow` failures when an actor at 0 HP takes damage.
4. Deterministically emitting a `ConcentrationCheckPrompt` with a Difficulty Class calculated as `Math.max(10, Math.floor(damageTaken / 2))` whenever an actor maintaining concentration takes damage.
5. Deterministically managing `ShortRest` and `LongRest`, including spending hit dice, resetting `ResourcePool` counters, recovering half of maximum hit dice on a long rest, and handling spell slots according to caster type (standard spellcasting vs. Warlock Pact Magic).
6. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
7. Supporting character level progression (levels 1-20), including subclass selection milestones, Ability Score Improvement (ASI) caps (maximum 20) versus Feat choices, and canonical spell slot progression tables.
8. Enforcing server-authoritative dice rolls via `ChaCha20Rng` across REST and WebSocket CQRS channels, prohibiting client-side `Math.random()`.
9. Supporting dual persistence channels: real-time WebSocket CQRS handled by `TableRoomActor` and `SqlxPostgresStore` during active table sessions, and REST persistence during asynchronous preparation in `CampaignWorkspace`.
10. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license, supporting bilingual (`en`/`fr`) metadata and extra-dimensional containers.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - `packages/game-systems/dnd5e` encapsulates all D&D 5e domain logic as pure TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x).
   - The pipeline deducts damage from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `packages/game-systems/dnd5e/src/rest.ts` groups `applyShortRest(actor, options)` and `applyLongRest(actor)`.
   - `applyShortRest` spends hit dice (`hitDieRoll + conMod`, minimum 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level-Up Progression (Levels 1-20)**:
   - `packages/game-systems/dnd5e/src/progression.ts` implements `applyLevelUp(actor, options)`.
   - `applyLevelUp` validates level increments (`targetLevel === currentLevel + 1`), enforces the level 20 cap, applies fixed or server-rolled HP with a 1 HP minimum gain floor, enforces mandatory subclass selection at class milestones, validates ASI score caps (maximum 20) or feat acquisition from `SystemSRD`, and reconciles spell slots.
   - `progression.ts` exports canonical spell slot tables: `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
5. **Server-Authoritative Rolls and Dual Persistence Channels**:
   - Hit point progression rolls and hit dice expenditures invoke server `ChaCha20Rng` evaluation via REST `POST /api/v1/campaigns/{id}/dice/roll` or WebSocket `TrameCommand::RollDice`. No client UI component calls `Math.random()`.
   - In active table sessions (`HudDrawers.tsx`), client components dispatch `TrameCommand::UpdateActorData` over WebSocket so `TableRoomActor` broadcasts updates and persists records through `SqlxPostgresStore`.
   - In asynchronous campaign preparation (`CampaignWorkspace`), client components dispatch REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` requests.
6. **3-Tier Hierarchical Compendium, Bilingual Metadata, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entry identifiers retain canonical untranslated ASCII slugs (such as `srd:spell:fireball` and `srd:item:bag_of_holding`).
   - Compendium entries support optional bilingual metadata (`i18n?: { en: LocalizedDisplayMetadata, fr: LocalizedDisplayMetadata }`).
   - Extra-dimensional containers declare `contentWeightMultiplier: 0` so child items contribute zero weight to the outer container.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules execute as pure, deterministic functions verified under `node --test`.
- Server-authoritative `ChaCha20Rng` guarantees tamper-proof level-up and rest dice rolls.
- Players and Game Masters experience identical progression behavior across `CampaignWorkspace` and `HudDrawers.tsx`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Supporting dual persistence channels requires injecting persistence adapters into client UI components.
