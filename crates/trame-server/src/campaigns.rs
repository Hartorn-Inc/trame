//! ============================================================================
//! CAMPAIGN, ACTOR, NOTES, DICE, ASSET & MAP-IMPORT REST ROUTES (campaigns.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Serves the campaign-scoped REST surface the web client codes against
//! (`packages/web/src/api/client.ts`): the lobby (list/create campaigns), members,
//! persistent actor sheets with optimistic concurrency (ADR-0037), role-filtered
//! notes, handout reveals and the party journal, out-of-session dice rolls, campaign
//! settings (MCP staging mode), authenticated asset upload with signed downloads,
//! and GM-only UVTT map import. Every route reads PostgreSQL when `DATABASE_URL`
//! is configured and the in-memory `InMemoryCampaignData` otherwise.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Credential + Membership First`:
//!      - Identity comes only from `resolve_authenticated_user` and the campaign role
//!        only from `resolve_campaign_role`; every route checks both before reading
//!        storage. Non-members get `403`, unauthenticated callers `401`.
//!   2. `Sheet Privacy (G5)`:
//!      - Players list and read only the actors they own; other actors answer `404`
//!        so their existence does not leak. Spectators cannot write anything.
//!   3. `Optimistic Concurrency (ADR-0037)`:
//!      - `PUT /actors/{id}` requires `expected_version`; a stale version returns
//!        `409 VERSION_CONFLICT` with `current_version`. Accepted writes resync the
//!        `LinkedActorToken`s of the room (`token.actor_id`) and broadcast
//!        `ActorUpdated`; the room snapshots the synced tokens (WAL durability).
//!   4. `Linked Vitals Persistence`:
//!      - `install_room_sinks` drains `LinkedVitalsChange` from rooms and writes hp /
//!        temp hp (and changed conditions) into the linked actor sheet. Synthetic
//!        tokens never reach storage.
//!   4b. `Sheet-Derived Rules Fields`:
//!      - Threat reach (equipped reach weapon or stat-block melee reach) and darkvision
//!        (species or stat-block senses) come from the stored sheet on every resync and
//!        on actor-linked `SpawnToken` (`resolve_spawn`), never from the client.
//!      - Armor Class comes from the sheet's `derived.armorClass` and speed from
//!        `derived.speed` (class features applied), else `attributes.speedFt` minus
//!        exhaustion (GS6). Both are bounded like stat block values (AC `1..=30`,
//!        speed `0..=200` ft) and sheet conditions are normalized and capped like
//!        `SetTokenConditions`. A token whose conditions impose Speed 0 keeps the
//!        sheet speed as its maximum but has no movement left.
//!      - A `SpawnToken` whose `stat_block` names an actor template UUID gets a copy of
//!        that actor's `statBlock`, which the room validates and applies (`statblock`).
//!   5. `Confidential Notes`:
//!      - Non-GM readers never receive `min_role = GM` notes nor `:::dm` / unrevealed
//!        `:::handout` blocks; player edits go through `merge_party_note_ast`, so the
//!        stored confidential blocks survive a player save.
//!   6. `Upload Guards`:
//!      - Uploads are capped at `MAX_ASSET_UPLOAD_BYTES`, checked for PNG/JPEG/WebP
//!        magic bytes and header dimensions before decoding, and re-encoded as WebP
//!        under a content-addressed key. Downloads require a valid HMAC signature.
//!      - Uploads and map imports first take one slot of the caller's upload quota
//!        (`AuthRateLimiter::uploads_per_account`, `429 RATE_LIMITED`), then check the
//!        per-campaign storage quota (`413 STORAGE_QUOTA_EXCEEDED`), then decode/encode
//!        on the blocking pool behind the global decode gate (SEC14). Player uploads
//!        are capped at `MAX_PLAYER_IMAGE_PIXEL_AREA`, GM uploads at
//!        `MAX_IMAGE_PIXEL_AREA`.
//!   7. `Sheet Values Feeding Server Rolls`:
//!      - Actor create/update rejects any `abilities.<ability>.score` outside
//!        `ABILITY_SCORES` (`400 INVALID_ABILITY_SCORE`), and the tactical sync
//!        clamps the Dexterity score again before deriving the initiative modifier,
//!        so no stored sheet can hand a player a +495 initiative bonus.
//!      - `POST /dice/roll` refuses non-GM reasons starting with "initiative"
//!        (`400 INITIATIVE_ROLL_REQUIRES_ROOM`): player initiative is rolled by the
//!        room from the token's server-side bonus, never from a client expression.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `PUT /api/v1/campaigns/{cid}/actors/{aid}`
//!     ├── 1. Authenticate, resolve role, load actor (owner or GM, else 404).
//!     ├── 2. Conditional update `WHERE version = expected_version` (409 on mismatch).
//!     ├── 3. Extract `ActorTacticalSync` from the sheet JSON.
//!     └── 4. Wake the room -> `notify_actor_updated` (sync linked tokens, snapshot,
//!            broadcast `ActorUpdated` to the GM and the linked tokens' controllers).
//! ============================================================================

use crate::archive::ExportEntity;
use crate::archive::importer::OWNER_USER_ID_FIELD;
use crate::dice::{RollVisibility, SeededDiceRoller, project_roll_for_recipient};
use crate::http::{AppState, error_response, resolve_authenticated_user, resolve_campaign_role};
use crate::importers::uvtt::{
    ImportedMapResult, MAX_IMAGE_PIXEL_AREA, MAX_PAYLOAD_SIZE_BYTES, MAX_PLAYER_IMAGE_PIXEL_AREA,
    UvttImportError, import_uvtt_map, transcode_upload_to_webp_blocking,
};
use crate::maps::{
    CampaignMapScene, LightSource, SceneSaveError, load_campaign_scene_set, save_campaign_scenes,
    scene_save_error,
};
use crate::notes::{
    DirectiveAstNode, FilteredNoteDocument, InMemoryPartyJournalStorage, NotesError,
    PartyJournalStorage, RevealHandoutCommand, UserRole, merge_party_note_ast, parse_markdown_ast,
    reveal_handout,
};
use crate::room::{ActorTacticalSync, LinkedVitalsChange, RoomSinks, TimelineNote};
use crate::storage::blob::Sha256Hasher;
use crate::storage::{ActorConcurrencyError, ActorRecord, CampaignNoteItem, CampaignRecord};
use crate::timeline::AppendEventInput;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post, put};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;
use trame_engine::commands::{CampaignRole, CommandActor, TrameCommand};
use uuid::Uuid;

/// Maximum accepted asset upload body (16 MiB).
pub const MAX_ASSET_UPLOAD_BYTES: usize = 16 * 1024 * 1024;

/// Maximum campaign name length in characters.
pub const MAX_CAMPAIGN_NAME_CHARS: usize = 120;

/// D&D 5e ability score range accepted on actor sheets (`abilities.<ability>.score`).
pub const ABILITY_SCORES: std::ops::RangeInclusive<i32> = 1..=30;

/// Session number used for room-originated timeline records (dice, initiative, handouts);
/// sessions are not tracked separately yet, so the live table writes to session `1`.
pub const LIVE_SESSION_NUM: u32 = 1;

/// Lobby entry returned by `GET /api/v1/campaigns` and `POST /api/v1/campaigns`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CampaignSummary {
    /// Campaign UUID.
    pub id: Uuid,
    /// Display name.
    pub name: String,
    /// Game system identifier (`"dnd5e"`).
    pub system: String,
    /// Caller's membership role (`"GM"`, `"PLAYER"`, `"SPECTATOR"`, ...).
    pub role: String,
    /// Creation timestamp (epoch seconds or ISO-8601 string, storage dependent).
    pub created_at: String,
    /// Optional description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Body of `POST /api/v1/campaigns`.
#[derive(Debug, Deserialize)]
pub struct CreateCampaignRequest {
    /// Display name (1..=`MAX_CAMPAIGN_NAME_CHARS` characters after trimming).
    pub name: String,
    /// Game system identifier; defaults to `"dnd5e"`.
    #[serde(default)]
    pub system: Option<String>,
    /// Optional description.
    #[serde(default)]
    pub description: Option<String>,
}

/// Actor sheet as returned by the actor routes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActorDto {
    /// Actor UUID.
    pub id: Uuid,
    /// Owning campaign UUID.
    pub campaign_id: Uuid,
    /// Player who owns the sheet (`None` for GM-owned NPCs).
    pub owner_user_id: Option<Uuid>,
    /// Display name.
    pub name: String,
    /// Optimistic concurrency version (`>= 1`).
    pub version: i64,
    /// Full sheet payload (`Dnd5eActorData`).
    pub data: Value,
}

impl From<ActorRecord> for ActorDto {
    fn from(r: ActorRecord) -> Self {
        Self {
            id: r.id,
            campaign_id: r.campaign_id,
            owner_user_id: r.owner_user_id,
            name: r.name,
            version: r.version,
            data: r.payload,
        }
    }
}

