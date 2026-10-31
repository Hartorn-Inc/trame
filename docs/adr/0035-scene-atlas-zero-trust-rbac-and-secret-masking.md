# ADR-0035: SceneAtlas Gallery, Zero-Trust Access Control, and Secret Masking

## Status
Accepted

## Context
Browsing regional overviews, town layouts, or explored dungeon floors enhances the player experience via the `SceneAtlas` tab. However, a map scene contains privileged Game Master secrets:
- Secret doors (`WallType::SecretDoor`) hidden inside walls;
- Traps or illusory walls (`WallType::Illusion`) appearing solid to adventurers;
- Staged monsters and hidden NPCs (`VisibilityChannel::GmHidden`);
- Backstage sound triggers (`SpatialAudioEmitter` with `gm_only = true`);
- Unexplored areas masked by fog of war.

Sending raw scene documents to web clients and relying on frontend JavaScript filtering violates zero-trust principles and allows secret exfiltration via browser developer tools.

## Decision
1. **Strict Server-Side RBAC Filtering**: Backend routes `GET /api/v1/campaigns/{id}/maps` and `GET /api/v1/campaigns/{id}/maps/{map_id}` inspect caller role:
   - For Game Masters (`CampaignRole::Gm`), the server transmits unredacted scene geometry and tokens.
   - For Players (`CampaignRole::Player`), the server rejects unrevealed scenes (`revealed_to_players == false`) with `403 Forbidden`.
2. **Active Secret Sanitization**: When serving requests from player accounts, the backend sanitizes the scene payload before serialization:
   - `WallType::SecretDoor` segments with `door_state != DoorState::Open` convert to `WallType::Normal`, with `door_state = None`.
   - `WallType::Illusion` segments convert to `WallType::Normal`.
   - Tokens with `visibility == VisibilityChannel::GmHidden` are omitted from `staged_tokens`.
   - Audio emitters with `gm_only == true` are omitted from `spatial_audio_emitters`.
   - Only the explored fog texture is provided, preventing unrevealed room leakage.

## Consequences
### Positive
- Cryptographic and architectural immunity against client-side packet inspection.
- Unified client rendering pipeline for both GM Map Studio and Player SceneAtlas.

### Negative
- Minor backend CPU serialization overhead during filtering and cloning before JSON dispatch.
