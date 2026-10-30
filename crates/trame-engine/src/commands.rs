//! Canonical CQRS `TrameCommand`, `TrameEvent`, `UndoEntry` Ring Buffer,
//! and Authoritative `TableState` Reducer (`01-TABLE-SPEC.md`, `04-RUNTIME-AND-DEDICATED-HOSTING.md`).

use crate::aoe::{AoeTemplate, GridCell, TokenSpatialRef};
use crate::geometry::{Bvh2D, CHANNEL_MATERIAL, Point2D, SenseProfile, WallKind, WallSegment};
use crate::rules::{ActiveEffect, DamageAffinity, DamageResolution, resolve_damage_application};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_UNDO_HISTORY: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TableMode {
    Exploration,
    TurnByTurn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AmbientLightingPreset {
    Daylight,
    Dusk,
    NightMoonlight,
    PitchDarkness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CampaignRole {
    Gm,
    Player,
    Spectator,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandActor {
    pub user_id: Uuid,
    pub role: CampaignRole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenState {
    pub id: Uuid,
    pub name: String,
    pub owner_user_id: Option<Uuid>,
    pub top_left: Point2D,
    pub grid_w: u8,
    pub grid_h: u8,
    pub is_squeezing: bool,
    pub elevation_ft: f64,
    pub height_ft: f64,
    pub visibility_channel: u8,
    pub invisible: bool,
    pub senses: SenseProfile,
    pub hp: i32,
    pub max_hp: i32,
    pub temp_hp: i32,
    pub speed_max_ft: f64,
    pub speed_remaining_ft: f64,
    pub has_action: bool,
    pub has_bonus_action: bool,
    pub has_reaction: bool,
    pub concentrating_on_aoe_id: Option<Uuid>,
    pub active_effects: Vec<ActiveEffect>,
}

impl TokenState {
    pub fn new_default(id: Uuid, name: impl Into<String>, top_left: Point2D) -> Self {
        Self {
            id,
            name: name.into(),
            owner_user_id: None,
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
            speed_max_ft: 30.0,
            speed_remaining_ft: 30.0,
            has_action: true,
            has_bonus_action: true,
            has_reaction: true,
            concentrating_on_aoe_id: None,
            active_effects: Vec::new(),
        }
    }

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrameCommand {
    MoveToken {
        token_id: Uuid,
        to_top_left: Point2D,
        to_elevation_ft: Option<f64>,
        gm_teleport: bool,
    },
    ToggleSqueeze {
        token_id: Uuid,
        is_squeezing: bool,
    },
    ToggleDoor {
        wall_id: Uuid,
        is_open: bool,
    },
    SetTableMode {
        mode: TableMode,
        exploration_paused: bool,
        initiative_order: Vec<Uuid>,
    },
    AdvanceTurn,
    ApplyDamage {
        token_id: Uuid,
        raw_damage: i32,
        affinity: DamageAffinity,
    },
    GmOverrideTokenResources {
        token_id: Uuid,
        hp: Option<i32>,
        temp_hp: Option<i32>,
        speed_remaining_ft: Option<f64>,
        has_action: Option<bool>,
        has_bonus_action: Option<bool>,
        has_reaction: Option<bool>,
    },
    ProjectAoe {
        template: AoeTemplate,
        persist_zone: bool,
    },
    BreakConcentration {
        caster_token_id: Uuid,
    },
    SetAmbientLighting {
        preset: AmbientLightingPreset,
    },
    UndoLastAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrameEvent {
    TokenMoved {
        token_id: Uuid,
        from_top_left: Point2D,
        to_top_left: Point2D,
        elevation_ft: f64,
        speed_remaining_ft: f64,
    },
    TokenSqueezeToggled {
        token_id: Uuid,
        is_squeezing: bool,
        speed_remaining_ft: f64,
    },
    DoorToggled {
        wall_id: Uuid,
        is_open: bool,
    },
    TableModeChanged {
        mode: TableMode,
        exploration_paused: bool,
        active_turn_token_id: Option<Uuid>,
        round: u32,
    },
    TurnAdvanced {
        active_turn_token_id: Option<Uuid>,
        round: u32,
    },
    DamageApplied {
        token_id: Uuid,
        resolution: DamageResolution,
    },
    TokenResourcesOverridden {
        token_id: Uuid,
        hp: i32,
        temp_hp: i32,
        speed_remaining_ft: f64,
        has_action: bool,
        has_bonus_action: bool,
        has_reaction: bool,
    },
    AoeProjected {
        template: AoeTemplate,
        affected_cells: Vec<GridCell>,
        affected_token_ids: Vec<Uuid>,
        persisted: bool,
    },
    ConcentrationBroken {
        caster_token_id: Uuid,
        removed_aoe_id: Option<Uuid>,
    },
    AmbientLightingChanged {
        preset: AmbientLightingPreset,
    },
    ActionUndone {
        description: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UndoEntry {
    pub description: String,
    pub snapshot: TableSnapshotData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableSnapshotData {
    pub mode: TableMode,
    pub exploration_paused: bool,
    pub ambient_lighting: AmbientLightingPreset,
    pub round: u32,
    pub initiative_order: Vec<Uuid>,
    pub active_turn_index: usize,
    pub tokens: BTreeMap<Uuid, TokenState>,
    pub walls: Vec<WallSegment>,
    pub persistent_aoes: BTreeMap<Uuid, AoeTemplate>,
}

#[derive(Debug, Clone)]
pub struct TableState {
    pub cell_size_px: f64,
    pub feet_per_cell: f64,
    pub data: TableSnapshotData,
    pub bvh: Bvh2D,
    pub undo_stack: VecDeque<UndoEntry>,
}

#[derive(Debug, Error, PartialEq)]
pub enum CommandError {
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("entity not found: {0}")]
    NotFound(String),
    #[error("exploration movement is currently paused by the GM")]
    ExplorationPaused,
    #[error("not your turn in Turn-by-Turn mode")]
    NotActiveTurn,
    #[error("insufficient movement budget: need {needed_ft:.1} ft, have {remaining_ft:.1} ft")]
    InsufficientMovement { needed_ft: f64, remaining_ft: f64 },
    #[error("movement blocked by wall at ({x:.1}, {y:.1})")]
    WallCollision { x: f64, y: f64 },
    #[error("door is locked")]
    DoorLocked,
    #[error("undo stack is empty")]
    NothingToUndo,
}

impl Default for TableState {
    fn default() -> Self {
        Self::new(100.0, 5.0, Vec::new())
    }
}

impl TableState {
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
                persistent_aoes: BTreeMap::new(),
            },
            bvh,
            undo_stack: VecDeque::with_capacity(MAX_UNDO_HISTORY),
        }
    }

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
    /// turn-order budgets, and pushing a compensating `UndoEntry`.
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
                let half_px = self.cell_size_px * 0.5;
                let from_center =
                    Point2D::new(token.top_left.x + half_px, token.top_left.y + half_px);
                let to_center = Point2D::new(to_top_left.x + half_px, to_top_left.y + half_px);

                if !is_gm_teleport {
                    let is_ethereal =
                        (token.visibility_channel & crate::geometry::CHANNEL_ETHEREAL) != 0;
                    if let Some(hit_pt) = self.bvh.check_movement_collision(
                        from_center,
                        to_center,
                        new_elev + token.height_ft * 0.5,
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

            TrameCommand::UndoLastAction => {
                Self::require_gm(actor)?;
                let entry = self
                    .undo_stack
                    .pop_back()
                    .ok_or(CommandError::NothingToUndo)?;
                self.data = entry.snapshot;
                self.bvh = Bvh2D::build(self.data.walls.clone());
                Ok(vec![TrameEvent::ActionUndone {
                    description: entry.description,
                }])
            }
        }
    }
}