/// Body of `POST /api/v1/campaigns/{id}/actors`.
#[derive(Debug, Deserialize)]
pub struct CreateActorRequest {
    /// Optional client-chosen actor UUID; a new one is generated otherwise.
    #[serde(default)]
    pub id: Option<Uuid>,
    /// Display name.
    pub name: String,
    /// Owner (GM only; players always own what they create).
    #[serde(default)]
    pub owner_user_id: Option<Uuid>,
    /// Sheet payload.
    #[serde(default)]
    pub data: Value,
}

/// Body of `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.
#[derive(Debug, Deserialize)]
pub struct UpdateActorRequest {
    /// Version the client last read; required (ADR-0037).
    pub expected_version: Option<i64>,
    /// Optional new display name.
    #[serde(default)]
    pub name: Option<String>,
    /// Full replacement sheet payload.
    pub data: Value,
}

/// Note as returned to a caller (content already filtered for the caller's role).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteDto {
    /// URL-safe slug, unique within the campaign.
    pub slug: String,
    /// Note UUID.
    pub id: Uuid,
    /// Title.
    pub title: String,
    /// Markdown body (role-filtered).
    pub content_markdown: String,
    /// Minimum role able to read the note (`"PLAYER"` or `"GM"`).
    pub min_role: String,
    /// Optional folder path.
    pub folder: Option<String>,
}

/// Body of `PUT /api/v1/campaigns/{id}/notes/{slug}`.
#[derive(Debug, Deserialize)]
pub struct PutNoteRequest {
    /// Title.
    pub title: String,
    /// Markdown body.
    pub content_markdown: String,
    /// Optional folder path.
    #[serde(default)]
    pub folder: Option<String>,
    /// `"PLAYER"` (default) or `"GM"`; only the GM may set it.
    #[serde(default)]
    pub min_role: Option<String>,
}

/// Body of `POST /api/v1/campaigns/{id}/dice/roll`.
#[derive(Debug, Deserialize)]
pub struct DiceRollRequest {
    /// Dice expression (`"2d20kh1+5"`).
    pub expression: String,
    /// Visibility tier; defaults to `Public`.
    #[serde(default)]
    pub visibility: Option<RollVisibility>,
    /// Optional label.
    #[serde(default)]
    pub reason: Option<String>,
}

/// Persisted campaign settings (`GET/PUT /api/v1/campaigns/{id}/settings`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CampaignSettings {
    /// When `true`, every MCP mutation is staged as a proposal for GM approval.
    #[serde(default)]
    pub mcp_staging_mode: bool,
}

/// Body of `POST /api/v1/campaigns/{id}/handouts/{handout_id}/reveal`.
#[derive(Debug, Default, Deserialize)]
pub struct RevealHandoutRequest {
    /// Timeline session number; defaults to `LIVE_SESSION_NUM`.
    #[serde(default)]
    pub session_num: Option<u32>,
}

/// Query of `POST /api/v1/campaigns/{id}/maps/import`.
#[derive(Debug, Default, Deserialize)]
pub struct MapImportQuery {
    /// Scene name; defaults to `"Imported map"`.
    #[serde(default)]
    pub name: Option<String>,
}

/// Query of the signed download route.
#[derive(Debug, Deserialize)]
pub struct SignedDownloadQuery {
    /// Expiry (epoch seconds).
    pub exp: u64,
    /// Hex HMAC-SHA256 signature over `"{key}:{exp}"`.
    pub sig: String,
}

#[derive(Default)]
struct CampaignDataInner {
    campaigns: HashMap<Uuid, CampaignRecord>,
    actors: HashMap<(Uuid, Uuid), ActorRecord>,
    notes: HashMap<(Uuid, String), CampaignNoteItem>,
    settings: HashMap<Uuid, CampaignSettings>,
}

/// In-memory campaign storage used when PostgreSQL is not configured.
#[derive(Clone, Default)]
pub struct InMemoryCampaignData {
    inner: Arc<RwLock<CampaignDataInner>>,
    /// Party journal of revealed handouts.
    pub journal: Arc<InMemoryPartyJournalStorage>,
}

fn storage_error(err: impl std::fmt::Display) -> Response {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "STORAGE_ERROR",
        &err.to_string(),
    )
}

fn forbidden(msg: &str) -> Response {
    error_response(StatusCode::FORBIDDEN, "FORBIDDEN", msg)
}

fn not_found(msg: &str) -> Response {
    error_response(StatusCode::NOT_FOUND, "NOT_FOUND", msg)
}

fn bad_request(code: &str, msg: &str) -> Response {
    error_response(StatusCode::BAD_REQUEST, code, msg)
}

fn role_label(role: CampaignRole) -> &'static str {
    match role {
        CampaignRole::Gm => "GM",
        CampaignRole::Player => "PLAYER",
        CampaignRole::Spectator => "SPECTATOR",
    }
}

/// Authenticates the caller and resolves their membership role in `campaign_id`.
async fn caller_role(
    state: &AppState,
    headers: &HeaderMap,
    campaign_id: Uuid,
) -> Result<(Uuid, CampaignRole), Box<Response>> {
    let user_id = resolve_authenticated_user(state, headers)
        .await
        .map_err(|_| {
            Box::new(error_response(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "valid authentication credentials required",
            ))
        })?;
    let role = resolve_campaign_role(state, campaign_id, user_id)
        .await
        .ok_or_else(|| Box::new(forbidden("user is not an active member of this campaign")))?;
    Ok((user_id, role))
}

pub(crate) async fn load_campaign(
    state: &AppState,
    campaign_id: Uuid,
) -> Result<Option<CampaignRecord>, String> {
    if let Some(pg) = &state.postgres_store {
        return Ok(pg.get_campaign_details(campaign_id).await?.map(|(c, _)| c));
    }
    if let Some(c) = state
        .campaign_data
        .inner
        .read()
        .map_err(|_| "campaign lock poisoned".to_string())?
        .campaigns
        .get(&campaign_id)
    {
        return Ok(Some(c.clone()));
    }
    Ok(state
        .campaign_store
        .get_campaign(&campaign_id)
        .map(|m| CampaignRecord {
            id: m.id,
            name: m.name,
            system_id: m.system,
            gm_user_id: Uuid::nil(),
            active_scene_id: None,
            description: m.description,
            created_at: m.created_at,
        }))
}

fn summary(c: CampaignRecord, role: &str) -> CampaignSummary {
    CampaignSummary {
        id: c.id,
        name: c.name,
        system: c.system_id,
        role: role.to_ascii_uppercase(),
        created_at: c.created_at,
        description: c.description,
    }
}

/// `GET /api/v1/campaigns` -> `{ campaigns: [CampaignSummary] }` for the caller's memberships.
pub async fn list_campaigns_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Ok(user_id) = resolve_authenticated_user(&state, &headers).await else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "valid authentication credentials required",
        );
    };
    let memberships = match state
        .auth_state
        .session_store
        .get_campaign_members_for_user(user_id)
        .await
    {
        Ok(m) => m,
        Err(err) => return storage_error(err),
    };
    let mut campaigns = Vec::with_capacity(memberships.len());
    for m in memberships {
        match load_campaign(&state, m.campaign_id).await {
            Ok(Some(c)) => campaigns.push(summary(c, &m.role)),
            Ok(None) => {}
            Err(err) => return storage_error(err),
        }
    }
    campaigns.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(json!({ "campaigns": campaigns })).into_response()
}

/// `POST /api/v1/campaigns` -> `201 { campaign }`; the caller becomes GM. Only `Host` and
/// `Owner` accounts may create campaigns (`403 HOST_REQUIRED` otherwise, SEC10).
pub async fn create_campaign_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateCampaignRequest>,
) -> Response {
    let Ok(user_id) = resolve_authenticated_user(&state, &headers).await else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "valid authentication credentials required",
        );
    };
    if let Err(resp) = crate::access::require_campaign_creator(&state, user_id).await {
        return *resp;
    }
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > MAX_CAMPAIGN_NAME_CHARS {
        return bad_request(
            "INVALID_NAME",
            &format!("name must be 1..={MAX_CAMPAIGN_NAME_CHARS} characters"),
        );
    }
    let system = req
        .system
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("dnd5e");
    let id = Uuid::new_v4();
    let record = if let Some(pg) = &state.postgres_store {
        match pg
            .create_campaign(id, name, system, user_id, req.description.as_deref())
            .await
        {
            Ok(r) => r,
            Err(err) => return storage_error(err),
        }
    } else {
        let record = CampaignRecord {
            id,
            name: name.to_string(),
            system_id: system.to_string(),
            gm_user_id: user_id,
            active_scene_id: None,
            description: req.description.clone(),
            created_at: crate::auth::magic_link::now_epoch_seconds().to_string(),
        };
        if let Ok(mut inner) = state.campaign_data.inner.write() {
            inner.campaigns.insert(id, record.clone());
        }
        if let Err(err) = state
            .auth_state
            .session_store
            .assign_campaign_member(id, user_id, None, "GM")
            .await
        {
            return storage_error(err);
        }
        record
    };
    (
        StatusCode::CREATED,
        Json(json!({ "campaign": summary(record, "GM") })),
    )
        .into_response()
}

