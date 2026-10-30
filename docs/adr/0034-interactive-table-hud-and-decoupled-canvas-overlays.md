# ADR-0034: Interactive Table HUD, Reaction Interruption Authority, and Acoustic Occlusion

## Status
Accepted

## Context
The interactive table in TRAME requires low-latency user feedback for interactive tools (3D ruler, radar pings, vector drawing overlays) while providing an authoritative HUD for combat sequencing (mode toggles, initiative tracking, 5-second reaction interruptions) and omnipotent Game Master overrides (resource edits, action refunds, 1-click state undo).

Previous web architectures encountered performance degradation when streaming high-frequency cursor coordinates through React reconciliation loops or saturating WebSocket bandwidth with transient manipulation frames. Furthermore, handling multi-client reaction interruptions without server-authoritative timestamps introduced clock drift, permitting clients to display conflicting countdown states. Finally, simulating acoustic occlusion through architectural walls required spatial calculations that risked degrading frame rendering rates when executed naively on the JavaScript main thread.

## Decision
1. **Decoupling React 19 HUD and PixiJS v8 SceneGraph**:
   - Transient manipulations (ruler drag preview, drawing ghost polygons, radar ping pulses) execute exclusively within PixiJS v8 SceneGraph (`uiControlHud` layer) and query the compiled WebAssembly bridge (`wasmBridge.ts`) synchronously.
   - React components in `@trame/web` subscribe exclusively to committed states stored in `tableStore.ts`.
   - Network transmission of pings uses lightweight `PointerPing` envelopes broadcast without persistent database storage.

2. **Server-Authoritative Reaction Interruptions**:
   - When a token vacates an enemy `ThreatReach`, `TableRoomActor` suspends movement interpolation for all connected peers.
   - `TableRoomActor` assigns an absolute server timestamp (`expires_at_ms`) and emits `TableInterruptSuspended`.
   - Clients estimate server clock skew using a two-way `TimeSyncPing` / `TimeSyncPong` exchange and display a synchronized 5-second `ReactionBanner`.
   - The Game Master retains omnipotent authority to force, cancel, or resolve interruptions prematurely via `GmOverrideToolbar`.

3. **Transactional 1-Click State Undo**:
   - `TableRoomActor` integrates with the engine ring buffer (`undo_stack: VecDeque<UndoEntry>`, bounded to 50 items) via `TrameCommand::UndoLastAction`.
   - Client interfaces invoke undo via `UndoDrawer.tsx` or `Cmd+Z` / `Ctrl+Z` hotkeys.
   - Undoing token movements restores token coordinates, refunds expended movement allowance in `ActionEconomyType`, and rolls back fog-of-war exploration cache in `DualBufferFogOfWar`.

4. **Spatial Audio Architecture and Occlusion Raycasting**:
   - `SpatialAudioManager` maps sound sources to WebAudio `PannerNode` and `BiquadFilterNode` instances.
   - Occlusion calculations execute against `blocks_sound` walls at a throttled frequency of 10 Hz via the WASM bridge raycast engine.
   - The raycast engine prioritizes the nearest 16 active emitters to prevent CPU starvation; emitters beyond index 16 retain their last known cutoff frequency.

## Consequences
### Positive
- Client frame rendering maintains 60 FPS during interactive ruler measurement and ping broadcasts.
- Reaction countdowns execute synchronously across distributed clients without timestamp drift.
- Game Masters can instantaneously revert erroneous token movements and mutations in 1 click.
- Spatial audio realistically models physical architecture without compromising the JavaScript audio thread budget.

### Negative
- Requires continuous round-trip time estimation (`TimeSync`) to compensate for network latency.
- Requires maintaining synchronization between GPU fog cache textures and engine spatial command history.
