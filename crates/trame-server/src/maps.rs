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
//!   5. `Scene-Set Optimistic Concurrency (ADR-0037)`:
//!      - `PUT` replaces every scene, so without a guard two GMs silently overwrite each
//!        other. Each campaign scene set carries one integer `version` (PostgreSQL
//!        `campaigns.scenes_version`, default `0`). `GET` returns it; `PUT` must echo it as
//!        `expected_version` (missing -> `400 MISSING_EXPECTED_VERSION`, stale ->
//!        `409 VERSION_CONFLICT` with `current_version`). Every scene write, including
//!        `POST .../maps/import`, goes through `save_campaign_scenes` and bumps it by one.
//!      - With PostgreSQL, scenes and version are read by one statement (one snapshot) and
//!        PostgreSQL is the only source of truth; the in-memory store serves memory-only mode.
//!   6. `Archive Round Trip`:
//!      - Export writes the stored scenes as `scene` entities (`export_entities_with_scenes`);
//!        import restores every entity that parses as a `CampaignMapScene`
//!        (`restorable_scene`) into scene storage. Import always targets a fresh campaign,
//!        so the restored set keeps version `0`.
//!   7. `Staged Stat Block Copies (D7)`:
//!      - `PUT` gives every staged token a validated copy of its stat block
//!        (`resolve_staged_stat_blocks`: SRD reference or actor template copied, homebrew
//!        bounds-checked; `400 INVALID_STAT_BLOCK` otherwise). Activation hands the copy
//!        to the room, which derives the token's HP, AC, speed, senses, reach and damage
//!        affinities from it. Player responses never carry stat blocks.
//!   8. `Prep and Play Agree on Terrain and Fog`:
//!      - A scene stores its difficult-terrain cells and GM fog rulings.
//!        `ActivateScene` loads them onto the table instead of clearing the table's
//!        (the engine drops off-grid cells and `Clear` rulings), and the GM saves the
//!        live table's set back with `POST .../maps/{scene_id}/table-rulings`, which
//!        only accepts the table's active scene. Players receive the terrain but
//!        never the prepared fog rulings.
//! ============================================================================

use crate::archive::ExportEntity;
use crate::http::{AppState, ErrorResponse};
use crate::sync::mask_wall_for_player;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use trame_engine::aoe::GridCell;
use trame_engine::commands::{
    CampaignRole, FogOverrideCell, LightSource as EngineLightSource, SceneActivation, TokenState,
    TrameCommand,
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

/// Monster or NPC token placed on a scene in the map studio; it becomes a `SyntheticToken`
/// when the scene is activated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedToken {
    pub id: Uuid,
    pub name: String,
    /// Where the stat block was copied from: an SRD reference (`srd:monster:<slug>`) or an
    /// actor template UUID. When `stat_block` is absent, `PUT .../maps` copies it from here.
    #[serde(default, alias = "monsterTemplateId", alias = "templateKey")]
    pub monster_template_id: Option<String>,
    /// Copy of the dnd5e `MonsterStatBlock` taken when the token was staged (D7), editable
    /// as homebrew. `PUT .../maps` resolves references and validates bounds
    /// (`statblock::resolve_stat_block`); players never receive it.
    #[serde(default, alias = "statBlock", skip_serializing_if = "Option::is_none")]
    pub stat_block: Option<serde_json::Value>,
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
    /// Difficult-terrain grid cells (`{ col, row }`) prepared for the scene; `ActivateScene`
    /// loads them onto the table (off-grid cells dropped) and `POST .../table-rulings` saves
    /// the live table's set back. Public map knowledge: players receive them.
    #[serde(default, alias = "difficultTerrain")]
    pub difficult_terrain: Vec<GridCell>,
    /// GM fog rulings (`{ cell_x, cell_y, mode }`, `REVEAL` / `HIDE`) prepared for the scene,
    /// loaded and saved like `difficult_terrain`. Stripped from player responses so prepared
    /// rulings of unrevealed areas do not leak before activation.
    #[serde(default, alias = "fogOverrides")]
    pub fog_overrides: Vec<FogOverrideCell>,
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

/// Why a versioned scene-set write was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneSaveError {
    /// `expected_version` no longer matches; carries the stored version (`409`).
    VersionConflict { current_version: i64 },
    /// The backing store failed (`500`).
    Storage(String),
}

/// In-memory campaign scene sets, each stored with its optimistic-concurrency version.
#[derive(Debug, Clone, Default)]
pub struct InMemoryMapStorage {
    scenes: Arc<RwLock<HashMap<Uuid, (Vec<CampaignMapScene>, i64)>>>,
}

