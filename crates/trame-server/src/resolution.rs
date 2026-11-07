//! ============================================================================
//! SERVER-ROLLED ACTION RESOLUTION & HIDDEN-STAT TRUST BOUNDARY (resolution.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Decision D6 needs a target's Armor Class or saving throw bonus to decide a
//! hit or a save, and a player never sees those numbers for a monster (G5,
//! story 47). Before this module the client asked the player to rule the
//! outcome, which dead-ended every player-vs-monster attack. Here the room
//! rolls the d20s and the damage with its CSPRNG, compares them to the
//! target's server-side numbers, and fills `ResolveAction.resolution` before
//! the engine stores it as a `PendingResolution`. The room does the same for
//! `RollConcentrationCheck` with the token's Constitution save bonus.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Trust Boundary (what the client may say)`:
//!      - From the issuer: the attack bonus and critical range (their own
//!        sheet or, for the GM, the monster's stat block), the save DC, the
//!        damage dice, modifier and type, the accepted cover, and each
//!        target's advantage state for attack rolls (the attacker's own
//!        conditions and features). Every number is bounded below; the
//!        ability scores behind them are already bounded when sheets are
//!        stored (`campaigns::ABILITY_SCORES`). A save's roll mode comes from
//!        the client only when the issuer is the GM or controls the target.
//!      - From the server only: every d20 and damage die, the target's AC,
//!        its save bonus (`server_save_bonus`), automatic failures, the
//!        Restrained disadvantage, and the automatic critical hit
//!        (Paralyzed / Unconscious within 5 ft, by `token_distance_ft`, never
//!        when the attacker has no token on the table).
//!   2. `Targets The Issuer Can See`:
//!      - A player may only target tokens in their projection
//!        (`visible_token_ids_for_recipient`), so a hidden token's id cannot
//!        be probed for hit / miss.
//!   3. `Crit Doubles Dice Only`:
//!      - `damage_expression` doubles every dice count on a critical hit; the
//!        flat modifier is added once.
//!   4. `Every Damage Part Keeps Its Type`:
//!      - `extra_damage` parts (`1d8 slashing + 2d6 fire`) are rolled, doubled
//!        on a critical hit and halved on a save one by one, so the engine
//!        applies the target's affinity to each type when the damage lands.
//!   5. `Nothing Leaves Through The Dice Log`:
//!      - Resolution rolls are not fanned out as `DiceRolled`; the outcome
//!        reaches clients only through `ActionResolved` and the projection,
//!        which `sync.rs` redacts per recipient.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `fill_action_resolution(state, actor, request, roller)`
//!     ├── 1. Validate name, check, dice, type, targets (count, distinct, visible).
//!     ├── 2. Attack: per target d20 (mode) + bonus vs AC + cover -> outcome,
//!     │      damage rolled per hit (doubled dice on a critical hit).
//!     ├── 3. Save: damage rolled once; per target auto-fail or d20 + server
//!     │      save bonus (+ cover on Dexterity) vs DC -> full / half / none.
//!     └── 4. Automatic: damage rolled once, every target hit.
//! ============================================================================

use crate::dice::{DiceRollOutcome, RollVisibility, SeededDiceRoller};
use crate::statblock::DAMAGE_TYPES;
use crate::sync::visible_token_ids_for_recipient;
use serde_json::Value;
use trame_engine::commands::{CampaignRole, CommandActor, TableState, TokenState};
use trame_engine::resolution::{
    ABILITY_IDS, ActionRequest, ExtraDamage, MAX_ACTION_NAME_CHARS, MAX_EXTRA_DAMAGE_COMPONENTS,
    MAX_RESOLUTION_TARGETS, PendingResolution, ResolutionCheck, ResolvedTarget, RollMode,
    TargetOutcome, attack_outcome, auto_critical_within_5ft, damage_after_save, kept_d20,
    save_condition_mode, save_fails_automatically, token_distance_ft,
};
use uuid::Uuid;

