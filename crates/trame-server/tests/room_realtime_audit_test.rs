//! ============================================================================
//! ROOM REALTIME AUDIT REGRESSIONS (room_realtime_audit_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Pins the room actor fixes from the final-gate realtime audit at the room
//!   seam (`TableRoomActor` / `RoomLeaseManager`, no sockets):
//!   - dead sessions (receiver dropped, no `DisconnectClient`) are pruned so
//!     the room can hibernate;
//!   - the per-session command rate limit throttles a flood but not play;
//!   - hidden roll privacy counts offline campaign players (`set_player_roster`);
//!   - a sheet sync or an MCP staging pushes a `StateSnapshot` to every
//!     recipient whose projection changed;
//!   - the Concentration `DiceRolled` reaches the GM and the controller only.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - The actor enqueues every frame before it answers a request, so the
//!     queue right after an awaited room call holds everything it sent.
//! ============================================================================

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use trame_engine::commands::{CampaignRole, CommandActor, TableState, TokenState, TrameCommand};
use trame_engine::geometry::Point2D;
use trame_engine::resolution::RollMode;
use trame_server::dice::RollVisibility;
use trame_server::room::{
    ActorTacticalSync, COMMAND_RATE_BURST, COMMAND_RATE_REFILL_PER_SEC, ConnectedClient,
    OutboundClientFrame, RoomLeaseManager, RoomSinks, TableRoomActor, TableRoomHandle,
    TimelineNote, client_channel,
};
use trame_server::sync::{ClientEnvelope, ServerEnvelope};
use trame_server::wal::{InMemoryWalStorage, TableStateSnapshot, WalStorage};
use uuid::Uuid;

type Rx = mpsc::Receiver<OutboundClientFrame>;

fn token(id: Uuid, name: &str, owner: Option<Uuid>, x: f64) -> TokenState {
    let mut t = TokenState::new_default(id, name, Point2D::new(x, 100.0));
    t.owner_user_id = owner;
    t
}

fn wal_with(campaign_id: Uuid, state: &TableState) -> Arc<InMemoryWalStorage> {
    let wal = Arc::new(InMemoryWalStorage::new());
    wal.save_snapshot(TableStateSnapshot::capture(campaign_id, 0, 0, state))
        .unwrap();
    wal
}

async fn connect(room: &TableRoomHandle, user_id: Uuid, role: CampaignRole) -> (Uuid, Rx) {
    let (tx, rx) = client_channel();
    let session_id = Uuid::new_v4();
    room.connect_client(ConnectedClient {
        session_id,
        user_id,
        role,
        tx,
    })
    .await
    .unwrap();
    (session_id, rx)
}

fn drain(rx: &mut Rx) -> Vec<ServerEnvelope> {
    let mut out = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if let OutboundClientFrame::Binary(bytes) = frame {
            out.push(rmp_serde::from_slice(&bytes).unwrap());
        }
    }
    out
}

fn gm() -> CommandActor {
    CommandActor {
        user_id: Uuid::new_v4(),
        role: CampaignRole::Gm,
    }
}

fn teleport(token_id: Uuid, x: f64) -> TrameCommand {
    TrameCommand::MoveToken {
        token_id,
        to_top_left: Point2D::new(x, 100.0),
        to_elevation_ft: None,
        gm_teleport: true,
    }
}

// ---------------------------------------------------------------------------
// RT4: dead sessions are pruned
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dropped_receiver_is_pruned_and_the_room_hibernates() {
    // (case_id, disconnect explicitly before dropping)
    let cases = [
        ("receiver_dropped_without_disconnect", false),
        ("receiver_dropped_after_disconnect", true),
    ];
    for (case, disconnect) in cases {
        let campaign_id = Uuid::new_v4();
        let hero = Uuid::new_v4();
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        state
            .data
            .tokens
            .insert(hero, token(hero, "Hero", None, 100.0));
        let mgr = RoomLeaseManager::new(wal_with(campaign_id, &state), 25, 0);
        let room = mgr.get_or_wake_room(campaign_id).await.unwrap();
        let (session, rx) = connect(&room, Uuid::new_v4(), CampaignRole::Player).await;
        assert_eq!(
            room.metrics().await.unwrap().active_connections,
            1,
            "case {case}: attached"
        );
        if disconnect {
            room.disconnect_client(session).await.unwrap();
        }
        drop(rx);

        room.dispatch_direct_command(gm(), teleport(hero, 300.0))
            .await
            .unwrap();
        assert_eq!(
            room.metrics().await.unwrap().active_connections,
            0,
            "case {case}: dead session pruned"
        );
        assert_eq!(
            mgr.sweep_idle_rooms(u64::MAX).await,
            vec![campaign_id],
            "case {case}: idle room hibernates"
        );
    }
}

