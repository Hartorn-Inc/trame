//! ============================================================================
//! CAMPAIGN MAP SCENES REST API & ZERO-TRUST RBAC (maps.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements REST storage and retrieval endpoints for campaign map scenes
//! under `/api/v1/campaigns/{campaign_id}/maps`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. Server-side Zero-Trust RBAC:
//!      - GM accounts receive full unredacted scene geometry and staged tokens.
//!      - Player accounts receive scenes with `revealed_to_players == true` only.
//!      - Player payloads sanitize closed SecretDoor segments to Normal,
//!        remove Illusion tags, strip GmHidden tokens, and remove GM-only audio.
//! ============================================================================

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WallType {
    Normal,
    Window,
    Terrain,
    Door,
    SecretDoor,
    Illusion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DoorState {
    Open,
    Closed,
    Locked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VisibilityChannel {
    Public,
    GmHidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WallSegment {
    pub id: Uuid,
    pub p1: Point2D,
    pub p2: Point2D,
    pub wall_type: WallType,
    pub door_state: Option<DoorState>,
    pub bottom_elevation_ft: f32,
    pub top_elevation_ft: f32,
    pub blocks_light: bool,
    pub blocks_movement: bool,
    pub blocks_sound: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LightSource {
    pub id: Uuid,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub radius_ft: f32,
    pub color_hex: String,
    pub intensity: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpatialAudioEmitter {
    pub id: Uuid,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub radius_ft: f32,
    pub volume: f32,
    pub looping: bool,
    pub gm_only: bool,
    pub audio_clip_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedToken {
    pub id: Uuid,
    pub name: String,
    pub monster_template_id: Option<String>,
    pub x: f32,
    pub y: f32,
    pub elevation_ft: f32,
    pub size_cells: u32,
    pub token_avatar_url: Option<String>,
    pub visibility: VisibilityChannel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpawnPoint {
    pub id: Uuid,
    pub name: String,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CampaignMapScene {
    pub id: Uuid,
    pub campaign_id: Uuid,
    pub name: String,
    pub grid_type: String,
    pub grid_size_px: u32,
    pub grid_cell_distance_ft: f32,
    pub width_px: u32,
    pub height_px: u32,
    pub background_image_url: Option<String>,
    pub default_ground_elevation_ft: f32,
    pub revealed_to_players: bool,
    pub spawn_points: Vec<SpawnPoint>,
    pub wall_segments: Vec<WallSegment>,
    pub light_sources: Vec<LightSource>,
    pub spatial_audio_emitters: Vec<SpatialAudioEmitter>,
    pub staged_tokens: Vec<StagedToken>,
    pub explored_fog_texture: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryMapStorage {
    scenes: Arc<RwLock<HashMap<Uuid, Vec<CampaignMapScene>>>>,
}

impl InMemoryMapStorage {
    pub fn new() -> Self {
        Self {
            scenes: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get_campaign_maps(&self, campaign_id: Uuid) -> Vec<CampaignMapScene> {
        self.scenes
            .read()
            .ok()
            .and_then(|map| map.get(&campaign_id).cloned())
            .unwrap_or_default()
    }

    pub fn save_campaign_maps(&self, campaign_id: Uuid, scenes: Vec<CampaignMapScene>) {
        if let Ok(mut map) = self.scenes.write() {
            map.insert(campaign_id, scenes);
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct CampaignMapsQuery {
    pub user_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutCampaignMapsPayload {
    pub scenes: Vec<CampaignMapScene>,
}

pub fn sanitize_scene_for_player(mut scene: CampaignMapScene) -> CampaignMapScene {
    for wall in &mut scene.wall_segments {
        if wall.wall_type == WallType::SecretDoor && wall.door_state != Some(DoorState::Open) {
            wall.wall_type = WallType::Normal;
            wall.door_state = None;
        }
        if wall.wall_type == WallType::Illusion {
            wall.wall_type = WallType::Normal;
        }
    }
    scene
        .staged_tokens
        .retain(|t| t.visibility != VisibilityChannel::GmHidden);
    scene.spatial_audio_emitters.retain(|e| !e.gm_only);
    scene
}

pub async fn get_campaign_maps_handler(
    State(state): State<crate::http::AppState>,
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<CampaignMapsQuery>,
    headers: HeaderMap,
) -> Response {
    let user_id =
        match crate::http::resolve_authenticated_user(&state, &headers, query.user_id).await {
            Ok(uid) => uid,
            Err(status) => {
                return (
                    status,
                    Json(crate::http::ErrorResponse {
                        code: Some("UNAUTHORIZED".to_string()),
                        error: "valid authentication credentials required".to_string(),
                    }),
                )
                    .into_response();
            }
        };

    let is_gm = crate::http::is_authorized_campaign_gm(&state, campaign_id, user_id).await;
    if !is_gm && !crate::http::is_authorized_campaign_member(&state, campaign_id, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(crate::http::ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not an active member of this campaign".to_string(),
            }),
        )
            .into_response();
    }

    let scenes = state.map_storage.get_campaign_maps(campaign_id);
    if is_gm {
        return Json(scenes).into_response();
    }

    let sanitized: Vec<CampaignMapScene> = scenes
        .into_iter()
        .filter(|s| s.revealed_to_players)
        .map(sanitize_scene_for_player)
        .collect();

    Json(sanitized).into_response()
}

pub async fn put_campaign_maps_handler(
    State(state): State<crate::http::AppState>,
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<CampaignMapsQuery>,
    headers: HeaderMap,
    Json(payload): Json<PutCampaignMapsPayload>,
) -> Response {
    let user_id =
        match crate::http::resolve_authenticated_user(&state, &headers, query.user_id).await {
            Ok(uid) => uid,
            Err(status) => {
                return (
                    status,
                    Json(crate::http::ErrorResponse {
                        code: Some("UNAUTHORIZED".to_string()),
                        error: "valid authentication credentials required".to_string(),
                    }),
                )
                    .into_response();
            }
        };

    let is_gm = crate::http::is_authorized_campaign_gm(&state, campaign_id, user_id).await;
    if !is_gm {
        return (
            StatusCode::FORBIDDEN,
            Json(crate::http::ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may update campaign map scenes".to_string(),
            }),
        )
            .into_response();
    }

    state
        .map_storage
        .save_campaign_maps(campaign_id, payload.scenes);
    StatusCode::NO_CONTENT.into_response()
}
