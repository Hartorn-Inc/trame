//! Engine command seam for the tactical rules (GS4, GS11, GS14, UA5, UA6, UA15): apply
//! `TrameCommand`s to `TableState` and assert state, events, and the undo stack. Every test is
//! table-driven and each case carries a descriptive ID printed on failure.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use trame_engine::aoe::GridCell;
use trame_engine::rules::DamageAffinity;
use trame_engine::wasm_api::call_export;
use trame_engine::{
    CampaignRole, CommandActor, CommandError, Point2D, TableSnapshotData, TableState, TokenState,
    TrameCommand, TrameEvent,
};
use uuid::Uuid;

const PLAYER_ID: Uuid = Uuid::from_u128(0xA1);
const HERO_ID: Uuid = Uuid::from_u128(0x10);
const GOBLIN_ID: Uuid = Uuid::from_u128(0x20);

fn gm() -> CommandActor {
    CommandActor {
        user_id: Uuid::from_u128(0xF0),
        role: CampaignRole::Gm,
    }
}

fn player() -> CommandActor {
    CommandActor {
        user_id: PLAYER_ID,
        role: CampaignRole::Player,
    }
}

fn spectator() -> CommandActor {
    CommandActor {
        user_id: Uuid::from_u128(0xA9),
        role: CampaignRole::Spectator,
    }
}

fn opened_prompt_count(events: &[TrameEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, TrameEvent::ReactionPromptOpened { .. }))
        .count()
}

fn cell(col: i32, row: i32) -> GridCell {
    GridCell { col, row }
}

/// Starts Turn-by-Turn combat with `order` (first entry active) and clears the undo stack.
fn start_combat(state: &mut TableState, order: Vec<Uuid>) {
    state
        .apply_command(
            &gm(),
            TrameCommand::StartTurnByTurn {
                initiative_order: order,
                initiative_totals: BTreeMap::new(),
            },
        )
        .unwrap();
    state.undo_stack.clear();
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
        assert_eq!(
            resolution.concentration_check_dc, c.expect_dc,
            "case {}",
            c.id
        );
        assert_eq!(state.undo_stack.len(), 1, "case {} undo entry", c.id);
    }
}

