# ADR-0001: D&D 5e GameSystemPack Architecture, Multi-Type Damage Pipeline, Deterministic Rests, and 3-Tier Compendium

## Status
Accepted, amended. Decision 1 is refined by the amendment at the end of this ADR (single WASM formula evaluator). The rules baseline moved from SRD 5.1 to SRD 5.2.1 with [ADR-0038](./0038-srd-521-rules-baseline.md). Decision 6 is superseded by ADR-0037: `Actor` sheet changes always use REST `PUT` with `expected_version`, never WebSocket `UpdateActorData`.

## Context
The TRAME V1 milestone requires a complete, out-of-the-box game system pack for Dungeons & Dragons 5e (SRD 5.2.1, the 2024 rules, licensed under Creative Commons CC-BY-4.0; see ADR-0038).
The core engine `crates/trame-engine` (Rust/WASM) provides the generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase `ActiveEffect` manager, and the single-instance mitigation primitive `resolve_damage_application`.

However, the full combat and progression rules of SRD 5.2.1 introduce requirements specific to D&D 5e:
1. Computing multiple simultaneous damage instances with distinct `DamageType` categories (for example, bludgeoning weapon damage + radiant damage).
2. Enforcing a strict absorption sequence: absorption by `TempHP` (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing `InstantDeath` rules when excess damage equals or exceeds maximum HP (`hp.max`), and automatically recording `DeathSavingThrow` failures when an actor at 0 HP takes damage (adding 2 failures on a critical hit).
4. Deterministically emitting a `ConcentrationCheckPrompt` with a Difficulty Class (DC) calculated as `Math.max(10, Math.floor(damageTaken / 2))` whenever an actor maintaining concentration takes damage.
5. Deterministically managing `ShortRest` and `LongRest`, including spending hit dice, resetting `ResourcePool` counters, recovering half of maximum hit dice on a long rest, and handling spell slots according to caster type (standard spellcasting vs. Warlock Pact Magic).
6. Expiring active `Condition` entries in strict temporal order across three `TurnTrigger` checkpoints (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
7. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license.
8. Deterministically evaluating character level-up progression (levels 1 to 20), including subclass selection tiers, Ability Score Improvement (ASI) versus Feat choices, spell slot tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`), and server-authoritative `ChaCha20Rng` dice rolls for HP progression and short rest hit dice recovery.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `packages/game-systems/dnd5e/src/rest.ts` isolates pure synchronous rest functions.
   - `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
   - Hit dice expenditures during short rests invoke the server-authoritative `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` or WebSocket `TrameCommand::RollDice` without client-side `Math.random()`.
4. **Deterministic Progression and Level-Up Engine (Levels 1 to 20)**:
   - `packages/game-systems/dnd5e/src/progression.ts` implements `applyLevelUp(actor, options)` enforcing strict level-20 cap validation, subclass selection at level 3 for every class (ADR-0038), ability score caps at 20 during ASI (+2 to one ability or +1 to two distinct abilities), and feat acquisition.
   - HP progression supports fixed average (`Math.floor(hitDieSize / 2) + 1 + conMod`) or server-authoritative `ChaCha20Rng` rolled HP (`Math.max(1, rolledHp + conMod)`).
   - Exports canonical spell slot progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`) and reconciles slot maximums and current values via `reconcileSlots`.
5. **3-Tier Hierarchical Compendium and CC-BY-4.0 License**:
   - Compendium entries use canonical untranslated ASCII slugs (for example, `srd:spell:fireball`, `srd:item:bag_of_holding`) and support bilingual metadata (`i18n?: { en: { name, description }, fr: { name, description } }`).
   - Extra-dimensional containers enforce `contentWeightMultiplier: 0` so nested items contribute zero weight to the carrier tare weight.
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.2.1 CC-BY-4.0 attribution notice (`SRD_521_ATTRIBUTION`), which also credits SRD 5.1 for the few entries that fill SRD 5.2.1 gaps.
6. **Dual Persistence Channel and Authority Boundary**:
   - When triggered from `CampaignWorkspace` outside an active table session, the client persists actor mutations via REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.
   - When triggered from the live table HUD (`HudDrawers.tsx`), the client dispatches WebSocket `TrameCommand::UpdateActorData` to `TableRoomActor`, which broadcasts updates to connected peers and persists state through `SqlxPostgresStore`.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- Tamper-proof HP rolls and hit die expenditures backed by server-authoritative `ChaCha20Rng`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Unified actor mutation pathways across asynchronous preparation and live table play.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Level-up and rest UI modals require injecting an environment-specific `DiceRollService` adapter.

## Amendment: single formula evaluator (2026-11-01)
The browser used to compute derived stats twice: `computeDnd5eSheetDerived` in TypeScript and `evaluate_derived_dag` in Rust on the server, and the two drifted (unarmored defense, exhaustion on spell DC).

- `evaluate_derived_dag` compiled to WASM is the only evaluator of `system.json` formulas, in the browser and on the server.
- `computeDnd5eSheetDerived` keeps its public signature but delegates formula evaluation to the WASM engine through `setDerivedDagEvaluator`: the browser installs the `wasmBridge.ts` export before the first render, Node consumers import `src/node.ts`. There is no TypeScript fallback; evaluating before an evaluator is installed throws.
- D&D 5e rules that are pure formulas (armor vs. unarmored defense, Dexterity caps) live in `system.json` and use the exclusive base phase ("best wins").
- `packages/game-systems/dnd5e` keeps the D&D procedures that are not formulas: level-up, rests, the damage pipeline orchestration, and the character builder.
- Trade-off: the game-systems tests need the WASM build, in exchange for one source of truth and no client/server drift.
