# Lexique EPURE (GLOSSARY.md)

Ce document définit les termes métier et techniques officiels du projet TRAME selon la norme de rédaction contrôlée ASD-STE100 (ADR-0031).
Chaque entrée respecte un principe de bijection sémantique stricte : un concept unique correspond à un terme unique.
L'utilisation des termes listés sous _Avoid_ est formellement prohibée.

---

### AcousticOcclusion
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
