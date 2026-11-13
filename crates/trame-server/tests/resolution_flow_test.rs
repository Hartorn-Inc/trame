//! ============================================================================
//! SERVER-ROLLED ACTION RESOLUTION FLOW (resolution_flow_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Drives `ResolveAction`, `ApplyResolution` and `RollConcentrationCheck`
//!   through a real `TableRoomActor` (in-memory WAL) to pin decision D6 and
//!   story 58: the server rolls against hidden AC and save bonuses, the issuer
//!   only learns outcomes and damage, Apply is exactly-once, and the pending
//!   resolution survives a WAL replay with the same rolls.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Outcomes are made deterministic with flat damage and extreme bonuses
//!     (`+30` / `-10`) instead of seeding the CSPRNG.
//!   - Every table-driven case carries a descriptive id printed on failure.
//! ============================================================================

use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use trame_engine::commands::{
    CampaignRole, CommandActor, TableState, TokenState, TrameCommand, TrameEvent,
};
use trame_engine::cover::CoverLevel;
use trame_engine::geometry::{CHANNEL_GM_HIDDEN, Point2D};
use trame_engine::resolution::{
    ActionRequest, ActionTargetRequest, ConcentrationRoll, DamageComponentRequest,
    PendingResolution, ResolutionAdjustment, ResolutionCheck, ResolvedTarget, RollMode,
    TargetOutcome,
};
use trame_engine::rules::DamageAffinity;
use trame_server::room::{
    ConnectedClient, OutboundClientFrame, TableRoomActor, TableRoomHandle, client_channel,
};
use trame_server::sync::ServerEnvelope;
use trame_server::wal::InMemoryWalStorage;
use uuid::Uuid;

struct Room {
    handle: TableRoomHandle,
    wal: Arc<InMemoryWalStorage>,
    campaign_id: Uuid,
    gm: CommandActor,
    player: CommandActor,
    other: CommandActor,
    hero: Uuid,
    goblin: Uuid,
    lurker: Uuid,
}

fn actor(role: CampaignRole) -> CommandActor {
    CommandActor {
        user_id: Uuid::new_v4(),
        role,
    }
}

/// Hero (player-owned, adjacent to the goblin), goblin (GM, AC 15, stat block with
/// `dex` save `+30` and `con` save `-10`), and a GM-hidden lurker.
async fn room() -> Room {
    let campaign_id = Uuid::new_v4();
    let wal = Arc::new(InMemoryWalStorage::new());
    let handle = TableRoomActor::spawn(campaign_id, wal.clone(), 25).unwrap();
    let gm = actor(CampaignRole::Gm);
    let player = actor(CampaignRole::Player);
    let other = actor(CampaignRole::Player);
    let mut tokens = Vec::new();
    let mut hero = TokenState::new_default(Uuid::new_v4(), "Hero", Point2D::new(0.0, 0.0));
    hero.owner_user_id = Some(player.user_id);
    let mut goblin = TokenState::new_default(Uuid::new_v4(), "Goblin", Point2D::new(100.0, 0.0));
    goblin.stat_block = Some(json!({
        "name": "Goblin",
        "size": "small",
        "armorClass": { "value": 15 },
        "hitPoints": { "average": 20 },
        "speed": { "walk": 30 },
        "abilities": { "str": 8, "dex": 14, "con": 10, "int": 10, "wis": 8, "cha": 8 },
        "savingThrows": { "dex": 30, "con": -10 }
    }));
    let mut lurker = TokenState::new_default(Uuid::new_v4(), "Lurker", Point2D::new(300.0, 0.0));
    lurker.visibility_channel |= CHANNEL_GM_HIDDEN;
    let ids = (hero.id, goblin.id, lurker.id);
    tokens.extend([hero, goblin, lurker]);
    for token in tokens {
        handle
            .dispatch_direct_command(
                gm.clone(),
                TrameCommand::SpawnToken {
                    token: Box::new(token),
                },
            )
            .await
            .unwrap();
    }
    Room {
        handle,
        wal,
        campaign_id,
        gm,
        player,
        other,
        hero: ids.0,
        goblin: ids.1,
        lurker: ids.2,
    }
}

