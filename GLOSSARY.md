# Glossaire EPURE & TRAME

All Rust crates (`crates/trame-engine`, `crates/trame-server`, `crates/trame-cli`), TypeScript/React packages (`packages/web`, `packages/game-systems/dnd5e`), SQL schemas, WebSocket payloads, and MCP tools MUST use these exact domain terms in English.

---

### Companion Mode (Mode Compagnon)
- **Definition**: Interface utilisateur tactile allégée dédiée aux terminaux mobiles et tablettes dont la largeur d'affichage est strictement inférieure à 768 pixels, désactivant le moteur de rendu WebGL pour préserver l'autonomie et les performances.
- **Avoid**: Mobile view, Lite app, Responsive fallback, Phone skin.

### CRDT (Conflict-free Replicated Data Type)
- **Definition**: Structure de données répliquée sans conflit (Yjs côté client, `yrs` côté serveur) garantissant la convergence mathématique d'un document texte partagé entre plusieurs pairs sans verrou distribué.
- **Avoid**: Real-time sync engine, Operational Transform, Delta merge.

### Directive Block (Bloc Directive)
- **Definition**: Bloc de syntaxe Markdown délimité par des triples deux-points `:::nom{cle="valeur"}` interprété par le compilateur AST pour encapsuler des éléments interactifs ou filtrés (`:::handout`, `:::dm`).
- **Avoid**: Shortcode, Custom tag, Special markup, Admonition.

### Handout (Document à Révéler)
- **Definition**: Artefact textuel ou visuel secret rédigé par le Maître de Jeu dans une note, possédant un identifiant unique, conservé secret jusqu'à son action explicite de révélation à l'ensemble des joueurs.
- **Avoid**: Secret clue, Player reveal, Clue card, Public paper.

### Handout Reveal Modal (Modal de Révélation)
- **Definition**: Composant d'interface s'affichant en superposition plein écran sur tous les clients connectés lorsqu'un Maître de Jeu diffuse l'événement de révélation d'un Handout.
- **Avoid**: Popup, Dialog window, Handout lightbox, Alert box.

### MobileCompanionLayout
- **Definition**: Coquille d'interface racine montée lorsque la largeur d'écran est strictement inférieure à 768 pixels, intégrant une barre de navigation inférieure à quatre onglets tactiles (`Sheet`, `Dice`, `Inventory`, `Journal`).
- **Avoid**: MobileShell, SmallScreenLayout, TabContainer.

### Party Journal (Journal de Groupe)
- **Definition**: Document textuel ou registre centralisé de notes partagé entre tous les participants d'une campagne, archivant de manière permanente les événements et Handouts révélés.
- **Avoid**: Group log, Campaign diary, Shared notebook, Quest log.

### Public Snapshot (Instantané Public)
- **Definition**: Représentation textuelle Markdown assainie et purgée de tout bloc secret (`:::dm` et `:::handout{revealed="false"}`), diffusée par `trame-server` aux clients non-MJ via WebSocket.
- **Avoid**: Sanitized content, Public markdown, Filtered copy.

### Session Timeline (Chronologie de Session)
- **Definition**: Flux d'événements append-only ordonné de manière strictement croissante par `seq_id`, indexé par `campaign_id` et `session_num`, retraçant l'ensemble des actions vérifiables d'une séance de jeu.
- **Avoid**: Game history, Event stream, Activity feed, Audit trail.

### TableCanvas
- **Definition**: Composant applicatif lourd montant le viewport de table virtuelle, initialisant l'instance PixiJS, les nuanceurs d'éclairage dynamique et les Framebuffer Objects (FBO) WebGL.
- **Avoid**: GameMap, BoardView, PixiContainer, CanvasRenderer.

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
