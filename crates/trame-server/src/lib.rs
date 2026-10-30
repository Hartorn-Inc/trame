#![allow(
    async_fn_in_trait,
    clippy::unnecessary_sort_by,
    clippy::too_many_arguments,
    clippy::type_complexity
)]

pub mod dice;
pub mod http;
pub mod room;
pub mod sync;
pub mod wal;

#[cfg(test)]
mod tests {
    use crate::dice::{RollVisibility, SeededDiceRoller, project_roll_for_recipient};
    use crate::room::{ConnectedClient, RoomLeaseManager};
    use crate::sync::{
        ClientEnvelope, ServerEnvelope, encode_server_envelope, project_state_for_recipient,
    };
    use crate::wal::{InMemoryWalStorage, TableStateSnapshot, WalStorage, recover_table_state};
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use trame_engine::commands::{CampaignRole, TableState, TokenState, TrameCommand};
    use trame_engine::geometry::{Bvh2D, Point2D, WallKind, WallSegment};
    use uuid::Uuid;

    #[test]
    fn chacha20_dice_roller_supports_advantage_disadvantage_and_blind_gm_filtering() {
        let mut roller = SeededDiceRoller::from_seed([42u8; 32]);
        let gm_id = Uuid::new_v4();
        let player_id = Uuid::new_v4();
        let bystander_id = Uuid::new_v4();

        let cases = [
            ("1d20+5", RollVisibility::Public, "attack_roll"),
            ("2d20kh1+7", RollVisibility::GmOnly, "advantage_stealth"),
            ("2d20kl1-1", RollVisibility::BlindGm, "blind_death_save"),
            ("8d6", RollVisibility::Public, "fireball_damage"),
        ];

        for (expr, vis, label) in cases {
            let outcome = roller
                .roll(player_id, expr, vis, label)
                .expect("valid dice expression");
            assert!(!outcome.terms.is_empty(), "case {label}");

            let gm_view = project_roll_for_recipient(&outcome, gm_id, CampaignRole::Gm)
                .expect("GM always sees every roll");
            assert!(!gm_view.blind_masked, "GM sees unmasked roll for {label}");
            assert_eq!(gm_view.total, Some(outcome.total));

            let player_view = project_roll_for_recipient(&outcome, player_id, CampaignRole::Player)
                .expect("Roller always gets an acknowledgment");
            let bystander_view =
                project_roll_for_recipient(&outcome, bystander_id, CampaignRole::Player);

            match vis {
                RollVisibility::Public => {
                    assert_eq!(player_view.total, Some(outcome.total));
                    assert!(bystander_view.is_some());
                }
                RollVisibility::GmOnly => {
                    assert_eq!(player_view.total, Some(outcome.total));
                    assert!(bystander_view.is_none());
                }
                RollVisibility::BlindGm => {
                    assert!(player_view.blind_masked);
                    assert_eq!(player_view.total, None);
                    assert!(player_view.terms.is_empty());
                    assert!(bystander_view.is_none());
                }
            }
        }
    }

    #[test]
    fn server_side_projection_strips_hidden_tokens_and_masks_secret_doors() {
        let campaign_id = Uuid::new_v4();
        let gm_id = Uuid::new_v4();
        let player_id = Uuid::new_v4();

        let mut secret_wall = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(200.0, 0.0),
            Point2D::new(200.0, 400.0),
        );
        secret_wall.kind = WallKind::SecretDoor { is_open: false };

        let mut state = TableState::new(100.0, 5.0, vec![secret_wall]);
        state.bvh = Bvh2D::build(state.data.walls.clone());

        let player_token_id = Uuid::new_v4();
        let mut player_tok =
            TokenState::new_default(player_token_id, "Player Paladin", Point2D::new(0.0, 0.0));
        player_tok.owner_user_id = Some(player_id);
        state.data.tokens.insert(player_token_id, player_tok);

        let visible_goblin_id = Uuid::new_v4();
        let goblin_tok = TokenState::new_default(
            visible_goblin_id,
            "Visible Goblin",
            Point2D::new(0.0, 100.0),
        );
        state.data.tokens.insert(visible_goblin_id, goblin_tok);

        let occluded_lich_id = Uuid::new_v4();
        let lich_tok = TokenState::new_default(
            occluded_lich_id,
            "Occluded Lich Behind Secret Door",
            Point2D::new(300.0, 0.0),
        );
        state.data.tokens.insert(occluded_lich_id, lich_tok);