async fn connect(
    room: &TableRoomHandle,
    who: &CommandActor,
) -> mpsc::Receiver<OutboundClientFrame> {
    let (tx, rx) = client_channel();
    room.connect_client(ConnectedClient {
        session_id: Uuid::new_v4(),
        user_id: who.user_id,
        role: who.role,
        tx,
    })
    .await
    .unwrap();
    rx
}

fn drain_events(rx: &mut mpsc::Receiver<OutboundClientFrame>) -> Vec<TrameEvent> {
    let mut out = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if let OutboundClientFrame::Binary(bytes) = frame
            && let Ok(ServerEnvelope::CommandAccepted { events, .. }) =
                rmp_serde::from_slice(&bytes)
        {
            out.extend(events);
        }
    }
    out
}

fn request(
    attacker: Option<Uuid>,
    check: ResolutionCheck,
    damage_dice: &str,
    damage_modifier: i32,
    targets: &[Uuid],
) -> ActionRequest {
    ActionRequest {
        resolution_id: Uuid::new_v4(),
        attacker_token_id: attacker,
        action_name: "Test action".to_string(),
        check,
        damage_dice: damage_dice.to_string(),
        damage_modifier,
        damage_type: None,
        extra_damage: Vec::new(),
        targets: targets
            .iter()
            .map(|id| ActionTargetRequest {
                token_id: *id,
                roll_mode: RollMode::Normal,
                cover: CoverLevel::None,
            })
            .collect(),
    }
}

/// A client-forged result the room must discard.
fn forged(request: &ActionRequest, issuer: Uuid) -> PendingResolution {
    PendingResolution {
        id: request.resolution_id,
        issuer_user_id: issuer,
        attacker_token_id: request.attacker_token_id,
        action_name: request.action_name.clone(),
        check: request.check.clone(),
        damage_type: None,
        damage_expression: "999".to_string(),
        extra_damage: Vec::new(),
        targets: request
            .targets
            .iter()
            .map(|t| ResolvedTarget {
                token_id: t.token_id,
                roll_mode: RollMode::Normal,
                outcome: TargetOutcome::Critical,
                d20_rolls: vec![20],
                total: Some(99),
                damage: 999,
                extra_damage: vec![999],
                is_critical: true,
                applied: false,
            })
            .collect(),
        sequence: 0,
    }
}