/// Accepted attack roll bonus range (`-10..=30`).
pub const ATTACK_BONUS_RANGE: std::ops::RangeInclusive<i32> = -10..=30;
/// Accepted lowest natural d20 of a critical hit (`18..=20`).
pub const CRITICAL_RANGE: std::ops::RangeInclusive<u8> = 18..=20;
/// Accepted save DC range (`1..=30`).
pub const SAVE_DC_RANGE: std::ops::RangeInclusive<i32> = 1..=30;
/// Accepted flat damage modifier range (`-20..=50`).
pub const DAMAGE_MODIFIER_RANGE: std::ops::RangeInclusive<i32> = -20..=50;
/// Most dice in one damage term before critical doubling (`1..=40`).
pub const MAX_DAMAGE_DICE_PER_TERM: u32 = 40;
/// Most dice terms in a damage expression.
pub const MAX_DAMAGE_TERMS: usize = 6;
/// Die sizes a damage term may use.
const DAMAGE_DIE_SIDES: [u32; 6] = [4, 6, 8, 10, 12, 20];
/// Accepted ability score range when a stat block's save is derived from its score.
const SCORE_RANGE: std::ops::RangeInclusive<i32> = 1..=30;

/// Parses damage dice (`"2d6"`, `"1d8+1d6"`; `""` is no dice) into `(count, sides)` terms.
pub fn parse_damage_dice(dice: &str) -> Result<Vec<(u32, u32)>, String> {
    let cleaned: String = dice.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    let terms: Vec<&str> = cleaned.split('+').collect();
    if terms.len() > MAX_DAMAGE_TERMS {
        return Err(format!(
            "damage dice allow at most {MAX_DAMAGE_TERMS} terms"
        ));
    }
    terms
        .into_iter()
        .map(|term| {
            let (count, sides) = term
                .to_ascii_lowercase()
                .split_once('d')
                .and_then(|(c, s)| Some((c.parse::<u32>().ok()?, s.parse::<u32>().ok()?)))
                .ok_or_else(|| format!("invalid damage dice term '{term}'"))?;
            if !(1..=MAX_DAMAGE_DICE_PER_TERM).contains(&count)
                || !DAMAGE_DIE_SIDES.contains(&sides)
            {
                return Err(format!("damage dice term '{term}' is out of bounds"));
            }
            Ok((count, sides))
        })
        .collect()
}

/// Damage expression of `terms` plus `modifier`, every dice count doubled on a critical hit
/// (invariant 3). `""` when there is neither dice nor modifier.
pub fn damage_expression(terms: &[(u32, u32)], modifier: i32, critical: bool) -> String {
    let factor = if critical { 2 } else { 1 };
    let mut parts: Vec<String> = terms
        .iter()
        .map(|(count, sides)| format!("{}d{sides}", count * factor))
        .collect();
    if modifier != 0 {
        parts.push(modifier.to_string());
    }
    parts.join("+").replace("+-", "-")
}

fn bounded_ability_mod(score: f64) -> i32 {
    let score = (score.round() as i32).clamp(*SCORE_RANGE.start(), *SCORE_RANGE.end());
    (score - 10).div_euclid(2)
}

/// Save bonus of a stat block (`MonsterStatBlock`): its printed `savingThrows[ability]`, else
/// the ability modifier of its score, else `0`.
pub fn stat_block_save_bonus(block: &Value, ability: &str) -> i32 {
    if let Some(bonus) = block
        .pointer(&format!("/savingThrows/{ability}"))
        .and_then(Value::as_f64)
    {
        return (bonus.round() as i32).clamp(-10, 30);
    }
    block
        .pointer(&format!("/abilities/{ability}"))
        .and_then(Value::as_f64)
        .map_or(0, bounded_ability_mod)
}

/// The save bonus the server rolls for `token`: the sheet-synced `save_bonuses`, else its
/// stat block copy, else `0` (a plain token has no known bonus).
pub fn server_save_bonus(token: &TokenState, ability: &str) -> i32 {
    if let Some(bonus) = token.save_bonuses.get(ability) {
        return *bonus;
    }
    token
        .stat_block
        .as_ref()
        .map_or(0, |block| stat_block_save_bonus(block, ability))
}

/// d20 expression of a roll in `mode` with `bonus` (`"2d20kh1+5"`).
pub fn d20_expression(mode: RollMode, bonus: i32) -> String {
    format!("{}{bonus:+}", mode.d20_term())
}

/// Natural d20s of a d20 roll and the kept one.
pub fn d20s_of(outcome: &DiceRollOutcome, mode: RollMode) -> (Vec<u8>, u8) {
    let rolls: Vec<u8> = outcome
        .terms
        .first()
        .map(|t| {
            t.raw_rolls
                .iter()
                .map(|r| u8::try_from(*r).unwrap_or(20))
                .collect()
        })
        .unwrap_or_default();
    let kept = kept_d20(mode, &rolls).unwrap_or(1);
    (rolls, kept)
}

