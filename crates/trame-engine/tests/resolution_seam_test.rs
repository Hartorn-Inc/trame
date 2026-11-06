//! Engine command seam for server-held action resolution and Concentration checks
//! (stories 50-54 and 58, decision D6): `ResolveAction`, `ApplyResolution`,
//! `DismissResolution` and `RollConcentrationCheck` applied to `TableState`. Every test is
//! table-driven and each case carries a descriptive ID printed on failure.

use trame_engine::aoe::{AoeShape, AoeTemplate, GridDiscretizationMode};
use trame_engine::resolution::{
    ActionRequest, ActionTargetRequest, ConcentrationRoll, ExtraDamage, MAX_PENDING_RESOLUTIONS,
    PendingResolution, ResolutionAdjustment, ResolutionCheck, ResolvedTarget, RollMode,
    TargetOutcome,
};
use trame_engine::{
    CampaignRole, CommandActor, CommandError, CoverLevel, Point2D, TableState, TokenState,
    TrameCommand, TrameEvent,
};
use uuid::Uuid;

const GM_ID: Uuid = Uuid::from_u128(0xF0);
const PLAYER_ID: Uuid = Uuid::from_u128(0xA1);
const OTHER_PLAYER_ID: Uuid = Uuid::from_u128(0xA2);
const HERO_ID: Uuid = Uuid::from_u128(0x10);
const GOBLIN_ID: Uuid = Uuid::from_u128(0x20);
const ORC_ID: Uuid = Uuid::from_u128(0x21);
const RESOLUTION_ID: Uuid = Uuid::from_u128(0x500);

fn actor(user_id: Uuid, role: CampaignRole) -> CommandActor {
    CommandActor { user_id, role }
}

fn gm() -> CommandActor {
    actor(GM_ID, CampaignRole::Gm)
}

fn player() -> CommandActor {
    actor(PLAYER_ID, CampaignRole::Player)
}

/// Hero (owned by `PLAYER_ID`) next to a goblin and an orc (GM tokens, 20 HP each).
fn table() -> TableState {
    let mut state = TableState::new(100.0, 5.0, Vec::new());
    let mut hero = TokenState::new_default(HERO_ID, "Hero", Point2D::new(0.0, 0.0));
    hero.owner_user_id = Some(PLAYER_ID);
    let goblin = TokenState::new_default(GOBLIN_ID, "Goblin", Point2D::new(100.0, 0.0));
    let mut orc = TokenState::new_default(ORC_ID, "Orc", Point2D::new(200.0, 0.0));
    orc.damage_resistances = vec!["fire".to_string()];
    for t in [hero, goblin, orc] {
        state.data.tokens.insert(t.id, t);
    }
    state
}

fn target(token_id: Uuid, outcome: TargetOutcome, damage: i32) -> ResolvedTarget {
    ResolvedTarget {
        token_id,
        roll_mode: RollMode::Normal,
        outcome,
        d20_rolls: vec![12],
        total: Some(17),
        damage,
        extra_damage: Vec::new(),
        is_critical: outcome == TargetOutcome::Critical,
        applied: false,
    }
}

/// `ResolveAction` as the room would forward it: request plus server-filled resolution.
fn resolve(issuer: Uuid, targets: Vec<ResolvedTarget>, damage_type: Option<&str>) -> TrameCommand {
    let request = ActionRequest {
        resolution_id: RESOLUTION_ID,
        attacker_token_id: Some(HERO_ID),
        action_name: "Fire Bolt".to_string(),
        check: ResolutionCheck::Attack {
            attack_bonus: 5,
            critical_range: 20,
        },
        damage_dice: "1d10".to_string(),
        damage_modifier: 0,
        damage_type: damage_type.map(str::to_string),
        extra_damage: Vec::new(),
        targets: targets
            .iter()
            .map(|t| ActionTargetRequest {
                token_id: t.token_id,
                roll_mode: RollMode::Normal,
                cover: CoverLevel::None,
            })
            .collect(),
    };
    let resolution = PendingResolution {
        id: RESOLUTION_ID,
        issuer_user_id: issuer,
        attacker_token_id: Some(HERO_ID),
        action_name: request.action_name.clone(),
        check: request.check.clone(),
        damage_type: request.damage_type.clone(),
        damage_expression: "1d10".to_string(),
        extra_damage: Vec::new(),
        targets,
        sequence: 0,
    };
    TrameCommand::ResolveAction {
        request: Box::new(request),
        resolution: Some(Box::new(resolution)),
    }
}

