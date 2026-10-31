# ADR 0034: Persistance Découplée des Scènes de Carte et Transition Atomique ActivateScene

## Status
Accepted

## Context
In TRAME, the live tabletop is managed in memory by a distributed Tokio actor (`TableRoomActor`) synchronizing real-time state over WebSockets. Previously, the Game Master lacked an isolated preparation environment to author new scenes (drawing 2.5D walls, configuring lights and spatial audio emitters, staging monsters) without mutating the live session. Moreover, switching maps during a session required manual re-entry or risked losing dynamic player token state (`HeroToken` HP, conditions, inventory).

## Decision
1. **Decoupled REST Persistence**: Persist `campaign_map_scenes` in PostgreSQL and expose `GET / POST / PUT / DELETE /api/v1/campaigns/{campaign_id}/maps[/{map_id}]` so the GM can author and save scenes independently of the active `TableRoomActor`.
2. **Atomic `ActivateScene` Command**: When `TableRoomActor` receives `ActivateScene { scene_id }`:
   - It loads the target scene's `WallSegment`, `LightSource`, `SpatialAudioEmitter`, and `StagedToken` entities.
   - It preserves all active `HeroToken` instances (`owner_user_id.is_some()`) along with their HP, conditions, and inventories.
   - It deterministically relocates each `HeroToken` onto the target scene's `SpawnPoint` coordinates (`spawn_points[token_index % spawn_points.len()]`, or `(0.0, 0.0)` when empty) at `default_ground_elevation_ft`.
   - It instantiates each `StagedToken` with its configured `VisibilityChannel` (`Public` or `GmHidden`) and broadcasts `SceneActivated`.

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