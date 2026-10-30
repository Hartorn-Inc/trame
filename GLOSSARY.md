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

- **Definition**: Valeur numérique entière dérivée du score de caractéristique d'un acteur selon la formule standard : `Math.floor((score - 10) / 2)`.

- **Allowed**: `AbilityModifier`, `modificateur de caractéristique`

- **Avoid**: `bonus de carac`, `stat mod`, `carac bonus`

### AbilityScore

- **Definition**: Valeur numérique entière représentant le score de base ou effectif d'un acteur pour une caractéristique parmi `str`, `dex`, `con`, `int`, `wis`, `cha`.

- **Allowed**: `AbilityScore`, `score de caractéristique`

- **Avoid**: `stat`, `statistique`, `caractéristique brute`

### ActiveEffect

- **Definition**: Mutation déclarative appliquée à une propriété numérique ou textuelle d'un acteur selon l'ordre strict des 5 phases (`BASE_FORMULA` -> `ADD` -> `OVERRIDE_CONDITIONAL` -> `MULTIPLY` -> `FINAL_CLAMP`).

- **Allowed**: `ActiveEffect`, `effet actif`

- **Avoid**: `buff`, `debuff`, `stat modifier`, `status effect`

### Actor

- **Definition**: Entité du monde de jeu (personnage-joueur, PNJ ou monstre) possédant un état persistant, des caractéristiques, un inventaire et des effets actifs.

- **Allowed**: `Actor`, `acteur`

- **Avoid**: `personnage`, `entité`, `token`

### CampaignHomebrew

- **Definition**: Niveau supérieur de persistance du compendium stockant les entités personnalisées et les surcharges spécifiques à une campagne de jeu, prioritaire sur `INSTANCE_LIBRARY` et `SYSTEM_SRD`.

- **Allowed**: `CampaignHomebrew`, `compendium de campagne`

- **Avoid**: `homebrew local`, `custom campaign data`

### CompendiumResolver

- **Definition**: Composant déterministe résolvant les requêtes de recherche et d'accès aux entités de jeu selon la cascade prioritaire immuable `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`.

- **Allowed**: `CompendiumResolver`, `résolveur de compendium`

- **Avoid**: `compendium service`, `entity fetcher`

### CompendiumTier

- **Definition**: Couche de stockage hiérarchique au sein du compendium identifiée par l'une des valeurs : `SYSTEM_SRD`, `INSTANCE_LIBRARY` ou `CAMPAIGN_HOMEBREW`.

- **Allowed**: `CompendiumTier`, `niveau de compendium`

- **Avoid**: `compendium layer`, `compendium level`

### ConcentrationCheckPrompt

- **Definition**: Intention interactive générée par le pipeline de dégâts lorsqu'un acteur subit des dégâts alors qu'il maintient un sort sous concentration, avec un Degré de Difficulté (DD) égal à `Math.max(10, Math.floor(damageTaken / 2))`.

- **Allowed**: `ConcentrationCheckPrompt`, `invite de jet de concentration`

- **Avoid**: `concentration check`, `concentration save prompt`, `concentration DC`

### Condition

- **Definition**: État standardisé affectant un acteur (ex: `blinded`, `charmed`, `unconscious`) associé à une durée en rounds et à un déclencheur d'expiration.

- **Allowed**: `Condition`, `état`

- **Avoid**: `statut`, `altération d'état`, `affliction`

### DamageMitigation

- **Definition**: Application ordonnée des modificateurs de réduction et d'amplification de dégâts selon la séquence stricte : `IMMUNE` (multiplicateur 0), puis `RESISTANT` (multiplicateur 0.5 avec arrondi inférieur), puis `VULNERABLE` (multiplicateur 2).

- **Allowed**: `DamageMitigation`, `atténuation de dégâts`

- **Avoid**: `mitigation`, `damage reduction`, `resistance pipeline`

### DamageType

- **Definition**: Catégorie de dégâts normalisée du SRD 5.1 (`acid`, `bludgeoning`, `cold`, `fire`, `force`, `lightning`, `necrotic`, `piercing`, `poison`, `psychic`, `radiant`, `slashing`, `thunder`).

- **Allowed**: `DamageType`, `type de dégâts`

- **Avoid**: `élément`, `damage category`

### DeathSavingThrow

- **Definition**: Jet de sauvegarde d20 sans caractéristique exécuté par un acteur inconscient à 0 PV au début de son tour, cumulant succès (seuil >= 10) et échecs (seuil < 10, double échec sur 1 naturel, reprise à 1 PV sur 20 naturel).

- **Allowed**: `DeathSavingThrow`, `jet de sauvegarde contre la mort`

