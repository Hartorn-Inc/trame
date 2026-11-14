//! ============================================================================
//! SERVER-HELD ACTION RESOLUTION & CONCENTRATION CHECKS (resolution.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Decision D6 resolves an attack or an area spell in two steps: roll, then an
//! explicit Apply. When the attacker cannot see the target's numbers (a player
//! against a monster's AC or save bonus), only the server can roll and compare,
//! so the result has to live on the server until someone applies it. This
//! module holds that `PendingResolution`, the pure rules used to build it, and
//! the engine side of the commands that create, apply and dismiss it. It also
//! owns the `ConcentrationCheckPrompt` queue opened when a concentrating token takes
//! damage (story 58).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Server Rolls, Engine Stores`:
//!      - `ResolveAction` and `RollConcentrationCheck` carry a server-filled
//!        payload (`resolution` / `roll`), like `ActivateScene`. The room
//!        always overwrites whatever a client sent; the engine rejects a
//!        missing payload. The WAL stores the filled command, so replay
//!        reproduces the same rolls without a dice roller.
//!   2. `WAL-Recorded, Undoable, Bounded`:
//!      - Pending resolutions and concentration checks live in
//!        `TableSnapshotData`: they survive restarts and undo restores them
//!        with the HP they relate to. At most `MAX_PENDING_RESOLUTIONS` are
//!        kept (the oldest by `sequence` is dropped); `ActivateScene` clears
//!        both queues. A check disappears as soon as its token stops
//!        concentrating (any command).
//!   3. `Apply Exactly Once Per Target`:
//!      - `ApplyResolution` applies the server-rolled damage (typed, so the
//!        engine derives the affinity) and marks each target `applied`. A
//!        target that is already applied is never damaged again; a fully
//!        applied resolution leaves the table. Targets with `0` damage are
//!        applied when the resolution is created. An action dealing several
//!        damage types carries `extra_damage` parts (at most
//!        `MAX_EXTRA_DAMAGE_COMPONENTS`): each part meets the target's own
//!        affinity to its type, then the sum lands as one hit (one
//!        Concentration check, one death-save failure at 0 HP). A GM amount
//!        override replaces every part and uses the primary type.
//!   4. `Who May Apply`:
//!      - The issuer applies their own resolution as rolled. Only the Game
//!        Master adjusts (amount, type, critical) or dismisses one.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `ResolveAction { request, resolution }` (room fills `resolution`)
//!     ├── 1. Validate issuer, attacker control and targets.
//!     ├── 2. Mark 0-damage targets applied; store unless all are applied.
//!     └── 3. Emit `ActionResolved`.
//!   `ApplyResolution { resolution_id, token_id, adjustment }`
//!     ├── 1. Issuer or GM; adjustments GM-only; refuse applied targets.
//!     ├── 2. `apply_damage_to_token` per target (concentration check queued).
//!     └── 3. Emit `DamageApplied`... + `ResolutionApplied`.
//!   `RollConcentrationCheck { token_id, roll }` (room fills `roll`)
//!     ├── 1. Token control; pop the oldest DC of the token's queue.
//!     └── 2. Emit `ConcentrationCheckRolled`; a failure ends concentration.
//! ============================================================================

use crate::commands::{
    CampaignRole, CommandActor, CommandError, ConditionOverrideEntry, TableState, TokenState,
    TrameEvent, condition_effect_active,
};
use crate::cover::CoverLevel;
use crate::rules::{DamageAffinity, mitigate_damage};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Most pending resolutions a table keeps; creating one more drops the oldest.
pub const MAX_PENDING_RESOLUTIONS: usize = 32;
/// Most targets one action resolves (`1..=32`).
pub const MAX_RESOLUTION_TARGETS: usize = 32;
/// Longest action name (`chars`).
pub const MAX_ACTION_NAME_CHARS: usize = 120;
/// Ability ids accepted for saving throws, in sheet order.
pub const ABILITY_IDS: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

