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
//!   5. `Shared Combat Tracker`:
//!      - Initiative order and totals are shared table knowledge: players receive
//!        them in `InitiativeUpdated` and in the snapshot's `initiative_totals`,
//!        both limited to combatants in `visible_ids`, so GM-hidden or occluded
//!        tokens contribute neither an entry nor a total.
//!   6. `Controller-Only, Visibility-Gated Events (RT4, RT6, RT8)`:
//!      - HP (`DamageApplied`, `TokenHealed`, `TokenResourcesOverridden`), action
//!        economy (`ActionRefunded`) and full `TokenSpawned` payloads reach the
//!        controller of a token they can see; other players get the
//!        `BloodiedState` of the projection. `speed_remaining_ft` in `TokenMoved`
//!        / `TokenSqueezeToggled` is `0.0` for non-controllers.
//!      - Condition rulings follow the same rule: raw `conditions`
//!        (`TokenConditionsChanged`) and `overrides` (`ConditionOverrideChanged`)
//!        reach the controller of a visible token only, everyone else sees the
//!        effective list. `DeathSaveRecorded` keeps its counters for the
//!        controller only; others get the d20 and the Stable / dead flags.
//!      - The GM's `stat_block` copy never leaves the server for a non-GM: it is
//!        stripped from controlled tokens in snapshots and in `TokenSpawned`.
//!      - `TokenRemoved` reaches only players who could see the token before the
//!        command (line of sight in the pre-command state), and a token moving
//!        into view never reveals where it came from.
//!   7. `Reaction Prompt Audience (RT8)`:
//!      - One rule for snapshot prompts and prompt events: the GM, the reactor's
//!        owner, and the reactor token's controller. The trigger's controller is
//!        excluded, so a mover never learns which hidden creature may react;
//!        other reactors (`resolved_reactor_ids`) and a hidden mover's
//!        destination are redacted.
//!   8. `Pending Resolutions & Concentration Checks (D6, story 58)`:
//!      - A `PendingResolution` (snapshot and `ActionResolved`) reaches the GM
//!        and its issuer only. For the issuer, every target they do not
//!        control loses its natural d20s and total: hit / miss / critical or
//!        save success / failure and the damage remain, never a number that
//!        bounds AC or a save bonus. `ResolutionApplied` / `Dismissed` follow
//!        the same audience.
//!      - Concentration checks (state, `ConcentrationCheckRequested`,
//!        `ConcentrationCheckRolled`) reach the token's controller only.
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
use trame_engine::aoe::{AoeTemplate, GridCell};
pub use trame_engine::commands::McpStagingProposal;
use trame_engine::commands::{
    AmbientLightingPreset, CampaignRole, FogOverrideCell, LightSource, ReactionPrompt, TableMode,
    TableState, TokenState, TrameCommand, TrameEvent,
};
use trame_engine::geometry::{
    CHANNEL_GM_HIDDEN, Point2D, WallKind, WallSegment, can_token_see_target,
};
use trame_engine::resolution::PendingResolution;
use uuid::Uuid;

/// A submitted `TrameCommand` plus the client's correlation id (RT10).
///
/// Wire shape: the command's own map (`{"cmd": "MOVE_TOKEN", ...}`) with an optional extra
/// `correlation_id` key, so clients that do not send one keep working unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandSubmission {
    /// Tabletop mutation to apply.
    #[serde(flatten)]
    pub command: TrameCommand,
    /// Opaque client token echoed in `ServerEnvelope::CommandRejected` (`None` when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

impl From<TrameCommand> for CommandSubmission {
    fn from(command: TrameCommand) -> Self {
        Self {
            command,
            correlation_id: None,
        }
    }
}

