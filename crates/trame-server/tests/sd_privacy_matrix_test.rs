//! ============================================================================
//! S-D REALTIME PRIVACY MATRIX (sd_privacy_matrix_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Pins what each recipient receives for every event kind the wave 2 audit
//!   flagged (RT2, RT4, RT6, RT7, RT8), so a later change to the per-recipient
//!   filters cannot silently leak HP, hidden tokens or reaction prompts.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Four recipients per case: the GM, the token's controller (`controller`),
//!     another player who can see the token (`viewer`), and a player whose only
//!     token is behind a wall (`blind`).
//!   - Filters are exercised through the public `sync` functions on a table
//!     built in memory; initiative, pointer pings and the bounded outbound queue
//!     go through a real `TableRoomActor`.
//! ============================================================================

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use trame_engine::aoe::{AoeShape, AoeTemplate, GridDiscretizationMode};
use trame_engine::commands::{
    CampaignRole, CommandActor, ConditionOverrideEntry, OverrideMode, OverrideSubject,
    ReactionDecision, ReactionPrompt, RefundableResource, TableMode, TableState, TokenState,
    TrameCommand, TrameEvent,
};
use trame_engine::geometry::{Bvh2D, CHANNEL_GM_HIDDEN, Point2D, WallSegment};
use trame_engine::resolution::{
    PendingResolution, ResolutionCheck, ResolvedTarget, RollMode, TargetOutcome,
};
use trame_engine::rules::{DamageAffinity, DeathSaveOutcome};
use trame_server::room::{
    ConnectedClient, OutboundClientFrame, RoomSinks, TableRoomActor, TableRoomHandle, TimelineNote,
    client_channel, client_channel_with_capacity,
};
use trame_server::sync::{
    BloodiedState, ClientEnvelope, ServerEnvelope, filter_events_for_recipient,
    project_state_for_recipient,
};
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Table fixture
// ---------------------------------------------------------------------------

/// Recipients in matrix order.
const RECIPIENTS: [&str; 4] = ["gm", "controller", "viewer", "blind"];

struct Table {
    state: TableState,
    gm: Uuid,
    controller: Uuid,
    viewer: Uuid,
    blind: Uuid,
    /// Token controlled by `controller`, seen by `viewer`, hidden from `blind` by the wall.
    hero: Uuid,
    /// Token of `blind`, alone behind the wall.
    blind_token: Uuid,
    /// GM-hidden monster next to `hero`.
    lurker: Uuid,
}

impl Table {
    fn new() -> Self {
        let wall = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(1000.0, -10.0),
            Point2D::new(1000.0, 2010.0),
        );
        let mut state = TableState::new(100.0, 5.0, vec![wall]);
        state.bvh = Bvh2D::build(state.data.walls.clone());
        let (gm, controller, viewer, blind) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );

        let mut place = |name: &str, x: f64, y: f64, owner: Option<Uuid>| {
            let id = Uuid::new_v4();
            let mut t = TokenState::new_default(id, name, Point2D::new(x, y));
            t.owner_user_id = owner;
            t.max_hp = 20;
            t.hp = 12;
            t.speed_max_ft = 30.0;
            t.speed_remaining_ft = 25.0;
            t.has_action = false;
            state.data.tokens.insert(id, t);
            id
        };
        let hero = place("Hero", 100.0, 100.0, Some(controller));
        place("Viewer", 100.0, 400.0, Some(viewer));
        let blind_token = place("Blind", 1500.0, 100.0, Some(blind));
        let lurker = place("Lurker", 300.0, 100.0, None);
        state
            .data
            .tokens
            .get_mut(&lurker)
            .unwrap()
            .visibility_channel |= CHANNEL_GM_HIDDEN;
        Self {
            state,
            gm,
            controller,
            viewer,
            blind,
            hero,
            blind_token,
            lurker,
        }
    }

    fn recipient(&self, name: &str) -> (Uuid, CampaignRole) {
        match name {
            "gm" => (self.gm, CampaignRole::Gm),
            "controller" => (self.controller, CampaignRole::Player),
            "viewer" => (self.viewer, CampaignRole::Player),
            _ => (self.blind, CampaignRole::Player),
        }
    }

    fn prompt(&self, reactor: Uuid, reactor_owner: Option<Uuid>) -> ReactionPrompt {
        ReactionPrompt {
            prompt_id: Uuid::new_v4(),
            reactor_actor_id: reactor,
            trigger_token_id: self.hero,
            pending_destination: Some(Point2D::new(100.0, 200.0)),
            pending_elevation_ft: Some(0.0),
            reactor_owner_user_id: reactor_owner,
            resolved_reactor_ids: vec![self.lurker],
            awaiting_resolution: false,
        }
    }
}