// ---------------------------------------------------------------------------
// Per-session command rate limit
// ---------------------------------------------------------------------------

fn roll(n: usize) -> ClientEnvelope {
    ClientEnvelope::RollDice {
        expression: "1d20".to_string(),
        visibility: RollVisibility::Public,
        reason: format!("check {n}"),
        correlation_id: Some(format!("c{n}")),
    }
}

/// `(rolls answered with DiceRolled, correlation ids rejected as rate limited)`.
fn tally(frames: &[ServerEnvelope]) -> (usize, Vec<String>) {
    let rolled = frames
        .iter()
        .filter(|f| matches!(f, ServerEnvelope::DiceRolled(_)))
        .count();
    let limited = frames
        .iter()
        .filter_map(|f| match f {
            ServerEnvelope::CommandRejected {
                reason,
                correlation_id,
            } if reason.starts_with("rate limited") => correlation_id.clone(),
            _ => None,
        })
        .collect();
    (rolled, limited)
}

#[tokio::test]
async fn command_flood_is_throttled_and_paced_play_is_not() {
    let campaign_id = Uuid::new_v4();
    let state = TableState::new(100.0, 5.0, Vec::new());
    let room = TableRoomActor::spawn(campaign_id, wal_with(campaign_id, &state), 25).unwrap();
    let burst = COMMAND_RATE_BURST as usize;

    // Flood: twice the burst back to back. Allow one or two refilled tokens on a slow runner.
    let (flooder, mut flood_rx) = connect(&room, Uuid::new_v4(), CampaignRole::Player).await;
    drain(&mut flood_rx);
    for n in 0..burst * 2 {
        room.send_envelope(flooder, roll(n)).await.unwrap();
    }
    let (rolled, limited) = tally(&drain(&mut flood_rx));
    assert!(
        (burst..=burst + 2).contains(&rolled),
        "case flood_beyond_burst_is_throttled: {rolled} rolls accepted"
    );
    assert_eq!(
        rolled + limited.len(),
        burst * 2,
        "case flood_every_roll_answered"
    );
    assert_eq!(
        limited.last().map(String::as_str),
        Some(format!("c{}", burst * 2 - 1).as_str()),
        "case rejection_echoes_correlation_id"
    );

    // Paced play on another session: a full burst, a pause, then a refill's worth.
    let (player, mut player_rx) = connect(&room, Uuid::new_v4(), CampaignRole::Player).await;
    drain(&mut player_rx);
    let refill = COMMAND_RATE_REFILL_PER_SEC as usize;
    // (case_id, pause before, rolls sent)
    let cases = [
        ("burst_of_play_is_never_throttled", Duration::ZERO, burst),
        (
            "one_second_refills_the_per_second_allowance",
            Duration::from_millis(1100),
            refill,
        ),
    ];
    for (case, pause, count) in cases {
        tokio::time::sleep(pause).await;
        for n in 0..count {
            room.send_envelope(player, roll(n)).await.unwrap();
        }
        let (rolled, limited) = tally(&drain(&mut player_rx));
        assert_eq!((rolled, limited.len()), (count, 0), "case {case}");
    }
}

// ---------------------------------------------------------------------------
// Hidden roll privacy counts offline players
// ---------------------------------------------------------------------------

fn bandit_roll_visibility(notes: &[TimelineNote]) -> Option<bool> {
    notes
        .iter()
        .find(|n| n.event_type == "dice_roll" && n.payload["reason"] == "Initiative: Bandit")
        .map(|n| n.payload.get("visibility").is_some())
}

fn initiative_order_hidden(notes: &[TimelineNote]) -> Option<bool> {
    notes
        .iter()
        .find(|n| n.event_type == "initiative")
        .map(|n| n.payload.get("visibility").is_some())
}

