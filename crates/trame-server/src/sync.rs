//! ============================================================================
//! MESSAGEPACK WIRE PROTOCOL & 2.5D BVH STATE PROJECTION (sync.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Defines the binary MessagePack wire protocol envelopes (`ClientEnvelope` and
//! `ServerEnvelope`) and enforces information-theoretic server-side state and
//! event filtering (`project_state_for_recipient` and `filter_events_for_recipient`).
//! Without server-side projection, a malicious or curious player could inspect
//! WebSocket frames in browser DevTools to reveal tokens hidden behind dungeon
//! walls, invisible enemies, or unfound secret doors.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Server-Side Occlusion & GM-Channel Stripping`:
//!      - `visible_token_ids_for_recipient` strips any token carrying the
//!        `CHANNEL_GM_HIDDEN` bitmask for non-GMs and requires at least one
//!        player-owned token to have an unobstructed 2.5D BVH ray
//!        (`can_token_see_target`, eye height at `80%` stature to target torso
//!        at `50%` stature) before including a candidate token in the recipient's
//!        `ProjectedTableState` or `initiative_order`.
//!   2. `Secret Door Wire Masking`:
//!      - Closed `WallKind::SecretDoor { is_open: false }` segments are
//!        rewritten to `WallKind::Normal` inside `project_state_for_recipient`
//!        for all non-GM recipients so wire inspection cannot distinguish a
//!        closed secret door from a solid dungeon wall.
//!   3. `Event Stream Filtering`:
//!      - `filter_events_for_recipient` drops `TokenMoved`, `TokenSqueezeToggled`,
//!        `DamageApplied`, and `TokenResourcesOverridden` events referencing
//!        tokens outside the recipient's `visible_token_ids_for_recipient` set.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `project_state_for_recipient(campaign_id, state, recipient_user_id, recipient_role)`
//!     ├── 1. Compute `visible_ids = visible_token_ids_for_recipient(...)` via 2.5D `Bvh2D`.
//!     ├── 2. Filter `state.data.tokens` and `initiative_order` to `visible_ids` (or all if GM).
//!     ├── 3. Rewrite closed `WallKind::SecretDoor` to `WallKind::Normal` for non-GMs.
//!     └── 4. Package `ProjectedTableState` for MessagePack serialization (`rmp_serde`).
//! ============================================================================

use crate::dice::{ProjectedDiceRoll, RollVisibility};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use trame_engine::aoe::AoeTemplate;
pub use trame_engine::commands::McpStagingProposal;
use trame_engine::commands::{
    AmbientLightingPreset, CampaignRole, FogOverrideCell, LightSource, ReactionPrompt, TableMode,
    TableState, TokenState, TrameCommand, TrameEvent,
};
use trame_engine::geometry::{
    CHANNEL_GM_HIDDEN, Point2D, WallKind, WallSegment, can_token_see_target,
};
use uuid::Uuid;

/// Inbound binary MessagePack payload sent from a connected client to the room actor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientEnvelope {
    /// Submits an authoritative tabletop mutation command (`MoveToken`, `ToggleDoor`, `ApplyDamage`, etc.).
    SubmitCommand(Box<TrameCommand>),
    /// Requests an authoritative CSPRNG dice roll evaluated by the room's `SeededDiceRoller`.
    RollDice {
        /// Standard dice notation string (e.g., `"2d20kh1+5"`).
        expression: String,
        /// Privacy scope (`Public`, `GmOnly`, or `BlindGm`).
        visibility: RollVisibility,
        /// Action label or skill name associated with the roll.
        reason: String,
    },
    /// Broadcasts a transient Ephemeral Pointer ping onto the shared map canvas.
    PointerPing {
        /// Canvas coordinate of the pointer ping in pixels (`px`).
        pos: Point2D,
        /// Hexadecimal color string (e.g., `"#FFAA00"`) identifying the pinging user.
        color_hex: String,
    },
    /// Round-trip latency probe carrying the client's monotonic timestamp in milliseconds (`ms`).
    Ping {
        /// Client-side timestamp in milliseconds (`ms`).
        client_time_ms: u64,
    },
}