/// What a recipient must receive for one event.
#[derive(Debug, Clone, Copy)]
enum Want {
    /// Nothing.
    Absent,
    /// The event unchanged.
    Same,
    /// `speed_remaining_ft` zeroed.
    NoSpeed,
    /// `AoeCleared` without its caster.
    NoCaster,
    /// `ReactionPromptOpened` without other reactors and without the hidden mover's destination.
    PromptRedacted,
    /// `TokenMoved` whose `from_top_left` is its destination.
    NoOrigin,
    /// `ActionResolved` whose targets the recipient does not control lost their d20s and total.
    ResolutionRedacted,
    /// `TokenConditionsChanged` whose raw `conditions` are replaced by the effective list.
    EffectiveConditions,
    /// `ConditionOverrideChanged` without its rulings.
    NoOverrides,
    /// `DeathSaveRecorded` keeping only the d20 and the Stable / dead flags.
    DeathSaveRedacted,
    /// `TokenSpawned` without the GM's stat block copy.
    NoStatBlock,
}

fn expected(want: Want, ev: &TrameEvent) -> Vec<TrameEvent> {
    let mut ev = ev.clone();
    match (want, &mut ev) {
        (Want::Absent, _) => return Vec::new(),
        (Want::Same, _) => {}
        (
            Want::NoSpeed,
            TrameEvent::TokenMoved {
                speed_remaining_ft, ..
            }
            | TrameEvent::TokenSqueezeToggled {
                speed_remaining_ft, ..
            },
        ) => *speed_remaining_ft = 0.0,
        (
            Want::NoCaster,
            TrameEvent::AoeCleared {
                caster_token_id, ..
            },
        ) => *caster_token_id = None,
        (Want::PromptRedacted, TrameEvent::ReactionPromptOpened { prompt }) => {
            prompt.resolved_reactor_ids.clear();
            prompt.pending_destination = None;
            prompt.pending_elevation_ft = None;
        }
        (
            Want::NoOrigin,
            TrameEvent::TokenMoved {
                from_top_left,
                to_top_left,
                ..
            },
        ) => *from_top_left = *to_top_left,
        (Want::ResolutionRedacted, TrameEvent::ActionResolved { resolution }) => {
            // Only the first target (the hidden monster) is not controlled by the issuer.
            resolution.targets[0].d20_rolls.clear();
            resolution.targets[0].total = None;
        }
        (
            Want::EffectiveConditions,
            TrameEvent::TokenConditionsChanged {
                conditions,
                effective_conditions,
                ..
            },
        ) => *conditions = effective_conditions.clone(),
        (Want::NoOverrides, TrameEvent::ConditionOverrideChanged { overrides, .. }) => {
            overrides.clear();
        }
        (Want::DeathSaveRedacted, TrameEvent::DeathSaveRecorded { outcome, .. }) => {
            outcome.successes = 0;
            outcome.failures = 0;
            outcome.regains_hp = false;
        }
        (Want::NoStatBlock, TrameEvent::TokenSpawned { token }) => token.stat_block = None,
        (want, ev) => panic!("{want:?} does not apply to {ev:?}"),
    }
    vec![ev]
}

fn gm() -> CommandActor {
    CommandActor {
        user_id: Uuid::new_v4(),
        role: CampaignRole::Gm,
    }
}

/// Resolution issued by `controller`: a hit on the lurker (hidden AC) and a hit on their own
/// hero.
fn controller_resolution(t: &Table) -> PendingResolution {
    let hit = |token_id| ResolvedTarget {
        token_id,
        roll_mode: RollMode::Normal,
        outcome: TargetOutcome::Hit,
        d20_rolls: vec![14],
        total: Some(19),
        damage: 6,
        is_critical: false,
        applied: false,
    };
    PendingResolution {
        id: Uuid::new_v4(),
        issuer_user_id: t.controller,
        attacker_token_id: Some(t.hero),
        action_name: "Longsword".to_string(),
        check: ResolutionCheck::Attack {
            attack_bonus: 5,
            critical_range: 20,
        },
        damage_type: Some("slashing".to_string()),
        damage_expression: "1d8+3".to_string(),
        targets: vec![hit(t.lurker), hit(t.hero)],
        sequence: 1,
    }
}

/// One event produced by the engine from a GM command on `table.state`.
fn engine_event(table: &Table, cmd: TrameCommand) -> TrameEvent {
    let mut scratch = table.state.clone();
    let mut events = scratch.apply_command(&gm(), cmd).unwrap();
    assert_eq!(events.len(), 1, "{events:?}");
    events.remove(0)
}

// ---------------------------------------------------------------------------
// Event matrix
// ---------------------------------------------------------------------------