/// Conditions whose rules make a hit from within 5 ft a critical hit (`auto_crit_within_5ft`).
const AUTO_CRIT_CONDITIONS: [&str; 2] = ["paralyzed", "unconscious"];
/// Conditions whose rules fail Strength and Dexterity saves (`auto_fail_str_dex_saves`).
const AUTO_FAIL_SAVE_CONDITIONS: [&str; 4] = ["paralyzed", "petrified", "stunned", "unconscious"];
/// Conditions imposing disadvantage on Dexterity saves (`dex_save_disadvantage`).
const DEX_SAVE_DISADVANTAGE_CONDITIONS: [&str; 1] = ["restrained"];

/// Advantage state of a d20 roll.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RollMode {
    /// One d20.
    #[default]
    Normal,
    /// Two d20, the higher is kept.
    Advantage,
    /// Two d20, the lower is kept.
    Disadvantage,
}

impl RollMode {
    /// d20 term of the mode: `1d20`, `2d20kh1` or `2d20kl1`.
    pub fn d20_term(self) -> &'static str {
        match self {
            Self::Normal => "1d20",
            Self::Advantage => "2d20kh1",
            Self::Disadvantage => "2d20kl1",
        }
    }
}

/// How the targets of an action are checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResolutionCheck {
    /// One attack roll per target against its Armor Class.
    Attack {
        /// Attack roll bonus from the attacker's sheet or stat block (`-10..=30`).
        attack_bonus: i32,
        /// Lowest natural d20 that is a critical hit (`18..=20`, `20` by default).
        critical_range: u8,
    },
    /// One saving throw per target against the issuer's DC; damage is rolled once.
    Save {
        /// Ability id of the save (`ABILITY_IDS`).
        ability: String,
        /// Save DC (`1..=30`).
        dc: i32,
        /// A successful save halves the damage (rounded down); otherwise it negates it.
        half_on_success: bool,
    },
    /// No roll: every target takes the damage (Magic Missile, areas without a save).
    Automatic,
}

/// One target of an `ActionRequest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ActionTargetRequest {
    /// Targeted token.
    pub token_id: Uuid,
    /// Advantage state the client computed. Attacks always use it (the attacker's own
    /// conditions and features); saves use it only when the issuer is the GM or controls
    /// the target, otherwise the server's condition-based mode applies.
    #[serde(default)]
    pub roll_mode: RollMode,
    /// Cover the issuer accepted for this target: `+2` / `+5` to AC and Dexterity saves;
    /// `Total` blocks the target.
    #[serde(default = "no_cover")]
    pub cover: CoverLevel,
}

fn no_cover() -> CoverLevel {
    CoverLevel::None
}

/// What a client asks the server to resolve (`ResolveAction.request`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ActionRequest {
    /// Client-chosen id of the resolution (UUID, unique on the table); the card follows it.
    pub resolution_id: Uuid,
    /// Token of the attacker or caster (`None` when it has none on the table: no automatic
    /// critical hit then). Players must control it.
    #[serde(default)]
    pub attacker_token_id: Option<Uuid>,
    /// Name shown in the card and the GM list (`1..=MAX_ACTION_NAME_CHARS` chars).
    pub action_name: String,
    /// Attack roll, saving throw, or automatic hit.
    pub check: ResolutionCheck,
    /// Damage dice (`"2d6"`, `"1d8+1d6"`), dice terms only; `""` for no damage.
    #[serde(default)]
    pub damage_dice: String,
    /// Flat damage added once, never doubled (`-20..=50`).
    #[serde(default)]
    pub damage_modifier: i32,
    /// Lowercase SRD damage type; `None` is untyped damage (no affinity).
    #[serde(default)]
    pub damage_type: Option<String>,
    /// Further damage parts with their own type (a monster's `1d8 slashing + 2d6 fire`),
    /// rolled like the primary part (`0..=MAX_EXTRA_DAMAGE_COMPONENTS`).
    #[serde(default)]
    pub extra_damage: Vec<DamageComponentRequest>,
    /// Targets (`1..=MAX_RESOLUTION_TARGETS`, distinct).
    pub targets: Vec<ActionTargetRequest>,
}