/// Role-filtered projection of `TableState` safe for serialization over a specific recipient's WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectedTableState {
    /// Unique identifier of the campaign room.
    pub campaign_id: Uuid,
    /// Current tabletop mode (`Exploration` or `TurnByTurn`).
    pub mode: TableMode,
    /// Whether player movement is paused in `Exploration` mode.
    pub exploration_paused: bool,
    /// Active global ambient lighting preset.
    pub ambient_lighting: AmbientLightingPreset,
    /// Grid cell width/height in canvas pixels (`px`).
    pub cell_size_px: f64,
    /// Tactical distance per grid cell in feet (`ft`).
    pub feet_per_cell: f64,
    /// Map of tokens visible to this specific recipient after BVH and `CHANNEL_GM_HIDDEN` filtering.
    pub tokens: BTreeMap<Uuid, TokenState>,
    /// Map walls with closed `SecretDoor` segments masked as `WallKind::Normal` for non-GM recipients.
    pub walls: Vec<WallSegment>,
    /// Active persistent Area of Effect templates on the map.
    pub persistent_aoes: BTreeMap<Uuid, AoeTemplate>,
    /// Combat initiative order filtered to tokens visible to this recipient.
    pub initiative_order: Vec<Uuid>,
    /// Zero-based index of the active turn in the authoritative initiative list.
    pub active_turn_index: usize,
    /// Current 1-based combat round counter.
    pub round: u32,
    /// Dynamic point light sources placed on the active map.
    #[serde(default)]
    pub lights: Vec<LightSource>,
    /// Manual GM fog-of-war cell overrides (`Reveal` / `Hide`).
    #[serde(default)]
    pub fog_overrides: Vec<FogOverrideCell>,
    /// Optional SHA-256 hash or asset URL of the active background battlemap image.
    #[serde(default)]
    pub background_asset_hash: Option<String>,
    /// Active battlemap width in canvas pixels (`px`).
    #[serde(default)]
    pub map_width_px: u32,
    /// Active battlemap height in canvas pixels (`px`).
    #[serde(default)]
    pub map_height_px: u32,
    /// Active 5-second tactical reaction prompts keyed by `prompt_id`.
    #[serde(default)]
    pub active_reaction_prompts: BTreeMap<Uuid, ReactionPrompt>,
    /// Queued MCP dry-run staging proposals keyed by `proposal_id` (included only for `Gm` recipients).
    #[serde(default)]
    pub mcp_staging_proposals: BTreeMap<Uuid, McpStagingProposal>,
}

/// Outbound binary MessagePack payload broadcast or unicast from `TableRoomActor` to connected clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ServerEnvelope {
    /// Full role-filtered tabletop snapshot pushed upon initial WebSocket connection.
    StateSnapshot {
        /// Current authoritative WAL sequence number (`>= 0`).
        seq_id: u64,
        /// Recipient-tailored tabletop state projection.
        state: ProjectedTableState,
    },
    /// Broadcast after a `TrameCommand` commits to the WAL, carrying recipient-filtered events and state.
    CommandAccepted {
        /// Monotonically increasing WAL sequence number assigned to the command (`>= 1`).
        seq_id: u64,
        /// Domain events visible to this recipient.
        events: Vec<TrameEvent>,
        /// Updated recipient-tailored tabletop state projection.
        state: ProjectedTableState,
    },
    /// Unicast to the submitting client when a `TrameCommand` or dice roll fails validation or RBAC.
    CommandRejected {
        /// Human-readable rejection reason.
        reason: String,
    },
    /// Broadcast (or unicast according to `RollVisibility`) when a dice roll completes.
    DiceRolled(ProjectedDiceRoll),
    /// Broadcasts a transient canvas pointer ping to all connected sessions in the room.
    PointerPingBroadcast {
        /// User UUID who triggered the ping.
        sender_user_id: Uuid,
        /// Canvas coordinate in pixels (`px`).
        pos: Point2D,
        /// Hexadecimal color string for rendering the ping ring.
        color_hex: String,
    },
    /// Unicast response to `ClientEnvelope::Ping` for round-trip time (RTT) measurement.
    Pong {
        /// Echoed client timestamp in milliseconds (`ms`).
        client_time_ms: u64,
        /// Authoritative room actor timestamp in milliseconds (`ms`).
        server_time_ms: u64,
    },
    /// Broadcasts an out-of-band persistent actor sheet update (`ADR-0037`) without polluting the tactical undo stack.
    ActorUpdated {
        /// Unique identifier of the updated persistent actor sheet.
        actor_id: Uuid,
        /// New monotonically increasing optimistic concurrency version (`>= 1`).
        version: u64,
        /// Serialized actor payload (`ActorDto` / sheet JSON).
        data: serde_json::Value,
    },
    /// Broadcasts a staged MCP batch proposal to connected Game Masters for dry-run preview.
    McpStagingProposed {
        /// Staged MCP command batch awaiting `CommitMcpStaging` or `RejectMcpStaging`.
        proposal: McpStagingProposal,
    },
}