fn roll(
    roller: &mut SeededDiceRoller,
    issuer: Uuid,
    expression: &str,
    reason: &str,
) -> Result<DiceRollOutcome, String> {
    roller
        .roll(issuer, expression, RollVisibility::GmOnly, reason)
        .map_err(|err| format!("invalid configuration: {err}"))
}

fn roll_damage(
    roller: &mut SeededDiceRoller,
    issuer: Uuid,
    expression: &str,
    reason: &str,
) -> Result<i32, String> {
    if expression.is_empty() {
        return Ok(0);
    }
    Ok(roll(roller, issuer, expression, reason)?.total.max(0))
}

/// One damage part of a request: parsed dice terms and flat modifier.
struct DamagePart {
    terms: Vec<(u32, u32)>,
    modifier: i32,
}

/// Rolls every damage part (the primary part first), dice doubled on a critical hit.
fn roll_parts(
    roller: &mut SeededDiceRoller,
    issuer: Uuid,
    parts: &[DamagePart],
    critical: bool,
    reason: &str,
) -> Result<Vec<i32>, String> {
    parts
        .iter()
        .map(|p| {
            let expression = damage_expression(&p.terms, p.modifier, critical);
            roll_damage(roller, issuer, &expression, reason)
        })
        .collect()
}

/// Primary part and extra parts of rolled damage, the shape `ResolvedTarget` stores.
fn split_parts(mut rolled: Vec<i32>) -> (i32, Vec<i32>) {
    let extra = rolled.split_off(1.min(rolled.len()));
    (rolled.first().copied().unwrap_or(0), extra)
}

fn validate_request(
    state: &TableState,
    actor: &CommandActor,
    request: &ActionRequest,
) -> Result<Vec<DamagePart>, String> {
    let invalid = |m: &str| Err(format!("invalid configuration: {m}"));
    let name_len = request.action_name.trim().chars().count();
    if !(1..=MAX_ACTION_NAME_CHARS).contains(&name_len) {
        return invalid("action name must be 1..=120 characters");
    }
    match &request.check {
        ResolutionCheck::Attack {
            attack_bonus,
            critical_range,
        } => {
            if !ATTACK_BONUS_RANGE.contains(attack_bonus)
                || !CRITICAL_RANGE.contains(critical_range)
            {
                return invalid("attack bonus or critical range is out of bounds");
            }
        }
        ResolutionCheck::Save { ability, dc, .. } => {
            if !ABILITY_IDS.contains(&ability.as_str()) || !SAVE_DC_RANGE.contains(dc) {
                return invalid("save ability or DC is out of bounds");
            }
        }
        ResolutionCheck::Automatic => {}
    }
    if request.extra_damage.len() > MAX_EXTRA_DAMAGE_COMPONENTS {
        return invalid("an action has at most 3 extra damage parts");
    }
    let mut modifiers = std::iter::once(request.damage_modifier)
        .chain(request.extra_damage.iter().map(|p| p.modifier));
    if modifiers.any(|m| !DAMAGE_MODIFIER_RANGE.contains(&m)) {
        return invalid("damage modifier is out of bounds");
    }
    let mut types = std::iter::once(&request.damage_type)
        .chain(request.extra_damage.iter().map(|p| &p.damage_type));
    if types.any(|t| t.as_deref().is_some_and(|t| !DAMAGE_TYPES.contains(&t))) {
        return invalid("damage type is not an SRD damage type");
    }
    let count = request.targets.len();
    if count == 0 || count > MAX_RESOLUTION_TARGETS {
        return invalid("an action resolves 1..=32 targets");
    }
    let mut ids: Vec<Uuid> = request.targets.iter().map(|t| t.token_id).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != count {
        return invalid("targets must be distinct");
    }
    if actor.role != CampaignRole::Gm {
        let visible = visible_token_ids_for_recipient(state, actor.user_id, actor.role);
        if ids.iter().any(|id| !visible.contains(id)) {
            return Err("entity not found: a target is not on the table".to_string());
        }
    }
    std::iter::once((&request.damage_dice, request.damage_modifier))
        .chain(request.extra_damage.iter().map(|p| (&p.dice, p.modifier)))
        .map(|(dice, modifier)| {
            let terms =
                parse_damage_dice(dice).map_err(|m| format!("invalid configuration: {m}"))?;
            Ok(DamagePart { terms, modifier })
        })
        .collect()
}