/// `GET /api/v1/campaigns/{id}` -> `{ campaign }` (members only).
pub async fn get_campaign_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    match load_campaign(&state, campaign_id).await {
        Ok(Some(c)) => Json(json!({ "campaign": summary(c, role_label(role)) })).into_response(),
        Ok(None) => not_found("campaign not found"),
        Err(err) => storage_error(err),
    }
}

/// `GET /api/v1/campaigns/{id}/members` -> `{ members: [{ user_id, role, character_id, joined_at }] }`.
pub async fn list_members_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = caller_role(&state, &headers, campaign_id).await {
        return *resp;
    }
    match state
        .auth_state
        .session_store
        .list_campaign_members(campaign_id)
        .await
    {
        Ok(members) => Json(json!({ "members": members })).into_response(),
        Err(err) => storage_error(err),
    }
}

// ---------------------------------------------------------------------------
// Actor storage (PostgreSQL or memory)
// ---------------------------------------------------------------------------

fn stamp_payload(payload: &mut Value, actor_id: Uuid, campaign_id: Uuid, version: i64) {
    if !payload.is_object() {
        *payload = json!({});
    }
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".to_string(), json!(actor_id));
        obj.insert("campaign_id".to_string(), json!(campaign_id));
        obj.insert("version".to_string(), json!(version));
    }
}

async fn list_actors(state: &AppState, campaign_id: Uuid) -> Result<Vec<ActorRecord>, String> {
    if let Some(pg) = &state.postgres_store {
        return pg.list_actors_for_campaign(campaign_id).await;
    }
    let inner = state
        .campaign_data
        .inner
        .read()
        .map_err(|_| "actor lock poisoned".to_string())?;
    let mut list: Vec<ActorRecord> = inner
        .actors
        .values()
        .filter(|a| a.campaign_id == campaign_id)
        .cloned()
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(list)
}

/// Loads one actor sheet from PostgreSQL or memory.
pub async fn get_actor(
    state: &AppState,
    campaign_id: Uuid,
    actor_id: Uuid,
) -> Result<Option<ActorRecord>, String> {
    if let Some(pg) = &state.postgres_store {
        return pg.get_actor(campaign_id, actor_id).await;
    }
    Ok(state
        .campaign_data
        .inner
        .read()
        .map_err(|_| "actor lock poisoned".to_string())?
        .actors
        .get(&(campaign_id, actor_id))
        .cloned())
}

async fn create_actor(
    state: &AppState,
    campaign_id: Uuid,
    actor_id: Uuid,
    owner_user_id: Option<Uuid>,
    name: &str,
    mut payload: Value,
) -> Result<ActorRecord, ActorConcurrencyError> {
    if let Some(pg) = &state.postgres_store {
        return pg
            .create_actor(campaign_id, actor_id, owner_user_id, name, payload)
            .await;
    }
    stamp_payload(&mut payload, actor_id, campaign_id, 1);
    payload["name"] = json!(name);
    let record = ActorRecord {
        id: actor_id,
        campaign_id,
        owner_user_id,
        name: name.to_string(),
        version: 1,
        payload,
    };
    let mut inner = state
        .campaign_data
        .inner
        .write()
        .map_err(|_| ActorConcurrencyError::Database("actor lock poisoned".to_string()))?;
    if inner.actors.contains_key(&(campaign_id, actor_id)) {
        return Err(ActorConcurrencyError::Database(format!(
            "actor {actor_id} already exists"
        )));
    }
    inner.actors.insert((campaign_id, actor_id), record.clone());
    Ok(record)
}

/// Archive entities for `campaign_id`: every stored actor sheet (payload plus `name` and
/// `owner_user_id`) replaces any store `actor` entity with the same ID.
pub async fn export_entities_with_actors(
    state: &AppState,
    campaign_id: Uuid,
    entities: Vec<ExportEntity>,
) -> Result<Vec<ExportEntity>, String> {
    let actors = list_actors(state, campaign_id).await?;
    let ids: std::collections::HashSet<String> = actors.iter().map(|a| a.id.to_string()).collect();
    let mut out: Vec<ExportEntity> = entities
        .into_iter()
        .filter(|e| {
            e.entity_type != "actor"
                || !e
                    .data
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.contains(id))
        })
        .collect();
    for actor in actors {
        let mut data = actor.payload;
        stamp_payload(&mut data, actor.id, campaign_id, actor.version);
        data["name"] = json!(actor.name);
        if let Some(owner) = actor.owner_user_id {
            data[OWNER_USER_ID_FIELD] = json!(owner);
        }
        out.push(ExportEntity {
            entity_type: "actor".to_string(),
            data,
        });
    }
    Ok(out)
}

/// Splits an archived `actor` entity into `(id, name, owner, sheet data)`; the owner field is
/// removed from the sheet. `None` for non-actor entities.
pub fn split_actor_entity(entity: &ExportEntity) -> Option<(Uuid, String, Option<Uuid>, Value)> {
    if entity.entity_type != "actor" {
        return None;
    }
    let mut data = entity.data.clone();
    let owner = data
        .as_object_mut()
        .and_then(|o| o.remove(OWNER_USER_ID_FIELD))
        .and_then(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok()));
    let id = data
        .get("id")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or_else(Uuid::new_v4);
    let name = data
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("Imported actor")
        .to_string();
    Some((id, name, owner, data))
}

