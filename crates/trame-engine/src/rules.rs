//! ============================================================================
//! DERIVED DAG FORMULA EVALUATOR & 5-PHASE ACTIVE EFFECTS (rules.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Provides the system-agnostic rules evaluation engine for character and
//! monster attributes: Kahn's topological sort over `derivedDAG` formulas, a
//! safe recursive-descent arithmetic expression evaluator (`eval_formula_expr`),
//! the deterministic 5-phase `ActiveEffect` modifier pipeline
//! (`BASE -> ADD -> MULTIPLY -> OVERRIDE -> CLAMP`), and the D&D 5e damage,
//! Temporary HP, Instant Death, and Concentration DC calculator
//! (`resolve_damage_application`).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Cycle Detection in derivedDAG`:
//!      - `topological_sort_formulas` verifies that every formula dependency
//!        resolves to a Directed Acyclic Graph (DAG). Any cyclic dependency
//!        fails closed with `RulesEngineError::CyclicDependency` before
//!        evaluation begins.
//!   2. `Same-Source Non-Stacking Rule`:
//!      - Duplicate enabled `ActiveEffect` instances sharing the same canonical
//!        `source_name` (e.g., two `"Spell:ShieldOfFaith"` buffs) are
//!        deduplicated prior to phase resolution so identical spells cannot
//!        stack (`02-GAME-ENGINE-AND-DND5E.md` §3).
//!   3. `Strict 5-Phase Modifier Ordering`:
//!      - Every attribute resolves in fixed order:
//!        `Phase 1 (Base: max)` -> `Phase 2 (Add: sum)` -> `Phase 3 (Multiply: product)`
//!        -> `Phase 4 (Override: max)` -> `Phase 5 (ClampMin / ClampMax)`.
//!   4. `Sandboxed Expression Parser (No eval/JIT)`:
//!      - `eval_formula_expr` uses a zero-unsafe recursive-descent parser with
//!        explicit division-by-zero protection (`|denom| < 1e-12`).
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `evaluate_actor_attributes(base_attributes, derived_formulas, active_effects)`
//!     ├── 1. Deduplicate enabled `ActiveEffect` entries by `source_name`.
//!     ├── 2. Topologically sort `derived_formulas` via Kahn's algorithm.
//!     ├── 3. Apply `apply_5_phase_pipeline` to all base attribute keys.
//!     ├── 4. Evaluate each derived formula in topological order & apply 5-phase modifiers.
//!     └── 5. Materialize any orphan modifier targets starting from `0.0`.
//! ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use thiserror::Error;
use uuid::Uuid;

/// Errors returned when evaluating an actor's `derivedDAG` formulas or modifier pipeline.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RulesEngineError {
    /// A cycle was detected in the `derivedDAG` formula graph involving the named attribute key.
    #[error("cyclic dependency detected in derivedDAG involving '{0}'")]
    CyclicDependency(String),
    /// A formula expression failed lexical tokenization or recursive-descent parsing.
    #[error("formula parse error in '{target}': {reason}")]
    FormulaParseError {
        /// Attribute key whose formula failed to parse.
        target: String,
        /// Human-readable syntax or arithmetic error description.
        reason: String,
    },
}

/// Canonical execution phase within the 5-phase attribute modifier pipeline (`02-GAME-ENGINE-AND-DND5E.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModifierPhase {
    /// Phase 1: Raises the initial base value if `modifier.value > base` (e.g., *Barkskin* or *Mage Armor* base AC).
    Base = 1,
    /// Phase 2: Adds a signed flat bonus or penalty to the running sum (e.g., *Shield of Faith* `+2`).
    Add = 2,
    /// Phase 3: Multiplies the `(base + add_sum)` intermediate total by `modifier.value` (e.g., *Haste* `x2` speed).
    Multiply = 3,
    /// Phase 4: Replaces the computed value outright, keeping the highest override when multiple collide (e.g., *Gauntlets of Ogre Power* `= 19`).
    Override = 4,
    /// Phase 5a: Enforces a lower bound `value = value.max(clamp_min)` after overrides.
    ClampMin = 5,
    /// Phase 5b: Enforces an upper bound `value = value.min(clamp_max)` (e.g., ability score cap `20`).
    ClampMax = 6,
}

