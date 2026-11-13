//! Engine command seam: apply `TrameCommand`s to `TableState` and assert the resulting state,
//! events, and undo stack. Each test is table-driven; every case carries a descriptive ID that
//! is printed on failure.

use std::collections::BTreeMap;
use trame_engine::aoe::{AoeShape, AoeTemplate, GridDiscretizationMode};
use trame_engine::{
    CampaignRole, CommandActor, CommandError, McpStagingProposal, Point2D, ReactionDecision,
    ReactionPromptCloseReason, RefundableResource, SceneActivation, TableMode, TableState,
    TokenState, TrameCommand, TrameEvent, WallKind, WallSegment,
};
use uuid::Uuid;

const PLAYER_ID: Uuid = Uuid::from_u128(0xA1);
const OTHER_PLAYER_ID: Uuid = Uuid::from_u128(0xA2);
const HERO_ID: Uuid = Uuid::from_u128(0x10);
const GOBLIN_ID: Uuid = Uuid::from_u128(0x20);
const GOBLIN_B_ID: Uuid = Uuid::from_u128(0x21);

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

fn token(id: Uuid, name: &str, x: f64, y: f64, owner: Option<Uuid>) -> TokenState {
    let mut t = TokenState::new_default(id, name, Point2D::new(x, y));
    t.owner_user_id = owner;
    t
}

/// Table with `tokens` placed and, when `order` is non-empty, Turn-by-Turn combat started with
/// the first entry active. The undo stack is cleared so tests only see their own entries.
fn table(tokens: Vec<TokenState>, order: Vec<Uuid>) -> TableState {
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    for t in tokens {
        state.data.tokens.insert(t.id, t);
    }
    if !order.is_empty() {
        state
            .apply_command(
                &gm(),
                TrameCommand::StartTurnByTurn {
                    initiative_order: order,
                    initiative_totals: BTreeMap::new(),
                },
            )
            .unwrap();
    }
    state.undo_stack.clear();
    state
}

fn move_cmd(token_id: Uuid, x: f64, gm_teleport: bool) -> TrameCommand {
    TrameCommand::MoveToken {
        token_id,
        to_top_left: Point2D::new(x, 0.0),
        to_elevation_ft: None,
        gm_teleport,
    }
}

fn opened_prompts(events: &[TrameEvent]) -> Vec<trame_engine::ReactionPrompt> {
    events
        .iter()
        .filter_map(|e| match e {
            TrameEvent::ReactionPromptOpened { prompt } => Some(prompt.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn move_token_stops_on_threat_reach_exit_and_prompts_the_reactor() {
    #[derive(Clone, Copy)]
    struct Case {
        id: &'static str,
        from_x: f64,
        to_x: f64,
        reach_ft: f64,
        reactor_y: f64,
        reactor_has_reaction: bool,
        reactor_hp: i32,
        reactor_owner: Option<Uuid>,
        in_combat: bool,
        gm_teleport: bool,
        expect_stop_x: f64,
        expect_prompt: bool,
    }
    let base = Case {
        id: "",
        from_x: 100.0,
        to_x: 400.0,
        reach_ft: 5.0,
        reactor_y: 0.0,
        reactor_has_reaction: true,
        reactor_hp: 7,
        reactor_owner: None,
        in_combat: true,
        gm_teleport: false,
        expect_stop_x: 400.0,
        expect_prompt: false,
    };
    let cases = [
        Case {
            id: "leaving_adjacent_reach_stops_on_the_start_square",
            expect_stop_x: 100.0,
            expect_prompt: true,
            ..base
        },
        Case {
            id: "leaving_10ft_reach_stops_on_last_threatened_square",
            reach_ft: 10.0,
            expect_stop_x: 200.0,
            expect_prompt: true,
            ..base
        },
        Case {
            id: "passing_through_reach_prompts",
            from_x: -300.0,
            to_x: 300.0,
            reactor_y: 100.0,
            expect_stop_x: 100.0,
            expect_prompt: true,
            ..base
        },
        Case {
            id: "moving_inside_reach_does_not_prompt",
            reach_ft: 10.0,
            to_x: 200.0,
            expect_stop_x: 200.0,
            ..base
        },
        Case {
            id: "approaching_from_outside_reach_does_not_prompt",
            from_x: 400.0,
            to_x: 100.0,
            expect_stop_x: 100.0,
            ..base
        },
        Case {
            id: "reactor_without_reaction_does_not_prompt",
            reactor_has_reaction: false,
            ..base
        },
        Case {
            id: "downed_reactor_does_not_prompt",
            reactor_hp: 0,
            ..base
        },
        Case {
            id: "allied_hero_does_not_prompt",
            reactor_owner: Some(OTHER_PLAYER_ID),
            ..base
        },
        Case {
            id: "gm_teleport_does_not_prompt",
            gm_teleport: true,
            ..base
        },
        Case {
            id: "exploration_mode_does_not_prompt",
            in_combat: false,
            ..base
        },
    ];

    for c in cases {
        let hero = token(HERO_ID, "Kyra", c.from_x, 0.0, Some(PLAYER_ID));
        let mut goblin = token(GOBLIN_ID, "Goblin", 0.0, c.reactor_y, c.reactor_owner);
        goblin.reach_ft = c.reach_ft;
        goblin.has_reaction = c.reactor_has_reaction;
        goblin.hp = c.reactor_hp;
        let order = if c.in_combat {
            vec![HERO_ID, GOBLIN_ID]
        } else {
            vec![]
        };
        let mut state = table(vec![hero, goblin], order);
        let actor = if c.gm_teleport { gm() } else { player() };

        let events = state
            .apply_command(&actor, move_cmd(HERO_ID, c.to_x, c.gm_teleport))
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));

        assert_eq!(
            state.data.tokens[&HERO_ID].top_left.x, c.expect_stop_x,
            "case {} stop square",
            c.id
        );
        let prompts = opened_prompts(&events);
        assert_eq!(!prompts.is_empty(), c.expect_prompt, "case {} prompt", c.id);
        assert_eq!(
            state.data.active_reaction_prompts.len(),
            usize::from(c.expect_prompt),
            "case {} stored prompts",
            c.id
        );
        if let Some(prompt) = prompts.first() {
            assert_eq!(prompt.reactor_actor_id, GOBLIN_ID, "case {}", c.id);
            assert_eq!(prompt.trigger_token_id, HERO_ID, "case {}", c.id);
            assert_eq!(prompt.reactor_owner_user_id, None, "case {}", c.id);
            assert_eq!(
                prompt.pending_destination,
                Some(Point2D::new(c.to_x, 0.0)),
                "case {}",
                c.id
            );
        }
        if c.in_combat && !c.gm_teleport {
            let travelled_ft = (c.expect_stop_x - c.from_x).abs() / 100.0 * 5.0;
            assert!(
                (state.data.tokens[&HERO_ID].speed_remaining_ft - (30.0 - travelled_ft)).abs()
                    < 1e-6,
                "case {} charges only the travelled distance",
                c.id
            );
        }
        assert_eq!(state.undo_stack.len(), 1, "case {} one undo entry", c.id);
    }
}

#[test]
fn reaction_decisions_resume_or_interrupt_the_move() {
    struct Case {
        id: &'static str,
        second_goblin: bool,
        decider: CommandActor,
        decision: ReactionDecision,
        expect_hero_x: f64,
        expect_goblin_has_reaction: bool,
        expect_next_prompt_reactor: Option<Uuid>,
    }
    let trigger = ReactionDecision::Trigger {
        ability_id: Some("opportunity_attack".to_string()),
    };
    let cases = [
        Case {
            id: "gm_forced_pass_resumes_to_destination",
            second_goblin: false,
            decider: gm(),
            decision: ReactionDecision::Pass,
            expect_hero_x: 400.0,
            expect_goblin_has_reaction: true,
            expect_next_prompt_reactor: None,
        },
        Case {
            id: "trigger_spends_reaction_and_keeps_token_on_exit_square",
            second_goblin: false,
            decider: gm(),
            decision: trigger.clone(),
            expect_hero_x: 100.0,
            expect_goblin_has_reaction: false,
            expect_next_prompt_reactor: None,
        },
        Case {
            id: "pass_on_first_reactor_prompts_the_next_threatening_reactor",
            second_goblin: true,
            decider: gm(),
            decision: ReactionDecision::Pass,
            expect_hero_x: 100.0,
            expect_goblin_has_reaction: true,
            expect_next_prompt_reactor: Some(GOBLIN_B_ID),
        },
    ];

    for c in cases {
        let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
        let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
        let mut tokens = vec![hero, goblin];
        if c.second_goblin {
            tokens.push(token(GOBLIN_B_ID, "Goblin B", 0.0, 100.0, None));
        }
        let mut state = table(tokens, vec![HERO_ID, GOBLIN_ID]);
        let events = state
            .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
            .unwrap();
        let prompt = opened_prompts(&events).remove(0);
        assert_eq!(prompt.reactor_actor_id, GOBLIN_ID, "case {}", c.id);

        let events = state
            .apply_command(
                &c.decider,
                TrameCommand::DecideReaction {
                    prompt_id: prompt.prompt_id,
                    actor_id: GOBLIN_ID,
                    decision: c.decision.clone(),
                },
            )
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));

        assert_eq!(
            state.data.tokens[&HERO_ID].top_left.x, c.expect_hero_x,
            "case {} hero position",
            c.id
        );
        assert_eq!(
            state.data.tokens[&GOBLIN_ID].has_reaction, c.expect_goblin_has_reaction,
            "case {} reaction spent",
            c.id
        );
        let kept = state.data.active_reaction_prompts.get(&prompt.prompt_id);
        match c.decision {
            ReactionDecision::Pass => assert!(kept.is_none(), "case {} pass removes", c.id),
            ReactionDecision::Trigger { .. } => assert!(
                kept.is_some_and(|p| p.awaiting_resolution),
                "case {} trigger awaits resolution",
                c.id
            ),
        }
        let next = opened_prompts(&events).first().map(|p| p.reactor_actor_id);
        assert_eq!(next, c.expect_next_prompt_reactor, "case {}", c.id);
    }
}

