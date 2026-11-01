# Technical Specification [E4]: Interactive Table HUD, Reaction Banner, GM Override Toolbar, Ping/Ruler & Spatial Audio

## 1. Context & Business Goals

The Focus Table HUD module provides TRAME's real-time interactive interface for players and the Game Master (GM). It combines:
1. **Exploration & combat tracker**: mode switch (`TableMode::Exploration` vs `TableMode::TurnByTurn`), global GM pause indicator (`Spacebar`), initiative carousel, action economy badges (`[A]`, `[BA]`, `[R]`, `[Move]`) and a reaction banner that interrupts the turn.
2. **GM override toolbar & 1-click undo**: instant edit popover for HP / Temp HP / death saves / spell slots, 1-click refund of actions and movement, forced teleport without spending speed, ambient lighting preset selector (`DAYLIGHT`, `DUSK`, `NIGHT_MOONLIGHT`, `PITCH_DARKNESS`) and the `UndoDrawer` history drawer with the `Cmd+Z` / `Ctrl+Z` shortcut.
3. **Non-blocking table tools**: 3D multi-point measuring ruler (supports the `5-5-5`, `5-10-5` and Euclidean metrics, including `ElevationFt` elevation), synchronized ephemeral radar pings, freehand/polygon vector annotations with an option to convert them into physical walls.
4. **WebAudio spatial audio engine**: 3D positioning of sound emitters and dynamic low-pass acoustic occlusion computed by a WASM raycast against walls flagged `blocks_sound`.

> **Status note (convergence spec v3, decision G2):** the 5-second reaction countdown described in this document is superseded. A `ThreatReach` exit stops the token on the exit square and opens a reaction prompt for the reactor's owner (the GM for monsters) with **no timer**; the owner resolves it with `DecideReaction` (`Trigger` or `Pass`), and the GM can force `Pass` at any time. Movement resumes after `Pass` or after resolution. `TimeSync` remains the clock-offset protocol for any other server-authoritative timer.

---

## 2. Architecture & Separation of Concerns

### 2.1 Decoupling Preact vs PixiJS v8 SceneGraph vs WASM Bridge
To guarantee 60 FPS without loading the Preact reconciler or saturating WebSocket bandwidth:
- **Ephemeral dynamic interactions**: active ruler manipulation (dragging waypoints), radar ping animation and ghost display of vector strokes run directly in the PixiJS v8 SceneGraph (`packages/web/src/canvas/SceneGraph.ts`, `uiControlHud` layer). These computations query the WebAssembly bridge `wasmBridge.ts` synchronously without triggering a Preact re-render.
- **Persisted state & HUD**: the signal store (`tableStore.ts` / `TableClientStore`, `PreactSignalState`) keeps only the active tool, the confirmed entities and the combat metadata. The Preact components (`CombatTracker.tsx`, `ReactionBanner.tsx`, `GmOverrideToolbar.tsx`, `UndoDrawer.tsx`) subscribe selectively to changes in this store.
- **Network broadcast**: radar pings emit lightweight broadcast messages that are not persisted in the database. Confirmed vector strokes and physical wall segments emit commands persisted by the `TableRoomActor`.

### 2.2 Time Authority & Network Synchronization (`TimeSync`)
To avoid any desynchronization of server-authoritative countdowns:
- The `TableRoomActor` server is the time authority. When a timed window opens, the server assigns an absolute deadline timestamp: `expires_at_ms = current_server_time_ms + duration_ms`.
- The client estimates its clock offset `server_time_offset_ms` through a continuous exchange (`ClientEnvelope::Ping` / `ServerEnvelope::Pong`).
- The client derives the remaining time to display: `remaining_ms = max(0, expires_at_ms - (client_now_ms + server_time_offset_ms))`.

### 2.3 1-Click Undo & Transactional Rollback
- `TableState` keeps a native undo stack `undo_stack: VecDeque<UndoEntry>` bounded to 50 entries (`MAX_UNDO_HISTORY`) in `crates/trame-engine/src/commands.rs`.
- Running `TrameCommand::UndoLastAction` restores an atomic table snapshot (`TableSnapshotData`) and rebuilds the `Bvh2D` spatial tree.
- The broadcast of the restored state orders the client to update `TableClientStore` and to call `DualBufferFogOfWar.rollbackSnapshot(snapshot_id)` to invalidate the fog tiles explored during the undone turn.