#[test]
fn move_token_costs_chebyshev_squares_and_doubles_difficult_terrain() {
    #[derive(Clone, Copy)]
    struct Case {
        id: &'static str,
        to: (f64, f64),
        to_elevation_ft: f64,
        difficult: &'static [(i32, i32)],
        start_on_difficult: bool,
        squeezing: bool,
        expect_cost_ft: f64,
    }
    let base = Case {
        id: "",
        to: (300.0, 0.0),
        to_elevation_ft: 0.0,
        difficult: &[],
        start_on_difficult: false,
        squeezing: false,
        expect_cost_ft: 15.0,
    };
    let cases = [
        Case {
            id: "straight_costs_5ft_per_square",
            ..base
        },
        Case {
            id: "diagonal_costs_5ft",
            to: (300.0, 300.0),
            ..base
        },
        Case {
            id: "mixed_move_costs_the_longer_axis",
            to: (200.0, 100.0),
            expect_cost_ft: 10.0,
            ..base
        },
        Case {
            id: "difficult_terrain_doubles_cost",
            difficult: &[(1, 0), (2, 0)],
            expect_cost_ft: 25.0,
            ..base
        },
        Case {
            id: "difficult_diagonal_square_costs_10ft",
            to: (100.0, 100.0),
            difficult: &[(1, 1)],
            expect_cost_ft: 10.0,
            ..base
        },
        Case {
            id: "leaving_difficult_terrain_costs_normal",
            to: (100.0, 0.0),
            difficult: &[(0, 0)],
            start_on_difficult: true,
            expect_cost_ft: 5.0,
            ..base
        },
        Case {
            id: "climbing_costs_the_longer_of_horizontal_and_vertical",
            to: (100.0, 0.0),
            to_elevation_ft: 10.0,
            expect_cost_ft: 10.0,
            ..base
        },
        Case {
            id: "squeezing_doubles_the_difficult_cost",
            to: (100.0, 0.0),
            difficult: &[(1, 0)],
            squeezing: true,
            expect_cost_ft: 20.0,
            ..base
        },
        Case {
            id: "diagonal_over_budget_is_rejected",
            to: (700.0, 700.0),
            expect_cost_ft: 35.0,
            ..base
        },
    ];

    for c in cases {
        let mut hero = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
        hero.is_squeezing = c.squeezing;
        let mut state = table(vec![hero]);
        state.data.difficult_terrain = c.difficult.iter().map(|&(x, y)| cell(x, y)).collect();
        assert_eq!(
            state.data.difficult_terrain.contains(&cell(0, 0)),
            c.start_on_difficult,
            "case {} setup",
            c.id
        );
        start_combat(&mut state, vec![HERO_ID]);
        let to = Point2D::new(c.to.0, c.to.1);

        let wasm_preview: Value = serde_json::from_str(
            &call_export(
                "previewMove",
                &json!({
                    "walls": [],
                    "token": { "topLeft": {"x": 0.0, "y": 0.0}, "isSqueezing": c.squeezing },
                    "toTopLeft": to,
                    "toElevationFt": c.to_elevation_ft,
                    "cellSizePx": 100.0,
                    "feetPerCell": 5.0,
                    "difficultTerrain": state.data.difficult_terrain,
                })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            wasm_preview["costFt"],
            json!(c.expect_cost_ft),
            "case {} WASM preview",
            c.id
        );
        let native_preview =
            state.preview_move(&state.data.tokens[&HERO_ID], to, c.to_elevation_ft);
        assert_eq!(
            native_preview.cost_ft, c.expect_cost_ft,
            "case {} native preview",
            c.id
        );

        let result = state.apply_command(
            &player(),
            TrameCommand::MoveToken {
                token_id: HERO_ID,
                to_top_left: to,
                to_elevation_ft: Some(c.to_elevation_ft),
                gm_teleport: false,
            },
        );
        if c.expect_cost_ft <= 30.0 {
            result.unwrap_or_else(|e| panic!("case {}: {e}", c.id));
            assert_eq!(
                state.data.tokens[&HERO_ID].speed_remaining_ft,
                30.0 - c.expect_cost_ft,
                "case {} remaining speed",
                c.id
            );
            assert_eq!(state.undo_stack.len(), 1, "case {} undo entry", c.id);
        } else {
            assert_eq!(
                result.unwrap_err(),
                CommandError::InsufficientMovement {
                    needed_ft: c.expect_cost_ft,
                    remaining_ft: 30.0,
                },
                "case {}",
                c.id
            );
            assert!(state.undo_stack.is_empty(), "case {} no undo", c.id);
        }
    }
}

#[test]
fn set_difficult_terrain_is_gm_only_on_map_and_undoable() {
    struct Case {
        id: &'static str,
        actor: CommandActor,
        cells: Vec<GridCell>,
        difficult: bool,
        expect_err: Option<&'static str>,
        expect_cells: Vec<GridCell>,
    }
    let painted = vec![cell(1, 1), cell(2, 1)];
    let cases = [
        Case {
            id: "gm_paints_difficult_cells",
            actor: gm(),
            cells: vec![cell(3, 3), cell(4, 3)],
            difficult: true,
            expect_err: None,
            expect_cells: vec![cell(1, 1), cell(2, 1), cell(3, 3), cell(4, 3)],
        },
        Case {
            id: "gm_erases_difficult_cells",
            actor: gm(),
            cells: vec![cell(1, 1)],
            difficult: false,
            expect_err: None,
            expect_cells: vec![cell(2, 1)],
        },
        Case {
            id: "player_cannot_paint_difficult_terrain",
            actor: player(),
            cells: vec![cell(3, 3)],
            difficult: true,
            expect_err: Some("permission denied"),
            expect_cells: painted.clone(),
        },
        Case {
            id: "off_map_cell_is_rejected",
            actor: gm(),
            cells: vec![cell(3, 3), cell(20, 0)],
            difficult: true,
            expect_err: Some("outside the 20x20 map grid"),
            expect_cells: painted.clone(),
        },
        Case {
            id: "negative_cell_is_rejected",
            actor: gm(),
            cells: vec![cell(-1, 0)],
            difficult: true,
            expect_err: Some("outside"),
            expect_cells: painted.clone(),
        },
        Case {
            id: "empty_cell_list_is_rejected",
            actor: gm(),
            cells: vec![],
            difficult: true,
            expect_err: Some("must not be empty"),
            expect_cells: painted.clone(),
        },
    ];

    for c in cases {
        let mut state = table(vec![]);
        state.data.difficult_terrain = painted.iter().copied().collect();
        let result = state.apply_command(
            &c.actor,
            TrameCommand::SetDifficultTerrain {
                cells: c.cells.clone(),
                difficult: c.difficult,
            },
        );
        let actual: Vec<GridCell> = state.data.difficult_terrain.iter().copied().collect();
        assert_eq!(actual, c.expect_cells, "case {} cells", c.id);
        match c.expect_err {
            Some(fragment) => {
                let message = result.unwrap_err().to_string();
                assert!(message.contains(fragment), "case {}: {message}", c.id);
                assert!(state.undo_stack.is_empty(), "case {} no undo", c.id);
            }
            None => {
                let events = result.unwrap_or_else(|e| panic!("case {}: {e}", c.id));
                assert_eq!(
                    events,
                    vec![TrameEvent::DifficultTerrainChanged {
                        cells: c.cells.clone(),
                        difficult: c.difficult,
                    }],
                    "case {} events",
                    c.id
                );
                state
                    .apply_command(&gm(), TrameCommand::UndoLastAction)
                    .unwrap();
                let restored: Vec<GridCell> =
                    state.data.difficult_terrain.iter().copied().collect();
                assert_eq!(restored, painted, "case {} undo restores", c.id);
            }
        }
    }
}

#[test]
fn snapshots_written_before_the_tactical_fields_still_load() {
    let mut state = table(vec![token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID))]);
    state.data.difficult_terrain.insert(cell(1, 1));
    let mut legacy = serde_json::to_value(&state.data).unwrap();
    legacy.as_object_mut().unwrap().remove("difficult_terrain");
    let loaded: TableSnapshotData = serde_json::from_value(legacy).unwrap();
    assert!(loaded.difficult_terrain.is_empty());
    assert_eq!(loaded.tokens[&HERO_ID].name, "Kyra");
}

