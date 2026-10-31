# Spécification Technique & Fonctionnelle : 3-Scope Wiki Notes, Live Handout Modal, MobileCompanionView & i18n

- **Identifiant** : `spec-3-scope-wiki-notes-private-part`
- **Date** : 2025-05-18
- **Statut** : Prêt pour implémentation
- **Références** : Issue #80, ADR-0004, ADR-0009, ADR-0031, GLOSSARY.md

---

## 1. Objectifs & Périmètre

La présente spécification définit la mise en œuvre complète des fonctionnalités suivantes dans TRAME :
1. **Système de Wiki Notes à 3 niveaux de visibilité (`NoteVisibility`)** :
   - `PRIVATE` (notes personnelles hermétiques aux tiers et au MJ),
   - `PARTY` (wiki collaboratif partagé entre joueurs et MJ),
   - `DM_ONLY` (secrets réservés au Maître de Jeu),
   organisés par dossiers hiérarchiques dans l'onglet `DocumentsWorkspaceTab` et le tiroir latéral du plateau.
2. **Filtrage Zero-Trust côté serveur (`FilteredNoteDocument`)** :
   - Purge des blocs secrets `:::dm` et `:::handout{revealed="false"}` pour les utilisateurs non-MJ.
   - Algorithme de préservation et fusion AST pour préserver les blocs confidentiels du MJ lors des éditions `PUT` par des joueurs sur les notes `PARTY`.
3. **Cycle de vie transactionnel et révélation de Handout en direct** :
   - Commande d'émission `TrameCommand::RevealHandout` via WebSocket et endpoint REST `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
   - Persistance découplée dans la table SQL `party_journal_entries` et timeline `session_events`.
   - Broadcast WebSocket `ServerEnvelope::HandoutRevealed` déclenchant l'ouverture automatique du composant Preact `[data-testid="handout-reveal-modal"]`.
4. **Vue Mobile Compagnon Preact (`MobileCompanionView`)** :
   - Montage conditionnel réactif pour viewports `< 768px` ou activation explicite via `mobileCompanionOverrideSignal`.
   - Destruction propre de l'instance WebGL/PixiJS (`app.destroy(true, { children: true, texture: false })`).
   - Interface tactile à 5 onglets (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).
5. **Couche de Présentation Réactive Bilingue et Unités Métriques (`i18n`)** :
   - Signaux réactifs globaux `localeSignal` (`'en' | 'fr'`) et `unitSystemSignal` (`'imperial_ft' | 'metric_m'`).
   - Fonction de formatage unifiée `formatDistanceFt(feet)` gérant le singulier/pluriel des cases.
   - Dictionnaire bilingue bidirectionnel pour la recherche dans le Compendium sans altération des slugs canoniques en anglais.

---

## 2. Modèle de Données & Schéma SQL

### 2.1 Table `campaign_notes`

Chaque note de campagne est stockée dans la table existante `campaign_notes` avec le schéma d'autorisation enrichi :

```sql
ALTER TABLE campaign_notes ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'PARTY';
ALTER TABLE campaign_notes ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE campaign_notes ADD COLUMN IF NOT EXISTS folder VARCHAR(255) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_campaign_notes_visibility ON campaign_notes(campaign_id, visibility, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_notes_folder ON campaign_notes(campaign_id, folder);
```

- `visibility` prend l'une des trois valeurs : `'PRIVATE'`, `'PARTY'`, `'DM_ONLY'`.
- `owner_user_id` référence l'identifiant du créateur de la note (obligatoire pour `PRIVATE`).
- `folder` représente le chemin logique du dossier (ex. `""`, `"Quêtes"`, `"PNJ/Alliés"`).

### 2.2 Table `party_journal_entries`

Table autonome et découplée pour stocker les handouts révélés au groupe de jeu :