/// Single attribute modification entry belonging to an `ActiveEffect`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttributeModifier {
    /// Dot-separated attribute path targeted by this modifier (e.g., `"ac.base"`, `"abilities.str.score"`).
    pub target: String,
    /// Pipeline phase during which `value` is applied.
    pub phase: ModifierPhase,
    /// Numeric operand applied at `phase`.
    pub value: f64,
}

/// Buff, debuff, condition, or equipment effect attached to a token or actor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveEffect {
    /// Unique identifier for this active effect instance.
    pub id: Uuid,
    /// Canonical source name (e.g., `"Spell:Bless"`, `"Feat:ShieldMaster"`).
    /// Duplicate active effects with the same `source_name` do not stack (`02-GAME-ENGINE-AND-DND5E.md` §3).
    pub source_name: String,
    /// Whether the effect is currently active (`false` = suppressed/unequipped).
    pub enabled: bool,
    /// Optional remaining combat duration in rounds (`None` = indefinite/permanent).
    pub duration_rounds_remaining: Option<u32>,
    /// Optional token ID of the caster maintaining concentration on this effect.
    pub concentration_caster_id: Option<Uuid>,
    /// Ordered list of attribute modifiers granted by this effect.
    pub modifiers: Vec<AttributeModifier>,
}

/// Evaluates topological `derivedDAG` formulas and applies the 5-phase `ActiveEffect` modifier pipeline.
///
/// Deduplicates enabled effects by `source_name`, applies modifiers to `base_attributes`,
/// evaluates `derived_formulas` in deterministic topological order, and returns the complete
/// resolved attribute map. Fails closed with `RulesEngineError` on cycles or syntax errors.
pub fn evaluate_actor_attributes(
    base_attributes: &BTreeMap<String, f64>,
    derived_formulas: &BTreeMap<String, String>,
    active_effects: &[ActiveEffect],
) -> Result<BTreeMap<String, f64>, RulesEngineError> {
    // Deduplicate active effects by `source_name` (keep highest magnitude or first enabled)
    let mut deduplicated_effects: Vec<&ActiveEffect> = Vec::new();
    let mut seen_sources: HashSet<&str> = HashSet::new();
    for eff in active_effects {
        if !eff.enabled {
            continue;
        }
        if seen_sources.insert(eff.source_name.as_str()) {
            deduplicated_effects.push(eff);
        }
    }

    let order = topological_sort_formulas(derived_formulas)?;
    let mut env = base_attributes.clone();

    // Apply 5-phase modifiers to base attributes first
    let all_base_keys: Vec<String> = env.keys().cloned().collect();
    for key in all_base_keys {
        let initial = env.get(&key).copied().unwrap_or(0.0);
        let modified = apply_5_phase_pipeline(&key, initial, &deduplicated_effects);
        env.insert(key, modified);
    }

    // Evaluate derivedDAG in topological order, then apply 5-phase modifiers to each derived key
    for key in order {
        if let Some(expr) = derived_formulas.get(&key) {
            let raw_val = eval_formula_expr(expr, &env).map_err(|reason| {
                RulesEngineError::FormulaParseError {
                    target: key.clone(),
                    reason,
                }
            })?;
            let final_val = apply_5_phase_pipeline(&key, raw_val, &deduplicated_effects);
            env.insert(key, final_val);
        }
    }

    // Also apply modifiers targeting keys not present in base or derived
    for eff in &deduplicated_effects {
        for m in &eff.modifiers {
            if !env.contains_key(&m.target) {
                let val = apply_5_phase_pipeline(&m.target, 0.0, &deduplicated_effects);
                env.insert(m.target.clone(), val);
            }
        }
    }

    Ok(env)
}

