# TRAME — Ubiquitous Domain Glossary (`GLOSSARY.md`)

All Rust crates (`crates/trame-engine`, `crates/trame-server`, `crates/trame-cli`), TypeScript/Preact packages (`packages/web`, `packages/game-systems/dnd5e`), SQL schemas, WebSocket payloads, and MCP tools MUST use these exact domain terms in English.

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

---

## 5. Controlled Technical Terms (ASD-STE100)

### AbilityModifier

- **Definition**: Integer value derived from an actor's ability score using the standard formula: `Math.floor((score - 10) / 2)`.
- **Allowed Context**: `AbilityModifier`, `ability modifier`, derived attribute evaluation.
- **_Avoid_**: `stat mod`, `ability bonus`.

### AbilityScore

- **Definition**: Integer value representing an actor's base or effective score for one of `str`, `dex`, `con`, `int`, `wis`, `cha`.
- **Allowed Context**: `AbilityScore`, `ability score`.
- **_Avoid_**: `stat`, `raw stat`.

### AcousticOcclusion

- **Definition**: Attenuation of sound high frequencies calculated via raycasting through walls with `blocks_sound: true`.
- **Allowed Context**: Spatial audio raycasting, emitter attenuation, and WebAudio filter updates.
- **_Avoid_**: SoundMuffling, WallAudioDamping.

### ActionEconomyType

- **Definition**: Categorization of an actor tactical resource pool (`Action`, `BonusAction`, `Reaction`, or `Movement`).
- **Allowed Context**: Combat turn management, HUD badges, and Game Master refunds.
- **_Avoid_**: TurnResource, ActionSlot, TokenAllowance.

### ActiveEffect

- **Definition**: Declarative mutation applied to a numeric or string actor property following the strict 5-phase order (`BASE_FORMULA` -> `ADD` -> `OVERRIDE_CONDITIONAL` -> `MULTIPLY` -> `FINAL_CLAMP`).
- **Allowed Context**: `ActiveEffect`, `active effect`, 5-phase modifier pipeline.
- **_Avoid_**: `buff`, `debuff`, `stat modifier`, `status effect`.

### Actor

- **Definition**: Game-world entity (player character, NPC, or monster) possessing persistent state, ability scores, inventory, and active effects.
- **Allowed Context**: `Actor`, `actor`.
- **_Avoid_**: `character`, `entity`, `token` (when referring to the persistent sheet record).

### AmbientPreset

- **Definition**: Environmental lighting and atmospheric configuration (`Daylight`, `Dusk`, `NightMoonlight`, `PitchDarkness`).
- **Allowed Context**: Map lighting configuration, Game Master override toolbar, and canvas rendering.
- **_Avoid_**: WeatherMode, LightingTheme, SkyboxPreset.

### CampaignHomebrew

- **Definition**: Top-priority compendium persistence tier storing custom entities and campaign-specific overrides, taking precedence over `INSTANCE_LIBRARY` and `SYSTEM_SRD`.
- **Allowed Context**: `CampaignHomebrew`, `campaign homebrew`.
- **_Avoid_**: `local homebrew`, `custom campaign data`.

### CampaignLobby

- **Definition**: Top-level authenticated Preact view where users create campaigns, inspect campaign rosters, generate 1-click Magic Link invites, and import/export `.trame` Archives before entering a live table room.
- **Allowed Context**: Browser navigation, campaign selection, and archive management.
- **_Avoid_**: DashboardPage, HomePortal, GameBrowser.

### CombatTracker

- **Definition**: HUD component displaying the combat turn order carousel, initiative values, and action economy badges.
- **Allowed Context**: Live table view and combat execution interfaces.
- **_Avoid_**: TurnTracker, InitiativeList, OrderBanner.

### CompendiumResolver

- **Definition**: Deterministic resolver evaluating entity lookup and search queries across the immutable priority cascade `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`.
- **Allowed Context**: `CompendiumResolver`, `compendium resolver`.
- **_Avoid_**: `compendium service`, `entity fetcher`.