#[test]
fn event_privacy_matrix() {
    use Want::*;
    let t = Table::new();
    let lurker_prompt = t.prompt(t.lurker, None);
    let blind_prompt = t.prompt(t.blind_token, Some(t.blind));
    let mut spawned = t.state.data.tokens[&t.hero].clone();
    spawned.id = Uuid::new_v4();
    spawned.top_left = Point2D::new(100.0, 250.0);
    spawned.stat_block = Some(serde_json::json!({ "name": "Knight", "attackBonus": 5 }));
    let mut with_spawned = t.state.clone();
    with_spawned.data.tokens.insert(spawned.id, spawned.clone());
    let mut hero_removed = t.state.clone();
    hero_removed.data.tokens.remove(&t.hero);
    // The GM-hidden lurker handed to `controller`: controlled, but not visible to them.
    let mut lurker_owned = t.state.clone();
    lurker_owned
        .data
        .tokens
        .get_mut(&t.lurker)
        .unwrap()
        .owner_user_id = Some(t.controller);
    let removed_poison = ConditionOverrideEntry {
        subject: OverrideSubject::Condition,
        id: "poisoned".to_string(),
        mode: OverrideMode::Remove,
    };
    let mut with_prompts = t.state.clone();
    for p in [&lurker_prompt, &blind_prompt] {
        with_prompts
            .data
            .active_reaction_prompts
            .insert(p.prompt_id, p.clone());
    }
    let resolution = controller_resolution(&t);
    let mut with_resolution = t.state.clone();
    with_resolution
        .data
        .pending_resolutions
        .insert(resolution.id, resolution.clone());

    // (case_id, event, (state after, state before), [gm, controller, viewer, blind])
    let cases: Vec<(&str, TrameEvent, (&TableState, &TableState), [Want; 4])> = vec![
        (
            "damage_applied_hp_for_controller_only",
            engine_event(
                &t,
                TrameCommand::ApplyDamage {
                    token_id: t.hero,
                    raw_damage: 3,
                    affinity: DamageAffinity::Normal,
                    is_critical: false,
                    damage_type: None,
                },
            ),
            (&t.state, &t.state),
            [Same, Same, Absent, Absent],
        ),
        (
            "token_healed_hp_for_controller_only",
            engine_event(
                &t,
                TrameCommand::HealActor {
                    token_id: t.hero,
                    amount: 2,
                },
            ),
            (&t.state, &t.state),
            [Same, Same, Absent, Absent],
        ),
        (
            "resources_overridden_for_controller_only",
            engine_event(
                &t,
                TrameCommand::GmOverrideTokenResources {
                    token_id: t.hero,
                    hp: Some(5),
                    temp_hp: None,
                    speed_remaining_ft: None,
                    has_action: None,
                    has_bonus_action: None,
                    has_reaction: None,
                },
            ),
            (&t.state, &t.state),
            [Same, Same, Absent, Absent],
        ),
        (
            "action_refunded_for_controller_only",
            engine_event(
                &t,
                TrameCommand::RefundAction {
                    token_id: t.hero,
                    resource: RefundableResource::Action,
                },
            ),
            (&t.state, &t.state),
            [Same, Same, Absent, Absent],
        ),
        (
            "token_spawned_full_payload_for_controller_only",
            TrameEvent::TokenSpawned {
                token: Box::new(spawned.clone()),
            },
            (&with_spawned, &t.state),
            [Same, NoStatBlock, Absent, Absent],
        ),
        (
            "conditions_changed_raw_list_for_controller_only",
            TrameEvent::TokenConditionsChanged {
                token_id: t.hero,
                conditions: vec!["poisoned".to_string(), "prone".to_string()],
                effective_conditions: vec!["prone".to_string()],
            },
            (&t.state, &t.state),
            [Same, Same, EffectiveConditions, Absent],
        ),
        (
            "override_rulings_for_controller_only",
            TrameEvent::ConditionOverrideChanged {
                token_id: t.hero,
                overrides: vec![removed_poison.clone()],
                effective_conditions: vec!["prone".to_string()],
            },
            (&t.state, &t.state),
            [Same, Same, NoOverrides, Absent],
        ),
        (
            "override_rulings_skip_a_controller_who_cannot_see_the_token",
            TrameEvent::ConditionOverrideChanged {
                token_id: t.lurker,
                overrides: vec![removed_poison.clone()],
                effective_conditions: vec![],
            },
            (&lurker_owned, &lurker_owned),
            [Same, Absent, Absent, Absent],
        ),
        (
            "death_save_counters_for_controller_only",
            TrameEvent::DeathSaveRecorded {
                token_id: t.hero,
                d20: 12,
                outcome: DeathSaveOutcome {
                    successes: 2,
                    failures: 1,
                    regains_hp: false,
                    stable: false,
                    dead: false,
                },
            },
            (&t.state, &t.state),
            [Same, Same, DeathSaveRedacted, Absent],
        ),
        (
            "death_save_revival_keeps_only_the_d20_for_viewers",
            TrameEvent::DeathSaveRecorded {
                token_id: t.hero,
                d20: 20,
                outcome: DeathSaveOutcome {
                    successes: 0,
                    failures: 0,
                    regains_hp: true,
                    stable: false,
                    dead: false,
                },
            },
            (&t.state, &t.state),
            [Same, Same, DeathSaveRedacted, Absent],
        ),
        (
            "death_save_death_flag_reaches_viewers",
            TrameEvent::DeathSaveRecorded {
                token_id: t.hero,
                d20: 1,
                outcome: DeathSaveOutcome {
                    successes: 1,
                    failures: 3,
                    regains_hp: false,
                    stable: false,
                    dead: true,
                },
            },
            (&t.state, &t.state),
            [Same, Same, DeathSaveRedacted, Absent],
        ),
        (
            "token_moved_speed_for_controller_only",
            TrameEvent::TokenMoved {
                token_id: t.hero,
                from_top_left: Point2D::new(100.0, 50.0),
                to_top_left: Point2D::new(100.0, 100.0),
                elevation_ft: 0.0,
                speed_remaining_ft: 25.0,
            },
            (&t.state, &t.state),
            [Same, Same, NoSpeed, Absent],
        ),
        (
            "squeeze_toggled_speed_for_controller_only",
            TrameEvent::TokenSqueezeToggled {
                token_id: t.hero,
                is_squeezing: true,
                speed_remaining_ft: 25.0,
            },
            (&t.state, &t.state),
            [Same, Same, NoSpeed, Absent],
        ),
        (
            "token_removed_only_to_those_who_saw_it",
            TrameEvent::TokenRemoved { token_id: t.hero },
            (&hero_removed, &t.state),
            [Same, Same, Same, Absent],
        ),
        (
            "hidden_token_removed_reaches_gm_only",
            TrameEvent::TokenRemoved { token_id: t.lurker },
            (&t.state, &t.state),
            [Same, Absent, Absent, Absent],
        ),
        (
            "aoe_cleared_hides_caster_from_blind",
            TrameEvent::AoeCleared {
                aoe_id: Uuid::new_v4(),
                caster_token_id: Some(t.hero),
            },
            (&t.state, &t.state),
            [Same, Same, Same, NoCaster],
        ),
        (
            "hidden_reactor_prompt_never_reaches_the_mover",
            TrameEvent::ReactionPromptOpened {
                prompt: lurker_prompt.clone(),
            },
            (&t.state, &t.state),
            [Same, Absent, Absent, Absent],
        ),
        (
            "reactor_owner_gets_prompt_without_hidden_mover_destination",
            TrameEvent::ReactionPromptOpened {
                prompt: blind_prompt.clone(),
            },
            (&t.state, &t.state),
            [Same, Absent, Absent, PromptRedacted],
        ),
        (
            "reaction_decided_follows_the_prompt_audience",
            TrameEvent::ReactionDecided {
                prompt_id: blind_prompt.prompt_id,
                actor_id: t.blind_token,
                decision: ReactionDecision::Pass,
                movement_interrupted: false,
            },
            (&t.state, &with_prompts),
            [Same, Absent, Absent, Same],
        ),
        (
            "action_resolved_reaches_issuer_without_hidden_numbers",
            TrameEvent::ActionResolved {
                resolution: Box::new(resolution.clone()),
            },
            (&t.state, &t.state),
            [Same, ResolutionRedacted, Absent, Absent],
        ),
        (
            "resolution_applied_reaches_gm_and_issuer",
            TrameEvent::ResolutionApplied {
                resolution_id: resolution.id,
                token_ids: vec![t.lurker],
            },
            (&t.state, &with_resolution),
            [Same, Same, Absent, Absent],
        ),
        (
            "resolution_dismissed_reaches_gm_and_issuer",
            TrameEvent::ResolutionDismissed {
                resolution_id: resolution.id,
            },
            (&t.state, &with_resolution),
            [Same, Same, Absent, Absent],
        ),
        (
            "concentration_check_prompts_the_controller_only",
            TrameEvent::ConcentrationCheckRequested {
                token_id: t.hero,
                dc: 10,
            },
            (&t.state, &t.state),
            [Same, Same, Absent, Absent],
        ),
        (
            "monster_concentration_roll_is_gm_only",
            TrameEvent::ConcentrationCheckRolled {
                token_id: t.lurker,
                dc: 12,
                d20_rolls: vec![7],
                total: 9,
                success: false,
            },
            (&t.state, &t.state),
            [Same, Absent, Absent, Absent],
        ),
    ];

    for (case, event, (state, prior), wants) in cases {
        for (recipient, want) in RECIPIENTS.iter().zip(wants) {
            let (user_id, role) = t.recipient(recipient);
            let got = filter_events_for_recipient(
                state,
                prior,
                std::slice::from_ref(&event),
                user_id,
                role,
            );
            assert_eq!(
                got,
                expected(want, &event),
                "case {case}, recipient {recipient}"
            );
        }
    }
}

