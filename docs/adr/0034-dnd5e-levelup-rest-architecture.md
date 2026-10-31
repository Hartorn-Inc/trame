# ADR-0034: D&D 5e Level Advancement (Lvl 1-20), Rest Architecture, and SRD 5.1 Expansion

## Status
Accepted

## Context
The game system `@trame/game-system-dnd5e` contains an embryonic `applyLevelUp` function in `packages/game-systems/dnd5e/src/progression.ts`. This function does not handle subclass selection, the Ability Score Improvement (ASI: `+2` or `+1/+1`) versus Feats choice, spell learning, or multiclass / Pact Magic progression. Furthermore, the engine defines no rest functions (`ShortRest`, `LongRest`). In the web user interface (`@trame/web`), no dialog executes character level advancement or rest transitions from an `Actor` sheet (`CampaignWorkspace` or `HudDrawers.tsx`). Finally, the embedded compendium `compendium.ts` contains only a minimal subset of SRD 5.1 items and monsters and does not support bilingual localization (`en`/`fr`).

## Decision

1. **Modular Split in `@trame/game-system-dnd5e`**:
   - Encapsulate pure, synchronous rest functions `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData` in `packages/game-systems/dnd5e/src/rest.ts`.
   - Extend `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` in `packages/game-systems/dnd5e/src/progression.ts` with strict validation for maximum level (20), capping ability scores at 20 during ASI, and canonical spell slot progression tables.
   - Export spell slot progression tables `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS` from `packages/game-systems/dnd5e/src/progression.ts`.

2. **Server-Authoritative Dice Rolling**:
   - UI components never invoke `Math.random()`.
   - Hit point and hit die rolls during rests use the server-authoritative service based on `ChaCha20Rng` through the REST route `POST /api/v1/campaigns/{id}/dice/roll` (outside active sessions) or through the CQRS WebSocket command `TrameCommand::RollDice` (on an active table).
   - Each roll emits a `TrameEvent` recorded in the public session log with its authoritative signature before applying mutations to the `Actor`.

3. **Dual Persistence Channel (CQRS / REST)**:
   - When the user triggers level advancement or rests from the live table HUD (`HudDrawers.tsx`), the client dispatches the CQRS command `TrameCommand::UpdateActorData` over WebSocket. `TableRoomActor` processes the command, broadcasts updates to subscribers, and persists state via `SqlxPostgresStore`.
   - When the user triggers the action from `CampaignWorkspace` outside an active session, the client dispatches an HTTP REST request `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.

4. **Compendium Format and Localization**:
   - Compendium entry identifier keys retain universal, untranslated canonical ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Every entry in `compendium.ts` supports an optional bilingual block `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
   - Magic containers use the property `contentWeightMultiplier: 0` to negate the weight of their contained items.

## Consequences

### Positive
- Pure functions guarantee strict SRD 5.1 rule integrity and run unit tests without network dependencies.
- The server-side `ChaCha20Rng` generator guarantees roll auditability and prevents dice tampering.
- The user interface unifies the user experience between offline preparation (`CampaignWorkspace`) and live table sessions (`HudDrawers.tsx`).

### Negative
- UI code must support dual mutation channels (REST and CQRS); UI components share presentation state and delegate persistence to an injected environment adapter.