---

## 3. Network Contracts & Data Structures (`crates/trame-server/src/sync.rs`)

The structures below are the E4 design contract. In the implemented wire protocol, every table mutation travels as `ClientEnvelope::SubmitCommand(TrameCommand)` and comes back as `ServerEnvelope::CommandAccepted { seq_id, events, state }` (or `CommandRejected`). The mapping is:

| E4 design message | Implemented as |
| :--- | :--- |
| `SetTableMode`, `ToggleTablePause` | `TrameCommand::SetTableMode { mode, exploration_paused, initiative_order }` |
| `GmOverrideHp`, `GmRefundAction` | `TrameCommand::GmOverrideTokenResources` |
| `GmTeleportToken` | `TrameCommand::MoveToken { gm_teleport: true, .. }` |
| `GmSetAmbientPreset` | `TrameCommand::SetAmbientLighting { preset: AmbientLightingPreset }` |
| `GmTriggerUndo` / `ActionUndone` | `TrameCommand::UndoLastAction` / `CommandAccepted` with the restored state |
| `DeclareReaction` / `TableInterruptSuspended` / `TableInterruptResolved` | `TrameCommand::DecideReaction` / `ReactionPrompt` in `ProjectedTableState.active_reaction_prompts` |
| `PointerPing` / `PointerPingBroadcast` | `ClientEnvelope::PointerPing { pos, color_hex }` / `ServerEnvelope::PointerPingBroadcast` |
| `TimeSyncPing` / `TimeSyncPong` | `ClientEnvelope::Ping` / `ServerEnvelope::Pong` |

