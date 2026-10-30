# Spécification Technique & Fonctionnelle : Wiki Collaboratif, Révélation de Handouts, Timeline de Session et Mode Compagnon Mobile

## 1. Objectif et Périmètre

Ce document spécifie l'implémentation de quatre composants intégrés pour la plateforme TRAME (`packages/web` et `crates/trame-server`) :
1. **Éditeur Markdown Wiki Collaboratif** : Support des liens de compendium `[[Entity]]` avec autocomplétion, édition multi-curseurs en temps réel via Yjs/`yrs`, et gestion sécurisée des blocs de directives `:::dm` et `:::handout`.
2. **Modal de Révélation de Handout et Journal de Groupe** : Déclenchement de l'action `[ Reveal to Party ]` par le Maître de Jeu, affichage plein écran immédiat chez tous les joueurs connectés, et archivage persistant dans le Journal de Groupe.
3. **Flux Chronologique Append-Only de Session (Session Timeline)** : Journal persistant des événements de session, exposé par WebSocket, point de terminaison REST et outil de serveur MCP (`get_session_timeline`).
4. **Mode Compagnon Mobile Découplé (< 768px)** : Layout tactile léger avec quatre onglets, interdisant formellement l'instanciation de l'application PixiJS et des Framebuffer Objects (FBO) WebGL sur les écrans de largeur inférieure à 768 pixels.

---

## 2. Modèle de Données et Architecture des Protocoles

### 2.1 Grammaire Canonique des Directives Markdown

Les documents de notes sont formatés en texte Markdown UTF-8.
Les directives interactives respectent strictement la syntaxe clé-valeur suivante :

```text
:::handout{id="<uuid>" title="<titre>" revealed="<boolean>"}
Contenu du document à révéler (texte, Markdown ou image)
:::

:::dm
Notes et secrets réservés exclusivement au Maître de Jeu
:::
```

- Les attributs de directive utilisent des guillemets doubles obligatoires.
- Le titre peut contenir des espaces et des caractères de ponctuation sans briser l'analyseur syntaxique.
- Les blocs `:::dm` ne comportent aucun attribut et masquent intégralement leur contenu textuel aux clients non-MJ.

### 2.2 Architecture de Synchronisation CRDT et Isolation Zero-Trust

Pour empêcher la fuite de secrets sans rompre les vecteurs d'état CRDT :
1. Les clients connectés avec le rôle `GameMaster` rejoignent la salle Yjs/`yrs` autoritaire via le canal WebSocket `notes:{note_id}:dm`.
2. Les clients connectés avec le rôle `Player` ou `Spectator` NE se connectent JAMAIS à la salle CRDT brute Yjs/`yrs`.
3. Les clients non-MJ s'abonnent au canal de diffusion WebSocket `notes:{note_id}:public`.
4. Lorsque le document Yjs fait l'objet d'une mise à jour par le Maître de Jeu, `trame-server` exécute la fonction de transformation pure `FilteredNoteDocument::filter_for_role(raw_content, role)` :
   - Si `role == UserRole::GameMaster`, le contenu intégral brut est conservé.
   - Si `role != UserRole::GameMaster`, le compilateur AST supprime tous les blocs délimités par `:::dm` et tous les blocs `:::handout` dont l'attribut `revealed` est égal à `"false"`.
5. `trame-server` diffuse l'instantané Markdown assaini résultant sous la forme d'un message JSON `notes.snapshot` sur le canal `notes:{note_id}:public`.

### 2.3 Schéma de Persistance SQL du Journal de Groupe

Les Handouts révélés sont persistés dans la table PostgreSQL `party_journal_entries` :

```sql
CREATE TABLE IF NOT EXISTS party_journal_entries (
    handout_id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    revealed_at BIGINT NOT NULL,
    revealed_by VARCHAR(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_party_journal_campaign ON party_journal_entries(campaign_id, revealed_at DESC);
```

### 2.4 Schéma de Persistance SQL de la Chronologie de Session

La chronologie de session repose sur un journal d'événements append-only strict :

```sql
CREATE TABLE IF NOT EXISTS session_events (
    id BIGSERIAL PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    session_num INT NOT NULL,
    session_id VARCHAR(64) GENERATED ALWAYS AS (campaign_id || ':' || session_num) STORED,
    seq_id BIGINT NOT NULL,
    timestamp BIGINT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    actor_id VARCHAR(64),
    payload_json JSONB NOT NULL,
    CONSTRAINT uq_session_seq UNIQUE (campaign_id, session_num, seq_id)
);

CREATE INDEX IF NOT EXISTS idx_session_events_lookup ON session_events(campaign_id, session_num, seq_id ASC);
```

