<!-- EPURE GLOSSARY -->
# GLOSSARY

All Rust crates (`crates/trame-engine`, `crates/trame-server`, `crates/trame-cli`), TypeScript/React packages (`packages/web`, `packages/game-systems/dnd5e`), SQL schemas, WebSocket payloads, and MCP tools MUST use these exact domain terms in English.

### Actor
* Definition: An entity in the game world that possesses attributes, inventory, notes, and visual representations. The server persists actors in the database and streams actor state changes to connected clients.
* Avoid: character, entity, mob, NPC.

### Archive
* Definition: A compressed ZIP container file with the `.trame` extension. The file packages `manifest.json`, `database.jsonl`, notes in Markdown format, and assets in WebP format for campaign portability.
* Avoid: package, bundle, zip file, export file.

### Asset
* Definition: A binary media file stored in WebP format within the BlobStore or within the `assets/` directory of an Archive.
* Avoid: image, picture, texture, media file.

### BlobStore
* Definition: The storage abstraction trait that manages binary asset persistence across local filesystem storage (`LocalFsStore`) and cloud object storage (`S3Store`).
* Avoid: object storage, bucket, file store.

### Campaign
* Definition: The top-level administrative and organizational unit in TRAME that groups tables, scenes, actors, assets, notes, and user permissions.
* Avoid: game, world, adventure, module.

### Graceful Shutdown Sequence
* Definition: The deterministic termination procedure executed by `trame-server` upon receipt of a `SIGTERM` signal. The sequence terminates WebSocket loops, commits memory snapshots to persistent storage via `TableRoomHandle::hibernate()`, and closes database pools.
* Avoid: graceful hibernation sequence, server stop, quick shutdown.

### Identity Binding
* Definition: The cryptographic process that associates an existing guest player session record with a persistent credential record (Argon2id password hash or OAuth2 identity provider identifier) without altering the user identifier or character assignments.
* Avoid: account link, account linking, account merge, bind.

### Magic Link URL
* Definition: A single-use or scoped Uniform Resource Locator containing a signed JSON Web Token in the query parameter `?invite=<jwt>` that authenticates a player directly into an assigned Actor Sheet without preliminary credential registration.
* Avoid: invite link, magic URL, invite token, login link.

### Manifest
* Definition: The JSON file named `manifest.json` located at the root of an Archive. The file specifies format version, export timestamp, campaign metadata, and cryptographic SHA-256 digests for all archive entries.
* Avoid: header, descriptor, index.

### Personal Access Token
* Definition: A cryptographically random authentication token prefixed with `trame_pat_` that grants programmatic API and Model Context Protocol access scoped to specific campaign boundaries.
* Avoid: API key, bearer token, PAT.

### Room Lease
* Definition: A time-bounded memory lease managed by `RoomLeaseManager` that keeps active campaign table rooms hydrated in memory during client activity and triggers room hibernation after 15 minutes of inactivity.
* Avoid: session lease, table lease, idle timer.

- **`MCP Staging Mode`**: When `mcp_staging_mode = true`, destructive or bulk MCP tool calls queue as translucent purple ghost previews on the GM's canvas requiring `[ Commit All ]` or `[ Reject ]`.
- **`NoteVisibility`**: 3-tier note access (`PRIVATE` author-only, `PARTY` shared wiki, `DM_ONLY` GM lore with inline `:::dm` and revealable `:::handout` blocks).
- **`.trame` Archive**: A portable ZIP bundle (`manifest.json`, `database.jsonl`, `notes/`, `assets/`) allowing 1-click full campaign migration between local Docker, `e2-micro`, and Cloud Run + Neon + R2.

---

## 5. Controlled Technical Terms (ASD-STE100)

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

- **Definition**: Global operational mode of the table distinguishing free Exploration from turn-by-turn combat.

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

- **Allowed Context**: Game Master HUD, table history drawer, and transaction rollback interfaces.

- **_Avoid_**: HistoryDrawer, RollbackPanel, UndoList.

### AbilityModifier
- **Definition**: Integer value derived from an actor's ability score using the standard formula: `Math.floor((score - 10) / 2)`.
- **Allowed**: `AbilityModifier`, `ability modifier`
- **Avoid**: `stat mod`, `ability bonus`

### AbilityScore
- **Definition**: Integer value representing an actor's base or effective score for one of `str`, `dex`, `con`, `int`, `wis`, `cha`.
- **Allowed**: `AbilityScore`, `ability score`
- **Avoid**: `stat`, `raw stat`

### ActiveEffect
- **Definition**: Declarative mutation applied to a numeric or string actor property following the strict 5-phase order (`BASE_FORMULA` -> `ADD` -> `OVERRIDE_CONDITIONAL` -> `MULTIPLY` -> `FINAL_CLAMP`).
- **Allowed**: `ActiveEffect`, `active effect`
- **Avoid**: `buff`, `debuff`, `stat modifier`, `status effect`

### Actor
- **Definition**: Game-world entity (player character, NPC, or monster) possessing persistent state, ability scores, inventory, and active effects.
- **Allowed**: `Actor`, `actor`
- **Avoid**: `character`, `entity`, `token`

### CampaignHomebrew
- **Definition**: Top-priority compendium persistence tier storing custom entities and campaign-specific overrides, taking precedence over `INSTANCE_LIBRARY` and `SYSTEM_SRD`.
- **Allowed**: `CampaignHomebrew`, `campaign homebrew`
- **Avoid**: `local homebrew`, `custom campaign data`

### CompendiumResolver
- **Definition**: Deterministic resolver evaluating entity lookup and search queries across the immutable priority cascade `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`.
- **Allowed**: `CompendiumResolver`, `compendium resolver`
- **Avoid**: `compendium service`, `entity fetcher`

