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

### Wiki Autocomplete (Complétion Wiki)

- **Definition**: Mécanisme de suggestion textuelle déclenché par la saisie de doubles crochets `[[` permettant d'insérer des hyperliens internes vers des acteurs, lieux ou objets du compendium.

- **Avoid**: Wiki link popup, Entity suggester, Smart mention, Quick search.