/// Rolls `request` for `actor` (invariants 1-3). Unknown tokens are reported as not found;
/// the engine re-checks attacker control and target existence before storing the result.
pub fn fill_action_resolution(
    state: &TableState,
    actor: &CommandActor,
    request: &ActionRequest,
    roller: &mut SeededDiceRoller,
) -> Result<PendingResolution, String> {
    let parts = validate_request(state, actor, request)?;
    let tokens = &state.data.tokens;
    let target_of = |id: &Uuid| {
        tokens
            .get(id)
            .ok_or_else(|| format!("entity not found: token {id}"))
    };
    let attacker = match request.attacker_token_id {
        Some(id) => Some(target_of(&id)?),
        None => None,
    };
    let issuer = actor.user_id;
    let name = request.action_name.trim().to_string();
    let base_expression = damage_expression(&parts[0].terms, parts[0].modifier, false);
    let damage_reason = format!("{name}: damage");
    let mut targets = Vec::with_capacity(request.targets.len());

    match &request.check {
        ResolutionCheck::Attack {
            attack_bonus,
            critical_range,
        } => {
            for wanted in &request.targets {
                let target = target_of(&wanted.token_id)?;
                let mode = wanted.roll_mode;
                let Some(cover_bonus) = wanted.cover.bonus() else {
                    targets.push(blocked(wanted.token_id, mode));
                    continue;
                };
                let d20 = roll(
                    roller,
                    issuer,
                    &d20_expression(mode, *attack_bonus),
                    &format!("{name}: attack"),
                )?;
                let (d20_rolls, natural) = d20s_of(&d20, mode);
                let auto_critical = attacker.is_some_and(|a| {
                    auto_critical_within_5ft(target)
                        && token_distance_ft(a, target, state.cell_size_px, state.feet_per_cell)
                            <= 5.0
                });
                let outcome = attack_outcome(
                    natural,
                    d20.total,
                    target.ac + cover_bonus,
                    *critical_range,
                    auto_critical,
                );
                let critical = outcome == TargetOutcome::Critical;
                let (damage, extra_damage) =
                    if matches!(outcome, TargetOutcome::Hit | TargetOutcome::Critical) {
                        split_parts(roll_parts(
                            roller,
                            issuer,
                            &parts,
                            critical,
                            &damage_reason,
                        )?)
                    } else {
                        (0, Vec::new())
                    };
                targets.push(ResolvedTarget {
                    token_id: wanted.token_id,
                    roll_mode: mode,
                    outcome,
                    d20_rolls,
                    total: Some(d20.total),
                    damage,
                    extra_damage,
                    is_critical: critical,
                    applied: false,
                });
            }
        }
        ResolutionCheck::Save {
            ability,
            dc,
            half_on_success,
        } => {
            let rolled = roll_parts(roller, issuer, &parts, false, &damage_reason)?;
            for wanted in &request.targets {
                let target = target_of(&wanted.token_id)?;
                let client_mode_allowed =
                    actor.role == CampaignRole::Gm || target.owner_user_id == Some(actor.user_id);
                let mode = if client_mode_allowed {
                    wanted.roll_mode
                } else {
                    save_condition_mode(target, ability)
                };
                let Some(cover_bonus) = wanted.cover.bonus() else {
                    targets.push(blocked(wanted.token_id, mode));
                    continue;
                };
                if save_fails_automatically(target, ability) {
                    let (damage, extra_damage) = split_parts(rolled.clone());
                    targets.push(ResolvedTarget {
                        token_id: wanted.token_id,
                        roll_mode: mode,
                        outcome: TargetOutcome::SaveFailure,
                        d20_rolls: Vec::new(),
                        total: None,
                        damage,
                        extra_damage,
                        is_critical: false,
                        applied: false,
                    });
                    continue;
                }
                let bonus = server_save_bonus(target, ability)
                    + if ability == "dex" { cover_bonus } else { 0 };
                let save = roll(
                    roller,
                    issuer,
                    &d20_expression(mode, bonus),
                    &format!("{name}: {} save", ability.to_ascii_uppercase()),
                )?;
                let (d20_rolls, _) = d20s_of(&save, mode);
                let success = save.total >= *dc;
                let (damage, extra_damage) = split_parts(
                    rolled
                        .iter()
                        .map(|part| damage_after_save(*part, success, *half_on_success))
                        .collect(),
                );
                targets.push(ResolvedTarget {
                    token_id: wanted.token_id,
                    roll_mode: mode,
                    outcome: if success {
                        TargetOutcome::SaveSuccess
                    } else {
                        TargetOutcome::SaveFailure
                    },
                    d20_rolls,
                    total: Some(save.total),
                    damage,
                    extra_damage,
                    is_critical: false,
                    applied: false,
                });
            }
        }
        ResolutionCheck::Automatic => {
            let (rolled, rolled_extra) =
                split_parts(roll_parts(roller, issuer, &parts, false, &damage_reason)?);
            for wanted in &request.targets {
                target_of(&wanted.token_id)?;
                if wanted.cover.bonus().is_none() {
                    targets.push(blocked(wanted.token_id, RollMode::Normal));
                    continue;
                }
                targets.push(ResolvedTarget {
                    token_id: wanted.token_id,
                    roll_mode: RollMode::Normal,
                    outcome: TargetOutcome::Hit,
                    d20_rolls: Vec::new(),
                    total: None,
                    damage: rolled,
                    extra_damage: rolled_extra.clone(),
                    is_critical: false,
                    applied: false,
                });
            }
        }
    }

    Ok(PendingResolution {
        id: request.resolution_id,
        issuer_user_id: issuer,
        attacker_token_id: request.attacker_token_id,
        action_name: name,
        check: request.check.clone(),
        damage_type: request.damage_type.clone(),
        damage_expression: base_expression,
        extra_damage: request
            .extra_damage
            .iter()
            .zip(&parts[1..])
            .map(|(requested, part)| ExtraDamage {
                damage_type: requested.damage_type.clone(),
                expression: damage_expression(&part.terms, part.modifier, false),
            })
            .collect(),
        targets,
        sequence: 0,
    })
}

