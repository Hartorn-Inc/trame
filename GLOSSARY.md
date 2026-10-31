# Glossaire EPURE — TRAME

Ce document normalise le vocabulaire technique et métier du projet TRAME selon les exigences de la norme ASD-STE100 (ADR-0031).

---

## Termes Métier & Domaine VTT

### Acteur
- **Définition** : Entité active du jeu (personnage-joueur, PNJ, monstre) instanciée sur la table avec des caractéristiques (PV, CA, vitesse, initiative).
- **Identifiant** : `actor_id` (UUID v4 / string hex).

### Campagne
- **Définition** : Espace persistant de jeu qui regroupe les scènes, acteurs, notes de wiki, journaux et paramètres de règles pour une table de jeu donnée.
- **Identifiant** : `campaign_id`.

### DirectiveBlock
- **Définition** : Bloc Markdown syntaxique enrichi préfixé par `:::` délimitant une section contextuelle au sein d'une note.
- **Directives reconnues** :
  - `:::dm` : Bloc secret réservé exclusivement au Maître de Jeu (`UserRole::GameMaster`).
  - `:::handout{id="..." title="..." revealed="true|false"}` : Bloc de document distribuable ou d'indice destiné à être révélé aux joueurs.
- **Règle de sécurité** : Tout bloc secret non autorisé est purgé côté serveur avant diffusion par `FilteredNoteDocument`.

### FilteredNoteDocument
- **Définition** : Module d'assainissement et de projection AST côté serveur (`trame-server`) qui parse le Markdown source et purge les blocs confidentiels (`:::dm` et `:::handout` non révélés) avant toute sérialisation HTTP ou WebSocket destinée à un utilisateur non-MJ.

### Handout
- **Définition** : Document visuel, texte, lettre ou carte destiné à être partagé avec les joueurs de la table. Un handout est initialement masqué (`revealed="false"`), puis rendu visible (`revealed="true"`) par une action explicite du Maître de Jeu.

### HandoutRevealModal
- **Définition** : Composant modal Preact de premier plan (`[data-testid="handout-reveal-modal"]`) déclenché automatiquement chez tous les clients connectés lors de la réception d'un événement `ServerEnvelope::HandoutRevealed`.

### Note
- **Définition** : Document textuel au format Markdown stocké au sein d'une campagne, classé dans un dossier optionnel et soumis à un périmètre de visibilité (`NoteVisibility`).
- **Identifiant** : `note_id`.

### NoteVisibility
- **Définition** : Énumération stricte à 3 niveaux définissant le périmètre d'accès et d'autorisation d'une note de campagne :
  - `PRIVATE` : Note personnelle appartenant à un utilisateur unique (`owner_user_id`). Invisible et inaccessible pour tous les autres membres, y compris le Maître de Jeu.
  - `PARTY` : Note collaborative partagée entre tous les joueurs et le Maître de Jeu de la campagne. Lisible et modifiable par les rôles `GameMaster` et `Player`.
  - `DM_ONLY` : Note secrète réservée exclusivement aux utilisateurs détenant le rôle `GameMaster`.

### MobileCompanionView
- **Définition** : Vue Preact tactile dédiée aux périphériques mobiles (largeur d'écran `< 768px`) ou activée manuellement via `mobileCompanionOverrideSignal`. Cette vue désactive l'allocation WebGL de `TableCanvas` et présente 5 onglets dédiés (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).

### PartyJournalEntry
- **Définition** : Entrée persistante et immuable dans la table SQL `party_journal_entries` représentant un handout formellement révélé au groupe de jeu, découplée du cycle de vie de la note source.

### SessionTimelineEvent
- **Définition** : Enregistrement append-only dans la table SQL `session_events` représentant un fait marquant de la session (début de combat, attaque, créature vaincue, porte ouverte, handout révélé) indexé par un `seq_id` monotone.

### TrameCommand
- **Définition** : Commande unitaire et typée émise par un client vers `trame-server` via WebSocket ou REST pour exécuter une mutation avec validation du rôle de l'émetteur (`UserRole`).
  - Exemple : `TrameCommand::RevealHandout { campaign_id, note_id, handout_id }`.

### UserRole
- **Définition** : Rôle d'un utilisateur au sein d'une campagne :
  - `GameMaster` : Maître de Jeu disposant de tous les privilèges d'administration et de révélation.
  - `Player` : Joueur disposant d'un accès à ses notes privées, aux notes de groupe et aux acteurs assignés.
  - `Spectator` : Observateur en lecture seule n'ayant aucun droit de mutation sur les notes ou les documents.

---

## Termes Techniques Frontend & Architecture

### DocumentsWorkspaceTab
- **Définition** : Troisième onglet de navigation au sein de `CampaignWorkspace` (`[data-testid="tab-documents"]`) regroupant l'explorateur de notes par dossiers, la galerie des handouts révélés et la chronologie des événements de session.

### localeSignal
- **Définition** : Signal réactif Preact (`@preact/signals`) stockant la langue active de l'interface (`'en' | 'fr'`), initialisé depuis `localStorage` avec repli sur `navigator.language`.

### unitSystemSignal
- **Définition** : Signal réactif Preact stockant le système d'unités actif pour les mesures tactiques (`'imperial_ft' | 'metric_m'`).