#[test]
fn interrupted_token_cannot_move_until_the_reaction_is_resolved() {
    let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
    let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
    let mut state = table(vec![hero, goblin], vec![HERO_ID, GOBLIN_ID]);
    let events = state
        .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
        .unwrap();
    let prompt = opened_prompts(&events).remove(0);

    let err = state
        .apply_command(&player(), move_cmd(HERO_ID, 300.0, false))
        .unwrap_err();
    assert_eq!(err, CommandError::ReactionPending);

    state
        .apply_command(
            &gm(),
            TrameCommand::DecideReaction {
                prompt_id: prompt.prompt_id,
                actor_id: GOBLIN_ID,
                decision: ReactionDecision::Trigger { ability_id: None },
            },
        )
        .unwrap();
    let err = state
        .apply_command(&player(), move_cmd(HERO_ID, 300.0, false))
        .unwrap_err();
    assert_eq!(
        err,
        CommandError::ReactionPending,
        "triggered, not resolved"
    );

    state
        .apply_command(
            &gm(),
            TrameCommand::ResolveReaction {
                prompt_id: prompt.prompt_id,
            },
        )
        .unwrap();
    let events = state
        .apply_command(&player(), move_cmd(HERO_ID, 200.0, false))
        .unwrap();
    assert!(
        opened_prompts(&events).is_empty(),
        "spent reaction cannot prompt again"
    );
    assert_eq!(state.data.tokens[&HERO_ID].top_left.x, 200.0);
}

#[test]
fn resolving_a_triggered_reaction_resumes_the_move() {
    struct Case {
        id: &'static str,
        second_goblin: bool,
        resolver: CommandActor,
        mover_drops_to_zero: bool,
        expect_hero_x: f64,
        expect_next_prompt_reactor: Option<Uuid>,
    }
    let cases = [
        Case {
            id: "gm_resolves_and_move_reaches_destination",
            second_goblin: false,
            resolver: gm(),
            mover_drops_to_zero: false,
            expect_hero_x: 400.0,
            expect_next_prompt_reactor: None,
        },
        Case {
            id: "resolved_reactor_is_skipped_and_next_reactor_prompted",
            second_goblin: true,
            resolver: gm(),
            mover_drops_to_zero: false,
            expect_hero_x: 100.0,
            expect_next_prompt_reactor: Some(GOBLIN_B_ID),
        },
        Case {
            id: "mover_downed_by_the_reaction_does_not_resume",
            second_goblin: false,
            resolver: gm(),
            mover_drops_to_zero: true,
            expect_hero_x: 100.0,
            expect_next_prompt_reactor: None,
        },
    ];

    for c in cases {
        let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
        let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
        let mut tokens = vec![hero, goblin];
        if c.second_goblin {
            tokens.push(token(GOBLIN_B_ID, "Goblin B", 0.0, 100.0, None));
        }
        let mut state = table(tokens, vec![HERO_ID, GOBLIN_ID]);
        let events = state
            .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
            .unwrap();
        let prompt = opened_prompts(&events).remove(0);
        state
            .apply_command(
                &gm(),
                TrameCommand::DecideReaction {
                    prompt_id: prompt.prompt_id,
                    actor_id: GOBLIN_ID,
                    decision: ReactionDecision::Trigger { ability_id: None },
                },
            )
            .unwrap();
        if c.mover_drops_to_zero {
            state.apply_command(&gm(), damage(HERO_ID, 25)).unwrap();
        }
        let undo_before = state.undo_stack.len();

        let events = state
            .apply_command(
                &c.resolver,
                TrameCommand::ResolveReaction {
                    prompt_id: prompt.prompt_id,
                },
            )
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));

        assert_eq!(
            events.first(),
            Some(&TrameEvent::ReactionPromptClosed {
                prompt_id: prompt.prompt_id,
                reason: ReactionPromptCloseReason::Resolved,
            }),
            "case {}",
            c.id
        );
        assert_eq!(
            state.data.tokens[&HERO_ID].top_left.x, c.expect_hero_x,
            "case {} hero position",
            c.id
        );
        assert!(
            !state
                .data
                .active_reaction_prompts
                .contains_key(&prompt.prompt_id),
            "case {} resolved prompt removed",
            c.id
        );
        let next = opened_prompts(&events).first().map(|p| p.reactor_actor_id);
        assert_eq!(next, c.expect_next_prompt_reactor, "case {}", c.id);
        assert_eq!(state.undo_stack.len(), undo_before + 1, "case {}", c.id);
    }
}

#[test]
fn hero_owner_resolves_their_reaction_and_the_monster_resumes() {
    let hero = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
    let goblin = token(GOBLIN_ID, "Goblin", 100.0, 0.0, None);
    let mut state = table(vec![hero, goblin], vec![GOBLIN_ID, HERO_ID]);
    let events = state
        .apply_command(&gm(), move_cmd(GOBLIN_ID, 400.0, false))
        .unwrap();
    let prompt = opened_prompts(&events).remove(0);
    state
        .apply_command(
            &player(),
            TrameCommand::DecideReaction {
                prompt_id: prompt.prompt_id,
                actor_id: HERO_ID,
                decision: ReactionDecision::Trigger { ability_id: None },
            },
        )
        .unwrap();
    state
        .apply_command(
            &player(),
            TrameCommand::ResolveReaction {
                prompt_id: prompt.prompt_id,
            },
        )
        .unwrap();
    assert_eq!(state.data.tokens[&GOBLIN_ID].top_left.x, 400.0);
}

#[test]
fn resolve_reaction_rejections_leave_state_and_undo_untouched() {
    // (case id, actor, trigger first, send DecideReaction instead of ResolveReaction, error)
    let cases: Vec<(&str, CommandActor, bool, bool, CommandError)> = vec![
        (
            "undecided_prompt_cannot_be_resolved",
            gm(),
            false,
            false,
            CommandError::InvalidConfiguration(
                "reaction has not been triggered; decide it first".into(),
            ),
        ),
        (
            "player_cannot_resolve_gm_monster_reaction",
            player(),
            true,
            false,
            CommandError::PermissionDenied("you do not control this token".into()),
        ),
        (
            "spectator_cannot_resolve",
            spectator(),
            true,
            false,
            CommandError::PermissionDenied("spectators cannot resolve reactions".into()),
        ),
        (
            "triggered_prompt_cannot_be_decided_again",
            gm(),
            true,
            true,
            CommandError::InvalidConfiguration(
                "reaction already triggered; resolve it with ResolveReaction".into(),
            ),
        ),
    ];

    for (case_id, actor, trigger_first, decide_again, expected) in cases {
        let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
        let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
        let mut state = table(vec![hero, goblin], vec![HERO_ID, GOBLIN_ID]);
        let events = state
            .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
            .unwrap();
        let prompt_id = opened_prompts(&events).remove(0).prompt_id;
        let decide = TrameCommand::DecideReaction {
            prompt_id,
            actor_id: GOBLIN_ID,
            decision: ReactionDecision::Trigger { ability_id: None },
        };
        if trigger_first {
            state.apply_command(&gm(), decide.clone()).unwrap();
        }
        let data_before = state.data.clone();
        let undo_before = state.undo_stack.len();

        let cmd = if decide_again {
            decide
        } else {
            TrameCommand::ResolveReaction { prompt_id }
        };
        let err = state.apply_command(&actor, cmd).unwrap_err();

        assert_eq!(err, expected, "case {case_id}");
        assert_eq!(state.data, data_before, "case {case_id} state untouched");
        assert_eq!(state.undo_stack.len(), undo_before, "case {case_id}");
    }
}

#[test]
fn stale_reaction_prompts_are_closed() {
    struct Case {
        id: &'static str,
        trigger_first: bool,
        cmd: TrameCommand,
        expect_closed: bool,
    }
    let exploration = TrameCommand::SetTableMode {
        mode: TableMode::Exploration,
        exploration_paused: false,
        initiative_order: vec![],
        initiative_totals: BTreeMap::new(),
    };
    let cases = [
        Case {
            id: "end_turn_by_turn_closes_prompts",
            trigger_first: false,
            cmd: TrameCommand::EndTurnByTurn,
            expect_closed: true,
        },
        Case {
            id: "set_table_mode_to_exploration_closes_prompts",
            trigger_first: false,
            cmd: exploration,
            expect_closed: true,
        },
        Case {
            id: "set_table_mode_staying_turn_by_turn_keeps_prompts",
            trigger_first: false,
            cmd: TrameCommand::SetTableMode {
                mode: TableMode::TurnByTurn,
                exploration_paused: false,
                initiative_order: vec![HERO_ID, GOBLIN_ID],
                initiative_totals: BTreeMap::new(),
            },
            expect_closed: false,
        },
        Case {
            id: "removing_the_trigger_token_closes_prompts",
            trigger_first: false,
            cmd: TrameCommand::RemoveToken { token_id: HERO_ID },
            expect_closed: true,
        },
        Case {
            id: "removing_the_reactor_token_closes_prompts",
            trigger_first: false,
            cmd: TrameCommand::RemoveToken {
                token_id: GOBLIN_ID,
            },
            expect_closed: true,
        },
        Case {
            id: "gm_moving_the_trigger_token_closes_prompts",
            trigger_first: false,
            cmd: move_cmd(HERO_ID, 300.0, true),
            expect_closed: true,
        },
        Case {
            id: "gm_moving_the_trigger_token_closes_triggered_prompts",
            trigger_first: true,
            cmd: move_cmd(HERO_ID, 300.0, true),
            expect_closed: true,
        },
    ];

    for c in cases {
        let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
        let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
        let mut state = table(vec![hero, goblin], vec![HERO_ID, GOBLIN_ID]);
        let events = state
            .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
            .unwrap();
        let prompt_id = opened_prompts(&events).remove(0).prompt_id;
        if c.trigger_first {
            state
                .apply_command(
                    &gm(),
                    TrameCommand::DecideReaction {
                        prompt_id,
                        actor_id: GOBLIN_ID,
                        decision: ReactionDecision::Trigger { ability_id: None },
                    },
                )
                .unwrap();
        }

        let events = state
            .apply_command(&gm(), c.cmd)
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));

        let closed = events.contains(&TrameEvent::ReactionPromptClosed {
            prompt_id,
            reason: ReactionPromptCloseReason::Stale,
        });
        assert_eq!(closed, c.expect_closed, "case {} close event", c.id);
        assert_eq!(
            state.data.active_reaction_prompts.is_empty(),
            c.expect_closed,
            "case {} stored prompts",
            c.id
        );
    }
}