#[test]
fn token_coming_into_view_hides_where_it_came_from() {
    let t = Table::new();
    let mut prior = t.state.clone();
    prior.data.tokens.get_mut(&t.hero).unwrap().top_left = Point2D::new(1500.0, 400.0);
    let event = TrameEvent::TokenMoved {
        token_id: t.hero,
        from_top_left: Point2D::new(1500.0, 400.0),
        to_top_left: Point2D::new(100.0, 100.0),
        elevation_ft: 0.0,
        speed_remaining_ft: 25.0,
    };
    // (recipient, expected payload)
    let cases = [
        ("gm", Want::Same),
        ("controller", Want::Same),
        ("viewer", Want::NoOrigin),
        ("blind", Want::Absent),
    ];
    for (recipient, want) in cases {
        let (user_id, role) = t.recipient(recipient);
        let mut got = filter_events_for_recipient(
            &t.state,
            &prior,
            std::slice::from_ref(&event),
            user_id,
            role,
        );
        if let Some(TrameEvent::TokenMoved {
            speed_remaining_ft, ..
        }) = got.first_mut()
        {
            *speed_remaining_ft = 25.0;
        }
        assert_eq!(got, expected(want, &event), "recipient {recipient}");
    }
}

// ---------------------------------------------------------------------------
// Snapshot matrix (also what a reconnecting client receives)
// ---------------------------------------------------------------------------

