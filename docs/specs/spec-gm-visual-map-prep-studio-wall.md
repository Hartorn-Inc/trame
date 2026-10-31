# Spécification Technique & Fonctionnelle : GM Visual Map Prep Studio & Player SceneAtlas

## 1. Résumé Exécutif & Périmètre

Cette spécification définit l'architecture et les règles métier pour l'onglet `MapsStudioTab` intégré au composant `CampaignWorkspace`. Le système comprend :
1. Un **Map Prep Studio** pour le meneur de jeu, permettant de créer, importer, modifier et organiser des scènes de carte (`CampaignMapScene`) ;
2. Un éditeur géométrique 2.5D (`MapsStudioTab Canvas`) pour tracer et éditer des segments de mur (`WallSegment`), positionner des sources lumineuses (`LightSource`), configurer des émetteurs sonores (`SpatialAudioEmitter`), pré-placer des tokens d'embuscade (`StagedToken`), et peindre manuellement le brouillard de guerre (`DualBufferFogOfWar`) ;
3. Un orchestrateur de transition de scène (`ActivateScene`) déployant instantanément une scène préparée sur la table active gérée par `TableRoomActor` en transférant les héros des joueurs (`HeroToken`) sans perte d'état dynamique ;
4. Une galerie interactive de consultation cartographique pour les joueurs (`SceneAtlas`), protégée par une politique de sécurité zero-trust masquant les portes secrètes, les murs illusoires et les créatures dissimulées.

---

## 2. Termes Canoniques & Invariants ASD-STE100

Le document applique strictement la norme ASD-STE100 et le glossaire canonique du projet :
- **Acteur Explicite** : Tout énoncé d'exigence technique identifie le module sujet (`TableRoomActor`, `SpatialAudioManager`, `DualBufferFogOfWar`, `MapsStudioTab Canvas`, `BackendController`).
- **Termes Prohibés** : Les synonymes `Push to Live Table`, `Visual Map Editor`, `multi-scene gallery grid`, `CHANNEL_GM_HIDDEN`, `sound dampening`, `DD2VTT` sont remplacés par leurs équivalents canoniques `ActivateScene`, `MapsStudioTab Canvas`, `SceneAtlas`, `VisibilityChannel::GmHidden`, `AcousticOcclusion`, `UvttMap`.

---

## 3. Schéma de Persistance et Modèles de Données Rust

### 3.1 Migration Base de Données SQL (`campaign_map_scenes`)

Le backend stocke les scènes de campagne dans la table PostgreSQL `campaign_map_scenes` :

```sql
CREATE TABLE campaign_map_scenes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    grid_type VARCHAR(20) NOT NULL DEFAULT 'Square',
    grid_size_px INT NOT NULL DEFAULT 70,
    grid_cell_distance_ft REAL NOT NULL DEFAULT 5.0,
    width_px INT NOT NULL,
    height_px INT NOT NULL,
    background_image_url TEXT,
    default_ground_elevation_ft REAL NOT NULL DEFAULT 0.0,
    revealed_to_players BOOLEAN NOT NULL DEFAULT false,
    spawn_points JSONB NOT NULL DEFAULT '[]'::jsonb,
    wall_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
    light_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
    spatial_audio_emitters JSONB NOT NULL DEFAULT '[]'::jsonb,
    staged_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
    explored_fog_texture BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_campaign_map_scenes_campaign_id ON campaign_map_scenes(campaign_id);
```