#[test]
fn monster_leaving_hero_reach_prompts_the_hero_owner() {
    let hero = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
    let goblin = token(GOBLIN_ID, "Goblin", 100.0, 0.0, None);
    let mut state = table(vec![hero, goblin], vec![GOBLIN_ID, HERO_ID]);
    let events = state
        .apply_command(&gm(), move_cmd(GOBLIN_ID, 400.0, false))
        .unwrap();
    let prompt = opened_prompts(&events).remove(0);
    assert_eq!(prompt.reactor_actor_id, HERO_ID);
    assert_eq!(prompt.reactor_owner_user_id, Some(PLAYER_ID));

    state
        .apply_command(
            &player(),
            TrameCommand::DecideReaction {
                prompt_id: prompt.prompt_id,
                actor_id: HERO_ID,
                decision: ReactionDecision::Pass,
            },
        )
        .unwrap();
    assert_eq!(state.data.tokens[&GOBLIN_ID].top_left.x, 400.0);
}

#[test]
fn decide_reaction_rejections_leave_state_and_undo_untouched() {
    let unknown_prompt = Uuid::from_u128(0xDEAD);
    let cases: Vec<(&str, CommandActor, Option<Uuid>, Uuid, bool, CommandError)> = vec![
        (
            "unknown_prompt_is_not_found",
            gm(),
            Some(unknown_prompt),
            GOBLIN_ID,
            false,
            CommandError::NotFound(format!("reaction prompt {unknown_prompt}")),
        ),
        (
            "actor_id_must_match_prompt_reactor",
            gm(),
            None,
            HERO_ID,
            false,
            CommandError::PermissionDenied("reaction prompt belongs to another actor".into()),
        ),
        (
            "player_cannot_decide_for_gm_monster",
            player(),
            None,
            GOBLIN_ID,
            false,
            CommandError::PermissionDenied("you do not control this token".into()),
        ),
        (
            "spectator_cannot_decide",
            spectator(),
            None,
            GOBLIN_ID,
            false,
            CommandError::PermissionDenied("spectators cannot decide reactions".into()),
        ),
        (
            "trigger_without_reaction_is_rejected",
            gm(),
            None,
            GOBLIN_ID,
            true,
            CommandError::ReactionUnavailable,
        ),
    ];

    for (case_id, actor, prompt_override, actor_id, spend_reaction_first, expected) in cases {
        let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
        let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
        let mut state = table(vec![hero, goblin], vec![HERO_ID, GOBLIN_ID]);
        let events = state
            .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
            .unwrap();
        let prompt = opened_prompts(&events).remove(0);
        if spend_reaction_first {
            state.data.tokens.get_mut(&GOBLIN_ID).unwrap().has_reaction = false;
        }
        let data_before = state.data.clone();
        let undo_before = state.undo_stack.len();

        let err = state
            .apply_command(
                &actor,
                TrameCommand::DecideReaction {
                    prompt_id: prompt_override.unwrap_or(prompt.prompt_id),
                    actor_id,
                    decision: ReactionDecision::Trigger { ability_id: None },
                },
            )
            .unwrap_err();

        assert_eq!(err, expected, "case {case_id}");
        assert_eq!(state.data, data_before, "case {case_id} state untouched");
        assert_eq!(
            state.undo_stack.len(),
            undo_before,
            "case {case_id} no undo pushed"
        );
    }
}

fn goblin_spawn(id: u128, x: f64) -> TrameCommand {
    TrameCommand::SpawnToken {
        token: Box::new(token(Uuid::from_u128(id), "Goblin", x, 300.0, None)),
    }
}

fn damage(token_id: Uuid, raw: i32) -> TrameCommand {
    TrameCommand::ApplyDamage {
        token_id,
        raw_damage: raw,
        affinity: trame_engine::DamageAffinity::Normal,
        is_critical: false,
        damage_type: None,
    }
}

#[test]
fn commit_mcp_staging_is_atomic_with_one_composite_undo() {
    let missing = Uuid::from_u128(0xBAD);
    let five_commands = vec![
        goblin_spawn(0x31, 0.0),
        goblin_spawn(0x32, 100.0),
        goblin_spawn(0x33, 200.0),
        damage(Uuid::from_u128(0x31), 3),
        TrameCommand::SetAmbientLighting {
            preset: trame_engine::AmbientLightingPreset::Dusk,
        },
    ];
    let cases: Vec<(
        &str,
        CommandActor,
        Vec<TrameCommand>,
        bool,
        Option<CommandError>,
    )> = vec![
        (
            "five_commands_commit_together",
            gm(),
            five_commands,
            true,
            None,
        ),
        (
            "failing_sub_command_rolls_back_the_whole_batch",
            gm(),
            vec![goblin_spawn(0x31, 0.0), damage(missing, 3)],
            true,
            Some(CommandError::BatchCommandFailed {
                index: 1,
                source: Box::new(CommandError::NotFound(format!("token {missing}"))),
            }),
        ),
        (
            "nested_undo_is_rejected_before_any_change",
            gm(),
            vec![goblin_spawn(0x31, 0.0), TrameCommand::UndoLastAction],
            true,
            Some(CommandError::BatchCommandFailed {
                index: 1,
                source: Box::new(CommandError::InvalidConfiguration(
                    "undo and staging commands cannot be nested in a batch".into(),
                )),
            }),
        ),
        (
            "unknown_proposal_is_not_found",
            gm(),
            vec![goblin_spawn(0x31, 0.0)],
            false,
            Some(CommandError::NotFound(format!(
                "MCP staging proposal {}",
                Uuid::from_u128(0x99)
            ))),
        ),
        (
            "player_cannot_commit",
            player(),
            vec![goblin_spawn(0x31, 0.0)],
            true,
            Some(CommandError::PermissionDenied(
                "GM role required for this command".into(),
            )),
        ),
    ];

    for (case_id, actor, commands, stage_it, expected_err) in cases {
        let mut state = table(
            vec![token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID))],
            vec![],
        );
        state
            .apply_command(&gm(), move_cmd(HERO_ID, 100.0, true))
            .unwrap();
        let proposal_id = Uuid::from_u128(0x99);
        if stage_it {
            state.data.mcp_staging_proposals.insert(
                proposal_id,
                McpStagingProposal {
                    proposal_id,
                    summary: "Ambush".into(),
                    commands,
                },
            );
        }
        let data_before = state.data.clone();
        let undo_before = state.undo_stack.clone();

        let result = state.apply_command(&actor, TrameCommand::CommitMcpStaging { proposal_id });

        match expected_err {
            Some(expected) => {
                assert_eq!(result.unwrap_err(), expected, "case {case_id}");
                assert_eq!(state.data, data_before, "case {case_id} rolled back");
                assert_eq!(state.undo_stack, undo_before, "case {case_id} undo intact");
            }
            None => {
                let events = result.unwrap();
                assert!(
                    matches!(events.last(), Some(TrameEvent::McpStagingCommitted { .. })),
                    "case {case_id} committed event"
                );
                assert_eq!(state.data.tokens.len(), 4, "case {case_id} spawned");
                assert_eq!(
                    state.undo_stack.len(),
                    undo_before.len() + 1,
                    "case {case_id} exactly one composite undo"
                );
                state
                    .apply_command(&gm(), TrameCommand::UndoLastAction)
                    .unwrap();
                assert_eq!(
                    state.data, data_before,
                    "case {case_id} one undo reverts all"
                );
                assert_eq!(state.undo_stack, undo_before, "case {case_id} undo stack");
            }
        }
    }
}

#[test]
fn apply_batch_is_all_or_nothing() {
    let missing = Uuid::from_u128(0xBAD);
    let cases: Vec<(&str, Vec<TrameCommand>, Option<CommandError>)> = vec![
        (
            "successful_batch_pushes_one_undo",
            vec![goblin_spawn(0x31, 0.0), damage(Uuid::from_u128(0x31), 2)],
            None,
        ),
        (
            "failing_batch_restores_state_and_undo",
            vec![
                goblin_spawn(0x31, 0.0),
                goblin_spawn(0x32, 100.0),
                damage(missing, 2),
            ],
            Some(CommandError::BatchCommandFailed {
                index: 2,
                source: Box::new(CommandError::NotFound(format!("token {missing}"))),
            }),
        ),
        (
            "empty_batch_is_rejected",
            vec![],
            Some(CommandError::InvalidConfiguration(
                "batch must contain at least one command".into(),
            )),
        ),
    ];

    for (case_id, commands, expected_err) in cases {
        let mut state = table(vec![], vec![]);
        state.apply_command(&gm(), goblin_spawn(0x30, 0.0)).unwrap();
        let data_before = state.data.clone();
        let undo_before = state.undo_stack.clone();

        let result = state.apply_batch(&gm(), commands, "MCP batch");

        match expected_err {
            Some(expected) => {
                assert_eq!(result.unwrap_err(), expected, "case {case_id}");
                assert_eq!(state.data, data_before, "case {case_id} rolled back");
                assert_eq!(state.undo_stack, undo_before, "case {case_id} undo intact");
            }
            None => {
                result.unwrap();
                assert_eq!(
                    state.undo_stack.len(),
                    undo_before.len() + 1,
                    "case {case_id}"
                );
                assert_eq!(
                    state.undo_stack.back().unwrap().description,
                    "MCP batch",
                    "case {case_id}"
                );
                state
                    .apply_command(&gm(), TrameCommand::UndoLastAction)
                    .unwrap();
                assert_eq!(
                    state.data, data_before,
                    "case {case_id} one undo reverts all"
                );
            }
        }
    }
}

