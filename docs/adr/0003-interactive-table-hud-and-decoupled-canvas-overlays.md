# ADR-0003: Interactive Table HUD, Reaction Interruption Authority, and Acoustic Occlusion

## Status
Accepted

## Context
The interactive table in TRAME requires low-latency user feedback for interactive tools (3D ruler, radar pings, vector drawing overlays) while providing an authoritative HUD for combat sequencing (mode toggles, initiative tracking, 5-second reaction interruptions) and omnipotent Game Master overrides (resource edits, action refunds, 1-click state undo).

Streaming high-frequency cursor coordinates through full-tree Virtual DOM reconciliation or saturating WebSocket bandwidth with transient manipulation frames degrades frame rates. Furthermore, handling multi-client reaction interruptions without server-authoritative timestamps introduces clock drift, and simulating `AcousticOcclusion` through architectural walls requires throttled spatial calculations coupled with an unambiguous 2.5D wall permeability matrix.

## Decision
1. **Decoupling Preact HUD (`PreactSignalState`) and PixiJS v8 SceneGraph**:
   - Transient manipulations (ruler drag preview, `DrawingOverlay` ghost polygons, `PointerPing` radar pulses) execute within the PixiJS v8 `SceneGraph` and query the compiled WebAssembly bridge synchronously.
   - Preact HUD components in `packages/web` subscribe via `@preact/signals` (`PreactSignalState`) to committed states in `TableClientStore`.
2. **Server-Authoritative Reaction Interruptions**:
   - When a token vacates an enemy `ThreatReach`, `TableRoomActor` suspends movement interpolation for all connected peers, assigns an absolute server timestamp (`expires_at_ms`), and emits a reaction window state.
   - Clients estimate server clock skew using a two-way `TimeSync` ping/pong exchange and display a synchronized 5-second `ReactionBanner`.
   - The Game Master retains authority to force, cancel, or resolve interruptions via `GmOverrideToolbar`.
3. **Transactional 1-Click State Undo**:
   - `TableRoomActor` integrates with the engine ring buffer (`undo_stack: VecDeque<UndoEntry>`, bounded to 50 items) via `TrameCommand::UndoLastAction`.
   - Client interfaces invoke undo via `UndoDrawer` or `Cmd+Z` / `Ctrl+Z` hotkeys.
4. **Spatial Audio Architecture, 2.5D Acoustic Occlusion Matrix, and Raycasting**:
   - `SpatialAudioManager` maps sound sources to WebAudio `PannerNode` and `BiquadFilterNode` instances.
   - `SpatialAudioEmitter` introduces `elevation_ft: f32` to position audio sources in 3D space `(x, y, elevation_ft)`.
   - The engine enforces an unambiguous 2.5D wall permeability matrix:
     - `Normal`: blocks vision, movement, and sound (`blocks_sound = true`).
     - `Window`: blocks movement and sound (`blocks_sound = true`), transparent to vision and dynamic light (`blocks_light = false`).
     - `Terrain`: 2.5D barrier blocking movement and sound when emitter and listener elevations are below `top_elevation_ft`.
     - `Door`: blocks sound (`blocks_sound = true`), vision, and movement when closed or locked; permeable to sound (`blocks_sound = false`), vision, and movement when open.
     - `SecretDoor`: identical to `Normal` when closed or locked (`blocks_sound = true`); permeable to sound (`blocks_sound = false`) when open.
     - `Illusion`: fully permeable to sound (`blocks_sound = false`), vision, and movement.
   - `SpatialAudioManager` traces a direct 3D ray segment between emitter `(x_e, y_e, z_e)` and listener `(x_l, y_l, z_l)`. If the segment intersects a `WallSegment` whose vertical range `[bottom_elevation_ft, top_elevation_ft]` spans the ray and whose `blocks_sound == true`, an exponential attenuation of -12 dB (linear factor 0.25) is applied per intersected wall, coupled with a first-order low-pass filter at 800 Hz cutoff.
   - `AcousticOcclusion` calculations execute at a throttled frequency of 10 Hz for the nearest 16 active emitters.

## Consequences
### Positive
- Client frame rendering maintains 60 FPS during interactive ruler measurement and ping broadcasts.
- Reaction countdowns execute synchronously across distributed clients without timestamp drift.
- Game Masters can revert erroneous token movements and mutations in 1 click.
- Enforces strict physical consistency between visual display, line-of-sight, and 2.5D acoustic occlusion across vertical architecture.

### Negative
- Requires continuous round-trip time estimation (`TimeSync`) to compensate for network latency.
- Throttled 3D BVH raycast intersection calculations add computational overhead to the client audio evaluation thread.
