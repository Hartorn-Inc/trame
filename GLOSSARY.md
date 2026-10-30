# TRAME — Ubiquitous Domain Glossary (`GLOSSARY.md`)

All Rust crates (`crates/trame-engine`, `crates/trame-server`, `crates/trame-cli`), TypeScript/React packages (`packages/web`, `packages/game-systems/dnd5e`), SQL schemas, WebSocket payloads, and MCP tools MUST use these exact domain terms in English.

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
- **Definition**: Combat phase evaluation point (`ROUNDS`, `TURNS_START`, `TURNS_END`) governing when active condition durations decrement.
- **Allowed**: `TurnTrigger`, `turn trigger`
- **Avoid**: `initiative phase`, `round tick`

## Terms

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

### Table Room
* Definition: The in-memory actor synchronization unit managed by `TableRoomHandle` that coordinates real-time WebSocket state distribution for a single active campaign table.
* Avoid: game room, channel, table session.

### TOTP Secret
* Definition: A 160-bit shared secret key used for Time-based One-Time Password multi-factor authentication (RFC 6238). The server encrypts the secret at rest using AES-256-GCM before database insertion.
* Avoid: MFA key, 2FA secret, auth code.