#[test]
fn snapshot_privacy_matrix() {
    let t = Table::new();
    let mut state = t.state.clone();
    let lurker_prompt = t.prompt(t.lurker, None);
    let blind_prompt = t.prompt(t.blind_token, Some(t.blind));
    for p in [&lurker_prompt, &blind_prompt] {
        state
            .data
            .active_reaction_prompts
            .insert(p.prompt_id, p.clone());
    }
    let mut aoe_state = state.clone();
    let aoe_id = Uuid::new_v4();
    let template = AoeTemplate {
        id: aoe_id,
        origin: Point2D::new(100.0, 100.0),
        origin_elevation_ft: 0.0,
        shape: AoeShape::Sphere { radius_ft: 10.0 },
        stops_at_walls: false,
        discretization: GridDiscretizationMode::CenterPoint,
        concentration_caster_id: Some(t.hero),
    };
    aoe_state.data.persistent_aoes.insert(aoe_id, template);

    // (recipient, hero HP sent, hero bloodied tier sent, prompt ids sent, AoE caster sent)
    type Row = (Option<i32>, Option<BloodiedState>, Vec<Uuid>, Option<Uuid>);
    let cases: [(&str, Row); 4] = [
        (
            "gm",
            (
                Some(12),
                None,
                vec![lurker_prompt.prompt_id, blind_prompt.prompt_id],
                Some(t.hero),
            ),
        ),
        ("controller", (Some(12), None, vec![], Some(t.hero))),
        (
            "viewer",
            (None, Some(BloodiedState::Unhurt), vec![], Some(t.hero)),
        ),
        ("blind", (None, None, vec![blind_prompt.prompt_id], None)),
    ];
    for (recipient, (hp, bloodied, prompts, caster)) in cases {
        let (user_id, role) = t.recipient(recipient);
        let view = project_state_for_recipient(Uuid::nil(), &aoe_state, user_id, role);
        assert_eq!(view.tokens.get(&t.hero).map(|h| h.hp), hp, "{recipient} hp");
        assert_eq!(
            view.public_tokens.get(&t.hero).map(|h| h.bloodied),
            bloodied,
            "{recipient} bloodied"
        );
        let mut sent: Vec<Uuid> = view.active_reaction_prompts.keys().copied().collect();
        let mut want = prompts.clone();
        sent.sort();
        want.sort();
        assert_eq!(sent, want, "{recipient} prompts");
        if let Some(p) = view.active_reaction_prompts.get(&blind_prompt.prompt_id)
            && role != CampaignRole::Gm
        {
            assert_eq!(p.pending_destination, None, "{recipient} mover destination");
            assert!(
                p.resolved_reactor_ids.is_empty(),
                "{recipient} other reactors"
            );
        }
        assert_eq!(
            view.persistent_aoes[&aoe_id].concentration_caster_id, caster,
            "{recipient} caster"
        );
    }
}

