# ADR 0035: Galerie SceneAtlas, Contrôle d'Accès Zero-Trust et Masquage des Secrets

## Status
Accepted

## Context
Players use `SceneAtlas` to inspect regional maps and explored dungeon floors. However, raw `CampaignMapScene` records contain GM-only secrets (`WallType::SecretDoor`, `WallType::Illusion`, `VisibilityChannel::GmHidden` tokens, `gm_only` audio emitters, and unexplored areas). Filtering these solely on the client would leak secrets in network responses.

## Decision
1. **Strict Server-Side RBAC**: `GET /api/v1/campaigns/{id}/maps` and `GET /api/v1/campaigns/{id}/maps/{map_id}` return full scenes to `CampaignRole::Gm` and reject unrevealed scenes (`revealed_to_players == false`) with `HTTP 403 Forbidden` for `CampaignRole::Player`.
2. **Active Secret Masking**: Before serializing a revealed scene to a player, the server transforms unopened `WallType::SecretDoor` and `WallType::Illusion` segments into `WallType::Normal` (`door_state = None`), strips all `VisibilityChannel::GmHidden` tokens and `gm_only` audio emitters, and includes only the consolidated `explored_fog_texture`.

## Décision
1. **Filtrage RBAC Strict Côté Serveur** : Le contrôleur backend `GET /api/v1/campaigns/{id}/maps` et `GET /api/v1/campaigns/{id}/maps/{map_id}` évalue le rôle de l'utilisateur demandeur :
   - Si l'utilisateur possède le rôle de meneur de jeu (`CampaignRole::Gm`), le serveur renvoie l'intégralité des données sans altération.
   - Si l'utilisateur possède le rôle de joueur (`CampaignRole::Player`), le serveur rejette toute scène dont `revealed_to_players == false` avec un code HTTP `403 Forbidden`.
2. **Masquage Actif des Secrets (Data Sanitization)** : Pour toute requête émanant d'un joueur, la couche d'accès aux données du backend transforme le payload de la scène avant sérialisation :
   - Les segments `WallType::SecretDoor` ayant `door_state != DoorState::Open` sont transformés en `WallType::Normal`, avec `door_state = None`.
   - Les segments `WallType::Illusion` sont transformés en `WallType::Normal`.
   - Tous les tokens ayant `visibility == VisibilityChannel::GmHidden` sont purgés du tableau `staged_tokens`.
   - Tous les émetteurs sonores ayant `gm_only == true` sont purgés du tableau `spatial_audio_emitters`.
   - Seule la texture consolidée `explored_fog_texture` (brouillard exploré permanent) est transmise au joueur, sans révéler les zones vierges.

## Conséquences
### Positives
- Immunité cryptographique et réseau contre la triche et l'inspection de paquets côté client.
- Réutilisation d'une structure de données unifiée côté client pour le rendu de `SceneAtlas`.

### Négatives
- Surcoût CPU mineur lors de la copie et du filtrage des structures de scène dans l'API backend avant sérialisation JSON.