Types d'événements supportés (`event_type`) :
- `DiceRolled` : lancer de dé exécuté avec résultat numérique.
- `CombatRoundStarted` : nouveau round de combat amorcé.
- `RoomTransitioned` : déplacement du groupe vers une nouvelle salle ou scène.
- `HandoutRevealed` : indice ou document révélé à la table.

---

## 3. Interfaces Applicatives et Contrats d'API

### 3.1 Commandes et Messages Temps-Réel WebSocket

#### Commande Émise par le Maître de Jeu (Client -> Serveur)
```json
{
  "action": "notes.reveal_handout",
  "campaign_id": "camp-123",
  "session_num": 4,
  "handout_id": "h-456",
  "title": "Lettre intercepted",
  "content": "Rendez-vous à minuit au vieux moulin."
}
```

#### Diffusion WebSocket de Révélation (Serveur -> Tous les Clients Connectés)
```json
{
  "event": "handout.revealed",
  "handout_id": "h-456",
  "title": "Lettre interceptée",
  "content": "Rendez-vous à minuit au vieux moulin.",
  "revealed_by": "user-gm-1",
  "timestamp": 1717171200000
}
```

### 3.2 Point de Terminaison REST de la Chronologie

- **Route** : `GET /api/campaigns/{campaign_id}/sessions/{session_num}/timeline`
- **Paramètres de requête** : `after` (entier optionnel, valeur par défaut `0`), `limit` (entier optionnel, valeur par défaut `50`, maximum `200`).
- **Réponse HTTP 200** :
```json
{
  "campaign_id": "camp-123",
  "session_num": 4,
  "session_id": "camp-123:4",
  "events": [
    {
      "seq_id": 1,
      "timestamp": 1717171000000,
      "event_type": "DiceRolled",
      "actor_id": "char-789",
      "payload": { "expression": "1d20+5", "total": 19 }
    },
    {
      "seq_id": 2,
      "timestamp": 1717171200000,
      "event_type": "HandoutRevealed",
      "actor_id": "user-gm-1",
      "payload": { "handout_id": "h-456", "title": "Lettre interceptée" }
    }
  ],
  "has_more": false
}
```

### 3.3 Contrat d'Outil MCP (`get_session_timeline`)

- **Nom de l'outil** : `get_session_timeline`
- **Schéma d'entrée** :
```json
{
  "type": "object",
  "properties": {
    "campaign_id": { "type": "string" },
    "session_num": { "type": "integer" }
  },
  "required": ["campaign_id", "session_num"]
}
```
- **URI de ressource MCP retournée** : `campaign://{campaign_id}/sessions/{session_num}/timeline`
- **Charge utile textuelle** : Transcription chronologique ordonnée par `seq_id` formatée en Markdown pour l'ingestion par le modèle d'IA générative.

---

## 4. Règles Métier et Invariants Déterministes (ASD-STE100)

### 4.1 Invariants d'Édition et de Confidentialité des Notes
1. `trame-server` MUST interdire à tout client ne disposant pas du rôle `GameMaster` de souscrire au canal Yjs `notes:{note_id}:dm`.
2. WHEN un client sans rôle `GameMaster` tente de souscrire à `notes:{note_id}:dm`, THEN `trame-server` MUST rejeter la souscription avec le code d'erreur `FORBIDDEN`.
3. WHEN `trame-server` sérialise un document de note pour un client sans rôle `GameMaster`, `trame-server` MUST supprimer tous les blocs `:::dm` du corps du document.
4. WHEN `trame-server` sérialise un document de note pour un client sans rôle `GameMaster`, `trame-server` MUST supprimer tous les blocs `:::handout` dont l'attribut `revealed` est égal à `"false"`.
5. IF un bloc `:::handout` possède l'attribut `revealed="true"`, THEN `trame-server` MUST conserver le bloc dans l'instantané public.

### 4.2 Invariants de Révélation de Handout
1. Seul un utilisateur disposant du rôle `GameMaster` peut émettre la commande `notes.reveal_handout`.
2. WHEN `trame-server` valide la commande `notes.reveal_handout`, THEN `trame-server` MUST enregistrer l'entrée correspondante dans la table `party_journal_entries`.
3. WHEN `trame-server` valide la commande `notes.reveal_handout`, THEN `trame-server` MUST insérer un événement de type `HandoutRevealed` dans la table `session_events`.
4. WHEN `trame-server` persiste la révélation d'un handout, THEN `trame-server` MUST diffuser l'événement `handout.revealed` à tous les clients connectés à la campagne.
5. WHEN le client `packages/web` reçoit l'événement `handout.revealed`, THEN `packages/web` MUST afficher le composant `HandoutRevealModal` contenant le titre et le texte du handout.

