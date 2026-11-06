//! ============================================================================
//! CQRS COMMAND REDUCER, RBAC ENFORCEMENT & UNDO RING BUFFER (commands.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Defines the authoritative Command Query Responsibility Segregation (CQRS)
//! state machine (`TableState`), incoming client mutations (`TrameCommand`),
//! resulting domain events (`TrameEvent`), and bounded 50-entry compensating
//! snapshot ring buffer (`UndoEntry`). All tabletop state mutations flow
//! exclusively through `TableState::apply_command`, guaranteeing deterministic
//! role-based access control (RBAC), wall collision checks, turn movement
//! budgets, concentration lifecycle management, and single-click GM undo.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Fail-Closed Role-Based Access Control (RBAC)`:
//!      - `Spectator` actors are rejected (`CommandError::PermissionDenied`)
//!        before any state mutation or undo snapshot occurs.
//!      - `Player` actors can only move, squeeze, or break concentration on
//!        tokens where `token.owner_user_id == Some(actor.user_id)`, cannot
//!        open locked or secret doors, and cannot move when exploration is
//!        paused or outside their active turn in `TableMode::TurnByTurn`.
//!   2. `Atomic Pre-Mutation Undo Ring Buffer`:
//!      - `push_undo` captures a full `TableSnapshotData` clone *only after*
//!        all RBAC, BVH collision, and movement budget checks succeed, capped
//!        at `MAX_UNDO_HISTORY = 50` entries (`VecDeque::pop_front`) to bound
//!        per-room memory usage.
//!   3. `Automatic Concentration Cleanup`:
//!      - Casting a new persistent concentration AoE automatically removes the
//!        caster's previous concentration zone, and dropping to `0` HP via
//!        `ApplyDamage` immediately terminates active concentration and emits
//!        `TrameEvent::ConcentrationBroken`.
//!   4. `BVH Synchronization`:
//!      - Any mutation that alters wall permeability (`ToggleDoor`,
//!        `UndoLastAction`, `LoadScene`, `ActivateScene`) immediately rebuilds
//!        `self.bvh` so subsequent raycasts and collision queries reflect the
//!        updated geometry.
//!   5. `ThreatReach Opportunity Prompts (Turn-by-Turn only)`:
//!      - A non-teleport `MoveToken` whose straight path leaves the `reach_ft`
//!        of a hostile token that still has its reaction, is not GM-hidden or
//!        incapacitated, and can see the mover stops on the exit square and
//!        opens a `ReactionPrompt` addressed to the reactor's owner (`None` =
//!        GM). There is no timer. Until the prompt is decided, players cannot
//!        move the interrupted token.
//!      - `prompt_id` is a SHA-256-derived UUIDv8 over mover, reactor, round,
//!        and `reaction_prompt_seq`: players who see the mover cannot recover
//!        a hidden reactor's ID, and WAL replay reproduces the same IDs.
//!      - `UndoLastAction` emits `ReactionPromptOpened` / `ReactionPromptClosed
//!        { Undone }` for every prompt the restored snapshot adds, changes, or
//!        drops, so event-driven clients stay in sync with state.
//!      - Hostility is side-based: a `HeroToken` (`owner_user_id.is_some()`)
//!        and a GM-controlled token (`owner_user_id.is_none()`) are hostile.
//!      - A mover with `disengaged` set (Disengage action) opens no prompt;
//!        every turn start and `EndTurnByTurn` clear the flag on all tokens.
//!      - `Pass` (including a GM-forced `Pass`) resumes the remaining move,
//!        re-checking walls, budget, and the other reactors' reach. `Trigger`
//!        spends the reaction and leaves the token on the exit square; once the
//!        attack is resolved, `ResolveReaction` resumes the remaining move.
//!   6. `Validate-Then-Snapshot Reactions`:
//!      - `DecideReaction` verifies that the prompt exists, that `actor_id`
//!        is its reactor, that the issuer owns the reactor (GM may force), and
//!        that `Trigger` still has a reaction available, all before pushing
//!        an `UndoEntry`.
//!   7. `All-or-Nothing Batches`:
//!      - `apply_batch` and `CommitMcpStaging` run sub-commands against the
//!        live state; on the first failure the table data, `Bvh2D`, grid size,
//!        and undo stack are restored exactly and the error carries the failing
//!        index. On success the sub-commands' own undo entries are discarded in
//!        favor of one composite `UndoEntry`.
//!   8. `Conditions and Game Master Rulings`:
//!      - `SetTokenConditions` follows token control (GM: any token; player:
//!        owned tokens); `ConditionOverride` is GM-only. Both validate ids
//!        (`1..=64` bytes, at most 32 per token) before pushing an `UndoEntry`.
//!      - `TokenState::effective_conditions` applies the rulings (`Remove`
//!        wins over the token's own conditions, `Force` adds); engine checks
//!        such as Incapacitated read effective conditions only.
//!   9. `Shared Movement Pricing`:
//!      - `MoveToken` budgets, `preview_move`, and the `previewMove` WASM export
//!        all price moves with `MovementGrid::movement_cost_ft` (Chebyshev
//!        squares, `difficult_terrain` doubled), so previews never disagree
//!        with server validation.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `TableState::apply_command(actor, cmd)`
//!     ├── 1. Verify actor role (`require_gm` / `require_token_control`).
//!     ├── 2. Validate spatial & turn invariants (BVH collision, speed budget, door locks).
//!     ├── 3. Push pre-mutation `UndoEntry` onto `undo_stack` (bounded to 50).
//!     ├── 4. Mutate `self.data` (and rebuild `self.bvh` if walls changed).
//!     └── 5. Return emitted `Vec<TrameEvent>` for WAL persistence and client broadcast.
//!
//!   `TableState::apply_batch(actor, commands, description)`
//!     ├── 1. Reject empty batches and nested undo/staging commands.
//!     ├── 2. Snapshot data, `Bvh2D`, grid size; detach the undo stack.
//!     ├── 3. `apply_command` each sub-command; on error restore and return `BatchCommandFailed`.
//!     └── 4. Reattach the undo stack and push one composite `UndoEntry`.
//! ============================================================================

use crate::aoe::{AoeTemplate, GridCell, TokenSpatialRef};
pub use crate::geometry::Point2D;
use crate::geometry::{
    Bvh2D, CHANNEL_ETHEREAL, CHANNEL_GM_HIDDEN, CHANNEL_MATERIAL, SenseProfile, WallKind,
    WallSegment, can_token_see_target, segment_intersection, segment_intersects_segment,
};
use crate::movement::MovementGrid;
use crate::rules::{ActiveEffect, DamageAffinity, DamageResolution, resolve_damage_application};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use thiserror::Error;
use uuid::Uuid;

/// Maximum number of compensating state snapshots retained in `TableState::undo_stack` (`50` entries).
pub const MAX_UNDO_HISTORY: usize = 50;

fn default_bright_radius_ft() -> f64 {
    20.0
}

fn default_dim_radius_ft() -> f64 {
    40.0
}

fn default_light_color_hex() -> String {
    "#FFAA44".to_string()
}

fn default_light_intensity() -> f64 {
    1.0
}

fn default_map_dimension_px() -> u32 {
    2000
}

/// Dynamic 2.5D point light source placed on the tabletop scene (`01-TABLE-SPEC.md`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct LightSource {
    /// Unique identifier of the light source emitter.
    pub id: Uuid,
    /// 2D canvas coordinate of the light emitter in pixels (`px`).
    #[serde(alias = "origin")]
    pub position: Point2D,
    /// Vertical height of the light emitter in feet (`ft`) relative to table zero.
    #[serde(default)]
    pub elevation_ft: f64,
    /// Inner bright-light radius in feet (`ft`, default `20.0`).
    #[serde(default = "default_bright_radius_ft", alias = "bright_radius_px")]
    pub bright_radius_ft: f64,
    /// Outer dim-light falloff radius in feet (`ft`, default `40.0`).
    #[serde(
        default = "default_dim_radius_ft",
        alias = "radius_ft",
        alias = "dim_radius_px"
    )]
    pub dim_radius_ft: f64,
    /// Hexadecimal RGB color string (e.g., `"#FFAA44"`).
    #[serde(default = "default_light_color_hex")]
    pub color_hex: String,
    /// Normalized luminous intensity in `0.0..=1.0` (default `1.0`).
    #[serde(default = "default_light_intensity")]
    pub intensity: f64,
}

/// Manual Game Master fog-of-war brush operation mode applied to a discrete grid cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FogOverrideMode {
    /// Forces the grid cell to remain revealed to players regardless of dynamic line-of-sight.
    #[serde(alias = "Reveal", alias = "reveal")]
    Reveal,
    /// Forces the grid cell to remain shrouded in fog regardless of dynamic line-of-sight.
    #[serde(alias = "Hide", alias = "hide")]
    Hide,
    /// Clears any manual GM override on the grid cell, returning it to dynamic BVH line-of-sight.
    #[serde(alias = "Clear", alias = "clear")]
    Clear,
}

/// Discrete grid cell coordinate and manual GM fog-of-war override state stored in `TableState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct FogOverrideCell {
    /// Discrete horizontal grid column index (`cell_x`).
    pub cell_x: i32,
    /// Discrete vertical grid row index (`cell_y`).
    pub cell_y: i32,
    /// Active manual override mode (`Reveal` or `Hide`).
    pub mode: FogOverrideMode,
}

/// Player or GM decision in response to a tactical reaction prompt (e.g., Opportunity Attack, Shield).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "decision", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReactionDecision {
    /// Triggers and consumes the reaction, optionally specifying the ability or spell identifier.
    #[serde(alias = "Trigger", alias = "trigger")]
    Trigger {
        /// Optional ability or spell identifier used for the reaction (e.g., `"opportunity_attack"`).
        #[serde(default)]
        ability_id: Option<String>,
    },
    /// Declines to spend the reaction, allowing the interrupted movement or action to resume.
    #[serde(alias = "Pass", alias = "pass")]
    Pass,
}

/// Active tactical reaction window awaiting a `DecideReaction` command from the reacting
/// token's owner or the GM. Prompts never expire on a timer (G2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ReactionPrompt {
    /// Unique identifier of this reaction prompt.
    pub prompt_id: Uuid,
    /// Token UUID eligible to spend its reaction (`has_reaction == true`).
    pub reactor_actor_id: Uuid,
    /// Token UUID whose movement or action triggered the reaction window.
    pub trigger_token_id: Uuid,
    /// Optional destination top-left coordinate in pixels (`px`) to resume if the reactor passes.
    #[serde(default)]
    pub pending_destination: Option<Point2D>,
    /// Optional destination elevation in feet (`ft`) to resume if the reactor passes.
    #[serde(default)]
    pub pending_elevation_ft: Option<f64>,
    /// User who must decide the prompt: the reactor token's owner, or `None` for the GM.
    #[serde(default)]
    pub reactor_owner_user_id: Option<Uuid>,
    /// Reactors already prompted during this movement, so resuming does not prompt them again.
    #[serde(default)]
    pub resolved_reactor_ids: Vec<Uuid>,
    /// `true` once the reactor chose `Trigger`: the reaction is being played out and the
    /// interrupted movement resumes only on `ResolveReaction`. `false` while awaiting the
    /// `DecideReaction` choice.
    #[serde(default)]
    pub awaiting_resolution: bool,
}

/// Why a `ReactionPrompt` left `active_reaction_prompts` without a `DecideReaction` `Pass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReactionPromptCloseReason {
    /// The triggered reaction was played out (`ResolveReaction`); movement may have resumed.
    Resolved,
    /// The prompt no longer applies: combat ended, the trigger or reactor token was removed,
    /// or the GM moved the trigger token.
    Stale,
    /// `UndoLastAction` restored a state in which the prompt does not exist.
    Undone,
}

/// Result of `TableState::preview_move`, serialized as `{ "collision": {x, y} | null, "costFt" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct MovePreview {
    /// First movement-blocking wall crossing in pixels (`px`) between the token centers, or
    /// `None` when the straight path is clear.
    pub collision: Option<Point2D>,
    /// Movement cost in feet (`ft`) from `MovementGrid::movement_cost_ft`: Chebyshev squares
    /// (diagonals cost 5 ft), difficult squares doubled, elevation as a third axis, doubled
    /// while squeezing.
    pub cost_ft: f64,
}

/// Fully resolved scene payload consumed by `TrameCommand::ActivateScene`.
///
/// Clients send `ActivateScene { scene_id }` only; the server resolves the persisted scene
/// into this payload before applying, so WAL replays stay deterministic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SceneActivation {
    /// Asset store key or SHA-256 hash of the background battlemap (`None` = no background).
    #[serde(default)]
    pub map_asset_id: Option<String>,
    /// Battlemap canvas width in pixels (`px`, `> 0`).
    pub width_px: u32,
    /// Battlemap canvas height in pixels (`px`, `> 0`).
    pub height_px: u32,
    /// Grid cell width/height in pixels (`px`, `> 0.0`).
    pub pixels_per_grid: f64,
    /// Wall and portal geometry replacing the current scene walls.
    #[serde(default)]
    pub walls: Vec<WallSegment>,
    /// Point light sources replacing the current scene lights.
    #[serde(default)]
    pub lights: Vec<LightSource>,
    /// `StagedToken`s instantiated as live tokens; IDs must not collide with kept `HeroToken`s.
    #[serde(default)]
    pub staged_tokens: Vec<TokenState>,
    /// Top-left spawn coordinates in pixels (`px`) assigned to `HeroToken`s in token-ID order;
    /// heroes beyond the list keep their current position.
    #[serde(default)]
    pub hero_spawn_points: Vec<Point2D>,
}

/// Action-economy resource restored by `TrameCommand::RefundAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RefundableResource {
    /// Restores the primary Action (`has_action = true`).
    Action,
    /// Restores the Bonus Action (`has_bonus_action = true`).
    BonusAction,
    /// Restores the Reaction (`has_reaction = true`).
    Reaction,
    /// Restores the full turn movement budget (`speed_remaining_ft = speed_max_ft`).
    Movement,
}

/// Queued MCP dry-run staging batch awaiting explicit GM confirmation (`CommitMcpStaging`) or rejection (`RejectMcpStaging`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpStagingProposal {
    /// Unique identifier of the staged MCP proposal.
    pub proposal_id: Uuid,
    /// Human-readable summary of the proposed batch of tabletop commands.
    pub summary: String,
    /// Ordered sequence of `TrameCommand` mutations to execute atomically if committed.
    pub commands: Vec<TrameCommand>,
}

/// Operating mode of the active tabletop session (`01-TABLE-SPEC.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TableMode {
    /// Free-form exploration where owned tokens move without initiative order unless `exploration_paused` is set.
    Exploration,
    /// Structured tactical combat enforcing `initiative_order`, `active_turn_index`, and per-turn `speed_remaining_ft`.
    TurnByTurn,
}

/// Global ambient illumination preset applied to the tabletop scene.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AmbientLightingPreset {
    /// Full bright daylight across unoccluded areas.
    Daylight,
    /// Twilight/dusk dim lighting.
    Dusk,
    /// Outdoor nighttime moonlight (dim illumination).
    NightMoonlight,
    /// Total darkness requiring darkvision, devil's sight, or local light sources.
    PitchDarkness,
}