#[test]
fn heal_actor_restores_hp_with_permissions_and_death_rules() {
    struct Case {
        id: &'static str,
        actor: CommandActor,
        target_owner: Option<Uuid>,
        hp: i32,
        failures: u8,
        is_dead: bool,
        amount: i32,
        expect: Result<(i32, i32), CommandError>,
    }
    let cases = [
        Case {
            id: "gm_heals_any_token",
            actor: gm(),
            target_owner: None,
            hp: 5,
            failures: 0,
            is_dead: false,
            amount: 4,
            expect: Ok((9, 4)),
        },
        Case {
            id: "player_heals_own_token",
            actor: player(),
            target_owner: Some(PLAYER_ID),
            hp: 5,
            failures: 0,
            is_dead: false,
            amount: 4,
            expect: Ok((9, 4)),
        },
        Case {
            id: "healing_caps_at_max_hp",
            actor: gm(),
            target_owner: None,
            hp: 18,
            failures: 0,
            is_dead: false,
            amount: 10,
            expect: Ok((20, 2)),
        },
        Case {
            id: "healing_at_zero_resets_death_saves",
            actor: gm(),
            target_owner: Some(PLAYER_ID),
            hp: 0,
            failures: 2,
            is_dead: false,
            amount: 1,
            expect: Ok((1, 1)),
        },
        Case {
            id: "player_cannot_heal_others",
            actor: player(),
            target_owner: Some(OTHER_PLAYER_ID),
            hp: 5,
            failures: 0,
            is_dead: false,
            amount: 4,
            expect: Err(CommandError::PermissionDenied(
                "you do not control this token".into(),
            )),
        },
        Case {
            id: "dead_tokens_cannot_be_healed",
            actor: gm(),
            target_owner: None,
            hp: 0,
            failures: 3,
            is_dead: true,
            amount: 4,
            expect: Err(CommandError::InvalidConfiguration(
                "dead creatures cannot be healed".into(),
            )),
        },
        Case {
            id: "negative_amount_is_rejected",
            actor: gm(),
            target_owner: None,
            hp: 5,
            failures: 0,
            is_dead: false,
            amount: -3,
            expect: Err(CommandError::InvalidConfiguration(
                "healing amount must be >= 0".into(),
            )),
        },
    ];

    for c in cases {
        let mut target = token(HERO_ID, "Kyra", 0.0, 0.0, c.target_owner);
        target.hp = c.hp;
        target.death_save_failures = c.failures;
        target.is_dead = c.is_dead;
        let mut state = table(vec![target], vec![]);

        let result = state.apply_command(
            &c.actor,
            TrameCommand::HealActor {
                token_id: HERO_ID,
                amount: c.amount,
            },
        );

        match c.expect {
            Ok((new_hp, restored)) => {
                let events = result.unwrap_or_else(|e| panic!("case {}: {e}", c.id));
                assert_eq!(
                    events,
                    vec![TrameEvent::TokenHealed {
                        token_id: HERO_ID,
                        hp_restored: restored,
                        new_hp,
                    }],
                    "case {}",
                    c.id
                );
                assert_eq!(state.data.tokens[&HERO_ID].hp, new_hp, "case {}", c.id);
                assert_eq!(
                    state.data.tokens[&HERO_ID].death_save_failures, 0,
                    "case {} death saves reset",
                    c.id
                );
                assert_eq!(state.undo_stack.len(), 1, "case {}", c.id);
            }
            Err(expected) => {
                assert_eq!(result.unwrap_err(), expected, "case {}", c.id);
                assert!(state.undo_stack.is_empty(), "case {} no undo", c.id);
            }
        }
    }
}

#[test]
fn apply_damage_tracks_death_saves_and_enforces_ownership() {
    struct Case {
        id: &'static str,
        actor: CommandActor,
        target_owner: Option<Uuid>,
        hp: i32,
        failures: u8,
        raw: i32,
        critical: bool,
        expect: Result<(i32, u8, bool), CommandError>,
    }
    let cases = [
        Case {
            id: "hit_at_zero_adds_one_failure",
            actor: gm(),
            target_owner: Some(PLAYER_ID),
            hp: 0,
            failures: 0,
            raw: 3,
            critical: false,
            expect: Ok((0, 1, false)),
        },
        Case {
            id: "critical_at_zero_adds_two_failures",
            actor: gm(),
            target_owner: Some(PLAYER_ID),
            hp: 0,
            failures: 0,
            raw: 3,
            critical: true,
            expect: Ok((0, 2, false)),
        },
        Case {
            id: "third_failure_marks_dead",
            actor: gm(),
            target_owner: Some(PLAYER_ID),
            hp: 0,
            failures: 2,
            raw: 3,
            critical: false,
            expect: Ok((0, 3, true)),
        },
        Case {
            id: "massive_damage_marks_dead",
            actor: gm(),
            target_owner: None,
            hp: 5,
            failures: 0,
            raw: 30,
            critical: false,
            expect: Ok((0, 0, true)),
        },
        Case {
            id: "massive_damage_overflow_equal_to_max_hp_from_full_hp_kills",
            actor: gm(),
            target_owner: Some(PLAYER_ID),
            hp: 20,
            failures: 0,
            raw: 40,
            critical: false,
            expect: Ok((0, 0, true)),
        },
        Case {
            id: "massive_damage_overflow_one_below_max_hp_only_downs",
            actor: gm(),
            target_owner: Some(PLAYER_ID),
            hp: 20,
            failures: 0,
            raw: 39,
            critical: false,
            expect: Ok((0, 0, false)),
        },
        Case {
            id: "player_damages_own_token",
            actor: player(),
            target_owner: Some(PLAYER_ID),
            hp: 10,
            failures: 0,
            raw: 3,
            critical: false,
            expect: Ok((7, 0, false)),
        },
        Case {
            id: "player_cannot_damage_tokens_they_do_not_own",
            actor: player(),
            target_owner: None,
            hp: 10,
            failures: 0,
            raw: 3,
            critical: false,
            expect: Err(CommandError::PermissionDenied(
                "you do not control this token".into(),
            )),
        },
    ];

    for c in cases {
        let mut target = token(HERO_ID, "Kyra", 0.0, 0.0, c.target_owner);
        target.hp = c.hp;
        target.death_save_failures = c.failures;
        let mut state = table(vec![target], vec![]);

        let result = state.apply_command(
            &c.actor,
            TrameCommand::ApplyDamage {
                token_id: HERO_ID,
                raw_damage: c.raw,
                affinity: trame_engine::DamageAffinity::Normal,
                is_critical: c.critical,
                damage_type: None,
            },
        );

        match c.expect {
            Ok((hp, failures, dead)) => {
                result.unwrap_or_else(|e| panic!("case {}: {e}", c.id));
                let t = &state.data.tokens[&HERO_ID];
                assert_eq!(t.hp, hp, "case {} hp", c.id);
                assert_eq!(t.death_save_failures, failures, "case {} failures", c.id);
                assert_eq!(t.is_dead, dead, "case {} dead", c.id);
                assert_eq!(state.undo_stack.len(), 1, "case {} one undo entry", c.id);
            }
            Err(expected) => {
                assert_eq!(result.unwrap_err(), expected, "case {}", c.id);
                assert!(state.undo_stack.is_empty(), "case {} no undo", c.id);
            }
        }
    }
}

#[test]
fn zero_hp_adds_unconscious_and_regaining_hp_removes_it() {
    use trame_engine::{OverrideMode, OverrideSubject};
    struct Case {
        id: &'static str,
        target_owner: Option<Uuid>,
        hp: i32,
        conditions: Vec<&'static str>,
        remove_ruling: bool,
        command: TrameCommand,
        expect_conditions: Vec<&'static str>,
        expect_effective: Vec<&'static str>,
    }
    let base = || Case {
        id: "",
        target_owner: Some(PLAYER_ID),
        hp: 5,
        conditions: vec!["prone"],
        remove_ruling: false,
        command: damage(HERO_ID, 5),
        expect_conditions: vec!["prone", "unconscious"],
        expect_effective: vec!["prone", "unconscious"],
    };
    let cases = [
        Case {
            id: "hero_dropped_to_zero_falls_unconscious",
            ..base()
        },
        Case {
            id: "hit_at_zero_keeps_a_single_unconscious",
            hp: 0,
            conditions: vec!["unconscious"],
            command: damage(HERO_ID, 1),
            expect_conditions: vec!["unconscious"],
            expect_effective: vec!["unconscious"],
            ..base()
        },
        Case {
            id: "gm_ruling_removing_unconscious_wins",
            remove_ruling: true,
            expect_effective: vec!["prone"],
            ..base()
        },
        Case {
            id: "synthetic_monster_dies_instead",
            target_owner: None,
            expect_conditions: vec!["prone"],
            expect_effective: vec!["prone"],
            ..base()
        },
        Case {
            id: "massive_damage_kills_without_unconscious",
            command: damage(HERO_ID, 40),
            expect_conditions: vec!["prone"],
            expect_effective: vec!["prone"],
            ..base()
        },
        Case {
            id: "healing_from_zero_wakes_the_hero",
            hp: 0,
            conditions: vec!["unconscious", "prone"],
            command: TrameCommand::HealActor {
                token_id: HERO_ID,
                amount: 3,
            },
            expect_conditions: vec!["prone"],
            expect_effective: vec!["prone"],
            ..base()
        },
        Case {
            id: "healing_above_zero_keeps_other_unconsciousness",
            hp: 4,
            conditions: vec!["unconscious"],
            command: TrameCommand::HealActor {
                token_id: HERO_ID,
                amount: 3,
            },
            expect_conditions: vec!["unconscious"],
            expect_effective: vec!["unconscious"],
            ..base()
        },
        Case {
            id: "natural_20_death_save_wakes_the_hero",
            hp: 0,
            conditions: vec!["unconscious"],
            command: TrameCommand::RecordDeathSave {
                token_id: HERO_ID,
                d20: Some(20),
            },
            expect_conditions: vec![],
            expect_effective: vec![],
            ..base()
        },
        Case {
            id: "gm_resource_override_to_zero_knocks_out",
            command: TrameCommand::GmOverrideTokenResources {
                token_id: HERO_ID,
                hp: Some(0),
                temp_hp: None,
                speed_remaining_ft: None,
                has_action: None,
                has_bonus_action: None,
                has_reaction: None,
            },
            ..base()
        },
    ];
    for c in cases {
        let mut hero = token(HERO_ID, "Kyra", 0.0, 0.0, c.target_owner);
        hero.max_hp = 20;
        hero.hp = c.hp;
        hero.conditions = c.conditions.iter().map(|s| s.to_string()).collect();
        if c.remove_ruling {
            hero.condition_overrides
                .push(trame_engine::ConditionOverrideEntry {
                    subject: OverrideSubject::Condition,
                    id: "unconscious".to_string(),
                    mode: OverrideMode::Remove,
                });
        }
        let mut state = table(vec![hero.clone()], vec![]);
        let events = state
            .apply_command(&gm(), c.command)
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));
        let tok = &state.data.tokens[&HERO_ID];
        let strings = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(tok.conditions, strings(&c.expect_conditions), "case {}", c.id);
        assert_eq!(
            tok.effective_conditions(),
            strings(&c.expect_effective),
            "case {} effective",
            c.id
        );
        let changed = tok.conditions != hero.conditions;
        assert_eq!(
            events
                .iter()
                .any(|e| matches!(e, TrameEvent::TokenConditionsChanged { .. })),
            changed,
            "case {} conditions event",
            c.id
        );
        assert_eq!(state.undo_stack.len(), 1, "case {} one undo entry", c.id);
        state
            .apply_command(&gm(), TrameCommand::UndoLastAction)
            .unwrap();
        assert_eq!(
            state.data.tokens[&HERO_ID].conditions, hero.conditions,
            "case {} undone",
            c.id
        );
    }
}

