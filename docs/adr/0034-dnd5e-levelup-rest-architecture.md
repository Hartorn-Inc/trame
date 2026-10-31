# ADR-0034: D&D 5e Level-Up (Lvl 1-20), Short/Long Rests, and SRD 5.1 Compendium Expansion Architecture

- **Status**: Accepted
- **Date**: 2025-05-20
- **Deciders**: EPURE Architect, TRAME Core Team
- **Branch**: `plan/77-spec-d-d-5e-levelupmodal-lvl-1-20-sh`

## 1. Context
The `@trame/game-system-dnd5e` package initially contained a minimal `applyLevelUp` function in `packages/game-systems/dnd5e/src/progression.ts` without support for subclass selection, Ability Score Improvement (`+2` or `+1/+1`) versus Feat choices, spell learning, or multiclass/Pact Magic slot progression. In addition, no rest mechanics (`ShortRest`, `LongRest`) were defined in the engine, and `@trame/web` lacked UI modals (`LevelUpModal`, `RestModal`) for executing progression or rests from `CampaignWorkspace` or `HudDrawers.tsx`. Finally, the embedded `compendium.ts` only included a small subset of SRD 5.1 items and monsters without bilingual (`en`/`fr`) metadata.

## 2. Decisions

### 2.1 Modular Separation in `@trame/game-system-dnd5e`
- `packages/game-systems/dnd5e/src/rest.ts` groups the pure synchronous functions `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData`.
- `packages/game-systems/dnd5e/src/progression.ts` extends `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` with strict level-20 cap validation, ability score caps at 20 during ASI, and canonical spell slot tables.
- The canonical slot tables `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS` are exported from `packages/game-systems/dnd5e/src/progression.ts`.

### 2.2 Server-Authoritative Dice Rolls
- No UI component uses `Math.random()`.
- Hit point progression rolls and hit dice expenditures during a short rest invoke the authoritative server `ChaCha20Rng` service via REST `POST /api/v1/campaigns/{id}/dice/roll` (outside an active table session) or via CQRS WebSocket `TrameCommand::RollDice` (on an active table).
- Every roll emits an authoritative `TrameEvent` recorded in the public session log before applying the `Actor` mutation.

### 2.3 Dual Persistence Channel (CQRS / REST)
- When triggered from the live table HUD (`HudDrawers.tsx`), the client dispatches `TrameCommand::UpdateActorData` over WebSocket so `TableRoomActor` broadcasts the update and persists it through `SqlxPostgresStore`.
- When triggered from `CampaignWorkspace` outside an active table session, the client sends a REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` request.

### 2.4 Compendium Format and Internationalization
- Compendium entry identifiers retain canonical untranslated ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
- Each entry in `compendium.ts` supports an optional bilingual metadata block `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
- Extra-dimensional containers use `contentWeightMultiplier: 0` so contained items contribute zero weight to the outer carrier.

## 3. Consequences

### 3.1 Positive Consequences
- Strict SRD 5.1 rule integrity enforced by pure, deterministic functions testable without network dependencies.
- Tamper-proof hit point and hit die rolls backed by server-side `ChaCha20Rng`.
- Unified player and GM experience across asynchronous campaign preparation (`CampaignWorkspace`) and live table sessions (`HudDrawers.tsx`).

### 3.2 Negative Consequences and Mitigated Risks
- Maintaining dual persistence channels (REST and CQRS) is mitigated by sharing a single pure state transition model and delegating persistence to an injected environment adapter.