impl InMemoryMapStorage {
    pub fn new() -> Self {
        Self {
            scenes: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get_campaign_maps(&self, campaign_id: Uuid) -> Vec<CampaignMapScene> {
        self.get_campaign_map_set(campaign_id).0
    }

    /// Scenes and version of `campaign_id`; an unknown campaign is `(vec![], 0)`.
    pub fn get_campaign_map_set(&self, campaign_id: Uuid) -> (Vec<CampaignMapScene>, i64) {
        self.scenes
            .read()
            .ok()
            .and_then(|map| map.get(&campaign_id).cloned())
            .unwrap_or_default()
    }

    /// Unconditionally replaces the scenes and bumps the version (seeding and fixtures).
    pub fn save_campaign_maps(&self, campaign_id: Uuid, scenes: Vec<CampaignMapScene>) {
        if let Ok(mut map) = self.scenes.write() {
            let entry = map.entry(campaign_id).or_default();
            *entry = (scenes, entry.1 + 1);
        }
    }

    /// Replaces the scenes only when the stored version equals `expected_version`; the
    /// check and write share one write-lock so concurrent saves cannot both succeed.
    pub fn save_campaign_maps_if_version(
        &self,
        campaign_id: Uuid,
        scenes: Vec<CampaignMapScene>,
        expected_version: i64,
    ) -> Result<i64, SceneSaveError> {
        let mut map = self
            .scenes
            .write()
            .map_err(|_| SceneSaveError::Storage("map storage lock poisoned".to_string()))?;
        let entry = map.entry(campaign_id).or_default();
        if entry.1 != expected_version {
            return Err(SceneSaveError::VersionConflict {
                current_version: entry.1,
            });
        }
        *entry = (scenes, expected_version + 1);
        Ok(entry.1)
    }

    /// Sets the scenes restored by an archive import, keeping the current version (`0` for
    /// the fresh campaign an import always creates) so it never moves backwards.
    pub fn restore_campaign_maps(&self, campaign_id: Uuid, scenes: Vec<CampaignMapScene>) {
        if let Ok(mut map) = self.scenes.write() {
            map.entry(campaign_id).or_default().0 = scenes;
        }
    }
}

/// The map scene carried by an archive entity, scoped to `campaign_id`, or `None` when the
/// entity is not a `scene` or its payload is not a `CampaignMapScene` (foreign or legacy
/// archives); such entities stay plain campaign entities.
pub fn restorable_scene(campaign_id: Uuid, entity: &ExportEntity) -> Option<CampaignMapScene> {
    if entity.entity_type != "scene" {
        return None;
    }
    let mut scene: CampaignMapScene = serde_json::from_value(entity.data.clone()).ok()?;
    scene.campaign_id = campaign_id;
    Some(scene)
}

/// Archive entities for `campaign_id`: the scene storage's scenes (in scene order) replace
/// any store `scene` entity with the same ID, so mirrored scene rows are not exported twice.
pub async fn export_entities_with_scenes(
    state: &AppState,
    campaign_id: Uuid,
    entities: Vec<ExportEntity>,
) -> Result<Vec<ExportEntity>, String> {
    let scenes = load_campaign_scenes(state, campaign_id).await?;
    let scene_ids: std::collections::HashSet<String> =
        scenes.iter().map(|s| s.id.to_string()).collect();
    let mut out: Vec<ExportEntity> = entities
        .into_iter()
        .filter(|e| {
            e.entity_type != "scene"
                || !e
                    .data
                    .get("id")
                    .and_then(|v| v.as_str())
                    .is_some_and(|id| scene_ids.contains(id))
        })
        .collect();
    for scene in &scenes {
        out.push(ExportEntity {
            entity_type: "scene".to_string(),
            data: serde_json::to_value(scene).map_err(|e| e.to_string())?,
        });
    }
    Ok(out)
}

/// `PUT .../maps` body. `expected_version` is optional only so its absence can be
/// reported as `400 MISSING_EXPECTED_VERSION` instead of a generic deserialization error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutCampaignMapsPayload {
    pub scenes: Vec<CampaignMapScene>,
    /// Scene-set version the client last read; must equal the stored version.
    #[serde(default)]
    pub expected_version: Option<i64>,
}

/// `GET .../maps` and `PUT .../maps` response: the (role-filtered) scenes plus the
/// campaign scene-set version to send back as the next `expected_version`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CampaignMapsResponse {
    pub scenes: Vec<CampaignMapScene>,
    pub version: i64,
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
    for token in &mut scene.staged_tokens {
        token.stat_block = None;
    }
    scene.spatial_audio_emitters.retain(|e| !e.gm_only);
    scene.fog_overrides.clear();
    scene
}

