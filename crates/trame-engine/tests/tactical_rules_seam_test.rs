//! Engine command seam for the tactical rules (GS4, GS11, GS14, UA5, UA6, UA15): apply
//! `TrameCommand`s to `TableState` and assert state, events, and the undo stack. Every test is
//! table-driven and each case carries a descriptive ID printed on failure.

use trame_engine::rules::DamageAffinity;
use trame_engine::{
    CampaignRole, CommandActor, Point2D, TableState, TokenState, TrameCommand, TrameEvent,
};
use uuid::Uuid;

const PLAYER_ID: Uuid = Uuid::from_u128(0xA1);
const HERO_ID: Uuid = Uuid::from_u128(0x10);

fn gm() -> CommandActor {
    CommandActor {
        user_id: Uuid::from_u128(0xF0),
        role: CampaignRole::Gm,
    }
}

fn token(id: Uuid, name: &str, x: f64, y: f64, owner: Option<Uuid>) -> TokenState {
    let mut t = TokenState::new_default(id, name, Point2D::new(x, y));
    t.owner_user_id = owner;
    t
}

/// Table (100 px cells, 5 ft per cell) holding `tokens`, with an empty undo stack.
fn table(tokens: Vec<TokenState>) -> TableState {
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    for t in tokens {
        state.data.tokens.insert(t.id, t);
    }
    state
}

#[test]
fn concentration_check_dc_is_half_damage_between_10_and_30() {
    struct Case {
        id: &'static str,
        raw_damage: i32,
        concentrating: bool,
        expect_dc: Option<i32>,
    }
    let cases = [
        Case {
            id: "concentration_dc_floor_is_10",
            raw_damage: 8,
            concentrating: true,
            expect_dc: Some(10),
        },
        Case {
            id: "concentration_dc_is_half_damage",
            raw_damage: 45,
            concentrating: true,
            expect_dc: Some(22),
        },
        Case {
            id: "concentration_dc_reaches_30_at_60_damage",
            raw_damage: 60,
            concentrating: true,
            expect_dc: Some(30),
        },
        Case {
            id: "concentration_dc_capped_at_30",
            raw_damage: 150,
            concentrating: true,
            expect_dc: Some(30),
        },
        Case {
            id: "no_check_without_concentration",
            raw_damage: 150,
            concentrating: false,
            expect_dc: None,
        },
    ];
    for c in cases {
        let mut hero = token(HERO_ID, "Ezren", 0.0, 0.0, Some(PLAYER_ID));
        hero.max_hp = 500;
        hero.hp = 500;
        hero.concentrating_on_aoe_id = c.concentrating.then(|| Uuid::from_u128(0xAE));
        let mut state = table(vec![hero]);

        let events = state
            .apply_command(
                &gm(),
                TrameCommand::ApplyDamage {
                    token_id: HERO_ID,
                    raw_damage: c.raw_damage,
                    affinity: DamageAffinity::Normal,
                    is_critical: false,
                    damage_type: None,
                },
            )
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));

        let Some(TrameEvent::DamageApplied { resolution, .. }) = events.first() else {
            panic!("case {}: expected DamageApplied, got {events:?}", c.id);
        };
        assert_eq!(resolution.concentration_check_dc, c.expect_dc, "case {}", c.id);
        assert_eq!(state.undo_stack.len(), 1, "case {} undo entry", c.id);
    }
}