#[test]
fn snapshot_stat_block_is_gm_only() {
    let t = Table::new();
    let mut state = t.state.clone();
    let stat_block = serde_json::json!({ "name": "Knight", "attackBonus": 5 });
    state.data.tokens.get_mut(&t.hero).unwrap().stat_block = Some(stat_block.clone());
    // (recipient, hero stat block sent in a full token)
    let cases = [
        ("gm", Some(stat_block)),
        ("controller", None),
        ("viewer", None),
        ("blind", None),
    ];
    for (recipient, want) in cases {
        let (user_id, role) = t.recipient(recipient);
        let view = project_state_for_recipient(Uuid::nil(), &state, user_id, role);
        assert_eq!(
            view.tokens.get(&t.hero).and_then(|h| h.stat_block.clone()),
            want,
            "{recipient}"
        );
    }
}

#[test]
fn snapshot_resolution_and_concentration_matrix() {
    let t = Table::new();
    let mut state = t.state.clone();
    let resolution = controller_resolution(&t);
    state
        .data
        .pending_resolutions
        .insert(resolution.id, resolution.clone());
    state
        .data
        .pending_concentration_checks
        .insert(t.hero, vec![10]);
    state
        .data
        .pending_concentration_checks
        .insert(t.lurker, vec![15]);

    // (recipient, resolution sent, lurker target d20s and total sent, hero target d20s sent,
    // concentration check tokens sent)
    type Row = (bool, bool, bool, Vec<Uuid>);
    let mut all_checks = vec![t.hero, t.lurker];
    all_checks.sort();
    let cases: [(&str, Row); 4] = [
        ("gm", (true, true, true, all_checks)),
        ("controller", (true, false, true, vec![t.hero])),
        ("viewer", (false, false, false, vec![])),
        ("blind", (false, false, false, vec![])),
    ];
    for (recipient, (sent, lurker_numbers, hero_numbers, checks)) in cases {
        let (user_id, role) = t.recipient(recipient);
        let view = project_state_for_recipient(Uuid::nil(), &state, user_id, role);
        let seen = view.pending_resolutions.get(&resolution.id);
        assert_eq!(seen.is_some(), sent, "{recipient} resolution");
        if let Some(seen) = seen {
            let lurker = &seen.targets[0];
            assert_eq!(
                lurker.outcome,
                TargetOutcome::Hit,
                "{recipient} outcome kept"
            );
            assert_eq!(lurker.damage, 6, "{recipient} damage kept");
            assert_eq!(
                lurker.total.is_some() && !lurker.d20_rolls.is_empty(),
                lurker_numbers,
                "{recipient} hidden AC bound"
            );
            assert_eq!(
                seen.targets[1].total.is_some(),
                hero_numbers,
                "{recipient} own token numbers"
            );
        }
        let mut sent_checks: Vec<Uuid> =
            view.pending_concentration_checks.keys().copied().collect();
        sent_checks.sort();
        assert_eq!(sent_checks, checks, "{recipient} concentration checks");
    }
}

// ---------------------------------------------------------------------------
// Room-level: initiative privacy, pointer pings, bounded outbound queues
// ---------------------------------------------------------------------------

struct Room {
    handle: TableRoomHandle,
    timeline: mpsc::UnboundedReceiver<TimelineNote>,
}

async fn room() -> Room {
    let (timeline_tx, timeline) = mpsc::unbounded_channel();
    let handle = TableRoomActor::spawn_with_sinks(
        Uuid::new_v4(),
        Arc::new(InMemoryWalStorage::new()),
        25,
        RoomSinks {
            vitals: None,
            timeline: Some(timeline_tx),
        },
    )
    .unwrap();
    Room { handle, timeline }
}

async fn connect(
    room: &TableRoomHandle,
    user_id: Uuid,
    role: CampaignRole,
) -> (Uuid, mpsc::Receiver<OutboundClientFrame>) {
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

fn drain(rx: &mut mpsc::Receiver<OutboundClientFrame>) -> Vec<ServerEnvelope> {
    let mut out = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if let OutboundClientFrame::Binary(bytes) = frame {
            out.push(rmp_serde::from_slice(&bytes).unwrap());
        }
    }
    out
}

/// Names of the tokens whose initiative roll reached a recipient.
fn rolled_names(frames: &[ServerEnvelope]) -> Vec<String> {
    let mut names: Vec<String> = frames
        .iter()
        .filter_map(|f| match f {
            ServerEnvelope::DiceRolled(roll) => {
                Some(roll.reason.trim_start_matches("Initiative: ").to_string())
            }
            _ => None,
        })
        .collect();
    names.sort();
    names
}