fn blocked(token_id: Uuid, roll_mode: RollMode) -> ResolvedTarget {
    ResolvedTarget {
        token_id,
        roll_mode,
        outcome: TargetOutcome::Blocked,
        d20_rolls: Vec::new(),
        total: None,
        damage: 0,
        extra_damage: Vec::new(),
        is_critical: false,
        applied: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn damage_expression_table() {
        let cases = [
            ("dice_and_modifier", vec![(1, 8)], 3, false, "1d8+3"),
            ("critical_doubles_dice_only", vec![(1, 8)], 3, true, "2d8+3"),
            (
                "critical_doubles_every_term",
                vec![(1, 6), (2, 4)],
                0,
                true,
                "2d6+4d4",
            ),
            ("negative_modifier", vec![(1, 4)], -1, false, "1d4-1"),
            ("flat_damage_only", vec![], 2, false, "2"),
            ("no_damage", vec![], 0, false, ""),
        ];
        for (id, terms, modifier, critical, expected) in cases {
            assert_eq!(
                damage_expression(&terms, modifier, critical),
                expected,
                "{id}"
            );
        }
    }

    #[test]
    fn parse_damage_dice_table() {
        let cases: [(&str, &str, Result<Vec<(u32, u32)>, ()>); 6] = [
            ("empty_is_no_dice", "", Ok(vec![])),
            ("single_term", "8d6", Ok(vec![(8, 6)])),
            (
                "two_terms_with_spaces",
                "1d8 + 1d6",
                Ok(vec![(1, 8), (1, 6)]),
            ),
            ("flat_modifier_rejected", "1d6+2", Err(())),
            ("odd_die_rejected", "1d7", Err(())),
            ("too_many_dice_rejected", "41d6", Err(())),
        ];
        for (id, input, expected) in cases {
            assert_eq!(parse_damage_dice(input).map_err(|_| ()), expected, "{id}");
        }
    }

    #[test]
    fn stat_block_save_bonus_table() {
        let block = json!({ "abilities": { "dex": 15, "wis": 8 }, "savingThrows": { "wis": 4 } });
        let cases = [
            ("printed_save_wins", "wis", 4),
            ("score_modifier_otherwise", "dex", 2),
            ("missing_ability_is_zero", "cha", 0),
        ];
        for (id, ability, expected) in cases {
            assert_eq!(stat_block_save_bonus(&block, ability), expected, "{id}");
        }
    }
}
