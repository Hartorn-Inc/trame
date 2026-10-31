# ADR-0003: Interactive Table HUD, Reaction Interruption Authority, and Acoustic Occlusion

## Status
Accepted

## Context
The interactive table in TRAME requires low-latency user feedback for interactive tools (3D ruler, radar pings, vector drawing overlays) while providing an authoritative HUD for combat sequencing (mode toggles, initiative tracking, 5-second reaction interruptions) and omnipotent Game Master overrides (resource edits, action refunds, 1-click state undo).

Streaming high-frequency cursor coordinates through full-tree Virtual DOM reconciliation or saturating WebSocket bandwidth with transient manipulation frames degrades frame rates. Furthermore, handling multi-client reaction interruptions without server-authoritative timestamps introduces clock drift, and simulating `AcousticOcclusion` through 2.5D architectural walls requires throttled spatial calculations, explicit emitter vertical coordinates (`elevation_ft`), and a deterministic permeability matrix across wall kinds.

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
4. **Spatial Audio Architecture, Wall Permeability Matrix, and 2.5D Occlusion Raycasting**:
   - `SpatialAudioManager` maps sound sources to WebAudio `PannerNode` and `BiquadFilterNode` instances.
   - `SpatialAudioEmitter` defines vertical position with `elevation_ft: f32` to locate sources in three dimensions `(x, y, elevation_ft)`.
   - The deterministic wall permeability matrix defines acoustic propagation across `WallSegment` kinds:
     - `Normal`: blocks vision, movement, and sound (`blocks_sound = true`).
     - `Window`: blocks movement and sound (`blocks_sound = true`), allows dynamic light and vision (`blocks_light = false`).
     - `Terrain`: 2.5D barrier blocking movement and sound when source and listener elevation is below `top_elevation_ft`.
     - `Door`: blocks sound (`blocks_sound = true`), vision, and movement when closed or locked; allows sound (`blocks_sound = false`), vision, and movement when open.
     - `SecretDoor`: identical to `Normal` (`blocks_sound = true`) when closed or locked; allows sound (`blocks_sound = false`) when open.
     - `Illusion`: fully permeable to sound (`blocks_sound = false`), vision, and movement.
   - `SpatialAudioManager` calculates 2.5D `AcousticOcclusion` by tracing a direct 3D ray segment between emitter `(x_e, y_e, z_e)` and listener `(x_l, y_l, z_l)`. If the segment intersects a `WallSegment` whose `[bottom_elevation_ft, top_elevation_ft]` interval spans the ray and whose `blocks_sound == true`, it applies an exponential attenuation of -12 dB (linear factor 0.25) per wall and a first-order low-pass filter at 800 Hz.
   - `AcousticOcclusion` calculations execute against `blocks_sound` walls at a throttled frequency of 10 Hz for the nearest 16 active emitters.

## Consequences
### Positive
- Client frame rendering maintains 60 FPS during interactive ruler measurement and ping broadcasts.
- Reaction countdowns execute synchronously across distributed clients without timestamp drift.
- Game Masters can revert erroneous token movements and mutations in 1 click.
- Rigorous physical consistency between visual display, line of sight, and acoustic perception across vertical environments.

### Negative
- Requires continuous round-trip time estimation (`TimeSync`) to compensate for network latency.
- Increased 3D raycasting complexity resolved via BVH on the client audio thread.