/// Campaign-scoped authorization role assigned to a connected user session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CampaignRole {
    /// Game Master with full authority over all tokens, secret doors, table modes, lighting, and undo history.
    Gm,
    /// Standard player permitted to control owned tokens, toggle unlocked doors, and project spells.
    Player,
    /// Read-only observer; all state-mutating commands fail closed with `CommandError::PermissionDenied`.
    Spectator,
}

/// Authenticated identity and campaign role of the user issuing a `TrameCommand`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CommandActor {
    /// Unique identifier of the authenticated user.
    pub user_id: Uuid,
    /// Authoritative role of the user within this campaign room.
    pub role: CampaignRole,
}

fn default_token_ac() -> i32 {
    10
}

fn default_reach_ft() -> f64 {
    5.0
}

fn is_zero_i32(value: &i32) -> bool {
    *value == 0
}

/// SRD condition IDs that include Incapacitated (no actions or reactions).
const INCAPACITATING_CONDITIONS: [&str; 5] = [
    "incapacitated",
    "paralyzed",
    "petrified",
    "stunned",
    "unconscious",
];

/// `true` when `token`'s effective conditions (overrides applied) include Incapacitated.
fn is_incapacitated(token: &TokenState) -> bool {
    token
        .effective_conditions()
        .iter()
        .any(|c| INCAPACITATING_CONDITIONS.contains(&c.as_str()))
}

/// Maximum number of conditions on a token, and of `ConditionOverride` entries per token.
pub const MAX_TOKEN_CONDITIONS: usize = 32;
/// Maximum length in bytes of a condition or effect id.
pub const MAX_CONDITION_ID_LEN: usize = 64;

/// What a `ConditionOverride` rules on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OverrideSubject {
    /// A `Condition` id (lowercase SRD id, e.g. `"prone"`).
    Condition,
    /// An automated condition or feature effect id (owned by the game system, e.g. the
    /// `ActiveEffect` a condition maps to).
    Effect,
}

/// Ruling imposed by a `ConditionOverride`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OverrideMode {
    /// The condition or effect applies even when the token's state says otherwise.
    Force,
    /// The condition or effect does not apply even when the token's state says it does.
    Remove,
}

/// One Game Master ruling stored on a token by `ConditionOverride`; it always wins over the
/// token's own conditions and over automated effects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ConditionOverrideEntry {
    /// Whether `id` names a condition or an effect.
    pub subject: OverrideSubject,
    /// Condition id (trimmed, lowercase) or effect id (trimmed), `1..=64` bytes.
    pub id: String,
    /// Forced on or removed.
    pub mode: OverrideMode,
}

/// Normalizes a condition id (trim, ASCII lowercase) or an effect id (trim only) and checks its
/// length (`1..=MAX_CONDITION_ID_LEN` bytes).
fn normalize_override_id(subject: OverrideSubject, raw: &str) -> Result<String, CommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_CONDITION_ID_LEN {
        return Err(CommandError::InvalidConfiguration(format!(
            "condition or effect id must be 1..={MAX_CONDITION_ID_LEN} bytes"
        )));
    }
    Ok(match subject {
        OverrideSubject::Condition => trimmed.to_ascii_lowercase(),
        OverrideSubject::Effect => trimmed.to_string(),
    })
}

/// Authoritative spatial, vitality, action-economy, and sensory state of a single tabletop token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TokenState {
    /// Unique identifier of the token.
    pub id: Uuid,
    /// Display name shown on the tabletop and combat tracker.
    pub name: String,
    /// Optional user ID of the player who controls this token (`None` = GM-only NPC/monster).
    pub owner_user_id: Option<Uuid>,
    /// Optional persistent actor sheet UUID linked to this tactical token (`ADR-0037`).
    #[serde(default)]
    pub actor_id: Option<Uuid>,
    /// Top-left canvas coordinate of the token's footprint in pixels (`px`).
    pub top_left: Point2D,
    /// Nominal horizontal footprint width in grid cells (`>= 1`).
    pub grid_w: u8,
    /// Nominal vertical footprint height in grid cells (`>= 1`).
    pub grid_h: u8,
    /// When `true`, shrinks footprints `>= 2` by 1 cell and doubles movement cost (`2.0` ft per `1.0` ft moved).
    pub is_squeezing: bool,
    /// Vertical elevation of the token's base in feet (`ft`) relative to table zero.
    pub elevation_ft: f64,
    /// Vertical stature of the token in feet (`ft`, e.g., `5.0` for Medium creatures).
    pub height_ft: f64,
    /// Bitmask of visibility planes (`CHANNEL_MATERIAL`, `CHANNEL_ETHEREAL`, `CHANNEL_GM_HIDDEN`) the token occupies.
    pub visibility_channel: u8,
    /// Whether the token currently has the Invisible condition.
    pub invisible: bool,
    /// Sensory ranges and special vision modes (`SenseProfile`) used by the 2.5D raycaster.
    pub senses: SenseProfile,
    /// Current Hit Points (`0..=max_hp`).
    pub hp: i32,
    /// Maximum Hit Points (`>= 1`).
    pub max_hp: i32,
    /// Current Temporary Hit Points (`>= 0`).
    pub temp_hp: i32,
    /// Armor Class (`AC`, default `10`).
    #[serde(default = "default_token_ac")]
    pub ac: i32,
    /// Dexterity modifier (default `0`); initiative tie-breaker and the base of the
    /// initiative bonus.
    #[serde(default)]
    pub dex_mod: i32,
    /// Non-Dexterity part of the derived initiative bonus synced from the linked actor sheet
    /// (proficiency bonus with Alert, minus `2 * exhaustion`); default `0`.
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub initiative_extra: i32,
    /// Maximum movement speed per combat turn in feet (`ft`, e.g., `30.0`).
    pub speed_max_ft: f64,
    /// Remaining movement budget for the current combat turn in feet (`ft`, `0.0..=speed_max_ft`).
    pub speed_remaining_ft: f64,
    /// Whether the token still has its primary Action available this turn.
    pub has_action: bool,
    /// Whether the token still has its Bonus Action available this turn.
    pub has_bonus_action: bool,
    /// Whether the token still has its Reaction available this round.
    pub has_reaction: bool,
    /// Optional ID of the persistent `AoeTemplate` currently maintained via concentration by this token.
    pub concentrating_on_aoe_id: Option<Uuid>,
    /// Active bonuses, penalties, and modifiers applied to this token.
    pub active_effects: Vec<ActiveEffect>,
    /// Active condition ids (lowercase SRD ids), set by `SetTokenConditions` or synchronized
    /// from the persistent actor sheet (`ADR-0037`). See `effective_conditions` for the
    /// overrides.
    #[serde(default)]
    pub conditions: Vec<String>,
    /// Melee `ThreatReach` in feet (`ft`, default `5.0`); leaving it provokes an opportunity prompt.
    #[serde(default = "default_reach_ft")]
    pub reach_ft: f64,
    /// `true` after the Disengage action (`SetDisengaged`): this token's movement opens no
    /// `ReactionPrompt` until the next turn starts, which clears every token's flag.
    #[serde(default)]
    pub disengaged: bool,
    /// `DeathSaveCounters` successes (`0..=3`), reset when the token regains HP.
    #[serde(default)]
    pub death_save_successes: u8,
    /// `DeathSaveCounters` failures (`0..=3`), raised by damage taken at 0 HP and reset on healing.
    #[serde(default)]
    pub death_save_failures: u8,
    /// `true` after `InstantDeath` or a third death saving throw failure; dead tokens cannot be healed.
    #[serde(default)]
    pub is_dead: bool,
    /// Damage types this token takes half damage from (lowercase SRD ids, e.g. `"fire"`).
    #[serde(default)]
    pub damage_resistances: Vec<String>,
    /// Damage types this token ignores entirely (lowercase SRD ids).
    #[serde(default)]
    pub damage_immunities: Vec<String>,
    /// Damage types this token takes double damage from (lowercase SRD ids).
    #[serde(default)]
    pub damage_vulnerabilities: Vec<String>,
    /// Game Master `ConditionOverride` rulings (at most `MAX_TOKEN_CONDITIONS`, one per
    /// subject and id); they win over `conditions` and over automated effects.
    #[serde(default)]
    pub condition_overrides: Vec<ConditionOverrideEntry>,
}

impl TokenState {
    /// Creates a default `1x1` Medium (`5.0` ft tall, `20/20` HP, `30.0` ft speed) token on `CHANNEL_MATERIAL`.
    pub fn new_default(id: Uuid, name: impl Into<String>, top_left: Point2D) -> Self {
        Self {
            id,
            name: name.into(),
            owner_user_id: None,
            actor_id: None,
            top_left,
            grid_w: 1,
            grid_h: 1,
            is_squeezing: false,
            elevation_ft: 0.0,
            height_ft: 5.0,
            visibility_channel: CHANNEL_MATERIAL,
            invisible: false,
            senses: SenseProfile::default(),
            hp: 20,
            max_hp: 20,
            temp_hp: 0,
            ac: 10,
            dex_mod: 0,
            initiative_extra: 0,
            speed_max_ft: 30.0,
            speed_remaining_ft: 30.0,
            has_action: true,
            has_bonus_action: true,
            has_reaction: true,
            concentrating_on_aoe_id: None,
            active_effects: Vec::new(),
            conditions: Vec::new(),
            reach_ft: default_reach_ft(),
            disengaged: false,
            death_save_successes: 0,
            death_save_failures: 0,
            is_dead: false,
            damage_resistances: Vec::new(),
            damage_immunities: Vec::new(),
            damage_vulnerabilities: Vec::new(),
            condition_overrides: Vec::new(),
        }
    }

    /// Conditions in force after the `ConditionOverride` rulings: `conditions` (lowercased,
    /// deduplicated, in order) minus the `Remove`d ones, then the `Force`d ones not already
    /// present, in ruling order.
    pub fn effective_conditions(&self) -> Vec<String> {
        let ruled = |id: &str, mode: OverrideMode| {
            self.condition_overrides
                .iter()
                .any(|o| o.subject == OverrideSubject::Condition && o.mode == mode && o.id == id)
        };
        let mut out: Vec<String> = Vec::new();
        let own = self
            .conditions
            .iter()
            .map(|c| c.trim().to_ascii_lowercase());
        let forced = self
            .condition_overrides
            .iter()
            .filter(|o| o.subject == OverrideSubject::Condition && o.mode == OverrideMode::Force)
            .map(|o| o.id.clone());
        for id in own.chain(forced) {
            if !ruled(&id, OverrideMode::Remove) && !out.contains(&id) {
                out.push(id);
            }
        }
        out
    }

    /// Modifier added to the server's `1d20` initiative roll (`AuthoritativeInitiativeRoll`).
    pub fn initiative_modifier(&self) -> i32 {
        self.dex_mod.saturating_add(self.initiative_extra)
    }

    /// Derives this token's `DamageAffinity` toward `damage_type` (case-insensitive) from its
    /// own damage lists (G6), so clients never choose the affinity for typed damage.
    ///
    /// Resolution order: immunity wins; resistance and vulnerability to the same type cancel
    /// out (SRD: halve, then double) to `Normal`; otherwise the single matching list applies.
    pub fn damage_affinity_for(&self, damage_type: &str) -> DamageAffinity {
        let has = |list: &[String]| list.iter().any(|t| t.eq_ignore_ascii_case(damage_type));
        if has(&self.damage_immunities) {
            return DamageAffinity::Immune;
        }
        match (
            has(&self.damage_resistances),
            has(&self.damage_vulnerabilities),
        ) {
            (true, false) => DamageAffinity::Resistant,
            (false, true) => DamageAffinity::Vulnerable,
            _ => DamageAffinity::Normal,
        }
    }

    /// Projects this token's current bounding box (accounting for `is_squeezing` footprint reduction)
    /// into a `TokenSpatialRef` for AoE target evaluation.
    pub fn spatial_ref(&self) -> TokenSpatialRef {
        TokenSpatialRef {
            id: self.id,
            top_left: self.top_left,
            grid_w: if self.is_squeezing {
                (self.grid_w.saturating_sub(1)).max(1)
            } else {
                self.grid_w
            },
            grid_h: if self.is_squeezing {
                (self.grid_h.saturating_sub(1)).max(1)
            } else {
                self.grid_h
            },
            elevation_ft: self.elevation_ft,
            height_ft: self.height_ft,
        }
    }
}

