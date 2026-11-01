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
//!        `UndoLastAction`) immediately rebuilds `self.bvh` so subsequent
//!        raycasts and collision queries reflect the updated geometry.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `TableState::apply_command(actor, cmd)`
//!     ├── 1. Verify actor role (`require_gm` / `require_token_control`).
//!     ├── 2. Validate spatial & turn invariants (BVH collision, speed budget, door locks).
//!     ├── 3. Push pre-mutation `UndoEntry` onto `undo_stack` (bounded to 50).
//!     ├── 4. Mutate `self.data` (and rebuild `self.bvh` if walls changed).
//!     └── 5. Return emitted `Vec<TrameEvent>` for WAL persistence and client broadcast.
//! ============================================================================

use crate::aoe::{AoeTemplate, GridCell, TokenSpatialRef};
pub use crate::geometry::Point2D;
use crate::geometry::{
    Bvh2D, CHANNEL_ETHEREAL, CHANNEL_GM_HIDDEN, CHANNEL_MATERIAL, SenseProfile, WallKind,
    WallSegment, segment_intersection, segment_intersects_segment,
};
use crate::rules::{ActiveEffect, DamageAffinity, DamageResolution, resolve_damage_application};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
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
pub struct FogOverrideCell {
    /// Discrete horizontal grid column index (`cell_x`).
    pub cell_x: i32,
    /// Discrete vertical grid row index (`cell_y`).
    pub cell_y: i32,
    /// Active manual override mode (`Reveal` or `Hide`).
    pub mode: FogOverrideMode,
}

/// Player or GM decision in response to a tactical 5-second reaction prompt (e.g., Opportunity Attack, Shield).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// Active tactical reaction window awaiting a `DecideReaction` command from the reacting actor or GM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReactionPrompt {
    /// Unique identifier of this reaction prompt.
    pub prompt_id: Uuid,
    /// Token/actor UUID eligible to spend their reaction (`has_reaction == true`).
    pub reactor_actor_id: Uuid,
    /// Token UUID whose movement or action triggered the reaction window.
    pub trigger_token_id: Uuid,
    /// Optional destination top-left coordinate in pixels (`px`) to resume if the reactor passes.
    #[serde(default)]
    pub pending_destination: Option<Point2D>,
    /// Optional destination elevation in feet (`ft`) to resume if the reactor passes.
    #[serde(default)]
    pub pending_elevation_ft: Option<f64>,
}

/// Queued MCP dry-run staging batch awaiting explicit GM confirmation (`CommitMcpStaging`) or rejection (`RejectMcpStaging`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TableMode {
    /// Free-form exploration where owned tokens move without initiative order unless `exploration_paused` is set.
    Exploration,
    /// Structured tactical combat enforcing `initiative_order`, `active_turn_index`, and per-turn `speed_remaining_ft`.
    TurnByTurn,
}

/// Global ambient illumination preset applied to the tabletop scene.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
pub struct CommandActor {
    /// Unique identifier of the authenticated user.
    pub user_id: Uuid,
    /// Authoritative role of the user within this campaign room.
    pub role: CampaignRole,
}

fn default_token_ac() -> i32 {
    10
}

