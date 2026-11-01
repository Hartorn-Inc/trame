# ADR-0036: D&D 5e Level-Up (Lvl 1-20), Short/Long Rests, and SRD 5.1 Compendium Expansion Architecture

## Status
Accepted

## Context
The `@trame/game-system-dnd5e` package initially established the core D&D 5e pipeline and rest principles in ADR-0001 (`docs/adr/0001-dnd5e-gamesystempack-pipeline-and-compendium.md`). However, `packages/game-systems/dnd5e/src/progression.ts` only provided a stub `applyLevelUp` function without support for subclass selection, Ability Score Improvement (`+2` or `+1/+1`) versus Feat choices, spell learning, or full caster/half caster/Pact Magic slot progression. Furthermore, rest mechanics (`ShortRest`, `LongRest`) required dedicated modular extraction into `rest.ts`, and `@trame/web` lacked interactive UI modals (`LevelUpModal`, `RestModal`) in `CampaignWorkspace` and `HudDrawers.tsx` (ADR-0006). Finally, the compendium required expansion beyond initial items (ADR-0007) with bilingual (`en`/`fr`) metadata and extra-dimensional containers.

## Decision
1. **Modular Separation in `@trame/game-system-dnd5e`**:
   - `packages/game-systems/dnd5e/src/rest.ts` groups the pure synchronous functions `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData`.
   - `packages/game-systems/dnd5e/src/progression.ts` extends `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` with strict level-20 cap validation, ability score caps at 20 during ASI, and canonical spell slot tables.
   - The canonical slot tables `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS` are exported from `packages/game-systems/dnd5e/src/progression.ts`.
2. **Server-Authoritative Dice Rolls**:
   - No UI component uses `Math.random()`.
   - Hit point progression rolls and hit dice expenditures during a short rest invoke the authoritative server `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` (outside an active table session) or via CQRS WebSocket `TrameCommand::RollDice` (on an active table).
   - Every roll emits an authoritative `TrameEvent` recorded in the public session log before applying the `Actor` mutation.
3. **Dual Persistence Channel (CQRS / REST)**:
   - When triggered from the live table HUD (`HudDrawers.tsx`), the client dispatches `TrameCommand::UpdateActorData` over WebSocket so `TableRoomActor` broadcasts the update and persists it through `SqlxPostgresStore` (ADR-0010).
   - When triggered from `CampaignWorkspace` outside an active table session, the client sends a REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` request.
4. **Compendium Format and Internationalization**:
   - Compendium entry identifiers retain canonical untranslated ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
   - Each entry in `compendium.ts` supports an optional bilingual metadata block `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
   - Extra-dimensional containers use `contentWeightMultiplier: 0` so contained items contribute zero weight to the outer carrier (ADR-0007).

## Consequences
### Positive
- Strict SRD 5.1 rule integrity enforced by pure, deterministic functions testable without network dependencies.
- Tamper-proof hit point and hit die rolls backed by server-side `ChaCha20Rng`.
- Unified player and GM experience across asynchronous campaign preparation (`CampaignWorkspace`) and live table sessions (`HudDrawers.tsx`).

### Negative
- Maintaining dual persistence channels (REST and CQRS) is mitigated by sharing a single pure state transition model and delegating persistence to an injected environment adapter.
