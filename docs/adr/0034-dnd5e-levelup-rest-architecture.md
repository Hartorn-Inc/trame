# ADR-0034: D&D 5e Level Advancement (Lvl 1-20), Rest Architecture, and SRD 5.1 Compendium Expansion Architecture

- **Status**: Accepted
- **Date**: 2025-05-20
- **Deciders**: EPURE Architect, TRAME Core Team
- **Branch**: plan/77-spec-d-d-5e-levelupmodal-lvl-1-20-sh

## 1. Context
The `@trame/game-system-dnd5e` package initially contained an embryonic `applyLevelUp` function in `packages/game-systems/dnd5e/src/progression.ts`. This function did not support subclass selection, Ability Score Improvement (ASI: `+2` or `+1/+1`) versus Feats choice, spell learning, or multiclass / Pact Magic slot progression. Furthermore, the engine defined no rest mechanics (`ShortRest`, `LongRest`). In the web user interface (`@trame/web`), no dialog or modal (`LevelUpModal`, `RestModal`) executed character level advancement or rest transitions from an `Actor` sheet (`CampaignWorkspace` or `HudDrawers.tsx`). Finally, the embedded compendium `compendium.ts` contained only a minimal subset of SRD 5.1 items and monsters and lacked bilingual (`en`/`fr`) localization metadata.

## 2. Decisions

### 2.1 Modular Separation in `@trame/game-system-dnd5e`
- Encapsulate pure, synchronous rest functions `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` and `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData` in `packages/game-systems/dnd5e/src/rest.ts`.
- Extend `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` in `packages/game-systems/dnd5e/src/progression.ts` with strict validation for maximum level (20), capping ability scores at 20 during ASI, and canonical spell slot progression tables.
- Export canonical spell slot progression tables `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS`, and `PACT_MAGIC_SPELL_SLOTS` from `packages/game-systems/dnd5e/src/progression.ts`.

### 2.2 Server-Authoritative Dice Rolls
- UI components never invoke `Math.random()`.
- Hit point progression rolls and hit dice expenditures during rests invoke the server-authoritative `ChaCha20Rng` service via REST route `POST /api/v1/campaigns/{id}/dice/roll` (outside an active table session) or via CQRS WebSocket command `TrameCommand::RollDice` (on an active table).
- Every roll emits an authoritative `TrameEvent` recorded in the public session log with its authoritative signature before applying mutations to the `Actor`.

### 2.3 Dual Persistence Channel (CQRS / REST)
- When the user triggers level advancement or rests from the live table HUD (`HudDrawers.tsx`), the client dispatches the CQRS command `TrameCommand::UpdateActorData` over WebSocket. `TableRoomActor` processes the command, broadcasts updates to subscribers, and persists state via `SqlxPostgresStore`.
- When the user triggers the action from `CampaignWorkspace` outside an active table session, the client dispatches an HTTP REST request `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.

### 2.4 Compendium Format and Internationalization
- Compendium entry identifier keys retain universal, untranslated canonical ASCII slugs (`srd:spell:fireball`, `srd:item:bag_of_holding`).
- Every entry in `compendium.ts` supports an optional bilingual metadata block `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
- Extra-dimensional and magic containers use the property `contentWeightMultiplier: 0` so contained items contribute zero weight to the outer carrier.

## 3. Consequences

### 3.1 Positive Consequences
- Pure, deterministic functions enforce strict SRD 5.1 rule integrity and execute unit tests without network dependencies.
- The server-side `ChaCha20Rng` generator guarantees roll auditability and tamper-proof hit point / hit die rolls.
- The architecture unifies the player and GM user experience between offline campaign preparation (`CampaignWorkspace`) and live table sessions (`HudDrawers.tsx`).

### 3.2 Negative Consequences and Mitigated Risks
- UI code must support dual mutation channels (REST and CQRS); UI components share presentation state and delegate persistence to an injected environment adapter.