use rand::{RngExt, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use trame_engine::commands::CampaignRole;
use uuid::Uuid;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DiceError {
    #[error("Empty dice expression")]
    EmptyExpression,
    #[error("Invalid dice term: {0}")]
    InvalidTerm(String),
    #[error("Dice count must be between 1 and 100, got {0}")]
    InvalidCount(u32),
    #[error("Dice sides must be between 2 and 1000, got {0}")]
    InvalidSides(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RollVisibility {
    Public,
    GmOnly,
    BlindGm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeepMode {
    All,
    KeepHighest(u32),
    KeepLowest(u32),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SingleTermResult {
    pub sign: i32,
    pub count: u32,
    pub sides: u32,
    pub keep_mode: KeepMode,
    pub raw_rolls: Vec<u32>,
    pub kept_rolls: Vec<u32>,
    pub subtotal: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiceRollOutcome {
    pub roll_id: Uuid,
    pub roller_user_id: Uuid,
    pub expression: String,
    pub visibility: RollVisibility,
    pub reason: String,
    pub terms: Vec<SingleTermResult>,
    pub flat_modifier: i32,
    pub total: i32,
    pub is_critical_success: bool,
    pub is_critical_failure: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectedDiceRoll {
    pub roll_id: Uuid,
    pub roller_user_id: Uuid,
    pub expression: String,
    pub visibility: RollVisibility,
    pub reason: String,
    /// True when a Blind GM roll is echoed back to the rolling player without revealing the outcome.
    pub blind_masked: bool,
    pub terms: Vec<SingleTermResult>,
    pub flat_modifier: i32,
    pub total: Option<i32>,
    pub is_critical_success: Option<bool>,
    pub is_critical_failure: Option<bool>,
}

pub struct SeededDiceRoller {
    rng: ChaCha20Rng,
}

impl SeededDiceRoller {
    pub fn from_os_csprng() -> Self {
        let mut seed = [0u8; 32];
        let mut os_rng = rand::rng();
        os_rng.fill(&mut seed);
        Self {
            rng: ChaCha20Rng::from_seed(seed),
        }
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            rng: ChaCha20Rng::from_seed(seed),
        }
    }

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

/// Projects a dice roll outcome for a specific connected recipient based on RBAC and roll visibility.
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