        let player_proj =
            project_state_for_recipient(campaign_id, &state, player_id, CampaignRole::Player);
        assert!(player_proj.tokens.contains_key(&player_token_id));
        assert!(player_proj.tokens.contains_key(&visible_goblin_id));
        assert!(
            !player_proj.tokens.contains_key(&occluded_lich_id),
            "Occluded token behind wall must never be sent to player socket"
        );
        assert_eq!(
            player_proj.walls[0].kind,
            WallKind::Normal,
            "Closed SecretDoor must be masked as Normal wall on player wire payload"
        );

        let gm_proj = project_state_for_recipient(campaign_id, &state, gm_id, CampaignRole::Gm);
        assert_eq!(gm_proj.tokens.len(), 3);
        assert_eq!(
            gm_proj.walls[0].kind,
            WallKind::SecretDoor { is_open: false }
        );
    }

    #[tokio::test]
    async fn room_actor_wal_recovery_and_idle_lease_hibernation() {
        let wal = Arc::new(InMemoryWalStorage::new());
        let campaign_id = Uuid::new_v4();
        let player_id = Uuid::new_v4();
        let token_id = Uuid::new_v4();

        let mut initial = TableState::new(100.0, 5.0, Vec::new());
        let mut ranger = TokenState::new_default(token_id, "Ranger", Point2D::new(0.0, 0.0));
        ranger.owner_user_id = Some(player_id);
        initial.data.tokens.insert(token_id, ranger);

        wal.save_snapshot(TableStateSnapshot {
            campaign_id,
            snapshot_seq_id: 0,
            captured_at_ms: 1000,
            cell_size_px: initial.cell_size_px,
            feet_per_cell: initial.feet_per_cell,
            data: initial.data,
        })
        .unwrap();

        let lease_mgr = RoomLeaseManager::new(wal.clone(), 10, 900_000);
        let handle = lease_mgr.get_or_wake_room(campaign_id).await.unwrap();
        assert_eq!(lease_mgr.active_room_count().await, 1);

        let (tx, mut rx) = mpsc::unbounded_channel();
        let session_id = Uuid::new_v4();
        handle
            .connect_client(ConnectedClient {
                session_id,
                user_id: player_id,
                role: CampaignRole::Player,
                tx,
            })
            .await
            .unwrap();

        let first_frame = rx.recv().await.unwrap();
        let decoded: ServerEnvelope = rmp_serde::from_slice(&first_frame).unwrap();
        assert!(matches!(
            decoded,
            ServerEnvelope::StateSnapshot { seq_id: 0, .. }
        ));

        handle
            .send_envelope(
                session_id,
                ClientEnvelope::SubmitCommand(TrameCommand::MoveToken {
                    token_id,
                    to_top_left: Point2D::new(200.0, 0.0),
                    to_elevation_ft: None,
                    gm_teleport: false,
                }),
            )
            .await
            .unwrap();

        let second_frame = rx.recv().await.unwrap();
        let decoded_move: ServerEnvelope = rmp_serde::from_slice(&second_frame).unwrap();
        match decoded_move {
            ServerEnvelope::CommandAccepted {
                seq_id, ref state, ..
            } => {
                assert_eq!(seq_id, 1);
                assert_eq!(state.tokens[&token_id].top_left, Point2D::new(200.0, 0.0));
                assert!(encode_server_envelope(&decoded_move).is_ok());
            }
            other => panic!("Expected CommandAccepted, got {other:?}"),
        }

        // Verify crash recovery from WAL (snapshot @ 0 + WAL entry @ 1)
        let (recovered_state, recovered_seq) =
            recover_table_state(wal.as_ref(), campaign_id).unwrap();
        assert_eq!(recovered_seq, 1);
        assert_eq!(
            recovered_state.data.tokens[&token_id].top_left,
            Point2D::new(200.0, 0.0)
        );

        // Disconnect client and trigger Idle-Lease sweep past 15-minute threshold
        handle.disconnect_client(session_id).await.unwrap();
        let metrics = handle.metrics().await.unwrap();
        assert_eq!(metrics.active_connections, 0);

        let hibernated = lease_mgr
            .sweep_idle_rooms(metrics.last_activity_ms + 900_001)
            .await;
        assert_eq!(hibernated, vec![campaign_id]);
        assert_eq!(lease_mgr.active_room_count().await, 0);

        // Waking the room again restores seq_id = 1 transparently
        let woken = lease_mgr.get_or_wake_room(campaign_id).await.unwrap();
        let woken_metrics = woken.metrics().await.unwrap();
        assert_eq!(woken_metrics.seq_id, 1);
    }
}
