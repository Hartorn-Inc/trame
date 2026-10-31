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
7. Supporting complete character progression from level 1 to 20: subclass selection at class thresholds, Ability Score Improvement (`+2` or `+1/+1` capped at 20) versus Feat choices, deterministic spell slot progressions (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`), and server-authoritative dice rolls (`ChaCha20Rng`) without client `Math.random()`.
8. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license, supporting bilingual (`en`/`fr`) metadata and extra-dimensional containers with zero content weight multiplier.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `packages/game-systems/dnd5e/src/rest.ts` groups the pure synchronous functions `applyShortRest(actor, options)` and `applyLongRest(actor)`.
   - `applyShortRest` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level-Up Progression (Lvl 1-20) and Server-Authoritative Rolls**:
   - `packages/game-systems/dnd5e/src/progression.ts` implements `applyLevelUp(actor, options)` with strict level-20 cap validation, ability score caps at 20 during ASI, subclass selection enforcement, and canonical spell slot progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
   - Hit point progression rolls and hit dice expenditures invoke the authoritative server `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` (outside active table sessions) or WebSocket `TrameCommand::RollDice` (on active tables). UI components never invoke `Math.random()`.
   - Mutations persist via WebSocket CQRS (`TrameCommand::UpdateActorData`) in live table sessions (`HudDrawers.tsx`) and REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` in asynchronous campaign preparation (`CampaignWorkspace`).
5. **3-Tier Hierarchical Compendium, Bilingual I18n, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use canonical untranslated ASCII slugs (`srd:spell:fireball`), support optional bilingual metadata blocks `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`, and extra-dimensional containers enforce `contentWeightMultiplier: 0`.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Tamper-proof hit point and hit die rolls backed by server-side `ChaCha20Rng`.
- Unified player and GM experience across asynchronous campaign preparation (`CampaignWorkspace`) and live table sessions (`HudDrawers.tsx`).

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Dual persistence channels (REST and CQRS) require maintaining schema consistency across transports.
