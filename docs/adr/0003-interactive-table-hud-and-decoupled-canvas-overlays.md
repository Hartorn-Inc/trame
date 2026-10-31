# ADR-0003: Interactive Table HUD, Reaction Interruption Authority, and Acoustic Occlusion

## Status
Accepted

## Context
The interactive table in TRAME requires low-latency user feedback for interactive tools (3D ruler, radar pings, vector drawing overlays) while providing an authoritative HUD for combat sequencing (mode toggles, initiative tracking, 5-second reaction interruptions) and omnipotent Game Master overrides (resource edits, action refunds, 1-click state undo).

Streaming high-frequency cursor coordinates through full-tree Virtual DOM reconciliation or saturating WebSocket bandwidth with transient manipulation frames degrades frame rates. Furthermore, handling multi-client reaction interruptions without server-authoritative timestamps introduces clock drift, and simulating `AcousticOcclusion` through architectural walls requires throttled spatial calculations.

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
4. **Spatial Audio Architecture, 2.5D Elevation, and Acoustic Occlusion**:
   - Add `elevation_ft: f32` to `SpatialAudioEmitter` to position sound sources in three-dimensional space `(x, y, elevation_ft)`.
   - `SpatialAudioManager` maps sound sources to WebAudio `PannerNode` and `BiquadFilterNode` instances.
   - `AcousticOcclusion` calculations execute against `blocks_sound` walls at a throttled frequency of 10 Hz for the nearest 16 active emitters.
   - Enforce an unambiguous permeability matrix for `WallSegment` kinds:
     - `Normal` blocks vision, movement, and sound (`blocks_sound = true`).
     - `Window` blocks movement and sound (`blocks_sound = true`), but transmits vision and dynamic light (`blocks_light = false`).
     - `Terrain` blocks movement and sound when source and listener elevations fall below `top_elevation_ft`.
     - `Door` and `SecretDoor` block sound (`blocks_sound = true`) when closed or locked, and transmit sound (`blocks_sound = false`) when open.
     - `Illusion` remains completely permeable to sound (`blocks_sound = false`), vision, and movement.
   - `SpatialAudioManager` traces a direct 3D ray between source `(x_e, y_e, z_e)` and listener `(x_l, y_l, z_l)`. If the ray intersects a `WallSegment` whose vertical interval `[bottom_elevation_ft, top_elevation_ft]` spans the ray and where `blocks_sound == true`, an exponential attenuation of -12 dB (linear factor 0.25) applies per intersected wall, coupled with low-pass filtering.

## Consequences
### Positive
- Client frame rendering maintains 60 FPS during interactive ruler measurement and ping broadcasts.
- Reaction countdowns execute synchronously across distributed clients without timestamp drift.
- Game Masters can revert erroneous token movements and mutations in 1 click.
- 2.5D acoustic occlusion and wall permeability matrix align audio propagation deterministically with visual and physical boundaries.

### Negative
- Requires continuous round-trip time estimation (`TimeSync`) to compensate for network latency.
- 3D raycasting for acoustic occlusion adds BVH intersection computation on the client audio thread.