#[test]
fn typed_damage_derives_affinity_from_the_target_token() {
    struct Case {
        id: &'static str,
        resist: &'static [&'static str],
        immune: &'static [&'static str],
        vulnerable: &'static [&'static str],
        conditions: &'static [&'static str],
        damage_type: Option<&'static str>,
        claimed: trame_engine::DamageAffinity,
        expected_hp: i32,
    }
    let to_vec = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let cases = [
        Case {
            id: "untyped_damage_uses_the_claimed_affinity",
            resist: &["fire"],
            immune: &[],
            vulnerable: &[],
            conditions: &[],
            damage_type: None,
            claimed: trame_engine::DamageAffinity::Normal,
            expected_hp: 10,
        },
        Case {
            id: "resistant_target_halves_typed_damage",
            resist: &["fire"],
            immune: &[],
            vulnerable: &[],
            conditions: &[],
            damage_type: Some("Fire"),
            claimed: trame_engine::DamageAffinity::Normal,
            expected_hp: 15,
        },
        Case {
            id: "immunity_beats_a_claimed_vulnerability",
            resist: &[],
            immune: &["poison"],
            vulnerable: &[],
            conditions: &[],
            damage_type: Some("poison"),
            claimed: trame_engine::DamageAffinity::Vulnerable,
            expected_hp: 20,
        },
        Case {
            id: "claimed_immunity_is_ignored_for_typed_damage",
            resist: &[],
            immune: &[],
            vulnerable: &[],
            conditions: &[],
            damage_type: Some("cold"),
            claimed: trame_engine::DamageAffinity::Immune,
            expected_hp: 10,
        },
        Case {
            id: "resistance_then_vulnerability_on_even_damage",
            resist: &["fire"],
            immune: &[],
            vulnerable: &["fire"],
            conditions: &[],
            damage_type: Some("fire"),
            claimed: trame_engine::DamageAffinity::Normal,
            expected_hp: 10,
        },
        Case {
            id: "vulnerable_target_takes_double_typed_damage",
            resist: &[],
            immune: &[],
            vulnerable: &["radiant"],
            conditions: &[],
            damage_type: Some("radiant"),
            claimed: trame_engine::DamageAffinity::Resistant,
            expected_hp: 0,
        },
        Case {
            id: "petrified_target_resists_every_damage_type",
            resist: &[],
            immune: &[],
            vulnerable: &[],
            conditions: &["petrified"],
            damage_type: Some("force"),
            claimed: trame_engine::DamageAffinity::Normal,
            expected_hp: 15,
        },
        Case {
            id: "petrified_resistance_then_vulnerability_on_even_damage",
            resist: &[],
            immune: &[],
            vulnerable: &["bludgeoning"],
            conditions: &["petrified"],
            damage_type: Some("bludgeoning"),
            claimed: trame_engine::DamageAffinity::Normal,
            expected_hp: 10,
        },
    ];

    for c in cases {
        let mut target = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
        target.damage_resistances = to_vec(c.resist);
        target.damage_immunities = to_vec(c.immune);
        target.damage_vulnerabilities = to_vec(c.vulnerable);
        target.conditions = to_vec(c.conditions);
        let mut state = table(vec![target], vec![]);
        state
            .apply_command(
                &gm(),
                TrameCommand::ApplyDamage {
                    token_id: HERO_ID,
                    raw_damage: 10,
                    affinity: c.claimed,
                    is_critical: false,
                    damage_type: c.damage_type.map(str::to_string),
                },
            )
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));
        assert_eq!(
            state.data.tokens[&HERO_ID].hp, c.expected_hp,
            "case {}",
            c.id
        );
    }
}

#[test]
fn resistance_applies_before_vulnerability_to_the_same_type() {
    // (case_id, resistances, vulnerabilities, conditions, raw damage, hp lost)
    let cases: [(&str, &[&str], &[&str], &[&str], i32, i32); 6] = [
        ("resistance_then_vulnerability_25_to_24", &["fire"], &["fire"], &[], 25, 24),
        ("resistance_then_vulnerability_1_to_0", &["fire"], &["fire"], &[], 1, 0),
        ("petrified_then_vulnerability_25_to_24", &[], &["fire"], &["petrified"], 25, 24),
        ("resistance_alone_25_to_12", &["fire"], &[], &[], 25, 12),
        ("vulnerability_alone_25_to_50", &[], &["fire"], &[], 25, 50),
        ("other_type_unmitigated", &["cold"], &["cold"], &[], 25, 25),
    ];
    let to_vec = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    for (case, resist, vulnerable, conditions, raw, lost) in cases {
        let mut target = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
        target.max_hp = 100;
        target.hp = 100;
        target.damage_resistances = to_vec(resist);
        target.damage_vulnerabilities = to_vec(vulnerable);
        target.conditions = to_vec(conditions);
        let mut state = table(vec![target], vec![]);
        state
            .apply_command(
                &gm(),
                TrameCommand::ApplyDamage {
                    token_id: HERO_ID,
                    raw_damage: raw,
                    affinity: trame_engine::DamageAffinity::Normal,
                    is_critical: false,
                    damage_type: Some("fire".to_string()),
                },
            )
            .unwrap_or_else(|e| panic!("case {case}: {e}"));
        assert_eq!(state.data.tokens[&HERO_ID].hp, 100 - lost, "case {case}");
    }
}

fn scene_payload(staged: Vec<TokenState>) -> SceneActivation {
    SceneActivation {
        map_asset_id: Some("sha256:crypt".into()),
        width_px: 3000,
        height_px: 2000,
        pixels_per_grid: 140.0,
        walls: vec![WallSegment::normal_wall(
            Uuid::from_u128(0x77),
            Point2D::new(0.0, 0.0),
            Point2D::new(0.0, 500.0),
        )],
        lights: vec![],
        staged_tokens: staged,
        hero_spawn_points: vec![Point2D::new(1400.0, 700.0)],
    }
}

#[test]
fn activate_scene_keeps_heroes_spawns_staged_tokens_and_undoes_cleanly() {
    let staged_id = Uuid::from_u128(0x55);
    let cases: Vec<(
        &str,
        CommandActor,
        Option<SceneActivation>,
        Option<CommandError>,
    )> = vec![
        (
            "gm_activates_resolved_scene",
            gm(),
            Some(scene_payload(vec![token(
                staged_id, "Ghoul", 700.0, 700.0, None,
            )])),
            None,
        ),
        (
            "unresolved_scene_payload_is_rejected",
            gm(),
            None,
            Some(CommandError::InvalidConfiguration(
                "ActivateScene requires the server-resolved scene payload".into(),
            )),
        ),
        (
            "player_cannot_activate_scenes",
            player(),
            Some(scene_payload(vec![])),
            Some(CommandError::PermissionDenied(
                "GM role required for this command".into(),
            )),
        ),
        (
            "staged_token_colliding_with_hero_is_rejected",
            gm(),
            Some(scene_payload(vec![token(
                HERO_ID, "Imposter", 0.0, 0.0, None,
            )])),
            Some(CommandError::InvalidConfiguration(format!(
                "staged token {HERO_ID} collides with a hero token"
            ))),
        ),
        (
            "non_positive_grid_is_rejected",
            gm(),
            Some(SceneActivation {
                pixels_per_grid: 0.0,
                ..scene_payload(vec![])
            }),
            Some(CommandError::InvalidConfiguration(
                "Scene dimensions and pixels_per_grid must be positive".into(),
            )),
        ),
    ];

    for (case_id, actor, scene, expected_err) in cases {
        let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
        let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
        let mut state = table(vec![hero, goblin], vec![HERO_ID, GOBLIN_ID]);
        let data_before = state.data.clone();

        let result = state.apply_command(
            &actor,
            TrameCommand::ActivateScene {
                scene_id: Uuid::from_u128(0x5C),
                scene,
            },
        );

        if let Some(expected) = expected_err {
            assert_eq!(result.unwrap_err(), expected, "case {case_id}");
            assert_eq!(state.data, data_before, "case {case_id} untouched");
            continue;
        }
        let events = result.unwrap();
        assert!(
            matches!(
                &events[..],
                [TrameEvent::SceneActivated { hero_token_ids, spawned_token_ids, .. }]
                    if hero_token_ids == &vec![HERO_ID] && spawned_token_ids == &vec![staged_id]
            ),
            "case {case_id} event: {events:?}"
        );
        let ids: Vec<Uuid> = state.data.tokens.keys().copied().collect();
        assert_eq!(ids, vec![HERO_ID, staged_id], "case {case_id} roster");
        assert_eq!(
            state.data.tokens[&HERO_ID].top_left,
            Point2D::new(1400.0, 700.0),
            "case {case_id} hero on spawn point"
        );
        assert_eq!(state.data.mode, TableMode::Exploration, "case {case_id}");
        assert!(state.data.initiative_order.is_empty(), "case {case_id}");
        assert_eq!(state.data.walls.len(), 1, "case {case_id} walls replaced");
        assert_eq!(state.cell_size_px, 140.0, "case {case_id} grid");

        state
            .apply_command(&gm(), TrameCommand::UndoLastAction)
            .unwrap();
        assert_eq!(
            state.data, data_before,
            "case {case_id} undo restores scene"
        );
        assert_eq!(
            state.cell_size_px, 100.0,
            "case {case_id} undo restores grid"
        );
    }
}

