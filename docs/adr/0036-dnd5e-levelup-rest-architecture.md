# ADR-0036: D&D 5e Level-Up (Lvl 1-20), Short/Long Rests, and SRD 5.1 Compendium Expansion Architecture

## Status
Accepted

## Context
The `@trame/game-system-dnd5e` package initially contained a minimal `applyLevelUp` function in `packages/game-systems/dnd5e/src/progression.ts` without support for subclass selection, Ability Score Improvement (`+2` or `+1/+1`) versus Feat choices, spell learning, or multiclass/Pact Magic slot progression.
While ADR-0001 defined the deterministic rest recovery formulas (`applyShortRest`, `applyLongRest`) in pure TypeScript, `@trame/web` lacked interactive UI modals (`LevelUpModal`, `RestModal`) for executing progression or rests from `CampaignWorkspace` or `HudDrawers.tsx`. Furthermore, rest and level-up hit die rolls required server-authoritative randomness to prevent client-side manipulation. Finally, the embedded `compendium.ts` only included a small subset of SRD 5.1 items and monsters without bilingual (`en`/`fr`) metadata.

## Decision
1. **Modular Separation in `@trame/game-system-dnd5e`**:
   - `packages/game-systems/dnd5e/src/rest.ts` groups the pure synchronous functions `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData` in accordance with ADR-0001.
   - `packages/game-systems/dnd5e/src/progression.ts` extends `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` with strict level-20 cap validation, ability score caps at 20 during ASI, and canonical spell slot tables (`FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, `PACT_MAGIC_SPELL_SLOTS`).
2. **Server-Authoritative Dice Rolls (`ChaCha20Rng`)**:
   - UI components never invoke `Math.random()`.
   - Hit point progression rolls and hit dice expenditures during a short rest invoke the authoritative server `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` (outside active table sessions) or via CQRS WebSocket `TrameCommand::RollDice` (on an active table).
   - Every roll emits an authoritative `TrameEvent` recorded in the public session log before applying the `Actor` mutation.
3. **Dual Persistence Channel (CQRS / REST)**:
   - When triggered from the live table HUD (`HudDrawers.tsx`), the client dispatches `TrameCommand::UpdateActorData` over WebSocket so `TableRoomActor` broadcasts the update and persists state through `SqlxPostgresStore` (ADR-0010).
   - When triggered from `CampaignWorkspace` outside an active table session, the client sends a REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` request.
4. **Compendium Format and Internationalization**:
   - Compendium entry identifiers retain canonical untranslated ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Each entry in `compendium.ts` supports an optional bilingual metadata block `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
   - Extra-dimensional containers enforce `contentWeightMultiplier: 0` in accordance with ADR-0007 tare weight rules.

## Consequences
### Positive
- Strict SRD 5.1 rule integrity enforced by pure, deterministic functions testable without network dependencies.
- Tamper-proof hit point and hit die rolls backed by server-side `ChaCha20Rng`.
- Unified player and GM experience across asynchronous campaign preparation (`CampaignWorkspace`) and live table sessions (`HudDrawers.tsx`).

### Negative
- Maintaining dual persistence channels (REST and CQRS) requires a shared state transition model with injected environment adapters.