fn names(list: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = list.iter().map(|s| s.to_string()).collect();
    v.sort();
    v
}

#[tokio::test]
async fn initiative_rolls_for_unseen_tokens_are_gm_only() {
    // (case_id, wall between the parties, per recipient [gm, controller, viewer, blind] rolls
    // received, GM-only timeline roll records)
    let cases = [
        (
            "everyone_sees_everyone_rolls_are_public",
            false,
            [
                names(&["Blind", "Hero", "Lurker", "Viewer"]),
                names(&["Blind", "Hero", "Viewer"]),
                names(&["Blind", "Hero", "Viewer"]),
                names(&["Blind", "Hero", "Viewer"]),
            ],
            names(&["Lurker"]),
        ),
        (
            "walled_off_player_hides_every_roll_but_their_own",
            true,
            [
                names(&["Blind", "Hero", "Lurker", "Viewer"]),
                names(&["Hero"]),
                names(&["Viewer"]),
                names(&["Blind"]),
            ],
            names(&["Blind", "Hero", "Lurker", "Viewer"]),
        ),
    ];
    for (case, walled, wants, gm_only_records) in cases {
        let t = Table::new();
        let mut r = room().await;
        let gm_actor = CommandActor {
            user_id: t.gm,
            role: CampaignRole::Gm,
        };
        if walled {
            r.handle
                .dispatch_direct_command(
                    gm_actor.clone(),
                    TrameCommand::AddWall {
                        wall: t.state.data.walls[0].clone(),
                    },
                )
                .await
                .unwrap();
        }
        for token in t.state.data.tokens.values() {
            r.handle
                .dispatch_direct_command(
                    gm_actor.clone(),
                    TrameCommand::SpawnToken {
                        token: Box::new(token.clone()),
                    },
                )
                .await
                .unwrap();
        }
        let mut sockets = Vec::new();
        for recipient in RECIPIENTS {
            let (user_id, role) = t.recipient(recipient);
            sockets.push(connect(&r.handle, user_id, role).await.1);
        }
        while r.timeline.try_recv().is_ok() {}
        r.handle
            .dispatch_direct_command(
                gm_actor.clone(),
                TrameCommand::StartTurnByTurn {
                    initiative_order: vec![],
                    initiative_totals: Default::default(),
                },
            )
            .await
            .unwrap();
        for ((recipient, rx), want) in RECIPIENTS.iter().zip(&mut sockets).zip(&wants) {
            assert_eq!(
                &rolled_names(&drain(rx)),
                want,
                "case {case}, recipient {recipient}"
            );
        }
        let mut gm_only = Vec::new();
        while let Ok(note) = r.timeline.try_recv() {
            if note.event_type == "dice_roll" && note.payload["visibility"] == "gm" {
                let reason = note.payload["reason"].as_str().unwrap_or_default();
                gm_only.push(reason.trim_start_matches("Initiative: ").to_string());
            }
        }
        gm_only.sort();
        assert_eq!(gm_only, gm_only_records, "case {case}: timeline");
        assert_eq!(
            r.handle.get_table_snapshot().await.unwrap().1.data.mode,
            TableMode::TurnByTurn,
            "case {case}"
        );
    }
}