fn concentration_aoe(aoe_id: Uuid, caster: Uuid) -> TrameCommand {
    TrameCommand::ProjectAoe {
        template: AoeTemplate {
            id: aoe_id,
            origin: Point2D::new(500.0, 500.0),
            origin_elevation_ft: 0.0,
            shape: AoeShape::Sphere { radius_ft: 10.0 },
            stops_at_walls: true,
            discretization: GridDiscretizationMode::CenterPoint,
            concentration_caster_id: Some(caster),
        },
        persist_zone: true,
    }
}

#[test]
fn clear_aoe_removes_zone_and_ends_bound_concentration() {
    let aoe_id = Uuid::from_u128(0xA0E);
    let other = CommandActor {
        user_id: OTHER_PLAYER_ID,
        role: CampaignRole::Player,
    };
    let cases: Vec<(&str, CommandActor, Uuid, Option<CommandError>)> = vec![
        ("gm_clears_any_zone", gm(), aoe_id, None),
        ("caster_controller_clears_own_zone", player(), aoe_id, None),
        (
            "other_player_cannot_clear",
            other,
            aoe_id,
            Some(CommandError::PermissionDenied(
                "you do not control this token".into(),
            )),
        ),
        (
            "unknown_zone_is_not_found",
            gm(),
            Uuid::from_u128(0x404),
            Some(CommandError::NotFound(format!(
                "aoe {}",
                Uuid::from_u128(0x404)
            ))),
        ),
    ];

    for (case_id, actor, target_aoe, expected_err) in cases {
        let mut state = table(
            vec![token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID))],
            vec![],
        );
        state
            .apply_command(&player(), concentration_aoe(aoe_id, HERO_ID))
            .unwrap();
        let undo_before = state.undo_stack.len();

        let result = state.apply_command(&actor, TrameCommand::ClearAoe { aoe_id: target_aoe });

        match expected_err {
            Some(expected) => {
                assert_eq!(result.unwrap_err(), expected, "case {case_id}");
                assert!(
                    state.data.persistent_aoes.contains_key(&aoe_id),
                    "case {case_id}"
                );
                assert_eq!(state.undo_stack.len(), undo_before, "case {case_id}");
            }
            None => {
                assert_eq!(
                    result.unwrap(),
                    vec![TrameEvent::AoeCleared {
                        aoe_id,
                        caster_token_id: Some(HERO_ID),
                    }],
                    "case {case_id}"
                );
                assert!(state.data.persistent_aoes.is_empty(), "case {case_id}");
                assert_eq!(
                    state.data.tokens[&HERO_ID].concentrating_on_aoe_id, None,
                    "case {case_id} concentration ended"
                );
            }
        }
    }
}

#[test]
fn refund_action_restores_each_resource_for_the_gm_only() {
    let cases = [
        ("refund_action", RefundableResource::Action),
        ("refund_bonus_action", RefundableResource::BonusAction),
        ("refund_reaction", RefundableResource::Reaction),
        ("refund_movement", RefundableResource::Movement),
    ];
    for (case_id, resource) in cases {
        let mut spent = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
        spent.has_action = false;
        spent.has_bonus_action = false;
        spent.has_reaction = false;
        spent.speed_remaining_ft = 0.0;
        let mut state = table(vec![spent], vec![]);

        let err = state
            .apply_command(
                &player(),
                TrameCommand::RefundAction {
                    token_id: HERO_ID,
                    resource,
                },
            )
            .unwrap_err();
        assert_eq!(
            err,
            CommandError::PermissionDenied("GM role required for this command".into()),
            "case {case_id} player rejected"
        );

        let events = state
            .apply_command(
                &gm(),
                TrameCommand::RefundAction {
                    token_id: HERO_ID,
                    resource,
                },
            )
            .unwrap();
        assert_eq!(
            events,
            vec![TrameEvent::ActionRefunded {
                token_id: HERO_ID,
                resource
            }],
            "case {case_id}"
        );
        let t = &state.data.tokens[&HERO_ID];
        let restored = [
            (RefundableResource::Action, t.has_action),
            (RefundableResource::BonusAction, t.has_bonus_action),
            (RefundableResource::Reaction, t.has_reaction),
            (RefundableResource::Movement, t.speed_remaining_ft == 30.0),
        ];
        for (r, value) in restored {
            assert_eq!(
                value,
                r == resource,
                "case {case_id} only {resource:?} restored"
            );
        }
    }
}

#[test]
fn reveal_handout_records_and_broadcasts_without_undo() {
    let cases: Vec<(&str, CommandActor, &str, Option<CommandError>)> = vec![
        ("gm_reveals_handout", gm(), "crypt-map", None),
        (
            "player_cannot_reveal",
            player(),
            "crypt-map",
            Some(CommandError::PermissionDenied(
                "GM role required for this command".into(),
            )),
        ),
        (
            "blank_handout_id_is_rejected",
            gm(),
            "  ",
            Some(CommandError::InvalidConfiguration(
                "handout_id must not be empty".into(),
            )),
        ),
    ];
    for (case_id, actor, handout_id, expected_err) in cases {
        let mut state = table(vec![], vec![]);
        let result = state.apply_command(
            &actor,
            TrameCommand::RevealHandout {
                handout_id: handout_id.to_string(),
            },
        );
        match expected_err {
            Some(expected) => {
                assert_eq!(result.unwrap_err(), expected, "case {case_id}");
                assert!(state.data.revealed_handout_ids.is_empty(), "case {case_id}");
            }
            None => {
                assert_eq!(
                    result.unwrap(),
                    vec![TrameEvent::HandoutRevealed {
                        handout_id: handout_id.to_string()
                    }],
                    "case {case_id}"
                );
                assert!(
                    state.data.revealed_handout_ids.contains(handout_id),
                    "case {case_id}"
                );
            }
        }
        assert!(state.undo_stack.is_empty(), "case {case_id} never undoable");
    }
}

#[test]
fn revealed_handouts_survive_undo() {
    let reveal = || TrameCommand::RevealHandout {
        handout_id: "crypt-map".to_string(),
    };
    let cases: Vec<(&str, bool)> = vec![
        ("undo_of_an_earlier_move_keeps_the_reveal", false),
        ("undo_of_a_batch_containing_the_reveal_keeps_it", true),
    ];
    for (case_id, batched) in cases {
        let hero = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
        let mut state = table(vec![hero], vec![]);
        if batched {
            state
                .apply_batch(&gm(), vec![move_cmd(HERO_ID, 200.0, false), reveal()], "b")
                .unwrap();
        } else {
            state
                .apply_command(&gm(), move_cmd(HERO_ID, 200.0, false))
                .unwrap();
            state.apply_command(&gm(), reveal()).unwrap();
        }

        state
            .apply_command(&gm(), TrameCommand::UndoLastAction)
            .unwrap();

        assert_eq!(
            state.data.tokens[&HERO_ID].top_left.x, 0.0,
            "case {case_id}"
        );
        assert!(
            state.data.revealed_handout_ids.contains("crypt-map"),
            "case {case_id} still revealed"
        );
    }
}

#[test]
fn synthetic_gm_tokens_die_at_zero_hp() {
    // (case id, owner, linked actor, expect dead, expect unconscious)
    let cases: Vec<(&str, Option<Uuid>, Option<Uuid>, bool, bool)> = vec![
        ("synthetic_monster_dies_at_zero", None, None, true, false),
        (
            "linked_gm_npc_makes_death_saves",
            None,
            Some(Uuid::from_u128(0x99)),
            false,
            true,
        ),
        (
            "player_hero_makes_death_saves",
            Some(PLAYER_ID),
            None,
            false,
            true,
        ),
    ];
    for (case_id, owner, actor_id, expect_dead, expect_unconscious) in cases {
        let mut target = token(HERO_ID, "Target", 0.0, 0.0, owner);
        target.actor_id = actor_id;
        let mut state = table(vec![target], vec![]);

        let events = state.apply_command(&gm(), damage(HERO_ID, 25)).unwrap();

        let t = &state.data.tokens[&HERO_ID];
        assert_eq!(t.hp, 0, "case {case_id}");
        assert_eq!(t.is_dead, expect_dead, "case {case_id} dead");
        assert_eq!(t.death_save_failures, 0, "case {case_id} failures");
        match &events[0] {
            TrameEvent::DamageApplied { resolution, .. } => {
                assert_eq!(resolution.dead, expect_dead, "case {case_id}");
                assert_eq!(resolution.unconscious, expect_unconscious, "case {case_id}");
            }
            other => panic!("case {case_id}: unexpected {other:?}"),
        }
    }
}

#[test]
fn gm_override_above_zero_hp_revives_and_clears_death_saves() {
    // (case id, override hp, expect dead, expect hp)
    let cases: Vec<(&str, i32, bool, i32)> = vec![
        ("restoring_hp_clears_death", 5, false, 5),
        ("override_to_zero_keeps_death", 0, true, 0),
    ];
    for (case_id, hp, expect_dead, expect_hp) in cases {
        let mut target = token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID));
        target.hp = 0;
        target.is_dead = true;
        target.death_save_failures = 3;
        target.death_save_successes = 1;
        let mut state = table(vec![target], vec![]);

        let events = state
            .apply_command(
                &gm(),
                TrameCommand::GmOverrideTokenResources {
                    token_id: HERO_ID,
                    hp: Some(hp),
                    temp_hp: None,
                    speed_remaining_ft: None,
                    has_action: None,
                    has_bonus_action: None,
                    has_reaction: None,
                },
            )
            .unwrap();

        let t = &state.data.tokens[&HERO_ID];
        assert_eq!(t.hp, expect_hp, "case {case_id}");
        assert_eq!(t.is_dead, expect_dead, "case {case_id}");
        let cleared = !expect_dead;
        assert_eq!(t.death_save_failures == 0, cleared, "case {case_id}");
        assert_eq!(t.death_save_successes == 0, cleared, "case {case_id}");
        assert!(
            matches!(events[0], TrameEvent::TokenResourcesOverridden { is_dead, .. } if is_dead == expect_dead),
            "case {case_id} event"
        );
    }
}