### CompendiumTier

- **Definition**: Hierarchical storage layer within the compendium identified by `SYSTEM_SRD`, `INSTANCE_LIBRARY`, or `CAMPAIGN_HOMEBREW`.
- **Allowed Context**: `CompendiumTier`, `compendium tier`.
- **_Avoid_**: `compendium layer`, `compendium level`.

### ConcentrationCheckPrompt

- **Definition**: Interactive prompt emitted by the damage pipeline when a concentrating actor takes damage, with a Difficulty Class equal to `Math.max(10, Math.floor(damageTaken / 2))`.
- **Allowed Context**: `ConcentrationCheckPrompt`, `concentration check prompt`.
- **_Avoid_**: `concentration check`, `concentration save prompt`, `concentration DC`.

### Condition

- **Definition**: Standardized state affecting an actor (e.g., `blinded`, `charmed`, `unconscious`) paired with a duration in rounds and an expiration trigger.
- **Allowed Context**: `Condition`, `condition`.
- **_Avoid_**: `status`, `affliction`.

### CRDTDocument

- **Definition**: Conflict-free replicated document state backing collaborative campaign Markdown notes, partitioned between the authoritative Game Master channel and the role-filtered player snapshot channel.
- **Allowed Context**: Collaborative note synchronization and secret block stripping.
- **_Avoid_**: SharedPad, LiveDoc, NoteBuffer.

### DamageMitigation

- **Definition**: Ordered application of damage reduction and amplification modifiers following the strict sequence: `IMMUNE` (multiplier 0), then `RESISTANT` (multiplier 0.5 rounded down), then `VULNERABLE` (multiplier 2).
- **Allowed Context**: `DamageMitigation`, `damage mitigation`.
- **_Avoid_**: `mitigation`, `damage reduction`, `resistance pipeline`.

### DamageType

- **Definition**: Normalized SRD 5.1 damage category (`acid`, `bludgeoning`, `cold`, `fire`, `force`, `lightning`, `necrotic`, `piercing`, `poison`, `psychic`, `radiant`, `slashing`, `thunder`).
- **Allowed Context**: `DamageType`, `damage type`.
- **_Avoid_**: `element`, `damage category`.

### DeathSaveCounters

- **Definition**: Numerical pair recording character successes and failures on death saving throws (0 to 3 each).
- **Allowed Context**: Token character state, GM override popover, and character death mechanics.
- **_Avoid_**: DeathSavesState, BleedoutCounters, MortStatus.

### DeathSavingThrow

- **Definition**: Untyped d20 saving throw rolled by an unconscious actor at 0 HP at the start of their turn, tracking successes (`>= 10`) and failures (`< 10`, 2 failures on natural 1, regain 1 HP on natural 20).
- **Allowed Context**: `DeathSavingThrow`, `death saving throw`.
- **_Avoid_**: `death save`, `dying roll`.

### DerivedDAG

- **Definition**: Directed acyclic graph of declarative mathematical expressions evaluating computed actor properties without cycles or side effects.
- **Allowed Context**: `derivedDAG`, `DerivedDAG`.
- **_Avoid_**: `calculation formula`, `stat tree`, `dependency graph`.

### DirectiveBlock

- **Definition**: Fenced Markdown block (`:::dm` or `:::handout{id="..." title="..." revealed="..."}`) processed by `FilteredNoteDocument` to enforce server-side role stripping and handout reveal state.
- **Allowed Context**: Campaign wiki notes, GM secret blocks, and player handout reveals.
- **_Avoid_**: SpoilerTag, CalloutBox, SecretCallout.

### DrawingOverlay

- **Definition**: Canvas layer in PixiJS v8 SceneGraph capturing, rendering, and synchronizing vector annotations and physical boundaries.
- **Allowed Context**: Live table interaction tools and vector drawing replication.
- **_Avoid_**: PaintLayer, AnnotationCanvas, WhiteboardOverlay.

