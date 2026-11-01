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
//!   2. `Secret Geometry Wire Masking`:
//!      - Closed `WallKind::SecretDoor { is_open: false }` and `WallKind::Illusion`
//!        segments are rewritten to fully blocking `WallKind::Normal` walls
//!        (`mask_wall_for_player`) in snapshots and in `WallAdded` /
//!        `DoorConfigured` events; closing a secret door emits nothing to players.
//!   3. `PublicTokenView Redaction (G5)`:
//!      - Only tokens the recipient controls are sent as full `TokenState`.
//!        Every other visible token is a `PublicTokenView` carrying a coarse
//!        `BloodiedState` instead of HP, AC, senses, or action economy, and
//!        vitality events (`DamageApplied`, `TokenResourcesOverridden`,
//!        `TokenSpawned`) reach only the controller.
//!   4. `Per-Recipient Turn Index`:
//!      - `active_turn_index` indexes the recipient's filtered `initiative_order`
//!        and is `None` when the active combatant is hidden; turn events clear
//!        `active_turn_token_id` the same way, so a hidden monster's turn never
//!        leaks through the tracker.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `project_state_for_recipient(campaign_id, state, recipient_user_id, recipient_role)`
//!     ├── 1. Compute `visible_ids = visible_token_ids_for_recipient(...)` via 2.5D `Bvh2D`.
//!     ├── 2. Split visible tokens into controlled `tokens` and `public_tokens`.
//!     ├── 3. Mask secret doors / illusions and invisible AoE casters for non-GMs.
//!     ├── 4. Filter `initiative_order` and re-index `active_turn_index`.
//!     └── 5. Package `ProjectedTableState` for MessagePack serialization (`rmp_serde`).
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
    /// Full `TokenState` for every token the recipient controls (`owner_user_id == recipient`).
    /// GMs receive every token here.
    pub tokens: BTreeMap<Uuid, TokenState>,
    /// Reduced `PublicTokenView` for visible tokens the recipient does not control (G5).
    /// Always empty for GMs.
    #[serde(default)]
    pub public_tokens: BTreeMap<Uuid, PublicTokenView>,
    /// Map walls with closed `SecretDoor` and `Illusion` segments masked as `WallKind::Normal`
    /// for non-GM recipients.
    pub walls: Vec<WallSegment>,
    /// Active persistent Area of Effect templates; caster IDs of tokens the recipient cannot
    /// see are cleared.
    pub persistent_aoes: BTreeMap<Uuid, AoeTemplate>,
    /// Combat initiative order filtered to tokens visible to this recipient.
    pub initiative_order: Vec<Uuid>,
    /// Zero-based index of the active combatant inside this recipient's filtered
    /// `initiative_order`; `None` when the active combatant is hidden from the recipient or
    /// the order is empty.
    pub active_turn_index: Option<usize>,
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
    /// Active tactical reaction prompts keyed by `prompt_id`; prompts never expire on a timer
    /// (G2). Non-GM recipients only receive prompts they are party to, without
    /// `resolved_reactor_ids` and without hidden movers' `pending_destination`.
    #[serde(default)]
    pub active_reaction_prompts: BTreeMap<Uuid, ReactionPrompt>,
    /// Queued MCP dry-run staging proposals keyed by `proposal_id` (included only for `Gm` recipients).
    #[serde(default)]
    pub mcp_staging_proposals: BTreeMap<Uuid, McpStagingProposal>,
}

/// Coarse health tier shown to participants who do not control a token (G5, `GLOSSARY.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BloodiedState {
    /// Current HP strictly above half of maximum HP.
    Unhurt,
    /// Current HP at or below half of maximum HP, but above `0`.
    Bloodied,
    /// Current HP at or below `0`.
    Down,
}

impl BloodiedState {
    /// Classifies `hp` against `max_hp` with integer math (`2 * hp > max_hp` is `Unhurt`),
    /// widened to `i64` so extreme values cannot overflow.
    pub fn from_hp(hp: i32, max_hp: i32) -> Self {
        if hp <= 0 {
            Self::Down
        } else if 2 * i64::from(hp) > i64::from(max_hp) {
            Self::Unhurt
        } else {
            Self::Bloodied
        }
    }
}

