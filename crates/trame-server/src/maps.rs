//! ============================================================================
//! CAMPAIGN MAP SCENES REST API & ZERO-TRUST RBAC (maps.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements REST storage and retrieval endpoints for campaign map scenes
//! under `/api/v1/campaigns/{campaign_id}/maps`, and resolves persisted scenes
//! into the engine `SceneActivation` payload that `ActivateScene` requires.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Single Wall Type (A29)`:
//!      - Scenes store the engine `WallSegment`. Its tolerant deserializer accepts the
//!        map-editor shape (`p1`/`p2`, `wallType`, `doorState`); walls missing blocking
//!        flags default to blocking. Responses carry the canonical `kind` plus the
//!        editor fields (`p1`, `p2`, `wall_type`, `door_state`) so the editor round-trips
//!        without losing `OneWay` normals.
//!   2. `Server-side Zero-Trust RBAC`:
//!      - GM accounts receive full unredacted scene geometry and staged tokens.
//!      - Player accounts receive scenes with `revealed_to_players == true` only, with
//!        closed secret doors and illusions masked (`sync::mask_wall_for_player`),
//!        GM-hidden staged tokens stripped, and GM-only audio removed.
//!   3. `No Silent Save Failures (A25)`:
//!      - A PostgreSQL scene write error returns `500` instead of `204`.
//!   4. `Server-Resolved Scene Activation`:
//!      - `resolve_scene_command` replaces any client-supplied `ActivateScene.scene` with the
//!        persisted scene, so WAL replays are deterministic and clients cannot inject geometry.
//! ============================================================================

use crate::http::{AppState, ErrorResponse};
use crate::sync::mask_wall_for_player;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use trame_engine::commands::{
    LightSource as EngineLightSource, SceneActivation, TokenState, TrameCommand,
};
use trame_engine::geometry::{CHANNEL_GM_HIDDEN, Point2D as EnginePoint, WallKind, WallSegment};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum VisibilityChannel {
    #[default]
    Public,
    GmHidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LightSource {
    pub id: Uuid,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default, alias = "origin")]
    pub origin: Option<Point2D>,
    #[serde(default, alias = "elevationFt")]
    pub elevation_ft: f32,
    #[serde(default, alias = "radiusFt", alias = "dimRadiusFt")]
    pub radius_ft: f32,
    #[serde(default, alias = "brightRadiusFt")]
    pub bright_radius_ft: Option<f32>,
    #[serde(alias = "colorHex")]
    pub color_hex: String,
    #[serde(default)]
    pub intensity: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpatialAudioEmitter {
    pub id: Uuid,
    pub x: f32,
    pub y: f32,
    #[serde(default, alias = "elevationFt")]
    pub elevation_ft: f32,
    #[serde(default, alias = "radiusFt", alias = "maxDistanceFt")]
    pub radius_ft: f32,
    #[serde(default)]
    pub volume: f32,
    #[serde(default, alias = "loopPlayback")]
    pub looping: bool,
    #[serde(default, alias = "gmOnly")]
    pub gm_only: bool,
    #[serde(default, alias = "audioClipUrl", alias = "url")]
    pub audio_clip_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedToken {
    pub id: Uuid,
    pub name: String,
    #[serde(default, alias = "monsterTemplateId", alias = "templateKey")]
    pub monster_template_id: Option<String>,
    pub x: f32,
    pub y: f32,
    #[serde(default, alias = "elevationFt")]
    pub elevation_ft: f32,
    #[serde(default, alias = "sizeCells")]
    pub size_cells: u32,
    #[serde(default, alias = "tokenAvatarUrl")]
    pub token_avatar_url: Option<String>,
    #[serde(default, alias = "visibilityChannel")]
    pub visibility: VisibilityChannel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpawnPoint {
    pub id: Uuid,
    pub name: String,
    pub x: f32,
    pub y: f32,
}

fn default_grid_type() -> String {
    "square".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CampaignMapScene {
    pub id: Uuid,
    #[serde(alias = "campaignId")]
    pub campaign_id: Uuid,
    #[serde(alias = "title")]
    pub name: String,
    #[serde(default = "default_grid_type", alias = "gridType")]
    pub grid_type: String,
    #[serde(alias = "gridCellSizePx")]
    pub grid_size_px: u32,
    #[serde(alias = "feetPerCell")]
    pub grid_cell_distance_ft: f32,
    #[serde(alias = "widthPx")]
    pub width_px: u32,
    #[serde(alias = "heightPx")]
    pub height_px: u32,
    #[serde(default, alias = "backgroundImageUrl")]
    pub background_image_url: Option<String>,
    #[serde(default, alias = "defaultGroundElevationFt")]
    pub default_ground_elevation_ft: f32,
    #[serde(alias = "revealedToPlayers")]
    pub revealed_to_players: bool,
    #[serde(default, alias = "spawnPoints")]
    pub spawn_points: Vec<SpawnPoint>,
    /// Engine walls; serialized with editor-compatible extra fields (`serialize_editor_walls`).
    #[serde(
        default,
        alias = "walls",
        alias = "wallSegments",
        serialize_with = "serialize_editor_walls"
    )]
    pub wall_segments: Vec<WallSegment>,
    #[serde(default, alias = "lights", alias = "lightSources")]
    pub light_sources: Vec<LightSource>,
    #[serde(default, alias = "audioEmitters", alias = "spatialAudioEmitters")]
    pub spatial_audio_emitters: Vec<SpatialAudioEmitter>,
    #[serde(default, alias = "stagedTokens")]
    pub staged_tokens: Vec<StagedToken>,
    #[serde(default, alias = "exploredFogTexture")]
    pub explored_fog_texture: Option<Vec<u8>>,
}

/// Map-editor `wall_type` label for an engine `WallKind`.
fn editor_wall_type(kind: &WallKind) -> &'static str {
    match kind {
        WallKind::Normal => "Normal",
        WallKind::Window => "Window",
        WallKind::Terrain => "Terrain",
        WallKind::OneWay { .. } => "OneWay",
        WallKind::Door { .. } => "Door",
        WallKind::SecretDoor { .. } => "SecretDoor",
        WallKind::Illusion { .. } => "Illusion",
    }
}