### ElevationFt

- **Definition**: Vertical spatial displacement coordinate expressed in integer feet along the Z axis relative to table zero level.
- **Allowed Context**: Token 3D positioning, 3D ruler calculations, and spatial audio listener offsets.
- **_Avoid_**: TokenHeight, Altitude, TokenElevation, VerticalLevel.

### GameSystemPack

- **Definition**: Standardized bundle of declarative manifests, data schemas, rule helpers, and compendiums encapsulating a tabletop RPG ruleset.
- **Allowed Context**: `GameSystemPack`, `game system pack`.
- **_Avoid_**: `system plugin`, `game module`, `ruleset`.

### GmOverrideToolbar

- **Definition**: Interactive control panel allowing the Game Master to modify token resources, refund actions, teleport tokens, change table modes, and cycle ambient presets.
- **Allowed Context**: Game Master view HUD.
- **_Avoid_**: AdminBar, CheatMenu, MasterPanel.

### InstantDeath

- **Definition**: SRD 5.1 rule triggering immediate character death when remaining damage after reaching 0 HP equals or exceeds the actor's maximum hit points (`hp.max`).
- **Allowed Context**: `InstantDeath`, `instant death`.
- **_Avoid_**: `massive damage death`, `overkill death`.

### InstanceLibrary

- **Definition**: Middle compendium tier storing game entities shared across all campaigns hosted on the same TRAME instance.
- **Allowed Context**: `InstanceLibrary`, `instance library`.
- **_Avoid_**: `instance compendium`, `shared library`.

### LongRest

