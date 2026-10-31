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
8. Supporting deterministic progression from level 1 to 20 (`applyLevelUp`), including subclass selection milestones, Ability Score Improvements (ASI) capped at 20 vs. Feat selection, spell learning, and canonical spell slot progression matrices.
9. Enforcing server-side cryptographic authority (`ChaCha20Rng`) for all hit dice and hit point recovery rolls during level-up and rests.
10. Providing bilingual metadata support (`en`/`fr`) under universal canonical ASCII slugs and container tare cancellation (`contentWeightMultiplier: 0`).

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary and Module Organization**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
   - Rests execute as pure functions in `rest.ts`. All hit dice rolls require certified server-side `ChaCha20Rng` random numbers (`POST /api/v1/campaigns/{id}/dice/roll` or WebSocket `TrameCommand::RollDice`).
4. **Deterministic Level-Up Progression (Levels 1 to 20)**:
   - `applyLevelUp(actor, options)` in `progression.ts` validates level increments up to level 20, enforces subclass selection milestones, validates ASI limits (`+2` or `+1/+1` with each ability score capped at 20) vs. Feat selection, and synchronizes spell slot capacity.
   - The module exports static progression matrices: `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
   - Hit point increases enforce a minimum gain of 1 HP (`Math.max(1, baseGain + conMod)`), using either fixed average or server-certified `ChaCha20Rng` rolls.
5. **3-Tier Hierarchical Compendium, Bilingual Localization, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use universal untranslated ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`) and support optional bilingual metadata (`i18n?: { en: LocalizedDisplayMetadata, fr: LocalizedDisplayMetadata }`).
   - Magic containers declare `contentWeightMultiplier: 0` to negate content weight.
6. **Dual-Channel Actor Persistence (CQRS WebSocket / REST)**:
   - In active tabletop sessions (`HudDrawers.tsx`), modifications dispatch `TrameCommand::UpdateActorData` via WebSocket, processed by `TableRoomActor` and stored in `SqlxPostgresStore`.
   - Out-of-session modifications in `CampaignWorkspace` dispatch REST requests (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`).

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Server-authoritative `ChaCha20Rng` prevents client-side roll manipulation during level-up and rests.
- Progression matrices and rest rules cover the complete level 1 to 20 SRD 5.1 lifecycle.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- UI components must support dual persistence adapters depending on whether the session is live or in workspace view.
