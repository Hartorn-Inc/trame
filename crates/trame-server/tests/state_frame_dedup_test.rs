//! ============================================================================
//! UNCHANGED PROJECTION FRAME SKIPPING (state_frame_dedup_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Checks RT12 at the room seam: after a command commits, a recipient whose
//!   projection is unchanged since the last state frame it was sent (and who
//!   sees no event) gets no frame, a recipient whose projection changed gets a
//!   `CommandAccepted`, and a reconnect always starts from a full
//!   `StateSnapshot`. A visible event is sent even when the projection is
//!   unchanged, and an out-of-band change (sheet sync) pushes a snapshot whose
//!   hash later commands compare against.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - The actor enqueues every frame before it answers the dispatch, so an
//!     empty queue right after `dispatch_direct_command` means "not sent".
//! ============================================================================

use std::sync::Arc;
use tokio::sync::mpsc;
use trame_engine::commands::{
    CampaignRole, CommandActor, TableState, TokenState, TrameCommand, TrameEvent,
};
use trame_engine::geometry::{CHANNEL_GM_HIDDEN, Point2D};
use trame_server::room::{
    ActorTacticalSync, ConnectedClient, OutboundClientFrame, TableRoomActor, TableRoomHandle,
    client_channel,
};
use trame_server::sync::ServerEnvelope;
use trame_server::wal::{InMemoryWalStorage, TableStateSnapshot, WalStorage};
use uuid::Uuid;

struct Table {
    room: TableRoomHandle,
    gm: CommandActor,
    player: Uuid,
    /// Token controlled by `player`.
    hero: Uuid,
    /// Actor sheet linked to `hero` (sheet syncs reach the hero through it).
    hero_actor: Uuid,
    /// GM-hidden token the player never sees.
    lurker: Uuid,
}

impl Table {
    fn new() -> Self {
        let campaign_id = Uuid::new_v4();
        let player = Uuid::new_v4();
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        let hero = Uuid::new_v4();
        let mut hero_token = TokenState::new_default(hero, "Hero", Point2D::new(100.0, 100.0));
        hero_token.owner_user_id = Some(player);
        let hero_actor = Uuid::new_v4();
        hero_token.actor_id = Some(hero_actor);
        state.data.tokens.insert(hero, hero_token);
        let lurker = Uuid::new_v4();
        let mut lurker_token =
            TokenState::new_default(lurker, "Lurker", Point2D::new(300.0, 100.0));
        lurker_token.visibility_channel |= CHANNEL_GM_HIDDEN;
        state.data.tokens.insert(lurker, lurker_token);

        let wal = Arc::new(InMemoryWalStorage::new());
        wal.save_snapshot(TableStateSnapshot::capture(campaign_id, 0, 0, &state))
            .unwrap();
        Self {
            room: TableRoomActor::spawn(campaign_id, wal, 25).unwrap(),
            gm: CommandActor {
                user_id: Uuid::new_v4(),
                role: CampaignRole::Gm,
            },
            player,
            hero,
            hero_actor,
            lurker,
        }
    }

    async fn connect(
        &self,
        user_id: Uuid,
        role: CampaignRole,
    ) -> (Uuid, mpsc::Receiver<OutboundClientFrame>) {
        let (tx, rx) = client_channel();
        let session_id = Uuid::new_v4();
        self.room
            .connect_client(ConnectedClient {
                session_id,
                user_id,
                role,
                tx,
            })
            .await
            .unwrap();
        (session_id, rx)
    }

    /// GM teleport of `token_id` to `(x, 100)`.
    async fn gm_moves(&self, token_id: Uuid, x: f64) {
        self.room
            .dispatch_direct_command(
                self.gm.clone(),
                TrameCommand::MoveToken {
                    token_id,
                    to_top_left: Point2D::new(x, 100.0),
                    to_elevation_ft: None,
                    gm_teleport: true,
                },
            )
            .await
            .unwrap();
    }
}

fn drain(rx: &mut mpsc::Receiver<OutboundClientFrame>) -> Vec<ServerEnvelope> {
    let mut out = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if let OutboundClientFrame::Binary(bytes) = frame {
            out.push(rmp_serde::from_slice(&bytes).unwrap());
        }
    }
    out
}

/// Short frame label: `"snapshot"`, `"accepted"`, or `"other"`.
fn kinds(frames: &[ServerEnvelope]) -> Vec<&'static str> {
    frames
        .iter()
        .map(|f| match f {
            ServerEnvelope::StateSnapshot { .. } => "snapshot",
            ServerEnvelope::CommandAccepted { .. } => "accepted",
            _ => "other",
        })
        .collect()
}

/// `x` of the hero in the last state-carrying frame, if any.
fn hero_x(frames: &[ServerEnvelope], hero: Uuid) -> Option<f64> {
    frames.iter().rev().find_map(|f| match f {
        ServerEnvelope::StateSnapshot { state, .. }
        | ServerEnvelope::CommandAccepted { state, .. } => {
            state.tokens.get(&hero).map(|t| t.top_left.x)
        }
        _ => None,
    })
}