### 4.3 Invariants du Mode Compagnon Mobile (< 768px)
1. IF la largeur de la fenêtre du navigateur (`window.innerWidth`) est strictement inférieure à 768 pixels, THEN `packages/web` MUST activer le mode compagnon mobile.
2. WHEN le mode compagnon mobile est actif, `packages/web` MUST monter le composant racine `MobileCompanionLayout`.
3. WHEN le mode compagnon mobile est actif, `packages/web` MUST NOT instancier la classe `Application` de PixiJS.
4. WHEN le mode compagnon mobile est actif, `packages/web` MUST NOT allouer de Framebuffer Object (FBO) WebGL.
5. WHEN le mode compagnon mobile est actif, `MobileCompanionLayout` MUST présenter quatre boutons de navigation identifiés par les sélecteurs : `tab-button-sheet`, `tab-button-dice`, `tab-button-inventory`, et `tab-button-journal`.
6. WHEN l'utilisateur clique sur un bouton de navigation, `MobileCompanionLayout` MUST monter la vue associée identifiée par son attribut `data-testid` (`tab-sheet`, `tab-dice`, `tab-inventory`, ou `tab-journal`).
7. IF la largeur de la fenêtre du navigateur est supérieure ou égale à 768 pixels, THEN `packages/web` MUST monter le composant `TableCanvas`.

### 4.4 Invariants de la Chronologie de Session
1. `trame-server` MUST assigner à chaque événement dans `session_events` un identifiant séquentiel `seq_id` strictement croissant et unique pour le couple `(campaign_id, session_num)`.
2. WHEN deux commandes créent concurremment des événements pour une même session, `trame-server` MUST sérialiser l'attribution des `seq_id` via la transaction de base de données.
3. L'API `GET /api/campaigns/{campaign_id}/sessions/{session_num}/timeline` MUST retourner les événements triés par `seq_id ASC`.

---

## 5. Stratégie de Test et Validation Automatisée

Conformément aux directives d'alignement CI, la suite de tests frontend utilise exclusivement le moteur d'exécution natif Node 24 (`node:test` et `node:assert/strict`).

### 5.1 Matrice de Tests Backend (`crates/trame-server`)

1. `test_filter_for_role_purges_dm_and_unrevealed_handouts` :
   - Entrée : chaîne Markdown contenant un bloc `:::dm` et deux blocs `:::handout` (un avec `revealed="false"`, un avec `revealed="true"`).
   - Exécution : `FilteredNoteDocument::filter_for_role(input, UserRole::Player)`.
   - Assertion : la sortie ne contient aucun fragment du bloc `:::dm` ni du handout non révélé, et conserve intégralement le handout révélé.
2. `test_filter_for_role_preserves_everything_for_gamemaster` :
   - Entrée : même document Markdown.
   - Exécution : `FilteredNoteDocument::filter_for_role(input, UserRole::GameMaster)`.
   - Assertion : la sortie est strictement identique au document source.
3. `test_reveal_handout_inserts_journal_and_session_event` :
   - Exécution : envoi de la commande `notes.reveal_handout` avec identifiant de session et de handout.
   - Assertion : `party_journal_entries` contient la nouvelle ligne ; `session_events` contient un événement `HandoutRevealed` avec `seq_id == 1`.
4. `test_session_timeline_sequential_ordering_under_concurrency` :
   - Exécution : insertion concurrente de 50 événements de session via des threads parallèles.
   - Assertion : tous les `seq_id` sont contigus, sans doublon, et strictement ordonnés de 1 à 50.

### 5.2 Matrice de Tests Frontend (`packages/web`)

1. `test_mobile_companion_mode_bypasses_pixijs_canvas` :
   - Environnement : viewport simulé à 500 pixels de large.
   - Rendu : montage du composant racine de l'application.
   - Assertion : `document.querySelector('[data-testid="table-canvas"]')` est strictement `null` ; aucun appel au constructeur PixiJS n'a été émis.
2. `test_desktop_mode_mounts_table_canvas` :
   - Environnement : viewport simulé à 1024 pixels de large.
   - Rendu : montage du composant racine de l'application.
   - Assertion : `document.querySelector('[data-testid="table-canvas"]')` est présent dans le DOM.
3. `test_mobile_companion_tab_navigation` :
   - Environnement : viewport de 500 pixels.
   - Actions : clics successifs sur `tab-button-sheet`, `tab-button-dice`, `tab-button-inventory`, et `tab-button-journal`.
   - Assertions : affichage déterministe des conteneurs `tab-sheet`, `tab-dice`, `tab-inventory`, et `tab-journal`.
4. `test_handout_reveal_modal_rendering_on_event` :
   - Action : dispatch de l'événement WebSocket `handout.revealed`.
   - Assertion : le conteneur `[data-testid="handout-reveal-modal"]` apparaît et affiche le titre et le contenu du document diffusé.