#[test]
fn initiative_totals_are_stored_and_adjustable() {
    let rogue = Uuid::from_u128(0x40);
    let mut fast_rogue = token(rogue, "Rogue", 300.0, 0.0, Some(PLAYER_ID));
    fast_rogue.dex_mod = 4;
    let tokens = vec![
        token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID)),
        token(GOBLIN_ID, "Goblin", 500.0, 0.0, None),
        fast_rogue,
    ];

    let cases: Vec<(&str, Uuid, i32, Vec<Uuid>, Option<CommandError>)> = vec![
        (
            "raising_a_total_moves_the_combatant_up",
            GOBLIN_ID,
            20,
            vec![GOBLIN_ID, HERO_ID, rogue],
            None,
        ),
        (
            "ties_break_on_dex_mod_then_id",
            rogue,
            15,
            vec![rogue, HERO_ID, GOBLIN_ID],
            None,
        ),
        (
            "token_outside_initiative_is_not_found",
            Uuid::from_u128(0x404),
            10,
            vec![],
            Some(CommandError::NotFound(format!(
                "token {} in initiative order",
                Uuid::from_u128(0x404)
            ))),
        ),
    ];

    for (case_id, target, total, expected_order, expected_err) in cases {
        let mut state = table(tokens.clone(), vec![]);
        state
            .apply_command(
                &gm(),
                TrameCommand::StartTurnByTurn {
                    initiative_order: vec![HERO_ID, rogue, GOBLIN_ID],
                    initiative_totals: BTreeMap::from([
                        (HERO_ID, 15),
                        (rogue, 12),
                        (GOBLIN_ID, 8),
                        (Uuid::from_u128(0x999), 30),
                    ]),
                },
            )
            .unwrap();
        assert_eq!(
            state.data.initiative_totals.len(),
            3,
            "case {case_id} totals outside the order are dropped"
        );

        let result = state.apply_command(
            &gm(),
            TrameCommand::SetInitiativeTotal {
                token_id: target,
                total,
            },
        );
        match expected_err {
            Some(expected) => {
                assert_eq!(result.unwrap_err(), expected, "case {case_id}");
            }
            None => {
                result.unwrap();
                assert_eq!(
                    state.data.initiative_order, expected_order,
                    "case {case_id}"
                );
                assert_eq!(
                    state.active_turn_token_id(),
                    Some(HERO_ID),
                    "case {case_id} active combatant keeps the turn"
                );
                assert_eq!(
                    state.data.initiative_totals[&target], total,
                    "case {case_id}"
                );
            }
        }

        let err = state
            .apply_command(
                &player(),
                TrameCommand::SetInitiativeTotal {
                    token_id: HERO_ID,
                    total: 1,
                },
            )
            .unwrap_err();
        assert!(
            matches!(err, CommandError::PermissionDenied(_)),
            "case {case_id}"
        );

        state
            .apply_command(&gm(), TrameCommand::EndTurnByTurn)
            .unwrap();
        assert!(
            state.data.initiative_totals.is_empty(),
            "case {case_id} cleared with combat"
        );
    }
}

#[test]
fn wall_segment_accepts_canonical_and_map_editor_shapes() {
    let id = "00000000-0000-0000-0000-000000000001";
    let cases: Vec<(&str, String, WallKind, bool, bool, f64)> = vec![
        (
            "canonical_shape_round_trips",
            serde_json::to_string(&WallSegment::normal_wall(
                Uuid::from_u128(1),
                Point2D::new(0.0, 0.0),
                Point2D::new(10.0, 0.0),
            ))
            .unwrap(),
            WallKind::Normal,
            true,
            true,
            -1000.0,
        ),
        (
            "map_editor_open_door_string",
            format!(
                r#"{{"id":"{id}","p1":{{"x":0,"y":0}},"p2":{{"x":10,"y":0}},"wallType":"Door","doorState":"Open","blocksMovement":true,"blocksVision":true,"bottomElevationFt":0,"topElevationFt":10}}"#
            ),
            WallKind::Door {
                is_open: true,
                is_locked: false,
            },
            true,
            true,
            0.0,
        ),
        (
            "map_editor_locked_door_object",
            format!(
                r#"{{"id":"{id}","p1":{{"x":0,"y":0}},"p2":{{"x":10,"y":0}},"wallType":"Door","doorState":{{"isOpen":false,"isLocked":true}}}}"#
            ),
            WallKind::Door {
                is_open: false,
                is_locked: true,
            },
            true,
            true,
            -1000.0,
        ),
        (
            "map_editor_window_defaults_to_see_through",
            format!(
                r#"{{"id":"{id}","a":{{"x":0,"y":0}},"b":{{"x":10,"y":0}},"wallType":"Window"}}"#
            ),
            WallKind::Window,
            true,
            false,
            -1000.0,
        ),
        (
            "missing_kind_defaults_to_full_height_normal_wall",
            format!(r#"{{"id":"{id}","a":{{"x":0,"y":0}},"b":{{"x":10,"y":0}}}}"#),
            WallKind::Normal,
            true,
            true,
            -1000.0,
        ),
    ];
    for (case_id, json, kind, blocks_movement, blocks_vision, bottom_ft) in cases {
        let wall: WallSegment =
            serde_json::from_str(&json).unwrap_or_else(|e| panic!("case {case_id}: {e}"));
        assert_eq!(wall.kind, kind, "case {case_id} kind");
        assert_eq!(
            wall.blocks_movement, blocks_movement,
            "case {case_id} movement"
        );
        assert_eq!(wall.blocks_vision, blocks_vision, "case {case_id} vision");
        assert_eq!(wall.bottom_elevation_ft, bottom_ft, "case {case_id} bottom");
        let reparsed: WallSegment =
            serde_json::from_str(&serde_json::to_string(&wall).unwrap()).unwrap();
        assert_eq!(reparsed, wall, "case {case_id} canonical round trip");
    }
}

#[test]
fn walls_masked_for_players_hide_secrets_only() {
    let base = WallSegment::normal_wall(
        Uuid::from_u128(1),
        Point2D::new(0.0, 0.0),
        Point2D::new(10.0, 0.0),
    );
    let cases = [
        (
            "closed_secret_door_becomes_normal",
            WallKind::SecretDoor { is_open: false },
            WallKind::Normal,
        ),
        (
            "open_secret_door_stays_visible",
            WallKind::SecretDoor { is_open: true },
            WallKind::SecretDoor { is_open: true },
        ),
        (
            "illusion_becomes_normal",
            WallKind::Illusion {
                pierced_by_truesight: true,
            },
            WallKind::Normal,
        ),
        (
            "regular_door_is_unchanged",
            WallKind::Door {
                is_open: false,
                is_locked: true,
            },
            WallKind::Door {
                is_open: false,
                is_locked: true,
            },
        ),
    ];
    for (case_id, kind, expected_kind) in cases {
        let wall = WallSegment {
            kind,
            blocks_movement: false,
            ..base.clone()
        };
        let masked = wall.masked_for_players();
        assert_eq!(masked.kind, expected_kind, "case {case_id}");
        if expected_kind == WallKind::Normal {
            assert!(masked.blocks_movement, "case {case_id} masked wall blocks");
        }
    }
}

/// Hero (player-owned) adjacent to the goblin, Turn-by-Turn with the hero active.
fn adjacent_hero_and_goblin() -> TableState {
    let hero = token(HERO_ID, "Kyra", 100.0, 0.0, Some(PLAYER_ID));
    let goblin = token(GOBLIN_ID, "Goblin", 0.0, 0.0, None);
    table(vec![hero, goblin], vec![HERO_ID, GOBLIN_ID])
}

fn first_prompt_id(state: &mut TableState) -> Uuid {
    let events = state
        .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
        .unwrap();
    opened_prompts(&events).remove(0).prompt_id
}

#[test]
fn threat_reach_skips_reactors_that_cannot_react() {
    struct Case {
        id: &'static str,
        prepare: fn(&mut TableState),
        expect_prompt: bool,
    }
    let cases = [
        Case {
            id: "eligible_reactor_prompts",
            prepare: |_| {},
            expect_prompt: true,
        },
        Case {
            id: "gm_hidden_reactor_does_not_prompt",
            prepare: |s| {
                s.data
                    .tokens
                    .get_mut(&GOBLIN_ID)
                    .unwrap()
                    .visibility_channel |= trame_engine::geometry::CHANNEL_GM_HIDDEN;
            },
            expect_prompt: false,
        },
        Case {
            id: "incapacitated_reactor_does_not_prompt",
            prepare: |s| {
                s.data.tokens.get_mut(&GOBLIN_ID).unwrap().conditions =
                    vec!["incapacitated".into()];
            },
            expect_prompt: false,
        },
        Case {
            id: "stunned_label_matches_case_insensitively",
            prepare: |s| {
                s.data.tokens.get_mut(&GOBLIN_ID).unwrap().conditions = vec!["Stunned".into()];
            },
            expect_prompt: false,
        },
        Case {
            id: "non_incapacitating_condition_still_prompts",
            prepare: |s| {
                s.data.tokens.get_mut(&GOBLIN_ID).unwrap().conditions = vec!["prone".into()];
            },
            expect_prompt: true,
        },
        Case {
            id: "dead_reactor_does_not_prompt",
            prepare: |s| s.data.tokens.get_mut(&GOBLIN_ID).unwrap().is_dead = true,
            expect_prompt: false,
        },
        Case {
            id: "reactor_without_reaction_does_not_prompt",
            prepare: |s| s.data.tokens.get_mut(&GOBLIN_ID).unwrap().has_reaction = false,
            expect_prompt: false,
        },
        Case {
            id: "wall_blocking_line_of_sight_does_not_prompt",
            prepare: |s| {
                s.apply_command(
                    &gm(),
                    TrameCommand::AddWall {
                        wall: WallSegment::normal_wall(
                            Uuid::from_u128(0x99),
                            Point2D::new(100.0, -50.0),
                            Point2D::new(100.0, 150.0),
                        ),
                    },
                )
                .unwrap();
                s.undo_stack.clear();
            },
            expect_prompt: false,
        },
        Case {
            id: "invisible_mover_does_not_prompt",
            prepare: |s| s.data.tokens.get_mut(&HERO_ID).unwrap().invisible = true,
            expect_prompt: false,
        },
    ];

    for c in cases {
        let mut state = adjacent_hero_and_goblin();
        (c.prepare)(&mut state);
        let events = state
            .apply_command(&player(), move_cmd(HERO_ID, 400.0, false))
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));
        assert_eq!(
            !opened_prompts(&events).is_empty(),
            c.expect_prompt,
            "case {} prompt",
            c.id
        );
        let expect_x = if c.expect_prompt { 100.0 } else { 400.0 };
        assert_eq!(
            state.data.tokens[&HERO_ID].top_left.x, expect_x,
            "case {} stop square",
            c.id
        );
    }
}

