# 32. D&D 5e GameSystemPack Architecture: Multi-Type Damage Pipeline, Deterministic Rests, and 3-Tier Hierarchical Compendium

- **Status**: Accepted
- **Date**: 2025-05-18
- **Authors**: TRAME Team & EPURE Architect
- **Context**: Issue #7 ([E1] Built-in D&D 5e GameSystemPack (SRD 5.1))

## Context and Problem Statement

The TRAME V1 milestone requires a complete, out-of-the-box game system pack for Dungeons & Dragons 5e (SRD 5.1 licensed under Creative Commons CC-BY-4.0).
The core engine `crates/trame-engine` (Rust/WASM) provides the generic mathematical foundations: the declarative `derivedDAG` evaluator, the 5-phase active effects manager, and the single-instance mitigation primitive `resolve_damage_application`.

However, the full combat and progression rules of SRD 5.1 introduce requirements specific to D&D 5e:
1. Computing multiple simultaneous damage instances with distinct damage types (for example, bludgeoning weapon damage + radiant damage).
2. Enforcing a strict absorption sequence: absorption by temporary HP (`hp.temp`) first, followed by current hit points (`hp.current`).
3. Enforcing instant death rules (`InstantDeath`) when excess damage equals or exceeds maximum HP (`hp.max`), and automatically recording death saving throw failures (`DeathSavingThrow`) when an actor at 0 HP takes damage (adding 2 failures on a critical hit).
4. Deterministically emitting a concentration check prompt (`ConcentrationCheckPrompt`) with a Difficulty Class (DC) calculated as `Math.max(10, Math.floor(damageTaken / 2))` whenever an actor maintaining concentration takes damage.
5. Deterministically managing short and long rests, including spending hit dice, resetting resource pools (`ResourcePool`), recovering half of maximum hit dice on a long rest, and handling spell slots according to caster type (standard spellcasting vs. Warlock Pact Magic).
6. Expiring active conditions in strict temporal order across three turn triggers (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
7. Providing a 3-tier hierarchical compendium (`SYSTEM_SRD` read-only base, `INSTANCE_LIBRARY` shared layer, `CAMPAIGN_HOMEBREW` priority override) compliant with the CC-BY-4.0 license.

## Architectural Decision

### 1. Rust/WASM vs. TypeScript Execution Boundary
The Rust crate `crates/trame-engine` remains 100% agnostic to D&D 5e. It provides the generic directed acyclic graph engine and the elementary damage mitigation primitive.
All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules with no external state or UI dependencies:
- `system.json`: system manifest declaring actor types, abilities, skills, and `derivedDAG` calculation formulas.
- `manifest.ts`: TypeScript interfaces, strict identifier types, and the `Dnd5eActorData` actor schema.
- `pipeline.ts`: pure functions `resolveDamagePipeline`, `rollDeathSavingThrow`, `applyShortRest`, `applyLongRest`, and `decrementConditionDurations`.
- `progression.ts`: progression tables and functions for levels 1 through 20 (proficiency bonus, full/half/pact spell slot matrices, and level-up helpers).
- `compendium.ts`: `CompendiumResolver` class implementing hierarchical lookup and the mandatory CC-BY-4.0 legal attribution notice.

### 2. Deterministic Multi-Type Damage Pipeline
The `resolveDamagePipeline(actor, damageInstances, options)` function executes as a pure, side-effect-free synchronous function:
1. Computes mitigation for each instance according to the rule: `IMMUNE` (0x) -> `RESISTANT` (`Math.floor(amount * 0.5)`) -> `VULNERABLE` (2x) -> neutral (1x).
2. Sums effective damage into `totalDamage`.
3. If `actor.attributes.hp.current === 0`:
   - If `totalDamage >= actor.attributes.hp.max`, applies `instantDeath = true` and `failures = 3`.
   - Otherwise, increments `failures` by 2 if `options.isCritical === true`, or by 1 otherwise.
4. If `actor.attributes.hp.current > 0`:
   - Deducts damage from `hp.temp` first.
   - Applies any remainder to `hp.current`.
   - If `hp.current` reaches 0 and unabsorbed excess damage equals or exceeds `hp.max`, triggers `instantDeath = true`.
5. If `actor.concentratingOnSpellId` is defined and effective damage was taken (`totalDamage > 0`), includes a `concentrationPrompt` in the result with `dc = Math.max(10, Math.floor(totalDamage / 2))`.

### 3. Deterministic Modeling of Resource Pools and Rests
The `Dnd5eActorData` type includes the optional field `resources: Record<string, ResourcePool>` where each pool defines `{ current: number; max: number; resetOn: 'SHORT_REST' | 'LONG_REST' }`.
- `applyShortRest` supports interactive spending of hit dice (`hitDieRoll + conMod`, minimum 1 HP regained per die), resets all resources with `resetOn === 'SHORT_REST'`, and recharges Pact Magic spell slots to maximum.
- `applyLongRest` restores all current HP, resets `hp.temp` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, reduces exhaustion level by 1, resets all spell slots, and resets all resources (`resetOn === 'SHORT_REST'` or `resetOn === 'LONG_REST'`).

### 4. Temporal Condition Decrementation
The pure function `decrementConditionDurations(conditions, trigger, currentTurnActorId)` enforces turn-scoping rules:
- When `trigger` is `'TURNS_START'` or `'TURNS_END'`, a condition's `durationRounds` decrements by 1 **only if** `condition.appliedTurnActorId === currentTurnActorId`.
- When `trigger` is `'ROUNDS'`, all conditions with `durationRounds > 0` and `trigger === 'ROUNDS'` decrement by 1, regardless of the active actor.
- Any condition reaching `durationRounds <= 0` is removed from the active conditions array.

### 5. 3-Tier Hierarchical Compendium and CC-BY-4.0 License
The `CompendiumResolver` class guarantees the immutability of the base SRD:
- The priority cascade enforces: `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`.
- Entry deduplication is keyed on the `slug` field.
- Text search in `list(query)` performs case-insensitive filtering on `entry.name` and `entry.slug`.
- The `getAttribution()` method returns the mandatory legal license notice from Wizards of the Coast LLC for SRD 5.1 under CC-BY-4.0.

### 6. Testing Strategy
All unit and integration tests for the package are written for the native Node 24 test runner (`node --test`), executable via `npm test` in `packages/web` with no dependency on a running server or graphical interface.

## Consequences

### Positive
- **Strict Separation**: The Rust engine `trame-engine` remains generic and independent of any specific game system's rules.
- **Determinism**: All D&D 5e rules are pure, side-effect-free functions that are straightforward to audit and test under `node --test`.
- **Legal Compliance**: Creative Commons CC-BY-4.0 attribution is built directly into the compendium and verified by automated tests.
- **Homebrew Extensibility**: Campaign creators can override any entity without risking alteration to the official SRD baseline.

### Negative / Constraints
- Strict typing requires exhaustive structure definitions across all skills (`SkillId`), abilities (`AbilityId`), and proficiency ranks (`ProficiencyRank`).
- Combat turn evaluation requires explicitly passing the active turn actor identifier (`currentTurnActorId`) when invoking `decrementConditionDurations`.