#[tokio::test]
async fn hidden_initiative_counts_every_campaign_player() {
    let seer = Uuid::new_v4();
    let tokenless = Uuid::new_v4();
    // (case_id, roster, connected player, bandit roll and order are GM-only)
    let cases = [
        (
            "no_roster_connected_seer_bandit_public",
            vec![],
            Some(seer),
            false,
        ),
        (
            "offline_player_with_no_tokens_hides_bandit",
            vec![seer, tokenless],
            Some(seer),
            true,
        ),
        (
            "offline_tokenless_player_hides_bandit_with_nobody_connected",
            vec![tokenless],
            None,
            true,
        ),
        (
            "offline_seer_only_keeps_bandit_public",
            vec![seer],
            None,
            false,
        ),
    ];
    for (case, roster, connected, hidden) in cases {
        let campaign_id = Uuid::new_v4();
        let (hero, bandit) = (Uuid::new_v4(), Uuid::new_v4());
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        state
            .data
            .tokens
            .insert(hero, token(hero, "Hero", Some(seer), 0.0));
        state
            .data
            .tokens
            .insert(bandit, token(bandit, "Bandit", None, 200.0));
        let (timeline_tx, mut timeline_rx) = mpsc::unbounded_channel();
        let room = TableRoomActor::spawn_with_sinks(
            campaign_id,
            wal_with(campaign_id, &state),
            25,
            RoomSinks {
                vitals: None,
                timeline: Some(timeline_tx),
            },
        )
        .unwrap();
        room.set_player_roster(roster).await.unwrap();
        let _session = match connected {
            Some(user) => Some(connect(&room, user, CampaignRole::Player).await),
            None => None,
        };
        room.dispatch_direct_command(
            gm(),
            TrameCommand::StartTurnByTurn {
                initiative_order: Vec::new(),
                initiative_totals: Default::default(),
            },
        )
        .await
        .unwrap();
        let mut notes = Vec::new();
        while let Ok(note) = timeline_rx.try_recv() {
            notes.push(note);
        }
        assert_eq!(
            bandit_roll_visibility(&notes),
            Some(hidden),
            "case {case}: roll"
        );
        assert_eq!(
            initiative_order_hidden(&notes),
            Some(hidden),
            "case {case}: order"
        );
    }
}

// ---------------------------------------------------------------------------
// Out-of-band state changes reach the table
// ---------------------------------------------------------------------------

fn snapshot_hp(frames: &[ServerEnvelope], token_id: Uuid) -> Option<i32> {
    frames.iter().rev().find_map(|f| match f {
        ServerEnvelope::StateSnapshot { state, .. } => state.tokens.get(&token_id).map(|t| t.hp),
        _ => None,
    })
}

#[tokio::test]
async fn sheet_hp_save_pushes_the_token_to_everyone_whose_view_changed() {
    let campaign_id = Uuid::new_v4();
    let (player, bystander) = (Uuid::new_v4(), Uuid::new_v4());
    let (hero, actor_id) = (Uuid::new_v4(), Uuid::new_v4());
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    let mut hero_token = token(hero, "Hero", Some(player), 100.0);
    hero_token.actor_id = Some(actor_id);
    hero_token.max_hp = 20;
    hero_token.hp = 20;
    state.data.tokens.insert(hero, hero_token);
    let room = TableRoomActor::spawn(campaign_id, wal_with(campaign_id, &state), 25).unwrap();
    let mut gm_rx = connect(&room, Uuid::new_v4(), CampaignRole::Gm).await.1;
    let mut player_rx = connect(&room, player, CampaignRole::Player).await.1;
    let mut bystander_rx = connect(&room, bystander, CampaignRole::Player).await.1;
    drain(&mut gm_rx);
    drain(&mut player_rx);
    drain(&mut bystander_rx);

    room.notify_actor_updated(
        actor_id,
        2,
        serde_json::json!({}),
        ActorTacticalSync {
            hp_current: Some(7),
            ..ActorTacticalSync::default()
        },
    )
    .await
    .unwrap();

    // (case_id, frames, hp in the pushed snapshot)
    let cases = [
        ("gm_gets_token_hp", drain(&mut gm_rx), Some(7)),
        ("controller_gets_token_hp", drain(&mut player_rx), Some(7)),
        (
            "tokenless_bystander_view_unchanged_gets_nothing",
            drain(&mut bystander_rx),
            None,
        ),
    ];
    for (case, frames, want) in cases {
        assert_eq!(snapshot_hp(&frames, hero), want, "case {case}");
    }
}

