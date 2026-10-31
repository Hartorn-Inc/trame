# Glossaire EPURE & TRAME

Ce glossaire régit la terminologie technique et fonctionnelle du projet TRAME. Conformément à la norme ASD-STE100 (ADR-0031), chaque concept possède un terme canonique unique. L'utilisation des termes listés sous _Avoid_ est formellement prohibée dans les spécifications, ADRs et tickets.

---

### AcousticOcclusion
- **Description** : Calcul d'atténuation sonore opéré par `SpatialAudioManager` lorsqu'un rayon acoustique direct coupe un ou plusieurs `WallSegment` dont l'attribut `blocks_sound` vaut `true`.
- _Avoid_ : sound dampening, audio muffling, acoustic wall obstacle.

### ActivateScene
- **Description** : Commande atomique adressée au `TableRoomActor` chargeant une `CampaignMapScene` sur la table de jeu active, transférant l'environnement, les lumières, les PNJ et migrant les `HeroToken` des joueurs vers les `SpawnPoint` désignés.
- _Avoid_ : Push to Live Table, Load Scene, Deploy Map, Push Scene.

### CampaignMapScene
- **Description** : Entité persistée représentant une carte préparée dans la bibliothèque de scènes de campagne, incluant la géométrie des murs, les sources lumineuses, les émetteurs audio spatiaux, les tokens pré-placés et le brouillard exploré.
- _Avoid_ : Prepared Map, Scene Entity, Map Preset, Table Scene.

### DoorState
- **Description** : Énumération de l'état physique d'un `WallSegment` de type `Door` ou `SecretDoor` : `Open`, `Closed`, `Locked`.
- _Avoid_ : Portal status, Door mode, Portal state.

### DualBufferFogOfWar
- **Description** : Sous-système WebGL/Canvas gérant deux textures de brouillard de guerre : la vision active en temps réel (`ActiveVisionTexture`) et la mémoire d'exploration persistante (`ExploredMemoryTexture`).
- _Avoid_ : Fog buffer, Dynamic fog, Exploration brush, Fog shader texture.

### ElevationFt
- **Description** : Coordonnée verticale exprimée en pieds (`ft`) définissant la tranche altimétrique d'un obstacle ou la hauteur d'un token (`bottom_elevation_ft`, `top_elevation_ft`, `elevation_ft`).
- _Avoid_ : Height level, Z-index, Altitude, 2.5D height.

### HeroToken
- **Description** : Instance de token possédée par un joueur (`owner_user_id.is_some()`), préservée lors de la transition `ActivateScene` avec son état dynamique (points de vie, conditions, inventaire).
- _Avoid_ : Player token, Character pawn, PC token, Hero pawn.

### LightSource
- **Description** : Entité lumineuse ponctuelle ou directionnelle définie par des coordonnées, une couleur RVB hexadécimale, un rayon d'atténuation en pieds et une intensité lumineuse.
- _Avoid_ : Point light, Dynamic light, Torch emitter, Map light.

### MapsStudioTab
- **Description** : Onglet de l'espace de travail de campagne (`CampaignWorkspace`) offrant au meneur de jeu le studio de préparation visuelle de cartes et aux joueurs la galerie `SceneAtlas`.
- _Avoid_ : Map Editor, Map Prep Tab, Visual Map Studio, Studio Canvas.

### MapsStudioTab Canvas
- **Description** : Zone interactive de dessin et de manipulation 2.5D de la scène (murs, lumières, sons, monstres) au sein de `MapsStudioTab`.
- _Avoid_ : Visual Map Editor, Editor Canvas, Map Prep Canvas, Prep Grid.

### SceneAtlas
- **Description** : Composant de galerie et de consultation cartographique interactive destiné aux joueurs et au meneur de jeu, affichant uniquement les scènes ayant `revealed_to_players == true`.
- _Avoid_ : Player Map Gallery, Atlas Viewer, multi-scene gallery grid, Player Scene Viewer.

### SpawnPoint
- **Description** : Coordonnée bidimensionnelle `(x, y)` sur une `CampaignMapScene` marquant l'emplacement d'apparition ou de transition automatique des `HeroToken` lors de l'exécution de `ActivateScene`.
- _Avoid_ : Starting point, Player entry coordinate, Spawn marker, Arrival point.

### SpatialAudioEmitter
- **Description** : Entité sonore positionnée dans l'espace 2.5D `(x, y, elevation_ft)` émettant une source audio atténuée par la distance et par `AcousticOcclusion`.
- _Avoid_ : Sound point, Sound emitter, Audio anchor, Ambience node.

### SpatialAudioManager
- **Description** : Gestionnaire audio côté client évaluant le rayon de propagation acoustique, les collisions de rayons avec les murs et l'atténuation du signal selon la position du récepteur.
- _Avoid_ : Audio Engine, Sound Manager, 3D Audio System.

### StagedToken
- **Description** : Token pré-positionné sur une `CampaignMapScene` par le meneur de jeu avant le déploiement sur la table active, associé à un template et à un canal de visibilité.
- _Avoid_ : Preplaced Token, Draft Token, Prep NPC, Staged Monster.

### UvttMap
- **Description** : Format de fichier et structure de données universelle de carte de jeu (`.uvtt` / `.dd2vtt`) comportant les textures d'arrière-plan, la grille, les polygones de murs et les sources lumineuses.
- _Avoid_ : Universal VTT file, DD2VTT, VTT import payload.

### VisibilityChannel
- **Description** : Niveau de diffusion et d'isolation d'une entité dans l'état de la table : `Public` (visible par tous) ou `GmHidden` (visible exclusivement par le meneur de jeu).
- _Avoid_ : Channel, Hidden flag, Stealth visibility, Secret flag, CHANNEL_GM_HIDDEN.

### WallSegment
- **Description** : Segment de droite géométrique 2.5D défini par deux points d'extrémité `(p1, p2)`, une borne inférieure et supérieure d'élévation, un type physique `WallType` et des drapeaux d'occlusion.
- _Avoid_ : Wall barrier, Occlusion segment, Line of sight line, Wall vector.

### WallType
- **Description** : Énumération caractérisant le comportement physique et optique d'un `WallSegment` : `Normal`, `Window`, `Terrain`, `Door`, `SecretDoor`, `Illusion`.
- _Avoid_ : Wall kind, Barrier category, Occlusion style.