fn apply(token_id: Option<Uuid>, adjustment: Option<ResolutionAdjustment>) -> TrameCommand {
    TrameCommand::ApplyResolution {
        resolution_id: RESOLUTION_ID,
        token_id,
        adjustment,
    }
}

fn hp(state: &TableState, id: Uuid) -> i32 {
    state.data.tokens[&id].hp
}

#[test]
fn resolve_action_validates_issuer_and_payload() {
    struct Case {
        id: &'static str,
        actor: CommandActor,
        command: TrameCommand,
        expect_ok: bool,
    }
    let hit = || vec![target(GOBLIN_ID, TargetOutcome::Hit, 7)];
    let cases = [
        Case {
            id: "player_resolves_with_owned_attacker",
            actor: player(),
            command: resolve(PLAYER_ID, hit(), None),
            expect_ok: true,
        },
        Case {
            id: "gm_resolves_with_any_attacker",
            actor: gm(),
            command: resolve(GM_ID, hit(), None),
            expect_ok: true,
        },
        Case {
            id: "player_cannot_attack_with_unowned_token",
            actor: actor(OTHER_PLAYER_ID, CampaignRole::Player),
            command: resolve(OTHER_PLAYER_ID, hit(), None),
            expect_ok: false,
        },
        Case {
            id: "spectator_cannot_resolve",
            actor: actor(OTHER_PLAYER_ID, CampaignRole::Spectator),
            command: resolve(OTHER_PLAYER_ID, hit(), None),
            expect_ok: false,
        },
        Case {
            id: "issuer_must_match_the_actor",
            actor: player(),
            command: resolve(GM_ID, hit(), None),
            expect_ok: false,
        },
        Case {
            id: "missing_server_roll_is_rejected",
            actor: player(),
            command: match resolve(PLAYER_ID, hit(), None) {
                TrameCommand::ResolveAction { request, .. } => TrameCommand::ResolveAction {
                    request,
                    resolution: None,
                },
                other => other,
            },
            expect_ok: false,
        },
        Case {
            id: "unknown_target_is_rejected",
            actor: player(),
            command: resolve(
                PLAYER_ID,
                vec![target(Uuid::from_u128(0x99), TargetOutcome::Hit, 3)],
                None,
            ),
            expect_ok: false,
        },
        Case {
            id: "negative_damage_is_rejected",
            actor: player(),
            command: resolve(
                PLAYER_ID,
                vec![target(GOBLIN_ID, TargetOutcome::Hit, -1)],
                None,
            ),
            expect_ok: false,
        },
    ];
    for case in cases {
        let mut state = table();
        let result = state.apply_command(&case.actor, case.command);
        assert_eq!(result.is_ok(), case.expect_ok, "{}: {result:?}", case.id);
        assert_eq!(
            state.data.pending_resolutions.contains_key(&RESOLUTION_ID),
            case.expect_ok,
            "{}",
            case.id
        );
        assert_eq!(
            hp(&state, GOBLIN_ID),
            20,
            "{}: resolving never applies damage",
            case.id
        );
    }
}

#[test]
fn resolution_without_damage_left_is_not_stored() {
    let cases = [
        (
            "all_targets_missed",
            vec![target(GOBLIN_ID, TargetOutcome::Miss, 0)],
            false,
        ),
        (
            "one_hit_among_misses_is_stored",
            vec![
                target(GOBLIN_ID, TargetOutcome::Miss, 0),
                target(ORC_ID, TargetOutcome::Hit, 4),
            ],
            true,
        ),
    ];
    for (id, targets, expect_stored) in cases {
        let mut state = table();
        let events = state
            .apply_command(&player(), resolve(PLAYER_ID, targets, None))
            .unwrap();
        assert!(
            matches!(&events[..], [TrameEvent::ActionResolved { .. }]),
            "{id}: {events:?}"
        );
        assert_eq!(
            state.data.pending_resolutions.contains_key(&RESOLUTION_ID),
            expect_stored,
            "{id}"
        );
        if let Some(stored) = state.data.pending_resolutions.get(&RESOLUTION_ID) {
            assert!(
                stored.targets[0].applied,
                "{id}: 0-damage target is marked applied"
            );
            assert!(!stored.targets[1].applied, "{id}");
        }
    }
}