/// Most extra damage parts one action carries besides its primary part.
pub const MAX_EXTRA_DAMAGE_COMPONENTS: usize = 3;

/// One extra damage part of an `ActionRequest`, rolled and mitigated with its own type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DamageComponentRequest {
    /// Damage dice, dice terms only (`"2d6"`); `""` for flat damage.
    #[serde(default)]
    pub dice: String,
    /// Flat damage added once, never doubled (`-20..=50`).
    #[serde(default)]
    pub modifier: i32,
    /// Lowercase SRD damage type; `None` is untyped damage (no affinity).
    #[serde(default)]
    pub damage_type: Option<String>,
}

/// Extra damage part of a `PendingResolution`, in `ActionRequest::extra_damage` order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ExtraDamage {
    /// Damage type of the part (`None`: untyped).
    pub damage_type: Option<String>,
    /// Damage expression of the part before critical doubling (`"2d6"`).
    pub expression: String,
}

/// Result of one target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TargetOutcome {
    /// The attack hit (or an automatic hit).
    Hit,
    /// The attack is a critical hit (damage dice doubled).
    Critical,
    /// The attack missed.
    Miss,
    /// Total cover: the target could not be targeted.
    Blocked,
    /// The target succeeded on its save.
    SaveSuccess,
    /// The target failed its save (or failed automatically).
    SaveFailure,
}

/// Server-rolled result of one target of a `PendingResolution`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ResolvedTarget {
    /// Targeted token.
    pub token_id: Uuid,
    /// Mode the d20 was rolled with.
    pub roll_mode: RollMode,
    /// Hit, miss, critical, blocked, or save result.
    pub outcome: TargetOutcome,
    /// Natural d20s rolled (one, or two with advantage / disadvantage); empty when nothing
    /// was rolled or the recipient may not see them.
    #[serde(default)]
    pub d20_rolls: Vec<u8>,
    /// Attack or save total; `None` when nothing was rolled or the recipient may not see it.
    #[serde(default)]
    pub total: Option<i32>,
    /// Damage to apply (`>= 0`): rolled, after save-for-half, before the target's affinity.
    pub damage: i32,
    /// Damage of each `PendingResolution::extra_damage` part (`>= 0`, same order), before the
    /// target's affinity to that part's type; empty for single-type actions.
    #[serde(default)]
    pub extra_damage: Vec<i32>,
    /// Damage counts as a critical hit (death saving throw failures at 0 HP).
    pub is_critical: bool,
    /// The damage was applied (or there was none to apply).
    pub applied: bool,
}

/// An action rolled by the server and waiting for its Apply (`GLOSSARY.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct PendingResolution {
    /// `ActionRequest::resolution_id`.
    pub id: Uuid,
    /// User who requested it; they may apply it as rolled.
    pub issuer_user_id: Uuid,
    /// Attacker or caster token.
    pub attacker_token_id: Option<Uuid>,
    /// Action name.
    pub action_name: String,
    /// The check the targets faced.
    pub check: ResolutionCheck,
    /// Damage type applied (`None`: untyped).
    pub damage_type: Option<String>,
    /// Damage expression (`"1d8+3"`; critical hits doubled the dice), `""` without damage.
    pub damage_expression: String,
    /// Extra damage parts with their own type (`0..=MAX_EXTRA_DAMAGE_COMPONENTS`).
    #[serde(default)]
    pub extra_damage: Vec<ExtraDamage>,
    /// Results, in request order.
    pub targets: Vec<ResolvedTarget>,
    /// Creation order on the table (set by the engine; the oldest is dropped first).
    #[serde(default)]
    pub sequence: u64,
}

impl PendingResolution {
    fn fully_applied(&self) -> bool {
        self.targets.iter().all(|t| t.applied)
    }
}

