# TRAME — Ubiquitous Domain Glossary (`GLOSSARY.md`)

All Rust crates (`crates/trame-engine`, `crates/trame-server`, `crates/trame-cli`), TypeScript/React packages (`packages/web`, `packages/game-systems/dnd5e`), SQL schemas, WebSocket payloads, and MCP tools MUST use these exact domain terms.

---

## 1. Core Architectural Primitives

- **`TrameCommand`**: The single canonical CQRS command enum representing every possible mutation on a campaign or table (e.g., `MoveToken`, `ToggleDoor`, `ProjectAoE`, `ApplyDamage`, `RevealHandout`). Dispatched identically from the WebSocket client, REST API, or MCP tools.
- **`TrameEvent`**: An immutable domain event emitted after a `TrameCommand` passes RBAC and spatial/rule validation, broadcast to connected clients (filtered per player visibility) and appended to the session timeline.
- **`UndoEntry`**: A compensating state delta generated alongside every `TrameCommand` execution, pushed onto the per-map 50-action ring buffer so the GM can revert mistakes in 1 click (`Cmd+Z`).
- **`TableRoomActor`**: The single-owner Tokio actor in `trame-server` holding the authoritative live state of an active campaign in RAM (`Arc<RwLock<CampaignRoomState>>`).
- **`Idle-Lease`**: The 15-minute inactivity timer tracking exclusively human/MCP mutations (`TrameCommand`, dice rolls, note edits) while ignoring WebSocket Ping/Pong keep-alives, allowing Cloud Run instances to cleanly snapshot and scale to `0`.

---

## 2. Spatial & Table Primitives (`01-TABLE-SPEC.md`)