/// Applies the strict 5-phase modifier pipeline to `target_key` starting from `initial_base`:
/// `Phase 1 (BASE)` -> `Phase 2 (ADD)` -> `Phase 3 (MULTIPLY)` -> `Phase 4 (OVERRIDE)` -> `Phase 5 (CLAMP)`.
pub fn apply_5_phase_pipeline(
    target_key: &str,
    initial_base: f64,
    effects: &[&ActiveEffect],
) -> f64 {
    let mut base = initial_base;
    let mut add_sum = 0.0;
    let mut mul_product = 1.0;
    let mut override_val: Option<f64> = None;
    let mut clamp_min: Option<f64> = None;
    let mut clamp_max: Option<f64> = None;

    for eff in effects {
        for m in &eff.modifiers {
            if m.target != target_key {
                continue;
            }
            match m.phase {
                ModifierPhase::Base => {
                    if m.value > base {
                        base = m.value;
                    }
                }
                ModifierPhase::Add => {
                    add_sum += m.value;
                }
                ModifierPhase::Multiply => {
                    mul_product *= m.value;
                }
                ModifierPhase::Override => {
                    override_val = Some(override_val.map_or(m.value, |prev| prev.max(m.value)));
                }
                ModifierPhase::ClampMin => {
                    clamp_min = Some(clamp_min.map_or(m.value, |prev| prev.max(m.value)));
                }
                ModifierPhase::ClampMax => {
                    clamp_max = Some(clamp_max.map_or(m.value, |prev| prev.min(m.value)));
                }
            }
        }
    }

    let mut value = (base + add_sum) * mul_product;
    if let Some(ov) = override_val {
        value = ov;
    }
    if let Some(min_v) = clamp_min {
        value = value.max(min_v);
    }
    if let Some(max_v) = clamp_max {
        value = value.min(max_v);
    }
    value
}

fn topological_sort_formulas(
    formulas: &BTreeMap<String, String>,
) -> Result<Vec<String>, RulesEngineError> {
    let formula_keys: HashSet<&String> = formulas.keys().collect();
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut dependents: HashMap<String, Vec<String>> = HashMap::new();

    for (target, expr) in formulas {
        in_degree.entry(target.clone()).or_insert(0);
        for dep in extract_identifiers(expr) {
            if formula_keys.contains(&dep) {
                *in_degree.entry(target.clone()).or_insert(0) += 1;
                dependents.entry(dep).or_default().push(target.clone());
            }
        }
    }

    let mut queue: VecDeque<String> = in_degree
        .iter()
        .filter(|&(_, &deg)| deg == 0)
        .map(|(k, _)| k.clone())
        .collect();
    // Sort queue for deterministic ordering
    let mut sorted_init: Vec<String> = queue.drain(..).collect();
    sorted_init.sort();
    queue.extend(sorted_init);

    let mut order = Vec::with_capacity(formulas.len());
    while let Some(node) = queue.pop_front() {
        order.push(node.clone());
        if let Some(children) = dependents.get(&node) {
            let mut newly_ready = Vec::new();
            for child in children {
                if let Some(deg) = in_degree.get_mut(child) {
                    *deg -= 1;
                    if *deg == 0 {
                        newly_ready.push(child.clone());
                    }
                }
            }
            newly_ready.sort();
            queue.extend(newly_ready);
        }
    }

    if order.len() != formulas.len() {
        let cycle_node = in_degree
            .into_iter()
            .find(|&(_, deg)| deg > 0)
            .map(|(k, _)| k)
            .unwrap_or_else(|| "unknown".to_string());
        return Err(RulesEngineError::CyclicDependency(cycle_node));
    }

    Ok(order)
}

fn extract_identifiers(expr: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut current = String::new();
    for ch in expr.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            current.push(ch);
        } else if !current.is_empty() {
            if !is_builtin_fn_or_number(&current) {
                out.insert(current.clone());
            }
            current.clear();
        }
    }
    if !current.is_empty() && !is_builtin_fn_or_number(&current) {
        out.insert(current);
    }
    out
}

fn is_builtin_fn_or_number(token: &str) -> bool {
    token.parse::<f64>().is_ok()
        || matches!(token, "floor" | "ceil" | "round" | "min" | "max" | "abs")
}

/// Safe recursive-descent arithmetic evaluator supporting `+`, `-`, `*`, `/`, parentheses,
/// variables (`abilities.str.score`), and built-in functions (`floor`, `ceil`, `round`, `min`, `max`, `abs`).
///
/// Missing variables in `env` default to `0.0`. Rejects division by zero (`|denom| < 1e-12`)
/// and malformed tokens with an `Err(String)`.
pub fn eval_formula_expr(expr: &str, env: &BTreeMap<String, f64>) -> Result<f64, String> {
    let tokens = tokenize_expr(expr)?;
    let mut pos = 0usize;
    let val = parse_add_sub(&tokens, &mut pos, env)?;
    if pos < tokens.len() {
        return Err(format!("unexpected token at position {pos}"));
    }
    Ok(val)
}