impl ResolvedTarget {
    /// Raw damage of every part before affinities.
    fn total_damage(&self) -> i32 {
        self.damage + self.extra_damage.iter().sum::<i32>()
    }
}

/// Game Master changes to a resolution before it is applied.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ResolutionAdjustment {
    /// New amount (`>= 0`); only with a single `token_id`.
    #[serde(default)]
    pub damage: Option<i32>,
    /// New damage type; `""` makes it untyped.
    #[serde(default)]
    pub damage_type: Option<String>,
    /// New critical flag.
    #[serde(default)]
    pub is_critical: Option<bool>,
}

/// Server roll of a Concentration check (`RollConcentrationCheck.roll`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ConcentrationRoll {
    /// Natural d20s (one, or two with advantage / disadvantage), each `1..=20`.
    pub d20_rolls: Vec<u8>,
    /// Constitution save total.
    pub total: i32,
}

/// Kept natural d20 of `rolls` in `mode`.
pub fn kept_d20(mode: RollMode, rolls: &[u8]) -> Option<u8> {
    match mode {
        RollMode::Normal => rolls.first().copied(),
        RollMode::Advantage => rolls.iter().max().copied(),
        RollMode::Disadvantage => rolls.iter().min().copied(),
    }
}

/// Outcome of an attack roll. Order: a natural 1 misses; a natural d20 of at least
/// `critical_range` is a critical hit; a total of at least `armor_class` hits, and a hit is a
/// critical hit when `auto_critical` applies (Paralyzed / Unconscious target within 5 ft).
pub fn attack_outcome(
    natural: u8,
    total: i32,
    armor_class: i32,
    critical_range: u8,
    auto_critical: bool,
) -> TargetOutcome {
    if natural == 1 {
        TargetOutcome::Miss
    } else if natural >= critical_range {
        TargetOutcome::Critical
    } else if total >= armor_class {
        if auto_critical {
            TargetOutcome::Critical
        } else {
            TargetOutcome::Hit
        }
    } else {
        TargetOutcome::Miss
    }
}

/// Damage a target takes after its save: full on a failure, half (rounded down) or none on
/// a success.
pub fn damage_after_save(rolled: i32, success: bool, half_on_success: bool) -> i32 {
    match (success, half_on_success) {
        (false, _) => rolled,
        (true, true) => rolled / 2,
        (true, false) => 0,
    }
}

/// 3D distance in feet between two footprints, as the grid counts it: horizontally the
/// empty cells between the footprints plus one (adjacent = one cell), vertically the
/// difference of base elevations; the larger of the two (diagonals cost one square).
pub fn token_distance_ft(
    a: &TokenState,
    b: &TokenState,
    cell_size_px: f64,
    feet_per_cell: f64,
) -> f64 {
    let span = |start: f64, cells: u8| {
        let s = start / cell_size_px;
        (s, s + f64::from(cells))
    };
    let (ax0, ax1) = span(a.top_left.x, a.grid_w);
    let (bx0, bx1) = span(b.top_left.x, b.grid_w);
    let (ay0, ay1) = span(a.top_left.y, a.grid_h);
    let (by0, by1) = span(b.top_left.y, b.grid_h);
    let gap = [0.0, bx0 - ax1, ax0 - bx1, by0 - ay1, ay0 - by1]
        .into_iter()
        .fold(0.0_f64, f64::max);
    let horizontal = (gap + 1.0).round() * feet_per_cell;
    let vertical = (a.elevation_ft - b.elevation_ft).abs();
    horizontal.max(vertical)
}

fn rule_active(
    conditions: &[String],
    overrides: &[ConditionOverrideEntry],
    rule: &str,
    sources: &[&str],
) -> bool {
    condition_effect_active(conditions, overrides, rule, sources)
}

/// `true` when a hit on `target` from within 5 ft is a critical hit (Paralyzed, Unconscious,
/// GM rulings applied).
pub fn auto_critical_within_5ft(target: &TokenState) -> bool {
    rule_active(
        &target.conditions,
        &target.condition_overrides,
        "auto_crit_within_5ft",
        &AUTO_CRIT_CONDITIONS,
    )
}

