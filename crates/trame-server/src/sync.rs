use crate::dice::{ProjectedDiceRoll, RollVisibility};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use trame_engine::aoe::AoeTemplate;
use trame_engine::commands::{
    AmbientLightingPreset, CampaignRole, TableMode, TableState, TokenState, TrameCommand,
    TrameEvent,
};
use trame_engine::geometry::{
    CHANNEL_GM_HIDDEN, Point2D, WallKind, WallSegment, can_token_see_target,
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientEnvelope {
    SubmitCommand(TrameCommand),
    RollDice {
        expression: String,
        visibility: RollVisibility,
        reason: String,
    },
    PointerPing {
        pos: Point2D,
        color_hex: String,
    },
    Ping {
        client_time_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectedTableState {
    pub campaign_id: Uuid,
    pub mode: TableMode,
    pub exploration_paused: bool,
    pub ambient_lighting: AmbientLightingPreset,
    pub cell_size_px: f64,
    pub feet_per_cell: f64,
    pub tokens: BTreeMap<Uuid, TokenState>,
    pub walls: Vec<WallSegment>,
    pub persistent_aoes: BTreeMap<Uuid, AoeTemplate>,
    pub initiative_order: Vec<Uuid>,
    pub active_turn_index: usize,
    pub round: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ServerEnvelope {
    StateSnapshot {
        seq_id: u64,
        state: ProjectedTableState,
    },
    CommandAccepted {
        seq_id: u64,
        events: Vec<TrameEvent>,
        state: ProjectedTableState,
    },
    CommandRejected {
        reason: String,
    },
    DiceRolled(ProjectedDiceRoll),
    PointerPingBroadcast {
        sender_user_id: Uuid,
        pos: Point2D,
        color_hex: String,
    },
    Pong {
        client_time_ms: u64,
        server_time_ms: u64,
    },
}

pub fn encode_server_envelope(env: &ServerEnvelope) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    rmp_serde::to_vec_named(env)
}

pub fn decode_client_envelope(bytes: &[u8]) -> Result<ClientEnvelope, rmp_serde::decode::Error> {
    rmp_serde::from_slice(bytes)
}

/// Computes which token IDs in `state` are visible to `(recipient_user_id, recipient_role)`
/// using the 2.5D BVH raycaster.
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
/// - Strips `CHANNEL_GM_HIDDEN` tokens and tokens outside 2.5D BVH line-of-sight for non-GMs
/// - Masks closed `SecretDoor` walls as `Normal` walls so players cannot inspect wire data
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
    }
}

/// Filters `TrameEvent` notifications so hidden token movements or damage events
/// are never leaked to non-GM clients without line of sight.
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
            | TrameEvent::TokenResourcesOverridden { token_id, .. } => {
                visible_ids.contains(token_id)
            }
            TrameEvent::DoorToggled { .. }
            | TrameEvent::TableModeChanged { .. }
            | TrameEvent::TurnAdvanced { .. }
            | TrameEvent::AoeProjected { .. }
            | TrameEvent::ConcentrationBroken { .. }
            | TrameEvent::AmbientLightingChanged { .. }
            | TrameEvent::ActionUndone { .. } => true,
        })
        .cloned()
        .collect()
}