async fn resolve(
    room: &Room,
    who: &CommandActor,
    request: ActionRequest,
) -> Result<PendingResolution, String> {
    let resolution = Some(Box::new(forged(&request, who.user_id)));
    let (_, events) = room
        .handle
        .dispatch_direct_command(
            who.clone(),
            TrameCommand::ResolveAction {
                request: Box::new(request),
                resolution,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    match events.as_slice() {
        [TrameEvent::ActionResolved { resolution }] => Ok(*resolution.clone()),
        other => panic!("unexpected events {other:?}"),
    }
}

async fn state(room: &Room) -> TableState {
    room.handle.get_table_snapshot().await.unwrap().1
}

fn attack(bonus: i32) -> ResolutionCheck {
    ResolutionCheck::Attack {
        attack_bonus: bonus,
        critical_range: 20,
    }
}

fn save(ability: &str, dc: i32, half_on_success: bool) -> ResolutionCheck {
    ResolutionCheck::Save {
        ability: ability.to_string(),
        dc,
        half_on_success,
    }
}

#[tokio::test]
async fn player_attack_against_hidden_ac_is_server_rolled_and_redacted() {
    let r = room().await;
    let mut player_rx = connect(&r.handle, &r.player).await;
    let mut gm_rx = connect(&r.handle, &r.gm).await;
    let mut other_rx = connect(&r.handle, &r.other).await;
    drain_events(&mut player_rx);
    drain_events(&mut gm_rx);
    drain_events(&mut other_rx);

    let resolution = resolve(
        &r,
        &r.player,
        request(Some(r.hero), attack(5), "1d6", 2, &[r.goblin]),
    )
    .await
    .unwrap();
    let target = &resolution.targets[0];
    let natural = target.d20_rolls[0];
    // The forged critical / 999 damage was discarded; the server's numbers are consistent.
    let expected_outcome = match natural {
        1 => TargetOutcome::Miss,
        20 => TargetOutcome::Critical,
        n if i32::from(n) + 5 >= 15 => TargetOutcome::Hit,
        _ => TargetOutcome::Miss,
    };
    assert_eq!(
        target.outcome, expected_outcome,
        "server_compares_with_ac_15"
    );
    assert_eq!(target.total, Some(i32::from(natural) + 5), "server_total");
    let damage_range = match target.outcome {
        TargetOutcome::Hit => 3..=8,
        TargetOutcome::Critical => 4..=14,
        _ => 0..=0,
    };
    assert!(
        damage_range.contains(&target.damage),
        "damage {}",
        target.damage
    );
    assert_eq!(resolution.damage_expression, "1d6+2");

    // (recipient, gets the event, sees d20 and total)
    let cases = [
        ("issuer_sees_outcome_only", &mut player_rx, true, false),
        ("gm_sees_everything", &mut gm_rx, true, true),
        ("other_player_gets_nothing", &mut other_rx, false, false),
    ];
    for (id, rx, gets, sees_numbers) in cases {
        let events = drain_events(rx);
        let resolved: Vec<&PendingResolution> = events
            .iter()
            .filter_map(|e| match e {
                TrameEvent::ActionResolved { resolution } => Some(resolution.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(!resolved.is_empty(), gets, "{id}");
        if let Some(seen) = resolved.first() {
            let t = &seen.targets[0];
            assert_eq!(t.outcome, target.outcome, "{id}");
            assert_eq!(t.damage, target.damage, "{id}");
            assert_eq!(!t.d20_rolls.is_empty(), sees_numbers, "{id}: d20");
            assert_eq!(t.total.is_some(), sees_numbers, "{id}: total");
        }
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, TrameEvent::DamageApplied { .. })),
            "{id}: resolving applies nothing"
        );
    }
}

#[tokio::test]
async fn saves_use_the_server_side_bonus_and_save_for_half() {
    // (case_id, check, goblin conditions, expected outcome, expected damage of a flat 10)
    let cases = [
        (
            "dex_save_plus_30_always_succeeds_half",
            save("dex", 30, true),
            vec![],
            TargetOutcome::SaveSuccess,
            5,
        ),
        (
            "success_without_half_negates",
            save("dex", 30, false),
            vec![],
            TargetOutcome::SaveSuccess,
            0,
        ),
        (
            "con_save_minus_10_always_fails",
            save("con", 30, true),
            vec![],
            TargetOutcome::SaveFailure,
            10,
        ),
        (
            "paralyzed_fails_dex_automatically",
            save("dex", 30, true),
            vec!["paralyzed".to_string()],
            TargetOutcome::SaveFailure,
            10,
        ),
    ];
    for (id, check, conditions, outcome, damage) in cases {
        let r = room().await;
        if !conditions.is_empty() {
            r.handle
                .dispatch_direct_command(
                    r.gm.clone(),
                    TrameCommand::SetTokenConditions {
                        token_id: r.goblin,
                        conditions,
                    },
                )
                .await
                .unwrap();
        }
        let resolution = resolve(
            &r,
            &r.player,
            request(Some(r.hero), check, "", 10, &[r.goblin]),
        )
        .await
        .unwrap_or_else(|e| panic!("{id}: {e}"));
        let target = &resolution.targets[0];
        assert_eq!(target.outcome, outcome, "{id}");
        assert_eq!(target.damage, damage, "{id}");
    }
}

fn part(dice: &str, modifier: i32, damage_type: &str) -> DamageComponentRequest {
    DamageComponentRequest {
        dice: dice.to_string(),
        modifier,
        damage_type: Some(damage_type.to_string()),
    }
}

#[tokio::test]
async fn every_damage_part_is_rolled_with_its_own_type() {
    // (case_id, check, extra parts, expected primary damage, expected extra damage)
    let cases = [
        (
            "automatic_rolls_every_part",
            ResolutionCheck::Automatic,
            vec![part("", 7, "fire"), part("", 3, "poison")],
            10,
            vec![7, 3],
        ),
        (
            "save_for_half_halves_each_part",
            save("dex", 30, true),
            vec![part("", 7, "fire")],
            5,
            vec![3],
        ),
        (
            "failed_save_keeps_each_part",
            save("con", 30, true),
            vec![part("", 7, "fire")],
            10,
            vec![7],
        ),
    ];
    for (id, check, extra, damage, extra_damage) in cases {
        let r = room().await;
        let mut req = request(None, check, "", 10, &[r.goblin]);
        req.damage_type = Some("slashing".to_string());
        req.extra_damage = extra.clone();
        let resolution = resolve(&r, &r.gm, req)
            .await
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        let target = &resolution.targets[0];
        assert_eq!(target.damage, damage, "{id}: primary");
        assert_eq!(target.extra_damage, extra_damage, "{id}: extra parts");
        let types: Vec<Option<&str>> = resolution
            .extra_damage
            .iter()
            .map(|p| p.damage_type.as_deref())
            .collect();
        let wanted: Vec<Option<&str>> = extra.iter().map(|p| p.damage_type.as_deref()).collect();
        assert_eq!(types, wanted, "{id}: part types");
    }
}

#[tokio::test]
async fn invalid_damage_parts_are_rejected() {
    let r = room().await;
    // (case_id, extra parts)
    let cases = [
        ("unknown_part_type", vec![part("1d6", 0, "laser")]),
        ("part_dice_out_of_bounds", vec![part("100d6", 0, "fire")]),
        ("part_modifier_out_of_bounds", vec![part("", 51, "fire")]),
        ("more_than_three_parts", vec![part("1d4", 0, "fire"); 4]),
    ];
    for (id, extra) in cases {
        let mut req = request(None, ResolutionCheck::Automatic, "1d6", 0, &[r.goblin]);
        req.extra_damage = extra;
        let result = resolve(&r, &r.gm, req).await;
        assert!(result.is_err(), "{id}: {result:?}");
    }
}

#[tokio::test]
async fn invalid_requests_are_rejected_before_rolling() {
    let r = room().await;
    let unknown = Uuid::new_v4();
    // (case_id, issuer, request)
    let cases = [
        (
            "player_cannot_probe_a_hidden_token",
            r.player.clone(),
            request(Some(r.hero), attack(5), "1d6", 0, &[r.lurker]),
        ),
        (
            "player_cannot_attack_with_an_unowned_token",
            r.other.clone(),
            request(Some(r.hero), attack(5), "1d6", 0, &[r.goblin]),
        ),
        (
            "attack_bonus_out_of_bounds",
            r.player.clone(),
            request(Some(r.hero), attack(31), "1d6", 0, &[r.goblin]),
        ),
        (
            "damage_dice_out_of_bounds",
            r.player.clone(),
            request(Some(r.hero), attack(5), "100d6", 0, &[r.goblin]),
        ),
        (
            "duplicate_targets",
            r.player.clone(),
            request(Some(r.hero), attack(5), "1d6", 0, &[r.goblin, r.goblin]),
        ),
        (
            "unknown_target",
            r.gm.clone(),
            request(None, attack(5), "1d6", 0, &[unknown]),
        ),
        (
            "save_dc_out_of_bounds",
            r.gm.clone(),
            request(None, save("dex", 31, true), "1d6", 0, &[r.goblin]),
        ),
    ];
    for (id, who, req) in cases {
        let result = resolve(&r, &who, req).await;
        assert!(result.is_err(), "{id}: {result:?}");
    }
    assert!(state(&r).await.data.pending_resolutions.is_empty());

    let batch = r
        .handle
        .dispatch_batch(
            r.gm.clone(),
            vec![TrameCommand::ResolveAction {
                request: Box::new(request(
                    None,
                    ResolutionCheck::Automatic,
                    "",
                    3,
                    &[r.goblin],
                )),
                resolution: None,
            }],
            "batched".to_string(),
        )
        .await;
    assert!(batch.is_err(), "server_rolled_commands_cannot_be_batched");
}

#[tokio::test]
async fn apply_is_exactly_once_and_survives_wal_replay() {
    let r = room().await;
    let resolution = resolve(
        &r,
        &r.player,
        request(Some(r.hero), ResolutionCheck::Automatic, "", 4, &[r.goblin]),
    )
    .await
    .unwrap();
    let apply = |token_id: Option<Uuid>, adjustment: Option<ResolutionAdjustment>| {
        TrameCommand::ApplyResolution {
            resolution_id: resolution.id,
            token_id,
            adjustment,
        }
    };

    // A respawned room on the same WAL replays the stored, server-filled command.
    let replayed = TableRoomActor::spawn(r.campaign_id, r.wal.clone(), 25).unwrap();
    let replayed_state = replayed.get_table_snapshot().await.unwrap().1;
    assert_eq!(
        replayed_state.data.pending_resolutions.get(&resolution.id),
        state(&r).await.data.pending_resolutions.get(&resolution.id),
        "replay_restores_the_same_rolls"
    );

    // (case_id, actor, command, accepted, goblin HP after)
    let cases = [
        (
            "other_player_cannot_apply",
            r.other.clone(),
            apply(None, None),
            false,
            20,
        ),
        (
            "issuer_cannot_adjust",
            r.player.clone(),
            apply(
                Some(r.goblin),
                Some(ResolutionAdjustment {
                    damage: Some(1),
                    ..Default::default()
                }),
            ),
            false,
            20,
        ),
        (
            "gm_adjustment_type_must_be_srd",
            r.gm.clone(),
            apply(
                None,
                Some(ResolutionAdjustment {
                    damage_type: Some("laser".to_string()),
                    ..Default::default()
                }),
            ),
            false,
            20,
        ),
        (
            "issuer_applies_as_rolled",
            r.player.clone(),
            apply(None, None),
            true,
            16,
        ),
        (
            "second_apply_is_refused",
            r.gm.clone(),
            apply(None, None),
            false,
            16,
        ),
    ];
    for (id, who, command, accepted, hp) in cases {
        let result = r.handle.dispatch_direct_command(who, command).await;
        assert_eq!(result.is_ok(), accepted, "{id}: {result:?}");
        assert_eq!(state(&r).await.data.tokens[&r.goblin].hp, hp, "{id}");
    }
    assert!(state(&r).await.data.pending_resolutions.is_empty());
}

#[test]
fn sheet_save_bonuses_follow_the_sheet_shape() {
    // (case_id, sheet, expected [str, dex, con] bonuses or None)
    let cases = [
        (
            "character_sheet_adds_proficiency_by_level_minus_exhaustion",
            json!({
                "attributes": { "level": 5, "exhaustion": 1 },
                "abilities": {
                    "str": { "score": 16, "saveProficiency": true },
                    "dex": { "score": 12, "saveProficiency": false },
                    "con": { "score": 14, "saveProficiency": true }
                }
            }),
            Some([4, -1, 3]),
        ),
        (
            "flat_sheet_uses_save_proficiencies_map",
            json!({
                "level": 1,
                "abilities": { "str": 8, "dex": 18, "con": 10 },
                "saveProficiencies": { "dex": true }
            }),
            Some([-1, 6, 0]),
        ),
        (
            "stat_block_uses_printed_saves_then_scores",
            json!({ "statBlock": { "abilities": { "str": 20, "dex": 9, "con": 12 }, "savingThrows": { "con": 7 } } }),
            Some([5, -1, 7]),
        ),
        (
            "scores_are_clamped_to_30",
            json!({ "abilities": { "str": { "score": 99 } } }),
            Some([10, 0, 0]),
        ),
        (
            "no_abilities_keeps_token_bonuses",
            json!({ "name": "Note" }),
            None,
        ),
        (
            "level_6_paladin_cha_16_gets_aura_of_protection_from_derived_saves",
            json!({
                "attributes": { "level": 6 },
                "abilities": {
                    "str": { "score": 10, "saveProficiency": false },
                    "dex": { "score": 10, "saveProficiency": false },
                    "con": { "score": 10, "saveProficiency": false },
                    "cha": { "score": 16, "saveProficiency": true }
                },
                "derived": { "savingThrows": { "str": 3, "dex": 3, "con": 3, "cha": 9 } }
            }),
            Some([3, 3, 3]),
        ),
        (
            "derived_saves_are_clamped_and_non_numbers_fall_back",
            json!({
                "abilities": { "str": { "score": 10 }, "dex": { "score": 14 }, "con": { "score": 10 } },
                "derived": { "savingThrows": { "str": 99, "dex": "high", "con": -50 } }
            }),
            Some([30, 2, -10]),
        ),
    ];
    for (id, sheet, expected) in cases {
        let bonuses = trame_server::campaigns::tactical_sync_from_sheet(None, &sheet).save_bonuses;
        let got = bonuses.map(|b| [b["str"], b["dex"], b["con"]]);
        assert_eq!(got, expected, "{id}");
    }
}

#[test]
fn active_feature_resistances_reach_the_token() {
    // (case_id, sheet, damage type, raw damage, HP lost)
    let rage = json!({ "featureRules": { "resistances": ["bludgeoning", "piercing", "slashing"] } });
    let cases = [
        (
            "raging_barbarian_halves_slashing",
            json!({ "derived": rage }),
            "slashing",
            11,
            5,
        ),
        (
            "rage_ended_takes_full_slashing",
            json!({ "derived": { "featureRules": { "resistances": [] } } }),
            "slashing",
            11,
            11,
        ),
        (
            "rage_does_not_resist_fire",
            json!({ "derived": rage }),
            "fire",
            11,
            11,
        ),
        (
            "rage_and_sheet_vulnerability_apply_in_order",
            json!({ "damageMitigations": { "slashing": "VULNERABLE" }, "derived": rage }),
            "slashing",
            25,
            24,
        ),
        (
            "unknown_feature_damage_types_are_ignored",
            json!({ "derived": { "featureRules": { "resistances": ["laser", "Slashing "] } } }),
            "slashing",
            11,
            5,
        ),
    ];
    for (id, sheet, damage_type, raw, lost) in cases {
        let gm = actor(CampaignRole::Gm);
        let mut barbarian =
            TokenState::new_default(Uuid::new_v4(), "Barbarian", Point2D::new(0.0, 0.0));
        barbarian.max_hp = 60;
        barbarian.hp = 60;
        trame_server::campaigns::tactical_sync_from_sheet(None, &sheet)
            .apply_to_token(&mut barbarian, trame_engine::commands::TableMode::Exploration);
        let token_id = barbarian.id;
        let mut table = TableState::new(100.0, 5.0, Vec::new());
        table.data.tokens.insert(token_id, barbarian);
        table
            .apply_command(
                &gm,
                TrameCommand::ApplyDamage {
                    token_id,
                    raw_damage: raw,
                    affinity: DamageAffinity::Normal,
                    is_critical: false,
                    damage_type: Some(damage_type.to_string()),
                },
            )
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(60 - table.data.tokens[&token_id].hp, lost, "{id}");
    }
}

#[tokio::test]
async fn concentration_check_is_prompted_and_server_rolled() {
    // (case_id, hero CON save bonus, damage taken, concentration holds)
    let cases = [
        ("bonus_plus_30_always_holds", 30, 40, true),
        ("bonus_minus_10_vs_dc_20_always_breaks", -10, 40, false),
    ];
    for (id, bonus, damage, holds) in cases {
        let r = room().await;
        let mut sheet = TokenState::new_default(r.hero, "Hero", Point2D::new(0.0, 0.0));
        sheet.owner_user_id = Some(r.player.user_id);
        sheet.hp = 60;
        sheet.max_hp = 60;
        sheet.concentrating = true;
        sheet.save_bonuses = BTreeMap::from([("con".to_string(), bonus)]);
        r.handle
            .dispatch_direct_command(r.gm.clone(), TrameCommand::RemoveToken { token_id: r.hero })
            .await
            .unwrap();
        r.handle
            .dispatch_direct_command(
                r.gm.clone(),
                TrameCommand::SpawnToken {
                    token: Box::new(sheet),
                },
            )
            .await
            .unwrap();
        let mut player_rx = connect(&r.handle, &r.player).await;
        let mut other_rx = connect(&r.handle, &r.other).await;
        drain_events(&mut player_rx);
        drain_events(&mut other_rx);
        r.handle
            .dispatch_direct_command(
                r.gm.clone(),
                TrameCommand::ApplyDamage {
                    token_id: r.hero,
                    raw_damage: damage,
                    affinity: DamageAffinity::Normal,
                    is_critical: false,
                    damage_type: None,
                },
            )
            .await
            .unwrap();
        let prompted = |events: &[TrameEvent]| {
            events
                .iter()
                .any(|e| matches!(e, TrameEvent::ConcentrationCheckRequested { dc: 20, .. }))
        };
        assert!(
            prompted(&drain_events(&mut player_rx)),
            "{id}: controller prompted"
        );
        assert!(
            !prompted(&drain_events(&mut other_rx)),
            "{id}: other player not prompted"
        );

        let (_, events) = r
            .handle
            .dispatch_direct_command(
                r.player.clone(),
                TrameCommand::RollConcentrationCheck {
                    token_id: r.hero,
                    roll_mode: RollMode::Normal,
                    // Forged: the room replaces it with its own roll.
                    roll: Some(ConcentrationRoll {
                        d20_rolls: vec![20],
                        total: 99,
                    }),
                },
            )
            .await
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        let success = events.iter().find_map(|e| match e {
            TrameEvent::ConcentrationCheckRolled { success, total, .. } => Some((*success, *total)),
            _ => None,
        });
        assert!(
            matches!(success, Some((s, t)) if s == holds && t != 99),
            "{id}: {success:?}"
        );
        let after = state(&r).await;
        assert_eq!(after.data.tokens[&r.hero].concentrating, holds, "{id}");
        assert!(after.data.pending_concentration_checks.is_empty(), "{id}");
    }
}

#[tokio::test]
async fn hits_within_5_ft_on_a_downed_hero_are_critical_and_add_two_failures() {
    // (case_id, attacker is adjacent (goblin) or 15 ft away (lurker), outcome, failures added)
    let cases = [
        (
            "adjacent_attacker_scores_a_critical",
            true,
            TargetOutcome::Critical,
            2,
        ),
        (
            "attacker_15_ft_away_only_hits",
            false,
            TargetOutcome::Hit,
            1,
        ),
    ];
    for (id, adjacent, outcome, failures) in cases {
        let r = room().await;
        let hp = state(&r).await.data.tokens[&r.hero].hp;
        r.handle
            .dispatch_direct_command(
                r.gm.clone(),
                TrameCommand::ApplyDamage {
                    token_id: r.hero,
                    raw_damage: hp,
                    affinity: DamageAffinity::Normal,
                    is_critical: false,
                    damage_type: None,
                },
            )
            .await
            .unwrap();
        let downed = state(&r).await.data.tokens[&r.hero].clone();
        assert_eq!(
            (downed.hp, downed.conditions.clone()),
            (0, vec!["unconscious".to_string()]),
            "{id}: 0 HP adds unconscious"
        );

        let attacker = if adjacent { r.goblin } else { r.lurker };
        // Natural 1 and 20 decide the outcome on their own; reroll until the d20 is 2..=19.
        let resolution = loop {
            let resolution = resolve(
                &r,
                &r.gm,
                request(Some(attacker), attack(30), "", 4, &[r.hero]),
            )
            .await
            .unwrap();
            if (2..=19).contains(&resolution.targets[0].d20_rolls[0]) {
                break resolution;
            }
        };
        assert_eq!(resolution.targets[0].outcome, outcome, "{id}: outcome");
        r.handle
            .dispatch_direct_command(
                r.gm.clone(),
                TrameCommand::ApplyResolution {
                    resolution_id: resolution.id,
                    token_id: None,
                    adjustment: None,
                },
            )
            .await
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(
            state(&r).await.data.tokens[&r.hero].death_save_failures,
            failures,
            "{id}: death save failures"
        );
    }
}
