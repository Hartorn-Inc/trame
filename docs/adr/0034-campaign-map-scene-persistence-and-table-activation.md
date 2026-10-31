# ADR-0034: Decoupled Campaign Map Scene Persistence and Atomic ActivateScene Transition

## Status
Accepted

## Context
In TRAME, the active table is coordinated in memory by a distributed Tokio actor (`TableRoomActor`), synchronizing real-time table state over WebSockets. Previously, the Game Master possessed no isolated workspace to author new scenes (2.5D wall geometry, light sources, spatial audio emitters, staged ambush tokens) without mutating live table state. Any in-flight edits disturbed active players or risked corrupting transient session state.

Furthermore, transitioning to a new map during an active session required manual token recreation or caused loss of dynamic hero token attributes (current HP, conditions, inventory).

## Decision
1. **Decoupled REST Persistence**: Expose REST endpoints `GET / POST / PUT / DELETE /api/v1/campaigns/{campaign_id}/maps[/{map_id}]`. The Game Master drafts and persists scenes independently from the running `TableRoomActor`.
2. **Atomic ActivateScene Command**: Dispatch the `ActivateScene { scene_id: Uuid }` actor message to `TableRoomActor`. Upon handling:
   - `TableRoomActor` loads wall segments, light sources, spatial audio emitters, and staged tokens from the target persisted scene.
   - `TableRoomActor` preserves all active player `HeroToken` instances (`owner_user_id.is_some()`) without altering HP, conditions, or inventory.
   - `TableRoomActor` deterministically repositions each `HeroToken` onto scene `spawn_points`: `token.x = spawn_points[token_index % spawn_points.len()].x`, `token.y = spawn_points[token_index % spawn_points.len()].y`, and `token.elevation_ft = scene.default_ground_elevation_ft`. When `spawn_points` is empty, coordinates fall back to `(0.0, 0.0, scene.default_ground_elevation_ft)`.
   - `TableRoomActor` instantiates target `StagedToken` entities as active table tokens with their respective `VisibilityChannel` (`Public` or `GmHidden`).
   - `TableRoomActor` broadcasts the `SceneActivated` event to all connected clients.

## Consequences
### Positive
- Total isolation of GM map preparation from live room actor state.
- Seamless scene transitions preserving hero dynamic state.
- Reliable persistence and auditing of campaign map assets.

### Negative
- Requires explicit two-way synchronization if the GM wishes to snapshot live table state back into the scene library.
- Spatial overlap risk when multiple hero tokens share few spawn points (handled via client visual offset).
