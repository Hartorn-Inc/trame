//! ============================================================================
//! CRYPTOGRAPHICALLY SEEDED CHACHA20 DICE ROLLER & PRIVACY FILTER (dice.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Evaluates tabletop dice expressions (`1d20+5`, `2d20kh1+7` Advantage,
//! `2d20kl1-1` Disadvantage, `8d6`) on the authoritative server using a
//! cryptographically secure `ChaCha20Rng` stream (`SeededDiceRoller`), and
//! enforces per-recipient roll visibility filtering (`Public`, `GmOnly`,
//! `BlindGm`) via `project_roll_for_recipient`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Bounded Allocation & Loop Guards`:
//!      - `roll_dice_token` validates that dice `count` is in `1..=100`
//!        (`DiceError::InvalidCount`) and `sides` is in `2..=1000`
//!        (`DiceError::InvalidSides`) *before* allocating `Vec::with_capacity`,
//!        preventing denial-of-service via astronomical dice strings like
//!        `"999999999d20"`.
//!   2. `Three-Tier Roll Visibility`:
//!      - `RollVisibility::Public`: full breakdown sent to all connected clients.
//!      - `RollVisibility::GmOnly`: full breakdown sent only to the GM and the
//!        rolling player; `None` returned for all other players/spectators.
//!      - `RollVisibility::BlindGm`: full breakdown sent to the GM; the rolling
//!        player receives a masked confirmation (`blind_masked: true`,
//!        `terms: []`, `total: None`, `is_critical_*: None`) so they know their
//!        roll was registered without learning the secret outcome.
//!   3. `Natural 20 / Natural 1 Detection`:
//!      - `is_critical_success` (`Some(20)`) and `is_critical_failure`
//!        (`Some(1)`) trigger exclusively when the primary (first) dice term is
//!        a `d20` resolving to a single kept die (`kept_rolls.len() == 1`).
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `SeededDiceRoller::roll(roller_user_id, expression, visibility, reason)`
//!     ├── 1. Strip whitespace & reject empty expressions (`DiceError::EmptyExpression`).
//!     ├── 2. Split signed terms (`+` / `-`) via `split_signed_tokens`.
//!     ├── 3. For each dice term (`NdS`, `NdSkhK`, `NdSklK`):
//!     │    ├── Validate `1 <= count <= 100` and `2 <= sides <= 1000`.
//!     │    ├── Sample `ChaCha20Rng` in `1..=sides` & apply `KeepMode`.
//!     │    └── Accumulate signed `subtotal`.
//!     └── 4. Sum dice subtotals + `flat_modifier` & return `DiceRollOutcome`.
//! ============================================================================

use rand::{RngExt, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use trame_engine::commands::CampaignRole;
use uuid::Uuid;

/// Validation and parsing errors returned when evaluating a dice expression string.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DiceError {
    /// The expression string was empty or contained only whitespace.
    #[error("Empty dice expression")]
    EmptyExpression,
    /// A signed token could not be parsed as either a valid `NdS` dice term or an `i32` modifier.
    #[error("Invalid dice term: {0}")]
    InvalidTerm(String),
    /// The number of dice in a single term fell outside the safe range `1..=100`.
    #[error("Dice count must be between 1 and 100, got {0}")]
    InvalidCount(u32),
    /// The die face count fell outside the safe range `2..=1000`.
    #[error("Dice sides must be between 2 and 1000, got {0}")]
    InvalidSides(u32),
}

/// Privacy scope governing who can see the outcome of a dice roll (`01-TABLE-SPEC.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RollVisibility {
    /// Visible in full detail to the GM, the roller, and all other players/spectators in the room.
    Public,
    /// Visible in full detail to the GM and the rolling user; hidden (`None`) from all other participants.
    GmOnly,
    /// Visible in full detail only to the GM; the rolling user receives a `blind_masked: true` acknowledgment with `total: None`.
    BlindGm,
}