/// Reduced view of a token sent to a participant who does not control it (G5): no armor
/// class, hit point numbers, senses, action economy, or active effects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublicTokenView {
    /// Unique identifier of the token.
    pub id: Uuid,
    /// Display name shown on the tabletop.
    pub name: String,
    /// Controlling user (`None` for GM-controlled NPCs).
    pub owner_user_id: Option<Uuid>,
    /// Persistent actor sheet linked to the token, used by clients to resolve the portrait.
    pub actor_id: Option<Uuid>,
    /// Top-left canvas coordinate of the footprint in pixels (`px`).
    pub top_left: Point2D,
    /// Footprint width in grid cells (`>= 1`).
    pub grid_w: u8,
    /// Footprint height in grid cells (`>= 1`).
    pub grid_h: u8,
    /// Whether the token is squeezing (footprint shrunk by one cell when `>= 2`).
    pub is_squeezing: bool,
    /// Base elevation in feet (`ft`).
    pub elevation_ft: f64,
    /// Stature in feet (`ft`).
    pub height_ft: f64,
    /// Whether the token has the Invisible condition (only sent when the recipient perceives it).
    pub invisible: bool,
    /// Visible D&D 5e condition labels.
    pub conditions: Vec<String>,
    /// Coarse health tier derived from `hp` / `max_hp`.
    pub bloodied: BloodiedState,
}

