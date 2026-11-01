# ADR-0037: Optimistic-Concurrency REST Boundary for Persistent Actor Sheets vs. TrameCommand Tactical Table State

## Status
Accepted (Supersedes Section 3 of ADR-0036)

## Context
During the convergence of Epic E7 (`SqlxPostgresStore`, REST CRUD, WebSocket `TableRoomActor`) with Specs #77 (`LevelUpModal`, `RestModal`) and #78 (12-widget `DeclarativeSheetView`), a boundary collision emerged:
- `TableRoomActor` executes `TrameCommand` mutations against in-memory `TableState` and pushes an inverse `UndoEntry` onto a 50-action per-map ring buffer (`Cmd+Z`).
- Persistent `Actor` sheets (`Dnd5eActorData`) live in PostgreSQL (`actors` table with `version BIGINT`) and can be edited both inside a live table session (`HudDrawers`) and asynchronously in `CampaignWorkspace` (`Actors` tab) when no `TableRoomActor` is active.
- Routing full JSON `Actor` sheet replacements through `TrameCommand::UpdateActorData` would either pollute the 50-action tactical `UndoEntry` ring buffer with character sheet edits (causing a GM's tactical map `Cmd+Z` to accidentally revert a player's level-up or inventory reorganization) or require duplicating optimistic concurrency (`expected_version`) inside the `no_std`/`wasm` `trame-engine` crate.

## Considered Options
1. **Option A (Dual Persistence via `TrameCommand::UpdateActorData` + REST `PUT`)**: Dispatch `TrameCommand::UpdateActorData` when connected to WebSocket and REST `PUT` when offline. Rejected because it couples `trame-engine` to JSON document storage and mixes tactical table undo history with persistent character sheet edits.
2. **Option B (Unified Optimistic-Concurrency REST `PUT` for `Actor` Sheets + `TableRoomActor` Notification, Recommended)**: Route all structural/sheet `Actor` mutations through `PUT /api/v1/campaigns/{id}/actors/{actor_id}` with `expected_version`, while keeping `TrameCommand` strictly scoped to tactical table state (`TokenState`, combat, walls, doors, lights, AoE, handouts, MCP staging).

## Decision
1. **Persistent `Actor` Sheet Boundary (`PUT /api/v1/campaigns/{id}/actors/{actor_id}`)**:
   - All `DeclarativeSheetView`, `LevelUpModal`, `RestModal`, `CharacterBuilderWizard`, and `CompendiumDrawer` sheet mutations persist through `PUT /api/v1/campaigns/{id}/actors/{actor_id}` with `expected_version` optimistic locking (`409 Conflict` on stale version) in `SqlxPostgresStore`.
   - Upon committing the `Actor` update in PostgreSQL, the HTTP handler notifies the active `TableRoomActor` (if loaded) to broadcast `ServerEnvelope::ActorUpdated` to connected clients and synchronize linked `TokenState` tactical fields (`hp_current`, `hp_max`, `temp_hp`, `ac`, `speed_ft`, `conditions`) without pushing onto the tactical `UndoEntry` ring buffer.
   - Sheet-driven dice rolls (`LevelUpModal` hit points, `RestModal` hit dice, sheet checks) use `POST /api/v1/campaigns/{id}/dice/roll` with the same `ChaCha20Rng` roller, so they work while the room is hibernated; when the room is awake the result is also appended to the table roll log.
2. **Tactical Table Boundary (`TrameCommand`)**:
   - `TrameCommand` remains the sole mutation path for live tabletop state (`MoveToken`, `SpawnToken`, `RemoveToken`, `ApplyDamage`, `HealActor`, `ToggleDoor`, `StartTurnByTurn`, `NextTurn`, `DecideReaction`, `ProjectAoE`, `SetFogOverride`, `CommitMcpStaging`, `RejectMcpStaging`).
   - When tactical commands (`ApplyDamage`, `HealActor`) mutate a `LinkedActorToken`, `TableRoomActor` updates both `TokenState` and the persistent `Actor`'s hit points/death saves/concentration state and records a single tactical `UndoEntry`. A `SyntheticToken` only updates its own `TokenState`.

## Consequences
### Positive
- Prevents GM tactical map undo (`Cmd+Z`) from reverting player character sheet edits, level-ups, or inventory organization.
- Eliminates duplicate persistence logic between `CampaignWorkspace` (`Actors` tab) and live table `HudDrawers`.
- Keeps `trame-engine` deterministic, compact, and independent of full `Dnd5eActorData` JSON document schemas.

### Negative
- Live table sheet edits perform an authenticated HTTP `PUT` round-trip followed by a WebSocket `ServerEnvelope::ActorUpdated` broadcast rather than an inbound WebSocket frame.