/// The SRD reference of a studio template key saved before the SRD picker (`"Goblin"`,
/// `"Ogre"`): the key itself, lowercased, when it is an SRD monster slug.
fn legacy_srd_reference(key: &str) -> Option<String> {
    if key.starts_with(crate::statblock::SRD_MONSTER_PREFIX) || Uuid::parse_str(key).is_ok() {
        return None;
    }
    let slug = key.trim().to_ascii_lowercase();
    crate::statblock::srd_stat_block(&slug)
        .map(|_| format!("{}{slug}", crate::statblock::SRD_MONSTER_PREFIX))
}

/// Gives every staged token of `scenes` a validated stat block copy (D7): an existing
/// `stat_block` is resolved and bounds-checked; otherwise `monster_template_id` (SRD
/// reference or actor template UUID) is copied when it names one. A legacy studio key that
/// is an SRD slug (`"Ogre"`) is rewritten to its reference first. Tokens with neither stay
/// plain. Errors name the offending token.
pub async fn resolve_staged_stat_blocks(
    state: &AppState,
    campaign_id: Uuid,
    scenes: &mut [CampaignMapScene],
) -> Result<(), String> {
    for token in scenes.iter_mut().flat_map(|s| s.staged_tokens.iter_mut()) {
        if token.stat_block.is_none() {
            if let Some(reference) = token
                .monster_template_id
                .as_deref()
                .and_then(legacy_srd_reference)
            {
                token.monster_template_id = Some(reference);
            }
        }
        let source = match (&token.stat_block, token.monster_template_id.as_deref()) {
            (Some(block), _) => block.clone(),
            (None, Some(template))
                if template.starts_with(crate::statblock::SRD_MONSTER_PREFIX)
                    || Uuid::parse_str(template).is_ok() =>
            {
                serde_json::Value::String(template.to_string())
            }
            // Free-form keys naming no SRD monster ("Boss") stay plain rather than failing the save.
            _ => continue,
        };
        let block = match source.as_str().and_then(|s| Uuid::parse_str(s).ok()) {
            Some(id) => crate::campaigns::actor_template_stat_block(state, campaign_id, id).await,
            None => Ok(source),
        };
        let resolved = block
            .and_then(|block| crate::statblock::resolve_stat_block(&block))
            .map_err(|err| format!("staged token {}: {err}", token.id))?;
        token.stat_block = Some(resolved);
    }
    Ok(())
}

/// Loads the scenes of `campaign_id` from PostgreSQL when configured, otherwise from memory.
pub async fn load_campaign_scenes(
    state: &AppState,
    campaign_id: Uuid,
) -> Result<Vec<CampaignMapScene>, String> {
    Ok(load_campaign_scene_set(state, campaign_id).await?.0)
}

/// Like `load_campaign_scenes`, plus the scene-set version, read as one consistent snapshot
/// (a single SQL statement with PostgreSQL, one read lock in memory).
pub async fn load_campaign_scene_set(
    state: &AppState,
    campaign_id: Uuid,
) -> Result<(Vec<CampaignMapScene>, i64), String> {
    match state.postgres_store {
        Some(ref pg) => pg.load_campaign_scene_set_async(campaign_id).await,
        None => Ok(state.map_storage.get_campaign_map_set(campaign_id)),
    }
}

/// Replaces the scene set of `campaign_id` if its version still equals `expected_version`,
/// in PostgreSQL when configured (the sole source of truth), otherwise in memory. Every
/// scene-mutating path must go through here so they all bump the same version.
pub async fn save_campaign_scenes(
    state: &AppState,
    campaign_id: Uuid,
    scenes: Vec<CampaignMapScene>,
    expected_version: i64,
) -> Result<i64, SceneSaveError> {
    match state.postgres_store {
        Some(ref pg) => {
            pg.save_campaign_scenes_async(campaign_id, &scenes, expected_version)
                .await
        }
        None => {
            state
                .map_storage
                .save_campaign_maps_if_version(campaign_id, scenes, expected_version)
        }
    }
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
            // The room applies the copy (`statblock::normalize_command`), which also sets the
            // footprint from the creature size.
            token.stat_block = t.stat_block.clone();
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
        difficult_terrain: scene.difficult_terrain.clone(),
        fog_overrides: scene.fog_overrides.clone(),
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

    let Some(role) = crate::http::resolve_campaign_role(&state, campaign_id, user_id).await else {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "user is not an active member of this campaign".to_string(),
            }),
        )
            .into_response();
    };

    let (scenes, version) = match load_campaign_scene_set(&state, campaign_id).await {
        Ok(set) => set,
        Err(err) => return storage_error(err),
    };
    let scenes = if role == CampaignRole::Gm {
        scenes
    } else {
        scenes
            .into_iter()
            .filter(|s| s.revealed_to_players)
            .map(sanitize_scene_for_player)
            .collect()
    };
    Json(CampaignMapsResponse { scenes, version }).into_response()
}