/// Encodes a `ServerEnvelope` into a named MessagePack byte vector (`bytes`) for WebSocket transmission.
pub fn encode_server_envelope(env: &ServerEnvelope) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    rmp_serde::to_vec_named(env)
}

/// Decodes a binary MessagePack WebSocket frame (`bytes`) into a `ClientEnvelope`.
pub fn decode_client_envelope(bytes: &[u8]) -> Result<ClientEnvelope, rmp_serde::decode::Error> {
    rmp_serde::from_slice(bytes)
}

/// Computes which token IDs in `state` are visible to `(recipient_user_id, recipient_role)`
/// using the 2.5D BVH raycaster (`can_token_see_target`).
///
/// GMs perceive all tokens; Players and Spectators only perceive non-`CHANNEL_GM_HIDDEN` tokens
/// that they own or that lie within 2.5D line-of-sight of at least one token they own.
pub fn visible_token_ids_for_recipient(
    state: &TableState,
    recipient_user_id: Uuid,
    recipient_role: CampaignRole,
) -> HashSet<Uuid> {
    if recipient_role == CampaignRole::Gm {
        return state.data.tokens.keys().copied().collect();
    }

    let owned_tokens: Vec<&TokenState> = state
        .data
        .tokens
        .values()
        .filter(|t| {
            t.owner_user_id == Some(recipient_user_id)
                && (t.visibility_channel & CHANNEL_GM_HIDDEN) == 0
        })
        .collect();

    let mut visible = HashSet::new();
    for observer in &owned_tokens {
        visible.insert(observer.id);
    }

    for (cand_id, candidate) in &state.data.tokens {
        if (candidate.visibility_channel & CHANNEL_GM_HIDDEN) != 0 {
            continue;
        }
        if visible.contains(cand_id) {
            continue;
        }
        let seen = owned_tokens.iter().any(|observer| {
            can_token_see_target(
                &state.bvh,
                observer.top_left,
                observer.grid_w,
                observer.grid_h,
                observer.elevation_ft + observer.height_ft * 0.8,
                &observer.senses,
                candidate.top_left,
                candidate.grid_w,
                candidate.grid_h,
                candidate.elevation_ft + candidate.height_ft * 0.5,
                candidate.visibility_channel,
                candidate.invisible,
                state.cell_size_px,
                state.feet_per_cell,
            )
        });
        if seen {
            visible.insert(*cand_id);
        }
    }

    visible
}

