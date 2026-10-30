# TRAME — Phase 4 : Architecture Temps-Réel (Command Handler, Acteurs RAM) & Hébergement Dédié

Ce document spécifie l'architecture d'exécution interne du serveur Rust (`trame-server`), le pattern **Command Handler + Reversible Event Log**, la résilience zéro-perte (WAL), le protocole WebSocket, l'authentification et le modèle d'**Hébergement Dédié à la Demande** (1 Micro-Instance multi-campagnes + 1 base Neon Serverless Postgres dédiée + Cloudflare R2).

---

## 1. Pattern Central : Command Handler + Reversible Event Log

Toute mutation d'état dans TRAME — qu'elle provienne d'un clic sur le Canvas PixiJS, d'une édition de feuille React, d'une requête REST ou d'un appel d'outil MCP — passe obligatoirement par un **Command Dispatcher** unique.

```mermaid
sequenceDiagram
    participant Client as Client (WebSocket UI / HTTP / MCP Tool)
    participant Auth as Auth & RBAC Guard
    participant Dispatcher as CommandHandler (Rust)
    participant Actor as TableRoomActor (RAM)
    participant Engine as trame-engine (Règles & Raycasting)
    participant DB as Write-Behind + WAL (Neon Postgres)

    Client->>Auth: Envoie `TrameCommand` + Contexte Utilisateur
    Auth->>Dispatcher: `AuthenticatedCommand { user_id, role, cmd }`
    Dispatcher->>Actor: Route vers l'Acteur de la Campagne
    Actor->>Engine: Valide règles + collisions + calcule visibilité (< 1ms)
    Engine-->>Actor: `StateTransition { new_state, events, undo_patch }`
    Actor->>Actor: Pousse `undo_patch` dans la pile d'historique MJ
    Actor-->>Client: Diffuse `TrameEvent` filtré par joueur (WebSocket)
    Actor-)DB: Journalise WAL & enfile la mutation dans le buffer asynchrone
```

### 1.1 Structure Rust du `TrameCommand` et Auto-Génération MCP

Chaque commande est une variante d'énumération fortement typée annotée avec `serde` et `schemars::JsonSchema`. Le serveur MCP lit directement ces schémas à la compilation pour exposer les `Tools` MCP sans aucune duplication de code :

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "domain", content = "action", rename_all = "snake_case")]
pub enum TrameCommand {
    Table(TableCommand),       // MoveToken, InteractDoor, PlaceAoE, SetLightingPreset, SetMode...
    Combat(CombatCommand),     // StartCombat, RollInitiative, SpendActionEconomy, NextTurn...
    Actor(ActorCommand),       // UpdateSheet, EquipItem, TransformShape, CastSpell, TakeRest...
    Map(MapCommand),           // CreateMap, ImportUvtt, SetWalls, SetLights, EditFog, SpawnTokens...
    Note(NoteCommand),         // UpsertNote, RevealHandout, SyncBatch...
    History(HistoryCommand),   // UndoLastAction { action_id }, RedoAction
}
```

### 1.2 Gestion Native du `Undo / Redo` MJ (`ReversiblePatch`)

Lorsqu'un `CommandHandler` exécute une commande sur la Table, il retourne une structure `CommandOutcome` :

```rust
pub struct CommandOutcome {
    pub events: Vec<TrameEvent>,
    pub undo_entry: Option<UndoEntry>,
}

