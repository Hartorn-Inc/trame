# Specification: End-to-End Playable D&D 5e Campaign Convergence & Reviewer Must-Fixes

- **Identifier**: `spec-playable-dnd5e-campaign-convergence`
- **Status**: Ready for Agent (`ready-for-agent`)
- **Related ADRs**: `ADR-0001`, `ADR-0004`, `ADR-0010`, `ADR-0011`, `ADR-0034`, `ADR-0035`, `ADR-0036`, `ADR-0037`

---

## Problem Statement

A gaming group attempting to run a complete D&D 5e (`GameSystemPack` SRD 5.1) campaign on TRAME today is blocked by a split-brain divergence in the repository alongside critical integration and rule-coverage gaps identified across 13 specialist reviews:

1. **Unmerged Persistence & Transport Layer (`Epic E7 / #71`)**: On `dev`, the server runs exclusively against ephemeral in-memory storage (`InMemoryWalStorage`, `InMemoryAssetStore`), omits HTTP CRUD routes for `Campaign`, `Actor`, and `Note` entities, and mounts only `DocumentsWorkspaceTab` in the browser root (`App.tsx`). Meanwhile, the branch containing `SqlxPostgresStore`, the HTTP/WebSocket transport client, `CampaignLobby`, and `TableCanvas` (`origin/feature/71-e7-end-to-end-playable-trame-v1-sqlx`) branched before Specs `#77`, `#78`, `#79`, `#80`, and `#98` landed on `dev` and overwrites them if merged naively.
2. **Broken Live Gameplay Seams**: Even when combining the branches, players invited via Magic Link hit an authentication wall before token redemption (`GuestSessionUpgrade`); refreshing the browser (`F5`) drops the active session; clicking a token on the battlemap does not bind the character sheet drawer to that `Actor`; switching to `Turn-by-Turn Mode` initializes an empty `CombatTracker`; tokens can walk through closed doors and solid walls; and `LevelUpModal`/`RestModal` lack a wired server-authoritative `ChaCha20Rng` dice service.
3. **Incomplete SRD 5.1 Progression Catalog (`SystemSRD`)**: The bundled `SystemSRD` compendium contains only 45 starter entries (0 base classes, 0 species/ancestries, 0 backgrounds, 0 spells for levels 6-9, and 0 monsters between CR 3 and CR 16), preventing character creation and blocking high-level spellcasters during level-up from levels 11 to 20.
4. **Security, Protocol, Design & Accessibility Must-Fixes**: Unauthenticated query parameters on WebSocket upgrades (`?user_id=&role=gm`) and REST endpoints (`?fallback_user_id=`) allow role spoofing; three overlapping invite-minting routes exist and `POST /api/v1/auth/invites` lacks `GameMaster` authorization; player edits on `PARTY` notes risk overwriting confidential `:::dm` `DirectiveBlock` segments unless routed through `LineAnchorNoteMerge`; `ClientEnvelope::Ping` resets the 15-minute `Idle-Lease`; `/api/v1/mcp` and `McpStagingProposal` are unmounted; and light-mode `CanvasThemePalette` wall/turn strokes fall below WCAG 2.2 AA 3.0:1 non-text contrast.

---

## Solution

Converge the E7 persistence, HTTP/WebSocket transport, and live tabletop components from `origin/feature/71-e7-end-to-end-playable-trame-v1-sqlx` onto `dev` while preserving all five post-divergence specifications (`#77`, `#78`, `#79`, `#80`, `#98`) and resolving every P0/P1/P2 Must-Fix from the 13 EPURE reviewers:

