# ADR 0035: Galerie SceneAtlas, Contrôle d'Accès Zero-Trust et Masquage des Secrets

## Statut
Accepté

## Contexte
La consultation de cartes régionales, de plans de ville ou d'étages explorés enrichit l'expérience des joueurs via l'onglet `SceneAtlas`. Cependant, une scène de carte contient des informations sensibles réservées au meneur de jeu :
- Des segments de mur secrets (`WallType::SecretDoor`) dissimulés dans les maçonneries ;
- Des pièges ou murs d'illusion (`WallType::Illusion`) apparaissant comme solides aux aventuriers ;
- Des monstres et PNJ pré-positionnés masqués (`VisibilityChannel::GmHidden`) ;
- Des émetteurs audio réservés aux coulisses de mise en scène (`SpatialAudioEmitter` avec `gm_only = true`) ;
- Les zones non explorées recouvertes par le brouillard de guerre.

Transmettre la scène brute au client web et masquer les secrets via du code JavaScript frontal violerait le principe de sécurité zero-trust et permettrait l'exfiltration de secrets via l'inspecteur réseau.

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