### CompendiumTier
- **Definition**: Hierarchical storage layer within the compendium identified by `SYSTEM_SRD`, `INSTANCE_LIBRARY`, or `CAMPAIGN_HOMEBREW`.
- **Allowed**: `CompendiumTier`, `compendium tier`
- **Avoid**: `compendium layer`, `compendium level`

### ConcentrationCheckPrompt
- **Definition**: Interactive prompt emitted by the damage pipeline when a concentrating actor takes damage, with a Difficulty Class equal to `Math.max(10, Math.floor(damageTaken / 2))`.
- **Allowed**: `ConcentrationCheckPrompt`, `concentration check prompt`
- **Avoid**: `concentration check`, `concentration save prompt`, `concentration DC`

### Condition
- **Definition**: Standardized state affecting an actor (e.g., `blinded`, `charmed`, `unconscious`) paired with a duration in rounds and an expiration trigger.
- **Allowed**: `Condition`, `condition`
- **Avoid**: `status`, `affliction`

### DamageMitigation
- **Definition**: Ordered application of damage reduction and amplification modifiers following the strict sequence: `IMMUNE` (multiplier 0), then `RESISTANT` (multiplier 0.5 rounded down), then `VULNERABLE` (multiplier 2).
- **Allowed**: `DamageMitigation`, `damage mitigation`
- **Avoid**: `mitigation`, `damage reduction`, `resistance pipeline`

### DamageType
- **Definition**: Normalized SRD 5.1 damage category (`acid`, `bludgeoning`, `cold`, `fire`, `force`, `lightning`, `necrotic`, `piercing`, `poison`, `psychic`, `radiant`, `slashing`, `thunder`).
- **Allowed**: `DamageType`, `damage type`
- **Avoid**: `element`, `damage category`

### DeathSavingThrow
- **Definition**: Untyped d20 saving throw rolled by an unconscious actor at 0 HP at the start of their turn, tracking successes (`>= 10`) and failures (`< 10`, 2 failures on natural 1, regain 1 HP on natural 20).
- **Allowed**: `DeathSavingThrow`, `death saving throw`
- **Avoid**: `death save`, `dying roll`

### DerivedDAG
- **Definition**: Directed acyclic graph of declarative mathematical expressions evaluating computed actor properties without cycles or side effects.
- **Allowed**: `derivedDAG`, `DerivedDAG`
- **Avoid**: `calculation formula`, `stat tree`, `dependency graph`

### GameSystemPack
- **Definition**: Standardized bundle of declarative manifests, data schemas, rule helpers, and compendiums encapsulating a tabletop RPG ruleset.
- **Allowed**: `GameSystemPack`, `game system pack`
- **Avoid**: `system plugin`, `game module`, `ruleset`

### InstantDeath
- **Definition**: SRD 5.1 rule triggering immediate character death when remaining damage after reaching 0 HP equals or exceeds the actor's maximum hit points (`hp.max`).
- **Allowed**: `InstantDeath`, `instant death`
- **Avoid**: `massive damage death`, `overkill death`

### InstanceLibrary
- **Definition**: Middle compendium tier storing game entities shared across all campaigns hosted on the same TRAME instance.
- **Allowed**: `InstanceLibrary`, `instance library`
- **Avoid**: `instance compendium`, `shared library`

### LongRest
- **Definition**: Extended rest period of at least 8 hours restoring all HP, resetting temporary HP to 0, restoring `Math.max(1, Math.floor(hitDiceMax / 2))` hit dice, reducing exhaustion by 1 level, and resetting all spell slots and long-rest resource pools.
- **Allowed**: `LongRest`, `long rest`
- **Avoid**: `extended rest`, `full rest`

### ProficiencyBonus
- **Definition**: Integer bonus determined by overall character level according to `Math.floor((level - 1) / 4) + 2`.
- **Allowed**: `ProficiencyBonus`, `proficiency bonus`
- **Avoid**: `prof bonus`, `mastery bonus`

### ProficiencyRank
- **Definition**: Integer multiplier of `0` (unproficient), `1` (proficient), or `2` (expertise) applied to the proficiency bonus for a skill or saving throw.
- **Allowed**: `ProficiencyRank`, `proficiency rank`
- **Avoid**: `proficiency level`, `mastery rank`

### ResourcePool
- **Definition**: Bounded numeric counter (`current`, `max`) paired with a recovery cadence (`SHORT_REST` or `LONG_REST`) tracking limited-use actor features.
- **Allowed**: `ResourcePool`, `resource pool`
- **Avoid**: `feature counter`, `ability charge`, `resource tracker`

### ShortRest
- **Definition**: Rest period of at least 1 hour allowing interactive hit dice expenditure to regain HP, recovery of Pact Magic slots, and reset of `SHORT_REST` resource pools.
- **Allowed**: `ShortRest`, `short rest`
- **Avoid**: `quick rest`, `brief rest`

### SystemSRD
- **Definition**: Read-only baseline game reference data from the CC-BY-4.0 System Reference Document 5.1 bundled with the game system pack.
- **Allowed**: `SystemSRD`, `system SRD`
- **Avoid**: `core compendium`, `builtin srd`

### TempHP
- **Definition**: Non-cumulative temporary hit points acting as a priority absorption buffer before damage is subtracted from current hit points.
- **Allowed**: `TempHP`, `temporary hit points`
- **Avoid**: `HP shield`, `bonus HP`

### TurnTrigger
- **Definition**: Combat turn lifecycle hook (such as START_OF_TURN or END_OF_TURN) evaluated during initiative progression to process condition durations, ongoing saving throws, and resource resets.
- **Allowed**: `TurnTrigger`, `turn trigger`
- **Avoid**: `initiative phase`, `round tick`