/// Memory-only mode: turns the `actor` entities an archive import stored in the campaign store
/// into actor sheets. An owner is kept only when that account exists on this instance.
pub async fn restore_imported_actors(
    state: &AppState,
    campaign_id: Uuid,
    entities: &[ExportEntity],
) -> Result<(), String> {
    for (id, name, owner, data) in entities.iter().filter_map(split_actor_entity) {
        let owner = match owner {
            Some(uid) => match state.auth_state.session_store.get_user_by_id(uid).await {
                Ok(Some(_)) => Some(uid),
                _ => None,
            },
            None => None,
        };
        create_actor(state, campaign_id, id, owner, &name, data)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Conditional actor write (`version == expected_version`), PostgreSQL or memory.
pub async fn update_actor(
    state: &AppState,
    campaign_id: Uuid,
    actor_id: Uuid,
    expected_version: i64,
    name: Option<&str>,
    mut payload: Value,
) -> Result<ActorRecord, ActorConcurrencyError> {
    if let Some(pg) = &state.postgres_store {
        return pg
            .update_actor_optimistic(campaign_id, actor_id, expected_version, name, payload)
            .await;
    }
    let mut inner = state
        .campaign_data
        .inner
        .write()
        .map_err(|_| ActorConcurrencyError::Database("actor lock poisoned".to_string()))?;
    let Some(existing) = inner.actors.get_mut(&(campaign_id, actor_id)) else {
        return Err(ActorConcurrencyError::NotFound {
            campaign_id,
            actor_id,
        });
    };
    if existing.version != expected_version {
        return Err(ActorConcurrencyError::VersionConflict {
            actor_id,
            expected_version,
            actual_version: existing.version,
        });
    }
    let next = expected_version.saturating_add(1);
    stamp_payload(&mut payload, actor_id, campaign_id, next);
    if let Some(n) = name {
        existing.name = n.to_string();
    }
    payload["name"] = json!(existing.name);
    existing.version = next;
    existing.payload = payload;
    Ok(existing.clone())
}

async fn delete_actor(state: &AppState, campaign_id: Uuid, actor_id: Uuid) -> Result<bool, String> {
    if let Some(pg) = &state.postgres_store {
        return pg.delete_actor(campaign_id, actor_id).await;
    }
    Ok(state
        .campaign_data
        .inner
        .write()
        .map_err(|_| "actor lock poisoned".to_string())?
        .actors
        .remove(&(campaign_id, actor_id))
        .is_some())
}

/// `400 INVALID_ABILITY_SCORE` when a numeric `abilities.<ability>.score` of `data` lies
/// outside `ABILITY_SCORES`; non-numeric scores are ignored by every derivation.
fn check_ability_scores(data: &Value) -> Result<(), Box<Response>> {
    let Some(abilities) = data.get("abilities").and_then(Value::as_object) else {
        return Ok(());
    };
    for (ability, entry) in abilities {
        let Some(score) = entry.get("score").and_then(Value::as_f64) else {
            continue;
        };
        if score.fract() != 0.0 || !ABILITY_SCORES.contains(&(score as i32)) {
            return Err(Box::new(bad_request(
                "INVALID_ABILITY_SCORE",
                &format!(
                    "abilities.{ability}.score must be an integer within {}..={}",
                    ABILITY_SCORES.start(),
                    ABILITY_SCORES.end()
                ),
            )));
        }
    }
    Ok(())
}

fn can_read_actor(role: CampaignRole, user_id: Uuid, actor: &ActorRecord) -> bool {
    role == CampaignRole::Gm || actor.owner_user_id == Some(user_id)
}

fn i32_at(v: &Value, path: &[&str]) -> Option<i32> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    cur.as_f64().map(|n| n.round() as i32)
}

/// Non-Dexterity part of the D&D 5e `derivedDAG` initiative
/// (`dex_mod + initiative_prof * prof_bonus - 2 * exhaustion`): `initiative_prof` is 1 when
/// `features` holds `srd:feat:alert`, and `prof_bonus` comes from `attributes.level` clamped
/// to `1..=20`.
fn derived_initiative_extra(data: &Value) -> i32 {
    let level = i32_at(data, &["attributes", "level"])
        .unwrap_or(1)
        .clamp(1, 20);
    let prof_bonus = (level - 1) / 4 + 2;
    let has_alert = data
        .get("features")
        .and_then(Value::as_array)
        .is_some_and(|f| f.iter().any(|id| id.as_str() == Some("srd:feat:alert")));
    let exhaustion = i32_at(data, &["attributes", "exhaustion"])
        .unwrap_or(0)
        .clamp(0, 6);
    let alert_bonus = if has_alert { prof_bonus } else { 0 };
    alert_bonus - 2 * exhaustion
}

/// Saving throw bonuses of a sheet, keyed by ability id, for server-rolled saves (D6):
/// - Stat block sheet (`statBlock` object, or numeric `abilities.<ability>`): the printed
///   `savingThrows`, else the score modifier (`resolution::stat_block_save_bonus`).
/// - Character sheet (`abilities.<ability>.score`, clamped to `ABILITY_SCORES`): the modifier,
///   plus the proficiency bonus of `attributes.level` when `saveProficiency` is set, minus
///   `2 * exhaustion` (SRD 5.2.1 d20 tests). The flat sheet (numeric `abilities` with a
///   `saveProficiencies` map, `level`, `exhaustionLevel`) follows the same formula. Feats and
///   magic items are not folded in.
/// - Neither: `None`, so the token keeps its current bonuses.
fn sheet_save_bonuses(data: &Value) -> Option<BTreeMap<String, i32>> {
    use trame_engine::resolution::ABILITY_IDS;
    let collect = |f: &dyn Fn(&str) -> i32| {
        Some(
            ABILITY_IDS
                .iter()
                .map(|ab| (ab.to_string(), f(ab)))
                .collect(),
        )
    };
    if let Some(block) = data.get("statBlock").filter(|b| b.is_object()) {
        return collect(&|ab| crate::resolution::stat_block_save_bonus(block, ab));
    }
    let abilities = data.get("abilities")?.as_object()?;
    let flat_proficiencies = data.get("saveProficiencies").filter(|p| p.is_object());
    let flat = abilities.values().any(Value::is_number);
    if flat && flat_proficiencies.is_none() {
        return collect(&|ab| crate::resolution::stat_block_save_bonus(data, ab));
    }
    if !flat && !abilities.values().any(|a| a.get("score").is_some()) {
        return None;
    }
    let (level_path, exhaustion_path): (&[&str], &[&str]) = if flat {
        (&["level"], &["exhaustionLevel"])
    } else {
        (&["attributes", "level"], &["attributes", "exhaustion"])
    };
    let level = i32_at(data, level_path).unwrap_or(1).clamp(1, 20);
    let prof_bonus = (level - 1) / 4 + 2;
    let exhaustion = i32_at(data, exhaustion_path).unwrap_or(0).clamp(0, 6);
    collect(&|ab| {
        let entry = abilities.get(ab);
        let (score, proficient) = if flat {
            (
                entry.and_then(Value::as_f64),
                flat_proficiencies.and_then(|p| p.get(ab)),
            )
        } else {
            (
                entry.and_then(|e| e.get("score")).and_then(Value::as_f64),
                entry.and_then(|e| e.get("saveProficiency")),
            )
        };
        let score = score.map_or(10, |s| {
            (s.round() as i32).clamp(*ABILITY_SCORES.start(), *ABILITY_SCORES.end())
        });
        let proficient = proficient.and_then(Value::as_bool).unwrap_or(false);
        (score - 10).div_euclid(2) + if proficient { prof_bonus } else { 0 } - 2 * exhaustion
    })
}

/// Compendium keys (`srd:item:<key>`) of the SRD 5.2.1 weapons with the Reach property.
/// This table and `SRD_SPECIES_DARKVISION_FT` are parsed and checked against the dnd5e
/// packs by `packages/game-systems/dnd5e/tests/serverTablesDrift.test.ts`.
const SRD_REACH_WEAPONS: [&str; 5] = ["glaive", "halberd", "lance", "pike", "whip"];

/// Darkvision in feet of each SRD 5.2.1 species (`speciesId` key without `srd:species:`),
/// mirroring `SRD_SPECIES[*].darkvisionFt` in `packages/game-systems/dnd5e/src/origins.ts`.
const SRD_SPECIES_DARKVISION_FT: [(&str, f64); 9] = [
    ("dragonborn", 60.0),
    ("dwarf", 120.0),
    ("elf", 60.0),
    ("gnome", 60.0),
    ("goliath", 0.0),
    ("halfling", 0.0),
    ("human", 0.0),
    ("orc", 120.0),
    ("tiefling", 60.0),
];

/// Melee reach in feet a token threatens for opportunity attacks, from the sheet:
/// - Stat block (`actions[]`): the largest `attack.reachFt` among `melee` and
///   `melee_or_ranged` attacks, `5` when none is printed.
/// - Character sheet (`items[]`): `10` when an equipped item is an SRD reach weapon (matched
///   by `compendiumId`, else by `name` without a leading count, plural `s` allowed), else `5`.
/// - Neither list: `None`, so the token keeps its current reach.
fn threat_reach_ft(data: &Value) -> Option<f64> {
    if let Some(actions) = data.get("actions").and_then(Value::as_array) {
        let melee_reach = actions
            .iter()
            .filter_map(|a| a.get("attack"))
            .filter(|attack| {
                matches!(
                    attack.get("kind").and_then(Value::as_str),
                    Some("melee" | "melee_or_ranged")
                )
            })
            .filter_map(|attack| attack.get("reachFt").and_then(Value::as_f64))
            .fold(None, |best: Option<f64>, r| {
                Some(best.map_or(r, |b| b.max(r)))
            });
        return Some(melee_reach.unwrap_or(5.0).clamp(0.0, 100.0));
    }
    let items = data.get("items").and_then(Value::as_array)?;
    let is_reach_weapon = |item: &Value| {
        let key = match item.get("compendiumId").and_then(Value::as_str) {
            Some(id) => id.rsplit(':').next().unwrap_or(id).to_ascii_lowercase(),
            None => item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_start_matches(|c: char| c.is_ascii_digit() || c.is_whitespace())
                .to_ascii_lowercase(),
        };
        SRD_REACH_WEAPONS
            .iter()
            .any(|w| key == *w || key.strip_suffix('s') == Some(*w))
    };
    let wields_reach = items.iter().any(|item| {
        item.get("equipped").and_then(Value::as_bool) == Some(true) && is_reach_weapon(item)
    });
    Some(if wields_reach { 10.0 } else { 5.0 })
}

/// Darkvision in feet from the sheet: a stat block's `senses.darkvision` (`0` when the
/// `senses` object omits it), else the SRD species of `speciesId`, else `None` (unknown
/// species: the token keeps its current senses).
fn darkvision_ft(data: &Value) -> Option<f64> {
    if let Some(senses) = data.get("senses").and_then(Value::as_object) {
        let ft = senses
            .get("darkvision")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        return Some(ft.clamp(0.0, 500.0));
    }
    let species = data.get("speciesId").and_then(Value::as_str)?;
    let key = species.strip_prefix("srd:species:").unwrap_or(species);
    SRD_SPECIES_DARKVISION_FT
        .iter()
        .find(|(id, _)| *id == key)
        .map(|(_, ft)| *ft)
}

/// Armor Class from the sheet (GS6): the derived AC the client stores with the sheet
/// (`derived.armorClass`, armor, shield and Unarmored Defense applied), else a flat
/// `attributes.ac`, else a stat block's `armorClass.value`; `None` keeps the token's AC.
fn sheet_armor_class(data: &Value) -> Option<i32> {
    i32_at(data, &["derived", "armorClass"])
        .or_else(|| i32_at(data, &["attributes", "ac"]))
        .or_else(|| i32_at(data, &["armorClass", "value"]))
}

/// Walking speed in feet from the sheet (GS6). The derived speed the client stores with the
/// sheet (`derived.speed`: exhaustion and ClassFeature bonuses such as Unarmored Movement
/// or Fast Movement applied) wins, with the same trust model as `derived.armorClass`: the
/// room bounds it like a stat block speed (`ActorTacticalSync::apply_to_token`). Without
/// it, the `derivedDAG` base formula `max(0, speed_base - 5 * exhaustion)`: `speed_base` is
/// `attributes.speedFt` (legacy `attributes.speed`, or a stat block's `speed.walk`),
/// exhaustion is clamped to `0..=6`. `None` keeps the token's speed. Conditions are not
/// folded in here: the token evaluates Speed 0 itself so GM rulings still apply.
fn sheet_speed_ft(data: &Value) -> Option<f64> {
    if let Some(derived) = data
        .pointer("/derived/speed")
        .and_then(Value::as_f64)
        .filter(|ft| ft.is_finite())
    {
        return Some(derived);
    }
    let attributes = data.get("attributes");
    let base = attributes
        .and_then(|a| a.get("speedFt").or_else(|| a.get("speed")))
        .and_then(Value::as_f64)
        .or_else(|| data.pointer("/speed/walk").and_then(Value::as_f64))?;
    let exhaustion = i32_at(data, &["attributes", "exhaustion"])
        .unwrap_or(0)
        .clamp(0, 6);
    Some((base - 5.0 * f64::from(exhaustion)).max(0.0))
}

/// Extracts the token-relevant subset of a `Dnd5eActorData` sheet:
/// `attributes.hp.{current,max,temp}`, the Armor Class (`sheet_armor_class`),
/// `abilities.dex.score` (-> modifier), the walking speed (`sheet_speed_ft`),
/// `conditions[].id`, `damageMitigations` (`RESISTANT` / `IMMUNE` / `VULNERABLE` per damage
/// type, A68), the threat reach (`threat_reach_ft`), and darkvision (`darkvision_ft`).
pub fn tactical_sync_from_sheet(name: Option<&str>, data: &Value) -> ActorTacticalSync {
    let conditions = data.get("conditions").and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(|c| {
                c.get("id")
                    .and_then(Value::as_str)
                    .or_else(|| c.as_str())
                    .map(str::to_string)
            })
            .collect()
    });
    let damage_affinities = data
        .get("damageMitigations")
        .and_then(Value::as_object)
        .map(|map| {
            let mut resist = Vec::new();
            let mut immune = Vec::new();
            let mut vuln = Vec::new();
            for (damage_type, level) in map {
                match level.as_str().map(str::to_ascii_uppercase).as_deref() {
                    Some("RESISTANT") => resist.push(damage_type.clone()),
                    Some("IMMUNE") => immune.push(damage_type.clone()),
                    Some("VULNERABLE") => vuln.push(damage_type.clone()),
                    _ => {}
                }
            }
            (resist, immune, vuln)
        });
    let dex_mod = i32_at(data, &["abilities", "dex", "score"])
        .map(|s| (s.clamp(*ABILITY_SCORES.start(), *ABILITY_SCORES.end()) - 10).div_euclid(2));
    ActorTacticalSync {
        name: name.map(str::to_string),
        hp_current: i32_at(data, &["attributes", "hp", "current"]),
        hp_max: i32_at(data, &["attributes", "hp", "max"]),
        temp_hp: i32_at(data, &["attributes", "hp", "temp"]),
        ac: sheet_armor_class(data),
        dex_mod,
        initiative_extra: dex_mod.map(|_| derived_initiative_extra(data)),
        speed_ft: sheet_speed_ft(data),
        conditions,
        damage_affinities,
        reach_ft: threat_reach_ft(data),
        darkvision_ft: darkvision_ft(data),
        save_bonuses: sheet_save_bonuses(data),
    }
}