/// Authoritative CQRS mutation commands submitted by connected clients (`01-TABLE-SPEC.md`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "cmd", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrameCommand {
    /// Moves a token to a new canvas position and optional elevation, validating wall collisions and turn speed budgets.
    MoveToken {
        /// Target token ID to move.
        token_id: Uuid,
        /// Destination top-left coordinate in canvas pixels (`px`).
        to_top_left: Point2D,
        /// Optional new vertical elevation in feet (`ft`); preserves current elevation when `None`.
        to_elevation_ft: Option<f64>,
        /// When `true` and issued by a `Gm`, bypasses wall collisions, turn locks, and movement cost deduction.
        gm_teleport: bool,
    },
    /// Records the Disengage action on a token (GM: any token; players: owned tokens only). While
    /// set, the token's moves open no `ReactionPrompt`; the next turn start clears it.
    SetDisengaged {
        /// Target token ID.
        token_id: Uuid,
        /// `true` to take the Disengage action, `false` to withdraw it.
        disengaged: bool,
    },
    /// Replaces a token's conditions (GM: any token; players: owned tokens only). Ids are
    /// trimmed, lowercased, and deduplicated; at most `MAX_TOKEN_CONDITIONS` ids of
    /// `1..=MAX_CONDITION_ID_LEN` bytes. Undoable.
    SetTokenConditions {
        /// Target token ID.
        token_id: Uuid,
        /// Complete new condition list (empty clears every condition).
        conditions: Vec<String>,
    },
    /// Records, replaces, or clears a Game Master ruling that forces or removes a condition or
    /// an automated effect on any token (GM only). Undoable.
    ConditionOverride {
        /// Target token ID.
        token_id: Uuid,
        /// Whether `id` is a condition or an effect.
        subject: OverrideSubject,
        /// Condition id (lowercased) or effect id, `1..=MAX_CONDITION_ID_LEN` bytes.
        id: String,
        /// `Force` or `Remove`; `None` clears the ruling for `(subject, id)`.
        mode: Option<OverrideMode>,
    },
    /// Toggles the D&D 5e squeezing state for a token to fit through narrower passages at double movement cost.
    ToggleSqueeze {
        /// Target token ID.
        token_id: Uuid,
        /// New squeezing state (`true` = squeezing).
        is_squeezing: bool,
    },
    /// Opens or closes an interactive `Door` or `SecretDoor` wall segment and rebuilds the room `Bvh2D`.
    ToggleDoor {
        /// Target wall segment ID.
        wall_id: Uuid,
        /// Desired door state (`true` = open/permeable, `false` = closed/opaque).
        is_open: bool,
    },
    /// Switches the tabletop between `Exploration` and `TurnByTurn` combat modes (GM only).
    SetTableMode {
        /// New tabletop operating mode.
        mode: TableMode,
        /// Whether player movement is paused in `Exploration` mode.
        exploration_paused: bool,
        /// Ordered list of token IDs defining the combat initiative sequence.
        #[serde(default)]
        initiative_order: Vec<Uuid>,
        /// Initiative totals keyed by token ID; entries for tokens outside `initiative_order` are dropped.
        #[serde(default)]
        initiative_totals: BTreeMap<Uuid, i32>,
    },
    /// Enters `TurnByTurn` combat mode at Round 1, Turn Index 0 with an explicit or auto-rolled `initiative_order` (GM only).
    StartTurnByTurn {
        /// Ordered list of token IDs defining the combat initiative sequence (if empty, `TableRoomActor` rolls `1d20 + initiative bonus`).
        #[serde(default)]
        initiative_order: Vec<Uuid>,
        /// Initiative totals keyed by token ID (e.g., the `AuthoritativeInitiativeRoll` results);
        /// entries for tokens outside `initiative_order` are dropped.
        #[serde(default)]
        initiative_totals: BTreeMap<Uuid, i32>,
    },
    /// Sets one combatant's initiative total and re-sorts `initiative_order` (GM only).
    ///
    /// Sort order: total descending, then `dex_mod` descending, then token ID ascending; tokens
    /// without a total sort last. The active combatant keeps the turn.
    SetInitiativeTotal {
        /// Token ID of the combatant (must be in `initiative_order`).
        token_id: Uuid,
        /// New initiative total.
        total: i32,
    },
    /// Exits `TurnByTurn` combat mode and returns the tabletop to free-form `Exploration` mode (GM only).
    EndTurnByTurn,
    /// Advances the combat tracker to the next token in `initiative_order`, wrapping rounds and refreshing action/movement budgets.
    AdvanceTurn,
    /// Applies raw damage with a specified `DamageAffinity` to a target token, resolving Temp HP,
    /// Concentration checks, death saving throw failures at 0 HP, and `InstantDeath`.
    ///
    /// GM may target any token; players only tokens they own (G6).
    ApplyDamage {
        /// Target token ID receiving damage.
        token_id: Uuid,
        /// Unmitigated incoming damage amount (`>= 0`).
        raw_damage: i32,
        /// Target's resistance, vulnerability, or immunity toward the damage type. Ignored when
        /// `damage_type` is set.
        affinity: DamageAffinity,
        /// Whether the hit is a critical hit (adds 2 death saving throw failures at 0 HP).
        #[serde(default)]
        is_critical: bool,
        /// Typed damage (lowercase SRD id, e.g. `"fire"`). When set, the affinity is derived from
        /// the target's `damage_*` lists (`TokenState::damage_affinity_for`) instead of `affinity`.
        #[serde(default)]
        damage_type: Option<String>,
    },
    /// Restores hit points to a token, capped at `max_hp` (GM: any token; players: owned tokens only).
    ///
    /// Healing a token at 0 HP resets its `DeathSaveCounters`. Dead tokens cannot be healed.
    HealActor {
        /// Target token ID receiving healing.
        token_id: Uuid,
        /// Hit points restored (`>= 0`).
        amount: i32,
    },
    /// Directly overrides a token's HP, Temp HP, remaining speed, or action economy flags (GM only).
    GmOverrideTokenResources {
        /// Target token ID to override.
        token_id: Uuid,
        /// Optional new Hit Points (clamped to `0..=max_hp`).
        hp: Option<i32>,
        /// Optional new Temporary Hit Points (clamped to `>= 0`).
        temp_hp: Option<i32>,
        /// Optional new remaining turn movement speed in feet (`ft`, clamped to `>= 0.0`).
        speed_remaining_ft: Option<f64>,
        /// Optional override for primary Action availability.
        has_action: Option<bool>,
        /// Optional override for Bonus Action availability.
        has_bonus_action: Option<bool>,
        /// Optional override for Reaction availability.
        has_reaction: Option<bool>,
    },
    /// Evaluates and optionally persists an Area of Effect (`AoeTemplate`) on the tabletop.
    ProjectAoe {
        /// Geometric and concentration specification of the AoE.
        template: AoeTemplate,
        /// When `true`, stores the template in `persistent_aoes` and binds caster concentration if set.
        persist_zone: bool,
    },
    /// Removes a persistent AoE zone (GM, or the controller of its concentration caster).
    /// Clears the caster's concentration when it was bound to this zone.
    ClearAoe {
        /// `AoeTemplate::id` of the persistent zone to remove.
        aoe_id: Uuid,
    },
    /// Restores one spent action-economy resource on a token (GM only).
    RefundAction {
        /// Target token ID.
        token_id: Uuid,
        /// Resource to restore.
        resource: RefundableResource,
    },
    /// Voluntarily or forcibly ends a caster token's active concentration and removes its linked persistent AoE.
    BreakConcentration {
        /// Token ID of the concentrating spellcaster.
        caster_token_id: Uuid,
    },
    /// Updates the global ambient lighting preset for the tabletop (GM only).
    SetAmbientLighting {
        /// New ambient lighting preset.
        preset: AmbientLightingPreset,
    },
    /// Loads a new battlemap scene into the room, replacing walls and grid dimensions while preserving hero tokens (GM only).
    LoadScene {
        /// Unique identifier of the loaded scene.
        scene_id: Uuid,
        /// Asset store key or SHA-256 hash of the background WebP battlemap.
        map_asset_id: String,
        /// Battlemap canvas width in pixels (`px`).
        width_px: u32,
        /// Battlemap canvas height in pixels (`px`).
        height_px: u32,
        /// Grid cell width/height in pixels (`px`, `> 0.0`).
        pixels_per_grid: f64,
        /// Wall and portal geometry segments extracted from the scene or `.uvtt` bundle.
        walls: Vec<WallSegment>,
    },
    /// Activates a persisted map scene (GM only): replaces walls, lights, map, and grid; keeps
    /// `HeroToken`s (moved onto spawn points); removes every other token; spawns the scene's
    /// `StagedToken`s; clears AoEs, fog overrides, difficult terrain, reaction prompts; and
    /// returns to `Exploration`.
    ActivateScene {
        /// Unique identifier of the persisted scene.
        scene_id: Uuid,
        /// Resolved scene payload filled in by the server; `None` is rejected by the engine.
        #[serde(default)]
        scene: Option<SceneActivation>,
    },
    /// Spawns or replaces a token on the tabletop (GM only).
    SpawnToken {
        /// Complete initial state of the token to place on the map (boxed to keep
        /// `TrameCommand` small; JSON shape unchanged).
        token: Box<TokenState>,
    },
    /// Removes a token from the tabletop and combat initiative order (GM only).
    RemoveToken {
        /// Target token ID to remove.
        token_id: Uuid,
    },
    /// Appends or updates a 2.5D wall or portal segment on the active map and rebuilds the `Bvh2D` tree (GM only).
    AddWall {
        /// Authoritative wall or door segment primitive to add to the scene.
        wall: WallSegment,
    },
    /// Appends or updates a dynamic point light emitter on the active map (GM only).
    AddLight {
        /// Dynamic light source emitter to place on the scene.
        light: LightSource,
    },
    /// Applies a manual GM fog-of-war brush override (`Reveal`, `Hide`, or `Clear`) to a discrete grid cell (GM only).
    SetFogOverride {
        /// Brush operation mode (`Reveal`, `Hide`, or `Clear`).
        mode: FogOverrideMode,
        /// Discrete horizontal grid column index (`cell_x`).
        cell_x: i32,
        /// Discrete vertical grid row index (`cell_y`).
        cell_y: i32,
    },
    /// Marks (`difficult: true`) or clears (`false`) difficult terrain on grid cells of the
    /// active map (GM only). Every cell must lie on the map; the list must not be empty.
    SetDifficultTerrain {
        /// Grid cells to paint or erase.
        cells: Vec<GridCell>,
        /// `true` adds the cells to `difficult_terrain`, `false` removes them.
        difficult: bool,
    },
    /// Configures the active battlemap background URL/hash and physical dimensions in feet (GM only).
    SetMapConfig {
        /// Optional asset URL or SHA-256 hash of the map background image.
        background_url: Option<String>,
        /// Horizontal map width in tactical feet (`ft`, `> 0`).
        width_ft: u32,
        /// Vertical map height in tactical feet (`ft`, `> 0`).
        height_ft: u32,
    },
    /// Toggles a token's GM-hidden channel bitmask (`CHANNEL_GM_HIDDEN`) or magical invisibility state (GM only).
    SetTokenVisibility {
        /// Target token ID.
        token_id: Uuid,
        /// When `true`, sets `CHANNEL_GM_HIDDEN` so the token is stripped from non-GM wire state.
        gm_hidden: bool,
        /// When `true`, marks the token as invisible (requiring `see_invisibility`, `truesight`, or `blindsight`).
        invisible: bool,
    },
    /// Assigns or clears player ownership of a token on the tabletop (GM only).
    AssignTokenOwner {
        /// Target token ID.
        token_id: Uuid,
        /// User UUID granted control over the token (`None` for GM-only NPC/monster control).
        owner_user_id: Option<Uuid>,
    },
    /// Reconfigures a door wall segment's open, locked, or secret status and rebuilds the `Bvh2D` (GM only).
    ConfigureDoor {
        /// Target wall segment ID.
        wall_id: Uuid,
        /// Optional new open state.
        is_open: Option<bool>,
        /// Optional new locked state.
        is_locked: Option<bool>,
        /// Optional conversion between `WallKind::SecretDoor` (`true`) and `WallKind::Door` (`false`).
        is_secret: Option<bool>,
    },
    /// Reveals a campaign handout to the table (GM only). Not undoable: players have already seen it.
    RevealHandout {
        /// Handout identifier from the `:::handout{id="..."}` `DirectiveBlock` (non-empty).
        handout_id: String,
    },
    /// Resolves an active tactical reaction prompt (`Trigger` or `Pass`); the GM may force any decision.
    DecideReaction {
        /// Unique identifier of the active reaction prompt being resolved.
        prompt_id: Uuid,
        /// Reacting actor/token UUID.
        actor_id: Uuid,
        /// Player or GM decision (`Trigger` with optional `ability_id`, or `Pass`).
        decision: ReactionDecision,
    },
    /// Marks a triggered reaction as played out (reactor owner or GM). The interrupted movement
    /// then resumes toward its pending destination without re-prompting reactors already resolved
    /// during that movement; it does not resume if the mover dropped to 0 HP or the path became
    /// invalid (wall or movement budget).
    ResolveReaction {
        /// Unique identifier of the triggered reaction prompt.
        prompt_id: Uuid,
    },
    /// Commits a queued MCP dry-run staging batch atomically as a single undoable step (GM only).
    CommitMcpStaging {
        /// Unique identifier of the staged MCP proposal to execute.
        proposal_id: Uuid,
    },
    /// Rejects and discards a queued MCP dry-run staging batch without mutating the table (GM only).
    RejectMcpStaging {
        /// Unique identifier of the staged MCP proposal to discard.
        proposal_id: Uuid,
    },
    /// Restores the most recent pre-mutation `TableSnapshotData` from the 50-action ring buffer (GM only).
    UndoLastAction,
}