#[test]
fn apply_resolution_enforces_permissions_and_idempotency() {
    struct Case {
        id: &'static str,
        /// Commands applied in order after the resolution exists; the last one is checked.
        steps: Vec<(CommandActor, TrameCommand)>,
        expect_last_ok: bool,
        expect_goblin_hp: i32,
        expect_orc_hp: i32,
        expect_pending: bool,
    }
    let adjust = |damage: Option<i32>, damage_type: Option<&str>, crit: Option<bool>| {
        Some(ResolutionAdjustment {
            damage,
            damage_type: damage_type.map(str::to_string),
            is_critical: crit,
        })
    };
    let cases = [
        Case {
            id: "issuer_applies_all_targets_as_rolled",
            steps: vec![(player(), apply(None, None))],
            expect_last_ok: true,
            expect_goblin_hp: 13,
            // Fire resistance halves 6 to 3, derived by the engine from the damage type.
            expect_orc_hp: 17,
            expect_pending: false,
        },
        Case {
            id: "second_apply_is_refused",
            steps: vec![(player(), apply(None, None)), (gm(), apply(None, None))],
            expect_last_ok: false,
            expect_goblin_hp: 13,
            expect_orc_hp: 17,
            expect_pending: false,
        },
        Case {
            id: "single_target_apply_keeps_the_rest_pending",
            steps: vec![(player(), apply(Some(GOBLIN_ID), None))],
            expect_last_ok: true,
            expect_goblin_hp: 13,
            expect_orc_hp: 20,
            expect_pending: true,
        },
        Case {
            id: "apply_all_after_one_target_skips_the_applied_one",
            steps: vec![
                (player(), apply(Some(GOBLIN_ID), None)),
                (player(), apply(None, None)),
            ],
            expect_last_ok: true,
            expect_goblin_hp: 13,
            expect_orc_hp: 17,
            expect_pending: false,
        },
        Case {
            id: "applied_target_cannot_be_applied_again",
            steps: vec![
                (player(), apply(Some(GOBLIN_ID), None)),
                (player(), apply(Some(GOBLIN_ID), None)),
            ],
            expect_last_ok: false,
            expect_goblin_hp: 13,
            expect_orc_hp: 20,
            expect_pending: true,
        },
        Case {
            id: "other_player_cannot_apply",
            steps: vec![(
                actor(OTHER_PLAYER_ID, CampaignRole::Player),
                apply(None, None),
            )],
            expect_last_ok: false,
            expect_goblin_hp: 20,
            expect_orc_hp: 20,
            expect_pending: true,
        },
        Case {
            id: "issuer_cannot_adjust",
            steps: vec![(
                player(),
                apply(Some(GOBLIN_ID), adjust(Some(1), None, None)),
            )],
            expect_last_ok: false,
            expect_goblin_hp: 20,
            expect_orc_hp: 20,
            expect_pending: true,
        },
        Case {
            id: "gm_adjusts_amount_of_one_target",
            steps: vec![(gm(), apply(Some(GOBLIN_ID), adjust(Some(15), None, None)))],
            expect_last_ok: true,
            expect_goblin_hp: 5,
            expect_orc_hp: 20,
            expect_pending: true,
        },
        Case {
            id: "gm_retypes_damage_to_bypass_resistance",
            steps: vec![(gm(), apply(Some(ORC_ID), adjust(None, Some("cold"), None)))],
            expect_last_ok: true,
            expect_goblin_hp: 20,
            expect_orc_hp: 14,
            expect_pending: true,
        },
        Case {
            id: "amount_adjustment_needs_a_single_target",
            steps: vec![(gm(), apply(None, adjust(Some(15), None, None)))],
            expect_last_ok: false,
            expect_goblin_hp: 20,
            expect_orc_hp: 20,
            expect_pending: true,
        },
        Case {
            id: "gm_dismisses_without_damage",
            steps: vec![(
                gm(),
                TrameCommand::DismissResolution {
                    resolution_id: RESOLUTION_ID,
                },
            )],
            expect_last_ok: true,
            expect_goblin_hp: 20,
            expect_orc_hp: 20,
            expect_pending: false,
        },
        Case {
            id: "issuer_cannot_dismiss",
            steps: vec![(
                player(),
                TrameCommand::DismissResolution {
                    resolution_id: RESOLUTION_ID,
                },
            )],
            expect_last_ok: false,
            expect_goblin_hp: 20,
            expect_orc_hp: 20,
            expect_pending: true,
        },
    ];
    for case in cases {
        let mut state = table();
        state
            .apply_command(
                &player(),
                resolve(
                    PLAYER_ID,
                    vec![
                        target(GOBLIN_ID, TargetOutcome::Hit, 7),
                        target(ORC_ID, TargetOutcome::Hit, 6),
                    ],
                    Some("fire"),
                ),
            )
            .unwrap();
        let mut last = Ok(Vec::new());
        for (who, command) in case.steps {
            last = state.apply_command(&who, command);
        }
        assert_eq!(last.is_ok(), case.expect_last_ok, "{}: {last:?}", case.id);
        assert_eq!(hp(&state, GOBLIN_ID), case.expect_goblin_hp, "{}", case.id);
        assert_eq!(hp(&state, ORC_ID), case.expect_orc_hp, "{}", case.id);
        assert_eq!(
            state.data.pending_resolutions.contains_key(&RESOLUTION_ID),
            case.expect_pending,
            "{}",
            case.id
        );
    }
}

