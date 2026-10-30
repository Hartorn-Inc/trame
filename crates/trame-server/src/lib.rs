#![allow(
    async_fn_in_trait,
    clippy::unnecessary_sort_by,
    clippy::too_many_arguments,
    clippy::type_complexity
)]

//! ============================================================================
//! TRAME MULTIPLAYER RUNTIME & ROOM ACTOR CRATE ROOT (lib.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Orchestrates the authoritative multiplayer server runtime for `trame`:
//! cryptographically seeded ChaCha20 dice resolution (`dice`), Axum HTTP/WebSocket
//! transport (`http`), isolated per-campaign Tokio actor loops with `Idle-Lease`
//! hibernation (`room`), MessagePack binary wire framing with 2.5D BVH line-of-sight
//! state stripping (`sync`), Write-Ahead Log (WAL) + write-behind snapshot crash
//! recovery (`wal`), and streaming PKWARE portable campaign archive export/import (`archive`).
//!
//! ============================================================================

pub mod archive;
pub mod dice;
pub mod http;
pub mod room;
pub mod storage;
pub mod sync;
pub mod wal;

#[cfg(test)]
mod tests {
    use crate::dice::{RollVisibility, SeededDiceRoller, project_roll_for_recipient};
    use trame_engine::commands::CampaignRole;
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
                    let bystander = bystander_view.expect("Public roll visible to bystander");
                    assert_eq!(bystander.total, Some(outcome.total));
                }
                RollVisibility::GmOnly => {
                    assert_eq!(player_view.total, Some(outcome.total));
                    assert!(bystander_view.is_none(), "GmOnly hidden from other players");
                }
                RollVisibility::BlindGm => {
                    assert!(player_view.blind_masked);
                    assert_eq!(player_view.total, None);
                    assert!(player_view.terms.is_empty());
                    assert!(bystander_view.is_none(), "BlindGm hidden from bystanders");
                }
            }
        }
    }
}