#[tokio::test]
async fn unchanged_projection_sends_nothing_and_changed_projection_sends_a_frame() {
    let table = Table::new();
    let (_, mut gm_rx) = table.connect(table.gm.user_id, CampaignRole::Gm).await;
    let (_, mut player_rx) = table.connect(table.player, CampaignRole::Player).await;
    assert_eq!(kinds(&drain(&mut gm_rx)), ["snapshot"]);
    assert_eq!(kinds(&drain(&mut player_rx)), ["snapshot"]);

    // (case_id, token moved, x, frames for the GM, frames for the player)
    let cases: [(&str, Uuid, f64, &[&str], &[&str]); 4] = [
        (
            "gm_moves_hidden_token_player_projection_unchanged",
            table.lurker,
            500.0,
            &["accepted"],
            &[],
        ),
        (
            "second_hidden_move_still_skipped_for_player",
            table.lurker,
            600.0,
            &["accepted"],
            &[],
        ),
        (
            "gm_moves_player_token_projection_changed",
            table.hero,
            200.0,
            &["accepted"],
            &["accepted"],
        ),
        (
            "hidden_move_after_a_sent_frame_skipped_again",
            table.lurker,
            700.0,
            &["accepted"],
            &[],
        ),
    ];
    for (case, token_id, x, want_gm, want_player) in cases {
        table.gm_moves(token_id, x).await;
        assert_eq!(kinds(&drain(&mut gm_rx)), want_gm, "case {case}: GM frames");
        let player_frames = drain(&mut player_rx);
        assert_eq!(
            kinds(&player_frames),
            want_player,
            "case {case}: player frames"
        );
        if token_id == table.hero {
            assert_eq!(hero_x(&player_frames, table.hero), Some(x), "case {case}");
        }
    }
}

#[tokio::test]
async fn visible_event_with_unchanged_projection_is_still_sent() {
    let table = Table::new();
    let (_, mut gm_rx) = table.connect(table.gm.user_id, CampaignRole::Gm).await;
    let (_, mut player_rx) = table.connect(table.player, CampaignRole::Player).await;
    drain(&mut gm_rx);
    drain(&mut player_rx);
    let (_, current) = table.room.get_table_snapshot().await.unwrap();

    // Re-selecting the current ambient preset changes no projection but emits a public
    // `AmbientLightingChanged`.
    table
        .room
        .dispatch_direct_command(
            table.gm.clone(),
            TrameCommand::SetAmbientLighting {
                preset: current.data.ambient_lighting,
            },
        )
        .await
        .unwrap();
    let frames = drain(&mut player_rx);
    assert_eq!(kinds(&frames), ["accepted"], "case visible_event_sent");
    let Some(ServerEnvelope::CommandAccepted { events, .. }) = frames.first() else {
        panic!("case visible_event_sent: no CommandAccepted");
    };
    assert!(
        events
            .iter()
            .any(|e| matches!(e, TrameEvent::AmbientLightingChanged { .. })),
        "case visible_event_sent: event carried"
    );
}

#[tokio::test]
async fn out_of_band_change_then_commands_keep_hashes_in_step() {
    let linked = Table::new();
    let (_, mut player_rx) = linked.connect(linked.player, CampaignRole::Player).await;
    drain(&mut player_rx);

    linked
        .room
        .notify_actor_updated(
            linked.hero_actor,
            Some(linked.player),
            2,
            serde_json::json!({}),
            ActorTacticalSync {
                hp_current: Some(1),
                ..ActorTacticalSync::default()
            },
        )
        .await
        .unwrap();
    // `ActorUpdated` (the controller's sheet) then the changed projection.
    let pushed = drain(&mut player_rx);
    assert_eq!(
        kinds(&pushed),
        ["other", "snapshot"],
        "case out_of_band_change_pushed"
    );

    // (case_id, token moved, x, frames for the player)
    let cases: [(&str, Uuid, f64, &[&str]); 2] = [
        ("hidden_move_after_push_skipped", linked.lurker, 650.0, &[]),
        (
            "visible_move_after_push_sent",
            linked.hero,
            350.0,
            &["accepted"],
        ),
    ];
    for (case, token_id, x, want) in cases {
        linked.gm_moves(token_id, x).await;
        let frames = drain(&mut player_rx);
        assert_eq!(kinds(&frames), want, "case {case}");
        if token_id == linked.hero {
            assert_eq!(hero_x(&frames, linked.hero), Some(x), "case {case}");
        }
    }
}

#[tokio::test]
async fn reconnect_gets_a_full_snapshot_then_skipping_resumes() {
    let table = Table::new();
    let (_, mut gm_rx) = table.connect(table.gm.user_id, CampaignRole::Gm).await;
    let (first_session, mut first_rx) = table.connect(table.player, CampaignRole::Player).await;
    drain(&mut gm_rx);
    drain(&mut first_rx);

    table.room.disconnect_client(first_session).await.unwrap();
    table.gm_moves(table.hero, 250.0).await;
    table.gm_moves(table.lurker, 800.0).await;

    let (_, mut player_rx) = table.connect(table.player, CampaignRole::Player).await;
    let resync = drain(&mut player_rx);
    assert_eq!(
        kinds(&resync),
        ["snapshot"],
        "reconnect_starts_with_full_snapshot"
    );
    assert_eq!(
        hero_x(&resync, table.hero),
        Some(250.0),
        "snapshot_carries_changes_made_while_disconnected"
    );

    // (case_id, token moved, x, frames for the reconnected player)
    let cases: [(&str, Uuid, f64, &[&str]); 2] = [
        ("hidden_move_after_resync_skipped", table.lurker, 900.0, &[]),
        (
            "visible_move_after_resync_sent",
            table.hero,
            300.0,
            &["accepted"],
        ),
    ];
    for (case, token_id, x, want) in cases {
        table.gm_moves(token_id, x).await;
        assert_eq!(kinds(&drain(&mut player_rx)), want, "case {case}");
    }
}