1. **Authoritative Backend & Storage Convergence**: Wire `SqlxPostgresStore` (PostgreSQL 18 migrations, `block_in_place` execution) and full REST/WebSocket routes into `trame-server` on `dev`, preserving `ActivateScene` (`ADR-0034`), `LineAnchorNoteMerge` (`ADR-0004`), and optimistic-concurrency `Actor` persistence (`ADR-0037`).
2. **Zero-Trust Security & Protocol Hardening**: Authenticate all HTTP and WebSocket upgrades strictly via `trame_session` cookies or `trame_pat_` tokens, enforce `GameMaster` RBAC on invite minting, verify TOTP MFA on password login, validate UVTT image dimensions prior to raster allocation, and ignore `Ping` frames in `Idle-Lease` tracking.
3. **5-Tab `CampaignWorkspace` + Slide-Over `HudDrawers`**: Unify the frontend shell (`AuthScreen` with `GuestSessionUpgrade` -> `CampaignLobby` -> 5-tab `CampaignWorkspace` housing `Table`, `Maps`, `Actors`, `Documents`, and `Compendium`, plus slide-over `HudDrawers` on the `Table` tab and all 5 tabs on `MobileCompanionView`).
4. **End-to-End D&D 5e Session Loop & Curated ~160-Entry `SystemSRD`**: Enforce `WallSegment` movement collision in `MoveToken`, normalize `system.json` `derivedDAG` formulas, execute server-side `AuthoritativeInitiativeRoll` when entering `Turn-by-Turn Mode`, wire token-to-sheet selection and HP damage/healing sync, mount `/api/v1/mcp` with `McpStagingProposal`, and expand `SystemSRD` to ~160 bilingual EN/FR entries spanning levels 1-20.

---

## User Stories