#[derive(Debug, Clone, PartialEq)]
enum ExprToken {
    Number(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    LParen,
    RParen,
    Comma,
}

fn tokenize_expr(expr: &str) -> Result<Vec<ExprToken>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = expr.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        match ch {
            '+' => {
                tokens.push(ExprToken::Plus);
                i += 1;
            }
            '-' => {
                tokens.push(ExprToken::Minus);
                i += 1;
            }
            '*' => {
                tokens.push(ExprToken::Star);
                i += 1;
            }
            '/' => {
                tokens.push(ExprToken::Slash);
                i += 1;
            }
            '(' => {
                tokens.push(ExprToken::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(ExprToken::RParen);
                i += 1;
            }
            ',' => {
                tokens.push(ExprToken::Comma);
                i += 1;
            }
            c if c.is_ascii_digit() => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let s: String = chars[start..i].iter().collect();
                let n = s
                    .parse::<f64>()
                    .map_err(|_| format!("invalid number '{s}'"))?;
                tokens.push(ExprToken::Number(n));
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.')
                {
                    i += 1;
                }
                let s: String = chars[start..i].iter().collect();
                tokens.push(ExprToken::Ident(s));
            }
            other => return Err(format!("unexpected character '{other}'")),
        }
    }
    Ok(tokens)
}