/// Resolves the storage-backed parts of a `SpawnToken` before it reaches the room:
/// - Actor-linked token: every synced field (HP, AC, speed, conditions, affinities, reach,
///   darkvision) is overwritten from the stored sheet, so a client cannot spawn its token
///   with better numbers than the sheet allows. An actor that cannot be loaded leaves the
///   token unchanged.
/// - `stat_block` holding an actor template UUID: replaced by a copy of that actor's
///   `statBlock`; the room then validates and applies it (`statblock::normalize_command`).
///   A template that is missing or has no stat block rejects the command.
///
/// Other commands pass through unchanged.
pub async fn resolve_spawn(
    state: &AppState,
    campaign_id: Uuid,
    cmd: TrameCommand,
) -> Result<TrameCommand, String> {
    let TrameCommand::SpawnToken { mut token } = cmd else {
        return Ok(cmd);
    };
    if let Some(actor_id) = token.actor_id
        && let Ok(Some(actor)) = get_actor(state, campaign_id, actor_id).await
    {
        tactical_sync_from_sheet(None, &actor.payload)
            .apply_to_token(&mut token, trame_engine::commands::TableMode::Exploration);
    }
    if let Some(template_id) = token
        .stat_block
        .as_ref()
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
    {
        token.stat_block = Some(actor_template_stat_block(state, campaign_id, template_id).await?);
    }
    Ok(TrameCommand::SpawnToken { token })
}

/// Copy of the `statBlock` stored on actor `template_id` of `campaign_id` (a monster actor
/// used as a template); an error when the actor is missing or carries no stat block.
pub async fn actor_template_stat_block(
    state: &AppState,
    campaign_id: Uuid,
    template_id: Uuid,
) -> Result<Value, String> {
    get_actor(state, campaign_id, template_id)
        .await
        .ok()
        .flatten()
        .and_then(|actor| actor.payload.get("statBlock").cloned())
        .filter(Value::is_object)
        .ok_or_else(|| format!("not found: actor template {template_id} has no stat block"))
}

/// Wakes the room and resyncs linked tokens + broadcasts `ActorUpdated` for `record`.
async fn sync_actor_to_room(state: &AppState, record: &ActorRecord, sync: ActorTacticalSync) {
    let Ok(room) = state
        .lease_manager
        .get_or_wake_room(record.campaign_id)
        .await
    else {
        return;
    };
    if let Err(err) = room
        .notify_actor_updated(
            record.id,
            u64::try_from(record.version).unwrap_or(0),
            record.payload.clone(),
            sync,
        )
        .await
    {
        tracing::warn!(actor_id = %record.id, error = %err, "actor resync failed");
    }
}

fn concurrency_response(err: ActorConcurrencyError) -> Response {
    match err {
        ActorConcurrencyError::NotFound { .. } => not_found("actor not found"),
        ActorConcurrencyError::VersionConflict {
            expected_version,
            actual_version,
            ..
        } => (
            StatusCode::CONFLICT,
            Json(json!({
                "code": "VERSION_CONFLICT",
                "error": format!(
                    "stale actor version: expected {expected_version}, current {actual_version}"
                ),
                "current_version": actual_version,
            })),
        )
            .into_response(),
        ActorConcurrencyError::Database(msg) => storage_error(msg),
    }
}

/// `GET /api/v1/campaigns/{id}/actors` -> `{ actors }` (GM: all; players: owned only).
pub async fn list_actors_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (user_id, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    match list_actors(&state, campaign_id).await {
        Ok(list) => {
            let actors: Vec<ActorDto> = list
                .into_iter()
                .filter(|a| can_read_actor(role, user_id, a))
                .map(ActorDto::from)
                .collect();
            Json(json!({ "actors": actors })).into_response()
        }
        Err(err) => storage_error(err),
    }
}