/// Filter selector for advantage/disadvantage and pool keep rules (`kh` / `kl`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeepMode {
    /// Retains all rolled dice in the term (`NdS`).
    All,
    /// Retains only the highest `K` dice rolled (`NdSkhK`, e.g., `2d20kh1` for Advantage).
    KeepHighest(u32),
    /// Retains only the lowest `K` dice rolled (`NdSklK`, e.g., `2d20kl1` for Disadvantage).
    KeepLowest(u32),
}

/// Detailed breakdown of a single rolled dice term (e.g., `+2d20kh1` or `-1d4`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SingleTermResult {
    /// Algebraic sign of the term (`+1` or `-1`).
    pub sign: i32,
    /// Number of dice rolled in this term (`1..=100`).
    pub count: u32,
    /// Number of faces per die (`2..=1000`).
    pub sides: u32,
    /// Keep rule applied to `raw_rolls`.
    pub keep_mode: KeepMode,
    /// Unfiltered individual die results in roll order (`1..=sides`).
    pub raw_rolls: Vec<u32>,
    /// Subset of `raw_rolls` retained after applying `keep_mode`.
    pub kept_rolls: Vec<u32>,
    /// Signed sum of `kept_rolls` (`sign * sum(kept_rolls)`).
    pub subtotal: i32,
}

/// Authoritative unmasked result of a completed dice roll prior to recipient privacy projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiceRollOutcome {
    /// Unique identifier for this roll event.
    pub roll_id: Uuid,
    /// User UUID of the participant who initiated the roll.
    pub roller_user_id: Uuid,
    /// Normalized (whitespace-stripped) dice expression string.
    pub expression: String,
    /// Requested roll visibility tier.
    pub visibility: RollVisibility,
    /// Human-readable label (e.g., `"attack_roll"`, `"stealth_check"`).
    pub reason: String,
    /// Ordered breakdown of each dice term in the expression.
    pub terms: Vec<SingleTermResult>,
    /// Net sum of all flat integer modifiers (`+5`, `-2`, etc.) in the expression.
    pub flat_modifier: i32,
    /// Final total (`sum(terms.subtotal) + flat_modifier`).
    pub total: i32,
    /// `true` if the primary term is a single kept `d20` showing natural `20`.
    pub is_critical_success: bool,
    /// `true` if the primary term is a single kept `d20` showing natural `1`.
    pub is_critical_failure: bool,
}

/// Recipient-projected dice roll payload safe for transmission over a client WebSocket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectedDiceRoll {
    /// Unique identifier for this roll event.
    pub roll_id: Uuid,
    /// User UUID of the participant who initiated the roll.
    pub roller_user_id: Uuid,
    /// Normalized dice expression string.
    pub expression: String,
    /// Roll visibility tier.
    pub visibility: RollVisibility,
    /// Human-readable roll reason or label.
    pub reason: String,
    /// `true` when a `BlindGm` roll is echoed back to the rolling player with all results stripped.
    pub blind_masked: bool,
    /// Dice term breakdowns (empty when `blind_masked == true`).
    pub terms: Vec<SingleTermResult>,
    /// Net flat integer modifier.
    pub flat_modifier: i32,
    /// Final roll total (`None` when `blind_masked == true`).
    pub total: Option<i32>,
    /// Natural 20 flag (`None` when `blind_masked == true`).
    pub is_critical_success: Option<bool>,
    /// Natural 1 flag (`None` when `blind_masked == true`).
    pub is_critical_failure: Option<bool>,
}

/// Cryptographically secure `ChaCha20Rng` dice evaluator owned by a `TableRoomActor`.
pub struct SeededDiceRoller {
    rng: ChaCha20Rng,
}

impl SeededDiceRoller {
    /// Initializes a `SeededDiceRoller` seeded with 256 bits (`32` bytes) of entropy from the OS CSPRNG.
    pub fn from_os_csprng() -> Self {
        let mut seed = [0u8; 32];
        let mut os_rng = rand::rng();
        os_rng.fill(&mut seed);
        Self {
            rng: ChaCha20Rng::from_seed(seed),
        }
    }