/// Map-editor `door_state` label (`None` for non-door walls).
fn editor_door_state(kind: &WallKind) -> Option<&'static str> {
    match kind {
        WallKind::Door {
            is_locked: true, ..
        } => Some("Locked"),
        WallKind::Door { is_open: true, .. } | WallKind::SecretDoor { is_open: true } => {
            Some("Open")
        }
        WallKind::Door { .. } | WallKind::SecretDoor { .. } => Some("Closed"),
        _ => None,
    }
}

struct EditorWall<'a>(&'a WallSegment);

impl Serialize for EditorWall<'_> {
    /// Emits `p1`/`p2` (never `a`/`b`: both names present would be a duplicate field for the
    /// tolerant deserializer) plus `kind`, which takes precedence over `wall_type` on read.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let w = self.0;
        let mut map = serializer.serialize_map(Some(12))?;
        map.serialize_entry("id", &w.id)?;
        map.serialize_entry("p1", &w.a)?;
        map.serialize_entry("p2", &w.b)?;
        map.serialize_entry("kind", &w.kind)?;
        map.serialize_entry("wall_type", editor_wall_type(&w.kind))?;
        map.serialize_entry("door_state", &editor_door_state(&w.kind))?;
        map.serialize_entry("blocks_movement", &w.blocks_movement)?;
        map.serialize_entry("blocks_vision", &w.blocks_vision)?;
        map.serialize_entry("blocks_light", &w.blocks_light)?;
        map.serialize_entry("blocks_sound", &w.blocks_sound)?;
        map.serialize_entry("bottom_elevation_ft", &w.bottom_elevation_ft)?;
        map.serialize_entry("top_elevation_ft", &w.top_elevation_ft)?;
        map.end()
    }
}

fn serialize_editor_walls<S: Serializer>(
    walls: &[WallSegment],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(walls.iter().map(EditorWall))
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
    scene.wall_segments = scene
        .wall_segments
        .iter()
        .map(mask_wall_for_player)
        .collect();
    scene
        .staged_tokens
        .retain(|t| t.visibility != VisibilityChannel::GmHidden);
    scene.spatial_audio_emitters.retain(|e| !e.gm_only);
    scene
}

/// Loads the scenes of `campaign_id` from PostgreSQL when configured (falling back to the
/// in-memory cache when the table is empty), otherwise from memory.
pub async fn load_campaign_scenes(
    state: &AppState,
    campaign_id: Uuid,
) -> Result<Vec<CampaignMapScene>, String> {
    if let Some(ref pg) = state.postgres_store {
        let scenes = pg.load_campaign_scenes_async(campaign_id).await?;
        if !scenes.is_empty() {
            return Ok(scenes);
        }
    }
    Ok(state.map_storage.get_campaign_maps(campaign_id))
}

/// Persists `scenes` to PostgreSQL (when configured) and the in-memory cache.
pub async fn save_campaign_scenes(
    state: &AppState,
    campaign_id: Uuid,
    scenes: Vec<CampaignMapScene>,
) -> Result<(), String> {
    if let Some(ref pg) = state.postgres_store {
        pg.save_campaign_scenes_async(campaign_id, &scenes).await?;
    }
    state.map_storage.save_campaign_maps(campaign_id, scenes);
    Ok(())
}