/// `POST /api/v1/campaigns/{id}/actors` -> `201 { actor }`. Players own what they create.
pub async fn create_actor_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<CreateActorRequest>,
) -> Response {
    let (user_id, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    let owner = match role {
        CampaignRole::Gm => req.owner_user_id,
        CampaignRole::Player => Some(user_id),
        CampaignRole::Spectator => return forbidden("spectators cannot create actors"),
    };
    let name = req.name.trim();
    if name.is_empty() {
        return bad_request("INVALID_NAME", "actor name must not be empty");
    }
    if let Err(resp) = check_ability_scores(&req.data) {
        return *resp;
    }
    let actor_id = req.id.unwrap_or_else(Uuid::new_v4);
    if let Ok(Some(_)) = get_actor(&state, campaign_id, actor_id).await {
        return error_response(StatusCode::CONFLICT, "ACTOR_EXISTS", "actor already exists");
    }
    match create_actor(&state, campaign_id, actor_id, owner, name, req.data).await {
        Ok(record) => (
            StatusCode::CREATED,
            Json(json!({ "actor": ActorDto::from(record) })),
        )
            .into_response(),
        Err(err) => concurrency_response(err),
    }
}

/// `GET /api/v1/campaigns/{id}/actors/{actor_id}` -> `{ actor }` (GM or owner, else 404).
pub async fn get_actor_handler(
    State(state): State<AppState>,
    Path((campaign_id, actor_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (user_id, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    match get_actor(&state, campaign_id, actor_id).await {
        Ok(Some(a)) if can_read_actor(role, user_id, &a) => {
            Json(json!({ "actor": ActorDto::from(a) })).into_response()
        }
        Ok(_) => not_found("actor not found"),
        Err(err) => storage_error(err),
    }
}

/// `PUT /api/v1/campaigns/{id}/actors/{actor_id}` with `{ expected_version, name?, data }`
/// -> `{ actor }`, `409 VERSION_CONFLICT` when stale, `400 MISSING_EXPECTED_VERSION`.
pub async fn update_actor_handler(
    State(state): State<AppState>,
    Path((campaign_id, actor_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(req): Json<UpdateActorRequest>,
) -> Response {
    let (user_id, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    let Some(expected_version) = req.expected_version else {
        return bad_request(
            "MISSING_EXPECTED_VERSION",
            "expected_version is required (optimistic concurrency, ADR-0037)",
        );
    };
    match get_actor(&state, campaign_id, actor_id).await {
        Ok(Some(a)) if can_read_actor(role, user_id, &a) => {}
        Ok(_) => return not_found("actor not found"),
        Err(err) => return storage_error(err),
    }
    if role == CampaignRole::Spectator {
        return forbidden("spectators cannot edit actors");
    }
    if let Err(resp) = check_ability_scores(&req.data) {
        return *resp;
    }
    let name = req.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
    match update_actor(
        &state,
        campaign_id,
        actor_id,
        expected_version,
        name,
        req.data,
    )
    .await
    {
        Ok(record) => {
            let sync = tactical_sync_from_sheet(name, &record.payload);
            sync_actor_to_room(&state, &record, sync).await;
            Json(json!({ "actor": ActorDto::from(record) })).into_response()
        }
        Err(err) => concurrency_response(err),
    }
}

/// `DELETE /api/v1/campaigns/{id}/actors/{actor_id}` -> `204` (GM only).
pub async fn delete_actor_handler(
    State(state): State<AppState>,
    Path((campaign_id, actor_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    match caller_role(&state, &headers, campaign_id).await {
        Ok((_, CampaignRole::Gm)) => {}
        Ok(_) => return forbidden("only the GM may delete actors"),
        Err(resp) => return *resp,
    }
    match delete_actor(&state, campaign_id, actor_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found("actor not found"),
        Err(err) => storage_error(err),
    }
}

// ---------------------------------------------------------------------------
// Notes, handouts, journal
// ---------------------------------------------------------------------------

async fn list_notes(state: &AppState, campaign_id: Uuid) -> Result<Vec<CampaignNoteItem>, String> {
    if let Some(pg) = &state.postgres_store {
        return pg.list_campaign_notes(campaign_id).await;
    }
    let inner = state
        .campaign_data
        .inner
        .read()
        .map_err(|_| "note lock poisoned".to_string())?;
    let mut list: Vec<CampaignNoteItem> = inner
        .notes
        .values()
        .filter(|n| n.campaign_id == campaign_id)
        .cloned()
        .collect();
    list.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(list)
}

async fn save_note(state: &AppState, note: CampaignNoteItem) -> Result<(), String> {
    if let Some(pg) = &state.postgres_store {
        return pg.upsert_campaign_note(&note).await;
    }
    state
        .campaign_data
        .inner
        .write()
        .map_err(|_| "note lock poisoned".to_string())?
        .notes
        .insert((note.campaign_id, note.slug.clone()), note);
    Ok(())
}

fn is_gm_note(note: &CampaignNoteItem) -> bool {
    note.min_role.eq_ignore_ascii_case("GM")
}

fn note_for(note: CampaignNoteItem, role: CampaignRole) -> NoteDto {
    NoteDto {
        content_markdown: FilteredNoteDocument::filter_for_role(
            &note.content_markdown,
            UserRole::from(role),
        ),
        slug: note.slug,
        id: note.id,
        title: note.title,
        min_role: note.min_role,
        folder: note.folder,
    }
}

fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 128
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `GET /api/v1/campaigns/{id}/notes` -> `{ notes }`, filtered for the caller's role.
pub async fn list_notes_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    match list_notes(&state, campaign_id).await {
        Ok(list) => {
            let notes: Vec<NoteDto> = list
                .into_iter()
                .filter(|n| role == CampaignRole::Gm || !is_gm_note(n))
                .map(|n| note_for(n, role))
                .collect();
            Json(json!({ "notes": notes })).into_response()
        }
        Err(err) => storage_error(err),
    }
}

/// `PUT /api/v1/campaigns/{id}/notes/{slug}` -> `{ note }`. The GM writes raw markdown;
/// players may edit party notes only, merged so `:::dm` / hidden handout blocks survive.
pub async fn put_note_handler(
    State(state): State<AppState>,
    Path((campaign_id, slug)): Path<(Uuid, String)>,
    headers: HeaderMap,
    Json(req): Json<PutNoteRequest>,
) -> Response {
    let (user_id, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    if role == CampaignRole::Spectator {
        return forbidden("spectators cannot edit notes");
    }
    if !is_valid_slug(&slug) {
        return bad_request("INVALID_SLUG", "slug must match [A-Za-z0-9_-]{1,128}");
    }
    let existing = match list_notes(&state, campaign_id).await {
        Ok(list) => list.into_iter().find(|n| n.slug == slug),
        Err(err) => return storage_error(err),
    };
    let now = crate::auth::magic_link::now_epoch_seconds().to_string();
    let note = if role == CampaignRole::Gm {
        let min_role = match req.min_role.as_deref().map(str::to_ascii_uppercase) {
            Some(r) if r == "GM" => "GM".to_string(),
            _ => "PLAYER".to_string(),
        };
        CampaignNoteItem {
            campaign_id,
            slug: slug.clone(),
            id: existing.as_ref().map_or_else(Uuid::new_v4, |n| n.id),
            title: req.title,
            content_markdown: req.content_markdown,
            min_role,
            folder: req.folder,
            author_id: Some(user_id),
            created_at: existing
                .as_ref()
                .map_or_else(|| now.clone(), |n| n.created_at.clone()),
            updated_at: now,
        }
    } else {
        match existing {
            Some(n) if is_gm_note(&n) => return not_found("note not found"),
            Some(n) => CampaignNoteItem {
                content_markdown: merge_party_note_ast(&n.content_markdown, &req.content_markdown),
                title: req.title,
                folder: req.folder.or(n.folder.clone()),
                updated_at: now,
                ..n
            },
            None => CampaignNoteItem {
                campaign_id,
                slug: slug.clone(),
                id: Uuid::new_v4(),
                title: req.title,
                content_markdown: merge_party_note_ast("", &req.content_markdown),
                min_role: "PLAYER".to_string(),
                folder: req.folder,
                author_id: Some(user_id),
                created_at: now.clone(),
                updated_at: now,
            },
        }
    };
    if let Err(err) = save_note(&state, note.clone()).await {
        return storage_error(err);
    }
    Json(json!({ "note": note_for(note, role) })).into_response()
}

fn journal(state: &AppState) -> &dyn PartyJournalStorage {
    match &state.postgres_store {
        Some(pg) => pg.as_ref(),
        None => state.campaign_data.journal.as_ref(),
    }
}

/// `GET /api/v1/campaigns/{id}/journal` -> `{ entries }` (revealed handouts, newest first).
pub async fn list_journal_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = caller_role(&state, &headers, campaign_id).await {
        return *resp;
    }
    match journal(&state).list_entries(&campaign_id.to_string()) {
        Ok(entries) => Json(json!({ "entries": entries })).into_response(),
        Err(err) => storage_error(err),
    }
}

/// `POST /api/v1/campaigns/{id}/handouts/{handout_id}/reveal` -> `{ handout }` (GM only).
/// Finds the `:::handout{id=...}` block in the campaign notes, records it in the party
/// journal and timeline, applies `RevealHandout` to the room, and pushes the content to
/// every connected client (`ServerEnvelope::HandoutRevealed`).
pub async fn reveal_handout_handler(
    State(state): State<AppState>,
    Path((campaign_id, handout_id)): Path<(Uuid, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user_id = match caller_role(&state, &headers, campaign_id).await {
        Ok((uid, CampaignRole::Gm)) => uid,
        Ok(_) => return forbidden("only the GM may reveal handouts"),
        Err(resp) => return *resp,
    };
    let req: RevealHandoutRequest = if body.is_empty() {
        RevealHandoutRequest::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(r) => r,
            Err(err) => return bad_request("INVALID_PAYLOAD", &err.to_string()),
        }
    };
    let notes = match list_notes(&state, campaign_id).await {
        Ok(n) => n,
        Err(err) => return storage_error(err),
    };
    let Some((title, content)) = notes.iter().find_map(|n| {
        parse_markdown_ast(&n.content_markdown)
            .into_iter()
            .find_map(|node| match node {
                DirectiveAstNode::HandoutDirective {
                    id, title, content, ..
                } if id == handout_id => Some((title, content)),
                _ => None,
            })
    }) else {
        return not_found("handout not found in campaign notes");
    };
    let broadcast = match reveal_handout(
        UserRole::GameMaster,
        &user_id.to_string(),
        RevealHandoutCommand {
            campaign_id: campaign_id.to_string(),
            session_num: req.session_num.unwrap_or(LIVE_SESSION_NUM),
            handout_id: handout_id.clone(),
            title,
            content,
        },
        journal(&state),
        state.timeline_storage.as_ref(),
    ) {
        Ok(b) => b,
        Err(err @ NotesError::HandoutTitleTooLong(_)) => {
            return bad_request("HANDOUT_TITLE_TOO_LONG", &err.to_string());
        }
        Err(err) => return storage_error(err),
    };
    if let Ok(room) = state.lease_manager.get_or_wake_room(campaign_id).await {
        let actor = CommandActor {
            user_id,
            role: CampaignRole::Gm,
        };
        if let Err(err) = room
            .dispatch_direct_command(actor, TrameCommand::RevealHandout { handout_id })
            .await
        {
            tracing::warn!(%campaign_id, error = %err, "RevealHandout rejected by the room");
        }
        let _ = room.broadcast_handout(broadcast.clone()).await;
    }
    Json(json!({ "handout": broadcast })).into_response()
}

// ---------------------------------------------------------------------------
// Dice and settings
// ---------------------------------------------------------------------------

fn append_timeline(state: &AppState, note: TimelineNote) {
    let result = state.timeline_storage.append_event(
        &note.campaign_id.to_string(),
        LIVE_SESSION_NUM,
        AppendEventInput {
            event_type: note.event_type,
            actor_id: None,
            payload: note.payload,
            timestamp: None,
        },
    );
    if let Err(err) = result {
        tracing::warn!(error = %err, "timeline append failed");
    }
}

/// `POST /api/v1/campaigns/{id}/dice/roll` -> `{ roll }` (projected for the caller).
/// Rolls with a fresh OS-seeded ChaCha20 CSPRNG whether or not the room is awake, appends
/// the roll to the timeline, and fans it out to the live table when the room is awake.
pub async fn roll_dice_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<DiceRollRequest>,
) -> Response {
    let (user_id, role) = match caller_role(&state, &headers, campaign_id).await {
        Ok(r) => r,
        Err(resp) => return *resp,
    };
    if role == CampaignRole::Spectator {
        return forbidden("spectators cannot roll dice");
    }
    if role != CampaignRole::Gm
        && req.reason.as_deref().is_some_and(|r| {
            r.trim_start()
                .get(..10)
                .is_some_and(|p| p.eq_ignore_ascii_case("initiative"))
        })
    {
        return bad_request(
            "INITIATIVE_ROLL_REQUIRES_ROOM",
            "initiative is rolled by the live table: send it through the room WebSocket",
        );
    }
    let outcome = match SeededDiceRoller::from_os_csprng().roll(
        user_id,
        &req.expression,
        req.visibility.unwrap_or(RollVisibility::Public),
        req.reason.unwrap_or_default(),
    ) {
        Ok(o) => o,
        Err(err) => return bad_request("INVALID_DICE_EXPRESSION", &err.to_string()),
    };
    append_timeline(
        &state,
        crate::room::roll_timeline_note(campaign_id, &outcome),
    );
    if let Some(room) = state.lease_manager.get_active_room(campaign_id).await {
        let _ = room.broadcast_dice_roll(outcome.clone()).await;
    }
    let roll = project_roll_for_recipient(&outcome, user_id, role);
    Json(json!({ "roll": roll })).into_response()
}

/// Reads the persisted settings of `campaign_id` (defaults when unset).
pub async fn load_settings(
    state: &AppState,
    campaign_id: Uuid,
) -> Result<CampaignSettings, String> {
    if let Some(pg) = &state.postgres_store {
        let raw = pg.get_campaign_settings(campaign_id).await?;
        return Ok(serde_json::from_value(raw).unwrap_or_default());
    }
    Ok(state
        .campaign_data
        .inner
        .read()
        .map_err(|_| "settings lock poisoned".to_string())?
        .settings
        .get(&campaign_id)
        .cloned()
        .unwrap_or_default())
}

/// `GET /api/v1/campaigns/{id}/settings` -> `CampaignSettings` (members).
pub async fn get_settings_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = caller_role(&state, &headers, campaign_id).await {
        return *resp;
    }
    match load_settings(&state, campaign_id).await {
        Ok(s) => Json(s).into_response(),
        Err(err) => storage_error(err),
    }
}

/// `PUT /api/v1/campaigns/{id}/settings` -> `CampaignSettings` (GM only).
pub async fn put_settings_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    Json(settings): Json<CampaignSettings>,
) -> Response {
    match caller_role(&state, &headers, campaign_id).await {
        Ok((_, CampaignRole::Gm)) => {}
        Ok(_) => return forbidden("only the GM may change campaign settings"),
        Err(resp) => return *resp,
    }
    let result = if let Some(pg) = &state.postgres_store {
        match serde_json::to_value(&settings) {
            Ok(v) => pg.set_campaign_settings(campaign_id, &v).await,
            Err(err) => Err(err.to_string()),
        }
    } else {
        state
            .campaign_data
            .inner
            .write()
            .map(|mut inner| {
                inner.settings.insert(campaign_id, settings.clone());
            })
            .map_err(|_| "settings lock poisoned".to_string())
    };
    match result {
        Ok(()) => Json(settings).into_response(),
        Err(err) => storage_error(err),
    }
}

// ---------------------------------------------------------------------------
// Assets and map import
// ---------------------------------------------------------------------------

/// `POST /api/v1/campaigns/{id}/assets` (raw image body, GM or player) -> `201 { hash, key, url,
/// expires_in_secs }`. The image is validated and re-encoded as WebP under a content address.
pub async fn upload_asset_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let max_pixel_area = match caller_role(&state, &headers, campaign_id).await {
        Ok((_, CampaignRole::Spectator)) => return forbidden("spectators cannot upload assets"),
        Ok((user_id, role)) => {
            if let Err(wait) = state.auth_state.security.rate_limiter.take_upload(user_id) {
                return crate::security::too_many_requests(wait);
            }
            if role == CampaignRole::Gm {
                MAX_IMAGE_PIXEL_AREA
            } else {
                MAX_PLAYER_IMAGE_PIXEL_AREA
            }
        }
        Err(resp) => return *resp,
    };
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), MAX_ASSET_UPLOAD_BYTES).await else {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
            &format!("asset uploads are limited to {MAX_ASSET_UPLOAD_BYTES} bytes"),
        );
    };
    if let Err(resp) = ensure_asset_quota(&state, campaign_id, bytes.len()).await {
        return *resp;
    }
    let webp = match transcode_upload_to_webp_blocking(bytes, max_pixel_area).await {
        Ok(w) => w,
        Err(err) => return bad_request("INVALID_IMAGE", &err.to_string()),
    };
    let hash = Sha256Hasher::digest(&webp);
    let key = format!(
        "instances/{}/campaigns/{campaign_id}/assets/{hash}.webp",
        state.instance_id
    );
    if let Err(err) = state
        .asset_store
        .put_asset(&key, Bytes::from(webp), "image/webp")
        .await
    {
        return storage_error(err);
    }
    let ttl = crate::assets::store::PRESIGNED_URL_DEFAULT_TTL;
    match state.asset_store.mint_presigned_get_url(&key, ttl).await {
        Ok(url) => (
            StatusCode::CREATED,
            Json(json!({
                "hash": hash,
                "key": key,
                "url": url,
                "expires_in_secs": ttl.as_secs(),
            })),
        )
            .into_response(),
        Err(err) => storage_error(err),
    }
}

/// Refuses with `413 STORAGE_QUOTA_EXCEEDED` when the campaign's stored asset bytes plus
/// `incoming_bytes` (the raw upload, an estimate of the re-encoded size) would exceed
/// `SecurityPolicy::campaign_asset_quota_bytes`. Runs before any decode (SEC14).
async fn ensure_asset_quota(
    state: &AppState,
    campaign_id: Uuid,
    incoming_bytes: usize,
) -> Result<(), Box<Response>> {
    let quota = state.auth_state.security.campaign_asset_quota_bytes;
    let used = state
        .asset_store
        .campaign_usage_bytes(campaign_id)
        .await
        .map_err(|err| Box::new(storage_error(err)))?;
    if used.saturating_add(incoming_bytes as u64) > quota {
        return Err(Box::new(error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "STORAGE_QUOTA_EXCEEDED",
            &format!("campaign asset storage is limited to {quota} bytes"),
        )));
    }
    Ok(())
}

