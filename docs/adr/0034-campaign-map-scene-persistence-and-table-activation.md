# ADR-0034: Decoupled Campaign Map Scene Persistence and Atomic ActivateScene Transition

## Status
Accepted

## Context
In TRAME, the live tabletop is managed in memory by a distributed Tokio actor (`TableRoomActor`) synchronizing real-time state over WebSockets. Previously, the Game Master lacked an isolated preparation environment to author new scenes (drawing 2.5D walls, configuring lights and spatial audio emitters, staging monsters) without mutating the live session. Moreover, switching maps during a session required manual re-entry or risked losing dynamic player token state (`HeroToken` HP, conditions, inventory).

## Decision
1. **Decoupled REST Persistence**: Persist `campaign_map_scenes` in PostgreSQL and expose `GET / POST / PUT / DELETE /api/v1/campaigns/{campaign_id}/maps[/{map_id}]` so the GM can author and save scenes independently of the active `TableRoomActor`.
2. **Atomic `ActivateScene` Command**: When `TableRoomActor` receives `ActivateScene { scene_id }`:
   - It loads the target scene's `WallSegment`, `LightSource`, `SpatialAudioEmitter`, and `StagedToken` entities.
   - It preserves all active `HeroToken` instances (`owner_user_id.is_some()`) along with their HP, conditions, and inventories.
   - It deterministically relocates each `HeroToken` onto the target scene's `SpawnPoint` coordinates (`spawn_points[token_index % spawn_points.len()]`, or `(0.0, 0.0)` when empty) at `default_ground_elevation_ft`.
   - It instantiates each `StagedToken` with its configured `VisibilityChannel` (`Public` or `GmHidden`) and broadcasts `SceneActivated`.

## Consequences
- Complete isolation between GM scene preparation and the live table.
- Instantaneous scene transitions with zero loss of dynamic player state.
