# ADR-0034 : Modèle RBAC Zero-Trust des Notes (3 Scopes) et Cycle de Vie Transactionnel des Handouts

- **Statut** : Accepté
- **Date** : 2025-05-18
- **Auteurs** : Équipe Architecture TRAME
- **Contexte** : Issue #80, ADR-0004, ADR-0009

## Contexte

Dans TRAME, les joueurs étaient jusqu'ici empêchés de rédiger ou de modifier des notes de campagne car l'éditeur Markdown de `HudDrawers.tsx` était verrouillé par la condition `{isGm && ...}`. De plus, la structure des notes manquait d'un cloisonnement strict entre les notes personnelles du joueur, les notes communes de l'équipe et les secrets du Maître de Jeu.

Un joueur doit pouvoir documenter son historique personnel sans que le Maître de Jeu ou d'autres joueurs ne puissent l'espionner (zero-trust). Les joueurs doivent aussi collaborer sur un wiki commun (`PARTY`). Inversement, le Maître de Jeu doit pouvoir rédiger des notes secrètes (`DM_ONLY`) et insérer des directives inline secrètes (`:::dm`) ou des documents distribuables (`:::handout`) sans risque de fuite réseau vers les clients joueurs.

Enfin, lorsqu'un joueur édite une note `PARTY` contenant à l'origine des blocs secrets du MJ masqués côté client par `FilteredNoteDocument`, la soumission HTTP `PUT` ne doit en aucun cas écraser ou supprimer ces directives confidentielles.

## Décision

1. **Modèle de visibilité à 3 scopes (`NoteVisibility`)** :
   - `PRIVATE` : Associé strictement à `owner_user_id`. Le serveur applique une vérification stricte : si l'utilisateur demandeur n'est pas le propriétaire, la note est totalement invisible. Tout accès unitaire non autorisé retourne une erreur `HTTP 404 Not Found` (politique zero-trust pour empêcher l'énumération).
   - `PARTY` : Accessible en lecture et écriture pour tous les utilisateurs ayant le rôle `UserRole::GameMaster` ou `UserRole::Player` au sein de la campagne. Les utilisateurs ayant le rôle `UserRole::Spectator` ont un accès strict en lecture seule.
   - `DM_ONLY` : Accessible exclusivement aux utilisateurs ayant le rôle `UserRole::GameMaster`. Tout accès non-MJ retourne une erreur `HTTP 403 Forbidden`.

2. **Préservation structurelle des directives masquées lors des mutations Joueur** :
   - Lors de la soumission `PUT /api/v1/campaigns/{id}/notes/{note_id}` par un joueur sur une note `PARTY`, `trame-server` charge la version actuelle stockée en base de données.
   - Si le document stocké comporte des blocs `:::dm` ou des blocs `:::handout` avec `revealed="false"` qui n'étaient pas visibles pour le joueur, `trame-server` exécute une fusion structurelle en conservant intacts les blocs confidentiels du MJ aux positions AST d'origine.

3. **Cycle de vie transactionnel et découplage des Handouts** :
   - La révélation d'un handout est déclenchée par la commande unifiée `TrameCommand::RevealHandout { campaign_id, note_id, handout_id }` transmise via WebSocket ou via l'endpoint dédié `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
   - Dans une transaction SQL atomique, `trame-server` :
     1. Met à jour l'attribut `revealed="true"` dans le document Markdown source de la note.
     2. Insère ou met à jour de façon idempotente (`ON CONFLICT (handout_id) DO NOTHING`) l'entrée autonome dans la table `party_journal_entries`.
     3. Insère un enregistrement dans `session_events` avec le type `handout_revealed` et le `seq_id` monotone courant.
   - `trame-server` diffuse ensuite le message WebSocket `ServerEnvelope::HandoutRevealed` à tous les participants connectés de la campagne.
   - L'entrée dans `party_journal_entries` est autonome : la suppression ou l'édition ultérieure de la note source ne supprime pas le document déjà révélé dans le Journal de Groupe.

## Conséquences

### Positives
- Cloisonnement zero-trust garanti : les secrets des joueurs restent privés, et les secrets du MJ ne peuvent fuiter sur le réseau.
- Aucune perte accidentelle de secrets du MJ lors de l'édition collaborative des notes de groupe par les joueurs.
- Idempotence et persistance garantie des documents révélés dans le Journal de Groupe.

### Négatives / Contraintes
- Nécessité d'exécuter un merge AST côté serveur dans `trame-server` lors des requêtes `PUT` de joueurs sur des notes `PARTY` contenant des blocs secrets.
- Gestion rigoureuse des codes HTTP : `404 Not Found` pour masquer l'existence des notes `PRIVATE` tierces, `403 Forbidden` pour les refus de droits sur `DM_ONLY`.