1. As a `GameMaster`, I want to register an account or log in with email, password, and optional TOTP MFA, so that my campaigns, maps, actors, and notes persist durably in `SqlxPostgresStore` across server restarts.
2. As a `GameMaster` or `Player`, I want refreshing the browser (`F5`) to restore my authenticated session automatically via `/api/v1/auth/me`, so that I am not logged out mid-session.
3. As a `GameMaster`, I want to create a new D&D 5e `Campaign` in `CampaignLobby`, generate a signed Magic Link invite URL, and export or import portable `.trame` Archives, so that I can onboard my group and back up or migrate our campaign in 1 click.
4. As an invited `Player`, I want clicking a Magic Link invite URL (`?invite=<jwt>`) to perform a 1-click `GuestSessionUpgrade` that logs me directly into the target `CampaignWorkspace` with an optional non-blocking banner to bind permanent credentials later, so that I can join the table in under 5 seconds without a signup wall.
5. As a `GameMaster` or `Player`, I want `CampaignWorkspace` to provide 5 top-level workspace tabs (`Table`, `Maps`, `Actors`, `Documents`, `Compendium`) while keeping slide-over `HudDrawers` (`Actor` sheet, `CompendiumDrawer`, Dice/Chat, `UndoDrawer`) accessible directly over `TableCanvas`, so that I can both prepare campaign content in full-screen views and play on the battlemap without losing visual context.
6. As a `Player`, I want to create a level-1 D&D 5e character through `CharacterBuilderWizard` by choosing from all 9 SRD species/ancestries, 12 SRD classes, 6 SRD backgrounds, ability score assignments, and starting equipment, so that my `Actor` is initialized with valid `Dnd5eActorData` attributes (`hp`, `hitDiceCurrent`, `hitDiceMax`, `spellSlots`, `proficiencies`, `deathSaves`) ready for live play.
7. As a `GameMaster`, I want to import a `.uvtt`/`.dd2vtt` battlemap or author a scene in `MapsStudioTab` (adding 2.5D `WallSegment` barriers, doors, windows, `LightSource` emitters, `SpatialAudioManager` emitters, hero spawn points, and `StagedToken` ambush monsters), so that I can prepare encounters without disturbing the active table.
8. As a `GameMaster`, I want to click `[ Activate Scene on Table ]` in `MapsStudioTab` to dispatch `ActivateScene`, so that `TableRoomActor` atomically loads the scene's geometry and `StagedToken` entities while preserving all active `HeroToken` instances and repositioning them onto the scene's spawn points.
9. As a `Player`, I want to open `SceneAtlas` in the `Maps` tab to browse previously discovered scenes and explored `FogLayer` snapshots with all `SecretDoor` segments, traps, and `GM_HIDDEN` tokens stripped on the server, so that I can review world geography without spoilers.
10. As a `Player` or `GameMaster`, I want to click any token on `TableCanvas` or in `CombatTracker` to select its linked `Actor` (`selectedActorIdSignal`) and inspect or edit its 12-widget `DeclarativeSheetView` (respecting `PadlockEditMode` and `VisibilityTier` RBAC), so that the sheet drawer always reflects the selected creature rather than a static default.
11. As a `Player` or `GameMaster`, I want edits made on an `Actor` sheet (`DeclarativeSheetView`, `LevelUpModal`, `RestModal`, or `CompendiumDrawer` drag-and-drop) to persist via optimistic-concurrency `PUT /api/v1/campaigns/{id}/actors/{actor_id}` (`expected_version`) and broadcast `ServerEnvelope::ActorUpdated` to synchronize linked `TokenState` HP, AC, and speed on the live canvas without polluting the GM's 50-action tactical `UndoEntry` stack.
12. As a `Player`, I want to drag my `HeroToken` across `TableCanvas` with real-time 2.5D `BVH` line-of-sight, dynamic lighting, and `WallSegment` collision enforcement, so that my token cannot pass through solid walls or closed doors unless the `GameMaster` enables override mode.
13. As a `GameMaster`, I want switching `TableMode` from `Exploration Mode` to `Turn-by-Turn Mode` via `GmOverrideToolbar` to trigger an `AuthoritativeInitiativeRoll` (`1d20 + dex_mod` via server `ChaCha20Rng`) for all active combatants on the table and populate `CombatTracker` in descending order, so that combat starts in 1 click without an empty turn carousel.
14. As a `Player` or `GameMaster`, I want to apply damage or healing to a token from `TableCanvas` or `CombatTracker` via `ApplyDamage` and `HealActor`, automatically resolving `DamageMitigation` (`IMMUNE`, `RESISTANT`, `VULNERABLE`), `TempHP` absorption, `InstantDeath`, `DeathSavingThrow` counters at 0 HP, and `ConcentrationCheckPrompt` (`DC = max(10, floor(damage / 2))`), while recording a single `UndoEntry` for `Cmd+Z`.
15. As a `Player`, I want `ReactionBanner` to appear when an enemy exits my token's `ThreatReach` (or triggers a reaction window) and allow me to click `[ Use Reaction ]` or `[ Pass ]` (`TrameCommand::DecideReaction`), so that opportunity attacks and tactical reactions resolve deterministically within the turn timer.
16. As a `Player` or `GameMaster`, I want to trigger a `ShortRest` or `LongRest` from `CharacterSheetHeader` (`RestModal`), rolling spent Hit Dice via server-authoritative `ChaCha20Rng` (`ClientEnvelope::RollDice` / `POST /api/v1/campaigns/{id}/dice/roll`), recovering `SHORT_REST` / `LONG_REST` `ResourcePool` counters, Pact Magic / spell slots, and reducing exhaustion by 1 on a `LongRest`, so that party recovery follows SRD 5.1 rules.
17. As a `Player`, I want to level up my `Actor` from level 1 through level 20 using the 4-step `LevelUpModal` (class feature grants, subclass selection at levels 1/2/3, fixed average or server-rolled HP gain with `Tough` feat support, ASI `+2`/`+1/+1` or Feat selection, and Full/Half/Third/Pact spell slot progression with access to SRD spells across levels 0-9), so that we can play a full multi-tier campaign up to level 20.
18. As a `GameMaster` or `Player`, I want to author and edit `PRIVATE`, `PARTY`, and `DM_ONLY` Markdown notes in `DocumentsWorkspaceTab`, where `Player` edits on `PARTY` notes are reconciled on the server via `LineAnchorNoteMerge` (`merge_party_note_ast`) and rendered via `FilteredNoteDocument`, so that confidential `:::dm` and unrevealed `:::handout` `DirectiveBlock` segments are never leaked to players and never wiped when players edit shared notes.
19. As a `GameMaster`, I want clicking `[ Reveal to Party ]` on a `:::handout` block to persist a `PartyJournalEntry`, append a `SessionTimelineEvent`, and broadcast `HandoutRevealed` over WebSocket so connected players immediately see `HandoutRevealModal`.
20. As a `GameMaster` using an AI assistant or external MCP client, I want to connect to `POST /api/v1/mcp` using a `trame_pat_` token to read `trame://campaigns/{id}/timeline` and `trame://campaigns/{id}/notes` and invoke `TrameCommand` tools or `mcp.stage_encounter`, queuing a `McpStagingProposal` when `MCP Staging Mode` is enabled so I can review translucent ghost previews on `TableCanvas` and click `[ Commit All ]` or `[ Reject ]`.
21. As a `Player` joining from a smartphone (`< 768px`), I want `MobileCompanionView` to render functional `Sheet`, `Dice`, `Inventory`, `Tracker`, and `Journal` tabs with `>= 44x44px` touch targets and zero WebGL overhead, so that I can use TRAME as a companion sheet at a physical or hybrid table.
22. As a user in light or dark theme, I want all UI and canvas elements to obey ATLAS v1.1 design tokens (`DESIGN.md`), WCAG 2.2 AA contrast (`>= 4.5:1` text, `>= 3.0:1` non-text strokes in `CanvasThemePalette`), keyboard focus trapping in modals, and reactive EN/FR localization via `LocaleSignal` while keeping all source code and documentation strictly in English.