pub struct UndoEntry {
    pub action_id: Uuid,
    pub actor_user_id: Uuid,
    pub summary: String,               // ex: "Déplacement de Thorin (6 cases) + Révélation brouillard"
    pub inverse_ops: Vec<StatePatch>,  // Remet x/y, recrédite 30ft de mouvement, restaure le masque d'exploration
}
```

* Le `TableRoomActor` conserve une pile circulaire des **100 dernières actions** de la session en mémoire.
* Quand le MJ clique sur **"Annuler (`Undo`)"** (ou appelle `table.undo_last_action` via MCP), l'acteur applique `inverse_ops` en $< 1\text{ ms}$, restaure le masque de brouillard d'avant le mouvement fautif, et diffuse l'état corrigé à tous les joueurs.

---

## 2. Le `TableRoomActor` : État Temps-Réel en Mémoire & Garantie Zéro-Perte (Q9)

### 2.1 Exécution en RAM, Persistance `Write-Behind` & `Immediate Commit` Critique

1. **Chargement à chaud (`Hydration`)** :
   * Dès que le premier membre (ou agent MCP) ouvre une campagne, `trame-server` instancie un `TableRoomActor`, charge la carte active, ses murs (construit le BVH spatial en $< 2\text{ ms}$), ses tokens et les fiches des acteurs depuis Neon Postgres.
2. **Deux Niveaux de Persistance (Haute Fréquence vs Critique)** :
   * **Mutations haute fréquence (`Write-Behind Batching — 1s`)** : Les glissements de tokens, mises à jour de masques de brouillard LZ4 et ajustements continus sont regroupés et écrits vers Neon toutes les **1 seconde**.
   * **Mutations critiques (`Immediate Commit` + Journal d'Événements `command_wal`)** : Les jets de dés finaux, pertes de PV, dépenses d'emplacements de sorts, transferts d'inventaire, changements de tour et éditions de notes sont **écrits immédiatement** dans une table append-only légère (`command_wal`) sur Neon + acquittés au client.
3. **Graceful Shutdown & Resynchronisation Client (`last_acked_seq`)** :
   * Chaque événement envoyé par le serveur porte un numéro de séquence monotone `seq: u64`.
   * Sur réception d'un signal `SIGTERM` (ex: Cloud Run arrêtant une instance), le serveur bloque les nouvelles entrées et **flush l'intégralité des acteurs en RAM vers Neon en $< 150\text{ ms}$** avant de rendre la main.
   * Même en cas de crash brutal du conteneur, le client reconnecté renvoie les éventuelles commandes non-acquittées (`seq > server_seq`), garantissant **zéro perte d'action**.

### 2.2 Sécurité Cryptographique des Jets de Dés (`Server-Side CSPRNG` — Q14)

* **Aucun jet de dé n'est jamais tiré par le navigateur du client.**
* L'évaluateur de formules dans WASM côté client ne sert qu'à **valider la syntaxe** (`2d20kh1 + 5`) et afficher l'aperçu des modificateurs avant le jet.
* Le tirage aléatoire réel est exécuté **exclusivement sur le serveur Rust** via un générateur cryptographiquement sûr (`ChaCha20Rng` initialisé par l'entropie de l'OS), signé et horodaté dans le journal de session.

### 2.3 Réinitialisation & Gestion du Brouillard d'Exploration (Q15)

* Lorsqu'un MJ réutilise une carte (ou que des gardes patrouillent après le départ des joueurs), il dispose de **3 outils de réinitialisation de la Mémoire d'Exploration (`Explored Memory`)** :
  1. **Gomme de Mémoire d'Exploration (Pinceau / Polygone)** : Efface la mémoire grisée d'une salle spécifique (les joueurs devront à nouveau y entrer pour voir ce qui a changé).
  2. **Réinitialisation par Joueur ou Groupe (1 clic)** : Remet à zéro la mémoire d'exploration de toute la carte.
  3. **Mode "Sans Mémoire d'Exploration" (*Hardcore / Labyrinthe mouvant*)** : Option par carte où seul le champ de vision actif est visible ; tout ce qui sort de la ligne de vue redevient noir.

---

## 3. Authentification, Sécurité des Médias & Portabilité Totale

### 3.1 Authentification & Onboarding Sans Friction

1. **Lien d'Invitation Directe à une Campagne + Magic Link / Argon2id**.
2. **OAuth2 / OIDC Optionnel (Discord & Google)**.
3. **Sécurité Administrateur / MJ (TOTP MFA) & Personal Access Tokens (`trame_pat_...`)** scopés par rôle et par campagne pour le serveur MCP.

### 3.2 Sécurité d'Accès aux Cartes sur Cloudflare R2 / S3 (Anti-Leak MJ — Q10)

Pour empêcher un joueur curieux de deviner l'URL d'une carte ou de télécharger l'image haute résolution d'un donjon contenant des salles secrètes avant d'y être entré :

1. **Clés d'Objets Opaques Non-Devables** : Chaque fichier sur R2/S3 est stocké sous un identifiant `UUIDv4` aléatoire (`instances/{instance_id}/maps/{random_uuid}.webp`) sans aucun nom de fichier lisible.
2. **URLs Pré-Signées Courtes (`Presigned URLs — TTL 15 min`) générées après contrôle RBAC** :
   * Le bucket R2/S3 est **100% privé** (aucun accès public direct).
   * `trame-server` ne génère une URL signée pour une carte ou un handout que si le joueur est actuellement sur cette carte (ou que le handout a `revealed = true`).
3. **Séparation Calque Joueur vs Calque MJ (zéro secret sur l'image de fond)** :
   * Lors de l'import `.uvtt` ou de la création d'une carte, les annotations secrètes du MJ (numéros de salles, pièges, passages secrets) sont placées sur le calque vectoriel `DM_ONLY` (jamais envoyées aux joueurs), tandis que l'image WebP envoyée au navigateur ne contient que le décor graphique nu.

### 3.3 Portabilité & Sauvegarde : Format Ouvert `.trame` (Q11)

Pour garantir la réversibilité totale entre **Cloud Dédié (Cloud Run + Neon + R2)** et **Auto-Hébergement local (Docker / VM `e2-micro` / NAS)** :

* L'interface d'administration (et la commande CLI `trame-cli archive export`) permet d'exporter à tout moment **une Campagne** ou **l'Instance entière** sous forme d'une archive standard **`.trame` (ZIP chiffrable AES-256-GCM)** contenant :
  1. `manifest.json` (version du format, métadonnées, checksums SHA-256),
  2. `systems/` (tous les `GameSystemPack` YAML/JSON utilisés),
  3. `data/` (tous les acteurs, cartes, murs, lumières, tokens et journal de sessions en JSONL propre et indépendant du moteur SQL),
  4. `notes/` (l'arborescence complète des fichiers Markdown du Wiki avec leur frontmatter YAML, directement ouvrable dans **Obsidian** !),
  5. `assets/` (toutes les images WebP et pistes audio).
* Importer un fichier `.trame` sur n'importe quelle autre instance TRAME restaure 100% de la campagne en quelques secondes.

---

## 4. Hébergement Dédié à la Demande : Cloud Run vs VM `e2-micro`

### 4.1 Modèle Cible : 1 Micro-Instance Dédiée = 1 Serveur de Groupe Multi-Campagnes

* **1 conteneur / binaire `trame-server`** (~20–35 Mo RAM).
* **1 base de données Neon Serverless Postgres dédiée** (via pooler PgBouncer `:6543`).
* **1 préfixe privé sur Cloudflare R2 / S3** ou volume local.

### 4.2 Cycle de Vie `Scale-to-Zero` & `Idle-Lease` (0 € au repos sur Cloud Run + Neon)

* Les *pings* réseau ne réinitialisent pas le compteur d'inactivité.
* Après **15 minutes sans action humaine** (ou 5 minutes si tous les onglets sont en arrière-plan), `trame-server` flush son état en RAM vers Neon, envoie `HIBERNATING` aux clients et ferme les WebSockets $\rightarrow$ Cloud Run et Neon retombent à **0 CPU / 0 €**.
* Au moindre clic d'un joueur ou appel MCP, l'instance se réveille en **~25 ms** (Rust) + **~300 ms** (Neon) et reprend la session sans aucune couture.

---

## 5. UX Responsive Tablette / Mobile & Accessibilité (Q21, Q22)

1. **Mode Compagnon Joueur sur Tablette & Mobile (`Companion Mode`)** :
   * Sur iPad / tablette : navigation tactile complète sur la carte PixiJS (*pinch-to-zoom*, *two-finger pan*, appui long pour ping/mesure).
   * Sur smartphone (ou autour d'une table physique avec écran TV central) : bascule automatique ou manuelle en **Vue Compagnon Mobile** ultra-rapide affichant la **Feuille de Personnage D&D 5e**, le **Lanceur de Dés**, l'**Inventaire**, le **Suivi d'Initiative** et les **Notes**, synchronisés en temps réel avec la Table principale !
2. **Thèmes, Contrastes WCAG AA & Confort Visuel** :
   * Système de jetons CSS sémantiques supportant les thèmes sombres/clairs/parchemin, mode daltonien sur les anneaux tactiques et les gabarits AoE (motifs hachurés en plus des couleurs vert/jaune/rouge), et respect de `prefers-reduced-motion` (désactivation des secousses d'écran et animations de météo/lumières).
