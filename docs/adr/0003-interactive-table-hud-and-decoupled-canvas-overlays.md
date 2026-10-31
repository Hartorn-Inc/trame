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
4. **Spatial Audio Architecture and Occlusion Raycasting**:
   - `SpatialAudioManager` maps sound sources to WebAudio `PannerNode` and `BiquadFilterNode` instances.
   - `AcousticOcclusion` calculations execute against `blocks_sound` walls at a throttled frequency of 10 Hz for the nearest 16 active emitters.

## Consequences
### Positive
- Client frame rendering maintains 60 FPS during interactive ruler measurement and ping broadcasts.
- Reaction countdowns execute synchronously across distributed clients without timestamp drift.
- Game Masters can revert erroneous token movements and mutations in 1 click.

### Negative
- Requires continuous round-trip time estimation (`TimeSync`) to compensate for network latency.
