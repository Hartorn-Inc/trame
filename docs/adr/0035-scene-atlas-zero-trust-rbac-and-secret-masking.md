# ADR-0035: SceneAtlas Gallery, Zero-Trust RBAC, and Server-Side Secret Masking

## Status
Accepted

## Context
Players use `SceneAtlas` to inspect regional maps and explored dungeon floors. However, raw `CampaignMapScene` records contain GM-only secrets (`WallType::SecretDoor`, `WallType::Illusion`, `VisibilityChannel::GmHidden` tokens, `gm_only` audio emitters, and unexplored areas). Filtering these solely on the client would leak secrets in network responses.

## Decision
1. **Strict Server-Side RBAC**: `GET /api/v1/campaigns/{id}/maps` and `GET /api/v1/campaigns/{id}/maps/{map_id}` return full scenes to `CampaignRole::Gm` and reject unrevealed scenes (`revealed_to_players == false`) with `HTTP 403 Forbidden` for `CampaignRole::Player`.
2. **Active Secret Masking**: Before serializing a revealed scene to a player, the server transforms unopened `WallType::SecretDoor` and `WallType::Illusion` segments into `WallType::Normal` (`door_state = None`), strips all `VisibilityChannel::GmHidden` tokens and `gm_only` audio emitters, and includes only the consolidated `explored_fog_texture`.

## Consequences
- Zero-trust network security against client-side packet inspection.
- Unified scene payload structure reused cleanly by `SceneAtlas`.