fn parse_add_sub(
    tokens: &[ExprToken],
    pos: &mut usize,
    env: &BTreeMap<String, f64>,
) -> Result<f64, String> {
    let mut left = parse_mul_div(tokens, pos, env)?;
    while *pos < tokens.len() {
        match tokens[*pos] {
            ExprToken::Plus => {
                *pos += 1;
                left += parse_mul_div(tokens, pos, env)?;
            }
            ExprToken::Minus => {
                *pos += 1;
                left -= parse_mul_div(tokens, pos, env)?;
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_mul_div(
    tokens: &[ExprToken],
    pos: &mut usize,
    env: &BTreeMap<String, f64>,
) -> Result<f64, String> {
    let mut left = parse_unary(tokens, pos, env)?;
    while *pos < tokens.len() {
        match tokens[*pos] {
            ExprToken::Star => {
                *pos += 1;
                left *= parse_unary(tokens, pos, env)?;
            }
            ExprToken::Slash => {
                *pos += 1;
                let denom = parse_unary(tokens, pos, env)?;
                if denom.abs() < 1e-12 {
                    return Err("division by zero".to_string());
                }
                left /= denom;
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_unary(
    tokens: &[ExprToken],
    pos: &mut usize,
    env: &BTreeMap<String, f64>,
) -> Result<f64, String> {
    if *pos < tokens.len() {
        if tokens[*pos] == ExprToken::Minus {
            *pos += 1;
            return Ok(-parse_unary(tokens, pos, env)?);
        }
        if tokens[*pos] == ExprToken::Plus {
            *pos += 1;
            return parse_unary(tokens, pos, env);
        }
    }
    parse_primary(tokens, pos, env)
}

fn parse_primary(
    tokens: &[ExprToken],
    pos: &mut usize,
    env: &BTreeMap<String, f64>,
) -> Result<f64, String> {
    if *pos >= tokens.len() {
        return Err("unexpected end of expression".to_string());
    }
    match &tokens[*pos] {
        ExprToken::Number(n) => {
            *pos += 1;
            Ok(*n)
        }
        ExprToken::LParen => {
            *pos += 1;
            let val = parse_add_sub(tokens, pos, env)?;
            if *pos >= tokens.len() || tokens[*pos] != ExprToken::RParen {
                return Err("missing closing parenthesis".to_string());
            }
            *pos += 1;
            Ok(val)
        }
        ExprToken::Ident(name) => {
            let ident = name.clone();
            *pos += 1;
            if *pos < tokens.len() && tokens[*pos] == ExprToken::LParen {
                *pos += 1;
                let mut args = Vec::new();
                if *pos < tokens.len() && tokens[*pos] != ExprToken::RParen {
                    loop {
                        args.push(parse_add_sub(tokens, pos, env)?);
                        if *pos < tokens.len() && tokens[*pos] == ExprToken::Comma {
                            *pos += 1;
                        } else {
                            break;
                        }
                    }
                }
                if *pos >= tokens.len() || tokens[*pos] != ExprToken::RParen {
                    return Err(format!("missing closing ')' for function '{ident}'"));
                }
                *pos += 1;
                eval_builtin_fn(&ident, &args)
            } else {
                Ok(env.get(&ident).copied().unwrap_or(0.0))
            }
        }
        other => Err(format!("unexpected token {other:?}")),
    }
}

fn eval_builtin_fn(name: &str, args: &[f64]) -> Result<f64, String> {
    match name {
        "floor" if args.len() == 1 => Ok(args[0].floor()),
        "ceil" if args.len() == 1 => Ok(args[0].ceil()),
        "round" if args.len() == 1 => Ok(args[0].round()),
        "abs" if args.len() == 1 => Ok(args[0].abs()),
        "min" if !args.is_empty() => Ok(args.iter().copied().fold(f64::INFINITY, f64::min)),
        "max" if !args.is_empty() => Ok(args.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
        _ => Err(format!(
            "unsupported function call '{name}' with {} args",
            args.len()
        )),
    }
}

/// Target affinity toward a specific damage type (`02-GAME-ENGINE-AND-DND5E.md` §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DamageAffinity {
    /// Unmodified damage (`final_damage = raw`).
    Normal,
    /// Halves incoming damage rounded down (`final_damage = raw / 2`).
    Resistant,
    /// Doubles incoming damage (`final_damage = raw * 2`).
    Vulnerable,
    /// Reduces incoming damage to `0`.
    Immune,
}

/// Complete outcome of applying damage to a token, including Temporary HP depletion,
/// Instant Death detection, and Concentration saving throw DC calculation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DamageResolution {
    /// Post-mitigation damage points (`>= 0`) after applying `DamageAffinity`.
    pub final_damage: i32,
    /// Amount of `final_damage` absorbed by the target's Temporary HP (`>= 0`).
    pub temp_hp_absorbed: i32,
    /// Actual Hit Points subtracted from the target's `current_hp` (`>= 0`).
    pub hp_lost: i32,
    /// Resulting Hit Points after damage (`0..=max_hp`).
    pub new_hp: i32,
    /// Resulting Temporary Hit Points after absorption (`>= 0`).
    pub new_temp_hp: i32,
    /// `true` when `new_hp == 0` and remaining overflow damage `>= max_hp` (5e Massive Damage rule).
    pub instant_death: bool,
    /// `true` when `new_hp == 0` and `instant_death == false`.
    pub unconscious: bool,
    /// If the target is concentrating on a spell, survived (`new_hp > 0`), and took damage
    /// (`final_damage > 0`), equals `Some(max(10, floor(final_damage / 2)))`.
    pub concentration_check_dc: Option<i32>,
}

/// Resolves D&D 5e / generic damage mitigation (`IMMUNE -> RESISTANT -> VULNERABLE`),
/// Temporary HP absorption, Massive Damage Instant Death, and Concentration Constitution save DC
/// (`02-GAME-ENGINE-AND-DND5E.md` §4).
pub fn resolve_damage_application(
    raw_damage: i32,
    affinity: DamageAffinity,
    current_hp: i32,
    max_hp: i32,
    current_temp_hp: i32,
    is_concentrating: bool,
) -> DamageResolution {
    let raw = raw_damage.max(0);
    let final_damage = match affinity {
        DamageAffinity::Immune => 0,
        DamageAffinity::Resistant => raw / 2,
        DamageAffinity::Vulnerable => raw * 2,
        DamageAffinity::Normal => raw,
    };

    let temp_hp_absorbed = final_damage.min(current_temp_hp.max(0));
    let new_temp_hp = (current_temp_hp - temp_hp_absorbed).max(0);
    let remaining_after_temp = final_damage - temp_hp_absorbed;

    let hp_lost = remaining_after_temp.min(current_hp.max(0));
    let overflow = remaining_after_temp - hp_lost;
    let new_hp = (current_hp - hp_lost).max(0);

    let instant_death = new_hp == 0 && overflow >= max_hp.max(1);
    let unconscious = new_hp == 0 && !instant_death;

    let concentration_check_dc = if is_concentrating && final_damage > 0 && new_hp > 0 {
        Some(10.max(final_damage / 2))
    } else {
        None
    };

    DamageResolution {
        final_damage,
        temp_hp_absorbed,
        hp_lost,
        new_hp,
        new_temp_hp,
        instant_death,
        unconscious,
        concentration_check_dc,
    }
}