/// Maps a rejected scene-set write to `409 VERSION_CONFLICT` (with `current_version`) or `500`.
pub fn scene_save_error(err: SceneSaveError, expected_version: i64) -> Response {
    match err {
        SceneSaveError::VersionConflict { current_version } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "code": "VERSION_CONFLICT",
                "error": format!(
                    "stale scene set version: expected {expected_version}, current {current_version}"
                ),
                "current_version": current_version,
            })),
        )
            .into_response(),
        SceneSaveError::Storage(err) => storage_error(err),
    }
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

    let role = crate::http::resolve_campaign_role(&state, campaign_id, user_id).await;
    if role != Some(CampaignRole::Gm) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                code: Some("FORBIDDEN".to_string()),
                error: "only a campaign GM may update campaign map scenes".to_string(),
            }),
        )
            .into_response();
    }
    let Some(expected_version) = payload.expected_version else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                code: Some("MISSING_EXPECTED_VERSION".to_string()),
                error: "expected_version is required (optimistic concurrency, ADR-0037)"
                    .to_string(),
            }),
        )
            .into_response();
    };

    let mut scenes = payload.scenes;
    if let Err(err) = resolve_staged_stat_blocks(&state, campaign_id, &mut scenes).await {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                code: Some("INVALID_STAT_BLOCK".to_string()),
                error: err,
            }),
        )
            .into_response();
    }
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
    match save_campaign_scenes(&state, campaign_id, scenes.clone(), expected_version).await {
        Ok(version) => Json(CampaignMapsResponse { scenes, version }).into_response(),
        Err(err) => scene_save_error(err, expected_version),
    }
}

fn error_response(status: StatusCode, code: &str, error: String) -> Response {
    (
        status,
        Json(ErrorResponse {
            code: Some(code.to_string()),
            error,
        }),
    )
        .into_response()
}

/// `POST /api/v1/campaigns/{campaign_id}/maps/{scene_id}/table-rulings` (GM only): copies the
/// live table's difficult terrain and fog rulings into the stored scene `scene_id`, so the
/// next `ActivateScene` loads what was painted during play (invariant 8). Answers the
/// updated scene set like `PUT .../maps`.
/// - `401` unauthenticated, `403` not the campaign GM.
/// - `409 SCENE_NOT_ACTIVE` when `scene_id` is not the table's active scene (the table's
///   rulings belong to another scene); `404 SCENE_NOT_FOUND` when it is not stored.
/// - The write bumps the scene-set version read in the same request; a concurrent studio
///   save answers `409 VERSION_CONFLICT` and the GM retries.
pub async fn save_table_rulings_handler(
    State(state): State<AppState>,
    Path((campaign_id, scene_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let Ok(user_id) = crate::http::resolve_authenticated_user(&state, &headers).await else {
        return unauthorized();
    };
    if crate::http::resolve_campaign_role(&state, campaign_id, user_id).await
        != Some(CampaignRole::Gm)
    {
        return error_response(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "only a campaign GM may save table rulings to a scene".to_string(),
        );
    }
    let table = match state.lease_manager.get_or_wake_room(campaign_id).await {
        Ok(room) => match room.get_table_snapshot().await {
            Ok((_, table)) => table,
            Err(err) => return storage_error(err.to_string()),
        },
        Err(err) => return storage_error(err.to_string()),
    };
    if table.data.active_scene_id != Some(scene_id) {
        return error_response(
            StatusCode::CONFLICT,
            "SCENE_NOT_ACTIVE",
            format!("scene {scene_id} is not the scene active on the table"),
        );
    }
    let (mut scenes, version) = match load_campaign_scene_set(&state, campaign_id).await {
        Ok(set) => set,
        Err(err) => return storage_error(err),
    };
    let Some(scene) = scenes.iter_mut().find(|s| s.id == scene_id) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "SCENE_NOT_FOUND",
            format!("scene {scene_id} does not exist in this campaign"),
        );
    };
    scene.difficult_terrain = table.data.difficult_terrain.iter().copied().collect();
    scene.fog_overrides = table.data.fog_overrides.clone();
    match save_campaign_scenes(&state, campaign_id, scenes.clone(), version).await {
        Ok(version) => Json(CampaignMapsResponse { scenes, version }).into_response(),
        Err(err) => scene_save_error(err, version),
    }
}