#[test]
fn reaction_prompt_ids_are_one_way_and_unique_per_prompt() {
    struct Case {
        id: &'static str,
        /// Runs after the first prompt was opened on the same table and returns a new prompt ID.
        next_prompt: fn(&mut TableState) -> Uuid,
        expect_same_as_first: bool,
    }
    let cases = [
        Case {
            id: "replaying_the_same_commands_reproduces_the_id",
            next_prompt: |_| first_prompt_id(&mut adjacent_hero_and_goblin()),
            expect_same_as_first: true,
        },
        Case {
            id: "undo_then_repeat_issues_a_new_id",
            next_prompt: |s| {
                s.apply_command(&gm(), TrameCommand::UndoLastAction)
                    .unwrap();
                first_prompt_id(s)
            },
            expect_same_as_first: false,
        },
        Case {
            id: "same_pair_next_round_issues_a_new_id",
            next_prompt: |s| {
                s.apply_command(&gm(), TrameCommand::UndoLastAction)
                    .unwrap();
                s.apply_command(&gm(), TrameCommand::AdvanceTurn).unwrap();
                s.apply_command(&gm(), TrameCommand::AdvanceTurn).unwrap();
                assert_eq!(s.data.round, 2);
                first_prompt_id(s)
            },
            expect_same_as_first: false,
        },
    ];

    for c in cases {
        let mut state = adjacent_hero_and_goblin();
        let first = first_prompt_id(&mut state);
        let next = (c.next_prompt)(&mut state);
        assert_eq!(first == next, c.expect_same_as_first, "case {} id", c.id);
        for prompt_id in [first, next] {
            assert_eq!(prompt_id.get_version_num(), 8, "case {} UUIDv8", c.id);
            assert_ne!(
                prompt_id.as_u128() ^ HERO_ID.as_u128(),
                GOBLIN_ID.as_u128().rotate_left(64),
                "case {} reactor not recoverable by XOR",
                c.id
            );
        }
    }
}

#[test]
fn remove_token_keeps_the_active_turn_consistent() {
    struct Case {
        id: &'static str,
        order: Vec<Uuid>,
        advances_before: usize,
        removed: Uuid,
        expect_active: Option<Uuid>,
        expect_round: u32,
        expect_turn_advanced: bool,
    }
    let abc = vec![HERO_ID, GOBLIN_ID, GOBLIN_B_ID];
    let cases = [
        Case {
            id: "removing_a_combatant_before_the_active_one_keeps_the_turn",
            order: abc.clone(),
            advances_before: 1,
            removed: HERO_ID,
            expect_active: Some(GOBLIN_ID),
            expect_round: 1,
            expect_turn_advanced: false,
        },
        Case {
            id: "removing_a_combatant_after_the_active_one_keeps_the_turn",
            order: abc.clone(),
            advances_before: 0,
            removed: GOBLIN_B_ID,
            expect_active: Some(HERO_ID),
            expect_round: 1,
            expect_turn_advanced: false,
        },
        Case {
            id: "removing_the_active_combatant_passes_the_turn_on",
            order: abc.clone(),
            advances_before: 1,
            removed: GOBLIN_ID,
            expect_active: Some(GOBLIN_B_ID),
            expect_round: 1,
            expect_turn_advanced: true,
        },
        Case {
            id: "removing_the_active_last_combatant_wraps_to_a_new_round",
            order: abc.clone(),
            advances_before: 2,
            removed: GOBLIN_B_ID,
            expect_active: Some(HERO_ID),
            expect_round: 2,
            expect_turn_advanced: true,
        },
        Case {
            id: "removing_the_only_combatant_clears_the_turn",
            order: vec![GOBLIN_ID],
            advances_before: 0,
            removed: GOBLIN_ID,
            expect_active: None,
            expect_round: 1,
            expect_turn_advanced: true,
        },
        Case {
            id: "removing_a_token_outside_initiative_keeps_the_turn",
            order: vec![HERO_ID, GOBLIN_ID],
            advances_before: 1,
            removed: GOBLIN_B_ID,
            expect_active: Some(GOBLIN_ID),
            expect_round: 1,
            expect_turn_advanced: false,
        },
    ];

    for c in cases {
        let tokens = vec![
            token(HERO_ID, "Kyra", 0.0, 0.0, Some(PLAYER_ID)),
            token(GOBLIN_ID, "Goblin", 500.0, 0.0, None),
            token(GOBLIN_B_ID, "Goblin B", 1000.0, 0.0, None),
        ];
        let mut state = table(tokens, c.order.clone());
        for _ in 0..c.advances_before {
            state
                .apply_command(&gm(), TrameCommand::AdvanceTurn)
                .unwrap();
        }
        for tok in state.data.tokens.values_mut() {
            tok.speed_remaining_ft = 0.0;
            tok.has_action = false;
            tok.has_bonus_action = false;
            tok.has_reaction = false;
        }

        let events = state
            .apply_command(
                &gm(),
                TrameCommand::RemoveToken {
                    token_id: c.removed,
                },
            )
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));

        assert_eq!(
            state.active_turn_token_id(),
            c.expect_active,
            "case {} active",
            c.id
        );
        assert_eq!(state.data.round, c.expect_round, "case {} round", c.id);
        let advanced = events.contains(&TrameEvent::TurnAdvanced {
            active_turn_token_id: c.expect_active,
            round: c.expect_round,
        });
        assert_eq!(
            advanced, c.expect_turn_advanced,
            "case {} TurnAdvanced",
            c.id
        );
        if let Some(active) = c.expect_active {
            let tok = &state.data.tokens[&active];
            let fresh = tok.has_action && tok.has_reaction && tok.speed_remaining_ft == 30.0;
            assert_eq!(
                fresh, c.expect_turn_advanced,
                "case {} start-of-turn reset",
                c.id
            );
        }
    }
}

#[test]
fn undo_emits_reaction_prompt_diffs() {
    #[derive(Debug, PartialEq)]
    enum Expect {
        Closed,
        Reopened { awaiting_resolution: bool },
        Nothing,
    }
    struct Case {
        id: &'static str,
        /// Runs after the prompt was opened; the next `UndoLastAction` reverts its last command.
        then: fn(&mut TableState, Uuid),
        expect: Expect,
    }
    let cases = [
        Case {
            id: "undoing_the_move_closes_its_prompt",
            then: |_, _| {},
            expect: Expect::Closed,
        },
        Case {
            id: "undoing_a_pass_reopens_the_prompt",
            then: |s, prompt_id| {
                s.apply_command(
                    &gm(),
                    TrameCommand::DecideReaction {
                        prompt_id,
                        actor_id: GOBLIN_ID,
                        decision: ReactionDecision::Pass,
                    },
                )
                .unwrap();
            },
            expect: Expect::Reopened {
                awaiting_resolution: false,
            },
        },
        Case {
            id: "undoing_a_trigger_reopens_the_undecided_prompt",
            then: |s, prompt_id| {
                s.apply_command(
                    &gm(),
                    TrameCommand::DecideReaction {
                        prompt_id,
                        actor_id: GOBLIN_ID,
                        decision: ReactionDecision::Trigger { ability_id: None },
                    },
                )
                .unwrap();
            },
            expect: Expect::Reopened {
                awaiting_resolution: false,
            },
        },
        Case {
            id: "undoing_end_turn_by_turn_reopens_the_stale_prompt",
            then: |s, _| {
                s.apply_command(&gm(), TrameCommand::EndTurnByTurn).unwrap();
            },
            expect: Expect::Reopened {
                awaiting_resolution: false,
            },
        },
        Case {
            id: "undoing_an_unrelated_command_emits_no_prompt_events",
            then: |s, _| {
                s.apply_command(&gm(), goblin_spawn(0x30, 900.0)).unwrap();
            },
            expect: Expect::Nothing,
        },
    ];

    for c in cases {
        let mut state = adjacent_hero_and_goblin();
        let prompt_id = first_prompt_id(&mut state);
        (c.then)(&mut state, prompt_id);

        let events = state
            .apply_command(&gm(), TrameCommand::UndoLastAction)
            .unwrap_or_else(|e| panic!("case {}: {e}", c.id));

        let prompt_events: Vec<Expect> = events
            .iter()
            .filter_map(|e| match e {
                TrameEvent::ReactionPromptClosed {
                    prompt_id: closed,
                    reason: ReactionPromptCloseReason::Undone,
                } if *closed == prompt_id => Some(Expect::Closed),
                TrameEvent::ReactionPromptOpened { prompt } if prompt.prompt_id == prompt_id => {
                    Some(Expect::Reopened {
                        awaiting_resolution: prompt.awaiting_resolution,
                    })
                }
                TrameEvent::ReactionPromptOpened { .. }
                | TrameEvent::ReactionPromptClosed { .. } => {
                    panic!("case {}: unexpected prompt event {e:?}", c.id)
                }
                _ => None,
            })
            .collect();
        let expected: Vec<Expect> = match c.expect {
            Expect::Nothing => vec![],
            other => vec![other],
        };
        assert_eq!(prompt_events, expected, "case {} prompt events", c.id);
        assert_eq!(
            state.data.active_reaction_prompts.contains_key(&prompt_id),
            !matches!(expected.first(), Some(Expect::Closed)),
            "case {} stored prompt",
            c.id
        );
    }
}