/// Domain events emitted after a `TrameCommand` is accepted and applied to `TableState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "event", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrameEvent {
    /// Emitted when a token's position or elevation changes.
    TokenMoved {
        /// Moved token ID.
        token_id: Uuid,
        /// Previous top-left canvas coordinate in pixels (`px`).
        from_top_left: Point2D,
        /// New top-left canvas coordinate in pixels (`px`).
        to_top_left: Point2D,
        /// Updated vertical elevation in feet (`ft`).
        elevation_ft: f64,
        /// Remaining movement budget for the current turn in feet (`ft`).
        speed_remaining_ft: f64,
    },
    /// Emitted when a token takes or withdraws the Disengage action.
    TokenDisengaged {
        /// Target token ID.
        token_id: Uuid,
        /// Updated Disengage flag.
        disengaged: bool,
    },
    /// Emitted when `SetTokenConditions` replaces a token's conditions.
    TokenConditionsChanged {
        /// Target token ID.
        token_id: Uuid,
        /// Normalized condition list now on the token.
        conditions: Vec<String>,
        /// The token's effective conditions (`ConditionOverride` rulings applied).
        effective_conditions: Vec<String>,
    },
    /// Emitted when a `ConditionOverride` ruling is recorded, replaced, or cleared.
    ConditionOverrideChanged {
        /// Target token ID.
        token_id: Uuid,
        /// Every ruling now on the token (stripped for recipients who do not control it).
        overrides: Vec<ConditionOverrideEntry>,
        /// The token's effective conditions after the change.
        effective_conditions: Vec<String>,
    },
    /// Emitted when a token enters or exits squeezing mode.
    TokenSqueezeToggled {
        /// Target token ID.
        token_id: Uuid,
        /// Updated squeezing state.
        is_squeezing: bool,
        /// Remaining movement budget in feet (`ft`).
        speed_remaining_ft: f64,
    },
    /// Emitted when a door or secret door is opened or closed.
    DoorToggled {
        /// Toggled wall segment ID.
        wall_id: Uuid,
        /// Updated open state (`true` = open).
        is_open: bool,
    },
    /// Emitted when the GM transitions the table between Exploration and Turn-by-Turn modes.
    TableModeChanged {
        /// Active table mode.
        mode: TableMode,
        /// Whether exploration movement is paused.
        exploration_paused: bool,
        /// Token ID of the creature holding the first turn (`None` if `initiative_order` is empty).
        active_turn_token_id: Option<Uuid>,
        /// Current combat round counter (`>= 1`).
        round: u32,
    },
    /// Emitted when the active combat turn advances to the next combatant.
    TurnAdvanced {
        /// Token ID of the combatant whose turn just started.
        active_turn_token_id: Option<Uuid>,
        /// Current combat round counter (`>= 1`).
        round: u32,
    },
    /// Emitted when damage is resolved against a token.
    DamageApplied {
        /// Damaged token ID.
        token_id: Uuid,
        /// Detailed damage, Temp HP absorption, and concentration DC breakdown.
        resolution: DamageResolution,
    },
    /// Emitted when the GM manually overrides a token's combat resources.
    TokenResourcesOverridden {
        /// Target token ID.
        token_id: Uuid,
        /// Updated Hit Points.
        hp: i32,
        /// Updated Temporary Hit Points.
        temp_hp: i32,
        /// Updated remaining movement speed in feet (`ft`).
        speed_remaining_ft: f64,
        /// Updated primary Action flag.
        has_action: bool,
        /// Updated Bonus Action flag.
        has_bonus_action: bool,
        /// Updated Reaction flag.
        has_reaction: bool,
        /// Death flag after the override (cleared when HP is restored above 0).
        #[serde(default)]
        is_dead: bool,
    },
    /// Emitted when an AoE template is evaluated and projected onto the map.
    AoeProjected {
        /// The evaluated AoE template.
        template: AoeTemplate,
        /// Grid cells affected by the wall-clipped AoE.
        affected_cells: Vec<GridCell>,
        /// Token IDs whose footprints were hit by the AoE.
        affected_token_ids: Vec<Uuid>,
        /// Whether the AoE remains on the map as a persistent zone.
        persisted: bool,
    },
    /// Emitted when a spellcaster's concentration ends (voluntarily, by replacement, or by dropping to `0` HP).
    ConcentrationBroken {
        /// Token ID of the caster whose concentration ended.
        caster_token_id: Uuid,
        /// Optional ID of the persistent AoE removed from the map.
        removed_aoe_id: Option<Uuid>,
    },
    /// Emitted when the global ambient lighting preset changes.
    AmbientLightingChanged {
        /// Newly active lighting preset.
        preset: AmbientLightingPreset,
    },
    /// Emitted when a new battlemap scene is loaded into the room.
    SceneLoaded {
        /// Loaded scene ID.
        scene_id: Uuid,
        /// Background map asset key or SHA-256 hash.
        map_asset_id: String,
        /// Canvas width in pixels (`px`).
        width_px: u32,
        /// Canvas height in pixels (`px`).
        height_px: u32,
        /// Grid cell size in pixels (`px`).
        pixels_per_grid: f64,
    },
    /// Emitted when a token is spawned onto the tabletop.
    TokenSpawned {
        /// Newly spawned token state (boxed to keep `TrameEvent` small; JSON shape unchanged).
        token: Box<TokenState>,
    },
    /// Emitted when a token is removed from the tabletop.
    TokenRemoved {
        /// Removed token ID.
        token_id: Uuid,
    },
    /// Emitted when a wall or portal segment is added or updated on the map.
    WallAdded {
        /// Added or updated wall segment primitive.
        wall: WallSegment,
    },
    /// Emitted when a dynamic point light emitter is added or updated on the map.
    LightAdded {
        /// Added or updated light source emitter.
        light: LightSource,
    },
    /// Emitted when the GM paints or clears a manual fog-of-war cell override.
    FogOverrideChanged {
        /// Applied override mode (`Reveal`, `Hide`, or `Clear`).
        mode: FogOverrideMode,
        /// Discrete horizontal grid column index (`cell_x`).
        cell_x: i32,
        /// Discrete vertical grid row index (`cell_y`).
        cell_y: i32,
    },
    /// Emitted when the GM paints or erases difficult terrain.
    DifficultTerrainChanged {
        /// Cells named by the command.
        cells: Vec<GridCell>,
        /// `true` when the cells became difficult, `false` when they were cleared.
        difficult: bool,
    },
    /// Emitted when the battlemap background URL or physical dimensions are updated.
    MapConfigChanged {
        /// Updated background image URL or asset hash.
        background_url: Option<String>,
        /// Updated horizontal map width in feet (`ft`).
        width_ft: u32,
        /// Updated vertical map height in feet (`ft`).
        height_ft: u32,
    },
    /// Emitted when a token's GM-hidden bitmask or invisibility state changes.
    TokenVisibilityChanged {
        /// Target token ID.
        token_id: Uuid,
        /// Updated planar visibility bitmask.
        visibility_channel: u8,
        /// Updated magical invisibility flag.
        invisible: bool,
    },
    /// Emitted when a token's controlling user UUID changes.
    TokenOwnerAssigned {
        /// Target token ID.
        token_id: Uuid,
        /// Updated owner user UUID (`None` if GM-only).
        owner_user_id: Option<Uuid>,
    },
    /// Emitted when a door's open, locked, or secret properties are reconfigured by the GM.
    DoorConfigured {
        /// Target wall segment ID.
        wall_id: Uuid,
        /// Updated `WallKind` variant.
        kind: WallKind,
    },
    /// Emitted when a tactical reaction prompt is resolved (`Trigger` or `Pass`).
    ReactionDecided {
        /// Resolved reaction prompt UUID.
        prompt_id: Uuid,
        /// Reacting actor/token UUID.
        actor_id: Uuid,
        /// Chosen reaction decision.
        decision: ReactionDecision,
        /// Whether the triggering token's movement was interrupted (`true` on `Trigger`, `false` on `Pass`).
        movement_interrupted: bool,
    },
    /// Emitted when an open or triggered reaction prompt is closed without a `Pass` decision.
    ReactionPromptClosed {
        /// Closed reaction prompt UUID.
        prompt_id: Uuid,
        /// Why the prompt was closed.
        reason: ReactionPromptCloseReason,
    },
    /// Emitted when a queued MCP dry-run staging proposal is committed by the GM.
    McpStagingCommitted {
        /// Committed MCP staging proposal UUID.
        proposal_id: Uuid,
    },
    /// Emitted when a queued MCP dry-run staging proposal is rejected and discarded by the GM.
    McpStagingRejected {
        /// Rejected MCP staging proposal UUID.
        proposal_id: Uuid,
    },
    /// Emitted when the GM pops and restores the last snapshot from the undo ring buffer.
    ActionUndone {
        /// Human-readable description of the undone command.
        description: String,
    },
    /// Emitted when a moving token leaves a hostile's `ThreatReach` and stops on the exit square.
    ReactionPromptOpened {
        /// The opened prompt, addressed to `prompt.reactor_owner_user_id` (`None` = GM).
        prompt: ReactionPrompt,
    },
    /// Emitted when a token regains hit points through `HealActor`.
    TokenHealed {
        /// Healed token ID.
        token_id: Uuid,
        /// Hit points actually restored after the `max_hp` cap (`>= 0`).
        hp_restored: i32,
        /// Resulting Hit Points (`0..=max_hp`).
        new_hp: i32,
    },
    /// Emitted when a persistent AoE zone is removed through `ClearAoe`.
    AoeCleared {
        /// Removed `AoeTemplate::id`.
        aoe_id: Uuid,
        /// Caster whose concentration ended with the zone, if any.
        caster_token_id: Option<Uuid>,
    },
    /// Emitted when the GM restores a spent action-economy resource.
    ActionRefunded {
        /// Target token ID.
        token_id: Uuid,
        /// Restored resource.
        resource: RefundableResource,
    },
    /// Emitted when a persisted scene is activated.
    SceneActivated {
        /// Activated scene ID.
        scene_id: Uuid,
        /// Background map asset key or SHA-256 hash.
        map_asset_id: Option<String>,
        /// Canvas width in pixels (`px`).
        width_px: u32,
        /// Canvas height in pixels (`px`).
        height_px: u32,
        /// Grid cell size in pixels (`px`).
        pixels_per_grid: f64,
        /// `HeroToken`s kept from the previous scene.
        hero_token_ids: Vec<Uuid>,
        /// `StagedToken`s spawned from the scene.
        spawned_token_ids: Vec<Uuid>,
    },
    /// Emitted when the GM reveals a handout to the table.
    HandoutRevealed {
        /// Revealed handout identifier.
        handout_id: String,
    },
    /// Emitted when an initiative total changes and the order is re-sorted.
    InitiativeUpdated {
        /// Re-sorted combat order.
        initiative_order: Vec<Uuid>,
        /// Current initiative totals keyed by token ID.
        initiative_totals: BTreeMap<Uuid, i32>,
        /// Token ID of the combatant holding the turn.
        active_turn_token_id: Option<Uuid>,
    },
}

/// Single compensating snapshot entry stored in the `TableState::undo_stack` ring buffer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct UndoEntry {
    /// Human-readable label describing the action that was taken immediately after this snapshot.
    pub description: String,
    /// Full serializable tabletop state captured prior to the command mutation.
    pub snapshot: TableSnapshotData,
    /// Grid cell size in pixels (`px`) captured with the snapshot, so undoing a scene change also
    /// restores `TableState::cell_size_px` (`None` in entries written before this field existed).
    #[serde(default)]
    pub cell_size_px: Option<f64>,
}

/// Purely serializable tabletop state payload persisted in snapshots and the undo ring buffer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TableSnapshotData {
    /// Current tabletop mode (`Exploration` or `TurnByTurn`).
    pub mode: TableMode,
    /// Whether player movement is paused by the GM during `Exploration` mode.
    pub exploration_paused: bool,
    /// Current global ambient lighting preset.
    pub ambient_lighting: AmbientLightingPreset,
    /// Current 1-based combat round counter.
    pub round: u32,
    /// Ordered sequence of token IDs participating in combat initiative.
    pub initiative_order: Vec<Uuid>,
    /// Zero-based index into `initiative_order` indicating whose turn is active.
    pub active_turn_index: usize,
    /// Initiative totals keyed by token ID for combatants in `initiative_order` (cleared with combat).
    #[serde(default)]
    pub initiative_totals: BTreeMap<Uuid, i32>,
    /// Map of all active tokens on the tabletop keyed by token `Uuid`.
    pub tokens: BTreeMap<Uuid, TokenState>,
    /// Authoritative list of wall, window, terrain, and door segments on the map.
    pub walls: Vec<WallSegment>,
    /// Dynamic point light sources placed on the active map.
    #[serde(default)]
    pub lights: Vec<LightSource>,
    /// Manual GM fog-of-war cell overrides (`Reveal` / `Hide`).
    #[serde(default)]
    pub fog_overrides: Vec<FogOverrideCell>,
    /// Active persistent Area of Effect zones keyed by `AoeTemplate::id`.
    pub persistent_aoes: BTreeMap<Uuid, AoeTemplate>,
    /// Active 5-second tactical reaction prompts keyed by `prompt_id`.
    #[serde(default)]
    pub active_reaction_prompts: BTreeMap<Uuid, ReactionPrompt>,
    /// Queued MCP dry-run staging proposals keyed by `proposal_id`.
    #[serde(default)]
    pub mcp_staging_proposals: BTreeMap<Uuid, McpStagingProposal>,
    /// Optional SHA-256 hash or asset URL of the active background battlemap image.
    #[serde(default)]
    pub background_asset_hash: Option<String>,
    /// Active battlemap width in canvas pixels (`px`, default `2000`).
    #[serde(default = "default_map_dimension_px")]
    pub map_width_px: u32,
    /// Active battlemap height in canvas pixels (`px`, default `2000`).
    #[serde(default = "default_map_dimension_px")]
    pub map_height_px: u32,
    /// Handout identifiers revealed to the table through `RevealHandout`.
    #[serde(default)]
    pub revealed_handout_ids: BTreeSet<String>,
    /// Monotonic count of reaction prompts ever opened on this table (`0..`), hashed into each
    /// `prompt_id`. Survives undo so an undone prompt's ID is never reissued to another prompt.
    #[serde(default)]
    pub reaction_prompt_seq: u64,
    /// Grid cells of difficult terrain on the active map (entering one costs double movement).
    /// Painted with `SetDifficultTerrain`; cleared when another map is loaded or activated.
    #[serde(default)]
    pub difficult_terrain: BTreeSet<GridCell>,
}

/// Authoritative in-memory tabletop state machine combining serializable `TableSnapshotData`,
/// the live `Bvh2D` spatial index, and the 50-action `undo_stack`.
#[derive(Debug, Clone)]
pub struct TableState {
    /// Size of a single square grid cell in canvas pixels (`px`, default `100.0`).
    pub cell_size_px: f64,
    /// Tactical distance represented by a single grid cell in feet (`ft`, default `5.0`).
    pub feet_per_cell: f64,
    /// Serializable domain state (tokens, walls, initiative, lighting, persistent AoEs).
    pub data: TableSnapshotData,
    /// Precomputed 2.5D Bounding Volume Hierarchy over `data.walls`.
    pub bvh: Bvh2D,
    /// Bounded ring buffer (up to `MAX_UNDO_HISTORY = 50`) of pre-mutation snapshots for GM undo.
    pub undo_stack: VecDeque<UndoEntry>,
}

/// Domain and authorization errors returned when a `TrameCommand` is rejected by `TableState::apply_command`.
#[derive(Debug, Error, PartialEq)]
pub enum CommandError {
    /// The actor lacks the required `CampaignRole` or token ownership to execute the command.
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    /// The referenced token or wall UUID does not exist in `TableSnapshotData`.
    #[error("entity not found: {0}")]
    NotFound(String),
    /// A player attempted to move a token while `exploration_paused == true`.
    #[error("exploration movement is currently paused by the GM")]
    ExplorationPaused,
    /// A player attempted to move a token or advance the turn when it is not their token's active turn.
    #[error("not your turn in Turn-by-Turn mode")]
    NotActiveTurn,
    /// The requested movement distance exceeds the token's `speed_remaining_ft` in `TurnByTurn` mode.
    #[error("insufficient movement budget: need {needed_ft:.1} ft, have {remaining_ft:.1} ft")]
    InsufficientMovement {
        /// Movement cost required for the segment in feet (`ft`).
        needed_ft: f64,
        /// Remaining movement budget on the token in feet (`ft`).
        remaining_ft: f64,
    },
    /// The movement path intersected a movement-blocking `WallSegment` at `(x, y)` in pixels (`px`).
    #[error("movement blocked by wall at ({x:.1}, {y:.1})")]
    WallCollision {
        /// Horizontal collision coordinate in canvas pixels (`px`).
        x: f64,
        /// Vertical collision coordinate in canvas pixels (`px`).
        y: f64,
    },
    /// A non-GM actor attempted to open or close a locked door (`is_locked == true`).
    #[error("door is locked")]
    DoorLocked,
    /// A scene, map, or door configuration parameter was out of valid bounds.
    #[error("invalid configuration: {0}")]
    InvalidConfiguration(String),
    /// The GM issued `UndoLastAction` while `undo_stack` was empty.
    #[error("undo stack is empty")]
    NothingToUndo,
    /// A player tried to move a token that is stopped on an undecided `ReactionPrompt`.
    #[error("token movement is waiting for a reaction decision")]
    ReactionPending,
    /// The reacting token has already spent its reaction this round.
    #[error("reaction already spent")]
    ReactionUnavailable,
    /// A sub-command of an atomic batch failed; the whole batch was rolled back.
    #[error("batch command #{index} failed: {source}")]
    BatchCommandFailed {
        /// Zero-based index of the failing sub-command.
        index: usize,
        /// Error returned by the failing sub-command.
        source: Box<CommandError>,
    },
}

impl Default for TableState {
    fn default() -> Self {
        Self::new(100.0, 5.0, Vec::new())
    }
}

impl TableState {
    /// Initializes a new `TableState` with the given `cell_size_px` (in pixels), `feet_per_cell` (in feet),
    /// and initial `walls`, building the initial `Bvh2D` acceleration tree.
    pub fn new(cell_size_px: f64, feet_per_cell: f64, walls: Vec<WallSegment>) -> Self {
        let bvh = Bvh2D::build(walls.clone());
        Self {
            cell_size_px,
            feet_per_cell,
            data: TableSnapshotData {
                mode: TableMode::Exploration,
                exploration_paused: false,
                ambient_lighting: AmbientLightingPreset::Daylight,
                round: 1,
                initiative_order: Vec::new(),
                active_turn_index: 0,
                initiative_totals: BTreeMap::new(),
                tokens: BTreeMap::new(),
                walls,
                lights: Vec::new(),
                fog_overrides: Vec::new(),
                persistent_aoes: BTreeMap::new(),
                active_reaction_prompts: BTreeMap::new(),
                mcp_staging_proposals: BTreeMap::new(),
                background_asset_hash: None,
                map_width_px: default_map_dimension_px(),
                map_height_px: default_map_dimension_px(),
                revealed_handout_ids: BTreeSet::new(),
                reaction_prompt_seq: 0,
                difficult_terrain: BTreeSet::new(),
            },
            bvh,
            undo_stack: VecDeque::with_capacity(MAX_UNDO_HISTORY),
        }
    }