- **Avoid**: `death save`, `jet de mort`

### DerivedDAG

- **Definition**: Graphe orienté acyclique d'expressions mathématiques déclaratives évaluant les propriétés calculées de l'acteur sans cycle ni effet de bord.

- **Allowed**: `derivedDAG`, `DAG dérivé`

- **Avoid**: `formule de calcul`, `stat tree`, `dependency graph`

### GameSystemPack

- **Definition**: Ensemble standardisé de manifestes déclaratifs, de schémas de données, de helpers métier et de compendiums encapsulant les règles d'un système de jeu de rôle spécifique.

- **Allowed**: `GameSystemPack`, `pack système`

- **Avoid**: `system plugin`, `game module`, `ruleset`

### InstantDeath

- **Definition**: Règle du SRD 5.1 déclenchant la mort définitive et irréversible d'un acteur lorsque le surplus de dégâts subis après passage à 0 PV est supérieur ou égal à ses PV maximaux (`hp.max`).

- **Allowed**: `InstantDeath`, `mort instantanée`

- **Avoid**: `massive damage death`, `overkill death`

### InstanceLibrary

- **Definition**: Niveau intermédiaire de compendium stockant les données de jeu partagées entre les campagnes hébergées sur une même instance TRAME.

- **Allowed**: `InstanceLibrary`, `bibliothèque d'instance`

- **Avoid**: `instance compendium`, `shared library`

### LongRest

- **Definition**: Période de repos prolongée d'au moins 8 heures restaurant tous les PV, réinitialisant les PV temporaires à 0, restaurant `Math.max(1, Math.floor(hitDiceMax / 2))` dés de vie, réduisant l'épuisement d'un niveau et réinitialisant tous les emplacements de sorts et réserves de ressources.

- **Allowed**: `LongRest`, `repos long`

- **Avoid**: `extended rest`, `full rest`

### ProficiencyBonus

- **Definition**: Bonus numérique entier déterminé par le niveau global du personnage selon la formule déclarative : `Math.floor((level - 1) / 4) + 2`.

- **Allowed**: `ProficiencyBonus`, `bonus de maîtrise`

- **Avoid**: `prof bonus`, `mastery bonus`

### ProficiencyRank

- **Definition**: Multiplicateur numérique entier valant 0 (non maîtrisé), 1 (maîtrisé) ou 2 (expertise) appliqué au bonus de maîtrise pour une compétence ou un jet de sauvegarde.

- **Allowed**: `ProficiencyRank`, `rang de maîtrise`

- **Avoid**: `proficiency level`, `mastery rank`

### ResourcePool

- **Definition**: Compteur numérique borné (`current`, `max`) associé à une fréquence de réinitialisation (`SHORT_REST` ou `LONG_REST`) gérant les capacités limitées d'un acteur.

- **Allowed**: `ResourcePool`, `réserve de ressource`

- **Avoid**: `feature counter`, `ability charge`, `resource tracker`

### ShortRest

- **Definition**: Période de repos court d'au moins 1 heure permettant la dépense interactive de dés de vie pour regagner des PV, la récupération des emplacements de magie de pacte et la réinitialisation des réserves de ressources configurées sur `SHORT_REST`.

- **Allowed**: `ShortRest`, `repos court`

- **Avoid**: `quick rest`, `brief rest`

### SystemSRD

- **Definition**: Données de référence de base du système de jeu issues du System Reference Document 5.1 sous licence CC-BY-4.0, distribuées en lecture seule et intégrées au pack système.

- **Allowed**: `SystemSRD`, `SRD système`

- **Avoid**: `core compendium`, `builtin srd`

### TempHP

- **Definition**: Points de vie temporaires non cumulatifs servant de réserve d'absorption prioritaire avant déduction des dégâts sur les points de vie courants de l'acteur.

- **Allowed**: `TempHP`, `PV temporaires`

- **Avoid**: `temporary hit points`, `bouclier de PV`

### TurnTrigger

- **Definition**: Point d'ancrage temporel dans le cycle d'un tour de combat (`START_OF_TURN` ou `END_OF_TURN`) déclenchant l'évaluation des jets de sauvegarde et la décrémentation des durées d'états.

- **Allowed**: `TurnTrigger`, `déclencheur de tour`

- **Avoid**: `phase d'initiative`, `round tick`

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

### Wiki Autocomplete (Complétion Wiki)
- **Definition**: Mécanisme de suggestion textuelle déclenché par la saisie de doubles crochets `[[` permettant d'insérer des hyperliens internes vers des acteurs, lieux ou objets du compendium.
- **Avoid**: Wiki link popup, Entity suggester, Smart mention, Quick search.
