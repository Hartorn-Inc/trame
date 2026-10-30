//! Generic `GameSystemPack` Formula Evaluator (`derivedDAG`),
//! 5-Phase `ActiveEffect` Stacking Pipeline (`BASE -> ADD -> MULTIPLY -> OVERRIDE -> CLAMP`),
//! and Damage/Resistance Calculator (`02-GAME-ENGINE-AND-DND5E.md`).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RulesEngineError {
    #[error("cyclic dependency detected in derivedDAG involving '{0}'")]
    CyclicDependency(String),
    #[error("formula parse error in '{target}': {reason}")]
    FormulaParseError { target: String, reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModifierPhase {
    Base = 1,
    Add = 2,
    Multiply = 3,
    Override = 4,
    ClampMin = 5,
    ClampMax = 6,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttributeModifier {
    pub target: String,
    pub phase: ModifierPhase,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveEffect {
    pub id: Uuid,
    /// Canonical source name (e.g., `"Spell:Bless"`, `"Feat:ShieldMaster"`).
    /// Duplicate active effects with the same `source_name` do not stack (`02-GAME-ENGINE-AND-DND5E.md` §3).
    pub source_name: String,
    pub enabled: bool,
    pub duration_rounds_remaining: Option<u32>,
    pub concentration_caster_id: Option<Uuid>,
    pub modifiers: Vec<AttributeModifier>,
}

/// Evaluates topological `derivedDAG` formulas and applies the 5-phase `ActiveEffect` modifier pipeline.
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

/// Applies the strict 5-phase pipeline:
/// `Phase 1 (BASE)` -> `Phase 2 (ADD)` -> `Phase 3 (MULTIPLY)` -> `Phase 4 (OVERRIDE)` -> `Phase 5 (CLAMP)`
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
/// variables (`abilities.str.score`), and functions (`floor`, `ceil`, `round`, `min`, `max`, `abs`).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DamageAffinity {
    Normal,
    Resistant,
    Vulnerable,
    Immune,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DamageResolution {
    pub final_damage: i32,
    pub temp_hp_absorbed: i32,
    pub hp_lost: i32,
    pub new_hp: i32,
    pub new_temp_hp: i32,
    pub instant_death: bool,
    pub unconscious: bool,
    /// If the target is concentrating on a spell and took damage (`hp_lost + temp_hp_absorbed > 0`),
    /// equals `Some(max(10, floor(final_damage / 2)))`.
    pub concentration_check_dc: Option<i32>,
}

/// Resolves D&D 5e / generic damage mitigation (`IMMUNE -> RESISTANT -> VULNERABLE`),
/// Temporary HP absorption, Instant Death, and Concentration DC (`02-GAME-ENGINE-AND-DND5E.md` §4).
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