/// Converts a persisted scene into the engine `ActivateScene` payload. Staged tokens become
/// default tokens sized `size_cells` (min 1) and GM-hidden when the scene marks them so;
/// spawn points become `HeroToken` spawn coordinates in order.
pub fn scene_activation(scene: &CampaignMapScene) -> SceneActivation {
    let lights = scene
        .light_sources
        .iter()
        .map(|l| {
            let (x, y) = l.origin.as_ref().map_or((l.x, l.y), |p| (p.x, p.y));
            EngineLightSource {
                id: l.id,
                position: EnginePoint::new(f64::from(x), f64::from(y)),
                elevation_ft: f64::from(l.elevation_ft),
                bright_radius_ft: f64::from(l.bright_radius_ft.unwrap_or(l.radius_ft / 2.0)),
                dim_radius_ft: f64::from(l.radius_ft),
                color_hex: l.color_hex.clone(),
                intensity: f64::from(l.intensity),
            }
        })
        .collect();
    let staged_tokens = scene
        .staged_tokens
        .iter()
        .map(|t| {
            let mut token = TokenState::new_default(
                t.id,
                t.name.clone(),
                EnginePoint::new(f64::from(t.x), f64::from(t.y)),
            );
            let size = u8::try_from(t.size_cells.clamp(1, 8)).unwrap_or(1);
            token.grid_w = size;
            token.grid_h = size;
            token.elevation_ft = f64::from(t.elevation_ft);
            if t.visibility == VisibilityChannel::GmHidden {
                token.visibility_channel |= CHANNEL_GM_HIDDEN;
            }
            token
        })
        .collect();
    SceneActivation {
        map_asset_id: scene.background_image_url.clone(),
        width_px: scene.width_px,
        height_px: scene.height_px,
        pixels_per_grid: f64::from(scene.grid_size_px),
        walls: scene.wall_segments.clone(),
        lights,
        staged_tokens,
        hero_spawn_points: scene
            .spawn_points
            .iter()
            .map(|p| EnginePoint::new(f64::from(p.x), f64::from(p.y)))
            .collect(),
    }
}

/// Fills `ActivateScene.scene` from storage (overwriting any client-supplied payload); other
/// commands pass through unchanged. Unknown scene IDs are rejected.
pub async fn resolve_scene_command(
    state: &AppState,
    campaign_id: Uuid,
    cmd: TrameCommand,
) -> Result<TrameCommand, String> {
    let TrameCommand::ActivateScene { scene_id, .. } = cmd else {
        return Ok(cmd);
    };
    let scenes = load_campaign_scenes(state, campaign_id).await?;
    let scene = scenes
        .iter()
        .find(|s| s.id == scene_id)
        .ok_or_else(|| format!("not found: scene {scene_id} does not exist in this campaign"))?;
    Ok(TrameCommand::ActivateScene {
        scene_id,
        scene: Some(scene_activation(scene)),
    })
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorResponse {
            code: Some("UNAUTHORIZED".to_string()),
            error: "valid authentication credentials required".to_string(),
        }),
    )
        .into_response()
}

fn storage_error(err: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            code: Some("STORAGE_ERROR".to_string()),
            error: err,
        }),
    )
        .into_response()
}

pub async fn get_campaign_maps_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let Ok(user_id) = crate::http::resolve_authenticated_user(&state, &headers).await else {
        return unauthorized();
    };

    let is_gm = crate::http::is_authorized_campaign_gm(&state, campaign_id, user_id).await;
    if !is_gm && !crate::http::is_authorized_campaign_member(&state, campaign_id, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not an active member of this campaign".to_string(),
            }),
        )
            .into_response();
    }

    let scenes = match load_campaign_scenes(&state, campaign_id).await {
        Ok(s) => s,
        Err(err) => return storage_error(err),
    };
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
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<PutCampaignMapsPayload>,
) -> Response {
    let Ok(user_id) = crate::http::resolve_authenticated_user(&state, &headers).await else {
        return unauthorized();
    };

    let is_gm = crate::http::is_authorized_campaign_gm(&state, campaign_id, user_id).await;
    if !is_gm {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may update campaign map scenes".to_string(),
            }),
        )
            .into_response();
    }

    let mut scenes = payload.scenes;
    for scene in &mut scenes {
        scene.campaign_id = campaign_id;
        for light in &mut scene.light_sources {
            if let Some(ref pt) = light.origin
                && light.x == 0.0
                && light.y == 0.0
            {
                light.x = pt.x;
                light.y = pt.y;
            }
        }
    }
    match save_campaign_scenes(&state, campaign_id, scenes).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => storage_error(err),
    }
}