impl From<&TokenState> for PublicTokenView {
    fn from(t: &TokenState) -> Self {
        Self {
            id: t.id,
            name: t.name.clone(),
            owner_user_id: t.owner_user_id,
            actor_id: t.actor_id,
            top_left: t.top_left,
            grid_w: t.grid_w,
            grid_h: t.grid_h,
            is_squeezing: t.is_squeezing,
            elevation_ft: t.elevation_ft,
            height_ft: t.height_ft,
            invisible: t.invisible,
            conditions: t.conditions.clone(),
            bloodied: BloodiedState::from_hp(t.hp, t.max_hp),
        }
    }
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
    /// Handout content revealed by the GM (`POST .../handouts/{id}/reveal`), sent to every client.
    HandoutRevealed(crate::notes::HandoutRevealedBroadcast),
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

/// Rewrites walls whose true nature is GM knowledge so non-GM wire payloads cannot tell them
/// apart from solid masonry: closed `SecretDoor` and `Illusion` segments become fully
/// blocking `WallKind::Normal` walls. Open secret doors stay revealed.
pub fn mask_wall_for_player(wall: &WallSegment) -> WallSegment {
    let mut masked = wall.clone();
    if matches!(
        wall.kind,
        WallKind::SecretDoor { is_open: false } | WallKind::Illusion { .. }
    ) {
        masked.kind = WallKind::Normal;
        masked.blocks_movement = true;
        masked.blocks_vision = true;
        masked.blocks_light = true;
        masked.blocks_sound = true;
    }
    masked
}

fn mask_aoe_caster(template: &AoeTemplate, visible_ids: &HashSet<Uuid>) -> AoeTemplate {
    let mut masked = template.clone();
    if masked
        .concentration_caster_id
        .is_some_and(|caster| !visible_ids.contains(&caster))
    {
        masked.concentration_caster_id = None;
    }
    masked
}

/// Returns `true` when `recipient_user_id` controls `token_id` (`owner_user_id` match).
fn recipient_controls(state: &TableState, token_id: &Uuid, recipient_user_id: Uuid) -> bool {
    state
        .data
        .tokens
        .get(token_id)
        .is_some_and(|t| t.owner_user_id == Some(recipient_user_id))
}

/// Recipient predicate shared by prompt projection and prompt events: the reactor's owner,
/// the controller of the reactor token, or the controller of the triggering token.
fn prompt_concerns_recipient(
    state: &TableState,
    prompt: &ReactionPrompt,
    recipient_user_id: Uuid,
) -> bool {
    prompt.reactor_owner_user_id == Some(recipient_user_id)
        || recipient_controls(state, &prompt.reactor_actor_id, recipient_user_id)
        || recipient_controls(state, &prompt.trigger_token_id, recipient_user_id)
}

/// Strips GM knowledge from a prompt sent to a non-GM: the list of other reactors already
/// prompted, and the mover's destination when the recipient cannot see the mover.
fn redact_prompt_for_player(
    prompt: &ReactionPrompt,
    visible_ids: &HashSet<Uuid>,
) -> ReactionPrompt {
    let mut redacted = prompt.clone();
    redacted.resolved_reactor_ids.clear();
    if !visible_ids.contains(&prompt.trigger_token_id) {
        redacted.pending_destination = None;
        redacted.pending_elevation_ft = None;
    }
    redacted
}

/// Re-indexes the authoritative active turn into the recipient's filtered initiative list.
fn recipient_active_turn_index(state: &TableState, filtered_order: &[Uuid]) -> Option<usize> {
    let active = state.active_turn_token_id()?;
    filtered_order.iter().position(|id| *id == active)
}

/// Projects the authoritative `TableState` for a specific connected client:
/// - Strips `CHANNEL_GM_HIDDEN` tokens and tokens outside 2.5D BVH line-of-sight for non-GMs.
/// - Sends full `TokenState` only for controlled tokens; other visible tokens become
///   `PublicTokenView` (G5).
/// - Masks closed `SecretDoor` and `Illusion` walls as `WallKind::Normal`.
/// - Re-indexes `active_turn_index` into the filtered initiative order.
pub fn project_state_for_recipient(
    campaign_id: Uuid,
    state: &TableState,
    recipient_user_id: Uuid,
    recipient_role: CampaignRole,
) -> ProjectedTableState {
    let is_gm = recipient_role == CampaignRole::Gm;
    let visible_ids = visible_token_ids_for_recipient(state, recipient_user_id, recipient_role);

    let mut tokens = BTreeMap::new();
    let mut public_tokens = BTreeMap::new();
    for (id, tok) in &state.data.tokens {
        if !visible_ids.contains(id) {
            continue;
        }
        if is_gm || tok.owner_user_id == Some(recipient_user_id) {
            tokens.insert(*id, tok.clone());
        } else {
            public_tokens.insert(*id, PublicTokenView::from(tok));
        }
    }

    let walls: Vec<WallSegment> = if is_gm {
        state.data.walls.clone()
    } else {
        state.data.walls.iter().map(mask_wall_for_player).collect()
    };

    let initiative_order: Vec<Uuid> = state
        .data
        .initiative_order
        .iter()
        .filter(|id| is_gm || visible_ids.contains(id))
        .copied()
        .collect();
    let active_turn_index = recipient_active_turn_index(state, &initiative_order);

    let persistent_aoes = if is_gm {
        state.data.persistent_aoes.clone()
    } else {
        state
            .data
            .persistent_aoes
            .iter()
            .map(|(id, aoe)| (*id, mask_aoe_caster(aoe, &visible_ids)))
            .collect()
    };

    let active_reaction_prompts = if is_gm {
        state.data.active_reaction_prompts.clone()
    } else {
        state
            .data
            .active_reaction_prompts
            .iter()
            .filter(|(_, p)| prompt_concerns_recipient(state, p, recipient_user_id))
            .map(|(id, p)| (*id, redact_prompt_for_player(p, &visible_ids)))
            .collect()
    };

    ProjectedTableState {
        campaign_id,
        mode: state.data.mode,
        exploration_paused: state.data.exploration_paused,
        ambient_lighting: state.data.ambient_lighting,
        cell_size_px: state.cell_size_px,
        feet_per_cell: state.feet_per_cell,
        tokens,
        public_tokens,
        walls,
        persistent_aoes,
        initiative_order,
        active_turn_index,
        round: state.data.round,
        lights: state.data.lights.clone(),
        fog_overrides: state.data.fog_overrides.clone(),
        background_asset_hash: state.data.background_asset_hash.clone(),
        map_width_px: state.data.map_width_px,
        map_height_px: state.data.map_height_px,
        active_reaction_prompts,
        mcp_staging_proposals: if is_gm {
            state.data.mcp_staging_proposals.clone()
        } else {
            BTreeMap::new()
        },
    }
}

/// Filters and redacts `TrameEvent` notifications for a non-GM recipient (GMs get everything):
/// - Vitality events (`DamageApplied`, `TokenResourcesOverridden`) and full `TokenSpawned`
///   payloads reach only the token's controller; others learn the outcome through the
///   `PublicTokenView` in the accompanying state projection.
/// - Movement, squeeze, visibility, and ownership events require the token to be visible.
/// - Secret door / illusion geometry in `DoorToggled`, `DoorConfigured`, and `WallAdded` is
///   masked; closing a secret door is dropped entirely.
/// - `AoeProjected` keeps only visible affected tokens and hides invisible casters.
/// - Turn events clear `active_turn_token_id` when the active combatant is hidden.
/// - Reaction prompt events (`ReactionPromptOpened`, `ReactionDecided`,
///   `ReactionPromptClosed`) reach only the prompt's reactor owner and the controllers of the
///   reactor and trigger tokens. Decided and closed prompts are usually gone from `state`, so
///   the predicate is evaluated against `prior_prompts` (the prompts open before the command).
/// - `AoeCleared` drops the caster ID when the caster is hidden from the recipient.
/// - MCP staging and undo descriptions are GM-only.
pub fn filter_events_for_recipient(
    state: &TableState,
    prior_prompts: &BTreeMap<Uuid, ReactionPrompt>,
    events: &[TrameEvent],
    recipient_user_id: Uuid,
    recipient_role: CampaignRole,
) -> Vec<TrameEvent> {
    if recipient_role == CampaignRole::Gm {
        return events.to_vec();
    }

    let visible_ids = visible_token_ids_for_recipient(state, recipient_user_id, recipient_role);
    let visible_turn = |active: &Option<Uuid>| active.filter(|id| visible_ids.contains(id));
    let wall_kind = |wall_id: &Uuid| {
        state
            .data
            .walls
            .iter()
            .find(|w| w.id == *wall_id)
            .map(|w| w.kind.clone())
    };

    events
        .iter()
        .filter_map(|ev| match ev {
            TrameEvent::DamageApplied { token_id, .. }
            | TrameEvent::TokenResourcesOverridden { token_id, .. } => {
                recipient_controls(state, token_id, recipient_user_id).then(|| ev.clone())
            }
            TrameEvent::TokenSpawned { token } => {
                (token.owner_user_id == Some(recipient_user_id)).then(|| ev.clone())
            }
            TrameEvent::TokenMoved { token_id, .. }
            | TrameEvent::TokenSqueezeToggled { token_id, .. }
            | TrameEvent::TokenVisibilityChanged { token_id, .. }
            | TrameEvent::TokenOwnerAssigned { token_id, .. }
            | TrameEvent::ActionRefunded { token_id, .. } => {
                visible_ids.contains(token_id).then(|| ev.clone())
            }
            TrameEvent::TokenHealed { token_id, .. } => {
                recipient_controls(state, token_id, recipient_user_id).then(|| ev.clone())
            }
            TrameEvent::ReactionPromptOpened { prompt } => {
                prompt_concerns_recipient(state, prompt, recipient_user_id).then(|| {
                    TrameEvent::ReactionPromptOpened {
                        prompt: redact_prompt_for_player(prompt, &visible_ids),
                    }
                })
            }
            TrameEvent::ReactionDecided { prompt_id, .. }
            | TrameEvent::ReactionPromptClosed { prompt_id, .. } => prior_prompts
                .get(prompt_id)
                .or_else(|| state.data.active_reaction_prompts.get(prompt_id))
                .is_some_and(|p| prompt_concerns_recipient(state, p, recipient_user_id))
                .then(|| ev.clone()),
            TrameEvent::SceneActivated { .. } | TrameEvent::InitiativeUpdated { .. } => None,
            TrameEvent::AoeCleared {
                aoe_id,
                caster_token_id,
            } => Some(TrameEvent::AoeCleared {
                aoe_id: *aoe_id,
                caster_token_id: caster_token_id.filter(|id| visible_ids.contains(id)),
            }),
            TrameEvent::HandoutRevealed { .. } => Some(ev.clone()),
            TrameEvent::ConcentrationBroken {
                caster_token_id, ..
            } => visible_ids.contains(caster_token_id).then(|| ev.clone()),
            TrameEvent::DoorToggled { wall_id, .. } => match wall_kind(wall_id) {
                Some(WallKind::SecretDoor { is_open: false }) | Some(WallKind::Illusion { .. }) => {
                    None
                }
                _ => Some(ev.clone()),
            },
            TrameEvent::DoorConfigured { wall_id, kind } => {
                let masked = match kind {
                    WallKind::SecretDoor { is_open: false } | WallKind::Illusion { .. } => {
                        WallKind::Normal
                    }
                    other => other.clone(),
                };
                Some(TrameEvent::DoorConfigured {
                    wall_id: *wall_id,
                    kind: masked,
                })
            }
            TrameEvent::WallAdded { wall } => Some(TrameEvent::WallAdded {
                wall: mask_wall_for_player(wall),
            }),
            TrameEvent::AoeProjected {
                template,
                affected_cells,
                affected_token_ids,
                persisted,
            } => Some(TrameEvent::AoeProjected {
                template: mask_aoe_caster(template, &visible_ids),
                affected_cells: affected_cells.clone(),
                affected_token_ids: affected_token_ids
                    .iter()
                    .filter(|id| visible_ids.contains(id))
                    .copied()
                    .collect(),
                persisted: *persisted,
            }),
            TrameEvent::TableModeChanged {
                mode,
                exploration_paused,
                active_turn_token_id,
                round,
            } => Some(TrameEvent::TableModeChanged {
                mode: *mode,
                exploration_paused: *exploration_paused,
                active_turn_token_id: visible_turn(active_turn_token_id),
                round: *round,
            }),
            TrameEvent::TurnAdvanced {
                active_turn_token_id,
                round,
            } => Some(TrameEvent::TurnAdvanced {
                active_turn_token_id: visible_turn(active_turn_token_id),
                round: *round,
            }),
            TrameEvent::McpStagingCommitted { .. }
            | TrameEvent::McpStagingRejected { .. }
            | TrameEvent::ActionUndone { .. } => None,
            TrameEvent::AmbientLightingChanged { .. }
            | TrameEvent::SceneLoaded { .. }
            | TrameEvent::TokenRemoved { .. }
            | TrameEvent::LightAdded { .. }
            | TrameEvent::FogOverrideChanged { .. }
            | TrameEvent::MapConfigChanged { .. } => Some(ev.clone()),
        })
        .collect()
}