/// `resolve` with a primary part of `primary_type` and one extra part per `(type, damage)`.
fn resolve_parts(
    token_id: Uuid,
    primary: (Option<&str>, i32),
    extra: &[(&str, i32)],
) -> TrameCommand {
    let mut hit = target(token_id, TargetOutcome::Hit, primary.1);
    hit.extra_damage = extra.iter().map(|(_, damage)| *damage).collect();
    let TrameCommand::ResolveAction {
        request,
        resolution: Some(mut resolution),
    } = resolve(GM_ID, vec![hit], primary.0)
    else {
        unreachable!("resolve builds a filled ResolveAction")
    };
    resolution.extra_damage = extra
        .iter()
        .map(|(damage_type, _)| ExtraDamage {
            damage_type: Some(damage_type.to_string()),
            expression: "2d6".to_string(),
        })
        .collect();
    TrameCommand::ResolveAction {
        request,
        resolution: Some(resolution),
    }
}

#[test]
fn every_damage_part_is_mitigated_by_its_own_type() {
    struct Case {
        id: &'static str,
        token_id: Uuid,
        primary: (Option<&'static str>, i32),
        extra: Vec<(&'static str, i32)>,
        adjustment: Option<ResolutionAdjustment>,
        expect_hp: i32,
    }
    let cases = [
        Case {
            id: "fire_resistance_halves_only_the_fire_part",
            token_id: ORC_ID,
            primary: (Some("slashing"), 6),
            extra: vec![("fire", 7)],
            adjustment: None,
            expect_hp: 20 - 6 - 3,
        },
        Case {
            id: "no_affinity_takes_every_part_in_full",
            token_id: GOBLIN_ID,
            primary: (Some("piercing"), 5),
            extra: vec![("poison", 4), ("fire", 3)],
            adjustment: None,
            expect_hp: 20 - 12,
        },
        Case {
            id: "resisted_primary_with_unresisted_extra_part",
            token_id: ORC_ID,
            primary: (Some("fire"), 9),
            extra: vec![("cold", 2)],
            adjustment: None,
            expect_hp: 20 - 4 - 2,
        },
        Case {
            id: "gm_total_override_uses_the_primary_type",
            token_id: ORC_ID,
            primary: (Some("fire"), 6),
            extra: vec![("cold", 6)],
            adjustment: Some(ResolutionAdjustment {
                damage: Some(10),
                ..ResolutionAdjustment::default()
            }),
            expect_hp: 20 - 5,
        },
        Case {
            id: "gm_retyped_primary_keeps_the_extra_part_type",
            token_id: ORC_ID,
            primary: (Some("fire"), 6),
            extra: vec![("fire", 6)],
            adjustment: Some(ResolutionAdjustment {
                damage_type: Some("cold".to_string()),
                ..ResolutionAdjustment::default()
            }),
            expect_hp: 20 - 6 - 3,
        },
    ];
    for case in cases {
        let mut state = table();
        state
            .apply_command(
                &gm(),
                resolve_parts(case.token_id, case.primary, &case.extra),
            )
            .unwrap_or_else(|e| panic!("{}: {e:?}", case.id));
        state
            .apply_command(&gm(), apply(Some(case.token_id), case.adjustment))
            .unwrap_or_else(|e| panic!("{}: {e:?}", case.id));
        assert_eq!(hp(&state, case.token_id), case.expect_hp, "{}", case.id);
    }
}

#[test]
fn damage_parts_must_match_the_resolution() {
    let cases = [
        ("negative_extra_part_is_rejected", vec![-1], 1),
        ("more_target_parts_than_action_parts", vec![2, 2], 1),
        ("more_than_three_extra_parts", vec![1, 1, 1, 1], 4),
    ];
    for (id, target_parts, action_parts) in cases {
        let mut hit = target(GOBLIN_ID, TargetOutcome::Hit, 3);
        hit.extra_damage = target_parts;
        let TrameCommand::ResolveAction {
            request,
            resolution: Some(mut resolution),
        } = resolve(GM_ID, vec![hit], None)
        else {
            unreachable!("resolve builds a filled ResolveAction")
        };
        resolution.extra_damage = (0..action_parts)
            .map(|_| ExtraDamage {
                damage_type: None,
                expression: "1d4".to_string(),
            })
            .collect();
        let mut state = table();
        let result = state.apply_command(
            &gm(),
            TrameCommand::ResolveAction {
                request,
                resolution: Some(resolution),
            },
        );
        assert!(
            matches!(result, Err(CommandError::InvalidConfiguration(_))),
            "{id}: {result:?}"
        );
    }
}

#[test]
fn undo_restores_a_pending_resolution_with_the_hp() {
    let mut state = table();
    state
        .apply_command(
            &player(),
            resolve(
                PLAYER_ID,
                vec![target(GOBLIN_ID, TargetOutcome::Critical, 9)],
                None,
            ),
        )
        .unwrap();
    let events = state.apply_command(&player(), apply(None, None)).unwrap();
    assert!(
        events.iter().any(
            |e| matches!(e, TrameEvent::DamageApplied { resolution, .. } if resolution.new_hp == 11)
        ),
        "critical_damage_applied: {events:?}"
    );
    assert!(state.data.pending_resolutions.is_empty());
    state
        .apply_command(&gm(), TrameCommand::UndoLastAction)
        .unwrap();
    assert_eq!(hp(&state, GOBLIN_ID), 20);
    assert!(!state.data.pending_resolutions[&RESOLUTION_ID].targets[0].applied);
}

#[test]
fn pending_resolutions_are_capped_and_survive_snapshot_roundtrip() {
    let mut state = table();
    let mut first = None;
    for n in 0..=MAX_PENDING_RESOLUTIONS {
        let id = Uuid::from_u128(0x1000 + n as u128);
        first.get_or_insert(id);
        let TrameCommand::ResolveAction {
            mut request,
            resolution: Some(mut resolution),
        } = resolve(GM_ID, vec![target(GOBLIN_ID, TargetOutcome::Hit, 1)], None)
        else {
            unreachable!()
        };
        request.resolution_id = id;
        resolution.id = id;
        state
            .apply_command(
                &gm(),
                TrameCommand::ResolveAction {
                    request,
                    resolution: Some(resolution),
                },
            )
            .unwrap();
    }
    assert_eq!(
        state.data.pending_resolutions.len(),
        MAX_PENDING_RESOLUTIONS
    );
    assert!(
        !state.data.pending_resolutions.contains_key(&first.unwrap()),
        "oldest_resolution_is_dropped"
    );
    let json = serde_json::to_string(&state.data).unwrap();
    let restored: trame_engine::TableSnapshotData = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.pending_resolutions, state.data.pending_resolutions);
    assert_eq!(restored.resolution_seq, state.data.resolution_seq);
}

#[test]
fn concentration_check_is_queued_and_rolled() {
    struct Case {
        id: &'static str,
        roller: CommandActor,
        roll_total: i32,
        expect_ok: bool,
        expect_concentrating: bool,
        expect_check_left: bool,
    }
    let cases = [
        Case {
            id: "controller_success_keeps_concentration",
            roller: player(),
            roll_total: 10,
            expect_ok: true,
            expect_concentrating: true,
            expect_check_left: false,
        },
        Case {
            id: "controller_failure_ends_concentration_and_zone",
            roller: player(),
            roll_total: 9,
            expect_ok: true,
            expect_concentrating: false,
            expect_check_left: false,
        },
        Case {
            id: "gm_may_roll_for_any_token",
            roller: gm(),
            roll_total: 15,
            expect_ok: true,
            expect_concentrating: true,
            expect_check_left: false,
        },
        Case {
            id: "other_player_cannot_roll",
            roller: actor(OTHER_PLAYER_ID, CampaignRole::Player),
            roll_total: 15,
            expect_ok: false,
            expect_concentrating: true,
            expect_check_left: true,
        },
    ];
    for case in cases {
        let mut state = table();
        let zone_id = Uuid::from_u128(0x700);
        state
            .data
            .tokens
            .get_mut(&HERO_ID)
            .unwrap()
            .concentrating_on_aoe_id = Some(zone_id);
        state.data.persistent_aoes.insert(
            zone_id,
            AoeTemplate {
                id: zone_id,
                origin: Point2D::new(0.0, 0.0),
                origin_elevation_ft: 0.0,
                shape: AoeShape::Sphere { radius_ft: 10.0 },
                stops_at_walls: false,
                discretization: GridDiscretizationMode::CenterPoint,
                concentration_caster_id: Some(HERO_ID),
            },
        );
        let events = state
            .apply_command(
                &gm(),
                TrameCommand::ApplyDamage {
                    token_id: HERO_ID,
                    raw_damage: 8,
                    affinity: trame_engine::rules::DamageAffinity::Normal,
                    is_critical: false,
                    damage_type: None,
                },
            )
            .unwrap();
        assert!(
            events.iter().any(|e| matches!(
                e,
                TrameEvent::ConcentrationCheckRequested { token_id, dc: 10 } if *token_id == HERO_ID
            )),
            "{}: {events:?}",
            case.id
        );
        assert_eq!(state.data.pending_concentration_checks[&HERO_ID], vec![10]);
        let result = state.apply_command(
            &case.roller,
            TrameCommand::RollConcentrationCheck {
                token_id: HERO_ID,
                roll_mode: RollMode::Normal,
                roll: Some(ConcentrationRoll {
                    d20_rolls: vec![case.roll_total.clamp(1, 20) as u8],
                    total: case.roll_total,
                }),
            },
        );
        assert_eq!(result.is_ok(), case.expect_ok, "{}: {result:?}", case.id);
        let hero = &state.data.tokens[&HERO_ID];
        assert_eq!(
            hero.concentrating_on_aoe_id.is_some(),
            case.expect_concentrating,
            "{}",
            case.id
        );
        assert_eq!(
            state.data.persistent_aoes.contains_key(&zone_id),
            case.expect_concentrating,
            "{}",
            case.id
        );
        assert_eq!(
            state
                .data
                .pending_concentration_checks
                .contains_key(&HERO_ID),
            case.expect_check_left,
            "{}",
            case.id
        );
    }
}

#[test]
fn concentration_check_requires_a_pending_check_and_a_server_roll() {
    let roll = || {
        Some(ConcentrationRoll {
            d20_rolls: vec![15],
            total: 15,
        })
    };
    let cases: [(&str, bool, Option<ConcentrationRoll>); 3] = [
        ("no_pending_check", false, roll()),
        ("missing_server_roll", true, None),
        (
            "out_of_range_d20",
            true,
            Some(ConcentrationRoll {
                d20_rolls: vec![21],
                total: 21,
            }),
        ),
    ];
    for (id, pending, roll) in cases {
        let mut state = table();
        state.data.tokens.get_mut(&HERO_ID).unwrap().concentrating = true;
        if pending {
            state
                .data
                .pending_concentration_checks
                .insert(HERO_ID, vec![12]);
        }
        let result = state.apply_command(
            &player(),
            TrameCommand::RollConcentrationCheck {
                token_id: HERO_ID,
                roll_mode: RollMode::Normal,
                roll,
            },
        );
        assert!(
            matches!(result, Err(CommandError::InvalidConfiguration(_))),
            "{id}: {result:?}"
        );
    }
}

#[test]
fn concentration_checks_are_pruned_when_concentration_ends() {
    let mut state = table();
    state.data.tokens.get_mut(&HERO_ID).unwrap().concentrating = true;
    state
        .data
        .pending_concentration_checks
        .insert(HERO_ID, vec![12]);
    state
        .apply_command(
            &gm(),
            TrameCommand::BreakConcentration {
                caster_token_id: HERO_ID,
            },
        )
        .unwrap();
    assert!(state.data.pending_concentration_checks.is_empty());
}