/// `true` when the last `StateSnapshot` in `frames` carries the staged proposal `id`, `false`
/// when it does not, `None` when no snapshot was pushed.
fn snapshot_has_proposal(frames: &[ServerEnvelope], id: Uuid) -> Option<bool> {
    frames.iter().rev().find_map(|f| match f {
        ServerEnvelope::StateSnapshot { state, .. } => {
            Some(state.mcp_staging_proposals.contains_key(&id))
        }
        _ => None,
    })
}

#[tokio::test]
async fn mcp_staging_pushes_the_proposal_to_the_gm_only() {
    let campaign_id = Uuid::new_v4();
    let hero = Uuid::new_v4();
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    let player = Uuid::new_v4();
    state
        .data
        .tokens
        .insert(hero, token(hero, "Hero", Some(player), 100.0));
    let room = TableRoomActor::spawn(campaign_id, wal_with(campaign_id, &state), 25).unwrap();
    let mut gm_rx = connect(&room, Uuid::new_v4(), CampaignRole::Gm).await.1;
    let mut player_rx = connect(&room, player, CampaignRole::Player).await.1;
    drain(&mut gm_rx);
    drain(&mut player_rx);

    let proposal_id = Uuid::new_v4();
    room.stage_mcp_proposal(trame_engine::commands::McpStagingProposal {
        proposal_id,
        summary: "Move the hero".to_string(),
        commands: vec![teleport(hero, 300.0)],
    })
    .await
    .unwrap();

    // (case_id, frames, pushed snapshot carries the proposal)
    let cases = [
        (
            "gm_projection_gains_the_proposal",
            drain(&mut gm_rx),
            Some(true),
        ),
        (
            "player_projection_unchanged_gets_no_snapshot",
            drain(&mut player_rx),
            None,
        ),
    ];
    for (case, frames, want) in cases {
        assert_eq!(
            snapshot_has_proposal(&frames, proposal_id),
            want,
            "case {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// Concentration roll audience
// ---------------------------------------------------------------------------

#[tokio::test]
async fn concentration_roll_reaches_gm_and_controller_only() {
    let campaign_id = Uuid::new_v4();
    let (caster_owner, ally) = (Uuid::new_v4(), Uuid::new_v4());
    let (caster, ally_token) = (Uuid::new_v4(), Uuid::new_v4());
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    let mut caster_token = token(caster, "Cleric", Some(caster_owner), 100.0);
    caster_token.concentrating = true;
    state.data.tokens.insert(caster, caster_token);
    state
        .data
        .tokens
        .insert(ally_token, token(ally_token, "Fighter", Some(ally), 200.0));
    state
        .data
        .pending_concentration_checks
        .insert(caster, vec![10]);
    let room = TableRoomActor::spawn(campaign_id, wal_with(campaign_id, &state), 25).unwrap();
    let mut gm_rx = connect(&room, Uuid::new_v4(), CampaignRole::Gm).await.1;
    let mut owner_rx = connect(&room, caster_owner, CampaignRole::Player).await.1;
    let mut ally_rx = connect(&room, ally, CampaignRole::Player).await.1;
    drain(&mut gm_rx);
    drain(&mut owner_rx);
    drain(&mut ally_rx);

    room.dispatch_direct_command(
        gm(),
        TrameCommand::RollConcentrationCheck {
            token_id: caster,
            roll_mode: RollMode::Normal,
            roll: None,
        },
    )
    .await
    .unwrap();

    let saw = |frames: &[ServerEnvelope]| {
        (
            frames
                .iter()
                .any(|f| matches!(f, ServerEnvelope::DiceRolled(r) if r.reason.starts_with("Concentration"))),
            frames.iter().any(|f| matches!(f, ServerEnvelope::CommandAccepted { events, .. }
                if events.iter().any(|e| matches!(e, trame_engine::commands::TrameEvent::ConcentrationCheckRolled { .. })))),
        )
    };
    // (case_id, frames, (gets DiceRolled, gets ConcentrationCheckRolled))
    let cases = [
        ("gm_gets_roll_and_event", drain(&mut gm_rx), (true, true)),
        (
            "controller_gets_roll_and_event",
            drain(&mut owner_rx),
            (true, true),
        ),
        (
            "bystander_gets_neither",
            drain(&mut ally_rx),
            (false, false),
        ),
    ];
    for (case, frames, want) in cases {
        assert_eq!(saw(&frames), want, "case {case}");
    }
}