    /// Restores a compensating `UndoEntry` snapshot and rebuilds the 2.5D `Bvh2D` spatial index.
    ///
    /// `revealed_handout_ids` is kept from the current state: a reveal is an out-of-band
    /// disclosure that players have already seen, so undoing earlier or enclosing commands must
    /// not silently hide it again. `reaction_prompt_seq` is kept too, so prompt IDs stay unique.
    pub fn apply_undo_delta(&mut self, entry: UndoEntry) {
        let revealed_handout_ids = std::mem::take(&mut self.data.revealed_handout_ids);
        let reaction_prompt_seq = self.data.reaction_prompt_seq;
        self.data = entry.snapshot;
        self.data.revealed_handout_ids = revealed_handout_ids;
        self.data.reaction_prompt_seq = reaction_prompt_seq;
        if let Some(cell_size_px) = entry.cell_size_px {
            self.cell_size_px = cell_size_px;
        }
        self.bvh = Bvh2D::build(self.data.walls.clone());
    }

    /// Returns the token `Uuid` whose turn is currently active according to `active_turn_index`,
    /// or `None` if `initiative_order` is empty.
    pub fn active_turn_token_id(&self) -> Option<Uuid> {
        self.data
            .initiative_order
            .get(self.data.active_turn_index)
            .copied()
    }

    fn push_undo(&mut self, description: impl Into<String>) {
        let snapshot = self.data.clone();
        let cell_size_px = self.cell_size_px;
        self.push_undo_snapshot(description.into(), snapshot, cell_size_px);
    }

    fn push_undo_snapshot(
        &mut self,
        description: String,
        snapshot: TableSnapshotData,
        cell_size_px: f64,
    ) {
        if self.undo_stack.len() >= MAX_UNDO_HISTORY {
            self.undo_stack.pop_front();
        }
        self.undo_stack.push_back(UndoEntry {
            description,
            snapshot,
            cell_size_px: Some(cell_size_px),
        });
    }

    /// Applies `commands` all-or-nothing as one undoable step.
    ///
    /// Each sub-command keeps its own RBAC and validation. On the first failure every change is
    /// rolled back (data, `Bvh2D`, grid size, undo stack) and
    /// `CommandError::BatchCommandFailed { index, source }` is returned. On success exactly one
    /// composite `UndoEntry` labelled `description` is pushed. Empty batches and nested
    /// `UndoLastAction` / `CommitMcpStaging` / `RejectMcpStaging` are rejected up front with
    /// `CommandError::InvalidConfiguration`, because they would rewrite the undo stack mid-batch.
    pub fn apply_batch(
        &mut self,
        actor: &CommandActor,
        commands: Vec<TrameCommand>,
        description: impl Into<String>,
    ) -> Result<Vec<TrameEvent>, CommandError> {
        Self::validate_batch(&commands)?;
        let pre_batch = self.data.clone();
        self.apply_atomic(actor, commands, description.into(), pre_batch)
    }

    fn validate_batch(commands: &[TrameCommand]) -> Result<(), CommandError> {
        if commands.is_empty() {
            return Err(CommandError::InvalidConfiguration(
                "batch must contain at least one command".to_string(),
            ));
        }
        if let Some(index) = commands.iter().position(|cmd| {
            matches!(
                cmd,
                TrameCommand::UndoLastAction
                    | TrameCommand::CommitMcpStaging { .. }
                    | TrameCommand::RejectMcpStaging { .. }
            )
        }) {
            return Err(CommandError::BatchCommandFailed {
                index,
                source: Box::new(CommandError::InvalidConfiguration(
                    "undo and staging commands cannot be nested in a batch".to_string(),
                )),
            });
        }
        Ok(())
    }

    /// Runs pre-validated `commands` against the live state; on failure restores `restore_point`
    /// (which is also the composite undo snapshot on success).
    fn apply_atomic(
        &mut self,
        actor: &CommandActor,
        commands: Vec<TrameCommand>,
        description: String,
        restore_point: TableSnapshotData,
    ) -> Result<Vec<TrameEvent>, CommandError> {
        let saved_bvh = self.bvh.clone();
        let saved_cell_size_px = self.cell_size_px;
        let saved_undo = std::mem::take(&mut self.undo_stack);
        let mut events = Vec::new();
        for (index, cmd) in commands.into_iter().enumerate() {
            match self.apply_command(actor, cmd) {
                Ok(sub_events) => events.extend(sub_events),
                Err(source) => {
                    self.data = restore_point;
                    self.bvh = saved_bvh;
                    self.cell_size_px = saved_cell_size_px;
                    self.undo_stack = saved_undo;
                    return Err(CommandError::BatchCommandFailed {
                        index,
                        source: Box::new(source),
                    });
                }
            }
        }
        self.undo_stack = saved_undo;
        self.push_undo_snapshot(description, restore_point, saved_cell_size_px);
        Ok(events)
    }

    /// Footprint of `token` placed at `top_left` as `(min_x, min_y, max_x, max_y)` in pixels (`px`).
    fn footprint_px(&self, token: &TokenState, top_left: Point2D) -> (f64, f64, f64, f64) {
        let spatial = token.spatial_ref();
        (
            top_left.x,
            top_left.y,
            top_left.x + f64::from(spatial.grid_w.max(1)) * self.cell_size_px,
            top_left.y + f64::from(spatial.grid_h.max(1)) * self.cell_size_px,
        )
    }

    /// Returns `true` when `mover` (at `mover_top_left`, `mover_elev_ft`) is within `reactor`'s
    /// `reach_ft`, using 5e grid distance: edge-to-edge Chebyshev gap in cells plus one cell
    /// (adjacent = 5 ft), combined with the vertical gap between the two creatures' heights.
    fn is_within_reach(
        &self,
        reactor: &TokenState,
        mover: &TokenState,
        mover_top_left: Point2D,
        mover_elev_ft: f64,
    ) -> bool {
        let (ax0, ay0, ax1, ay1) = self.footprint_px(reactor, reactor.top_left);
        let (bx0, by0, bx1, by1) = self.footprint_px(mover, mover_top_left);
        let gap_x = (bx0 - ax1).max(ax0 - bx1).max(0.0);
        let gap_y = (by0 - ay1).max(ay0 - by1).max(0.0);
        let gap_cells = gap_x.max(gap_y) / self.cell_size_px.max(1e-9);
        let horizontal_ft = (gap_cells + 1.0) * self.feet_per_cell;
        let vertical_gap_ft = (mover_elev_ft - (reactor.elevation_ft + reactor.height_ft))
            .max(reactor.elevation_ft - (mover_elev_ft + mover.height_ft))
            .max(0.0);
        let distance_ft = horizontal_ft.max(vertical_gap_ft + self.feet_per_cell);
        distance_ft <= reactor.reach_ft + 1e-6
    }

    /// Finds the first hostile `ThreatReach` that `mover` leaves along the straight path to
    /// `to_top_left`, returning `(reactor_id, exit_top_left, exit_elevation_ft)`.
    ///
    /// Eligible reactors: hostile side, alive and above 0 HP, `has_reaction`, not GM-hidden
    /// (`CHANNEL_GM_HIDDEN`), not incapacitated (`is_incapacitated`), and not in `excluded`. The
    /// reactor must also see the mover at its last in-reach position (`can_token_see_target`:
    /// walls via the BVH, senses, channels, invisibility); ambient light level is not modelled,
    /// so darkness alone does not suppress the prompt. The path is sampled every 1/10 cell; a reactor triggers on the first
    /// out-of-reach sample that follows an in-reach sample, so passing through reach (enter then
    /// exit) prompts exactly like starting inside it. The exit point is the last in-reach sample
    /// snapped to the grid when the snapped square is still in reach. Ties on the exit sample go
    /// to the lowest reactor ID.
    fn find_threat_exit(
        &self,
        mover: &TokenState,
        to_top_left: Point2D,
        to_elev_ft: f64,
        excluded: &[Uuid],
    ) -> Option<(Uuid, Point2D, f64)> {
        let from = mover.top_left;
        let from_elev = mover.elevation_ft;
        let path_px = ((to_top_left.x - from.x).powi(2) + (to_top_left.y - from.y).powi(2)).sqrt();
        let step_px = (self.cell_size_px / 10.0).max(1e-3);
        let steps = ((path_px / step_px).ceil() as usize).max(1);
        let lerp = |t: f64| {
            (
                Point2D::new(
                    from.x + (to_top_left.x - from.x) * t,
                    from.y + (to_top_left.y - from.y) * t,
                ),
                from_elev + (to_elev_ft - from_elev) * t,
            )
        };

        let mut best: Option<(usize, Uuid)> = None;
        for reactor in self.data.tokens.values() {
            let eligible = reactor.id != mover.id
                && (reactor.owner_user_id.is_some() != mover.owner_user_id.is_some())
                && reactor.has_reaction
                && reactor.hp > 0
                && !reactor.is_dead
                && (reactor.visibility_channel & CHANNEL_GM_HIDDEN) == 0
                && !is_incapacitated(reactor)
                && !excluded.contains(&reactor.id);
            if !eligible {
                continue;
            }
            let mut was_inside = self.is_within_reach(reactor, mover, from, from_elev);
            let exit_step = (1..=steps).find(|&i| {
                let (pos, elev) = lerp(i as f64 / steps as f64);
                let inside = self.is_within_reach(reactor, mover, pos, elev);
                let exited = was_inside && !inside;
                was_inside = inside;
                exited
            });
            let sees_exit = |i: usize| {
                let (pos, elev) = lerp((i - 1) as f64 / steps as f64);
                can_token_see_target(
                    &self.bvh,
                    reactor.top_left,
                    reactor.grid_w,
                    reactor.grid_h,
                    reactor.elevation_ft + reactor.height_ft * 0.8,
                    &reactor.senses,
                    pos,
                    mover.grid_w,
                    mover.grid_h,
                    elev + mover.height_ft * 0.5,
                    mover.visibility_channel,
                    mover.invisible,
                    self.cell_size_px,
                    self.feet_per_cell,
                )
            };
            if let Some(i) = exit_step
                && best.is_none_or(|(best_i, _)| i < best_i)
                && sees_exit(i)
            {
                best = Some((i, reactor.id));
            }
        }

        let (exit_step, reactor_id) = best?;
        let reactor = &self.data.tokens[&reactor_id];
        let (last_inside, last_elev) = lerp((exit_step - 1) as f64 / steps as f64);
        let snapped = Point2D::new(
            (last_inside.x / self.cell_size_px).round() * self.cell_size_px,
            (last_inside.y / self.cell_size_px).round() * self.cell_size_px,
        );
        let exit = if self.is_within_reach(reactor, mover, snapped, last_elev) {
            snapped
        } else {
            last_inside
        };
        Some((reactor_id, exit, last_elev))
    }

    /// Rejects a straight move of `token` to `to_center` that crosses a movement-blocking wall
    /// overlapping the token's vertical span (ethereal tokens pass through).
    fn check_wall_collision(
        &self,
        token: &TokenState,
        to_top_left: Point2D,
        new_elev: f64,
    ) -> Result<(), CommandError> {
        let half_w = f64::from(token.grid_w.max(1)) * self.cell_size_px * 0.5;
        let half_h = f64::from(token.grid_h.max(1)) * self.cell_size_px * 0.5;
        let from_center = Point2D::new(token.top_left.x + half_w, token.top_left.y + half_h);
        let to_center = Point2D::new(to_top_left.x + half_w, to_top_left.y + half_h);
        let is_ethereal = (token.visibility_channel & CHANNEL_ETHEREAL) != 0;
        let check_elev = new_elev + token.height_ft * 0.5;

        if !is_ethereal {
            let token_bottom_ft = token.elevation_ft.min(new_elev);
            let token_top_ft = token.elevation_ft.max(new_elev) + token.height_ft.max(0.0);
            for wall in &self.data.walls {
                if !wall.is_blocking_movement() {
                    continue;
                }
                let elev_overlaps = token_bottom_ft <= wall.top_elevation_ft
                    && token_top_ft >= wall.bottom_elevation_ft
                    && check_elev >= wall.bottom_elevation_ft
                    && check_elev <= wall.top_elevation_ft;
                if elev_overlaps
                    && segment_intersects_segment(from_center, to_center, wall.a, wall.b)
                {
                    let hit_pt = segment_intersection(from_center, to_center, wall.a, wall.b)
                        .map(|(_, pt)| pt)
                        .unwrap_or(to_center);
                    return Err(CommandError::WallCollision {
                        x: hit_pt.x,
                        y: hit_pt.y,
                    });
                }
            }
        }

        if let Some(hit_pt) =
            self.bvh
                .check_movement_collision(from_center, to_center, check_elev, is_ethereal)
        {
            return Err(CommandError::WallCollision {
                x: hit_pt.x,
                y: hit_pt.y,
            });
        }
        Ok(())
    }

    /// Previews a straight `MoveToken` of `token` to `to_top_left` at `to_elevation_ft` with the
    /// exact wall-collision and movement-cost rules `MoveToken` enforces, without mutating state.
    /// Turn budget, turn order, and `ThreatReach` are not evaluated.
    pub fn preview_move(
        &self,
        token: &TokenState,
        to_top_left: Point2D,
        to_elevation_ft: f64,
    ) -> MovePreview {
        let collision = match self.check_wall_collision(token, to_top_left, to_elevation_ft) {
            Err(CommandError::WallCollision { x, y }) => Some(Point2D::new(x, y)),
            _ => None,
        };
        MovePreview {
            collision,
            cost_ft: self.movement_cost_ft(token, to_top_left, to_elevation_ft),
        }
    }

    /// Movement cost in feet (`ft`) of moving `token` from its position to `to_top_left` at
    /// `new_elev` on this table's grid and difficult terrain (`MovementGrid::movement_cost_ft`).
    fn movement_cost_ft(&self, token: &TokenState, to_top_left: Point2D, new_elev: f64) -> f64 {
        MovementGrid {
            cell_size_px: self.cell_size_px,
            feet_per_cell: self.feet_per_cell,
            difficult_terrain: &self.data.difficult_terrain,
        }
        .movement_cost_ft(
            &token.spatial_ref(),
            to_top_left,
            new_elev,
            token.is_squeezing,
        )
    }