#[test]
fn opportunity_prompts_follow_weapon_reach_and_disengage() {
    #[derive(Clone, Copy)]
    struct Case {
        id: &'static str,
        hero_x: f64,
        goblin_reach_ft: f64,
        disengage: bool,
        full_rounds_before_move: u32,
        expect_prompt: bool,
    }
    let base = Case {
        id: "",
        hero_x: 100.0,
        goblin_reach_ft: 5.0,
        disengage: false,
        full_rounds_before_move: 0,
        expect_prompt: true,
    };
    let cases = [
        Case {
            id: "default_reach_threatens_adjacent_square",
            ..base
        },
        Case {
            id: "default_reach_ignores_mover_10ft_away",
            hero_x: 200.0,
            expect_prompt: false,
            ..base
        },
        Case {
            id: "reach_weapon_threatens_10ft",
            hero_x: 200.0,
            goblin_reach_ft: 10.0,
            ..base
        },
        Case {
            id: "disengage_suppresses_reaction_prompt",
            disengage: true,
            expect_prompt: false,
            ..base
        },
        Case {
            id: "disengage_suppresses_reach_weapon_prompt",
            hero_x: 200.0,
            goblin_reach_ft: 10.0,
            disengage: true,
            expect_prompt: false,
            ..base
        },
        Case {
            id: "disengage_ends_when_the_next_turn_starts",
            disengage: true,
            full_rounds_before_move: 1,
            ..base
        },
    ];

    for c in cases {
        let hero = token(HERO_ID, "Kyra", c.hero_x, 0.0, Some(PLAYER_ID));
        let mut goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
        goblin.reach_ft = c.goblin_reach_ft;
        let mut state = table(vec![hero, goblin]);
        start_combat(&mut state, vec![HERO_ID, GOBLIN_ID]);

        if c.disengage {
            let events = state
                .apply_command(
                    &player(),
                    TrameCommand::SetDisengaged {
                        token_id: HERO_ID,
                        disengaged: true,
                    },
                )
                .unwrap_or_else(|e| panic!("case {}: {e}", c.id));
            assert_eq!(
                events,
                vec![TrameEvent::TokenDisengaged {
                    token_id: HERO_ID,
                    disengaged: true,
                }],
                "case {} events",
                c.id
            );
        }
        for _ in 0..c.full_rounds_before_move * 2 {
            state
                .apply_command(&gm(), TrameCommand::AdvanceTurn)
                .unwrap();
        }
        assert_eq!(
            state.data.tokens[&HERO_ID].disengaged,
            c.disengage && c.full_rounds_before_move == 0,
            "case {} flag before the move",
            c.id
        );

        let events = state
            .apply_command(
                &player(),
                TrameCommand::MoveToken {
                    token_id: HERO_ID,
                    to_top_left: Point2D::new(600.0, 0.0),
                    to_elevation_ft: None,
                    gm_teleport: false,
                },
            )
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));
        assert_eq!(
            opened_prompt_count(&events),
            usize::from(c.expect_prompt),
            "case {} prompts",
            c.id
        );
        assert_eq!(
            state.data.active_reaction_prompts.len(),
            usize::from(c.expect_prompt),
            "case {} prompt state",
            c.id
        );
    }
}