---

## Implementation Decisions

### 1. Persistence & Runtime Wiring (`SqlxPostgresStore`)
- Port the PostgreSQL 18 schema (`users`, `auth_sessions`, `personal_access_tokens`, `campaigns`, `campaign_members`, `actors`, `scenes`, `wal_events`, `wal_snapshots`, `fog_explored_chunks`, `notes`, `party_journal_entries`, `session_events`, `campaign_homebrew`) and `SqlxPostgresStore` implementation into `trame-server`.
- Replace per-call `std::thread::spawn` inside synchronous `WalStorage` bridge methods with `tokio::task::block_in_place(|| handle.block_on(...))` so WAL appends reuse the Tokio runtime worker pool without OS thread creation churn.
- Configure `trame-server` startup to connect to `DATABASE_URL` via `SqlxPostgresStore`, run SQL migrations automatically, and bind to `TRAME_PORT` -> `PORT` -> `8080` (with `TRAME_PORT=4000` set explicitly in local development compose). Fix the production compose PostgreSQL 18 volume mount to `/var/lib/postgresql`.

### 2. Dual-Boundary State Mutation Contract (`ADR-0037`)
- **Tactical Table State (`TrameCommand` over WebSocket / MCP)**:
  - Unify `TrameCommand` across `trame-engine`, `trame-server`, and `packages/web` to include: `MoveToken`, `SpawnToken`, `RemoveToken`, `AddWall`, `AddLight`, `ToggleDoor`, `ProjectAoE`, `ClearAoE`, `SetFogOverride`, `SetMapConfig`, `StartTurnByTurn`, `EndTurnByTurn`, `NextTurn`, `ApplyDamage`, `HealActor`, `RefundAction`, `SetAmbientPreset`, `DecideReaction`, `RevealHandout`, `CommitMcpStaging`, `RejectMcpStaging`, and `UndoLastAction`.
  - Enforce `WallSegment::is_blocking_movement()` inside `MoveToken` using 2D segment intersection against `TableState.walls` so tokens cannot cross solid walls or closed doors unless `is_gm_override` is true.
  - When `ApplyDamage` or `HealActor` targets a `LinkedActorToken`, `TableRoomActor` updates both `TokenState` and the persistent `Actor` record (`TempHP`, `DamageMitigation`, `ConcentrationCheckPrompt`, `InstantDeath`, `DeathSaveCounters`) and records a single tactical `UndoEntry`. A `SyntheticToken` (compendium monster) only updates its own `TokenState`.
  - `[ Commit All ]` on a `McpStagingProposal` records one composite `UndoEntry`, so a single `UndoLastAction` reverts the whole batch.