/// `true` when `target` fails a save of `ability` automatically (Strength and Dexterity
/// while Paralyzed, Petrified, Stunned or Unconscious).
pub fn save_fails_automatically(target: &TokenState, ability: &str) -> bool {
    matches!(ability, "str" | "dex")
        && rule_active(
            &target.conditions,
            &target.condition_overrides,
            "auto_fail_str_dex_saves",
            &AUTO_FAIL_SAVE_CONDITIONS,
        )
}

/// Condition-based mode of `target`'s save of `ability` (Restrained: Dexterity disadvantage).
pub fn save_condition_mode(target: &TokenState, ability: &str) -> RollMode {
    if ability == "dex"
        && rule_active(
            &target.conditions,
            &target.condition_overrides,
            "dex_save_disadvantage",
            &DEX_SAVE_DISADVANTAGE_CONDITIONS,
        )
    {
        RollMode::Disadvantage
    } else {
        RollMode::Normal
    }
}

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::InvalidConfiguration(message.into())
}

impl TableState {
    /// `ResolveAction`: stores the server-filled `resolution` (invariants 1-3).
    pub(crate) fn resolve_action_command(
        &mut self,
        actor: &CommandActor,
        request: &ActionRequest,
        resolution: Option<PendingResolution>,
    ) -> Result<Vec<TrameEvent>, CommandError> {
        if actor.role == CampaignRole::Spectator {
            return Err(CommandError::PermissionDenied(
                "spectators cannot resolve actions".to_string(),
            ));
        }
        let Some(mut resolution) = resolution else {
            return Err(invalid(
                "ResolveAction requires the server-rolled resolution",
            ));
        };
        if resolution.id != request.resolution_id
            || resolution.issuer_user_id != actor.user_id
            || self.data.pending_resolutions.contains_key(&resolution.id)
        {
            return Err(invalid("resolution id or issuer is not valid"));
        }
        if let Some(attacker) = resolution.attacker_token_id {
            self.require_token_control(actor, attacker)?;
        }
        if resolution.targets.is_empty() || resolution.targets.len() > MAX_RESOLUTION_TARGETS {
            return Err(invalid(format!(
                "an action resolves 1..={MAX_RESOLUTION_TARGETS} targets"
            )));
        }
        if resolution.extra_damage.len() > MAX_EXTRA_DAMAGE_COMPONENTS {
            return Err(invalid(format!(
                "an action has at most {MAX_EXTRA_DAMAGE_COMPONENTS} extra damage parts"
            )));
        }
        for target in &resolution.targets {
            if !self.data.tokens.contains_key(&target.token_id) {
                return Err(CommandError::NotFound(format!("token {}", target.token_id)));
            }
            if target.damage < 0 || target.extra_damage.iter().any(|d| *d < 0) {
                return Err(invalid("resolution damage must be >= 0"));
            }
            if target.extra_damage.len() > resolution.extra_damage.len() {
                return Err(invalid("a target has more damage parts than the action"));
            }
        }
        self.push_undo(format!("Resolve {}", resolution.action_name));
        for target in &mut resolution.targets {
            target.applied |= target.total_damage() == 0;
        }
        self.data.resolution_seq += 1;
        resolution.sequence = self.data.resolution_seq;
        if !resolution.fully_applied() {
            self.data
                .pending_resolutions
                .insert(resolution.id, resolution.clone());
            while self.data.pending_resolutions.len() > MAX_PENDING_RESOLUTIONS {
                let oldest = self
                    .data
                    .pending_resolutions
                    .values()
                    .min_by_key(|r| r.sequence)
                    .map(|r| r.id)
                    .expect("non-empty");
                self.data.pending_resolutions.remove(&oldest);
            }
        }
        Ok(vec![TrameEvent::ActionResolved {
            resolution: Box::new(resolution),
        }])
    }

