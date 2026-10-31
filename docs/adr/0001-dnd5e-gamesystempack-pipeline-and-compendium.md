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
8. Enforcing deterministic character progression from level 1 to 20 (`applyLevelUp`), including subclass selection at canonical milestones, Ability Score Improvements (ASI) capped at 20 versus feat selection, and spell slot progression across full, half, and pact casters.
9. Guaranteeing cryptographic randomness without client manipulation via server-authoritative `ChaCha20Rng` for all hit point and hit dice rolls.
10. Providing optional bilingual metadata (`en`/`fr`) for compendium entries while maintaining universal ASCII slugs and weight multiplier invariants.

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - Isolated in `packages/game-systems/dnd5e/src/rest.ts`, `applyShortRest(actor, options)` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest(actor)` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Deterministic Level Progression (Levels 1-20)**:
   - Encapsulated in `packages/game-systems/dnd5e/src/progression.ts`, `applyLevelUp(actor, options)` enforces maximum character level 20, validates subclass selection at class-specific milestones, validates Ability Score Improvements (ASI) with a strict ceiling of 20 per ability score versus feat selection from `SystemSRD`, and updates spell slot reserves via `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS`.
5. **Server-Authoritative Dice Authority and Dual-Channel Persistence**:
   - Client UI components never invoke `Math.random()`. Hit dice and HP progression rolls query the server-authoritative `ChaCha20Rng` engine via REST `POST /api/v1/campaigns/{id}/dice/roll` (outside active session) or WebSocket CQRS `TrameCommand::RollDice` (on active table), recording signed `TrameEvent` audit entries on the session timeline.
   - Rest and level-up mutations persist via WebSocket CQRS `TrameCommand::UpdateActorData` (`TableRoomActor` -> `SqlxPostgresStore`) during live table sessions (`HudDrawers.tsx`), or via REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` in `CampaignWorkspace`.
6. **3-Tier Hierarchical Compendium, Bilingual i18n, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries maintain universal ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`) with optional bilingual metadata `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
   - Magic containers enforce `contentWeightMultiplier: 0` to neutralize contained item weight.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Cryptographic `ChaCha20Rng` server-authoritative dice rolling eliminates client-side dice roll manipulation.
- Internationalized display metadata integrates cleanly without breaking canonical ASCII reference slugs.

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Dual persistence channels require UI adapters to handle both WebSocket CQRS commands and REST API requests.