    /// Initializes a deterministic `SeededDiceRoller` from an explicit 32-byte `seed` for reproducible tests.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            rng: ChaCha20Rng::from_seed(seed),
        }
    }

    /// Parses and evaluates `expression` (e.g., `"2d20kh1+7"`) using the internal `ChaCha20Rng`.
    ///
    /// Fails closed with `DiceError` if the expression is empty, malformed, or requests dice counts
    /// outside `1..=100` or die sides outside `2..=1000`.
    pub fn roll(
        &mut self,
        roller_user_id: Uuid,
        expression: &str,
        visibility: RollVisibility,
        reason: impl Into<String>,
    ) -> Result<DiceRollOutcome, DiceError> {
        let cleaned: String = expression.chars().filter(|c| !c.is_whitespace()).collect();
        if cleaned.is_empty() {
            return Err(DiceError::EmptyExpression);
        }

        let mut terms = Vec::new();
        let mut flat_modifier: i32 = 0;

        for (sign, token) in split_signed_tokens(&cleaned)? {
            if token.contains('d') || token.contains('D') {
                let term = self.roll_dice_token(sign, &token)?;
                terms.push(term);
            } else {
                let val = token
                    .parse::<i32>()
                    .map_err(|_| DiceError::InvalidTerm(token.clone()))?;
                flat_modifier += sign * val;
            }
        }

        let dice_sum: i32 = terms.iter().map(|t| t.subtotal).sum();
        let total = dice_sum + flat_modifier;

        let primary_d20 = terms
            .first()
            .filter(|t| t.sides == 20 && t.kept_rolls.len() == 1)
            .and_then(|t| t.kept_rolls.first().copied());

        Ok(DiceRollOutcome {
            roll_id: Uuid::new_v4(),
            roller_user_id,
            expression: cleaned,
            visibility,
            reason: reason.into(),
            terms,
            flat_modifier,
            total,
            is_critical_success: primary_d20 == Some(20),
            is_critical_failure: primary_d20 == Some(1),
        })
    }

    fn roll_dice_token(&mut self, sign: i32, token: &str) -> Result<SingleTermResult, DiceError> {
        let lower = token.to_ascii_lowercase();
        let (count_str, rest) = lower
            .split_once('d')
            .ok_or_else(|| DiceError::InvalidTerm(token.to_string()))?;

        let count = if count_str.is_empty() {
            1
        } else {
            count_str
                .parse::<u32>()
                .map_err(|_| DiceError::InvalidTerm(token.to_string()))?
        };

        if !(1..=100).contains(&count) {
            return Err(DiceError::InvalidCount(count));
        }

        let (sides_str, keep_mode) = if let Some((s, k)) = rest.split_once("kh") {
            let keep_n = k
                .parse::<u32>()
                .map_err(|_| DiceError::InvalidTerm(token.to_string()))?;
            (s, KeepMode::KeepHighest(keep_n))
        } else if let Some((s, k)) = rest.split_once("kl") {
            let keep_n = k
                .parse::<u32>()
                .map_err(|_| DiceError::InvalidTerm(token.to_string()))?;
            (s, KeepMode::KeepLowest(keep_n))
        } else {
            (rest, KeepMode::All)
        };

        let sides = sides_str
            .parse::<u32>()
            .map_err(|_| DiceError::InvalidTerm(token.to_string()))?;
        if !(2..=1000).contains(&sides) {
            return Err(DiceError::InvalidSides(sides));
        }

        let mut raw_rolls = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let roll = self.rng.random_range(1..=sides);
            raw_rolls.push(roll);
        }

        let mut sorted = raw_rolls.clone();
        let kept_rolls = match keep_mode {
            KeepMode::All => raw_rolls.clone(),
            KeepMode::KeepHighest(k) => {
                sorted.sort_unstable_by(|a, b| b.cmp(a));
                sorted.into_iter().take(k as usize).collect()
            }
            KeepMode::KeepLowest(k) => {
                sorted.sort_unstable();
                sorted.into_iter().take(k as usize).collect()
            }
        };

        let sum: u32 = kept_rolls.iter().sum();
        let subtotal = sign * (sum as i32);

        Ok(SingleTermResult {
            sign,
            count,
            sides,
            keep_mode,
            raw_rolls,
            kept_rolls,
            subtotal,
        })
    }
}