    /// `ApplyResolution`: applies the pending damage once per target (invariants 3-4).
    pub(crate) fn apply_resolution_command(
        &mut self,
        actor: &CommandActor,
        resolution_id: Uuid,
        token_id: Option<Uuid>,
        adjustment: Option<ResolutionAdjustment>,
    ) -> Result<Vec<TrameEvent>, CommandError> {
        let resolution = self
            .data
            .pending_resolutions
            .get(&resolution_id)
            .ok_or_else(|| CommandError::NotFound(format!("resolution {resolution_id}")))?
            .clone();
        let is_gm = actor.role == CampaignRole::Gm;
        if !is_gm && resolution.issuer_user_id != actor.user_id {
            return Err(CommandError::PermissionDenied(
                "only the GM or the attacker may apply this resolution".to_string(),
            ));
        }
        let adjustment = adjustment.unwrap_or_default();
        if !is_gm && adjustment != ResolutionAdjustment::default() {
            return Err(CommandError::PermissionDenied(
                "only the GM may adjust a resolution".to_string(),
            ));
        }
        if adjustment.damage.is_some_and(|d| d < 0) {
            return Err(invalid("resolution damage must be >= 0"));
        }
        if adjustment.damage.is_some() && token_id.is_none() {
            return Err(invalid("a damage adjustment needs a single target"));
        }
        let selected: Vec<usize> = match token_id {
            Some(id) => {
                let index = resolution
                    .targets
                    .iter()
                    .position(|t| t.token_id == id)
                    .ok_or_else(|| CommandError::NotFound(format!("resolution target {id}")))?;
                vec![index]
            }
            None => (0..resolution.targets.len()).collect(),
        };
        let selected: Vec<usize> = selected
            .into_iter()
            .filter(|i| !resolution.targets[*i].applied)
            .collect();
        if selected.is_empty() {
            return Err(invalid("this resolution was already applied"));
        }

        self.push_undo(format!("Apply {}", resolution.action_name));
        let damage_type = match adjustment.damage_type.as_deref() {
            Some("") => None,
            Some(t) => Some(t.to_string()),
            None => resolution.damage_type.clone(),
        };
        let mut events = Vec::new();
        let mut applied_ids = Vec::new();
        let mut updated = resolution;
        for index in selected {
            let target = &mut updated.targets[index];
            let critical = adjustment.is_critical.unwrap_or(target.is_critical);
            let has_parts =
                adjustment.damage.is_none() && target.extra_damage.iter().any(|d| *d > 0);
            if has_parts && let Some(token) = self.data.tokens.get(&target.token_id) {
                let parts = std::iter::once((target.damage, damage_type.as_deref())).chain(
                    target
                        .extra_damage
                        .iter()
                        .zip(&updated.extra_damage)
                        .map(|(amount, part)| (*amount, part.damage_type.as_deref())),
                );
                let amount = mitigated_parts(token, parts);
                if amount > 0 {
                    events.extend(self.apply_damage_to_token(
                        target.token_id,
                        amount,
                        DamageAffinity::Normal,
                        critical,
                        None,
                    ));
                }
            } else {
                let amount = adjustment.damage.unwrap_or(target.damage);
                if amount > 0 && self.data.tokens.contains_key(&target.token_id) {
                    events.extend(self.apply_damage_to_token(
                        target.token_id,
                        amount,
                        DamageAffinity::Normal,
                        critical,
                        damage_type.as_deref(),
                    ));
                }
            }
            target.applied = true;
            applied_ids.push(target.token_id);
        }
        if updated.fully_applied() {
            self.data.pending_resolutions.remove(&resolution_id);
        } else {
            self.data.pending_resolutions.insert(resolution_id, updated);
        }
        events.push(TrameEvent::ResolutionApplied {
            resolution_id,
            token_ids: applied_ids,
        });
        Ok(events)
    }