/// `GET /assets/download/{*key}?exp=&sig=` -> asset bytes when the HMAC signature is valid
/// and unexpired (`403` otherwise). The signature is the credential: no cookie required.
pub async fn download_asset_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Query(query): Query<SignedDownloadQuery>,
) -> Response {
    if !state
        .asset_store
        .verify_presigned_get(&key, query.exp, &query.sig)
    {
        return forbidden("invalid or expired asset signature");
    }
    match state.asset_store.get_asset(&key).await {
        Ok(Some(bytes)) => {
            let mut headers = HeaderMap::new();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("image/webp"));
            (StatusCode::OK, headers, bytes).into_response()
        }
        Ok(None) => not_found("asset not found"),
        Err(err) => storage_error(err),
    }
}

fn hex_rgb(rgb: [f32; 3]) -> String {
    let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", c(rgb[0]), c(rgb[1]), c(rgb[2]))
}

/// Converts an imported UVTT map into a hidden (`revealed_to_players = false`) scene.
/// Light radii convert from pixels to feet at 5 ft per grid cell.
pub fn scene_from_import(
    campaign_id: Uuid,
    name: &str,
    map: &ImportedMapResult,
) -> CampaignMapScene {
    let ppg = map.pixels_per_grid.max(1.0);
    let px_to_ft = |px: f64| (px / ppg * 5.0) as f32;
    CampaignMapScene {
        id: Uuid::new_v4(),
        campaign_id,
        name: name.to_string(),
        grid_type: "square".to_string(),
        grid_size_px: ppg.round() as u32,
        grid_cell_distance_ft: 5.0,
        width_px: map.width_px,
        height_px: map.height_px,
        background_image_url: Some(map.image_asset_key.clone()),
        default_ground_elevation_ft: 0.0,
        revealed_to_players: false,
        spawn_points: Vec::new(),
        wall_segments: map.walls.clone(),
        light_sources: map
            .lights
            .iter()
            .map(|l| LightSource {
                id: l.id,
                x: l.position.x as f32,
                y: l.position.y as f32,
                origin: None,
                elevation_ft: 0.0,
                radius_ft: px_to_ft(l.dim_radius_px),
                bright_radius_ft: Some(px_to_ft(l.bright_radius_px)),
                color_hex: hex_rgb(l.color_rgb),
                intensity: l.intensity as f32,
            })
            .collect(),
        spatial_audio_emitters: Vec::new(),
        staged_tokens: Vec::new(),
        explored_fog_texture: None,
    }
}