/// Projects the authoritative `TableState` for a specific connected client:
/// - Strips `CHANNEL_GM_HIDDEN` tokens and tokens outside 2.5D BVH line-of-sight for non-GMs.
/// - Masks closed `SecretDoor` walls as `WallKind::Normal` walls so players cannot inspect wire data.
pub fn project_state_for_recipient(
    campaign_id: Uuid,
    state: &TableState,
    recipient_user_id: Uuid,
    recipient_role: CampaignRole,
) -> ProjectedTableState {
    let is_gm = recipient_role == CampaignRole::Gm;
    let visible_ids = visible_token_ids_for_recipient(state, recipient_user_id, recipient_role);

    let tokens: BTreeMap<Uuid, TokenState> = state
        .data
        .tokens
        .iter()
        .filter(|(id, _)| visible_ids.contains(id))
        .map(|(id, tok)| (*id, tok.clone()))
        .collect();

    let walls: Vec<WallSegment> = state
        .data
        .walls
        .iter()
        .map(|w| {
            let mut cloned = w.clone();
            if !is_gm && cloned.kind == (WallKind::SecretDoor { is_open: false }) {
                cloned.kind = WallKind::Normal;
            }
            cloned
        })
        .collect();

    let initiative_order: Vec<Uuid> = state
        .data
        .initiative_order
        .iter()
        .filter(|id| is_gm || visible_ids.contains(id))
        .copied()
        .collect();

    ProjectedTableState {
        campaign_id,
        mode: state.data.mode,
        exploration_paused: state.data.exploration_paused,
        ambient_lighting: state.data.ambient_lighting,
        cell_size_px: state.cell_size_px,
        feet_per_cell: state.feet_per_cell,
        tokens,
        walls,
        persistent_aoes: state.data.persistent_aoes.clone(),
        initiative_order,
        active_turn_index: state.data.active_turn_index,
        round: state.data.round,
        lights: state.data.lights.clone(),
        fog_overrides: state.data.fog_overrides.clone(),
        background_asset_hash: state.data.background_asset_hash.clone(),
        map_width_px: state.data.map_width_px,
        map_height_px: state.data.map_height_px,
        active_reaction_prompts: state.data.active_reaction_prompts.clone(),
        mcp_staging_proposals: if is_gm {
            state.data.mcp_staging_proposals.clone()
        } else {
            BTreeMap::new()
        },
    }
}

/// Filters `TrameEvent` notifications so hidden token movements or damage events
/// are never leaked to non-GM clients without 2.5D line-of-sight.
pub fn filter_events_for_recipient(
    state: &TableState,
    events: &[TrameEvent],
    recipient_user_id: Uuid,
    recipient_role: CampaignRole,
) -> Vec<TrameEvent> {
    if recipient_role == CampaignRole::Gm {
        return events.to_vec();
    }

    let visible_ids = visible_token_ids_for_recipient(state, recipient_user_id, recipient_role);
    events
        .iter()
        .filter(|ev| match ev {
            TrameEvent::TokenMoved { token_id, .. }
            | TrameEvent::TokenSqueezeToggled { token_id, .. }
            | TrameEvent::DamageApplied { token_id, .. }
            | TrameEvent::TokenResourcesOverridden { token_id, .. }
            | TrameEvent::TokenVisibilityChanged { token_id, .. }
            | TrameEvent::TokenOwnerAssigned { token_id, .. }
            | TrameEvent::TokenHealed { token_id, .. }
            | TrameEvent::ActionRefunded { token_id, .. } => visible_ids.contains(token_id),
            TrameEvent::TokenSpawned { token } => visible_ids.contains(&token.id),
            TrameEvent::ReactionPromptOpened { prompt } => {
                visible_ids.contains(&prompt.trigger_token_id)
            }
            TrameEvent::SceneActivated { .. } | TrameEvent::InitiativeUpdated { .. } => false,
            TrameEvent::AoeCleared { .. } | TrameEvent::HandoutRevealed { .. } => true,
            TrameEvent::DoorToggled { .. }
            | TrameEvent::DoorConfigured { .. }
            | TrameEvent::TableModeChanged { .. }
            | TrameEvent::TurnAdvanced { .. }
            | TrameEvent::AoeProjected { .. }
            | TrameEvent::ConcentrationBroken { .. }
            | TrameEvent::AmbientLightingChanged { .. }
            | TrameEvent::SceneLoaded { .. }
            | TrameEvent::TokenRemoved { .. }
            | TrameEvent::WallAdded { .. }
            | TrameEvent::LightAdded { .. }
            | TrameEvent::FogOverrideChanged { .. }
            | TrameEvent::MapConfigChanged { .. }
            | TrameEvent::ReactionDecided { .. }
            | TrameEvent::ReactionPromptClosed { .. }
            | TrameEvent::McpStagingCommitted { .. }
            | TrameEvent::McpStagingRejected { .. }
            | TrameEvent::ActionUndone { .. } => true,
        })
        .cloned()
        .collect()
}