    /// Moves `token_id` toward `to_top_left`, stopping on the first hostile `ThreatReach` exit
    /// (Turn-by-Turn, non-teleport only) and opening a `ReactionPrompt`. Deducts the cost of the
    /// distance actually travelled when `deduct_budget` is set. Callers validate walls and budget.
    fn move_token_with_threat_check(
        &mut self,
        token_id: Uuid,
        to_top_left: Point2D,
        new_elev: f64,
        check_threats: bool,
        deduct_budget: bool,
        excluded_reactors: Vec<Uuid>,
    ) -> Vec<TrameEvent> {
        let token = self.data.tokens[&token_id].clone();
        let threat = if check_threats && !token.disengaged {
            self.find_threat_exit(&token, to_top_left, new_elev, &excluded_reactors)
        } else {
            None
        };
        let (stop_top_left, stop_elev) = match threat {
            Some((_, exit, exit_elev)) => (exit, exit_elev),
            None => (to_top_left, new_elev),
        };
        let cost_ft = self.movement_cost_ft(&token, stop_top_left, stop_elev);

        let tok_mut = self.data.tokens.get_mut(&token_id).expect("token exists");
        let from_top_left = tok_mut.top_left;
        tok_mut.top_left = stop_top_left;
        tok_mut.elevation_ft = stop_elev;
        if deduct_budget {
            tok_mut.speed_remaining_ft = (tok_mut.speed_remaining_ft - cost_ft).max(0.0);
        }
        let mut events = vec![TrameEvent::TokenMoved {
            token_id,
            from_top_left,
            to_top_left: stop_top_left,
            elevation_ft: stop_elev,
            speed_remaining_ft: tok_mut.speed_remaining_ft,
        }];

        if let Some((reactor_id, _, _)) = threat {
            let mut resolved_reactor_ids = excluded_reactors;
            resolved_reactor_ids.push(reactor_id);
            let prompt_id = self.next_reaction_prompt_id(token_id, reactor_id);
            let prompt = ReactionPrompt {
                prompt_id,
                reactor_actor_id: reactor_id,
                trigger_token_id: token_id,
                pending_destination: Some(to_top_left),
                pending_elevation_ft: Some(new_elev),
                reactor_owner_user_id: self.data.tokens[&reactor_id].owner_user_id,
                resolved_reactor_ids,
                awaiting_resolution: false,
            };
            self.data
                .active_reaction_prompts
                .insert(prompt.prompt_id, prompt.clone());
            events.push(TrameEvent::ReactionPromptOpened { prompt });
        }
        events
    }

    /// Continues the movement interrupted by `prompt` toward its pending destination, skipping
    /// reactors in `resolved_reactor_ids`. Does nothing when the mover is gone, at 0 HP, or the
    /// remaining path is blocked by a wall or exceeds the Turn-by-Turn movement budget.
    fn resume_interrupted_move(&mut self, prompt: &ReactionPrompt) -> Vec<TrameEvent> {
        let Some(dest) = prompt.pending_destination else {
            return Vec::new();
        };
        let Some(mover) = self.data.tokens.get(&prompt.trigger_token_id).cloned() else {
            return Vec::new();
        };
        if mover.hp == 0 || mover.is_dead {
            return Vec::new();
        }
        let new_elev = prompt.pending_elevation_ft.unwrap_or(mover.elevation_ft);
        let in_combat = self.data.mode == TableMode::TurnByTurn;
        let cost_ft = self.movement_cost_ft(&mover, dest, new_elev);
        let path_still_valid = self.check_wall_collision(&mover, dest, new_elev).is_ok()
            && (!in_combat || cost_ft <= mover.speed_remaining_ft + 1e-6);
        if !path_still_valid {
            return Vec::new();
        }
        self.move_token_with_threat_check(
            prompt.trigger_token_id,
            dest,
            new_elev,
            in_combat,
            in_combat,
            prompt.resolved_reactor_ids.clone(),
        )
    }

    /// Derives the next `prompt_id` and bumps `reaction_prompt_seq`.
    ///
    /// `prompt_id` reaches players who can see the mover, so it must not reveal the reactor
    /// (which may be GM-hidden). It is the first 16 bytes of
    /// `SHA-256("trame/reaction-prompt/v1" || mover || reactor || round_be || seq_be)` stamped as a
    /// UUIDv8: one-way, distinct across rounds and repeated prompts, and deterministic so WAL
    /// replay of the same commands reproduces the same IDs.
    fn next_reaction_prompt_id(&mut self, mover_id: Uuid, reactor_id: Uuid) -> Uuid {
        let seq = self.data.reaction_prompt_seq;
        self.data.reaction_prompt_seq += 1;
        let digest = Sha256::new()
            .chain_update(b"trame/reaction-prompt/v1")
            .chain_update(mover_id.as_bytes())
            .chain_update(reactor_id.as_bytes())
            .chain_update(self.data.round.to_be_bytes())
            .chain_update(seq.to_be_bytes())
            .finalize();
        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        uuid::Builder::from_custom_bytes(bytes).into_uuid()
    }

    /// Starts `token_id`'s turn: full speed, action, bonus action, and reaction. Also ends every
    /// Disengage, which lasts only until the end of the turn it was taken in.
    fn reset_turn_resources(&mut self, token_id: Uuid) {
        self.clear_disengaged();
        if let Some(tok) = self.data.tokens.get_mut(&token_id) {
            tok.speed_remaining_ft = tok.speed_max_ft;
            tok.has_action = true;
            tok.has_bonus_action = true;
            tok.has_reaction = true;
        }
    }

    fn clear_disengaged(&mut self) {
        for tok in self.data.tokens.values_mut() {
            tok.disengaged = false;
        }
    }

    /// Emits `ReactionPromptOpened` for prompts that undo restored or changed and
    /// `ReactionPromptClosed { Undone }` for prompts it removed, so clients that track prompts
    /// from events match the restored state.
    fn reaction_prompt_undo_diff(
        before: &BTreeMap<Uuid, ReactionPrompt>,
        after: &BTreeMap<Uuid, ReactionPrompt>,
    ) -> Vec<TrameEvent> {
        let closed = before
            .keys()
            .filter(|id| !after.contains_key(id))
            .map(|&prompt_id| TrameEvent::ReactionPromptClosed {
                prompt_id,
                reason: ReactionPromptCloseReason::Undone,
            });
        let opened = after
            .iter()
            .filter(|(id, prompt)| before.get(id) != Some(prompt))
            .map(|(_, prompt)| TrameEvent::ReactionPromptOpened {
                prompt: prompt.clone(),
            });
        closed.chain(opened).collect()
    }

    /// Removes every reaction prompt matching `stale`, emitting `ReactionPromptClosed { Stale }`.
    fn close_stale_prompts(&mut self, stale: impl Fn(&ReactionPrompt) -> bool) -> Vec<TrameEvent> {
        let ids: Vec<Uuid> = self
            .data
            .active_reaction_prompts
            .values()
            .filter(|p| stale(p))
            .map(|p| p.prompt_id)
            .collect();
        ids.into_iter()
            .map(|prompt_id| {
                self.data.active_reaction_prompts.remove(&prompt_id);
                TrameEvent::ReactionPromptClosed {
                    prompt_id,
                    reason: ReactionPromptCloseReason::Stale,
                }
            })
            .collect()
    }

    /// Re-sorts `initiative_order` by total (desc), `dex_mod` (desc), token ID (asc), keeping the
    /// active combatant on the turn.
    fn sort_initiative_order(&mut self) {
        let active = self.active_turn_token_id();
        let data = &mut self.data;
        let key = |id: &Uuid| {
            let total = data.initiative_totals.get(id).copied();
            let dex = data.tokens.get(id).map_or(0, |t| t.dex_mod);
            (
                std::cmp::Reverse(total.is_some()),
                std::cmp::Reverse(total.unwrap_or(0)),
                std::cmp::Reverse(dex),
                *id,
            )
        };
        let mut order = data.initiative_order.clone();
        order.sort_by_key(key);
        data.initiative_order = order;
        if let Some(active_id) = active
            && let Some(idx) = data.initiative_order.iter().position(|id| *id == active_id)
        {
            data.active_turn_index = idx;
        }
    }

    fn require_gm(actor: &CommandActor) -> Result<(), CommandError> {
        if actor.role == CampaignRole::Gm {
            Ok(())
        } else {
            Err(CommandError::PermissionDenied(
                "GM role required for this command".to_string(),
            ))
        }
    }

    fn require_token_control(
        &self,
        actor: &CommandActor,
        token_id: Uuid,
    ) -> Result<&TokenState, CommandError> {
        let token = self
            .data
            .tokens
            .get(&token_id)
            .ok_or_else(|| CommandError::NotFound(format!("token {token_id}")))?;
        match actor.role {
            CampaignRole::Gm => Ok(token),
            CampaignRole::Player if token.owner_user_id == Some(actor.user_id) => Ok(token),
            _ => Err(CommandError::PermissionDenied(
                "you do not control this token".to_string(),
            )),
        }
    }