/// `POST /api/v1/campaigns/{id}/maps/import?name=` (raw `.uvtt` / `.dd2vtt` JSON, GM only)
/// -> `201 { scene, version }` (the bumped scene-set version). Reuses the UVTT importer (64 MiB cap, magic bytes, pre-decode
/// dimension guard) and appends the scene to the campaign.
pub async fn import_map_handler(
    State(state): State<AppState>,
    Path(campaign_id): Path<Uuid>,
    Query(query): Query<MapImportQuery>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    match caller_role(&state, &headers, campaign_id).await {
        Ok((user_id, CampaignRole::Gm)) => {
            if let Err(wait) = state.auth_state.security.rate_limiter.take_upload(user_id) {
                return crate::security::too_many_requests(wait);
            }
        }
        Ok(_) => return forbidden("only the GM may import maps"),
        Err(resp) => return *resp,
    }
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), MAX_PAYLOAD_SIZE_BYTES).await else {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
            "map imports are limited to 64 MiB",
        );
    };
    if let Err(resp) = ensure_asset_quota(&state, campaign_id, bytes.len()).await {
        return *resp;
    }
    let map = match import_uvtt_map(
        bytes,
        state.instance_id,
        campaign_id,
        state.asset_store.as_ref(),
    )
    .await
    {
        Ok(m) => m,
        Err(UvttImportError::Storage(err)) => return storage_error(err),
        Err(err) => return bad_request("INVALID_MAP", &err.to_string()),
    };
    let name = query
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("Imported map");
    let scene = scene_from_import(campaign_id, name, &map);
    // An append never conflicts semantically, so a concurrent scene save only forces a
    // re-read; the bounded retry keeps a pathological save storm from looping forever.
    let mut attempt = 0;
    loop {
        let (mut scenes, expected_version) =
            match load_campaign_scene_set(&state, campaign_id).await {
                Ok(set) => set,
                Err(err) => return storage_error(err),
            };
        scenes.push(scene.clone());
        match save_campaign_scenes(&state, campaign_id, scenes, expected_version).await {
            Ok(version) => {
                return (
                    StatusCode::CREATED,
                    Json(json!({ "scene": scene, "version": version })),
                )
                    .into_response();
            }
            Err(SceneSaveError::VersionConflict { .. }) if attempt < MAP_IMPORT_SAVE_RETRIES => {
                attempt += 1;
            }
            Err(err) => return scene_save_error(err, expected_version),
        }
    }
}

/// Extra load-append-save rounds `import_map_handler` attempts after a version conflict.
const MAP_IMPORT_SAVE_RETRIES: u32 = 3;

// ---------------------------------------------------------------------------
// Room sinks and router
// ---------------------------------------------------------------------------

/// Merges table condition ids into a sheet's `conditions` list: entries whose id is still
/// present keep their sheet metadata (duration, source), removed ids are dropped, and new
/// ids are appended as `{ "id": ... }` in table order.
fn merge_sheet_conditions(sheet_conditions: Option<&Value>, ids: &[String]) -> Value {
    let existing = sheet_conditions
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let entry_id = |entry: &Value| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| entry.as_str())
            .map(str::to_string)
    };
    let mut merged: Vec<Value> = existing
        .iter()
        .filter(|entry| entry_id(entry).is_some_and(|id| ids.contains(&id)))
        .cloned()
        .collect();
    for id in ids {
        if !merged
            .iter()
            .any(|entry| entry_id(entry).as_ref() == Some(id))
        {
            merged.push(json!({ "id": id }));
        }
    }
    Value::Array(merged)
}

/// Writes a linked token's hp / temp hp into its actor sheet (`attributes.hp`), and its
/// conditions when they changed (`merge_sheet_conditions`), retrying once on a concurrent
/// sheet edit, then broadcasts the new version (`ActorUpdated`).
pub async fn persist_linked_vitals(
    state: &AppState,
    change: &LinkedVitalsChange,
) -> Result<(), String> {
    for _ in 0..2 {
        let Some(actor) = get_actor(state, change.campaign_id, change.actor_id).await? else {
            return Ok(());
        };
        let mut data = actor.payload.clone();
        if !data.get("attributes").is_some_and(Value::is_object) {
            data["attributes"] = json!({});
        }
        if !data["attributes"].get("hp").is_some_and(Value::is_object) {
            data["attributes"]["hp"] = json!({});
        }
        data["attributes"]["hp"]["current"] = json!(change.hp);
        data["attributes"]["hp"]["temp"] = json!(change.temp_hp);
        if let Some(conditions) = &change.conditions {
            data["conditions"] = merge_sheet_conditions(data.get("conditions"), conditions);
        }
        match update_actor(
            state,
            change.campaign_id,
            change.actor_id,
            actor.version,
            None,
            data,
        )
        .await
        {
            Ok(record) => {
                if let Some(room) = state
                    .lease_manager
                    .get_active_room(change.campaign_id)
                    .await
                {
                    let _ = room
                        .notify_actor_updated(
                            record.id,
                            u64::try_from(record.version).unwrap_or(0),
                            record.payload,
                            ActorTacticalSync::default(),
                        )
                        .await;
                }
                return Ok(());
            }
            Err(ActorConcurrencyError::VersionConflict { .. }) => continue,
            Err(err) => return Err(err.to_string()),
        }
    }
    Err(format!(
        "actor {} kept changing; vitals not persisted",
        change.actor_id
    ))
}

/// Connects the lease manager's rooms to storage: linked vitals go to the actor sheets and
/// dice / initiative records to the timeline. No-op outside a Tokio runtime.
pub fn install_room_sinks(state: &AppState) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let (vitals_tx, mut vitals_rx) = mpsc::unbounded_channel::<LinkedVitalsChange>();
    let (timeline_tx, mut timeline_rx) = mpsc::unbounded_channel::<TimelineNote>();
    state.lease_manager.set_sinks(RoomSinks {
        vitals: Some(vitals_tx),
        timeline: Some(timeline_tx),
    });
    let vitals_state = state.clone();
    tokio::spawn(async move {
        while let Some(change) = vitals_rx.recv().await {
            if let Err(err) = persist_linked_vitals(&vitals_state, &change).await {
                tracing::warn!(actor_id = %change.actor_id, error = %err, "linked vitals not persisted");
            }
        }
    });
    let timeline_state = state.clone();
    tokio::spawn(async move {
        while let Some(note) = timeline_rx.recv().await {
            append_timeline(&timeline_state, note);
        }
    });
}

/// Campaign-scoped REST routes (all under `/api/v1/campaigns`) plus the signed download route.
pub fn campaign_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/campaigns",
            get(list_campaigns_handler).post(create_campaign_handler),
        )
        .route("/api/v1/campaigns/{campaign_id}", get(get_campaign_handler))
        .route(
            "/api/v1/campaigns/{campaign_id}/members",
            get(list_members_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/actors",
            get(list_actors_handler).post(create_actor_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/actors/{actor_id}",
            get(get_actor_handler)
                .put(update_actor_handler)
                .delete(delete_actor_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/notes",
            get(list_notes_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/notes/{slug}",
            put(put_note_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/journal",
            get(list_journal_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/handouts/{handout_id}/reveal",
            post(reveal_handout_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/dice/roll",
            post(roll_dice_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/settings",
            get(get_settings_handler).put(put_settings_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/assets",
            post(upload_asset_handler),
        )
        .route(
            "/api/v1/campaigns/{campaign_id}/maps/import",
            post(import_map_handler),
        )
        .route("/assets/download/{*key}", get(download_asset_handler))
}