- **Definition**: Extended rest period of at least 8 hours restoring all HP, resetting temporary HP to 0, restoring `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, reducing exhaustion by 1 level, and resetting all spell slots and long-rest resource pools.
- **Allowed Context**: `LongRest`, `long rest`.
- **_Avoid_**: `extended rest`, `full rest`.

### PointerPing

- **Definition**: Transient visual radar pulse rendered at spatial coordinates to direct participant attention.
- **Allowed Context**: Canvas interactive tools, peer synchronization, and audio cues.
- **_Avoid_**: RadarBeacon, MapMarker, PingPulse.

### PreactSignalState

- **Definition**: Reactive client state architecture in `packages/web` using `@preact/signals` to bind decoded MessagePack `ServerEnvelope` frames directly to Preact HUD text nodes and PixiJS v8 `SceneGraph` transforms without full-tree Virtual DOM reconciliation.
- **Allowed Context**: Web client state management, WebSocket frame dispatch, and HUD drawers.
- **_Avoid_**: ReduxStore, ZustandStore, ContextProviderTree.

### ProficiencyBonus

- **Definition**: Integer bonus determined by overall character level according to `Math.floor((level - 1) / 4) + 2`.
- **Allowed Context**: `ProficiencyBonus`, `proficiency bonus`.
- **_Avoid_**: `prof bonus`, `mastery bonus`.

### ProficiencyRank

- **Definition**: Integer multiplier of `0` (unproficient), `1` (proficient), or `2` (expertise) applied to the proficiency bonus for a skill or saving throw.
- **Allowed Context**: `ProficiencyRank`, `proficiency rank`.
- **_Avoid_**: `proficiency level`, `mastery rank`.

### ReactionBanner

- **Definition**: Authoritative HUD countdown banner that interrupts action movement interpolation for eligible reacting actors.
- **Allowed Context**: Movement interruption window and combat reaction declaration.
- **_Avoid_**: ReactionPopup, OpportunityModal, InterruptionWidget.

### ResourcePool

- **Definition**: Bounded numeric counter (`current`, `max`) paired with a recovery cadence (`SHORT_REST` or `LONG_REST`) tracking limited-use actor features.
- **Allowed Context**: `ResourcePool`, `resource pool`.
- **_Avoid_**: `feature counter`, `ability charge`, `resource tracker`.

### ReversiblePatch

- **Definition**: Transactional state modification record storing forward mutations and inverse rollback data.
- **Allowed Context**: Engine command stack, GM undo actions, and fog-of-war rollbacks.
- **_Avoid_**: UndoAction, DeltaState, MutationSnapshot.

### RulerMetric

- **Definition**: Algorithmic distance formula applied by the measuring ruler tool (`FiveFiveFive`, `FiveTenFive`, or `Euclidean`).
- **Allowed Context**: Canvas ruler overlays and spatial distance measurements.
- **_Avoid_**: DistanceSystem, GridMeasure, MeasurementRule.

### ShortRest

- **Definition**: Rest period of at least 1 hour allowing interactive hit dice expenditure to regain HP, recovery of Pact Magic slots, and reset of `SHORT_REST` resource pools.
- **Allowed Context**: `ShortRest`, `short rest`.
- **_Avoid_**: `quick rest`, `brief rest`.

### SpatialAudioManager

- **Definition**: Subsystem managing WebAudio node graphs, 3D sound listener orientation, emitter attenuation, and acoustic wall occlusion.
- **Allowed Context**: Web client audio pipeline and table sound playback.
- **_Avoid_**: SoundEngine, AudioDriver, SpatialMixer.

### SqlxPostgresStore

- **Definition**: Authoritative PostgreSQL 18 persistence adapter layer (`sqlx::PgPool`) in `trame-server` backing `WalStorage`, `SessionStore`, `CampaignStore`, `PartyJournalStorage`, and `TimelineStorage`.
- **Allowed Context**: Server persistence, SQL migrations, and production runtime wiring.
- **_Avoid_**: InMemoryProdStore, OrmAdapter, PrismaStore.

### SystemSRD

- **Definition**: Read-only baseline game reference data from the CC-BY-4.0 System Reference Document 5.1 bundled with the game system pack.
- **Allowed Context**: `SystemSRD`, `system SRD`.
- **_Avoid_**: `core compendium`, `builtin srd`.

### TableMode

- **Definition**: Global operational mode of the table distinguishing free Exploration from turn-by-turn combat.
- **Allowed Context**: Table state synchronization, top bar controls, and movement validation.
- **_Avoid_**: GameState, PlayPhase, TableStatus.

### TempHP

- **Definition**: Non-cumulative temporary hit points acting as a priority absorption buffer before damage is subtracted from current hit points.
- **Allowed Context**: `TempHP`, `temporary hit points`.
- **_Avoid_**: `HP shield`, `bonus HP`.

### ThreatReach

- **Definition**: Radial spatial perimeter within which an actor threatens adjacent hostile entities and triggers opportunity reactions upon exit.
- **Allowed Context**: Movement validation, reaction triggers, and token combat ranges.
- **_Avoid_**: MeleeRange, OpportunityZone, DangerArea.

### TimeSync

- **Definition**: Two-way timestamp ping-pong protocol estimating clock offset between client and server.
- **Allowed Context**: Network synchronization, reaction banner timers, and latency compensation.
- **_Avoid_**: ClockAlignment, NetworkNtp, TimeCorrection.

### TurnTrigger

- **Definition**: Combat cadence checkpoint (`ROUNDS`, `TURNS_START`, or `TURNS_END`) governing when an active `Condition` or `ActiveEffect` decrements its remaining duration.
- **Allowed Context**: Combat round progression, condition duration tracking, and turn transition hooks.
- **_Avoid_**: TickHook, PhaseTimer, ExpirationEvent.

### UndoDrawer

- **Definition**: Slide-out Game Master panel tracking the ring buffer of recent reversible actions with 1-click rollback execution.
- **Allowed Context**: Game Master HUD, action history inspection, and rollback execution.
- **_Avoid_**: HistorySidebar, RollbackPanel.
