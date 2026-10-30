# Spécification Technique [E4] : Interactive Table HUD, Reaction Banner, GM Override Toolbar, Ping/Ruler & Spatial Audio

## 1. Contexte & Objectifs Métier

Le module Focus Table HUD fournit l'interface interactive temps-réel de TRAME pour les joueurs et le Meneur de Jeu (MJ / Game Master). Il combine :
1. **Exploration & Combat Tracker** : Bascule de mode (`TableMode::Exploration` vs `TableMode::TurnByTurn`), indicateur de pause MJ globale (`Spacebar`), carrousel d'initiative, badges d'économie d'actions (`[A]`, `[BA]`, `[R]`, `[Move]`) et bandeau de réaction interrompant le tour pendant 5 secondes.
2. **Barre d'outils d'Override Omnipotente MJ & Annulation 1-Click** : Popover d'édition instantanée HP / Temp HP / death saves / spell slots, remboursement en 1 clic des actions et du déplacement, téléportation forcée sans dépense de vitesse, sélecteur de preset d'ambiance lumineuse (`DAYLIGHT`, `DUSK`, `NIGHT_MOONLIGHT`, `PITCH_DARKNESS`) et tiroir d'historique `UndoDrawer` avec raccourci `Cmd+Z` / `Ctrl+Z`.
3. **Outils Table Non-Bloquants** : Règle de mesure multi-points 3D (support des métriques `5-5-5`, `5-10-5` et Euclidienne intégrant l'élévation `ElevationFt`), pings radar éphémères synchronisés, annotations vectorielles libres/polygones avec option de conversion en murs physiques.
4. **Moteur Audio Spatialisé WebAudio** : Positionnement 3D des émetteurs sonores et occlusion acoustique passe-bas dynamique calculée via raycast WASM contre les murs marqués `blocks_sound`.

---

## 2. Architecture & Découplage des Responsabilités

### 2.1 Découplage React 19 vs PixiJS v8 SceneGraph vs WASM Bridge
Pour garantir 60 FPS sans encombrer le réconciliateur React ni saturer la bande passante WebSocket :
- **Interactions dynamiques éphémères** : La manipulation active de la règle (glisser-déposer de waypoints), l'animation des pings radar et l'affichage fantôme des tracés vectoriels s'exécutent directement dans le SceneGraph PixiJS v8 (`packages/web/src/canvas/SceneGraph.ts`, calque `uiControlHud`). Ces calculs interrogent le bridge WebAssembly `wasmBridge.ts` de façon synchrone sans déclencher de re-render React.
- **États persistés & HUD** : Le store Zustand (`tableStore.ts` / `TableClientStore`) conserve uniquement l'outil actif, les entités validées et les métadonnées de combat. Les composants React (`CombatTracker.tsx`, `ReactionBanner.tsx`, `GmOverrideToolbar.tsx`, `UndoDrawer.tsx`) s'abonnent sélectivement aux mutations de ce store.
- **Diffusion réseau** : Les pings radar émettent des messages légers de broadcast non persistés en base de données. Les tracés vectoriels validés et les segments de murs physiques émettent des commandes persistées au `TableRoomActor`.

### 2.2 Autorité Temporelle & Synchronisation Réseau (`TimeSync`)
Pour éviter toute désynchronisation du compte à rebours de réaction de 5 secondes :
- Le serveur `TableRoomActor` fait autorité sur le temps. Lors du déclenchement d'une opportunité, le serveur suspend l'interpolation du token et assigne un timestamp absolu d'échéance : `expires_at_ms = current_server_time_ms + 5000`.
- Le client estime son décalage d'horloge `server_time_offset_ms` via un protocole d'échange continu `TimeSyncPing` / `TimeSyncPong`.
- Le client dérive le temps restant affiché : `remaining_ms = max(0, expires_at_ms - (client_now_ms + server_time_offset_ms))`.

### 2.3 Undo 1-Click & Rollback Transactionnel
- `TableRoomActor` maintient une pile d'annulation native `undo_stack: VecDeque<UndoEntry>` bornée à 50 entrées dans `crates/trame-engine/src/commands.rs`.
- L'exécution de `TrameCommand::UndoLastAction` restaure un snapshot atomique de la table `TableSnapshotData` et reconstruit l'arbre spatial `Bvh2D`.
- La diffusion de `ServerEnvelope::ActionUndone` ordonne au client de mettre à jour `TableClientStore` et d'invoquer `DualBufferFogOfWar.rollbackSnapshot(snapshot_id)` pour invalider les dalles de brouillard explorées lors du tour annulé.

---

## 3. Contrats Réseau & Structures de Données (`crates/trame-server/src/sync.rs`)

### 3.1 Types Communs

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TableMode {
    Exploration,
    TurnByTurn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionEconomyType {
    Action,
    BonusAction,
    Reaction,
    Movement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeathSaveCounters {
    pub successes: u8,
    pub failures: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AmbientPreset {
    Daylight,
    Dusk,
    NightMoonlight,
    PitchDarkness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RulerMetric {
    FiveFiveFive,
    FiveTenFive,
    Euclidean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PingType {
    Alert,
    Attention,
    Question,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrawingEntity {
    pub id: String,
    pub points: Vec<[f32; 2]>,
    pub color: String,
    pub line_width: f32,
    pub is_closed: bool,
    pub has_physical_walls: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioEmitterConfig {
    pub id: String,
    pub url: String,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub max_distance_ft: f32,
    pub ref_distance_ft: f32,
    pub rolloff: f32,
    pub loop_playback: bool,
    pub volume: f32,
}
```

### 3.2 Messages Émis par le Client (`ClientEnvelope`)

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ClientEnvelope {
    SetTableMode {
        mode: TableMode,
    },
    ToggleTablePause {
        is_paused: bool,
    },
    GmOverrideHp {
        token_id: String,
        hp: i32,
        temp_hp: i32,
        spell_slots_delta: Option<Vec<i8>>,
        death_saves: Option<DeathSaveCounters>,
    },
    GmRefundAction {
        token_id: String,
        economy_type: ActionEconomyType,
    },
    GmTeleportToken {
        token_id: String,
        target_x: f32,
        target_y: f32,
        target_elevation_ft: f32,
    },
    GmSetAmbientPreset {
        preset: AmbientPreset,
    },
    GmTriggerUndo,
    DeclareReaction {
        trigger_id: u64,
        actor_id: String,
        reaction_id: String,
        accepted: bool,
    },
    PointerPing {
        x: f32,
        y: f32,
        ping_type: PingType,
    },
    CreateDrawing {
        drawing: DrawingEntity,
    },
    DeleteDrawing {
        drawing_id: String,
    },
    TimeSyncPing {
        client_send_ms: u64,
    },
    UpsertAudioEmitter {
        emitter: AudioEmitterConfig,
    },
    RemoveAudioEmitter {
        emitter_id: String,
    },
}
```

### 3.3 Messages Diffusés par le Serveur (`ServerEnvelope`)

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ServerEnvelope {
    TableModeChanged {
        mode: TableMode,
        changed_by: String,
    },
    TablePauseToggled {
        is_paused: bool,
        changed_by: String,
    },
    TableInterruptSuspended {
        trigger_id: u64,
        actor_id: String,
        reaction_type: String,
        expires_at_ms: u64,
        reach_distance_ft: f32,
    },
    TableInterruptResolved {
        trigger_id: u64,
        was_interrupted: bool,
    },
    PointerPingBroadcast {
        x: f32,
        y: f32,
        ping_type: PingType,
        user_id: String,
        color: String,
    },
    DrawingCreated {
        drawing: DrawingEntity,
    },
    DrawingDeleted {
        drawing_id: String,
    },
    ActionUndone {
        snapshot_id: u64,
        restored_token_ids: Vec<String>,
    },
    TimeSyncPong {
        client_send_ms: u64,
        server_recv_ms: u64,
        server_send_ms: u64,
    },
    AudioEmitterUpserted {
        emitter: AudioEmitterConfig,
    },
    AudioEmitterRemoved {
        emitter_id: String,
    },
}
```

---

## 4. Modules Fonctionnels & Techniques

### Module 1 : Top Bar d'Exploration / Combat & Combat Tracker

#### 1.1 Bascule de Mode & Pause MJ (`Spacebar`)
- Le composant `CombatTopBar` affiche le mode courant (`TableMode`).
- WHEN le Game Master clique sur le bouton de bascule ou déclenche le raccourci dédié, THEN `CombatTopBar` émet `ClientEnvelope::SetTableMode { mode }`.
- WHEN le Game Master appuie sur la touche `Spacebar` hors d'un champ de saisie de texte, THEN `CombatTopBar` émet `ClientEnvelope::ToggleTablePause { is_paused }`.
- WHEN `TableRoomActor` reçoit `ToggleTablePause`, THEN `TableRoomActor` fige les déplacements de tous les tokens et diffuse `ServerEnvelope::TablePauseToggled` à tous les clients.
- WHEN `TablePauseToggled { is_paused: true }` arrive sur le client, THEN un bandeau visuel rouge semi-transparent `[ PAUSE MJ ]` s'affiche au centre de la vue et bloque les entrées de déplacement des joueurs.

#### 1.2 Carrousel d'Initiative & Ordre du Tour
- Le composant `CombatTracker.tsx` affiche horizontalement la séquence ordonnée des tokens participant au combat.
- Chaque carte de token présente le portrait, le nom, l'élévation `ElevationFt`, la valeur d'initiative et les badges d'économie d'actions.
- La carte du token actif possède une bordure dorée animée et un indicateur de temps de tour écoulé.
- Le Game Master dispose de boutons d'avance (`[ Suivant ]`) et de recul (`[ Précédent ]`) pour piloter le tour actif.

#### 1.3 Badges d'Économie d'Action (`[A]`, `[BA]`, `[R]`, `[Move]`)
- Quatre badges identifient l'état des ressources du tour du token sélectionné :
  - `[A]` : Action principale (vert = disponible, gris = dépensée).
  - `[BA]` : Action bonus (bleu = disponible, gris = dépensée).
  - `[R]` : Réaction (ambre = disponible, gris = dépensée).
  - `[Move]` : Vitesse de déplacement restante en pieds (ex: `25/30 ft`).
- WHEN un token effectue une attaque ou un sort, THEN `TableClientStore` met à jour l'état des badges en temps-réel suite aux événements du serveur.

---

### Module 2 : Bandeau d'Interruption de Réaction (5 Secondes) & TimeSync

#### 2.1 Détection de Menace (`ThreatReach`) & Interruption
- Chaque token de créature hostile possède une portée de menace `ThreatReach` (valeur par défaut : `5.0` pieds).
- WHEN un token en mouvement quitte le rayon `ThreatReach` d'une créature hostile éligible à une réaction, THEN `TableRoomActor` interrompt l'interpolation spatiale du token sur le serveur.
- `TableRoomActor` génère un identifiant d'interruption unique monotone `trigger_id: u64`.
- `TableRoomActor` calcule le timestamp d'échéance absolu `expires_at_ms = server_now_ms + 5000` et diffuse `ServerEnvelope::TableInterruptSuspended`.

#### 2.2 Synchronisation d'Horloge (`TimeSync`)
- Le client transmet périodiquement (toutes les 10 secondes et à la connexion) `ClientEnvelope::TimeSyncPing { client_send_ms: Date.now() }`.
- `TableRoomActor` répond immédiatement avec `ServerEnvelope::TimeSyncPong { client_send_ms, server_recv_ms, server_send_ms }`.
- `TableClientStore` met à jour le décalage temporel moyen :
  ```typescript
  const roundTripMs = (Date.now() - client_send_ms) - (server_send_ms - server_recv_ms);
  const serverTimeOffsetMs = server_send_ms + (roundTripMs / 2) - Date.now();
  ```

#### 2.3 Cycle de Vie du Bandeau HUD & Reprise Automatique
- WHEN le client reçoit `TableInterruptSuspended`, THEN le composant `ReactionBanner.tsx` monte à l'écran pour les joueurs contrôlant l'acteur réactif et pour le Game Master.
- Le bandeau affiche une jauge de progression dégressive de 5 secondes, le nom de l'interrupteur, le token ciblé et le bouton `[ Utiliser Réaction ]`.
- Le timer calcule à chaque trame : `remaining_ms = Math.max(0, expires_at_ms - (Date.now() + serverTimeOffsetMs))`.
- WHEN l'utilisateur clique sur `[ Utiliser Réaction ]`, THEN le client émet `ClientEnvelope::DeclareReaction { trigger_id, actor_id, reaction_id, accepted: true }`.
- WHEN `remaining_ms` atteint 0 sans déclaration explicite, THEN `TableRoomActor` résout l'interruption avec `was_interrupted: false` et diffuse `ServerEnvelope::TableInterruptResolved`.
- WHEN le client reçoit `TableInterruptResolved`, THEN `ReactionBanner.tsx` se démonte et le token reprend sa trajectoire d'interpolation.

#### 2.4 Contrôles d'Override MJ sur la Réaction
- Le Game Master dispose de trois boutons d'intervention directe sur le bandeau :
  - `[ Forcer ]` : Valide immédiatement l'interruption sans attendre le clic du joueur.
  - `[ Ignorer ]` : Rejette immédiatement la réaction et reprend la course du token.
  - `[ Pause ]` : Gèle le décompte de 5 secondes pour permettre une discussion tactique vocale.

---

### Module 3 : Barre d'Override Omnipotente MJ & Tiroir d'Annulation 1-Click (`UndoDrawer`)

#### 3.1 Popover d'Édition Instantanée HP, Temp HP & Death Saves
- WHEN le Game Master clique sur un token avec le modificateur `Alt` ou active l'outil d'édition de la barre `GmOverrideToolbar`, THEN un popover d'ajustement apparaît.
- Le popover permet de saisir directement les points de vie (`hp`), les points de vie temporaires (`temp_hp`), un ajustement relatif des emplacements de sorts (`spell_slots_delta`) et les compteurs de sauvegarde contre la mort (`death_saves`).
- `DeathSaveCounters` comprend deux champs numériques bornés entre 0 et 3 : `successes` et `failures`.
- WHEN le Game Master valide le popover, THEN `GmOverrideToolbar` transmet `ClientEnvelope::GmOverrideHp` immédiatement au `TableRoomActor`.
- `TableRoomActor` applique la modification et diffuse le nouvel état atomique du token.

#### 3.2 Remboursement d'Économie d'Action en 1 Clic
- `GmOverrideToolbar` propose quatre icônes de remboursement instantané (`[+A]`, `[+BA]`, `[+R]`, `[+Move]`).
- WHEN le Game Master clique sur une icône de remboursement, THEN `GmOverrideToolbar` transmet `ClientEnvelope::GmRefundAction { token_id, economy_type }`.
- `TableRoomActor` rétablit la ressource correspondante sans altérer le reste de l'état du token et diffuse la mise à jour.

#### 3.3 Téléportation Forcée sans Dépense de Déplacement
- WHEN le Game Master sélectionne l'outil Téléportation Forcée et clique sur une coordonnée cible de la table, THEN `GmOverrideToolbar` émet `ClientEnvelope::GmTeleportToken { token_id, target_x, target_y, target_elevation_ft }`.
- `TableRoomActor` déplace immédiatement le token aux coordonnées spécifiées sans décrémenter son quota de déplacement `Movement` ni déclencher d'attaque d'opportunité.

#### 3.4 Sélecteur de Presets d'Ambiance Lumineuse
- `GmOverrideToolbar` intègre un menu déroulant pour les ambiances de table :
  - `DAYLIGHT` : Luminosité ambiante 1.0, rayon d'obscurité nul, teinte neutre.
  - `DUSK` : Luminosité ambiante 0.45, teinte orangée/ambre.
  - `NIGHT_MOONLIGHT` : Luminosité ambiante 0.15, teinte bleu nuit, vision dans le noir requise.
  - `PITCH_DARKNESS` : Luminosité ambiante 0.0, obscurité absolue, aucune vision sans source de lumière.
- WHEN le Game Master sélectionne un preset, THEN `GmOverrideToolbar` émet `ClientEnvelope::GmSetAmbientPreset { preset }`.
- `TableRoomActor` synchronise l'ambiance et met à jour les uniformes du shader `LightingShader.ts`.

#### 3.5 Tiroir d'Annulation 1-Click (`UndoDrawer.tsx`) & Ring Buffer Moteur
- Le tiroir `UndoDrawer.tsx` répertorie les 50 dernières actions enregistrées dans `undo_stack` de `trame-engine`.
- Chaque entrée affiche l'icône de l'action, l'auteur, l'acteur ciblé et le timestamp relatif.
- WHEN le Game Master clique sur l'entrée la plus récente ou appuie sur le raccourci `Cmd+Z` / `Ctrl+Z`, THEN `UndoDrawer` émet `ClientEnvelope::GmTriggerUndo`.
- `TableRoomActor` exécute `TrameCommand::UndoLastAction`, dépile le dernier `UndoEntry`, restaure `TableSnapshotData` et reconstruit `Bvh2D`.
- `TableRoomActor` diffuse `ServerEnvelope::ActionUndone { snapshot_id, restored_token_ids }`.

#### 3.6 Rollback Transactionnel du FBO de Brouillard de Guerre (`DualBufferFogOfWar`)
- WHEN le client reçoit `ServerEnvelope::ActionUndone`, THEN `DualBufferFogOfWar.rollbackSnapshot(snapshot_id)` s'exécute.
- `DualBufferFogOfWar` réinitialise les dalles de brouillard explorées associées au token restauré pour ce tour, empêchant la persistance visuelle des zones découvertes par erreur.

---

### Module 4 : Outils Table Non-Bloquants (PixiJS v8 SceneGraph Overlay)

#### 4.1 Règle Multi-Points Non-Bloquante avec Élévation 3D
- La fonction `measureRulerWaypointsFt` dans `packages/web/src/canvas/SceneGraph.ts` calcule la distance cumulative le long d'une suite de waypoints $P_i = (X_i, Y_i, Z_i)$ où $Z_i$ représente `ElevationFt` en pieds et $(X_i, Y_i)$ les coordonnées monde en pieds (grille 5 ft).
- Formules de calcul supportées entre deux points consécutifs $A$ et $B$ :
  1. **Euclidean** :
     $$\Delta X = |X_B - X_A|, \quad \Delta Y = |Y_B - Y_A|, \quad \Delta Z = |Z_B - Z_A|$$
     $$D = \sqrt{\Delta X^2 + \Delta Y^2 + \Delta Z^2}$$
  2. **5-5-5 (Chebyshev 3D)** :
     $$D = \max(\Delta X, \Delta Y, \Delta Z)$$
  3. **5-10-5 (Alternance D&D 5e avec hypoténuse 3D)** :
     Soit la distance 2D horizontale standard :
     $$D_{diag} = \min(\Delta X, \Delta Y), \quad D_{str} = \max(\Delta X, \Delta Y) - D_{diag}$$
     $$N_{diag} = \lfloor D_{diag} / 5.0 \rfloor$$
     $$D_{2D} = D_{str} + \lfloor N_{diag} / 2 \rfloor \times 15.0 + (N_{diag} \pmod 2) \times 5.0$$
     $$D_{3D} = \sqrt{D_{2D}^2 + \Delta Z^2}$$
- Le rendu visuel de la règle s'exécute dans `uiControlHud` à 60 FPS sans mise à jour React.

#### 4.2 Radar Pings Éphémères
- WHEN un utilisateur effectue un clic molette ou un appui long avec la touche `P`, THEN `SceneGraph` intercepte l'événement et transmet `ClientEnvelope::PointerPing { x, y, ping_type }`.
- `TableRoomActor` diffuse `ServerEnvelope::PointerPingBroadcast` aux clients sans écriture en base de données.
- `SceneGraph` anime un sprite circulaire d'onde radar (`PingPulse`) avec décroissance exponentielle d'opacité sur une durée fixe de 1.5 seconde.

#### 4.3 Tracés Vectoriels & Conversion en Murs Physiques
- L'outil de dessin vectoriel `DrawingOverlay` permet de tracer des segments à main levée ou des polygones réguliers.
- La configuration du tracé comprend l'épaisseur de ligne, la couleur hexadécimale, la fermeture du polygone (`is_closed`) et le drapeau `has_physical_walls`.
- WHEN l'utilisateur termine son tracé, THEN `DrawingOverlay` émet `ClientEnvelope::CreateDrawing { drawing }`.
- WHEN `has_physical_walls` vaut `true`, THEN `TableRoomActor` extrait les segments linéaires du tracé et les insère comme entités `PhysicalWall` dans l'arbre spatial `Bvh2D` du moteur `trame-engine` avec les propriétés `blocks_movement: true`, `blocks_vision: true`, et `blocks_sound: true`.
- `TableRoomActor` diffuse `ServerEnvelope::DrawingCreated` à tous les clients pour affichage persistant.

---

### Module 5 : Moteur Audio Spatialisé & Occlusion Acoustique WebAudio

#### 5.1 Graphe de Nœuds WebAudio
Pour chaque émetteur sonore provisionné via `AudioEmitterConfig`, le composant `SpatialAudioManager` instancie la chaîne audio suivante :
```
[ AudioBufferSourceNode / HTMLMediaElement ]
                    │
                    ▼
            [ BiquadFilterNode ] (type: 'lowpass', calcul d'occlusion)
                    │
                    ▼
            [ PannerNode ] (panningModel: 'HRTF', distanceModel: 'inverse')
                    │
                    ▼
            [ GainNode ] (contrôle de volume maître)
                    │
                    ▼
        [ AudioContext.destination ]
```

#### 5.2 Approvisionnement & Cycle de Vie des Émetteurs
- La table initialise les émetteurs au chargement de la scène ou lors de la réception de `ServerEnvelope::AudioEmitterUpserted { emitter }`.
- WHEN `TableRoomActor` supprime une source audio, THEN il diffuse `ServerEnvelope::AudioEmitterRemoved { emitter_id }` et `SpatialAudioManager` libère les nœuds audio correspondants.
- Le `AudioListener` global est asservi aux coordonnées mondes et à l'élévation du token contrôlé par le joueur local.

#### 5.3 Atténuation Géométrique & Hypoténuse 3D
- La distance tridimensionnelle $d$ entre l'émetteur $E$ et le récepteur/auditeur $L$ intègre l'élévation `ElevationFt` :
  $$d = \sqrt{(X_E - X_L)^2 + (Y_E - Y_L)^2 + (Z_E - Z_L)^2}$$
- Le modèle d'atténuation libre applique la règle inverse standard avec distance de référence $d_{ref}$ et facteur d'atténuation $rolloff$ :
  $$\text{Gain}(d) = \begin{cases} 1.0 & \text{si } d \le d_{ref} \\ \dfrac{d_{ref}}{d_{ref} + rolloff \times (d - d_{ref})} & \text{si } d > d_{ref} \end{cases}$$

#### 5.4 Calcul d'Occlusion Acoustique & Fréquence de Coupure Déterministe
- Le thread audio exécute un raycast acoustique WASM à une fréquence throttlée de 10 Hz entre la position de l'émetteur et celle de l'auditeur.
- Le raycast dénombre le total de segments de murs physiques traversés possédant le drapeau `blocks_sound: true` ($N_{walls}$).
- La fréquence de coupure du filtre passe-bas `BiquadFilterNode.frequency.value` obéit strictement à la formule :
  $$f_{cutoff} = \frac{20000.0}{1.0 + 3.5 \times N_{walls}} \quad \text{(en Hertz)}$$
- **Valeurs de référence strictes** :
  - $N_{walls} = 0 \implies f_{cutoff} = 20000.00 \text{ Hz}$ (aucun filtrage).
  - $N_{walls} = 1 \implies f_{cutoff} = 4444.44 \text{ Hz}$.
  - $N_{walls} = 2 \implies f_{cutoff} = 2500.00 \text{ Hz}$.
  - $N_{walls} = 4 \implies f_{cutoff} = 1333.33 \text{ Hz}$.
- **Règle de limitation de charge** : WHEN le nombre d'émetteurs sonores dépasse 16, THEN `SpatialAudioManager` applique la dernière fréquence calculée aux émetteurs situés au-delà du 16e rang sans exécuter de nouveau raycast.

---

## 5. Invariants Métier & Règles ASD-STE100

1. **Invariant d'Autorité d'Interruption** : `TableRoomActor` contrôle l'unique source de vérité temporelle pour le décompte de réaction. Aucun client ne peut reprendre un mouvement suspendu sans avoir reçu `ServerEnvelope::TableInterruptResolved`.
2. **Invariant de Continuité d'Économie d'Action** : WHEN un Game Master déclenche un Undo sur un déplacement de token, THEN `TableRoomActor` recrédite la vitesse de déplacement exactement égale à la longueur du déplacement annulé.
3. **Invariant de Restauration du Brouillard** : L'annulation d'un déplacement de token révoque immédiatement les cellules de vision dévoilées dans `DualBufferFogOfWar` pour ce tour annulé.
4. **Invariant de Bounded Concurrency Audio** : `SpatialAudioManager` ne dépasse jamais 16 calculs de raycasts acoustiques simultanés par cycle d'atténuation de 100 ms (10 Hz).
5. **Invariant de Vocabulaire Contrôlé** : L'interface du tiroir d'historique s'intitule impérativement `UndoDrawer` (l'usage de `HistoryDrawer` est formellement interdit).

---

## 6. Plan de Test Déterministe TDD (Node 24 `node:test` + `node:assert/strict`)

Les tests unitaires s'exécutent avec le runner natif Node 24 (`npm test` dans `packages/web`) sans dépendance matérielle WebAudio réelle (utilisation d'un mock WebAudio déterministe).

### 6.1 Tests Audio Spatialisé & Occlusion (`packages/web/tests/audio.test.ts`)

#### Test 6.1.1 : Distance Euclidienne 3D avec Élévation $\Delta Z$
- **Description** : Calculer la distance entre un émetteur à $(0, 0, 0)$ et un auditeur à $(30, 40, 120)$.
- **Assertion** : Vérifier que la distance calculée vaut exactement $\sqrt{30^2 + 40^2 + 120^2} = \sqrt{900 + 1600 + 14400} = \sqrt{16900} = 130.00$ pieds.

#### Test 6.1.2 : Gain d'Atténuation Acoustique en Champ Libre
- **Description** : Configurer $d_{ref} = 10.0$, $rolloff = 1.0$, et distance $d = 50.0$.
- **Assertion** : Vérifier que le gain linéaire calculé vaut exactement $\frac{10.0}{10.0 + 1.0 \times (50.0 - 10.0)} = \frac{10.0}{50.0} = 0.20$.

#### Test 6.1.3 : Fréquences de Coupure Passe-Bas Déterministes par Occlusion de Murs
- **Description** : Simuler l'interposition de 1, 2 et 4 murs marqués `blocks_sound: true`.
- **Assertions** :
  - Avec 1 mur traversé, vérifier que `BiquadFilterNode.frequency.value` vaut exactement `4444.44` Hz (arrondi à 2 décimales).
  - Avec 2 murs traversés, vérifier que `BiquadFilterNode.frequency.value` vaut exactement `2500.00` Hz (arrondi à 2 décimales).
  - Avec 4 murs traversés, vérifier que `BiquadFilterNode.frequency.value` vaut exactement `1333.33` Hz (arrondi à 2 décimales).

#### Test 6.1.4 : Plafond de Charge à 16 Émetteurs Concurrants
- **Description** : Enregistrer 20 émetteurs audio simultanés.
- **Assertion** : Vérifier que le dispatcher de raycast WASM n'émet que 16 requêtes de raycasting par intervalle de 100 ms, et que les 4 émetteurs restants conservent leur valeur de fréquence précédente sans lever d'exception.

### 6.2 Tests de la Règle 3D (`packages/web/tests/ruler.test.ts`)

#### Test 6.2.1 : Règle Métrique 5-5-5 (Chebyshev 3D)
- **Description** : Mesurer un segment de waypoints de $(0, 0, 0)$ à $(15, 25, 40)$.
- **Assertion** : Vérifier que la distance renvoyée vaut $\max(15, 25, 40) = 40.00$ pieds.

#### Test 6.2.2 : Règle Métrique 5-10-5 avec Hypothénuse 3D
- **Description** : Mesurer un segment de waypoints avec $\Delta X = 10$, $\Delta Y = 10$, $\Delta Z = 20$.
- **Calcul** : $D_{diag} = 10$, $N_{diag} = 2$. $D_{2D} = 15.0$ pieds. $D_{3D} = \sqrt{15^2 + 20^2} = \sqrt{225 + 400} = 25.0$ pieds.
- **Assertion** : Vérifier que la fonction `measureRulerWaypointsFt` renvoie exactement `25.00` pieds.

#### Test 6.2.3 : Règle Métrique Euclidienne 3D
- **Description** : Mesurer un segment de $(0, 0, 0)$ à $(6, 8, 24)$.
- **Assertion** : Vérifier que la distance renvoyée vaut $\sqrt{36 + 64 + 576} = \sqrt{676} = 26.00$ pieds.

### 6.3 Tests du Bandeau de Réaction & Horloge (`packages/web/tests/hud.test.ts`)

#### Test 6.3.1 : Décroissance Déterministe du Compte à Rebours & Fermeture
- **Description** : Initialiser `ReactionBanner` avec `expires_at_ms = Date.now() + 5000` et `serverTimeOffsetMs = 0`.
- **Assertion** : Vérifier que `remainingMs` décroît de 1000 ms chaque seconde et que `ReactionBanner` émet l'état fermé dès que `remainingMs` atteint 0.

#### Test 6.3.2 : Résolution Immédiate par Action MJ
- **Description** : Simuler la réception de `TableInterruptResolved { trigger_id: 42, was_interrupted: false }` pendant le compte à rebours.
- **Assertion** : Vérifier que le composant `ReactionBanner` se démonte immédiatement sans attendre l'expiration des 5000 ms.

### 6.4 Tests de l'Undo 1-Click & Restauration du Brouillard (`packages/web/tests/undo.test.ts`)

#### Test 6.4.1 : Annulation de Déplacement Token & Remboursement d'Économie
- **Description** : Simuler un déplacement de token de 30 pieds puis l'application de `ActionUndone`.
- **Assertion** : Vérifier que les coordonnées du token reviennent à leur position antérieure et que le quota `Movement` de `ActionEconomyType` est recrédité de 30 pieds.

#### Test 6.4.2 : Invalidation Transactionnelle du Cache de Brouillard
- **Description** : Invoquer `DualBufferFogOfWar.rollbackSnapshot(snapshot_id)` après l'annulation d'un déplacement.
- **Assertion** : Vérifier que les pixels modifiés par le déplacement annulé dans la texture GPU repassent à la valeur non-explorée (0).