```sql
CREATE TABLE IF NOT EXISTS party_journal_entries (
    handout_id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    revealed_at BIGINT NOT NULL,
    revealed_by VARCHAR(64) NOT NULL,
    CONSTRAINT fk_party_journal_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_party_journal_campaign ON party_journal_entries(campaign_id, revealed_at DESC);
```

### 2.3 Table `session_events`

Table append-only pour la chronologie des événements de session de jeu :

```sql
CREATE TABLE IF NOT EXISTS session_events (
    id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    session_num INT NOT NULL DEFAULT 0,
    seq_id BIGINT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_session_events_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_events_campaign_seq ON session_events(campaign_id, seq_id ASC);
```

---

## 3. Spécification Backend (`trame-server`)

### 3.1 Règles d'Autorisation RBAC par Scope

| Scope | Rôle Client | Lecture (`GET`) | Création (`POST`) | Modification (`PUT`) | Suppression (`DELETE`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `PRIVATE` | Propriétaire (`owner_user_id == user.id`) | Autorisé | Autorisé | Autorisé | Autorisé |
| `PRIVATE` | Autre Joueur ou GM (`owner_user_id != user.id`) | **HTTP 404** | Refusé | Refusé | Refusé |
| `PARTY` | `GameMaster` ou `Player` | Autorisé | Autorisé | Autorisé (avec fusion AST) | Autorisé |
| `PARTY` | `Spectator` | Autorisé | **HTTP 403** | **HTTP 403** | **HTTP 403** |
| `DM_ONLY` | `GameMaster` | Autorisé | Autorisé | Autorisé | Autorisé |
| `DM_ONLY` | `Player` ou `Spectator` | **HTTP 403** | **HTTP 403** | **HTTP 403** | **HTTP 403** |

### 3.2 Filtrage Zero-Trust (`FilteredNoteDocument`)

1. `FilteredNoteDocument::filter_for_user(markdown: &str, role: UserRole) -> String` :
   - IF `role == UserRole::GameMaster`, THEN `FilteredNoteDocument` retourne le texte intégral sans altération.
   - IF `role != UserRole::GameMaster` :
     1. Le parseur supprime l'intégralité de chaque bloc `:::dm ... :::`.
     2. Le parseur inspecte chaque bloc `:::handout{...} ... :::` :
        - IF `revealed="true"`, THEN le bloc est conservé.
        - IF `revealed="false"` ou attribut `revealed` absent, THEN le bloc est totalement supprimé.

### 3.3 Préservation des Directives Confidentielles lors du PUT par un Joueur

WHEN un utilisateur avec `user.role != UserRole::GameMaster` transmet une requête `PUT /api/v1/campaigns/{id}/notes/{note_id}` sur une note de portée `PARTY` :
1. `trame-server` extrait le document actuellement persisté en base de données.
2. `trame-server` extrait la liste ordonnée des directives confidentielles masquées au joueur (`:::dm` et `:::handout{revealed="false"}`) avec leurs positions relatives dans l'AST Markdown d'origine.
3. Si des blocs confidentiels existent dans la note stockée mais sont absents du contenu soumis, `trame-server` fusionne le nouveau texte soumis avec les directives confidentielles d'origine en réinsérant les blocs masqués intacts à leurs emplacements correspondants avant la mise à jour SQL.

### 3.4 Contrats d'API REST des Notes

#### `GET /api/v1/campaigns/{id}/notes`
- Retourne la liste des notes visibles pour l'utilisateur appelant :
  - Inclut toutes les notes `PARTY`.
  - Inclut les notes `PRIVATE` dont `owner_user_id == current_user.id`.
  - Si `current_user.role == GameMaster`, inclut toutes les notes `DM_ONLY`.
- Chaque note retournée contient son contenu filtré via `FilteredNoteDocument`.
- Code de retour : `200 OK`.

#### `GET /api/v1/campaigns/{id}/notes/{note_id}`
- IF la note n'existe pas, retourne `404 Not Found`.
- IF la note a la visibilité `PRIVATE` et `owner_user_id != current_user.id`, retourne `404 Not Found` (zero-trust : aucune fuite de métadonnées ou d'existence).
- IF la note a la visibilité `DM_ONLY` et `current_user.role != GameMaster`, retourne `403 Forbidden`.
- IF l'accès est autorisé, retourne le document filtré avec `200 OK`.

#### `POST /api/v1/campaigns/{id}/notes`
- Payload JSON :
  ```json
  {
    "title": "string",
    "content": "string",
    "visibility": "PRIVATE | PARTY | DM_ONLY",
    "folder": "string"
  }
  ```
- IF `visibility == 'DM_ONLY'` et `current_user.role != GameMaster`, retourne `403 Forbidden`.
- IF `visibility == 'PRIVATE'`, `owner_user_id` est assigné automatiquement à `current_user.id`.
- Code de retour : `201 Created` avec le JSON de la note créée.

#### `PUT /api/v1/campaigns/{id}/notes/{note_id}`
- Payload JSON :
  ```json
  {
    "title": "string",
    "content": "string",
    "folder": "string"
  }
  ```
- IF la note est `PRIVATE` et `owner_user_id != current_user.id`, retourne `404 Not Found`.
- IF la note est `DM_ONLY` et `current_user.role != GameMaster`, retourne `403 Forbidden`.
- IF la note est `PARTY` et `current_user.role == Spectator`, retourne `403 Forbidden`.
- IF la note est `PARTY` et `current_user.role == Player`, exécute la fusion structurelle spécifiée en section 3.3.
- Code de retour : `200 OK`.

#### `DELETE /api/v1/campaigns/{id}/notes/{note_id}`
- IF la note est `PRIVATE` et `owner_user_id != current_user.id`, retourne `404 Not Found`.
- IF la note est `DM_ONLY` et `current_user.role != GameMaster`, retourne `403 Forbidden`.
- IF la note est `PARTY` et `current_user.role == Spectator`, retourne `403 Forbidden`.
- IF la note est `PARTY` et `current_user.role` est `GameMaster` ou `Player`, supprime la note et retourne `204 No Content`.

---

## 4. Spécification du Cycle de Vie des Handouts

### 4.1 Commande de Révélation

La révélation d'un handout est déclenchée soit par l'action WebSocket `TrameCommand::RevealHandout`, soit par l'endpoint REST dédié :

- **Route REST** : `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`
- **Payload JSON** :
  ```json
  {
    "handout_id": "string"
  }
  ```
- **Contrôle d'accès** : Seul le rôle `GameMaster` est autorisé. Tout autre rôle reçoit `403 Forbidden`.

### 4.2 Traitement Transactionnel Atomique

Lors de l'exécution de la révélation, `trame-server` exécute les étapes suivantes dans une transaction SQL unique :
1. Recherche du bloc `:::handout{id="<handout_id>"...}` dans le document Markdown de la note `note_id`.
   - IF le bloc n'existe pas, retourne `404 Not Found`.
2. Remplacement de l'attribut `revealed="false"` par `revealed="true"` dans le Markdown source de la note.
3. Insertion dans `party_journal_entries` :
   ```sql
   INSERT INTO party_journal_entries (handout_id, campaign_id, title, content, revealed_at, revealed_by)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (handout_id) DO UPDATE SET
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       revealed_at = EXCLUDED.revealed_at;
   ```
4. Résolution de `session_num` :
   - `trame-server` interroge l'état actif dans `TableRoomActor` pour la campagne `campaign_id`.
   - IF une session est active, THEN `session_num` prend la valeur de la session courante.
   - ELSE `session_num` prend la valeur `0`.
5. Incrémentation atomique du `seq_id` de la campagne et insertion de l'événement dans `session_events` :
   ```sql
   INSERT INTO session_events (id, campaign_id, session_num, seq_id, event_type, payload, created_at)
   VALUES ($1, $2, $3, $4, 'handout_revealed', $5, $6);
   ```
6. Diffusion du message WebSocket `ServerEnvelope::HandoutRevealed` à tous les clients connectés de la salle de table de jeu :
   ```json
   {
     "type": "HandoutRevealed",
     "payload": {
       "handout_id": "string",
       "title": "string",
       "content": "string",
       "revealed_at": 1716000000000,
       "revealed_by": "user_id"
     }
   }
   ```

### 4.3 Endpoint de Consultation du Journal de Groupe

- **Route REST** : `GET /api/v1/campaigns/{id}/journal`
- **Autorisation** : Tout participant authentifié (`GameMaster`, `Player`, `Spectator`).
- **Retour** : Tableau des entrées `PartyJournalEntry` ordonnées par `revealed_at DESC`.
- Code de retour : `200 OK`.

### 4.4 Endpoint de Consultation de la Chronologie des Événements

- **Route REST** : `GET /api/v1/campaigns/{id}/timeline`
- **Paramètres Query optionnels** : `since_seq_id=0`, `limit=50`.
- **Autorisation** : Tout participant authentifié.
- **Retour** : Tableau des `SessionTimelineEvent` triés par `seq_id ASC`.
- Code de retour : `200 OK`.

---

## 5. Spécification Frontend Preact & Mobile Companion

### 5.1 Architecture des Signaux et Modale de Handout

- Fichier : `packages/web/src/state/handoutSignals.ts`
- Exporte les signaux Preact réactifs :
  - `activeRevealedHandoutSignal = signal<PartyJournalEntry | null>(null)` : Handout actuellement affiché dans la modale plein écran.
  - `revealedHandoutsSignal = signal<PartyJournalEntry[]>([])` : Liste complète des handouts archivés dans la campagne.
- Intégration WebSocket (`packages/web/src/network/wsClient.ts`) :
  - Dès réception d'un frame `HandoutRevealed` :
    1. L'objet handout est prependé dans `revealedHandoutsSignal.value`.
    2. `activeRevealedHandoutSignal.value` est assigné avec ce handout.
- Composant `HandoutRevealModal` (`packages/web/src/components/handouts/HandoutRevealModal.tsx`) :
  - Sélecteur de test : `[data-testid="handout-reveal-modal"]`.
  - IF `activeRevealedHandoutSignal.value !== null`, affiche la modale par-dessus l'interface avec le titre, le corps formaté Markdown et un bouton de fermeture `[data-testid="close-handout-modal"]`.
  - Le clic sur la fermeture remet `activeRevealedHandoutSignal.value = null`.

### 5.2 DocumentsWorkspaceTab (`Tab 3`)

- Composant monté dans `CampaignWorkspace` pour le sélecteur `[data-testid="tab-documents"]`.
- Divisé en 3 sous-sections :
  1. **Explorateur de Notes & Arborescence Dossiers** :
     - Sélecteurs de filtrage par visibilité : `[data-testid="filter-private"]`, `[data-testid="filter-party"]`, `[data-testid="filter-dm-only"]` (visible uniquement pour le GM).
     - Arborescence groupée par dossier logique (`folder`).
     - Bouton de création de note : `[data-testid="create-note-btn"]` avec sélection du scope `PRIVATE` ou `PARTY` (ou `DM_ONLY` pour le GM).
     - Éditeur Markdown bidirectionnel supportant les directives `:::handout` et `:::dm`.
     - Pour chaque directive `:::handout` présente dans l'éditeur du GM : bouton d'action `[data-testid="btn-reveal-handout"]` déclenchant `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
  2. **Galerie des Handouts Révélés** (`[data-testid="past-handouts-gallery"]`) :
     - Liste en grille des cartes de handouts archivés issus de `GET /api/v1/campaigns/{id}/journal`.
     - Clic sur une carte ouvre le contenu dans `HandoutRevealModal`.
  3. **Chronologie des Événements (`SessionTimelineViewer`)** (`[data-testid="session-timeline-viewer"]`) :
     - Flux chronologique défilant des événements (`combat_started`, `attack_rolled`, `creature_defeated`, `door_opened`, `handout_revealed`).

### 5.3 MobileCompanionView (`< 768px`)

- Fichier : `packages/web/src/components/mobile/MobileCompanionView.tsx`.
- Sélecteur de test : `[data-testid="mobile-companion-view"]`.
- Règle de basculement dans `App.tsx` :
  ```typescript
  const shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768);
  ```
- Cycle de destruction PixiJS :
  - WHEN `shouldMountCanvas.value === false`, THEN le hook de nettoyage appelle `pixiApp.destroy(true, { children: true, texture: false })` et supprime l'élément canvas WebGL du DOM.
  - Le composant `MobileCompanionView` est alors rendu en plein écran.
- Onglets de la barre de navigation tactile inférieure (`[data-testid="mobile-bottom-nav"]`) :
  1. `[data-testid="nav-sheet"]` : Fiche de personnage condensée et tactile.
  2. `[data-testid="nav-dice"]` : Lanceur de dés rapide 3D / standard.
  3. `[data-testid="nav-inventory"]` : Gestion d'équipement et consommables.
  4. `[data-testid="nav-tracker"]` : Suivi d'initiative et d'état du tour.
  5. `[data-testid="nav-journal"]` : Consultation des notes `PRIVATE`/`PARTY` et galerie des Handouts.

---

## 6. Spécification i18n & Unités Métriques

### 6.1 Architecture du Module `packages/web/src/i18n/`

- Signaux globaux :
  - `localeSignal = signal<'en' | 'fr'>('en')`.
  - `unitSystemSignal = signal<'imperial_ft' | 'metric_m'>('imperial_ft')`.
- Fonction de traduction `t(key: string, vars?: Record<string, string | number>): string` :
  - Résout la clé dans le dictionnaire de `localeSignal.value`.
  - Remplace les interpolations `{{var}}`.
  - Si la clé est introuvable, retourne la clé anglaise de repli.

### 6.2 Formatage des Mesures Tactiques

- Fonction unifiée : `formatDistanceFt(feet: number): string`.
- Règles de calcul et grammaire ASD-STE100 :
  - IF `unitSystemSignal.value === 'imperial_ft'` :
    - Retourne `${feet} ft`.
  - IF `unitSystemSignal.value === 'metric_m'` :
    - Calcule `meters = feet * 0.3`.
    - Calcule `squares = Math.round(feet / 5)`.
    - Règle de singulier/pluriel : `unit_label = squares <= 1 ? 'case' : 'cases'`.
    - Retourne `${meters} m (${squares} ${unit_label})`.
- Exemples normatifs :
  - `formatDistanceFt(5)` en métrique $\to$ `"1.5 m (1 case)"`.
  - `formatDistanceFt(30)` en métrique $\to$ `"9 m (6 cases)"`.

### 6.3 Recherche Bilingue Compendium

- Le dictionnaire bilingue bidirectionnel (`compendiumLexicon.ts`) mappe les termes français vers les slugs canoniques anglais :
  - *Furtivité* $\leftrightarrow$ `stealth`
  - *Force* $\leftrightarrow$ `strength`
  - *Boule de feu* $\leftrightarrow$ `fireball`
  - *Repos court* $\leftrightarrow$ `short_rest`
- Lors d'une saisie utilisateur dans la barre de recherche du Compendium, la requête est normalisée : si une correspondance est trouvée dans le lexique pour `localeSignal.value === 'fr'`, le slug canonique correspondant est également inclus dans l'interrogation du moteur d'indexation sans dupliquer les packs de données SRD.

---

## 7. Fichiers Cibles Impactés

- Backend (`trame-server`) :
  - `packages/server/src/db/schema.sql` (ou migrations Diesel/SQLx)
  - `packages/server/src/api/notes.rs`
  - `packages/server/src/api/journal.rs`
  - `packages/server/src/markdown/filtered_document.rs`
  - `packages/server/src/markdown/ast_merge.rs`
  - `packages/server/src/ws/table_room.rs`
- Frontend (`packages/web`) :
  - `packages/web/src/state/handoutSignals.ts`
  - `packages/web/src/i18n/index.ts`
  - `packages/web/src/i18n/locales/en.ts`
  - `packages/web/src/i18n/locales/fr.ts`
  - `packages/web/src/i18n/compendiumLexicon.ts`
  - `packages/web/src/components/handouts/HandoutRevealModal.tsx`
  - `packages/web/src/components/workspace/DocumentsWorkspaceTab.tsx`
  - `packages/web/src/components/workspace/SessionTimelineViewer.tsx`
  - `packages/web/src/components/mobile/MobileCompanionView.tsx`
  - `packages/web/src/network/wsClient.ts`
  - `packages/web/src/App.tsx`

---

## 8. Critères d'Acceptation & Plan de Tests

### 8.1 Tests d'Intégration Backend (Rust)

1. `test_notes_rbac_isolation` :
   - Créer une note `PRIVATE` pour le Joueur A.
   - Requête `GET /api/v1/campaigns/{id}/notes/{note_id}` par le Joueur B $\to$ Reçoit `HTTP 404 Not Found`.
   - Requête `GET /api/v1/campaigns/{id}/notes/{note_id}` par le GameMaster $\to$ Reçoit `HTTP 404 Not Found`.
   - Créer une note `DM_ONLY` par le GameMaster.
   - Requête `GET /api/v1/campaigns/{id}/notes/{note_id}` par le Joueur A $\to$ Reçoit `HTTP 403 Forbidden`.
2. `test_party_note_ast_merge_preserves_gm_secrets` :
   - Le GameMaster crée une note `PARTY` avec un secret : `"Texte public\n\n:::dm\nSecret MJ\n:::\n\nFin public"`.
   - Le Joueur A lit la note : il reçoit `"Texte public\n\nFin public"`.
   - Le Joueur A soumet un `PUT` avec `"Texte public modifié\n\nFin public"`.
   - Le GameMaster lit la note : le bloc `:::dm\nSecret MJ\n:::` est toujours présent dans la note stockée.
3. `test_reveal_handout_atomicity` :
   - Le GameMaster appelle `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout` avec `handout_id = "clue-1"`.
   - Vérifier que `party_journal_entries` contient une ligne pour `clue-1`.
   - Vérifier que `session_events` contient une ligne `handout_revealed`.
   - Vérifier que le Joueur A peut désormais lire le handout via `GET /api/v1/campaigns/{id}/journal`.

### 8.2 Tests Fonctionnels Frontend (Vitest / Playwright)

1. `test_handout_modal_opens_on_websocket_envelope` :
   - Simuler la réception de `ServerEnvelope::HandoutRevealed` sur `wsClient`.
   - Vérifier que l'élément `[data-testid="handout-reveal-modal"]` devient visible.
   - Cliquer sur `[data-testid="close-handout-modal"]` et vérifier que la modale disparaît.
2. `test_mobile_companion_view_lifecycle` :
   - Redimensionner le viewport à `390px` de large.
   - Vérifier que `[data-testid="mobile-companion-view"]` est rendu dans le DOM.
   - Vérifier que l'instance `TableCanvas` PixiJS est détruite et absente du DOM.
   - Basculer sur l'onglet `[data-testid="nav-journal"]` et vérifier l'affichage des notes.
3. `test_i18n_formatting_and_units` :
   - Initialiser `localeSignal.value = 'fr'` et `unitSystemSignal.value = 'metric_m'`.
   - Vérifier que `formatDistanceFt(5)` produit exactement `"1.5 m (1 case)"`.
   - Vérifier que `formatDistanceFt(30)` produit exactement `"9 m (6 cases)"`.
   - Vérifier que la bascule sur `unitSystemSignal.value = 'imperial_ft'` produit `"30 ft"`.