- **Persistent `Actor` Sheet State (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`)**:
  - Route all structural and sheet edits (`DeclarativeSheetView`, `LevelUpModal`, `RestModal`, `CharacterBuilderWizard`, `CompendiumDrawer` item drops) through `PUT /api/v1/campaigns/{id}/actors/{actor_id}` with `expected_version` optimistic concurrency (`409 Conflict` on mismatch).
  - After committing to `SqlxPostgresStore`, notify `TableRoomActor` to emit `ServerEnvelope::ActorUpdated` and synchronize linked `TokenState` tactical fields (`hp_current`, `hp_max`, `temp_hp`, `ac`, `speed_ft`, `conditions`) without pushing onto the 50-entry tactical `UndoEntry` ring buffer.

### 3. `DerivedDAG` & `ActiveEffect` Boundary
- Keep `trame-engine`'s `DerivedDAG` parser (`rules.rs`) strictly pure arithmetic (`+`, `-`, `*`, `/`, parentheses, `min`, `max`, `floor`, `ceil`).
- Normalize all 26 `derivedDAG` expressions in `@trame/game-system-dnd5e` `system.json` to pure arithmetic expressions (`floor((score - 10) / 2)`, `floor((level - 1) / 4) + 2`, `10 + dex_mod`, `8 + prof_bonus + spell_mod`) and express conditional armor Dexterity caps and proficiency multipliers through the 5-phase `ActiveEffect` pipeline (`BASE` -> `ADD` -> `MULTIPLY` -> `OVERRIDE` -> `CLAMP`).

### 4. Security, Authentication & `GuestSessionUpgrade`
- **Zero-Trust Session & PAT Extraction**: Remove all trust of query-string identity/role parameters (`WsAuthQuery { user_id, role }` and `fallback_user_id`). Every HTTP handler and WebSocket upgrade (`/ws/campaigns/{id}`) must authenticate the caller via the `trame_session` cookie or `Authorization: Bearer trame_pat_*` header and resolve `UserRole` (`GameMaster`, `Player`, `Spectator`) from `campaign_members`.
- **Invite Minting & `GuestSessionUpgrade`**: `POST /api/v1/campaigns/{id}/invites` is the only invite-minting route; it requires an authenticated `GameMaster` of the target campaign and a minimum 32-byte `TRAME_INVITE_JWT_SECRET`. `POST /api/v1/auth/invites` and `POST /api/v1/auth/magic-link/mint` are removed. When a browser opens `?invite=<jwt>`, `App.tsx` executes `GuestSessionUpgrade` prior to the login screen guard: it redeems the token against `POST /api/v1/auth/magic-link`, receives an `HttpOnly` guest `trame_session` cookie (or binds the campaign membership to an existing session), cleans the URL via `history.replaceState`, and enters `CampaignWorkspace` immediately.
- **TOTP MFA & UVTT Pre-Decode Guards**: Verify `totp_secret` in `login_password_handler` when MFA is enabled before issuing a session cookie. In `import_uvtt_map`, inspect image headers via `image::image_dimensions(&image_bytes)` *before* `image::load_from_memory` so images exceeding `16,384 x 16,384` are rejected before raster heap allocation.

### 5. `AuthoritativeInitiativeRoll`, `ActivateScene` & `LineAnchorNoteMerge`
- **`AuthoritativeInitiativeRoll`**: When `StartTurnByTurn` is dispatched with an empty `initiative_order` (or combatants lacking scores), `TableRoomActor` uses its `ChaCha20Rng` to roll `1d20 + dex_mod` for each active combatant token on the table, broadcasts the individual `DiceRollResult` events to the roll log, sorts combatants descending (tie-breaking by `dex_mod` then `token_id`), and begins Round 1 at Turn Index 0.
- **`ActivateScene` (`ADR-0034`)**: Clicking `[ Activate Scene on Table ]` in `MapsStudioTab` calls `POST /api/v1/campaigns/{id}/maps/{map_id}/activate`, which dispatches `ActivateScene { scene_id }` to `TableRoomActor`: loading scene walls, lights, audio emitters, and `StagedToken` entities while preserving active `HeroToken` instances (`owner_user_id.is_some()`) and repositioning them onto scene `spawn_points`.
- **`LineAnchorNoteMerge` (`ADR-0004`)**: Wire `PUT /api/v1/campaigns/{id}/notes/{note_id}` to `merge_party_note_ast` whenever a `Player` saves a `PARTY` note so stripped `:::dm` and unrevealed `:::handout` `DirectiveBlock` segments are spliced back at their original line anchors. Ensure `DocumentsWorkspaceTab` always passes note markdown through `filterWikiMarkdownForRole` for non-GM users.

### 6. Native MCP Endpoint (`/api/v1/mcp`) & `McpStagingProposal`
- Mount `POST /api/v1/mcp` in `trame-server` supporting JSON-RPC 2.0 `tools/list`, `tools/call` (reflecting `TrameCommand` schemas, `mcp.execute_batch` capped at 25 commands, and `mcp.stage_encounter`), and `resources/read` (`trame://campaigns/{id}/timeline` and `trame://campaigns/{id}/notes`).
- When `mcp_staging_mode = true` on the campaign (or `mcp.stage_encounter` is called), queue the batch as a `McpStagingProposal` in `TableRoomActor` and broadcast `ServerEnvelope::McpStagingProposed` to the `GameMaster` client (rendering translucent purple ghost previews on `TableCanvas` with `[ Commit All ]` -> `CommitMcpStaging` and `[ Reject ]` -> `RejectMcpStaging`).
- Ensure `ClientEnvelope::Ping` does not update `TableRoomActor.last_activity_ms` so the 15-minute `Idle-Lease` hibernates idle rooms accurately.

### 7. 5-Tab `CampaignWorkspace`, `HudDrawers` & `MobileCompanionView`
- Structure `CampaignWorkspace.tsx` around 5 top-level tabs (`Table`, `Maps`, `Actors`, `Documents`, `Compendium`) while mounting slide-over `HudDrawers` (`CharacterSheetHeader` + 12-widget `DeclarativeSheetView` + `LevelUpModal` + `RestModal`, `CompendiumDrawer`, Dice/Chat, `UndoDrawer`) over `TableCanvas` in the `Table` tab.
- Fix `ApiClient` WebSocket framing (`PointerPing` external MessagePack variant tagging, full `CommandAccepted.state` reconciliation across all commands, `ActorUpdated` handling, and `HandoutRevealed` triggering `HandoutRevealModal`).
- Wire `diceRollService` in `CharacterSheetHeader` to the authoritative server dice endpoint/WebSocket command so rolled HP on level-up and Hit Die spending on `ShortRest` work end-to-end.
- Replace the 4 placeholder tab strings in `MobileCompanionView.tsx` (`sheet`, `dice`, `inventory`, `tracker`) with functional mobile Preact views alongside `DocumentsWorkspaceTab`.

### 8. Curated Campaign-Complete `SystemSRD` (~160 Bilingual Entries)
- Expand `packages/game-systems/dnd5e/src/compendium.ts` and `progression.ts` to ~160 bilingual (`en`/`fr`) SRD 5.1 entries:
  - **12 Base Classes** with Hit Die, saving throw proficiencies, and level 1-20 feature grant tables (`CLASS_FEATURES_BY_LEVEL`), plus **Third-Caster** (`1/3`) spell slot progression.
  - **12 Subclasses** (1 per base class), **9 Species/Ancestries**, and **6 Backgrounds**.
  - **~60 Iconic Spells across Levels 0 through 9** (at least 5-8 per spell level, including levels 6-9 so high-level casters never encounter an empty spell step in `LevelUpModal`).
  - **~40 Weapons, Armors, Containers, Potions & Adventuring Gear** and **5+ Feats** (wiring `feat:tough` to grant `+2 * level` max HP).
  - **~35 Monsters across CR 0 to CR 20** with complete statblocks (`ac`, `hp`, `speed_ft`, `abilities`, `actions`) for 1-click encounter spawning.

### 9. ATLAS v1.1 Design System, WCAG 2.2 AA & English-Only Source Policy
- Define `--atlas-text-xs`, `--atlas-text-sm`, `--atlas-text-base`, `--atlas-text-lg`, and `--atlas-accent-primary-subtle` in `tokens.css` and ensure `node scripts/check-impeccable-design.mjs` passes with 0 errors as part of `make lint-web`.
- Update `LIGHT_CANVAS_PALETTE` in `CanvasThemePalette.ts` (`walls.Normal.stroke = '#475569'`, `combat.activeTurn = '#B45309'`) to exceed 3.0:1 contrast against `#F4F7F9`; replace `<li role="button">` with `<li><button type="button">` in `SavingThrowListWidget` and `SkillCheckListWidget`; and add keyboard focus trapping (`Tab`/`Shift+Tab`) and trigger focus restoration to `LevelUpModal` and `RestModal`.
- Replace all hardcoded French literals in `LevelUpModal.tsx`, `RestModal.tsx`, and `pipeline.ts` with English defaults and `t(key)` lookups, translate remaining French lines in `ARCHITECTURE.md` to English, and include `tests/**/*.tsx` in `packages/web/tsconfig.json`.

---

## Testing Decisions

### Philosophy: High-Level Behavioral Seams
Tests must verify external observable behavior across module boundaries rather than internal implementation details. We target **four primary behavioral seams**:

1. **Seam 1 — Authoritative Server HTTP + WebSocket + `SqlxPostgresStore` Integration Seam (`crates/trame-server/tests/`)**:
   - **What it tests**: Full Axum router + `TableRoomActor` + `SqlxPostgresStore` round-trips: hybrid auth (`register`, `login` with TOTP check, `POST /api/v1/campaigns/{id}/invites` RBAC, `GuestSessionUpgrade` via `/api/v1/auth/magic-link`), zero-trust rejection of unauthenticated WebSocket/REST requests, `ActivateScene` hero preservation + spawn placement, `PUT /actors/{id}` optimistic locking (`409 Conflict` on stale version) + `ActorUpdated` broadcast, `LineAnchorNoteMerge` preserving `:::dm` blocks on player `PARTY` note edits, `/api/v1/mcp` JSON-RPC tool reflection + `McpStagingProposal` commit/reject, and `Ping` frames not resetting `Idle-Lease`.
   - **Prior art**: `crates/trame-server/src/http.rs` (`#[cfg(test)] mod tests`), `crates/trame-server/src/room.rs` tests, and `crates/trame-server/tests/` integration tests on `origin/feature/71`.
2. **Seam 2 — Deterministic Spatial & Rules Engine Seam (`crates/trame-engine/src/` & `crates/trame-engine/tests/`)**:
   - **What it tests**: `TableState::apply_command` enforcing `WallSegment::is_blocking_movement()` on `MoveToken` (blocked by closed doors/solid walls, allowed on open doors or `is_gm_override`), `DecideReaction` resolution, `CommitMcpStaging` / `RejectMcpStaging`, and `evaluate_derived_dag` parsing and evaluating all 26 normalized expressions from `packages/game-systems/dnd5e/system.json` without error.
   - **Prior art**: Parameterized tests in `crates/trame-engine/src/commands.rs`, `geometry.rs`, and `rules.rs`.
3. **Seam 3 — D&D 5e Progression, Rest & Compendium Seam (`packages/game-systems/dnd5e/tests/`)**:
   - **What it tests**: Level 1-20 `applyLevelUp` progression across all 12 SRD classes (including Full, Half, Third, and Pact casters, level 6-9 spell selection, class feature grants, and `feat:tough` HP calculation), `applyShortRest` / `applyLongRest` recovery, and `CompendiumResolver` lookups across the ~160 bilingual `SystemSRD` entries.
   - **Prior art**: `packages/game-systems/dnd5e/tests/progression.test.ts`, `rest.test.ts`, and `pipeline.test.ts`.
4. **Seam 4 — Unified Preact Workspace & Live Tabletop UI Seam (`packages/web/tests/`)**:
   - **What it tests**: `App.tsx` startup session restoration (`/api/v1/auth/me`) and `?invite=` `GuestSessionUpgrade`, 5-tab `CampaignWorkspace` navigation (`Table`, `Maps`, `Actors`, `Documents`, `Compendium`), token selection binding `selectedActorIdSignal` to the 12-widget `DeclarativeSheetView`, `CharacterSheetHeader` invoking `diceRollService` during `LevelUpModal` / `RestModal`, `MobileCompanionView` rendering all 5 functional tabs, WCAG 2.2 AA contrast/ARIA semantics, and `scripts/check-impeccable-design.mjs` passing with 0 violations.
   - **Prior art**: `packages/web/tests/modals/LevelUpModal.test.tsx`, `RestModal.test.tsx`, `packages/web/tests/maps.test.ts`, and `packages/web/tests/impeccable-design.test.ts`.

---

## Out of Scope

- **D&D 5e Multiclassing**: Leveling a single `Actor` across multiple base classes simultaneously (e.g., Fighter 2 / Wizard 3) remains deferred to a future specification; single-class progression from level 1 to 20 (including Third-Casters like Eldritch Knight / Arcane Trickster) is covered here.
- **Real-Time Keystroke-Level Collaborative Text Cursor Sync (`yrs` WebSocket Subprotocol)**: `PARTY` notes use deterministic server-side `LineAnchorNoteMerge` (`merge_party_note_ast`) and `FilteredNoteDocument` projection on save rather than sub-second character-by-character CRDT cursor streaming.
- **External Marketplace & Paid Third-Party Content Packs**: Only CC-BY-4.0 SRD 5.1 content (`SystemSRD`), `InstanceLibrary`, and `CampaignHomebrew` tiers are included.
- **Native Voice/Video WebRTC Streaming**: TRAME provides spatial table audio (`SpatialAudioManager` with `AcousticOcclusion`), leaving voice chat to external tools (Discord/Mumble).

---

## Further Notes

- All newly recorded domain terms (`ActivateScene`, `AuthoritativeInitiativeRoll`, `GuestSessionUpgrade`, `HeroToken`, `LineAnchorNoteMerge`, `MapsStudioTab`, `McpStagingProposal`, `SceneAtlas`, `StagedToken`) have been added to `GLOSSARY.md`.
- The architectural boundary between persistent `Actor` sheet mutations (`PUT /api/v1/campaigns/{id}/actors/{actor_id}` with `expected_version` optimistic locking) and tactical `TokenState` mutations (`TrameCommand` + 50-entry `UndoEntry` ring buffer) is recorded in `docs/adr/0037-actor-rest-vs-token-trame-command-boundary.md`.