#[tokio::test]
async fn pointer_pings_are_validated_and_throttled() {
    let r = room().await;
    let gm_id = Uuid::new_v4();
    let (gm_session, mut gm_rx) = connect(&r.handle, gm_id, CampaignRole::Gm).await;
    let (_, mut player_rx) = connect(&r.handle, Uuid::new_v4(), CampaignRole::Player).await;
    let scene_id = Uuid::new_v4();
    r.handle
        .dispatch_direct_command(
            CommandActor {
                user_id: gm_id,
                role: CampaignRole::Gm,
            },
            TrameCommand::LoadScene {
                scene_id,
                map_asset_id: "map".to_string(),
                width_px: 1000,
                height_px: 800,
                pixels_per_grid: 100.0,
                walls: vec![],
            },
        )
        .await
        .unwrap();
    drain(&mut gm_rx);
    drain(&mut player_rx);

    let ping = |x: f64, y: f64, color: &str, scene: Option<Uuid>| ClientEnvelope::PointerPing {
        pos: Point2D::new(x, y),
        color_hex: color.to_string(),
        scene_id: scene,
    };
    // (case_id, ping, wait before sending (ms), expected Ok(broadcast) / Err(rejection fragment)
    // / None (dropped silently))
    let cases: Vec<(&str, ClientEnvelope, u64, Option<Result<(), &str>>)> = vec![
        (
            "hex_color_on_the_active_scene",
            ping(10.0, 20.0, "#D57973", Some(scene_id)),
            0,
            Some(Ok(())),
        ),
        (
            "second_ping_inside_the_window_is_dropped",
            ping(10.0, 20.0, "#D57973", None),
            0,
            None,
        ),
        (
            "atlas_token_color_without_scene",
            ping(999.0, 799.0, "var(--atlas-info)", None),
            300,
            Some(Ok(())),
        ),
        (
            "nan_coordinate",
            ping(f64::NAN, 20.0, "#fff", None),
            300,
            Some(Err("position")),
        ),
        (
            "infinite_coordinate",
            ping(10.0, f64::INFINITY, "#fff", None),
            0,
            Some(Err("position")),
        ),
        (
            "negative_coordinate",
            ping(-1.0, 20.0, "#fff", None),
            0,
            Some(Err("position")),
        ),
        (
            "beyond_the_map",
            ping(1001.0, 20.0, "#fff", None),
            0,
            Some(Err("position")),
        ),
        (
            "stale_scene",
            ping(10.0, 20.0, "#fff", Some(Uuid::new_v4())),
            0,
            Some(Err("scene")),
        ),
        (
            "css_injection_color",
            ping(10.0, 20.0, "red;background:url(x)", None),
            0,
            Some(Err("color")),
        ),
        (
            "bad_hex_length",
            ping(10.0, 20.0, "#12345", None),
            0,
            Some(Err("color")),
        ),
        (
            "oversized_token_color",
            ping(10.0, 20.0, &format!("var(--{})", "a".repeat(60)), None),
            0,
            Some(Err("color")),
        ),
    ];
    for (case, envelope, wait_ms, want) in cases {
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        r.handle.send_envelope(gm_session, envelope).await.unwrap();
        let sender = drain(&mut gm_rx);
        let other = drain(&mut player_rx);
        let broadcast = |frames: &[ServerEnvelope]| {
            frames
                .iter()
                .any(|f| matches!(f, ServerEnvelope::PointerPingBroadcast { .. }))
        };
        match want {
            Some(Ok(())) => {
                assert!(broadcast(&sender) && broadcast(&other), "case {case}");
            }
            Some(Err(fragment)) => {
                assert!(!broadcast(&other), "case {case}: not broadcast");
                let reason = sender.iter().find_map(|f| match f {
                    ServerEnvelope::CommandRejected { reason, .. } => Some(reason.clone()),
                    _ => None,
                });
                assert!(
                    reason.as_deref().is_some_and(|r| r.contains(fragment)),
                    "case {case}: {reason:?}"
                );
            }
            None => assert!(sender.is_empty() && other.is_empty(), "case {case}"),
        }
    }
}

#[tokio::test]
async fn slow_consumer_overflow_spares_the_other_clients() {
    let r = room().await;
    let gm_id = Uuid::new_v4();
    let (slow_tx, slow_rx) = client_channel_with_capacity(3);
    let overflow = slow_tx.overflow_signal();
    r.handle
        .connect_client(ConnectedClient {
            session_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            role: CampaignRole::Player,
            tx: slow_tx,
        })
        .await
        .unwrap();
    let (_, mut fast_rx) = connect(&r.handle, gm_id, CampaignRole::Gm).await;
    drain(&mut fast_rx);

    // (case_id, commands submitted, frames the slow queue still holds, overflow signalled)
    let cases = [
        ("within_capacity", 2, 3, false),
        ("past_capacity", 4, 3, true),
    ];
    let mut submitted = 0;
    let mut delivered = 0;
    for (case, total, held, signalled) in cases {
        while submitted < total {
            let id = Uuid::new_v4();
            r.handle
                .dispatch_direct_command(
                    CommandActor {
                        user_id: gm_id,
                        role: CampaignRole::Gm,
                    },
                    TrameCommand::SpawnToken {
                        token: Box::new(TokenState::new_default(
                            id,
                            "Goblin",
                            Point2D::new(0.0, 0.0),
                        )),
                    },
                )
                .await
                .unwrap();
            submitted += 1;
        }
        assert_eq!(
            slow_rx.len(),
            held,
            "case {case}: snapshot + accepted frames held"
        );
        let fired = tokio::time::timeout(Duration::from_millis(50), overflow.notified())
            .await
            .is_ok();
        assert_eq!(fired, signalled, "case {case}: overflow signal");
        let accepted = drain(&mut fast_rx)
            .iter()
            .filter(|f| matches!(f, ServerEnvelope::CommandAccepted { .. }))
            .count();
        assert_eq!(accepted, total - delivered, "case {case}: GM unaffected");
        delivered = total;
    }
}