### 3.2 Modèles de Données Domaine Rust (`trame-engine / trame-server`)

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GridType {
    Square,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WallType {
    Normal,
    Window,
    Terrain,
    Door,
    SecretDoor,
    Illusion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DoorState {
    Open,
    Closed,
    Locked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VisibilityChannel {
    Public,
    GmHidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WallSegment {
    pub id: Uuid,
    pub p1: Point2D,
    pub p2: Point2D,
    pub wall_type: WallType,
    pub door_state: Option<DoorState>,
    pub bottom_elevation_ft: f32,
    pub top_elevation_ft: f32,
    pub blocks_light: bool,
    pub blocks_movement: bool,
    pub blocks_sound: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LightSource {
    pub id: Uuid,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub radius_ft: f32,
    pub color_hex: String,
    pub intensity: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpatialAudioEmitter {
    pub id: Uuid,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub radius_ft: f32,
    pub volume: f32,
    pub looping: bool,
    pub gm_only: bool,
    pub audio_clip_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedToken {
    pub id: Uuid,
    pub name: String,
    pub monster_template_id: Option<String>,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub size_cells: u32,
    pub token_avatar_url: Option<String>,
    pub visibility: VisibilityChannel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpawnPoint {
    pub id: Uuid,
    pub name: String,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CampaignMapScene {
    pub id: Uuid,
    pub campaign_id: Uuid,
    pub name: String,
    pub grid_type: GridType,
    pub grid_size_px: u32,
    pub grid_cell_distance_ft: f32,
    pub width_px: u32,
    pub height_px: u32,
    pub background_image_url: Option<String>,
    pub default_ground_elevation_ft: f32,
    pub revealed_to_players: bool,
    pub spawn_points: Vec<SpawnPoint>,
    pub wall_segments: Vec<WallSegment>,
    pub light_sources: Vec<LightSource>,
    pub spatial_audio_emitters: Vec<SpatialAudioEmitter>,
    pub staged_tokens: Vec<StagedToken>,
    pub explored_fog_texture: Option<Vec<u8>>,
}
```

---

## 4. Endpoints d'API REST & Sécurité Zero-Trust

### 4.1 Spécification des Routes

- `GET /api/v1/campaigns/{campaign_id}/maps` : Récupère la liste des scènes de la campagne.
- `POST /api/v1/campaigns/{campaign_id}/maps` : Crée une nouvelle scène de carte.
- `GET /api/v1/campaigns/{campaign_id}/maps/{map_id}` : Récupère une scène spécifique avec sa géométrie intégrale.
- `PUT /api/v1/campaigns/{campaign_id}/maps/{map_id}` : Met à jour la scène préparée (réservé au GM).
- `DELETE /api/v1/campaigns/{campaign_id}/maps/{map_id}` : Supprime la scène préparée (réservé au GM).
- `POST /api/v1/campaigns/{campaign_id}/maps/{map_id}/activate` : Exécute `ActivateScene` sur la table active.

### 4.2 Matrice de Filtrage Zero-Trust pour les Joueurs

WHEN un utilisateur avec le rôle `CampaignRole::Player` envoie une requête `GET` sur `/api/v1/campaigns/{campaign_id}/maps`, THEN le backend filtre la sélection en appliquant les règles strictes suivantes :
1. Le backend exclut toute scène dont `revealed_to_players == false`.
2. Pour chaque scène autorisée renvoyée au joueur :
   - Le backend mute chaque `WallSegment` de type `WallType::SecretDoor` dont `door_state != Some(DoorState::Open)` en `WallType::Normal`, avec `door_state = None`.
   - Le backend mute chaque `WallSegment` de type `WallType::Illusion` en `WallType::Normal`.
   - Le backend supprime tous les tokens de `staged_tokens` ayant `visibility == VisibilityChannel::GmHidden`.
   - Le backend supprime tous les émetteurs de `spatial_audio_emitters` ayant `gm_only == true`.
   - Le backend sérialise la texture `explored_fog_texture` encodée en PNG 8-bit niveaux de gris pour afficher la zone explorée sans révéler les zones masquées.

WHEN un utilisateur avec le rôle `CampaignRole::Player` envoie une requête `GET /api/v1/campaigns/{campaign_id}/maps/{map_id}` pour une scène dont `revealed_to_players == false`, THEN le backend retourne un code d'erreur HTTP `403 Forbidden`.

### 4.3 Template Déterministe `StarterDungeon`

WHEN la requête `POST /api/v1/campaigns/{campaign_id}/maps` contient le payload `template = "StarterDungeon"`, THEN le backend instancie une `CampaignMapScene` déterministe avec les propriétés suivantes :
- `name`: "The Forgotten Crypt"
- `grid_type`: `GridType::Square`
- `grid_size_px`: 70
- `grid_cell_distance_ft`: 5.0
- `width_px`: 2800 (40 cases)
- `height_px`: 2100 (30 cases)
- `default_ground_elevation_ft`: 0.0
- `revealed_to_players`: false
- `spawn_points`: `[SpawnPoint { id: <uuid>, name: "Crypt Entrance", x: 350.0, y: 1050.0 }]`
- `wall_segments`: Les murs délimitent une antichambre rectangulaire de 10x10 cases `[(140, 700) -> (840, 700) -> (840, 1400) -> (140, 1400) -> (140, 700)]`, un couloir central de 4 cases de large jusqu'à `(1680, 1050)`, et une salle du boss finale de 16x16 cases jusqu'à `(2660, 1820)`. Une porte `WallType::Door` (`door_state: Some(DoorState::Closed)`) sépare le couloir de la salle finale à `(1680, 980) -> (1680, 1120)`. Une porte secrète `WallType::SecretDoor` (`door_state: Some(DoorState::Closed)`) est placée à `(490, 700) -> (630, 700)`.
- `light_sources`: 2 torches murales dans l'antichambre à `(210.0, 770.0)` et `(210.0, 1330.0)` (`radius_ft: 20.0`, `color_hex: "#FFAA33"`, `intensity: 1.0`), et 1 brasero central dans la salle du boss à `(2170.0, 1050.0)` (`radius_ft: 40.0`, `color_hex: "#FF5500"`, `intensity: 1.2`).
- `staged_tokens`: 2 squelettes pré-placés dans le couloir à `(1120.0, 980.0)` et `(1120.0, 1120.0)` avec `visibility: VisibilityChannel::GmHidden` et `monster_template_id: Some("Skeleton")`, et 1 boss nécromancien dans la salle finale à `(2380.0, 1050.0)` avec `visibility: VisibilityChannel::GmHidden` et `monster_template_id: Some("Boss")`.

---

## 5. Moteur Géométrique 2.5D & Matrice d'Occlusion

### 5.1 Invariants Géométriques des `WallSegment`

Le backend et le bridge Wasm valident chaque `WallSegment` selon les invariants stricts suivants :
1. **Distance Minimale** : La distance euclidienne entre `p1` et `p2` doit être strictement supérieure à `0.1` ft :
   $$\sqrt{(p2.x - p1.x)^2 + (p2.y - p1.y)^2} > 0.1$$
   IF la distance est inférieure ou égale à `0.1` ft, THEN le backend rejette la requête avec le code HTTP `422 Unprocessable Entity`.
2. **Élévation Valide** : `bottom_elevation_ft < top_elevation_ft`.
   IF `bottom_elevation_ft >= top_elevation_ft`, THEN le backend rejette la requête avec le code HTTP `422 Unprocessable Entity`.

### 5.2 Matrice Physique et Optique

| WallType | DoorState | blocks_movement | blocks_light | blocks_sound | Rendu GM (`MapsStudioTab Canvas`) | Rendu Joueur (`SceneAtlas` / Table) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Normal` | `None` | `true` | `true` | `true` | Ligne bleue continue (#2A72D6) | Ligne d'obstacle standard |
| `Window` | `None` | `true` | `false` | `true` | Ligne cyan pointillée (#00D2D3) | Vitre translucide cyan |
| `Terrain` | `None` | Calcul élévation | Calcul élévation | Calcul élévation | Ligne verte double (#10AC84) | Ligne de dénivelé verte |
| `Door` | `Closed` | `true` | `true` | `true` | Ligne orange continue (#FF9F43) | Porte fermée orange |
| `Door` | `Open` | `false` | `false` | `false` | Ligne orange pointillée (#FF9F43) | Passage ouvert |
| `Door` | `Locked` | `true` | `true` | `true` | Ligne rouge continue (#EE5253) | Porte fermée avec cadenas |
| `SecretDoor`| `Closed` | `true` | `true` | `true` | Ligne violette 'S' (#5F27CD) | Ligne de mur normale bleue (#2A72D6) |
| `SecretDoor`| `Open` | `false` | `false` | `false` | Ligne violette pointillée (#5F27CD) | Passage ouvert |
| `Illusion` | `None` | `false` | `false` | `false` | Ligne magenta striée (#FF007F) | Ligne de mur normale bleue (#2A72D6) |

### 5.3 Modèle d'Occlusion Acoustique 2.5D (`AcousticOcclusion`)

`SpatialAudioManager` calcule l'atténuation sonore entre un émetteur $E(x_e, y_e, z_e)$ et un récepteur $L(x_l, y_l, z_l)$ :
1. `SpatialAudioManager` trace le segment de rayon direct $\vec{R} = L - E$.
2. `SpatialAudioManager` compte le nombre $N$ d'intersections avec des `WallSegment` vérifiant :
   - Le segment 2D $(p_1, p_2)$ coupe la projection 2D de $\vec{R}$ au point $(x_i, y_i)$.
   - L'élévation $z_i$ du rayon au point d'intersection satisfait $bottom\_elevation\_ft \le z_i \le top\_elevation\_ft$.
   - Le segment possède `blocks_sound == true`.
3. Pour chaque intersection valide, `SpatialAudioManager` applique une atténuation de 12 dB ($facteur = 0.25$) et un filtre passe-bas du premier ordre avec fréquence de coupure à 800 Hz.

---

## 6. Déploiement Atomique `ActivateScene` sur la Table de Jeu

### 6.1 Protocole de Migration Déterministe des Tokens

WHEN le meneur de jeu déclenche `ActivateScene` via l'envoi de `POST /api/v1/campaigns/{campaign_id}/maps/{map_id}/activate`, THEN `TableRoomActor` exécute la séquence atomique suivante :
1. `TableRoomActor` récupère la `CampaignMapScene` identifiée par `map_id` depuis la base de données.
2. `TableRoomActor` extrait tous les `HeroToken` actuels de la table (`owner_user_id.is_some()`), triés par ordre lexicographique de leur identifiant UUID.
3. `TableRoomActor` préserve sans altération les attributs d'état des `HeroToken` : `hp_current`, `hp_max`, `temp_hp`, `conditions`, `inventory_items`.
4. Pour chaque `HeroToken` d'indice `token_index` (indexé à 0) :
   - WHEN `scene.spawn_points` n'est pas vide, THEN `TableRoomActor` assigne `token.x = scene.spawn_points[token_index % scene.spawn_points.len()].x`, `token.y = scene.spawn_points[token_index % scene.spawn_points.len()].y`, et `token.elevation_ft = scene.default_ground_elevation_ft`.
   - WHEN `scene.spawn_points` est vide, THEN `TableRoomActor` assigne `token.x = 0.0`, `token.y = 0.0`, et `token.elevation_ft = scene.default_ground_elevation_ft`.
5. `TableRoomActor` supprime tous les anciens PNJ et monstres non possédés (`owner_user_id.is_none()`).
6. `TableRoomActor` instancie chaque `StagedToken` de la scène comme un nouveau token de table actif, en assignant `visibility = staged_token.visibility`.
7. `TableRoomActor` remplace la géométrie de murs de la table par `scene.wall_segments`, les lumières par `scene.light_sources`, et les sources sonores par `scene.spatial_audio_emitters`.
8. `TableRoomActor` diffuse l'événement WebSocket `SceneActivated` contenant le nouvel état complet à tous les clients connectés.

---

## 7. Pipeline d'Importation `UvttMap` (`.uvtt` / `.dd2vtt`)

Le convertisseur `wasmBridge.ts` et le service backend d'import transforment les fichiers universels `UvttMap` selon les étapes suivantes :
1. **Extraction de Texture & Résolution** : Le convertisseur décode la chaîne base64 `image` en buffer image, et extrait `resolution.map_size` et `resolution.pixels_per_grid`.
2. **Conversion des Murs Linéaires** : Pour chaque élément dans `line_of_sight` :
   - Le convertisseur décompose les poly-lignes en segments consécutifs `(p[k], p[k+1])`.
   - Le convertisseur instancie un `WallSegment` avec `wall_type = WallType::Normal`, `bottom_elevation_ft = 0.0`, `top_elevation_ft = 10.0`, `blocks_light = true`, `blocks_movement = true`, `blocks_sound = true`.
3. **Conversion des Portes & Portails** : Pour chaque élément dans `portals` :
   - Le convertisseur instancie un `WallSegment` reliant les coordonnées de la porte.
   - Le convertisseur assigne `wall_type = WallType::Door`.
   - IF `portal.closed == true`, THEN le convertisseur assigne `door_state = Some(DoorState::Closed)` et `blocks_sound = true`.
   - ELSE le convertisseur assigne `door_state = Some(DoorState::Open)` et `blocks_sound = false`.
4. **Conversion des Lumières Ponctuelles** : Pour chaque élément dans `lights` :
   - Le convertisseur instancie une `LightSource` avec les coordonnées `(position.x * pixels_per_grid, position.y * pixels_per_grid)`.
   - Le convertisseur préserve le rayon `radius_ft = range * 5.0` et la couleur hexadécimale issue de la composante RVB `color`.

---

## 8. Interface Utilisateur & Interaction Frontend (`@trame/web`)

### 8.1 Studio de Préparation MJ (`MapsStudioTab Canvas`)

L'onglet `MapsStudioTab` offre au meneur de jeu :
1. Une barre d'outils comprenant les sélecteurs : `Select/Move`, `Draw Wall` (avec sous-menu `Normal`, `Window`, `Terrain`, `Door`, `SecretDoor`, `Illusion`), `Light Source Tool`, `Spatial Audio Tool`, `Staged Monster Spawner`, `Fog Brush`.
2. Des réglages d'accrochage à la grille (`Snap to Grid`) : activé par défaut sur les intersections et centres de cases de la grille carrée.
3. Un inspecteur contextuel de segment sélectionné permettant de modifier `DoorState` (`Open`, `Closed`, `Locked`) et les bornes d'élévation `bottom_elevation_ft` et `top_elevation_ft`.
4. La palette **1-Click GM Monster Templates** permettant d'insérer instantanément un `StagedToken` (`Goblin`, `Bandit`, `Guard`, `Skeleton`, `Wolf`, `Ogre`, `Boss`) avec le commutateur `VisibilityChannel` configuré sur `GmHidden` par défaut.
5. Le bouton d'action principal `[ActivateScene]` déclenchant le déploiement immédiat sur la table active.
6. Le commutateur `[Revealed in Player Atlas]` (`revealed_to_players`) pour publier ou retirer la scène de la galerie des joueurs.

### 8.2 Galerie `SceneAtlas` pour les Joueurs

Pour les joueurs, l'onglet `MapsStudioTab` affiche exclusivement la galerie `SceneAtlas` :
1. Affichage sous forme de grille de vignettes représentant les scènes publiées (`revealed_to_players == true`).
2. Clic sur une vignette ouvrant la scène en plein écran avec contrôles fluides de zoom et de déplacement panoramique (pan/zoom).
3. Rendu sécurisé conforme à l'ADR 0035 : portes secrètes affichées comme des murs ordinaires, absence de tokens masqués, et affichage exclusif du brouillard de guerre exploré.

---

## 9. Sous-Systèmes Spécialisés

### 9.1 Brouillard de Guerre Manuel (`DualBufferFogOfWar`)

`DualBufferFogOfWar` maintient deux textures WebGL distinctes :
- `ActiveVisionTexture` : Re-calculée à chaque frame selon la ligne de vue dynamique des tokens actifs sur la table.
- `ExploredMemoryTexture` : Accumule les zones observées. Dans `MapsStudioTab Canvas`, le meneur de jeu peut peindre directement sur `ExploredMemoryTexture` avec un pinceau circulaire (rayon réglable de 10 à 200 px, modes `Reveal` et `Hide`).
- `DualBufferFogOfWar` encode la texture `ExploredMemoryTexture` exclusivement en un buffer d'octets PNG 8-bit en niveaux de gris (canal R représentant l'alpha d'exploration de 0 à 255) pour la persistance en base de données et le transfert réseau.

### 9.2 Positionnement du Récepteur Audio Spatial

`SpatialAudioManager` détermine la position du récepteur d'écoute $L(x_l, y_l, z_l)$ selon les règles déterministes suivantes :
- Pour le meneur de jeu (GM) : le récepteur est centré sur le viewport du canvas : $x_l = viewport.center_x$, $y_l = viewport.center_y$, et $z_l = 0.0$ ft.
- Pour un joueur :
  - IF le joueur possède au moins un token héros sur la table active, THEN le récepteur se lie aux coordonnées du premier token héros trié par ordre lexicographique de son identifiant UUID : $x_l = hero_token.x$, $y_l = hero_token.y$, et $z_l = hero_token.elevation_ft$.
  - IF le joueur ne possède aucun token sur la table active, THEN le récepteur est assigné à $x_l = 0.0$, $y_l = 0.0$, et $z_l = 0.0$ ft.

---

## 10. Stratégie de Test TDD & Critères d'Acceptation

### 10.1 Suite 1 : Backend UVTT Importer Test (`tests/uvtt_importer_test.rs`)
- **Test 1.1** : Importer un fichier `.uvtt` valide contenant 12 segments de murs, 3 portes et 4 lumières colorées. Valider que 15 `WallSegment` et 4 `LightSource` sont créés avec les coordonnées exactes et couleurs RVB conformes.
- **Test 1.2** : Rejeter un fichier `.uvtt` corrompu ou contenant des segments de longueur $< 0.1$ ft en renvoyant une erreur de validation explicite.

### 10.2 Suite 2 : Sécurité RBAC & Masquage SceneAtlas Test (`tests/scene_atlas_security_test.rs`)
- **Test 2.1** : Un compte joueur requêtant `GET /api/v1/campaigns/{id}/maps` ne reçoit que les scènes avec `revealed_to_players == true`.
- **Test 2.2** : Un compte joueur requêtant `GET /api/v1/campaigns/{id}/maps/{map_id}` sur une scène masquée reçoit un code HTTP `403 Forbidden`.
- **Test 2.3** : Vérifier que dans le payload reçu par un joueur pour une scène révélée, aucun segment ne possède `WallType::SecretDoor` fermé (transformé en `WallType::Normal`), aucun segment ne possède `WallType::Illusion` (transformé en `WallType::Normal`), aucun token ne possède `visibility == VisibilityChannel::GmHidden`, et aucun son n'a `gm_only == true`.

### 10.3 Suite 3 : Transition de Table ActivateScene Test (`tests/activate_scene_test.rs`)
- **Test 3.1** : Déclencher `ActivateScene` sur une table contenant 3 tokens joueurs. Vérifier que les 3 `HeroToken` sont conservés avec leurs points de vie intacts, et positionnés sur les coordonnées des `spawn_points` selon la règle déterministe `token_index % spawn_points.len()`.
- **Test 3.2** : Vérifier le repli déterministe vers `(0.0, 0.0, scene.default_ground_elevation_ft)` lorsque `spawn_points` est une liste vide.
- **Test 3.3** : Vérifier que les anciens monstres de la table sont purgés et que les `StagedToken` de la nouvelle scène sont instanciés avec leur visibilité respective.

### 10.4 Suite 4 : Frontend Studio & Canvas Interaction Test (`apps/web/src/tests/MapsStudioTab.spec.ts`)
- **Test 4.1** : Vérifier le tracé interactif de murs avec magnétisme sur la grille (`Snap to Grid`).
- **Test 4.2** : Vérifier le basculement d'état d'une porte (`Closed` -> `Open` -> `Locked`) et la mise à jour réactive des propriétés d'occlusion.
- **Test 4.3** : Vérifier l'insertion d'un monstre via le menu 1-Click GM Monster Templates et l'attribution par défaut de `VisibilityChannel::GmHidden`.
