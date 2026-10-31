# ADR-0034: D&D 5e Level-Up Progression (Lvl 1-20), Rest Management (Short/Long), and SRD 5.1 Expansion

## Status
Accepted

## Context
The game system `@trame/game-system-dnd5e` contained an embryonic `applyLevelUp` implementation in `packages/game-systems/dnd5e/src/progression.ts`. This implementation did not handle subclass selection, the Ability Score Improvement (ASI: `+2` or `+1/+1`) versus Feat choice, spell acquisition, or pact magic progression. Furthermore, rest routines (`ShortRest`, `LongRest`) required comprehensive regression coverage and state-machine integration. In the web user interface (`@trame/web`), no dialogue was exposed to execute level-up progression or rests from an `Actor` sheet (`CampaignWorkspace` or `HudDrawers.tsx`). Finally, the embedded compendium `compendium.ts` only included a minimal fraction of SRD 5.1 items and monsters and lacked bilingual localization (`en`/`fr`).

## Decision
1. **Modular Rules Architecture in `@trame/game-system-dnd5e`**:
   - The recovery pipeline in `packages/game-systems/dnd5e/src/pipeline.ts` encapsulates pure synchronous rest functions `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData`.
   - `packages/game-systems/dnd5e/src/progression.ts` extends `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` with strict validation of the maximum level (20), capping ability scores at 20 during ASI, and canonical spell slot progression tables.
   - Spell slot progression tables `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS` are exported from `packages/game-systems/dnd5e/src/progression.ts`.
2. **Server-Authoritative Dice Rolling**:
   - Zero UI components use `Math.random()`.
   - Hit point rolls and hit dice expenditures during rests request server-authoritative results based on `ChaCha20Rng` via REST route `POST /api/v1/campaigns/{id}/dice/roll` (outside active table sessions) or WebSocket CQRS command `TrameCommand::RollDice` (during active table sessions).
   - Every roll generates a `TrameEvent` appended to the public session timeline with its authoritative signature before mutating the `Actor`.
3. **Dual Persistence Channels (CQRS / REST)**:
   - When a user triggers level advancement or a rest from the live table HUD (`HudDrawers.tsx`), the client dispatches CQRS command `TrameCommand::UpdateActorData` over WebSocket. `TableRoomActor` processes the command, broadcasts the update to peers, and persists it via `SqlxPostgresStore`.
   - When a user triggers the action from `CampaignWorkspace` outside an active session, the client dispatches REST request `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.
4. **Compendium Format and Internationalization**:
   - Compendium entry identification keys use untranslated universal canonical ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Every entry in `compendium.ts` supports an optional bilingual block `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
   - Magic containers use the property `contentWeightMultiplier: 0` to negate the weight of contained items.

## Consequences
### Positive
- Strict integrity of SRD 5.1 rules guaranteed by pure, unit-testable functions without network dependencies.
- Full traceability and anti-cheat protection for hit dice rolls via server-side `ChaCha20Rng`.
- Unified user experience between out-of-session preparation (`CampaignWorkspace`) and live gameplay (`HudDrawers.tsx`).

### Negative
- Dual persistence channels (REST and CQRS) require UI code to share presentation state while delegating persistence to an injected environment adapter.