/// Authoritative spatial, vitality, action-economy, and sensory state of a single tabletop token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Dexterity modifier used for authoritative `1d20 + dex_mod` initiative rolls (default `0`).
    #[serde(default)]
    pub dex_mod: i32,
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
    /// Active buffs, debuffs, and modifiers applied to this token.
    pub active_effects: Vec<ActiveEffect>,
    /// Active D&D 5e condition labels synchronized from the persistent actor sheet (`ADR-0037`).
    #[serde(default)]
    pub conditions: Vec<String>,
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
            speed_max_ft: 30.0,
            speed_remaining_ft: 30.0,
            has_action: true,
            has_bonus_action: true,
            has_reaction: true,
            concentrating_on_aoe_id: None,
            active_effects: Vec::new(),
            conditions: Vec::new(),
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
    },
    /// Enters `TurnByTurn` combat mode at Round 1, Turn Index 0 with an explicit or auto-rolled `initiative_order` (GM only).
    StartTurnByTurn {
        /// Ordered list of token IDs defining the combat initiative sequence (if empty, `TableRoomActor` rolls `1d20 + dex_mod`).
        #[serde(default)]
        initiative_order: Vec<Uuid>,
    },
    /// Exits `TurnByTurn` combat mode and returns the tabletop to free-form `Exploration` mode (GM only).
    EndTurnByTurn,
    /// Advances the combat tracker to the next token in `initiative_order`, wrapping rounds and refreshing action/movement budgets.
    AdvanceTurn,
    /// Applies raw damage with a specified `DamageAffinity` to a target token, resolving Temp HP and Concentration checks.
    ApplyDamage {
        /// Target token ID receiving damage.
        token_id: Uuid,
        /// Unmitigated incoming damage amount (`>= 0`).
        raw_damage: i32,
        /// Target's resistance, vulnerability, or immunity toward the damage type.
        affinity: DamageAffinity,
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
    /// Spawns or replaces a token on the tabletop (GM only).
    SpawnToken {
        /// Complete initial state of the token to place on the map.
        token: TokenState,
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
    /// Resolves an active 5-second tactical reaction prompt (`Trigger` or `Pass`).
    DecideReaction {
        /// Unique identifier of the active reaction prompt being resolved.
        prompt_id: Uuid,
        /// Reacting actor/token UUID.
        actor_id: Uuid,
        /// Player or GM decision (`Trigger` with optional `ability_id`, or `Pass`).
        decision: ReactionDecision,
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
        /// Newly spawned token state.
        token: TokenState,
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
}

/// Single compensating snapshot entry stored in the `TableState::undo_stack` ring buffer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UndoEntry {
    /// Human-readable label describing the action that was taken immediately after this snapshot.
    pub description: String,
    /// Full serializable tabletop state captured prior to the command mutation.
    pub snapshot: TableSnapshotData,
}

/// Purely serializable tabletop state payload persisted in snapshots and the undo ring buffer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
            },
            bvh,
            undo_stack: VecDeque::with_capacity(MAX_UNDO_HISTORY),
        }
    }

    /// Restores a compensating `UndoEntry` snapshot and rebuilds the 2.5D `Bvh2D` spatial index.
    pub fn apply_undo_delta(&mut self, entry: UndoEntry) {
        self.data = entry.snapshot;
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
        if self.undo_stack.len() >= MAX_UNDO_HISTORY {
            self.undo_stack.pop_front();
        }
        self.undo_stack.push_back(UndoEntry {
            description: description.into(),
            snapshot: self.data.clone(),
        });
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
                }

                let new_elev = to_elevation_ft.unwrap_or(token.elevation_ft);
                let px_per_ft = self.cell_size_px / self.feet_per_cell.max(1.0);
                let half_w = f64::from(token.grid_w.max(1)) * self.cell_size_px * 0.5;
                let half_h = f64::from(token.grid_h.max(1)) * self.cell_size_px * 0.5;
                let from_center =
                    Point2D::new(token.top_left.x + half_w, token.top_left.y + half_h);
                let to_center = Point2D::new(to_top_left.x + half_w, to_top_left.y + half_h);

                if !is_gm_teleport {
                    let is_ethereal = (token.visibility_channel & CHANNEL_ETHEREAL) != 0;
                    let check_elev = new_elev + token.height_ft * 0.5;

                    if !is_ethereal {
                        let token_bottom_ft = token.elevation_ft.min(new_elev);
                        let token_top_ft =
                            token.elevation_ft.max(new_elev) + token.height_ft.max(0.0);
                        for wall in &self.data.walls {
                            if !wall.is_blocking_movement() {
                                continue;
                            }
                            let elev_overlaps = token_bottom_ft <= wall.top_elevation_ft
                                && token_top_ft >= wall.bottom_elevation_ft
                                && check_elev >= wall.bottom_elevation_ft
                                && check_elev <= wall.top_elevation_ft;
                            if elev_overlaps
                                && segment_intersects_segment(
                                    from_center,
                                    to_center,
                                    wall.a,
                                    wall.b,
                                )
                            {
                                let hit_pt =
                                    segment_intersection(from_center, to_center, wall.a, wall.b)
                                        .map(|(_, pt)| pt)
                                        .unwrap_or(to_center);
                                return Err(CommandError::WallCollision {
                                    x: hit_pt.x,
                                    y: hit_pt.y,
                                });
                            }
                        }
                    }

                    if let Some(hit_pt) = self.bvh.check_movement_collision(
                        from_center,
                        to_center,
                        check_elev,
                        is_ethereal,
                    ) {
                        return Err(CommandError::WallCollision {
                            x: hit_pt.x,
                            y: hit_pt.y,
                        });
                    }
                }

                let dist_ft = token.top_left.distance_3d(
                    token.elevation_ft,
                    to_top_left,
                    new_elev,
                    px_per_ft,
                );
                let cost_ft = if token.is_squeezing {
                    dist_ft * 2.0
                } else {
                    dist_ft
                };

                if !is_gm_teleport
                    && self.data.mode == TableMode::TurnByTurn
                    && cost_ft > token.speed_remaining_ft + 1e-6
                {
                    return Err(CommandError::InsufficientMovement {
                        needed_ft: cost_ft,
                        remaining_ft: token.speed_remaining_ft,
                    });
                }

                self.push_undo(format!("Move token {}", token.name));
                let tok_mut = self.data.tokens.get_mut(&token_id).expect("token exists");
                let from_top_left = tok_mut.top_left;
                tok_mut.top_left = to_top_left;
                tok_mut.elevation_ft = new_elev;
                if !is_gm_teleport && self.data.mode == TableMode::TurnByTurn {
                    tok_mut.speed_remaining_ft = (tok_mut.speed_remaining_ft - cost_ft).max(0.0);
                }

                Ok(vec![TrameEvent::TokenMoved {
                    token_id,
                    from_top_left,
                    to_top_left,
                    elevation_ft: new_elev,
                    speed_remaining_ft: tok_mut.speed_remaining_ft,
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
            } => {
                Self::require_gm(actor)?;
                self.push_undo("Change table mode");
                self.data.mode = mode;
                self.data.exploration_paused = exploration_paused;
                self.data.initiative_order = initiative_order;
                self.data.active_turn_index = 0;
                self.data.round = 1;
                if let Some(first_id) = self.active_turn_token_id()
                    && let Some(tok) = self.data.tokens.get_mut(&first_id)
                {
                    tok.speed_remaining_ft = tok.speed_max_ft;
                    tok.has_action = true;
                    tok.has_bonus_action = true;
                    tok.has_reaction = true;
                }
                Ok(vec![TrameEvent::TableModeChanged {
                    mode,
                    exploration_paused,
                    active_turn_token_id: self.active_turn_token_id(),
                    round: self.data.round,
                }])
            }

            TrameCommand::StartTurnByTurn { initiative_order } => {
                Self::require_gm(actor)?;
                self.push_undo("Start Turn-by-Turn mode");
                self.data.mode = TableMode::TurnByTurn;
                self.data.exploration_paused = false;
                self.data.initiative_order = initiative_order;
                self.data.active_turn_index = 0;
                self.data.round = 1;
                if let Some(first_id) = self.active_turn_token_id()
                    && let Some(tok) = self.data.tokens.get_mut(&first_id)
                {
                    tok.speed_remaining_ft = tok.speed_max_ft;
                    tok.has_action = true;
                    tok.has_bonus_action = true;
                    tok.has_reaction = true;
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
                self.data.mode = TableMode::Exploration;
                self.data.exploration_paused = false;
                self.data.initiative_order.clear();
                self.data.active_turn_index = 0;
                self.data.round = 1;
                Ok(vec![TrameEvent::TableModeChanged {
                    mode: TableMode::Exploration,
                    exploration_paused: false,
                    active_turn_token_id: None,
                    round: 1,
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
                    if let Some(next_id) = self.active_turn_token_id()
                        && let Some(tok) = self.data.tokens.get_mut(&next_id)
                    {
                        tok.speed_remaining_ft = tok.speed_max_ft;
                        tok.has_action = true;
                        tok.has_bonus_action = true;
                        tok.has_reaction = true;
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
            } => {
                if actor.role == CampaignRole::Spectator {
                    return Err(CommandError::PermissionDenied(
                        "spectators cannot apply damage".to_string(),
                    ));
                }
                let token = self
                    .data
                    .tokens
                    .get(&token_id)
                    .ok_or_else(|| CommandError::NotFound(format!("token {token_id}")))?
                    .clone();

                self.push_undo(format!("Apply {raw_damage} damage to {}", token.name));
                let is_concentrating = token.concentrating_on_aoe_id.is_some();
                let resolution = resolve_damage_application(
                    raw_damage,
                    affinity,
                    token.hp,
                    token.max_hp,
                    token.temp_hp,
                    is_concentrating,
                );

                let tok_mut = self.data.tokens.get_mut(&token_id).expect("token exists");
                tok_mut.hp = resolution.new_hp;
                tok_mut.temp_hp = resolution.new_temp_hp;

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
                self.bvh = Bvh2D::build(self.data.walls.clone());

                Ok(vec![TrameEvent::SceneLoaded {
                    scene_id,
                    map_asset_id,
                    width_px,
                    height_px,
                    pixels_per_grid,
                }])
            }

            TrameCommand::SpawnToken { token } => {
                Self::require_gm(actor)?;
                self.push_undo(format!("Spawn token {}", token.name));
                self.data.tokens.insert(token.id, token.clone());
                Ok(vec![TrameEvent::TokenSpawned { token }])
            }

            TrameCommand::RemoveToken { token_id } => {
                Self::require_gm(actor)?;
                if !self.data.tokens.contains_key(&token_id) {
                    return Err(CommandError::NotFound(format!("token {token_id}")));
                }
                self.push_undo(format!("Remove token {token_id}"));
                self.data.tokens.remove(&token_id);
                self.data.initiative_order.retain(|id| *id != token_id);
                if self.data.active_turn_index >= self.data.initiative_order.len() {
                    self.data.active_turn_index = 0;
                }
                Ok(vec![TrameEvent::TokenRemoved { token_id }])
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
                if actor.role == CampaignRole::Player && self.data.tokens.contains_key(&actor_id) {
                    self.require_token_control(actor, actor_id)?;
                }
                if let Some(prompt) = self.data.active_reaction_prompts.get(&prompt_id)
                    && actor.role != CampaignRole::Gm
                    && prompt.reactor_actor_id != actor_id
                {
                    return Err(CommandError::PermissionDenied(
                        "reaction prompt belongs to another actor".to_string(),
                    ));
                }

                self.push_undo(format!("Decide reaction {prompt_id}"));
                let removed_prompt = self.data.active_reaction_prompts.remove(&prompt_id);
                let mut extra_events = Vec::new();

                let movement_interrupted = match &decision {
                    ReactionDecision::Trigger { .. } => {
                        if let Some(reactor_tok) = self.data.tokens.get_mut(&actor_id) {
                            reactor_tok.has_reaction = false;
                        }
                        true
                    }
                    ReactionDecision::Pass => {
                        if let Some(prompt) = removed_prompt
                            && let Some(dest) = prompt.pending_destination
                            && let Some(moving_tok) =
                                self.data.tokens.get_mut(&prompt.trigger_token_id)
                        {
                            let from_top_left = moving_tok.top_left;
                            let new_elev = prompt
                                .pending_elevation_ft
                                .unwrap_or(moving_tok.elevation_ft);
                            moving_tok.top_left = dest;
                            moving_tok.elevation_ft = new_elev;
                            extra_events.push(TrameEvent::TokenMoved {
                                token_id: prompt.trigger_token_id,
                                from_top_left,
                                to_top_left: dest,
                                elevation_ft: new_elev,
                                speed_remaining_ft: moving_tok.speed_remaining_ft,
                            });
                        }
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

            TrameCommand::CommitMcpStaging { proposal_id } => {
                Self::require_gm(actor)?;
                let pre_batch_snapshot = self.data.clone();
                let mut batch_events = Vec::new();
                if let Some(proposal) = self.data.mcp_staging_proposals.remove(&proposal_id) {
                    let undo_len_before = self.undo_stack.len();
                    for staged_cmd in proposal.commands {
                        let evs = self.apply_command(actor, staged_cmd)?;
                        batch_events.extend(evs);
                    }
                    self.undo_stack.truncate(undo_len_before);
                }
                if self.undo_stack.len() >= MAX_UNDO_HISTORY {
                    self.undo_stack.pop_front();
                }
                self.undo_stack.push_back(UndoEntry {
                    description: format!("Commit MCP staging {proposal_id}"),
                    snapshot: pre_batch_snapshot,
                });
                batch_events.push(TrameEvent::McpStagingCommitted { proposal_id });
                Ok(batch_events)
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
                self.apply_undo_delta(entry);
                Ok(vec![TrameEvent::ActionUndone { description }])
            }
        }
    }
}