### 3.1 Common Types

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TableMode {
    Exploration,
    TurnByTurn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionEconomyType {
    Action,
    BonusAction,
    Reaction,
    Movement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeathSaveCounters {
    pub successes: u8,
    pub failures: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AmbientLightingPreset {
    Daylight,
    Dusk,
    NightMoonlight,
    PitchDarkness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RulerMetric {
    FiveFiveFive,
    FiveTenFive,
    Euclidean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PingType {
    Alert,
    Attention,
    Question,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrawingEntity {
    pub id: String,
    pub points: Vec<[f32; 2]>,
    pub color: String,
    pub line_width: f32,
    pub is_closed: bool,
    pub has_physical_walls: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioEmitterConfig {
    pub id: String,
    pub url: String,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub max_distance_ft: f32,
    pub ref_distance_ft: f32,
    pub rolloff: f32,
    pub loop_playback: bool,
    pub volume: f32,
}
```

### 3.2 Messages Sent by the Client (`ClientEnvelope`, design contract)

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ClientEnvelope {
    SetTableMode {
        mode: TableMode,
    },
    ToggleTablePause {
        is_paused: bool,
    },
    GmOverrideHp {
        token_id: String,
        hp: i32,
        temp_hp: i32,
        spell_slots_delta: Option<Vec<i8>>,
        death_saves: Option<DeathSaveCounters>,
    },
    GmRefundAction {
        token_id: String,
        economy_type: ActionEconomyType,
    },
    GmTeleportToken {
        token_id: String,
        target_x: f32,
        target_y: f32,
        target_elevation_ft: f32,
    },
    GmSetAmbientPreset {
        preset: AmbientLightingPreset,
    },
    GmTriggerUndo,
    DeclareReaction {
        trigger_id: u64,
        actor_id: String,
        reaction_id: String,
        accepted: bool,
    },
    PointerPing {
        x: f32,
        y: f32,
        ping_type: PingType,
    },
    CreateDrawing {
        drawing: DrawingEntity,
    },
    DeleteDrawing {
        drawing_id: String,
    },
    TimeSyncPing {
        client_send_ms: u64,
    },
    UpsertAudioEmitter {
        emitter: AudioEmitterConfig,
    },
    RemoveAudioEmitter {
        emitter_id: String,
    },
}
```

### 3.3 Messages Broadcast by the Server (`ServerEnvelope`, design contract)

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ServerEnvelope {
    TableModeChanged {
        mode: TableMode,
        changed_by: String,
    },
    TablePauseToggled {
        is_paused: bool,
        changed_by: String,
    },
    TableInterruptSuspended {
        trigger_id: u64,
        actor_id: String,
        reaction_type: String,
        expires_at_ms: u64,
        reach_distance_ft: f32,
    },
    TableInterruptResolved {
        trigger_id: u64,
        was_interrupted: bool,
    },
    PointerPingBroadcast {
        x: f32,
        y: f32,
        ping_type: PingType,
        user_id: String,
        color: String,
    },
    DrawingCreated {
        drawing: DrawingEntity,
    },
    DrawingDeleted {
        drawing_id: String,
    },
    ActionUndone {
        snapshot_id: u64,
        restored_token_ids: Vec<String>,
    },
    TimeSyncPong {
        client_send_ms: u64,
        server_recv_ms: u64,
        server_send_ms: u64,
    },
    AudioEmitterUpserted {
        emitter: AudioEmitterConfig,
    },
    AudioEmitterRemoved {
        emitter_id: String,
    },
}
```

---

## 4. Functional & Technical Modules

### Module 1: Exploration / Combat Top Bar & Combat Tracker

#### 1.1 Mode Switch & GM Pause (`Spacebar`)
- The `CombatTopBar` component shows the current mode (`TableMode`).
- WHEN the Game Master clicks the toggle button or uses the dedicated shortcut, THEN `CombatTopBar` sends `SetTableMode { mode }`.
- WHEN the Game Master presses `Spacebar` outside a text input, THEN `CombatTopBar` sends `SetTableMode` with the toggled `exploration_paused`.
- WHEN `TableRoomActor` receives the pause toggle, THEN `TableRoomActor` freezes the movement of every token and broadcasts the new state to every client.
- WHEN the paused state arrives on the client, THEN a semi-transparent red `[ GM PAUSE ]` banner appears in the center of the view and blocks player movement input.

#### 1.2 Initiative Carousel & Turn Order
- The `CombatTracker.tsx` component shows the ordered sequence of the tokens in combat horizontally. Players see only the combatants they can see, with the active turn re-indexed for them.
- Each token card shows the portrait, the name, the `ElevationFt` elevation, the initiative value and the action economy badges.
- The active token's card has an animated gold border and an elapsed turn time indicator.
- The Game Master has forward (`[ Next ]`, `AdvanceTurn`) and back (`[ Previous ]`) buttons to drive the active turn.

#### 1.3 Action Economy Badges (`[A]`, `[BA]`, `[R]`, `[Move]`)
- Four badges show the turn resource state of the selected token (`ActionEconomyType`):
  - `[A]`: main Action (green = available, grey = spent).
  - `[BA]`: Bonus Action (blue = available, grey = spent).
  - `[R]`: Reaction (amber = available, grey = spent).
  - `[Move]`: remaining movement speed in feet (for example `25/30 ft`).
- WHEN a token makes an attack or casts a spell, THEN `TableClientStore` updates the badges in real time from the server events.

---

### Module 2: Reaction Interruption Banner & TimeSync

> See the status note in section 1: the 5-second countdown below is superseded by decision G2 (no timer, the GM can force `Pass`). The detection, prompt and GM override rules still apply.

#### 2.1 Threat Detection (`ThreatReach`) & Interruption
- Every hostile creature token has a `ThreatReach` (default: `5.0` feet).
- WHEN a moving token leaves the `ThreatReach` radius of a hostile creature eligible to react, THEN `MoveToken` stops the token on the exit square on the server.
- The server creates a `ReactionPrompt` with a unique `prompt_id`, the reactor and the pending destination, and adds it to `active_reaction_prompts`.

#### 2.2 Clock Synchronization (`TimeSync`)
- The client periodically (every 10 seconds and on connection) sends `ClientEnvelope::Ping { client_time_ms: Date.now() }`.
- `TableRoomActor` replies immediately with `ServerEnvelope::Pong { client_time_ms, server_time_ms }`.
- `TableClientStore` updates the average clock offset:
  ```typescript
  const roundTripMs = Date.now() - client_time_ms;
  const serverTimeOffsetMs = server_time_ms + (roundTripMs / 2) - Date.now();
  ```

#### 2.3 HUD Banner Lifecycle & Resumption
- WHEN the client receives a new reaction prompt, THEN the `ReactionBanner.tsx` component mounts for the players controlling the reacting actor and for the Game Master.
- The banner shows the interrupting creature's name, the targeted token and the `[ Use Reaction ]` button.
- WHEN the user clicks `[ Use Reaction ]`, THEN the client sends `DecideReaction { prompt_id, actor_id, decision: Trigger }`.
- WHEN the prompt is resolved (`Trigger` or `Pass`), THEN the server removes it, `ReactionBanner.tsx` unmounts, and the token resumes its move (after `Pass`) or stays on the exit square until the reaction is resolved.

#### 2.4 GM Override Controls on the Reaction
- The Game Master has direct intervention buttons on the banner:
  - `[ Force ]`: accepts the interruption immediately without waiting for the player's click.
  - `[ Ignore ]`: forces `Pass` immediately and resumes the token's move.

---

### Module 3: GM Override Toolbar & 1-Click Undo Drawer (`UndoDrawer`)

#### 3.1 Instant HP, Temp HP & Death Save Edit Popover
- WHEN the Game Master clicks a token with the `Alt` modifier or enables the edit tool of the `GmOverrideToolbar`, THEN an adjustment popover appears.
- The popover lets the GM enter hit points (`hp`), temporary hit points (`temp_hp`), a relative spell slot adjustment (`spell_slots_delta`) and the death saving throw counters (`death_saves`).
- `DeathSaveCounters` has two numeric fields bounded between 0 and 3: `successes` and `failures`.
- WHEN the Game Master confirms the popover, THEN `GmOverrideToolbar` sends `GmOverrideTokenResources` to the `TableRoomActor` immediately.
- `TableRoomActor` applies the change and broadcasts the token's new atomic state.

#### 3.2 1-Click Action Economy Refund
- `GmOverrideToolbar` offers four instant refund icons (`[+A]`, `[+BA]`, `[+R]`, `[+Move]`).
- WHEN the Game Master clicks a refund icon, THEN `GmOverrideToolbar` sends `GmOverrideTokenResources` with the matching flag (`has_action`, `has_bonus_action`, `has_reaction`, `speed_remaining_ft`).
- `TableRoomActor` restores the matching resource without changing the rest of the token's state and broadcasts the update.

#### 3.3 Forced Teleport Without Spending Movement
- WHEN the Game Master selects the forced teleport tool and clicks a target coordinate on the table, THEN `GmOverrideToolbar` sends `MoveToken { token_id, to_top_left, to_elevation_ft, gm_teleport: true }`.
- `TableRoomActor` moves the token to the given coordinates immediately, without reducing its `Movement` budget and without triggering an opportunity attack.

#### 3.4 Ambient Lighting Preset Selector
- `GmOverrideToolbar` includes a drop-down menu of table ambiences (`AmbientLightingPreset`):
  - `DAYLIGHT`: ambient brightness 1.0, no darkness radius, neutral tint.
  - `DUSK`: ambient brightness 0.45, orange/amber tint.
  - `NIGHT_MOONLIGHT`: ambient brightness 0.15, night-blue tint, darkvision required.
  - `PITCH_DARKNESS`: ambient brightness 0.0, absolute darkness, no vision without a light source.
- WHEN the Game Master selects a preset, THEN `GmOverrideToolbar` sends `SetAmbientLighting { preset }`.
- `TableRoomActor` synchronizes the ambience and the client updates the `LightingShader.ts` uniforms.

#### 3.5 1-Click Undo Drawer (`UndoDrawer.tsx`) & Engine Ring Buffer
- The `UndoDrawer.tsx` drawer lists the last 50 actions recorded in the `trame-engine` `undo_stack`.
- Each entry shows the action icon, the author, the targeted actor and the relative timestamp.
- WHEN the Game Master clicks the most recent entry or presses `Cmd+Z` / `Ctrl+Z`, THEN `UndoDrawer` sends `UndoLastAction`.
- `TableRoomActor` runs `TrameCommand::UndoLastAction`, pops the last `UndoEntry`, restores `TableSnapshotData` and rebuilds `Bvh2D`.
- `TableRoomActor` broadcasts the restored state (`CommandAccepted`).

#### 3.6 Transactional Rollback of the Fog of War FBO (`DualBufferFogOfWar`)
- WHEN the client receives the restored state after an undo, THEN `DualBufferFogOfWar.rollbackSnapshot(snapshot_id)` runs.
- `DualBufferFogOfWar` resets the explored fog tiles linked to the restored token for that turn, so areas discovered by mistake do not stay visible.

---

### Module 4: Non-Blocking Table Tools (PixiJS v8 SceneGraph Overlay)

#### 4.1 Non-Blocking Multi-Point Ruler with 3D Elevation
- The `measureRulerWaypointsFt` function in `packages/web/src/canvas/SceneGraph.ts` computes the cumulative distance along a sequence of waypoints $P_i = (X_i, Y_i, Z_i)$ where $Z_i$ is `ElevationFt` in feet and $(X_i, Y_i)$ are world coordinates in feet (5 ft grid).
- Supported formulas between two consecutive points $A$ and $B$ (`RulerMetric`):
  1. **Euclidean**:
     $$\Delta X = |X_B - X_A|, \quad \Delta Y = |Y_B - Y_A|, \quad \Delta Z = |Z_B - Z_A|$$
     $$D = \sqrt{\Delta X^2 + \Delta Y^2 + \Delta Z^2}$$
  2. **5-5-5 (3D Chebyshev)**:
     $$D = \max(\Delta X, \Delta Y, \Delta Z)$$
  3. **5-10-5 (D&D 5e alternating diagonals with a 3D hypotenuse)**:
     Let the standard horizontal 2D distance be:
     $$D_{diag} = \min(\Delta X, \Delta Y), \quad D_{str} = \max(\Delta X, \Delta Y) - D_{diag}$$
     $$N_{diag} = \lfloor D_{diag} / 5.0 \rfloor$$
     $$D_{2D} = D_{str} + \lfloor N_{diag} / 2 \rfloor \times 15.0 + (N_{diag} \pmod 2) \times 5.0$$
     $$D_{3D} = \sqrt{D_{2D}^2 + \Delta Z^2}$$
- The ruler is rendered in `uiControlHud` at 60 FPS without a Preact update.

#### 4.2 Ephemeral Radar Pings (`PointerPing`)
- WHEN a user middle-clicks or long-presses with the `P` key, THEN `SceneGraph` intercepts the event and sends `ClientEnvelope::PointerPing { pos, color_hex }`.
- `TableRoomActor` broadcasts `ServerEnvelope::PointerPingBroadcast` to the clients without writing to the database.
- `SceneGraph` animates a circular radar-wave `PointerPing` sprite with exponential opacity decay over a fixed 1.5 seconds.

#### 4.3 Vector Strokes & Conversion to Physical Walls
- The `DrawingOverlay` vector drawing tool draws freehand segments or regular polygons.
- The stroke configuration includes the line width, the hexadecimal color, polygon closing (`is_closed`) and the `has_physical_walls` flag.
- WHEN the user finishes a stroke, THEN `DrawingOverlay` sends `CreateDrawing { drawing }`.
- WHEN `has_physical_walls` is `true`, THEN `TableRoomActor` extracts the stroke's line segments and inserts them as `WallSegment` entries in the `trame-engine` `Bvh2D` spatial tree (`AddWall`) with `blocks_movement: true`, `blocks_vision: true` and `blocks_sound: true`.
- `TableRoomActor` broadcasts the created drawing to every client for persistent display.

---

### Module 5: Spatial Audio Engine & WebAudio Acoustic Occlusion

#### 5.1 WebAudio Node Graph
For each sound emitter provisioned through `AudioEmitterConfig`, the `SpatialAudioManager` component creates the following audio chain:
```
[ AudioBufferSourceNode / HTMLMediaElement ]
                    │
                    ▼
            [ BiquadFilterNode ] (type: 'lowpass', occlusion computation)
                    │
                    ▼
            [ PannerNode ] (panningModel: 'HRTF', distanceModel: 'inverse')
                    │
                    ▼
            [ GainNode ] (master volume control)
                    │
                    ▼
        [ AudioContext.destination ]
```

#### 5.2 Emitter Provisioning & Lifecycle
- The table creates the emitters when the scene loads or when it receives `AudioEmitterUpserted { emitter }`.
- WHEN `TableRoomActor` removes an audio source, THEN it broadcasts `AudioEmitterRemoved { emitter_id }` and `SpatialAudioManager` releases the matching audio nodes.
- The global `AudioListener` follows the world coordinates and the elevation of the token controlled by the local player.

#### 5.3 Geometric Attenuation & 3D Hypotenuse
- The three-dimensional distance $d$ between the emitter $E$ and the listener $L$ includes the `ElevationFt` elevation:
  $$d = \sqrt{(X_E - X_L)^2 + (Y_E - Y_L)^2 + (Z_E - Z_L)^2}$$
- The free-field attenuation model applies the standard inverse rule with a reference distance $d_{ref}$ and a $rolloff$ factor:
  $$\text{Gain}(d) = \begin{cases} 1.0 & \text{if } d \le d_{ref} \\ \dfrac{d_{ref}}{d_{ref} + rolloff \times (d - d_{ref})} & \text{if } d > d_{ref} \end{cases}$$

#### 5.4 Acoustic Occlusion & Deterministic Cutoff Frequency (`AcousticOcclusion`)
- The audio loop runs a WASM acoustic raycast, throttled to 10 Hz, between the emitter and the listener.
- The raycast counts the physical wall segments crossed that have the `blocks_sound: true` flag ($N_{walls}$).
- The low-pass filter cutoff frequency `BiquadFilterNode.frequency.value` strictly follows the formula:
  $$f_{cutoff} = \frac{20000.0}{1.0 + 3.5 \times N_{walls}} \quad \text{(in Hertz)}$$
- **Strict reference values**:
  - $N_{walls} = 0 \implies f_{cutoff} = 20000.00 \text{ Hz}$ (no filtering).
  - $N_{walls} = 1 \implies f_{cutoff} = 4444.44 \text{ Hz}$.
  - $N_{walls} = 2 \implies f_{cutoff} = 2500.00 \text{ Hz}$.
  - $N_{walls} = 4 \implies f_{cutoff} = 1333.33 \text{ Hz}$.
- **Load limiting rule**: WHEN the number of sound emitters exceeds 16, THEN `SpatialAudioManager` applies the last computed frequency to the emitters ranked beyond 16th without running a new raycast.

---

## 5. Business Invariants & ASD-STE100 Rules

1. **Interruption authority invariant**: `TableRoomActor` is the single source of truth for reaction prompts. No client can resume a suspended move before the server has resolved the prompt.
2. **Action economy continuity invariant**: WHEN a Game Master undoes a token move, THEN `TableRoomActor` refunds movement speed exactly equal to the length of the undone move.
3. **Fog restoration invariant**: undoing a token move immediately revokes the vision cells revealed in `DualBufferFogOfWar` for that undone turn.
4. **Bounded audio concurrency invariant**: `SpatialAudioManager` never exceeds 16 acoustic raycasts per 100 ms attenuation cycle (10 Hz).
5. **Controlled vocabulary invariant**: the history drawer interface must be named `UndoDrawer` (`HistoryDrawer` is forbidden).

---

## 6. Deterministic TDD Test Plan (Node 24 `node:test` + `node:assert/strict`)

Unit tests run with the native Node 24 runner (`npm test` in `packages/web`) without real WebAudio hardware (a deterministic WebAudio mock is used).

### 6.1 Spatial Audio & Occlusion Tests (`packages/web/tests/audio.test.ts`)

#### Test 6.1.1: 3D Euclidean Distance with Elevation $\Delta Z$
- **Description**: compute the distance between an emitter at $(0, 0, 0)$ and a listener at $(30, 40, 120)$.
- **Assertion**: the computed distance is exactly $\sqrt{30^2 + 40^2 + 120^2} = \sqrt{900 + 1600 + 14400} = \sqrt{16900} = 130.00$ feet.

#### Test 6.1.2: Free-Field Acoustic Attenuation Gain
- **Description**: configure $d_{ref} = 10.0$, $rolloff = 1.0$ and distance $d = 50.0$.
- **Assertion**: the computed linear gain is exactly $\frac{10.0}{10.0 + 1.0 \times (50.0 - 10.0)} = \frac{10.0}{50.0} = 0.20$.

#### Test 6.1.3: Deterministic Low-Pass Cutoff Frequencies from Wall Occlusion
- **Description**: simulate 1, 2 and 4 interposed walls flagged `blocks_sound: true`.
- **Assertions**:
  - With 1 wall crossed, `BiquadFilterNode.frequency.value` is exactly `4444.44` Hz (rounded to 2 decimals).
  - With 2 walls crossed, `BiquadFilterNode.frequency.value` is exactly `2500.00` Hz (rounded to 2 decimals).
  - With 4 walls crossed, `BiquadFilterNode.frequency.value` is exactly `1333.33` Hz (rounded to 2 decimals).

#### Test 6.1.4: 16 Concurrent Emitter Load Ceiling
- **Description**: register 20 simultaneous audio emitters.
- **Assertion**: the WASM raycast dispatcher issues only 16 raycast requests per 100 ms interval, and the 4 remaining emitters keep their previous frequency value without throwing.

### 6.2 3D Ruler Tests (`packages/web/tests/ruler.test.ts`)

#### Test 6.2.1: 5-5-5 Metric (3D Chebyshev)
- **Description**: measure a waypoint segment from $(0, 0, 0)$ to $(15, 25, 40)$.
- **Assertion**: the returned distance is $\max(15, 25, 40) = 40.00$ feet.

#### Test 6.2.2: 5-10-5 Metric with a 3D Hypotenuse
- **Description**: measure a waypoint segment with $\Delta X = 10$, $\Delta Y = 10$, $\Delta Z = 20$.
- **Computation**: $D_{diag} = 10$, $N_{diag} = 2$. $D_{2D} = 15.0$ feet. $D_{3D} = \sqrt{15^2 + 20^2} = \sqrt{225 + 400} = 25.0$ feet.
- **Assertion**: `measureRulerWaypointsFt` returns exactly `25.00` feet.

#### Test 6.2.3: 3D Euclidean Metric
- **Description**: measure a segment from $(0, 0, 0)$ to $(6, 8, 24)$.
- **Assertion**: the returned distance is $\sqrt{36 + 64 + 576} = \sqrt{676} = 26.00$ feet.

### 6.3 Reaction Banner & Clock Tests (`packages/web/tests/hud.test.ts`)

#### Test 6.3.1: Banner Stays Open Until Resolution
- **Description**: mount `ReactionBanner` with an open reaction prompt and advance the clock by 10 seconds.
- **Assertion**: `ReactionBanner` stays mounted (there is no timer, decision G2).

#### Test 6.3.2: Immediate Resolution by a GM Action
- **Description**: simulate the GM forcing `Pass` on the open prompt.
- **Assertion**: the `ReactionBanner` component unmounts immediately.

### 6.4 1-Click Undo & Fog Restoration Tests (`packages/web/tests/undo.test.ts`)

#### Test 6.4.1: Token Move Undo & Economy Refund
- **Description**: simulate a 30-foot token move followed by an undo.
- **Assertion**: the token coordinates return to their previous position and the `Movement` budget (`ActionEconomyType`) is refunded by 30 feet.

#### Test 6.4.2: Transactional Fog Cache Invalidation
- **Description**: call `DualBufferFogOfWar.rollbackSnapshot(snapshot_id)` after undoing a move.
- **Assertion**: the pixels changed by the undone move in the GPU texture return to the unexplored value (0).