    /// `DismissResolution` (GM only): drops a pending resolution without applying it.
    pub(crate) fn dismiss_resolution_command(
        &mut self,
        actor: &CommandActor,
        resolution_id: Uuid,
    ) -> Result<Vec<TrameEvent>, CommandError> {
        Self::require_gm(actor)?;
        if !self.data.pending_resolutions.contains_key(&resolution_id) {
            return Err(CommandError::NotFound(format!(
                "resolution {resolution_id}"
            )));
        }
        self.push_undo("Dismiss resolution");
        self.data.pending_resolutions.remove(&resolution_id);
        Ok(vec![TrameEvent::ResolutionDismissed { resolution_id }])
    }

    /// `RollConcentrationCheck`: resolves the oldest pending check of `token_id` with the
    /// server-filled `roll`; a failure ends concentration and its persistent zone.
    pub(crate) fn roll_concentration_check_command(
        &mut self,
        actor: &CommandActor,
        token_id: Uuid,
        roll: Option<ConcentrationRoll>,
    ) -> Result<Vec<TrameEvent>, CommandError> {
        let name = self.require_token_control(actor, token_id)?.name.clone();
        let Some(&dc) = self
            .data
            .pending_concentration_checks
            .get(&token_id)
            .and_then(|dcs| dcs.first())
        else {
            return Err(invalid("no Concentration check is pending for this token"));
        };
        let Some(roll) = roll else {
            return Err(invalid("RollConcentrationCheck requires the server roll"));
        };
        if roll.d20_rolls.is_empty()
            || roll.d20_rolls.len() > 2
            || roll.d20_rolls.iter().any(|d| !(1..=20).contains(d))
        {
            return Err(invalid(
                "concentration d20 rolls must be 1 or 2 values within 1..=20",
            ));
        }
        self.push_undo(format!("Concentration check for {name}"));
        let success = roll.total >= dc;
        if let Some(dcs) = self.data.pending_concentration_checks.get_mut(&token_id) {
            dcs.remove(0);
            if dcs.is_empty() {
                self.data.pending_concentration_checks.remove(&token_id);
            }
        }
        let mut events = vec![TrameEvent::ConcentrationCheckRolled {
            token_id,
            dc,
            d20_rolls: roll.d20_rolls,
            total: roll.total,
            success,
        }];
        if !success {
            let tok = self.data.tokens.get_mut(&token_id).expect("token exists");
            tok.concentrating = false;
            let removed_aoe_id = tok.concentrating_on_aoe_id.take();
            if let Some(aoe_id) = removed_aoe_id {
                self.data.persistent_aoes.remove(&aoe_id);
            }
            self.data.pending_concentration_checks.remove(&token_id);
            events.push(TrameEvent::ConcentrationBroken {
                caster_token_id: token_id,
                removed_aoe_id,
            });
        }
        Ok(events)
    }

    /// Drops the Concentration checks of tokens that are gone or no longer concentrating.
    pub(crate) fn prune_concentration_checks(&mut self) {
        let tokens = &self.data.tokens;
        self.data.pending_concentration_checks.retain(|id, dcs| {
            !dcs.is_empty()
                && tokens
                    .get(id)
                    .is_some_and(|t| t.concentrating || t.concentrating_on_aoe_id.is_some())
        });
    }
}

