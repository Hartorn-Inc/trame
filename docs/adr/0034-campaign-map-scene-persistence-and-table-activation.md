# ADR 0034: Persistance Découplée des Scènes de Carte et Transition Atomique ActivateScene

## Statut
Accepté

## Contexte
Dans TRAME, la table active est gérée en mémoire par un acteur Tokio distribué (`TableRoomActor`), synchronisant l'état en temps réel via WebSockets. Auparavant, le meneur de jeu ne disposait d'aucun environnement isolé pour préparer de nouvelles scènes (dessin de murs 2.5D, configuration des lumières et des sources audio, disposition de monstres pré-placés) sans altérer l'état de la session en cours. Toute modification en direct perturbait la vue des joueurs connectés ou risquait de corrompre l'état éphémère de la session.

De plus, lors d'un changement de carte pendant une session, le transfert des personnages joueurs (`HeroToken`) vers la nouvelle scène nécessitait une ressaisie manuelle ou provoquait la perte des attributs dynamiques (points de vie, conditions, états).

## Décision
1. **Persistance REST Découplée** : Créer l'entité PostgreSQL `campaign_map_scenes` et exposer les routes REST `GET / POST / PUT / DELETE /api/v1/campaigns/{campaign_id}/maps[/{map_id}]`. Le meneur de jeu édite et sauvegarde ses scènes indépendamment du `TableRoomActor` actif.
2. **Commande Atomique ActivateScene** : Introduire le message d'acteur `ActivateScene { scene_id: Uuid }` dans `TableRoomActor`. Lors de la réception :
   - Le `TableRoomActor` charge la géométrie des `WallSegment`, les `LightSource`, les `SpatialAudioEmitter` et les `StagedToken` depuis la scène cible persistée.
   - Le `TableRoomActor` conserve tous les `HeroToken` actifs (`owner_user_id.is_some()`) sans altérer leurs points de vie, conditions ou inventaires.
   - Le `TableRoomActor` réassigne les coordonnées spatiales de chaque `HeroToken` de manière déterministe sur les `SpawnPoint` de la scène cible : `token.x = spawn_points[token_index % spawn_points.len()].x`, `token.y = spawn_points[token_index % spawn_points.len()].y`, et `token.elevation_ft = scene.default_ground_elevation_ft`. Si `spawn_points` est vide, les coordonnées sont assignées à `(0.0, 0.0, scene.default_ground_elevation_ft)`.
   - Le `TableRoomActor` instancie chaque `StagedToken` de la scène cible comme un nouveau token de table avec son `VisibilityChannel` respectif (`Public` ou `GmHidden`).
   - Le `TableRoomActor` diffuse l'événement de mise à jour complet `SceneActivated` à tous les clients connectés.

## Conséquences
### Positives
- Isolation totale du travail de préparation du MJ sans impact réseau ou mémoire sur la table en direct.
- Transition de scène instantanée et sans perte d'état dynamique pour les héros des joueurs.
- Traçabilité et sauvegarde fiable des scènes dans la base PostgreSQL de la campagne.

### Négatives
- Nécessite une synchronisation bi-directionnelle lorsque le MJ souhaite importer l'état courant d'une table active dans sa bibliothèque de scènes.
- Risque de collision d'espace lors du placement déterministe de multiples `HeroToken` sur un nombre restreint de `SpawnPoint` (géré par un offset visuel standard dans le client).