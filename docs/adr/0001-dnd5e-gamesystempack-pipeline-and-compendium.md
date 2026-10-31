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
8. Deterministically governing character progression (levels 1-20), including subclass selection, Ability Score Improvement (ASI) vs. Feat selection, and spell slot progression tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
9. Enforcing server-authoritative dice generation (`ChaCha20Rng`) without client-side `Math.random()` for level-up hit points and short-rest hit dice recovery.
10. Unifying actor mutations across active live sessions (WebSocket CQRS) and campaign preparation in `CampaignWorkspace` (REST via HTTP).

## Decision
1. **Rust/WASM vs. TypeScript Execution Boundary and Modular Breakdown**:
   - `crates/trame-engine` remains 100% agnostic to D&D 5e and provides the generic `derivedDAG` engine and elementary `DamageMitigation` primitive.
   - All D&D 5e domain logic is encapsulated in `packages/game-systems/dnd5e` as pure, strictly typed TypeScript modules: `system.json`, `manifest.ts`, `pipeline.ts`, `progression.ts`, `rest.ts`, and `compendium.ts`.
   - `packages/game-systems/dnd5e/src/rest.ts` isolates pure synchronous functions `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData`.
   - `packages/game-systems/dnd5e/src/progression.ts` implements `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData`, validating maximum character level (20), capping ability scores at 20 during ASI, enforcing subclass tier milestones, and exporting canonical spell slot tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
2. **Deterministic Multi-Type Damage Pipeline**:
   - `resolveDamagePipeline(actor, damageInstances, options)` computes `DamageMitigation` per instance (`IMMUNE` 0x -> `RESISTANT` `Math.floor(amount * 0.5)` -> `VULNERABLE` 2x), deducts from `TempHP` first, applies `InstantDeath` or `DeathSavingThrow` failures at 0 HP, and emits `ConcentrationCheckPrompt` when applicable.
3. **Deterministic Resource Pools and Rests**:
   - `applyShortRest` spends hit dice (`hitDieRoll + conMod`, min 1 HP), resets `SHORT_REST` `ResourcePool` entries, and recharges Pact Magic slots.
   - `applyLongRest` restores full HP, resets `TempHP` to 0, recovers `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, decrements exhaustion by 1, and resets all spell slots and resource pools.
4. **Authoritative Server Dice Rolls (`ChaCha20Rng`)**:
   - Client UI components never execute `Math.random()`.
   - Hit points gain and hit dice rolls during rest execute through the server-authoritative `ChaCha20Rng` service via REST endpoint `POST /api/v1/campaigns/{id}/dice/roll` (outside active session) or WebSocket CQRS command `TrameCommand::RollDice` (on active table).
   - Each roll creates a signed `TrameEvent` appended to the public session timeline before mutating the `Actor`.
5. **Dual Persistence Channel (CQRS / REST)**:
   - When triggered from the table HUD (`HudDrawers.tsx`), the client dispatches CQRS command `TrameCommand::UpdateActorData` over WebSocket. `TableRoomActor` processes the mutation, broadcasts updates to peers, and persists state via `SqlxPostgresStore`.
   - When triggered from `CampaignWorkspace` outside an active session, the client issues HTTP request `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.
6. **3-Tier Hierarchical Compendium, Bilingual i18n, and CC-BY-4.0 License**:
   - `CompendiumResolver` enforces `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` priority and exposes the mandatory Wizards of the Coast LLC SRD 5.1 CC-BY-4.0 attribution notice.
   - Compendium entries use immutable canonical ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Compendium entries support optional bilingual metadata: `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
   - Magic containers use property `contentWeightMultiplier: 0` to nullify content weight.

## Consequences
### Positive
- `crates/trame-engine` remains generic and reusable across tabletop RPG systems.
- All D&D 5e progression and combat rules are pure, deterministic functions verified under `node --test`.
- CC-BY-4.0 legal attribution is built directly into `CompendiumResolver`.
- Server-side `ChaCha20Rng` prevents dice manipulation during level-up and rest workflows.
- Workflow consistency is maintained between live tabletop play (`HudDrawers.tsx`) and offline preparation (`CampaignWorkspace`).

### Negative
- Combat turn evaluation requires explicitly passing `currentTurnActorId` when invoking `decrementConditionDurations`.
- Client must support dual persistence adapters (WebSocket CQRS vs HTTP REST) based on session context.