#[test]
fn set_disengaged_requires_token_control_and_is_undoable() {
    struct Case {
        id: &'static str,
        actor: CommandActor,
        target: Uuid,
        expect_ok: bool,
    }
    let cases = [
        Case {
            id: "player_disengages_own_token",
            actor: player(),
            target: HERO_ID,
            expect_ok: true,
        },
        Case {
            id: "gm_disengages_any_token",
            actor: gm(),
            target: GOBLIN_ID,
            expect_ok: true,
        },
        Case {
            id: "player_cannot_disengage_other_token",
            actor: player(),
            target: GOBLIN_ID,
            expect_ok: false,
        },
        Case {
            id: "spectator_cannot_disengage",
            actor: spectator(),
            target: HERO_ID,
            expect_ok: false,
        },
    ];
    for c in cases {
        let mut state = table(vec![
            token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID)),
            token(GOBLIN_ID, "Goblin", 0.0, 0.0, None),
        ]);
        let result = state.apply_command(
            &c.actor,
            TrameCommand::SetDisengaged {
                token_id: c.target,
                disengaged: true,
            },
        );
        assert_eq!(result.is_ok(), c.expect_ok, "case {}: {result:?}", c.id);
        assert_eq!(
            state.data.tokens[&c.target].disengaged, c.expect_ok,
            "case {} flag",
            c.id
        );
        assert_eq!(
            state.undo_stack.len(),
            usize::from(c.expect_ok),
            "case {} undo",
            c.id
        );
        if c.expect_ok {
            state
                .apply_command(&gm(), TrameCommand::UndoLastAction)
                .unwrap();
            assert!(
                !state.data.tokens[&c.target].disengaged,
                "case {} undone",
                c.id
            );
        }
    }
}