/// Inbound binary MessagePack payload sent from a connected client to the room actor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientEnvelope {
    /// Submits an authoritative tabletop mutation command (`MoveToken`, `ToggleDoor`, `ApplyDamage`, etc.).
    SubmitCommand(Box<CommandSubmission>),
    /// Requests an authoritative CSPRNG dice roll evaluated by the room's `SeededDiceRoller`.
    RollDice {
        /// Standard dice notation string (e.g., `"2d20kh1+5"`).
        expression: String,
        /// Privacy scope (`Public`, `GmOnly`, or `BlindGm`).
        visibility: RollVisibility,
        /// Action label or skill name associated with the roll.
        reason: String,
        /// Opaque client token echoed in `ServerEnvelope::CommandRejected` (`None` when omitted).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        correlation_id: Option<String>,
    },
    /// Broadcasts a transient Ephemeral Pointer ping onto the shared map canvas. The room
    /// drops it unless `pos` is finite and on the map, `color_hex` is a palette color, and
    /// `scene_id` (when sent) is the active scene; at most one ping per
    /// `POINTER_PING_MIN_INTERVAL_MS` per session is broadcast (RT2).
    PointerPing {
        /// Canvas coordinate of the pointer ping in pixels (`px`), within
        /// `0..=map_width_px` x `0..=map_height_px`.
        pos: Point2D,
        /// `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or an ATLAS token (`var(--atlas-info)`), at most
        /// `MAX_POINTER_PING_COLOR_LEN` bytes.
        color_hex: String,
        /// Scene the ping was aimed at (`ProjectedTableState::active_scene_id`); omitted by
        /// older clients, which skips the check.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scene_id: Option<Uuid>,
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
    /// Initiative totals keyed by token ID, limited to the entries of `initiative_order`
    /// (a hidden combatant's total never reaches a player). Lets a reconnecting client
    /// rebuild the combat tracker without replaying `InitiativeUpdated` events.
    #[serde(default)]
    pub initiative_totals: BTreeMap<Uuid, i32>,
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
    /// (G2). Non-GM recipients only receive the prompts of reactors they own or control (not
    /// the prompts their own movement triggered), without `resolved_reactor_ids` and without
    /// hidden movers' `pending_destination`.
    #[serde(default)]
    pub active_reaction_prompts: BTreeMap<Uuid, ReactionPrompt>,
    /// Scene shown on the table (`None` before the first scene); clients echo it in
    /// `PointerPing.scene_id`.
    #[serde(default)]
    pub active_scene_id: Option<Uuid>,
    /// Difficult-terrain grid cells of the active map (public map knowledge: every recipient
    /// gets the whole set), so clients draw them and preview movement cost.
    #[serde(default)]
    pub difficult_terrain: Vec<GridCell>,
    /// Queued MCP dry-run staging proposals keyed by `proposal_id` (included only for `Gm` recipients).
    #[serde(default)]
    pub mcp_staging_proposals: BTreeMap<Uuid, McpStagingProposal>,
    /// Server-rolled actions waiting for their Apply: every one for GMs; for other recipients
    /// only those they issued, redacted by `redact_resolution` (invariant 8).
    #[serde(default)]
    pub pending_resolutions: BTreeMap<Uuid, PendingResolution>,
    /// Open Concentration check DCs (oldest first) keyed by token: every token for GMs, the
    /// tokens the recipient controls otherwise.
    #[serde(default)]
    pub pending_concentration_checks: BTreeMap<Uuid, Vec<i32>>,
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
    /// Effective condition ids (`TokenState::effective_conditions`: GM rulings applied, the
    /// rulings themselves withheld).
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
            conditions: t.effective_conditions(),
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
    /// Unicast to the submitting client when a `TrameCommand` or dice roll fails validation,
    /// RBAC, or persistence, or when a frame cannot be decoded (RT10).
    CommandRejected {
        /// Human-readable rejection reason (never a raw storage error).
        reason: String,
        /// The `correlation_id` the client sent with the rejected envelope; `None` when the
        /// client sent none or the frame could not be decoded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        correlation_id: Option<String>,
    },
    /// Unicast to each Game Master who connects while the room actor that quarantined WAL
    /// entries during recovery is alive (D4); the frontend shows it as a banner.
    WalEntriesQuarantined {
        /// One summary per quarantined entry, in `seq_id` order.
        entries: Vec<QuarantinedWalSummary>,
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

/// Game Master-facing summary of a `QuarantinedWalEntry` (no command payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuarantinedWalSummary {
    /// Original WAL sequence number.
    pub seq_id: u64,
    /// Command label, e.g. `"UNDO_LAST_ACTION"`, `"MOVE_TOKEN"`, or `"MCP_STAGING"`.
    pub command_kind: String,
    /// Replay error, or a note naming the failing `seq_id` for later entries.
    pub error: String,
    /// Unix epoch timestamp in milliseconds (`ms`) when the entry was quarantined.
    pub quarantined_at_ms: u64,
}

impl From<&crate::wal::QuarantinedWalEntry> for QuarantinedWalSummary {
    fn from(entry: &crate::wal::QuarantinedWalEntry) -> Self {
        Self {
            seq_id: entry.seq_id,
            command_kind: entry.command_kind.clone(),
            error: entry.error.clone(),
            quarantined_at_ms: entry.quarantined_at_ms,
        }
    }
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

/// Full `TokenState` as sent to its non-GM controller: everything but the GM's `stat_block`
/// copy (attack bonuses, save DCs, legendary actions and homebrew notes stay GM knowledge
/// even when the GM hands the token to a player).
fn controller_token_view(token: &TokenState) -> TokenState {
    let mut view = token.clone();
    view.stat_block = None;
    view
}

/// Returns `true` when `recipient_user_id` controls `token_id` (`owner_user_id` match).
fn recipient_controls(state: &TableState, token_id: &Uuid, recipient_user_id: Uuid) -> bool {
    state
        .data
        .tokens
        .get(token_id)
        .is_some_and(|t| t.owner_user_id == Some(recipient_user_id))
}

/// Non-GM audience of a reaction prompt, shared by the snapshot and the prompt events: the
/// reactor's owner and the controller of the reactor token. The trigger's controller is not
/// part of it, so a mover never learns which hidden creature is about to react.
fn prompt_concerns_recipient(
    state: &TableState,
    prompt: &ReactionPrompt,
    recipient_user_id: Uuid,
) -> bool {
    prompt.reactor_owner_user_id == Some(recipient_user_id)
        || recipient_controls(state, &prompt.reactor_actor_id, recipient_user_id)
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

/// Issuer view of a resolution (invariant 8): targets the recipient does not control keep
/// their outcome and damage but lose their natural d20s and total.
pub fn redact_resolution(
    state: &TableState,
    resolution: &PendingResolution,
    recipient_user_id: Uuid,
) -> PendingResolution {
    let mut redacted = resolution.clone();
    for target in &mut redacted.targets {
        if !recipient_controls(state, &target.token_id, recipient_user_id) {
            target.d20_rolls.clear();
            target.total = None;
        }
    }
    redacted
}

/// Issuer of the resolution `id` before or after the command (it leaves the table once
/// fully applied or dismissed).
fn resolution_issuer(state: &TableState, prior: &TableState, id: &Uuid) -> Option<Uuid> {
    prior
        .data
        .pending_resolutions
        .get(id)
        .or_else(|| state.data.pending_resolutions.get(id))
        .map(|r| r.issuer_user_id)
}

/// Initiative totals of the combatants the recipient can see.
fn visible_totals(
    totals: &BTreeMap<Uuid, i32>,
    visible_ids: &HashSet<Uuid>,
) -> BTreeMap<Uuid, i32> {
    totals
        .iter()
        .filter(|(id, _)| visible_ids.contains(id))
        .map(|(id, total)| (*id, *total))
        .collect()
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
        if is_gm {
            tokens.insert(*id, tok.clone());
        } else if tok.owner_user_id == Some(recipient_user_id) {
            tokens.insert(*id, controller_token_view(tok));
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
    let initiative_totals = if is_gm {
        state.data.initiative_totals.clone()
    } else {
        visible_totals(&state.data.initiative_totals, &visible_ids)
    };

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
        initiative_totals,
        active_turn_index,
        round: state.data.round,
        lights: state.data.lights.clone(),
        fog_overrides: state.data.fog_overrides.clone(),
        background_asset_hash: state.data.background_asset_hash.clone(),
        map_width_px: state.data.map_width_px,
        map_height_px: state.data.map_height_px,
        active_reaction_prompts,
        active_scene_id: state.data.active_scene_id,
        difficult_terrain: state.data.difficult_terrain.iter().copied().collect(),
        mcp_staging_proposals: if is_gm {
            state.data.mcp_staging_proposals.clone()
        } else {
            BTreeMap::new()
        },
        pending_resolutions: if is_gm {
            state.data.pending_resolutions.clone()
        } else {
            state
                .data
                .pending_resolutions
                .iter()
                .filter(|(_, r)| r.issuer_user_id == recipient_user_id)
                .map(|(id, r)| (*id, redact_resolution(state, r, recipient_user_id)))
                .collect()
        },
        pending_concentration_checks: state
            .data
            .pending_concentration_checks
            .iter()
            .filter(|(id, _)| is_gm || recipient_controls(state, id, recipient_user_id))
            .map(|(id, dcs)| (*id, dcs.clone()))
            .collect(),
    }
}

/// Filters and redacts `TrameEvent` notifications for a non-GM recipient (GMs get everything).
/// `state` is the table after the command, `prior` the table before it (RT4, RT6, RT8):
/// - Controller-only events (`DamageApplied`, `TokenHealed`, `TokenResourcesOverridden`,
///   `ActionRefunded`, full `TokenSpawned` payloads) reach the token's controller, and only
///   while the token is visible to them. Everyone else learns the outcome through the
///   `PublicTokenView` (`BloodiedState`, never HP) of the accompanying state projection.
/// - Movement, squeeze, disengage, conditions, visibility, and ownership events require the
///   token to be visible. `TokenMoved` and `TokenSqueezeToggled` carry `speed_remaining_ft`
///   for the controller only (`0.0` for others), and a token that comes into view hides
///   where it came from (`from_top_left` is its destination).
/// - `TokenRemoved` reaches recipients who could see the token before the command.
/// - `ConditionOverrideChanged` keeps its rulings for the controller of a visible token only;
///   other recipients who see the token get it with `overrides` emptied.
/// - `TokenConditionsChanged` carries the raw `conditions` for the controller only; other
///   recipients get the effective list in both fields, so a hidden `Remove` ruling never
///   shows through the difference.
/// - `DeathSaveRecorded` is full for the controller only; other recipients get the d20 and
///   the Stable / dead flags, with the counters zeroed and `regains_hp` cleared.
/// - The GM's `stat_block` copy is stripped from the `TokenSpawned` a controller receives.
/// - Secret door / illusion geometry in `DoorToggled`, `DoorConfigured`, and `WallAdded` is
///   masked; closing a secret door is dropped entirely.
/// - `AoeProjected` keeps only visible affected tokens and hides invisible casters.
/// - Turn events clear `active_turn_token_id` when the active combatant is hidden.
/// - `InitiativeUpdated` keeps only visible combatants' order entries and totals.
/// - Reaction prompt events (`ReactionPromptOpened`, `ReactionDecided`,
///   `ReactionPromptClosed`) reach only the prompt's reactor owner and the reactor token's
///   controller, never the trigger's controller. Decided and closed prompts are usually gone
///   from `state`, so the predicate is evaluated against the prompts open in `prior`.
/// - `AoeCleared` drops the caster ID when the caster is hidden from the recipient.
/// - MCP staging and undo descriptions are GM-only.
pub fn filter_events_for_recipient(
    state: &TableState,
    prior: &TableState,
    events: &[TrameEvent],
    recipient_user_id: Uuid,
    recipient_role: CampaignRole,
) -> Vec<TrameEvent> {
    if recipient_role == CampaignRole::Gm {
        return events.to_vec();
    }

    let visible_ids = visible_token_ids_for_recipient(state, recipient_user_id, recipient_role);
    // Line of sight in `prior` is only computed when an event needs it.
    let prior_visible_ids = std::cell::OnceCell::new();
    let was_visible = |id: &Uuid| {
        prior_visible_ids
            .get_or_init(|| {
                visible_token_ids_for_recipient(prior, recipient_user_id, recipient_role)
            })
            .contains(id)
    };
    let controls_visible =
        |id: &Uuid| visible_ids.contains(id) && recipient_controls(state, id, recipient_user_id);
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
            | TrameEvent::TokenResourcesOverridden { token_id, .. }
            | TrameEvent::TokenHealed { token_id, .. }
            | TrameEvent::ActionRefunded { token_id, .. } => {
                controls_visible(token_id).then(|| ev.clone())
            }
            TrameEvent::TokenSpawned { token } => {
                controls_visible(&token.id).then(|| TrameEvent::TokenSpawned {
                    token: Box::new(controller_token_view(token)),
                })
            }
            TrameEvent::TokenMoved {
                token_id,
                from_top_left,
                to_top_left,
                elevation_ft,
                speed_remaining_ft,
            } => {
                if !visible_ids.contains(token_id) {
                    return None;
                }
                let controls = recipient_controls(state, token_id, recipient_user_id);
                Some(TrameEvent::TokenMoved {
                    token_id: *token_id,
                    from_top_left: if was_visible(token_id) {
                        *from_top_left
                    } else {
                        *to_top_left
                    },
                    to_top_left: *to_top_left,
                    elevation_ft: *elevation_ft,
                    speed_remaining_ft: if controls { *speed_remaining_ft } else { 0.0 },
                })
            }
            TrameEvent::TokenSqueezeToggled {
                token_id,
                is_squeezing,
                speed_remaining_ft,
            } => visible_ids.contains(token_id).then(|| {
                let controls = recipient_controls(state, token_id, recipient_user_id);
                TrameEvent::TokenSqueezeToggled {
                    token_id: *token_id,
                    is_squeezing: *is_squeezing,
                    speed_remaining_ft: if controls { *speed_remaining_ft } else { 0.0 },
                }
            }),
            TrameEvent::TokenDisengaged { token_id, .. }
            | TrameEvent::ConcentrationChanged { token_id, .. }
            | TrameEvent::TokenVisibilityChanged { token_id, .. }
            | TrameEvent::TokenOwnerAssigned { token_id, .. } => {
                visible_ids.contains(token_id).then(|| ev.clone())
            }
            TrameEvent::DeathSaveRecorded {
                token_id,
                d20,
                outcome,
            } => {
                if controls_visible(token_id) {
                    Some(ev.clone())
                } else {
                    visible_ids
                        .contains(token_id)
                        .then_some(TrameEvent::DeathSaveRecorded {
                            token_id: *token_id,
                            d20: *d20,
                            outcome: trame_engine::rules::DeathSaveOutcome {
                                successes: 0,
                                failures: 0,
                                regains_hp: false,
                                stable: outcome.stable,
                                dead: outcome.dead,
                            },
                        })
                }
            }
            TrameEvent::TokenConditionsChanged {
                token_id,
                effective_conditions,
                ..
            } => {
                if controls_visible(token_id) {
                    Some(ev.clone())
                } else {
                    visible_ids
                        .contains(token_id)
                        .then(|| TrameEvent::TokenConditionsChanged {
                            token_id: *token_id,
                            conditions: effective_conditions.clone(),
                            effective_conditions: effective_conditions.clone(),
                        })
                }
            }
            TrameEvent::TokenRemoved { token_id } => was_visible(token_id).then(|| ev.clone()),
            TrameEvent::ConditionOverrideChanged {
                token_id,
                effective_conditions,
                ..
            } => {
                if controls_visible(token_id) {
                    Some(ev.clone())
                } else {
                    visible_ids
                        .contains(token_id)
                        .then(|| TrameEvent::ConditionOverrideChanged {
                            token_id: *token_id,
                            overrides: Vec::new(),
                            effective_conditions: effective_conditions.clone(),
                        })
                }
            }
            TrameEvent::ReactionPromptOpened { prompt } => {
                prompt_concerns_recipient(state, prompt, recipient_user_id).then(|| {
                    TrameEvent::ReactionPromptOpened {
                        prompt: redact_prompt_for_player(prompt, &visible_ids),
                    }
                })
            }
            TrameEvent::ReactionDecided { prompt_id, .. }
            | TrameEvent::ReactionPromptClosed { prompt_id, .. } => prior
                .data
                .active_reaction_prompts
                .get(prompt_id)
                .or_else(|| state.data.active_reaction_prompts.get(prompt_id))
                .is_some_and(|p| prompt_concerns_recipient(state, p, recipient_user_id))
                .then(|| ev.clone()),
            TrameEvent::SceneActivated { .. } => None,
            TrameEvent::InitiativeUpdated {
                initiative_order,
                initiative_totals,
                active_turn_token_id,
            } => Some(TrameEvent::InitiativeUpdated {
                initiative_order: initiative_order
                    .iter()
                    .filter(|id| visible_ids.contains(id))
                    .copied()
                    .collect(),
                initiative_totals: visible_totals(initiative_totals, &visible_ids),
                active_turn_token_id: visible_turn(active_turn_token_id),
            }),
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
            TrameEvent::ActionResolved { resolution } => (resolution.issuer_user_id
                == recipient_user_id)
                .then(|| TrameEvent::ActionResolved {
                    resolution: Box::new(redact_resolution(state, resolution, recipient_user_id)),
                }),
            TrameEvent::ResolutionApplied { resolution_id, .. }
            | TrameEvent::ResolutionDismissed { resolution_id } => {
                (resolution_issuer(state, prior, resolution_id) == Some(recipient_user_id))
                    .then(|| ev.clone())
            }
            TrameEvent::ConcentrationCheckRequested { token_id, .. }
            | TrameEvent::ConcentrationCheckRolled { token_id, .. } => {
                controls_visible(token_id).then(|| ev.clone())
            }
            TrameEvent::McpStagingCommitted { .. }
            | TrameEvent::McpStagingRejected { .. }
            | TrameEvent::ActionUndone { .. } => None,
            TrameEvent::AmbientLightingChanged { .. }
            | TrameEvent::SceneLoaded { .. }
            | TrameEvent::LightAdded { .. }
            | TrameEvent::FogOverrideChanged { .. }
            | TrameEvent::DifficultTerrainChanged { .. }
            | TrameEvent::MapConfigChanged { .. } => Some(ev.clone()),
        })
        .collect()
}