fn split_signed_tokens(expr: &str) -> Result<Vec<(i32, String)>, DiceError> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut sign = 1;

    for (idx, ch) in expr.chars().enumerate() {
        if ch == '+' || ch == '-' {
            if idx == 0 {
                sign = if ch == '-' { -1 } else { 1 };
                continue;
            }
            if current.is_empty() {
                return Err(DiceError::InvalidTerm(expr.to_string()));
            }
            tokens.push((sign, std::mem::take(&mut current)));
            sign = if ch == '-' { -1 } else { 1 };
        } else {
            current.push(ch);
        }
    }

    if current.is_empty() {
        return Err(DiceError::InvalidTerm(expr.to_string()));
    }
    tokens.push((sign, current));
    Ok(tokens)
}

/// Projects a `DiceRollOutcome` for a specific connected recipient based on RBAC (`recipient_role`)
/// and `outcome.visibility` (`Public`, `GmOnly`, or `BlindGm`).
///
/// Returns `None` when the recipient is not authorized to know that the roll occurred, or a
/// `blind_masked: true` envelope with `total: None` when echoing a `BlindGm` roll back to the roller.
pub fn project_roll_for_recipient(
    outcome: &DiceRollOutcome,
    recipient_user_id: Uuid,
    recipient_role: CampaignRole,
) -> Option<ProjectedDiceRoll> {
    let is_gm = recipient_role == CampaignRole::Gm;
    match outcome.visibility {
        RollVisibility::Public => Some(ProjectedDiceRoll {
            roll_id: outcome.roll_id,
            roller_user_id: outcome.roller_user_id,
            expression: outcome.expression.clone(),
            visibility: outcome.visibility,
            reason: outcome.reason.clone(),
            blind_masked: false,
            terms: outcome.terms.clone(),
            flat_modifier: outcome.flat_modifier,
            total: Some(outcome.total),
            is_critical_success: Some(outcome.is_critical_success),
            is_critical_failure: Some(outcome.is_critical_failure),
        }),
        RollVisibility::GmOnly => {
            if is_gm || recipient_user_id == outcome.roller_user_id {
                Some(ProjectedDiceRoll {
                    roll_id: outcome.roll_id,
                    roller_user_id: outcome.roller_user_id,
                    expression: outcome.expression.clone(),
                    visibility: outcome.visibility,
                    reason: outcome.reason.clone(),
                    blind_masked: false,
                    terms: outcome.terms.clone(),
                    flat_modifier: outcome.flat_modifier,
                    total: Some(outcome.total),
                    is_critical_success: Some(outcome.is_critical_success),
                    is_critical_failure: Some(outcome.is_critical_failure),
                })
            } else {
                None
            }
        }
        RollVisibility::BlindGm => {
            if is_gm {
                Some(ProjectedDiceRoll {
                    roll_id: outcome.roll_id,
                    roller_user_id: outcome.roller_user_id,
                    expression: outcome.expression.clone(),
                    visibility: outcome.visibility,
                    reason: outcome.reason.clone(),
                    blind_masked: false,
                    terms: outcome.terms.clone(),
                    flat_modifier: outcome.flat_modifier,
                    total: Some(outcome.total),
                    is_critical_success: Some(outcome.is_critical_success),
                    is_critical_failure: Some(outcome.is_critical_failure),
                })
            } else if recipient_user_id == outcome.roller_user_id {
                Some(ProjectedDiceRoll {
                    roll_id: outcome.roll_id,
                    roller_user_id: outcome.roller_user_id,
                    expression: outcome.expression.clone(),
                    visibility: outcome.visibility,
                    reason: outcome.reason.clone(),
                    blind_masked: true,
                    terms: Vec::new(),
                    flat_modifier: outcome.flat_modifier,
                    total: None,
                    is_critical_success: None,
                    is_critical_failure: None,
                })
            } else {
                None
            }
        }
    }
}