    /// Executes a `TrameCommand` atomically, enforcing RBAC, spatial BVH collision,
    /// turn-order movement budgets, and pushing a compensating `UndoEntry` onto `undo_stack`.
    ///
    /// Fails closed without mutating `self.data` or `self.undo_stack` whenever any precondition fails.
    pub fn apply_command(
        &mut self,
        actor: &CommandActor,
        cmd: TrameCommand,
    ) -> Result<Vec<TrameEvent>, CommandError> {
        match cmd {
            TrameCommand::MoveToken {
                token_id,
                to_top_left,
                to_elevation_ft,
                gm_teleport,
            } => {
                let token = self.require_token_control(actor, token_id)?.clone();
                let is_gm_teleport = gm_teleport && actor.role == CampaignRole::Gm;

                if !is_gm_teleport {
                    if self.data.mode == TableMode::Exploration
                        && self.data.exploration_paused
                        && actor.role != CampaignRole::Gm
                    {
                        return Err(CommandError::ExplorationPaused);
                    }
                    if self.data.mode == TableMode::TurnByTurn
                        && actor.role != CampaignRole::Gm
                        && self.active_turn_token_id() != Some(token_id)
                    {
                        return Err(CommandError::NotActiveTurn);
                    }
                    if actor.role != CampaignRole::Gm
                        && self
                            .data
                            .active_reaction_prompts
                            .values()
                            .any(|p| p.trigger_token_id == token_id)
                    {
                        return Err(CommandError::ReactionPending);
                    }
                }

                let new_elev = to_elevation_ft.unwrap_or(token.elevation_ft);
                let in_combat = self.data.mode == TableMode::TurnByTurn;
                if !is_gm_teleport {
                    self.check_wall_collision(&token, to_top_left, new_elev)?;
                    let cost_ft = self.movement_cost_ft(&token, to_top_left, new_elev);
                    if in_combat && cost_ft > token.speed_remaining_ft + 1e-6 {
                        return Err(CommandError::InsufficientMovement {
                            needed_ft: cost_ft,
                            remaining_ft: token.speed_remaining_ft,
                        });
                    }
                }

                self.push_undo(format!("Move token {}", token.name));
                let mut events = self.close_stale_prompts(|p| p.trigger_token_id == token_id);
                let engaged = !is_gm_teleport && in_combat;
                events.extend(self.move_token_with_threat_check(
                    token_id,
                    to_top_left,
                    new_elev,
                    engaged,
                    engaged,
                    Vec::new(),
                ));
                Ok(events)
            }

            TrameCommand::SetDisengaged {
                token_id,
                disengaged,
            } => {
                let token = self.require_token_control(actor, token_id)?.clone();
                self.push_undo(format!("Set Disengage for {}", token.name));
                let tok_mut = self.data.tokens.get_mut(&token_id).expect("token exists");
                tok_mut.disengaged = disengaged;
                Ok(vec![TrameEvent::TokenDisengaged {
                    token_id,
                    disengaged,
                }])
            }

            TrameCommand::SetTokenConditions {
                token_id,
                conditions,
            } => {
                let name = self.require_token_control(actor, token_id)?.name.clone();
                if conditions.len() > MAX_TOKEN_CONDITIONS {
                    return Err(CommandError::InvalidConfiguration(format!(
                        "at most {MAX_TOKEN_CONDITIONS} conditions per token"
                    )));
                }
                let mut normalized: Vec<String> = Vec::with_capacity(conditions.len());
                for raw in &conditions {
                    let id = normalize_override_id(OverrideSubject::Condition, raw)?;
                    if !normalized.contains(&id) {
                        normalized.push(id);
                    }
                }
                self.push_undo(format!("Set conditions for {name}"));
                let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
                tok.conditions = normalized.clone();
                Ok(vec![TrameEvent::TokenConditionsChanged {
                    token_id,
                    conditions: normalized,
                    effective_conditions: tok.effective_conditions(),
                }])
            }

            TrameCommand::ConditionOverride {
                token_id,
                subject,
                id,
                mode,
            } => {
                Self::require_gm(actor)?;
                let token = self
                    .data
                    .tokens
                    .get(&token_id)
                    .ok_or_else(|| CommandError::NotFound(format!("token {token_id}")))?;
                let id = normalize_override_id(subject, &id)?;
                let existing = token
                    .condition_overrides
                    .iter()
                    .position(|o| o.subject == subject && o.id == id);
                if mode.is_some()
                    && existing.is_none()
                    && token.condition_overrides.len() >= MAX_TOKEN_CONDITIONS
                {
                    return Err(CommandError::InvalidConfiguration(format!(
                        "at most {MAX_TOKEN_CONDITIONS} overrides per token"
                    )));
                }
                let description = format!("Override {id} on {}", token.name);
                self.push_undo(description);
                let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
                match (mode, existing) {
                    (Some(mode), Some(idx)) => tok.condition_overrides[idx].mode = mode,
                    (Some(mode), None) => {
                        tok.condition_overrides
                            .push(ConditionOverrideEntry { subject, id, mode })
                    }
                    (None, Some(idx)) => {
                        tok.condition_overrides.remove(idx);
                    }
                    (None, None) => {}
                }
                Ok(vec![TrameEvent::ConditionOverrideChanged {
                    token_id,
                    overrides: tok.condition_overrides.clone(),
                    effective_conditions: tok.effective_conditions(),
                }])
            }

            TrameCommand::ToggleSqueeze {
                token_id,
                is_squeezing,
            } => {
                let token = self.require_token_control(actor, token_id)?.clone();
                self.push_undo(format!("Toggle squeeze for {}", token.name));
                let tok_mut = self.data.tokens.get_mut(&token_id).expect("token exists");
                tok_mut.is_squeezing = is_squeezing;
                Ok(vec![TrameEvent::TokenSqueezeToggled {
                    token_id,
                    is_squeezing,
                    speed_remaining_ft: tok_mut.speed_remaining_ft,
                }])
            }

            TrameCommand::ToggleDoor { wall_id, is_open } => {
                if actor.role == CampaignRole::Spectator {
                    return Err(CommandError::PermissionDenied(
                        "spectators cannot toggle doors".to_string(),
                    ));
                }
                let idx = self
                    .data
                    .walls
                    .iter()
                    .position(|w| w.id == wall_id)
                    .ok_or_else(|| CommandError::NotFound(format!("wall {wall_id}")))?;

                match &self.data.walls[idx].kind {
                    WallKind::Door { is_locked, .. } => {
                        if *is_locked && actor.role != CampaignRole::Gm {
                            return Err(CommandError::DoorLocked);
                        }
                    }
                    WallKind::SecretDoor { .. } => {
                        Self::require_gm(actor)?;
                    }
                    _ => {
                        return Err(CommandError::PermissionDenied(
                            "wall is not a door".to_string(),
                        ));
                    }
                }

                self.push_undo(format!("Toggle door {wall_id}"));
                match &mut self.data.walls[idx].kind {
                    WallKind::Door {
                        is_open: open_ref, ..
                    }
                    | WallKind::SecretDoor { is_open: open_ref } => {
                        *open_ref = is_open;
                    }
                    _ => {}
                }
                self.bvh = Bvh2D::build(self.data.walls.clone());

                Ok(vec![TrameEvent::DoorToggled { wall_id, is_open }])
            }

            TrameCommand::SetTableMode {
                mode,
                exploration_paused,
                initiative_order,
                mut initiative_totals,
            } => {
                Self::require_gm(actor)?;
                self.push_undo("Change table mode");
                self.data.mode = mode;
                self.data.exploration_paused = exploration_paused;
                initiative_totals.retain(|id, _| initiative_order.contains(id));
                self.data.initiative_totals = initiative_totals;
                self.data.initiative_order = initiative_order;
                self.data.active_turn_index = 0;
                self.data.round = 1;
                if let Some(first_id) = self.active_turn_token_id() {
                    self.reset_turn_resources(first_id);
                }
                let mut events = vec![TrameEvent::TableModeChanged {
                    mode,
                    exploration_paused,
                    active_turn_token_id: self.active_turn_token_id(),
                    round: self.data.round,
                }];
                if mode != TableMode::TurnByTurn {
                    events.extend(self.close_stale_prompts(|_| true));
                }
                Ok(events)
            }

            TrameCommand::StartTurnByTurn {
                initiative_order,
                mut initiative_totals,
            } => {
                Self::require_gm(actor)?;
                self.push_undo("Start Turn-by-Turn mode");
                self.data.mode = TableMode::TurnByTurn;
                self.data.exploration_paused = false;
                initiative_totals.retain(|id, _| initiative_order.contains(id));
                self.data.initiative_totals = initiative_totals;
                self.data.initiative_order = initiative_order;
                self.data.active_turn_index = 0;
                self.data.round = 1;
                if let Some(first_id) = self.active_turn_token_id() {
                    self.reset_turn_resources(first_id);
                }
                Ok(vec![TrameEvent::TableModeChanged {
                    mode: TableMode::TurnByTurn,
                    exploration_paused: false,
                    active_turn_token_id: self.active_turn_token_id(),
                    round: self.data.round,
                }])
            }

            TrameCommand::EndTurnByTurn => {
                Self::require_gm(actor)?;
                self.push_undo("End Turn-by-Turn mode");
                self.clear_disengaged();
                self.data.mode = TableMode::Exploration;
                self.data.exploration_paused = false;
                self.data.initiative_order.clear();
                self.data.initiative_totals.clear();
                self.data.active_turn_index = 0;
                self.data.round = 1;
                let mut events = vec![TrameEvent::TableModeChanged {
                    mode: TableMode::Exploration,
                    exploration_paused: false,
                    active_turn_token_id: None,
                    round: 1,
                }];
                events.extend(self.close_stale_prompts(|_| true));
                Ok(events)
            }

            TrameCommand::SetInitiativeTotal { token_id, total } => {
                Self::require_gm(actor)?;
                if !self.data.initiative_order.contains(&token_id) {
                    return Err(CommandError::NotFound(format!(
                        "token {token_id} in initiative order"
                    )));
                }
                self.push_undo(format!("Set initiative total for {token_id}"));
                self.data.initiative_totals.insert(token_id, total);
                self.sort_initiative_order();
                Ok(vec![TrameEvent::InitiativeUpdated {
                    initiative_order: self.data.initiative_order.clone(),
                    initiative_totals: self.data.initiative_totals.clone(),
                    active_turn_token_id: self.active_turn_token_id(),
                }])
            }

            TrameCommand::AdvanceTurn => {
                if actor.role == CampaignRole::Spectator {
                    return Err(CommandError::PermissionDenied(
                        "spectators cannot advance turns".to_string(),
                    ));
                }
                if actor.role == CampaignRole::Player {
                    let Some(active_id) = self.active_turn_token_id() else {
                        return Err(CommandError::NotActiveTurn);
                    };
                    self.require_token_control(actor, active_id)?;
                }

                self.push_undo("Advance combat turn");
                if !self.data.initiative_order.is_empty() {
                    self.data.active_turn_index += 1;
                    if self.data.active_turn_index >= self.data.initiative_order.len() {
                        self.data.active_turn_index = 0;
                        self.data.round += 1;
                    }
                    if let Some(next_id) = self.active_turn_token_id() {
                        self.reset_turn_resources(next_id);
                    }
                }
                Ok(vec![TrameEvent::TurnAdvanced {
                    active_turn_token_id: self.active_turn_token_id(),
                    round: self.data.round,
                }])
            }

            TrameCommand::ApplyDamage {
                token_id,
                raw_damage,
                affinity,
                is_critical,
                damage_type,
            } => {
                let token = self.require_token_control(actor, token_id)?.clone();
                let affinity = damage_type
                    .as_deref()
                    .map_or(affinity, |t| token.damage_affinity_for(t));

                self.push_undo(format!("Apply {raw_damage} damage to {}", token.name));
                let is_concentrating = token.concentrating_on_aoe_id.is_some();
                let mut resolution = resolve_damage_application(
                    raw_damage,
                    affinity,
                    token.hp,
                    token.max_hp,
                    token.temp_hp,
                    is_concentrating,
                    is_critical,
                    token.death_save_failures,
                );
                // 5e: monsters die at 0 HP instead of making death saves. Synthetic GM tokens
                // (no player owner, no linked actor) follow that default; the GM can revive one
                // with `GmOverrideTokenResources`.
                if resolution.new_hp == 0
                    && token.owner_user_id.is_none()
                    && token.actor_id.is_none()
                {
                    resolution.dead = true;
                    resolution.unconscious = false;
                }

                let tok_mut = self.data.tokens.get_mut(&token_id).expect("token exists");
                tok_mut.hp = resolution.new_hp;
                tok_mut.temp_hp = resolution.new_temp_hp;
                tok_mut.death_save_failures = resolution.new_death_save_failures;
                tok_mut.is_dead |= resolution.dead;

                let mut events = vec![TrameEvent::DamageApplied {
                    token_id,
                    resolution: resolution.clone(),
                }];

                // If the caster dropped to 0 HP, concentration breaks automatically
                if resolution.new_hp == 0
                    && let Some(aoe_id) = tok_mut.concentrating_on_aoe_id.take()
                {
                    self.data.persistent_aoes.remove(&aoe_id);
                    events.push(TrameEvent::ConcentrationBroken {
                        caster_token_id: token_id,
                        removed_aoe_id: Some(aoe_id),
                    });
                }

                Ok(events)
            }

            TrameCommand::HealActor { token_id, amount } => {
                let token = self.require_token_control(actor, token_id)?.clone();
                if amount < 0 {
                    return Err(CommandError::InvalidConfiguration(
                        "healing amount must be >= 0".to_string(),
                    ));
                }
                if token.is_dead {
                    return Err(CommandError::InvalidConfiguration(
                        "dead creatures cannot be healed".to_string(),
                    ));
                }
                self.push_undo(format!("Heal {} by {amount}", token.name));
                let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
                let new_hp = tok.hp.saturating_add(amount).min(tok.max_hp);
                let hp_restored = (new_hp - tok.hp).max(0);
                if hp_restored > 0 {
                    tok.hp = new_hp;
                    tok.death_save_successes = 0;
                    tok.death_save_failures = 0;
                }
                Ok(vec![TrameEvent::TokenHealed {
                    token_id,
                    hp_restored,
                    new_hp: tok.hp,
                }])
            }

            TrameCommand::ClearAoe { aoe_id } => {
                let caster_token_id = self
                    .data
                    .persistent_aoes
                    .get(&aoe_id)
                    .ok_or_else(|| CommandError::NotFound(format!("aoe {aoe_id}")))?
                    .concentration_caster_id;
                if actor.role != CampaignRole::Gm {
                    let Some(caster_id) = caster_token_id else {
                        return Err(CommandError::PermissionDenied(
                            "GM role required to clear this AoE".to_string(),
                        ));
                    };
                    self.require_token_control(actor, caster_id)?;
                }
                self.push_undo(format!("Clear AoE {aoe_id}"));
                self.data.persistent_aoes.remove(&aoe_id);
                if let Some(caster_id) = caster_token_id
                    && let Some(caster) = self.data.tokens.get_mut(&caster_id)
                    && caster.concentrating_on_aoe_id == Some(aoe_id)
                {
                    caster.concentrating_on_aoe_id = None;
                }
                Ok(vec![TrameEvent::AoeCleared {
                    aoe_id,
                    caster_token_id,
                }])
            }

            TrameCommand::RefundAction { token_id, resource } => {
                Self::require_gm(actor)?;
                if !self.data.tokens.contains_key(&token_id) {
                    return Err(CommandError::NotFound(format!("token {token_id}")));
                }
                self.push_undo(format!("Refund {resource:?} for {token_id}"));
                let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
                match resource {
                    RefundableResource::Action => tok.has_action = true,
                    RefundableResource::BonusAction => tok.has_bonus_action = true,
                    RefundableResource::Reaction => tok.has_reaction = true,
                    RefundableResource::Movement => tok.speed_remaining_ft = tok.speed_max_ft,
                }
                Ok(vec![TrameEvent::ActionRefunded { token_id, resource }])
            }

            TrameCommand::GmOverrideTokenResources {
                token_id,
                hp,
                temp_hp,
                speed_remaining_ft,
                has_action,
                has_bonus_action,
                has_reaction,
            } => {
                Self::require_gm(actor)?;
                let token_name = self
                    .data
                    .tokens
                    .get(&token_id)
                    .ok_or_else(|| CommandError::NotFound(format!("token {token_id}")))?
                    .name
                    .clone();
                self.push_undo(format!("GM override resources for {token_name}"));
                let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
                if let Some(v) = hp {
                    tok.hp = v.clamp(0, tok.max_hp);
                    if tok.hp > 0 {
                        tok.is_dead = false;
                        tok.death_save_successes = 0;
                        tok.death_save_failures = 0;
                    }
                }
                if let Some(v) = temp_hp {
                    tok.temp_hp = v.max(0);
                }
                if let Some(v) = speed_remaining_ft {
                    tok.speed_remaining_ft = v.max(0.0);
                }
                if let Some(v) = has_action {
                    tok.has_action = v;
                }
                if let Some(v) = has_bonus_action {
                    tok.has_bonus_action = v;
                }
                if let Some(v) = has_reaction {
                    tok.has_reaction = v;
                }
                Ok(vec![TrameEvent::TokenResourcesOverridden {
                    token_id,
                    hp: tok.hp,
                    temp_hp: tok.temp_hp,
                    speed_remaining_ft: tok.speed_remaining_ft,
                    has_action: tok.has_action,
                    has_bonus_action: tok.has_bonus_action,
                    has_reaction: tok.has_reaction,
                    is_dead: tok.is_dead,
                }])
            }

            TrameCommand::ProjectAoe {
                template,
                persist_zone,
            } => {
                if actor.role == CampaignRole::Spectator {
                    return Err(CommandError::PermissionDenied(
                        "spectators cannot project AoE".to_string(),
                    ));
                }
                self.push_undo("Project AoE template");
                let spatial_refs: Vec<TokenSpatialRef> = self
                    .data
                    .tokens
                    .values()
                    .map(TokenState::spatial_ref)
                    .collect();
                let (affected_cells, affected_token_ids) = template.evaluate_targets(
                    &spatial_refs,
                    self.cell_size_px,
                    self.feet_per_cell,
                    &self.bvh,
                );

                let mut extra_events = Vec::new();
                if persist_zone {
                    if let Some(caster_id) = template.concentration_caster_id
                        && let Some(caster) = self.data.tokens.get_mut(&caster_id)
                        && let Some(old_aoe) = caster.concentrating_on_aoe_id.replace(template.id)
                    {
                        self.data.persistent_aoes.remove(&old_aoe);
                        extra_events.push(TrameEvent::ConcentrationBroken {
                            caster_token_id: caster_id,
                            removed_aoe_id: Some(old_aoe),
                        });
                    }
                    self.data
                        .persistent_aoes
                        .insert(template.id, template.clone());
                }

                let mut events = extra_events;
                events.push(TrameEvent::AoeProjected {
                    template,
                    affected_cells,
                    affected_token_ids,
                    persisted: persist_zone,
                });
                Ok(events)
            }

            TrameCommand::BreakConcentration { caster_token_id } => {
                self.require_token_control(actor, caster_token_id)?;
                self.push_undo("Break concentration");
                let tok = self
                    .data
                    .tokens
                    .get_mut(&caster_token_id)
                    .expect("token exists");
                let removed_aoe_id = tok.concentrating_on_aoe_id.take();
                if let Some(aoe_id) = removed_aoe_id {
                    self.data.persistent_aoes.remove(&aoe_id);
                }
                Ok(vec![TrameEvent::ConcentrationBroken {
                    caster_token_id,
                    removed_aoe_id,
                }])
            }

            TrameCommand::SetAmbientLighting { preset } => {
                Self::require_gm(actor)?;
                self.push_undo("Change ambient lighting");
                self.data.ambient_lighting = preset;
                Ok(vec![TrameEvent::AmbientLightingChanged { preset }])
            }

            TrameCommand::LoadScene {
                scene_id,
                map_asset_id,
                width_px,
                height_px,
                pixels_per_grid,
                walls,
            } => {
                Self::require_gm(actor)?;
                if pixels_per_grid <= 0.0 || width_px == 0 || height_px == 0 {
                    return Err(CommandError::InvalidConfiguration(
                        "Scene dimensions and pixels_per_grid must be positive".to_string(),
                    ));
                }
                self.push_undo("Load scene");
                self.cell_size_px = pixels_per_grid;
                self.data.background_asset_hash = Some(map_asset_id.clone());
                self.data.map_width_px = width_px;
                self.data.map_height_px = height_px;
                self.data.walls = walls;
                self.data.persistent_aoes.clear();
                self.data.difficult_terrain.clear();
                self.bvh = Bvh2D::build(self.data.walls.clone());

                Ok(vec![TrameEvent::SceneLoaded {
                    scene_id,
                    map_asset_id,
                    width_px,
                    height_px,
                    pixels_per_grid,
                }])
            }

            TrameCommand::ActivateScene { scene_id, scene } => {
                Self::require_gm(actor)?;
                let Some(scene) = scene else {
                    return Err(CommandError::InvalidConfiguration(
                        "ActivateScene requires the server-resolved scene payload".to_string(),
                    ));
                };
                if scene.pixels_per_grid <= 0.0 || scene.width_px == 0 || scene.height_px == 0 {
                    return Err(CommandError::InvalidConfiguration(
                        "Scene dimensions and pixels_per_grid must be positive".to_string(),
                    ));
                }
                let hero_token_ids: Vec<Uuid> = self
                    .data
                    .tokens
                    .values()
                    .filter(|t| t.owner_user_id.is_some())
                    .map(|t| t.id)
                    .collect();
                if let Some(clash) = scene
                    .staged_tokens
                    .iter()
                    .find(|t| hero_token_ids.contains(&t.id))
                {
                    return Err(CommandError::InvalidConfiguration(format!(
                        "staged token {} collides with a hero token",
                        clash.id
                    )));
                }

                self.push_undo(format!("Activate scene {scene_id}"));
                self.data.tokens.retain(|_, t| t.owner_user_id.is_some());
                for (hero_id, spawn) in hero_token_ids.iter().zip(&scene.hero_spawn_points) {
                    let hero = self.data.tokens.get_mut(hero_id).expect("hero kept");
                    hero.top_left = *spawn;
                }
                for hero in self.data.tokens.values_mut() {
                    hero.concentrating_on_aoe_id = None;
                }
                let spawned_token_ids: Vec<Uuid> =
                    scene.staged_tokens.iter().map(|t| t.id).collect();
                for staged in scene.staged_tokens {
                    self.data.tokens.insert(staged.id, staged);
                }

                self.cell_size_px = scene.pixels_per_grid;
                self.data.background_asset_hash = scene.map_asset_id.clone();
                self.data.map_width_px = scene.width_px;
                self.data.map_height_px = scene.height_px;
                self.data.walls = scene.walls;
                self.data.lights = scene.lights;
                self.data.fog_overrides.clear();
                self.data.difficult_terrain.clear();
                self.data.persistent_aoes.clear();
                self.data.active_reaction_prompts.clear();
                self.data.mode = TableMode::Exploration;
                self.data.exploration_paused = false;
                self.data.initiative_order.clear();
                self.data.initiative_totals.clear();
                self.data.active_turn_index = 0;
                self.data.round = 1;
                self.bvh = Bvh2D::build(self.data.walls.clone());

                Ok(vec![TrameEvent::SceneActivated {
                    scene_id,
                    map_asset_id: scene.map_asset_id,
                    width_px: scene.width_px,
                    height_px: scene.height_px,
                    pixels_per_grid: scene.pixels_per_grid,
                    hero_token_ids,
                    spawned_token_ids,
                }])
            }

            TrameCommand::SpawnToken { token } => {
                Self::require_gm(actor)?;
                self.push_undo(format!("Spawn token {}", token.name));
                self.data.tokens.insert(token.id, (*token).clone());
                Ok(vec![TrameEvent::TokenSpawned { token }])
            }

            TrameCommand::RemoveToken { token_id } => {
                Self::require_gm(actor)?;
                if !self.data.tokens.contains_key(&token_id) {
                    return Err(CommandError::NotFound(format!("token {token_id}")));
                }
                self.push_undo(format!("Remove token {token_id}"));
                self.data.tokens.remove(&token_id);
                self.data.initiative_totals.remove(&token_id);
                let removed_pos = self
                    .data
                    .initiative_order
                    .iter()
                    .position(|id| *id == token_id);
                let mut events = vec![TrameEvent::TokenRemoved { token_id }];
                if let Some(pos) = removed_pos {
                    self.data.initiative_order.remove(pos);
                    let active = self.data.active_turn_index;
                    if pos < active {
                        self.data.active_turn_index = active - 1;
                    } else if pos == active {
                        // The next combatant slid into the active slot; wrapping starts a round.
                        if active >= self.data.initiative_order.len() {
                            self.data.active_turn_index = 0;
                            if !self.data.initiative_order.is_empty() {
                                self.data.round += 1;
                            }
                        }
                        if let Some(next_id) = self.active_turn_token_id() {
                            self.reset_turn_resources(next_id);
                        }
                        events.push(TrameEvent::TurnAdvanced {
                            active_turn_token_id: self.active_turn_token_id(),
                            round: self.data.round,
                        });
                    }
                }
                events.extend(self.close_stale_prompts(|p| {
                    p.trigger_token_id == token_id || p.reactor_actor_id == token_id
                }));
                Ok(events)
            }

            TrameCommand::AddWall { wall } => {
                Self::require_gm(actor)?;
                self.push_undo(format!("Add wall {}", wall.id));
                if let Some(existing) = self.data.walls.iter_mut().find(|w| w.id == wall.id) {
                    *existing = wall.clone();
                } else {
                    self.data.walls.push(wall.clone());
                }
                self.bvh = Bvh2D::build(self.data.walls.clone());
                Ok(vec![TrameEvent::WallAdded { wall }])
            }

            TrameCommand::AddLight { light } => {
                Self::require_gm(actor)?;
                self.push_undo(format!("Add light {}", light.id));
                if let Some(existing) = self.data.lights.iter_mut().find(|l| l.id == light.id) {
                    *existing = light.clone();
                } else {
                    self.data.lights.push(light.clone());
                }
                Ok(vec![TrameEvent::LightAdded { light }])
            }

            TrameCommand::SetFogOverride {
                mode,
                cell_x,
                cell_y,
            } => {
                Self::require_gm(actor)?;
                self.push_undo(format!("Set fog override ({cell_x}, {cell_y})"));
                self.data
                    .fog_overrides
                    .retain(|cell| !(cell.cell_x == cell_x && cell.cell_y == cell_y));
                if mode != FogOverrideMode::Clear {
                    self.data.fog_overrides.push(FogOverrideCell {
                        cell_x,
                        cell_y,
                        mode,
                    });
                }
                Ok(vec![TrameEvent::FogOverrideChanged {
                    mode,
                    cell_x,
                    cell_y,
                }])
            }

            TrameCommand::SetDifficultTerrain { cells, difficult } => {
                Self::require_gm(actor)?;
                if cells.is_empty() {
                    return Err(CommandError::InvalidConfiguration(
                        "difficult terrain cells must not be empty".to_string(),
                    ));
                }
                let cell_px = self.cell_size_px.max(1e-9);
                let cols = (f64::from(self.data.map_width_px) / cell_px).ceil() as i32;
                let rows = (f64::from(self.data.map_height_px) / cell_px).ceil() as i32;
                if let Some(off_map) = cells
                    .iter()
                    .find(|c| !(0..cols).contains(&c.col) || !(0..rows).contains(&c.row))
                {
                    return Err(CommandError::InvalidConfiguration(format!(
                        "cell ({}, {}) is outside the {cols}x{rows} map grid",
                        off_map.col, off_map.row
                    )));
                }
                self.push_undo(if difficult {
                    "Paint difficult terrain"
                } else {
                    "Erase difficult terrain"
                });
                for cell in &cells {
                    if difficult {
                        self.data.difficult_terrain.insert(*cell);
                    } else {
                        self.data.difficult_terrain.remove(cell);
                    }
                }
                Ok(vec![TrameEvent::DifficultTerrainChanged {
                    cells,
                    difficult,
                }])
            }

            TrameCommand::SetMapConfig {
                background_url,
                width_ft,
                height_ft,
            } => {
                Self::require_gm(actor)?;
                if width_ft == 0 || height_ft == 0 {
                    return Err(CommandError::InvalidConfiguration(
                        "Map width_ft and height_ft must be positive".to_string(),
                    ));
                }
                self.push_undo("Configure map dimensions and background");
                let px_per_ft = self.cell_size_px / self.feet_per_cell.max(1.0);
                self.data.background_asset_hash = background_url.clone();
                self.data.map_width_px = (f64::from(width_ft) * px_per_ft).round().max(1.0) as u32;
                self.data.map_height_px =
                    (f64::from(height_ft) * px_per_ft).round().max(1.0) as u32;
                Ok(vec![TrameEvent::MapConfigChanged {
                    background_url,
                    width_ft,
                    height_ft,
                }])
            }

            TrameCommand::SetTokenVisibility {
                token_id,
                gm_hidden,
                invisible,
            } => {
                Self::require_gm(actor)?;
                if !self.data.tokens.contains_key(&token_id) {
                    return Err(CommandError::NotFound(format!("token {token_id}")));
                }
                self.push_undo(format!("Set token visibility {token_id}"));
                let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
                if gm_hidden {
                    tok.visibility_channel |= CHANNEL_GM_HIDDEN;
                } else {
                    tok.visibility_channel &= !CHANNEL_GM_HIDDEN;
                    if tok.visibility_channel == 0 {
                        tok.visibility_channel = CHANNEL_MATERIAL;
                    }
                }
                tok.invisible = invisible;
                let visibility_channel = tok.visibility_channel;
                Ok(vec![TrameEvent::TokenVisibilityChanged {
                    token_id,
                    visibility_channel,
                    invisible,
                }])
            }

            TrameCommand::AssignTokenOwner {
                token_id,
                owner_user_id,
            } => {
                Self::require_gm(actor)?;
                if !self.data.tokens.contains_key(&token_id) {
                    return Err(CommandError::NotFound(format!("token {token_id}")));
                }
                self.push_undo(format!("Assign token owner {token_id}"));
                let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
                tok.owner_user_id = owner_user_id;
                Ok(vec![TrameEvent::TokenOwnerAssigned {
                    token_id,
                    owner_user_id,
                }])
            }

            TrameCommand::ConfigureDoor {
                wall_id,
                is_open,
                is_locked,
                is_secret,
            } => {
                Self::require_gm(actor)?;
                let idx = self
                    .data
                    .walls
                    .iter()
                    .position(|w| w.id == wall_id)
                    .ok_or_else(|| CommandError::NotFound(format!("wall {wall_id}")))?;

                let (mut cur_open, mut cur_locked, mut cur_secret) =
                    match &self.data.walls[idx].kind {
                        WallKind::Door {
                            is_open: o,
                            is_locked: l,
                        } => (*o, *l, false),
                        WallKind::SecretDoor { is_open: o } => (*o, false, true),
                        _ => {
                            return Err(CommandError::InvalidConfiguration(
                                "Wall segment is not a door".to_string(),
                            ));
                        }
                    };

                if let Some(o) = is_open {
                    cur_open = o;
                }
                if let Some(l) = is_locked {
                    cur_locked = l;
                }
                if let Some(s) = is_secret {
                    cur_secret = s;
                }

                let new_kind = if cur_secret {
                    WallKind::SecretDoor { is_open: cur_open }
                } else {
                    WallKind::Door {
                        is_open: cur_open,
                        is_locked: cur_locked,
                    }
                };

                self.push_undo(format!("Configure door {wall_id}"));
                self.data.walls[idx].kind = new_kind.clone();
                self.bvh = Bvh2D::build(self.data.walls.clone());

                Ok(vec![TrameEvent::DoorConfigured {
                    wall_id,
                    kind: new_kind,
                }])
            }

            TrameCommand::DecideReaction {
                prompt_id,
                actor_id,
                decision,
            } => {
                if actor.role == CampaignRole::Spectator {
                    return Err(CommandError::PermissionDenied(
                        "spectators cannot decide reactions".to_string(),
                    ));
                }
                let prompt = self
                    .data
                    .active_reaction_prompts
                    .get(&prompt_id)
                    .ok_or_else(|| CommandError::NotFound(format!("reaction prompt {prompt_id}")))?
                    .clone();
                if prompt.reactor_actor_id != actor_id {
                    return Err(CommandError::PermissionDenied(
                        "reaction prompt belongs to another actor".to_string(),
                    ));
                }
                if actor.role != CampaignRole::Gm {
                    self.require_token_control(actor, actor_id)?;
                }
                if prompt.awaiting_resolution {
                    return Err(CommandError::InvalidConfiguration(
                        "reaction already triggered; resolve it with ResolveReaction".to_string(),
                    ));
                }
                if matches!(decision, ReactionDecision::Trigger { .. })
                    && !self
                        .data
                        .tokens
                        .get(&actor_id)
                        .is_some_and(|t| t.has_reaction)
                {
                    return Err(CommandError::ReactionUnavailable);
                }

                self.push_undo(format!("Decide reaction {prompt_id}"));
                let mut extra_events = Vec::new();

                let movement_interrupted = match &decision {
                    ReactionDecision::Trigger { .. } => {
                        if let Some(reactor_tok) = self.data.tokens.get_mut(&actor_id) {
                            reactor_tok.has_reaction = false;
                        }
                        if let Some(open) = self.data.active_reaction_prompts.get_mut(&prompt_id) {
                            open.awaiting_resolution = true;
                        }
                        true
                    }
                    ReactionDecision::Pass => {
                        self.data.active_reaction_prompts.remove(&prompt_id);
                        extra_events.extend(self.resume_interrupted_move(&prompt));
                        false
                    }
                };

                let mut events = vec![TrameEvent::ReactionDecided {
                    prompt_id,
                    actor_id,
                    decision,
                    movement_interrupted,
                }];
                events.extend(extra_events);
                Ok(events)
            }

            TrameCommand::ResolveReaction { prompt_id } => {
                let prompt = self
                    .data
                    .active_reaction_prompts
                    .get(&prompt_id)
                    .ok_or_else(|| CommandError::NotFound(format!("reaction prompt {prompt_id}")))?
                    .clone();
                if actor.role != CampaignRole::Gm {
                    if actor.role == CampaignRole::Spectator {
                        return Err(CommandError::PermissionDenied(
                            "spectators cannot resolve reactions".to_string(),
                        ));
                    }
                    self.require_token_control(actor, prompt.reactor_actor_id)?;
                }
                if !prompt.awaiting_resolution {
                    return Err(CommandError::InvalidConfiguration(
                        "reaction has not been triggered; decide it first".to_string(),
                    ));
                }

                self.push_undo(format!("Resolve reaction {prompt_id}"));
                self.data.active_reaction_prompts.remove(&prompt_id);
                let mut events = vec![TrameEvent::ReactionPromptClosed {
                    prompt_id,
                    reason: ReactionPromptCloseReason::Resolved,
                }];
                events.extend(self.resume_interrupted_move(&prompt));
                Ok(events)
            }

            TrameCommand::CommitMcpStaging { proposal_id } => {
                Self::require_gm(actor)?;
                let staged = self
                    .data
                    .mcp_staging_proposals
                    .get(&proposal_id)
                    .ok_or_else(|| {
                        CommandError::NotFound(format!("MCP staging proposal {proposal_id}"))
                    })?;
                Self::validate_batch(&staged.commands)?;
                let pre_commit = self.data.clone();
                let proposal = self
                    .data
                    .mcp_staging_proposals
                    .remove(&proposal_id)
                    .expect("proposal exists");
                let mut events = self.apply_atomic(
                    actor,
                    proposal.commands,
                    format!("Commit MCP staging {proposal_id}"),
                    pre_commit,
                )?;
                events.push(TrameEvent::McpStagingCommitted { proposal_id });
                Ok(events)
            }

            TrameCommand::RevealHandout { handout_id } => {
                Self::require_gm(actor)?;
                if handout_id.trim().is_empty() {
                    return Err(CommandError::InvalidConfiguration(
                        "handout_id must not be empty".to_string(),
                    ));
                }
                self.data.revealed_handout_ids.insert(handout_id.clone());
                Ok(vec![TrameEvent::HandoutRevealed { handout_id }])
            }

            TrameCommand::RejectMcpStaging { proposal_id } => {
                Self::require_gm(actor)?;
                self.push_undo(format!("Reject MCP staging {proposal_id}"));
                self.data.mcp_staging_proposals.remove(&proposal_id);
                Ok(vec![TrameEvent::McpStagingRejected { proposal_id }])
            }

            TrameCommand::UndoLastAction => {
                Self::require_gm(actor)?;
                let entry = self
                    .undo_stack
                    .pop_back()
                    .ok_or(CommandError::NothingToUndo)?;
                let description = entry.description.clone();
                let prompts_before = std::mem::take(&mut self.data.active_reaction_prompts);
                self.apply_undo_delta(entry);
                let mut events = vec![TrameEvent::ActionUndone { description }];
                events.extend(Self::reaction_prompt_undo_diff(
                    &prompts_before,
                    &self.data.active_reaction_prompts,
                ));
                Ok(events)
            }
        }
    }
}