- **`Exploration Mode` vs. `Turn-by-Turn Mode`**: The two table movement regimes. Exploration uses continuous server-interpolated movement (120ms tick) with instant GM freeze (`Spacebar`) and automatic trap/LoS stops; Turn-by-Turn enforces initiative order, movement budgets (`speed_remaining`), and reaction pauses.
- **`BVH` (Bounding Volume Hierarchy)**: The 2D/2.5D spatial acceleration structure in `trame-engine` used for sub-millisecond raycasting, wall collision, and AoE clipping.
- **`WallSegment`**: A barrier on the map defined by its geometry and independent permeability flags (`blocks_movement`, `blocks_vision`, `blocks_light`, `blocks_sound`), height (`bottom_elevation_ft`, `top_elevation_ft`), and `WallKind` (`Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, `Illusion`).
- **`VisibilityChannel`**: Bitmask (`MATERIAL = 0b001`, `ETHEREAL = 0b010`, `GM_HIDDEN = 0b100`) governing which tokens and lights a viewer can perceive, combined with overhead `RoofPolygon` auto-occluders.
- **`SenseProfile`**: A token's sensory capabilities (`normal_range`, `darkvision_range`, `blindsight_range`, `tremorsense_range`, `truesight_range`, `devils_sight`, `see_invisibility`) evaluated against `WallSegment` and `LightSource` rules.
- **`FogLayer`**: The 3-tier fog of war system: Layer 0 (`Unexplored` opaque black), Layer 1 (`Explored Memory` desaturated static terrain snapshot stored per-player in R2/Postgres, hiding live enemy tokens), and Layer 2 (`GM Manual Fog` override).
- **`AoETemplate`**: A geometric projection (`Sphere`, `Cone`, `Cube`, `Line`, `Cylinder`) clipped against `BVH` walls (`stops_at_walls`) and discretized onto the grid (`CENTER_POINT`, `FIFTY_PERCENT`, `ANY_INTERSECTION`, `TOKEN_EUCLIDEAN`), either Instantaneous or Persistent (`Zone` linked to caster concentration).

---

## 3. Game Engine & Rules Primitives (`02-GAME-ENGINE-AND-DND5E.md`)

- **`GameSystemPack`**: A declarative manifest (`system.json` + JSON Schemas + `derivedDAG` + `sheetLayout` + compendium packs) defining a tabletop RPG system without hardcoding game rules in the server binary.
- **`derivedDAG`**: The topological directed acyclic graph of pure mathematical expressions (`trame-engine`) computing derived actor attributes (e.g., ability modifiers, AC, spell save DC) in deterministic order.
- **`ActiveEffect`**: A buff, condition, feat, or equipped item modifier evaluated through the strict 5-phase pipeline: `BASE` -> `ADD` -> `MULTIPLY` -> `OVERRIDE` -> `CLAMP`, obeying same-source non-stacking rules.
- **`VisibilityTier`**: Field-level RBAC on actor sheets (`PUBLIC`, `OWNER_AND_GM`, `GM_ONLY`). Server snapshots strip unauthorized fields before serialization.

---

## 4. MCP, Notes & Storage (`03-MCP-AND-NOTES-SPEC.md`, `04-RUNTIME-AND-DEDICATED-HOSTING.md`)

- **`MCP Staging Mode`**: When `mcp_staging_mode = true`, destructive or bulk MCP tool calls queue as translucent purple ghost previews on the GM's canvas requiring `[ Commit All ]` or `[ Reject ]`.
- **`NoteVisibility`**: 3-tier note access (`PRIVATE` author-only, `PARTY` shared wiki, `DM_ONLY` GM lore with inline `:::dm` and revealable `:::handout` blocks).
- **`.trame` Archive**: A portable ZIP bundle (`manifest.json`, `database.jsonl`, `notes/`, `assets/`) allowing 1-click full campaign migration between local Docker, `e2-micro`, and Cloud Run + Neon + R2.

- **Definition**: Attenuation of sound high frequencies calculated via raycasting through walls with `blocks_sound: true`.

- **Allowed Context**: Spatial audio processing and WebAudio filter graphs.

- **_Avoid_**: SoundMuffling, AudioBlocking, AcousticShadow.

### ActionEconomyType

- **Definition**: Categorization of an actor tactical resource pool (`Action`, `BonusAction`, `Reaction`, or `Movement`).

- **Allowed Context**: Combat turn management, HUD badges, and Game Master refunds.

- **_Avoid_**: TurnResource, ActionSlot, TokenAllowance.

### AmbientPreset

- **Definition**: Environmental lighting and atmospheric configuration (`Daylight`, `Dusk`, `NightMoonlight`, `PitchDarkness`).

- **Allowed Context**: Lighting shader uniforms, SceneGraph render passes, and GM override controls.

- **_Avoid_**: TimeOfDay, LightSetting, MoodPreset.

### CombatTracker

- **Definition**: HUD component displaying the combat turn order carousel, initiative values, and action economy badges.

- **Allowed Context**: Live table view and combat execution interfaces.

- **_Avoid_**: TurnTracker, InitiativeList, OrderBanner.

### DeathSaveCounters

- **Definition**: Numerical pair recording character successes and failures on death saving throws (0 to 3 each).

- **Allowed Context**: Token character state, GM override popover, and character death mechanics.

- **_Avoid_**: DeathSavesState, BleedoutCounters, MortStatus.

### DrawingOverlay

- **Definition**: Canvas layer in PixiJS v8 SceneGraph capturing, rendering, and synchronizing vector annotations and physical boundaries.

- **Allowed Context**: Live table interaction tools and vector drawing replication.

- **_Avoid_**: PaintLayer, AnnotationCanvas, WhiteboardOverlay.

### ElevationFt

- **Definition**: Vertical spatial displacement coordinate expressed in integer feet along the Z axis relative to table zero level.

- **Allowed Context**: Token 3D positioning, 3D ruler calculations, and spatial audio listener offsets.

- **_Avoid_**: TokenHeight, Altitude, TokenElevation, VerticalLevel.

### GmOverrideToolbar

- **Definition**: Interactive control panel allowing the Game Master to modify token resources, refund actions, teleport tokens, change table modes, and cycle ambient presets.

- **Allowed Context**: Game Master view HUD.

- **_Avoid_**: AdminBar, CheatMenu, MasterPanel.

### PointerPing

- **Definition**: Transient visual radar pulse rendered at spatial coordinates to direct participant attention.

- **Allowed Context**: Canvas interactive tools, peer synchronization, and audio cues.

- **_Avoid_**: RadarBeacon, MapMarker, PingPulse.

### ReactionBanner

- **Definition**: Authoritative HUD countdown banner that interrupts action movement interpolation for eligible reacting actors.

- **Allowed Context**: Movement interruption window and combat reaction declaration.

- **_Avoid_**: ReactionPopup, OpportunityModal, InterruptionWidget.

### ReversiblePatch

- **Definition**: Transactional state modification record storing forward mutations and inverse rollback data.

- **Allowed Context**: Engine command stack, GM undo actions, and fog-of-war rollbacks.

- **_Avoid_**: UndoAction, DeltaState, MutationSnapshot.

### RulerMetric

- **Definition**: Algorithmic distance formula applied by the measuring ruler tool (`FiveFiveFive`, `FiveTenFive`, or `Euclidean`).

- **Allowed Context**: Canvas ruler overlays and spatial distance measurements.

- **_Avoid_**: DistanceSystem, GridMeasure, MeasurementRule.

### SpatialAudioManager

- **Definition**: Subsystem managing WebAudio node graphs, 3D sound listener orientation, emitter attenuation, and acoustic wall occlusion.

- **Allowed Context**: Web client audio pipeline and table sound playback.

- **_Avoid_**: SoundEngine, AudioDriver, SpatialMixer.

### TableMode

- **Definition**: Global operational operational mode of the table distinguishing free Exploration from turn-by-turn combat.

- **Allowed Context**: Table state synchronization, top bar controls, and movement validation.

- **_Avoid_**: GameState, PlayPhase, TableStatus.

### ThreatReach

- **Definition**: Radial spatial perimeter within which an actor threatens adjacent hostile entities and triggers opportunity reactions upon exit.

- **Allowed Context**: Movement validation, reaction triggers, and token combat ranges.

- **_Avoid_**: MeleeRange, OpportunityZone, DangerArea.

### TimeSync

- **Definition**: Two-way timestamp ping-pong protocol estimating clock offset between client and server.

- **Allowed Context**: Network synchronization, reaction banner timers, and latency compensation.

- **_Avoid_**: ClockAlignment, NetworkNtp, TimeCorrection.

### UndoDrawer

- **Definition**: Game Master history drawer displaying recent table mutations and triggering single-click rollbacks.

- **Allowed Context**: Game Master override controls and mutation inspection.

- **_Avoid_**: HistoryDrawer, RollbackPanel, UndoHistoryModal.