/// Sum of damage parts after the token's affinity to each part's type (untyped parts are
/// unmitigated), so one hit of `slashing + fire` on a fire-resistant target halves only the fire.
fn mitigated_parts<'a>(
    token: &TokenState,
    parts: impl Iterator<Item = (i32, Option<&'a str>)>,
) -> i32 {
    parts
        .map(|(amount, damage_type)| {
            let affinity =
                damage_type.map_or(DamageAffinity::Normal, |t| token.damage_affinity_for(t));
            mitigate_damage(amount, affinity)
        })
        .fold(0, i32::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Point2D;

    #[test]
    fn attack_outcome_table() {
        let cases = [
            (
                "natural_1_always_misses",
                1,
                40,
                10,
                20,
                false,
                TargetOutcome::Miss,
            ),
            (
                "natural_20_is_critical",
                20,
                21,
                30,
                20,
                false,
                TargetOutcome::Critical,
            ),
            (
                "champion_19_is_critical",
                19,
                20,
                30,
                19,
                false,
                TargetOutcome::Critical,
            ),
            (
                "total_equal_to_ac_hits",
                10,
                15,
                15,
                20,
                false,
                TargetOutcome::Hit,
            ),
            (
                "total_below_ac_misses",
                10,
                14,
                15,
                20,
                false,
                TargetOutcome::Miss,
            ),
            (
                "auto_critical_upgrades_a_hit",
                10,
                15,
                15,
                20,
                true,
                TargetOutcome::Critical,
            ),
            (
                "auto_critical_never_upgrades_a_miss",
                10,
                14,
                15,
                20,
                true,
                TargetOutcome::Miss,
            ),
        ];
        for (id, natural, total, ac, range, auto, expected) in cases {
            assert_eq!(
                attack_outcome(natural, total, ac, range, auto),
                expected,
                "{id}"
            );
        }
    }

    #[test]
    fn damage_after_save_table() {
        let cases = [
            ("failure_takes_full", 21, false, true, 21),
            ("success_halves_rounding_down", 21, true, true, 10),
            ("success_negates_without_half", 21, true, false, 0),
        ];
        for (id, rolled, success, half, expected) in cases {
            assert_eq!(damage_after_save(rolled, success, half), expected, "{id}");
        }
    }

    #[test]
    fn token_distance_counts_elevation() {
        let at = |x: f64, elevation_ft: f64| {
            let mut t = TokenState::new_default(Uuid::nil(), "t", Point2D { x, y: 0.0 });
            t.elevation_ft = elevation_ft;
            t
        };
        let cases = [
            ("adjacent_same_level_is_5ft", at(100.0, 0.0), 5.0),
            ("two_cells_away_is_10ft", at(200.0, 0.0), 10.0),
            ("adjacent_but_10ft_up_is_10ft", at(100.0, 10.0), 10.0),
            ("adjacent_and_5ft_up_is_5ft", at(100.0, 5.0), 5.0),
        ];
        for (id, other, expected) in cases {
            assert_eq!(
                token_distance_ft(&at(0.0, 0.0), &other, 100.0, 5.0),
                expected,
                "{id}"
            );
        }
    }

    #[test]
    fn condition_rules_table() {
        let with = |conditions: &[&str]| {
            let mut t = TokenState::new_default(Uuid::nil(), "t", Point2D { x: 0.0, y: 0.0 });
            t.conditions = conditions.iter().map(|c| c.to_string()).collect();
            t
        };
        let cases: [(&str, bool, bool); 5] = [
            (
                "paralyzed_auto_crits",
                auto_critical_within_5ft(&with(&["paralyzed"])),
                true,
            ),
            (
                "unconscious_any_case_auto_crits",
                auto_critical_within_5ft(&with(&["Unconscious"])),
                true,
            ),
            (
                "stunned_does_not_auto_crit",
                auto_critical_within_5ft(&with(&["stunned"])),
                false,
            ),
            (
                "stunned_fails_dex_saves",
                save_fails_automatically(&with(&["stunned"]), "dex"),
                true,
            ),
            (
                "stunned_rolls_wis_saves",
                save_fails_automatically(&with(&["stunned"]), "wis"),
                false,
            ),
        ];
        for (id, actual, expected) in cases {
            assert_eq!(actual, expected, "{id}");
        }
        let modes = [
            (
                "restrained_dex_save_has_disadvantage",
                "dex",
                RollMode::Disadvantage,
            ),
            ("restrained_con_save_is_normal", "con", RollMode::Normal),
        ];
        for (id, ability, expected) in modes {
            assert_eq!(
                save_condition_mode(&with(&["restrained"]), ability),
                expected,
                "{id}"
            );
        }
    }
}
