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
//! (`BASE -> ADD -> MULTIPLY -> OVERRIDE -> CLAMP`), the D&D 5e damage,
//! Temporary HP, Instant Death, and Concentration DC calculator
//! (`resolve_damage_application`), and the death saving throw state machine
//! (`resolve_death_save`).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Cycle Detection in derivedDAG`:
//!      - `topological_sort_formulas` verifies that every formula dependency
//!        resolves to a Directed Acyclic Graph (DAG). Any cyclic dependency
//!        fails closed with `RulesEngineError::CyclicDependency` before
//!        evaluation begins.
//!   2. `Same-Source Non-Stacking Rule (Strongest Wins)`:
//!      - Duplicate enabled `ActiveEffect` instances sharing the same canonical
//!        `source_name` (e.g., two `"Spell:ShieldOfFaith"` buffs) are
//!        deduplicated prior to phase resolution so identical spells cannot
//!        stack. The instance with the largest magnitude (sum of absolute
//!        modifier values) is kept; ties keep the earliest instance
//!        (`02-GAME-ENGINE-AND-DND5E.md` §3).
//!   3. `Strict 5-Phase Modifier Ordering`:
//!      - Every attribute resolves in fixed order:
//!        `Phase 1 (Base: max)` -> `Phase 2 (Add: sum)` -> `Phase 3 (Multiply: product)`
//!        -> `Phase 4 (Override: max)` -> `Phase 5 (ClampMin / ClampMax)`.
//!      - The Base phase is exclusive: the attribute's own derived formula and
//!        every Base-phase modifier (numeric `value` or evaluated `formula`)
//!        are candidates, and only the maximum survives (e.g., Unarmored
//!        Defense `10 + dex_mod + con_mod` versus worn armor).
//!   4. `Sandboxed Expression Parser (No eval/JIT)`:
//!      - `eval_formula_expr` uses a zero-unsafe recursive-descent parser with
//!        explicit division-by-zero protection (`|denom| < 1e-12`).
//!   5. `Fail-Closed Unknown Variables`:
//!      - A formula referencing a variable absent from the evaluation
//!        environment fails with `RulesEngineError::UnknownVariable` instead of
//!        silently evaluating to `0`, so typos in `system.json` surface at once.
//!   6. `Saturating Damage Arithmetic`:
//!      - `DamageAffinity::Vulnerable` doubles with `i32::saturating_mul` so a
//!        hostile `raw_damage` near `i32::MAX` cannot overflow or panic.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `evaluate_actor_attributes(base_attributes, derived_formulas, active_effects)`
//!     ├── 1. Deduplicate enabled `ActiveEffect` entries by `source_name` (largest magnitude wins).
//!     ├── 2. Topologically sort `derived_formulas` (plus modifier formula dependencies) via Kahn's algorithm.
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
    /// A formula referenced a variable that is neither a base attribute nor a derived key.
    #[error("unknown variable '{variable}' in formula for '{target}'")]
    UnknownVariable {
        /// Attribute key whose formula referenced the unknown variable.
        target: String,
        /// Name of the unresolved variable.
        variable: String,
    },
}

/// Failure raised by `eval_formula_expr` for a single arithmetic expression.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum FormulaError {
    /// Lexical, syntactic, or arithmetic failure (e.g., division by zero).
    #[error("{0}")]
    Syntax(String),
    /// The expression referenced a variable absent from the evaluation environment.
    #[error("unknown variable '{0}'")]
    UnknownVariable(String),
}

impl FormulaError {
    fn into_rules_error(self, target: &str) -> RulesEngineError {
        match self {
            FormulaError::Syntax(reason) => RulesEngineError::FormulaParseError {
                target: target.to_string(),
                reason,
            },
            FormulaError::UnknownVariable(variable) => RulesEngineError::UnknownVariable {
                target: target.to_string(),
                variable,
            },
        }
    }
}

/// Canonical execution phase within the 5-phase attribute modifier pipeline (`02-GAME-ENGINE-AND-DND5E.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct AttributeModifier {
    /// Dot-separated attribute path targeted by this modifier (e.g., `"ac.base"`, `"abilities.str.score"`).
    pub target: String,
    /// Pipeline phase during which `value` is applied.
    pub phase: ModifierPhase,
    /// Numeric operand applied at `phase`. Also used as this modifier's magnitude when
    /// same-named effects are deduplicated, even when `formula` is set.
    pub value: f64,
    /// Optional `derivedDAG` expression evaluated against the actor's attributes; when set,
    /// its result replaces `value` as the operand (e.g., Unarmored Defense
    /// `"10 + dex_mod + con_mod"` as a Base-phase candidate for `"ac"`).
    #[serde(default)]
    pub formula: Option<String>,
}

/// Bonus, penalty, condition, or equipment effect attached to a token or actor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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

/// Evaluates topological `derivedDAG` formulas over `base_attributes` without active effects.
///
/// Topologically orders `derived_formulas` and evaluates each pure arithmetic expression,
/// failing closed with `RulesEngineError` on circular dependencies or syntax errors.
pub fn evaluate_derived_dag(
    base_attributes: &BTreeMap<String, f64>,
    derived_formulas: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, f64>, RulesEngineError> {
    evaluate_actor_attributes(base_attributes, derived_formulas, &[])
}

/// Evaluates topological `derivedDAG` formulas and applies the 5-phase `ActiveEffect` modifier pipeline.
///
/// Deduplicates enabled effects by `source_name` (largest magnitude wins), applies modifiers to
/// `base_attributes`, evaluates `derived_formulas` in deterministic topological order, and returns
/// the complete resolved attribute map. Fails closed with `RulesEngineError` on cycles, syntax
/// errors, or unknown variables.
///
/// Modifier formulas targeting a base attribute are evaluated against the unmodified
/// `base_attributes`; modifier formulas targeting a derived key are ordered after the keys they
/// reference.
pub fn evaluate_actor_attributes(
    base_attributes: &BTreeMap<String, f64>,
    derived_formulas: &BTreeMap<String, String>,
    active_effects: &[ActiveEffect],
) -> Result<BTreeMap<String, f64>, RulesEngineError> {
    let deduplicated_effects = deduplicate_effects_by_source(active_effects);

    let mut modifier_formulas: Vec<(&str, &str)> = Vec::new();
    for eff in &deduplicated_effects {
        for m in &eff.modifiers {
            if let Some(formula) = &m.formula {
                modifier_formulas.push((m.target.as_str(), formula.as_str()));
            }
        }
    }
    let order = topological_sort_formulas(derived_formulas, &modifier_formulas)?;
    let mut env = base_attributes.clone();

    // Apply 5-phase modifiers to base attributes first
    for (key, initial) in base_attributes {
        let modified =
            apply_5_phase_pipeline(key, *initial, &deduplicated_effects, base_attributes)?;
        env.insert(key.clone(), modified);
    }

    // Evaluate derivedDAG in topological order, then apply 5-phase modifiers to each derived key
    for key in order {
        if let Some(expr) = derived_formulas.get(&key) {
            let raw_val =
                eval_formula_expr(expr, &env).map_err(|err| err.into_rules_error(&key))?;
            let final_val = apply_5_phase_pipeline(&key, raw_val, &deduplicated_effects, &env)?;
            env.insert(key, final_val);
        }
    }

    // Also apply modifiers targeting keys not present in base or derived
    for eff in &deduplicated_effects {
        for m in &eff.modifiers {
            if !env.contains_key(&m.target) {
                let val = apply_5_phase_pipeline(&m.target, 0.0, &deduplicated_effects, &env)?;
                env.insert(m.target.clone(), val);
            }
        }
    }

    Ok(env)
}

/// Keeps one enabled `ActiveEffect` per `source_name`: the instance with the largest magnitude
/// (sum of absolute modifier `value`s). Ties keep the earliest instance so the result is
/// deterministic for a given input order. Output preserves first-appearance order of sources.
fn deduplicate_effects_by_source(active_effects: &[ActiveEffect]) -> Vec<&ActiveEffect> {
    fn magnitude(eff: &ActiveEffect) -> f64 {
        eff.modifiers.iter().map(|m| m.value.abs()).sum()
    }

    let mut kept: Vec<&ActiveEffect> = Vec::new();
    let mut slot_by_source: HashMap<&str, usize> = HashMap::new();
    for eff in active_effects.iter().filter(|e| e.enabled) {
        match slot_by_source.get(eff.source_name.as_str()) {
            Some(&slot) => {
                if magnitude(eff) > magnitude(kept[slot]) {
                    kept[slot] = eff;
                }
            }
            None => {
                slot_by_source.insert(eff.source_name.as_str(), kept.len());
                kept.push(eff);
            }
        }
    }
    kept
}

/// Applies the strict 5-phase modifier pipeline to `target_key` starting from `initial_base`:
/// `Phase 1 (BASE)` -> `Phase 2 (ADD)` -> `Phase 3 (MULTIPLY)` -> `Phase 4 (OVERRIDE)` -> `Phase 5 (CLAMP)`.
///
/// Modifier operands come from `formula` (evaluated against `env`) when set, otherwise from
/// `value`. The Base phase is exclusive: `initial_base` and every Base candidate compete and the
/// maximum is kept. Fails with `RulesEngineError` when a modifier formula cannot be evaluated.
pub fn apply_5_phase_pipeline(
    target_key: &str,
    initial_base: f64,
    effects: &[&ActiveEffect],
    env: &BTreeMap<String, f64>,
) -> Result<f64, RulesEngineError> {
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
            let operand = match &m.formula {
                Some(formula) => eval_formula_expr(formula, env)
                    .map_err(|err| err.into_rules_error(target_key))?,
                None => m.value,
            };
            match m.phase {
                ModifierPhase::Base => {
                    base = base.max(operand);
                }
                ModifierPhase::Add => {
                    add_sum += operand;
                }
                ModifierPhase::Multiply => {
                    mul_product *= operand;
                }
                ModifierPhase::Override => {
                    override_val = Some(override_val.map_or(operand, |prev| prev.max(operand)));
                }
                ModifierPhase::ClampMin => {
                    clamp_min = Some(clamp_min.map_or(operand, |prev| prev.max(operand)));
                }
                ModifierPhase::ClampMax => {
                    clamp_max = Some(clamp_max.map_or(operand, |prev| prev.min(operand)));
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
    Ok(value)
}

fn topological_sort_formulas(
    formulas: &BTreeMap<String, String>,
    modifier_formulas: &[(&str, &str)],
) -> Result<Vec<String>, RulesEngineError> {
    let formula_keys: HashSet<&String> = formulas.keys().collect();
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut dependents: HashMap<String, Vec<String>> = HashMap::new();

    let mut edges: BTreeMap<&String, HashSet<String>> = BTreeMap::new();
    for (target, expr) in formulas {
        edges
            .entry(target)
            .or_default()
            .extend(extract_identifiers(expr));
    }
    for (target, expr) in modifier_formulas {
        if let Some((key, _)) = formulas.get_key_value(*target) {
            edges
                .entry(key)
                .or_default()
                .extend(extract_identifiers(expr));
        }
    }

    for (target, deps) in edges {
        in_degree.entry(target.clone()).or_insert(0);
        for dep in deps {
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
/// Variables missing from `env` fail with `FormulaError::UnknownVariable` rather than defaulting
/// to `0.0`. Rejects division by zero (`|denom| < 1e-12`) and malformed tokens with
/// `FormulaError::Syntax`.
pub fn eval_formula_expr(expr: &str, env: &BTreeMap<String, f64>) -> Result<f64, FormulaError> {
    let tokens = tokenize_expr(expr)?;
    let mut pos = 0usize;
    let val = parse_add_sub(&tokens, &mut pos, env)?;
    if pos < tokens.len() {
        return Err(syntax(format!("unexpected token at position {pos}")));
    }
    Ok(val)
}

fn syntax(reason: impl Into<String>) -> FormulaError {
    FormulaError::Syntax(reason.into())
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

fn tokenize_expr(expr: &str) -> Result<Vec<ExprToken>, FormulaError> {
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
                    .map_err(|_| syntax(format!("invalid number '{s}'")))?;
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
            other => return Err(syntax(format!("unexpected character '{other}'"))),
        }
    }
    Ok(tokens)
}

fn parse_add_sub(
    tokens: &[ExprToken],
    pos: &mut usize,
    env: &BTreeMap<String, f64>,
) -> Result<f64, FormulaError> {
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
) -> Result<f64, FormulaError> {
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
                    return Err(syntax("division by zero"));
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
) -> Result<f64, FormulaError> {
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
) -> Result<f64, FormulaError> {
    if *pos >= tokens.len() {
        return Err(syntax("unexpected end of expression"));
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
                return Err(syntax("missing closing parenthesis"));
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
                    return Err(syntax(format!(
                        "missing closing ')' for function '{ident}'"
                    )));
                }
                *pos += 1;
                eval_builtin_fn(&ident, &args)
            } else {
                env.get(&ident)
                    .copied()
                    .ok_or(FormulaError::UnknownVariable(ident))
            }
        }
        other => Err(syntax(format!("unexpected token {other:?}"))),
    }
}

fn eval_builtin_fn(name: &str, args: &[f64]) -> Result<f64, FormulaError> {
    match name {
        "floor" if args.len() == 1 => Ok(args[0].floor()),
        "ceil" if args.len() == 1 => Ok(args[0].ceil()),
        "round" if args.len() == 1 => Ok(args[0].round()),
        "abs" if args.len() == 1 => Ok(args[0].abs()),
        "min" if !args.is_empty() => Ok(args.iter().copied().fold(f64::INFINITY, f64::min)),
        "max" if !args.is_empty() => Ok(args.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
        _ => Err(syntax(format!(
            "unsupported function call '{name}' with {} args",
            args.len()
        ))),
    }
}

/// Target affinity toward a specific damage type (`02-GAME-ENGINE-AND-DND5E.md` §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DamageAffinity {
    /// Unmodified damage (`final_damage = raw`).
    Normal,
    /// Halves incoming damage rounded down (`final_damage = raw / 2`).
    Resistant,
    /// Doubles incoming damage with saturating math (`final_damage = raw.saturating_mul(2)`).
    Vulnerable,
    /// Reduces incoming damage to `0`.
    Immune,
}

/// Complete outcome of applying damage to a token, including Temporary HP depletion,
/// Instant Death detection, and Concentration saving throw DC calculation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
    /// `true` when `new_hp == 0` and remaining overflow damage `>= max_hp` (`InstantDeath`).
    /// Applies both when dropping to 0 HP and when an already-downed target is hit again.
    pub instant_death: bool,
    /// `true` when `new_hp == 0` and the target is not dead (`dead == false`).
    pub unconscious: bool,
    /// If the target is concentrating on a spell, survived (`new_hp > 0`), and took damage
    /// (`final_damage > 0`), equals `Some(min(30, max(10, floor(final_damage / 2))))`
    /// (SRD 5.2.1 caps the DC at `MAX_CONCENTRATION_DC`).
    pub concentration_check_dc: Option<i32>,
    /// `DeathSavingThrow` failures added by this hit (`0`, `1`, or `2` on a critical hit). Only a
    /// target already at 0 HP that loses HP-bound damage (after Temp HP) gains failures.
    pub death_save_failures_added: u8,
    /// Resulting death saving throw failure counter (`0..=3`).
    pub new_death_save_failures: u8,
    /// `true` when the target dies: `instant_death` or `new_death_save_failures == 3`.
    pub dead: bool,
}

/// Number of failed `DeathSavingThrow`s at which a creature dies.
pub const DEATH_SAVE_FAILURES_TO_DIE: u8 = 3;

/// Number of successful `DeathSavingThrow`s at which a creature becomes Stable.
pub const DEATH_SAVE_SUCCESSES_TO_STABILIZE: u8 = 3;

/// Result of one `DeathSavingThrow` d20 (`resolve_death_save`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DeathSaveOutcome {
    /// Success counter after the roll (`0..=3`; reset to `0` on Stable or a natural 20).
    pub successes: u8,
    /// Failure counter after the roll (`0..=3`; reset to `0` on Stable or a natural 20).
    pub failures: u8,
    /// Natural 20: the creature regains 1 Hit Point and wakes up.
    pub regains_hp: bool,
    /// Third success: the creature is Stable at 0 HP and stops rolling.
    pub stable: bool,
    /// Third failure: the creature dies.
    pub dead: bool,
}

/// Resolves one `DeathSavingThrow` d20 (SRD 5.2.1) from the current counters.
///
/// Resolution order: natural 20 regains 1 HP and resets both counters; natural 1 adds two
/// failures; `2..=9` adds one failure; `10..=19` adds one success. Counters cap at 3. Three
/// failures kill; three successes make the creature Stable, and becoming Stable resets both
/// counters to `0` (SRD: "reset to zero when you regain any Hit Points or become Stable").
/// `d20` outside `1..=20` is clamped, so a malformed value can never skip the rules.
pub fn resolve_death_save(successes: u8, failures: u8, d20: u8) -> DeathSaveOutcome {
    let d20 = d20.clamp(1, 20);
    if d20 == 20 {
        return DeathSaveOutcome {
            successes: 0,
            failures: 0,
            regains_hp: true,
            stable: false,
            dead: false,
        };
    }
    let (added_successes, added_failures) = match d20 {
        1 => (0, 2),
        2..=9 => (0, 1),
        _ => (1, 0),
    };
    let failures = failures
        .saturating_add(added_failures)
        .min(DEATH_SAVE_FAILURES_TO_DIE);
    let successes = successes
        .saturating_add(added_successes)
        .min(DEATH_SAVE_SUCCESSES_TO_STABILIZE);
    let dead = failures >= DEATH_SAVE_FAILURES_TO_DIE;
    let stable = !dead && successes >= DEATH_SAVE_SUCCESSES_TO_STABILIZE;
    DeathSaveOutcome {
        successes: if stable { 0 } else { successes },
        failures: if stable { 0 } else { failures },
        regains_hp: false,
        stable,
        dead,
    }
}

/// Lowest `ConcentrationCheckPrompt` DC (`10`), used when half the damage is smaller.
pub const MIN_CONCENTRATION_DC: i32 = 10;

/// Highest `ConcentrationCheckPrompt` DC (`30`, SRD 5.2.1), reached at 60+ damage.
pub const MAX_CONCENTRATION_DC: i32 = 30;

/// Damage left after one affinity, from a raw amount floored at `0` (`Resistant` rounds down).
pub fn mitigate_damage(raw_damage: i32, affinity: DamageAffinity) -> i32 {
    let raw = raw_damage.max(0);
    match affinity {
        DamageAffinity::Immune => 0,
        DamageAffinity::Resistant => raw / 2,
        DamageAffinity::Vulnerable => raw.saturating_mul(2),
        DamageAffinity::Normal => raw,
    }
}

/// Resolves D&D 5e / generic damage mitigation (`IMMUNE -> RESISTANT -> VULNERABLE`),
/// Temporary HP absorption, `InstantDeath`, death saving throw failures at 0 HP, and
/// Concentration Constitution save DC (`02-GAME-ENGINE-AND-DND5E.md` §4).
///
/// Order: mitigation -> Temp HP absorption -> HP loss -> massive-damage check -> death-save
/// failures (only when `current_hp == 0` before the hit; `+2` when `is_critical`) -> death.
pub fn resolve_damage_application(
    raw_damage: i32,
    affinity: DamageAffinity,
    current_hp: i32,
    max_hp: i32,
    current_temp_hp: i32,
    is_concentrating: bool,
    is_critical: bool,
    current_death_save_failures: u8,
) -> DamageResolution {
    let final_damage = mitigate_damage(raw_damage, affinity);

    let temp_hp_absorbed = final_damage.min(current_temp_hp.max(0));
    let new_temp_hp = (current_temp_hp - temp_hp_absorbed).max(0);
    let remaining_after_temp = final_damage - temp_hp_absorbed;

    let hp_lost = remaining_after_temp.min(current_hp.max(0));
    let overflow = remaining_after_temp - hp_lost;
    let new_hp = (current_hp - hp_lost).max(0);

    let instant_death = new_hp == 0 && overflow >= max_hp.max(1);

    let death_save_failures_added = if current_hp <= 0 && remaining_after_temp > 0 && !instant_death
    {
        if is_critical { 2 } else { 1 }
    } else {
        0
    };
    let new_death_save_failures = current_death_save_failures
        .saturating_add(death_save_failures_added)
        .min(DEATH_SAVE_FAILURES_TO_DIE);
    let dead = instant_death || new_death_save_failures >= DEATH_SAVE_FAILURES_TO_DIE;
    let unconscious = new_hp == 0 && !dead;

    let concentration_check_dc = if is_concentrating && final_damage > 0 && new_hp > 0 {
        Some((final_damage / 2).clamp(MIN_CONCENTRATION_DC, MAX_CONCENTRATION_DC))
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
        death_save_failures_added,
        new_death_save_failures,
        dead,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dnd5e_system_json_derived_dag_evaluates_every_node() {
        let raw_json = include_str!("../../../packages/game-systems/dnd5e/system.json");
        let doc: serde_json::Value =
            serde_json::from_str(raw_json).expect("valid system.json document");
        let derived_obj = doc
            .get("derivedDAG")
            .and_then(|v| v.as_object())
            .expect("derivedDAG object must exist in system.json");
        assert!(!derived_obj.is_empty());

        let mut derived_formulas = BTreeMap::new();
        for (node_key, node_val) in derived_obj {
            let expr = node_val
                .as_str()
                .or_else(|| node_val.get("expr").and_then(|e| e.as_str()))
                .unwrap_or_else(|| panic!("missing expr string for derivedDAG.{node_key}"));
            derived_formulas.insert(node_key.clone(), expr.to_string());
        }

        // Level 5 wizard/rogue test fixture
        let mut base_attributes = BTreeMap::new();
        base_attributes.insert("level".into(), 5.0);
        base_attributes.insert("str".into(), 10.0);
        base_attributes.insert("dex".into(), 16.0);
        base_attributes.insert("con".into(), 14.0);
        base_attributes.insert("int".into(), 18.0);
        base_attributes.insert("wis".into(), 12.0);
        base_attributes.insert("cha".into(), 8.0);
        base_attributes.insert("exhaustion".into(), 1.0);
        base_attributes.insert("speed_base".into(), 30.0);
        // Studded leather: 12 + full Dexterity modifier.
        base_attributes.insert("armor_worn".into(), 1.0);
        base_attributes.insert("armor_base".into(), 12.0);
        base_attributes.insert("armor_dex_applies".into(), 1.0);
        base_attributes.insert("armor_max_dex".into(), 99.0);
        base_attributes.insert("unarmored_defense_con".into(), 0.0);
        base_attributes.insert("unarmored_defense_wis".into(), 0.0);
        base_attributes.insert("shield_bonus".into(), 0.0);
        for ability in ["str", "dex", "con", "wis", "cha"] {
            base_attributes.insert(format!("spell_ability_{ability}"), 0.0);
        }
        base_attributes.insert("spell_ability_int".into(), 1.0);
        base_attributes.insert("save_int_prof".into(), 1.0);
        base_attributes.insert("save_wis_prof".into(), 1.0);
        base_attributes.insert("skill_stealth_prof".into(), 2.0); // expertise
        base_attributes.insert("skill_perception_prof".into(), 1.0);
        // Unknown variables fail closed, so every rank the DAG reads must be present (0 = untrained).
        for expr in derived_formulas.values() {
            for ident in extract_identifiers(expr) {
                if ident.ends_with("_prof") {
                    base_attributes.entry(ident).or_insert(0.0);
                }
            }
        }

        let evaluated = evaluate_derived_dag(&base_attributes, &derived_formulas)
            .expect("every derivedDAG node in system.json must evaluate without FormulaParseError");

        for key in derived_formulas.keys() {
            assert!(
                evaluated.contains_key(key),
                "missing evaluated node `{key}`"
            );
        }
        assert_eq!(evaluated["prof_bonus"], 3.0);
        assert_eq!(evaluated["str_mod"], 0.0);
        assert_eq!(evaluated["dex_mod"], 3.0);
        assert_eq!(evaluated["con_mod"], 2.0);
        assert_eq!(evaluated["int_mod"], 4.0);
        assert_eq!(evaluated["wis_mod"], 1.0);
        assert_eq!(evaluated["cha_mod"], -1.0);
        // Exhaustion 1 (SRD 5.2.1): -2 on d20 tests and -5 ft speed; passives and spell DC unaffected.
        assert_eq!(evaluated["initiative"], 1.0);
        assert_eq!(evaluated["speed"], 25.0);
        assert_eq!(evaluated["ac_base"], 15.0);
        assert_eq!(evaluated["ac"], 15.0);
        assert_eq!(evaluated["spell_save_dc"], 15.0);
        assert_eq!(evaluated["spell_attack_bonus"], 5.0);
        assert_eq!(evaluated["save_int"], 5.0);
        assert_eq!(evaluated["skill_stealth"], 7.0);
        assert_eq!(evaluated["passive_perception"], 14.0);
    }

    fn effect(source_name: &str, modifiers: Vec<AttributeModifier>) -> ActiveEffect {
        ActiveEffect {
            id: Uuid::new_v4(),
            source_name: source_name.to_string(),
            enabled: true,
            duration_rounds_remaining: None,
            concentration_caster_id: None,
            modifiers,
        }
    }

    fn modifier(target: &str, phase: ModifierPhase, value: f64) -> AttributeModifier {
        AttributeModifier {
            target: target.to_string(),
            phase,
            value,
            formula: None,
        }
    }

    fn formula_modifier(target: &str, phase: ModifierPhase, formula: &str) -> AttributeModifier {
        AttributeModifier {
            target: target.to_string(),
            phase,
            value: 0.0,
            formula: Some(formula.to_string()),
        }
    }

    fn attrs(pairs: &[(&str, f64)]) -> BTreeMap<String, f64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn formulas(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn same_named_effects_keep_the_largest_magnitude() {
        let cases = [
            (
                "stronger_second_instance_wins",
                vec![("Spell:Bless", 2.0), ("Spell:Bless", 3.0)],
                13.0,
            ),
            (
                "stronger_first_instance_wins",
                vec![("Spell:Bless", 3.0), ("Spell:Bless", 1.0)],
                13.0,
            ),
            (
                "stronger_penalty_wins_by_absolute_value",
                vec![("Curse:Hex", -1.0), ("Curse:Hex", -4.0)],
                6.0,
            ),
            (
                "different_sources_still_stack",
                vec![("Spell:Bless", 2.0), ("Spell:ShieldOfFaith", 2.0)],
                14.0,
            ),
        ];
        for (case_id, sources, expected) in cases {
            let effects: Vec<ActiveEffect> = sources
                .iter()
                .map(|(name, v)| effect(name, vec![modifier("ac", ModifierPhase::Add, *v)]))
                .collect();
            let resolved =
                evaluate_actor_attributes(&attrs(&[("ac", 10.0)]), &BTreeMap::new(), &effects)
                    .unwrap();
            assert_eq!(resolved["ac"], expected, "case {case_id}");
        }
    }

    #[test]
    fn exclusive_base_phase_keeps_the_best_evaluated_formula() {
        let base = attrs(&[("dex", 14.0), ("con", 16.0), ("armor_bonus", 1.0)]);
        let dag = formulas(&[
            ("dex_mod", "floor((dex - 10) / 2)"),
            ("con_mod", "floor((con - 10) / 2)"),
            ("ac", "10 + dex_mod + armor_bonus"),
        ]);
        let unarmored = || {
            effect(
                "Feature:UnarmoredDefense",
                vec![formula_modifier(
                    "ac",
                    ModifierPhase::Base,
                    "10 + dex_mod + con_mod",
                )],
            )
        };
        let mage_armor = || {
            effect(
                "Spell:MageArmor",
                vec![formula_modifier("ac", ModifierPhase::Base, "13 + dex_mod")],
            )
        };
        let cases = [
            ("armor_formula_only", vec![], 13.0),
            ("unarmored_defense_beats_armor", vec![unarmored()], 15.0),
            (
                "best_of_three_candidates_wins",
                vec![mage_armor(), unarmored()],
                15.0,
            ),
            ("mage_armor_beats_armor", vec![mage_armor()], 15.0),
            (
                "numeric_base_candidate_below_formula_is_ignored",
                vec![effect(
                    "Item:Ring",
                    vec![modifier("ac", ModifierPhase::Base, 12.0)],
                )],
                13.0,
            ),
            (
                "add_phase_applies_after_best_base",
                vec![
                    unarmored(),
                    effect(
                        "Spell:ShieldOfFaith",
                        vec![modifier("ac", ModifierPhase::Add, 2.0)],
                    ),
                ],
                17.0,
            ),
        ];
        for (case_id, effects, expected) in cases {
            let resolved = evaluate_actor_attributes(&base, &dag, &effects).unwrap();
            assert_eq!(resolved["ac"], expected, "case {case_id}");
        }
    }

    #[test]
    fn unknown_formula_variables_fail_closed() {
        let cases = [
            (
                "typo_in_derived_formula",
                formulas(&[("ac", "10 + dex_mdo")]),
                vec![],
                RulesEngineError::UnknownVariable {
                    target: "ac".into(),
                    variable: "dex_mdo".into(),
                },
            ),
            (
                "missing_base_attribute",
                formulas(&[("save_str", "str_mod + save_str_prof")]),
                vec![],
                RulesEngineError::UnknownVariable {
                    target: "save_str".into(),
                    variable: "str_mod".into(),
                },
            ),
            (
                "unknown_variable_in_modifier_formula",
                formulas(&[("ac", "10")]),
                vec![effect(
                    "Feature:UnarmoredDefense",
                    vec![formula_modifier("ac", ModifierPhase::Base, "10 + wis_mod")],
                )],
                RulesEngineError::UnknownVariable {
                    target: "ac".into(),
                    variable: "wis_mod".into(),
                },
            ),
            (
                "syntax_error_is_still_a_parse_error",
                formulas(&[("ac", "10 +")]),
                vec![],
                RulesEngineError::FormulaParseError {
                    target: "ac".into(),
                    reason: "unexpected end of expression".into(),
                },
            ),
        ];
        for (case_id, dag, effects, expected) in cases {
            let err = evaluate_actor_attributes(&BTreeMap::new(), &dag, &effects).unwrap_err();
            assert_eq!(err, expected, "case {case_id}");
        }
    }

    #[test]
    fn damage_resolution_handles_death_saves_instant_death_and_overflow() {
        #[derive(Clone, Copy)]
        struct Case {
            id: &'static str,
            raw: i32,
            affinity: DamageAffinity,
            hp: i32,
            temp_hp: i32,
            critical: bool,
            failures: u8,
            expect_hp: i32,
            expect_failures_added: u8,
            expect_failures: u8,
            expect_instant_death: bool,
            expect_dead: bool,
        }
        let base = Case {
            id: "",
            raw: 0,
            affinity: DamageAffinity::Normal,
            hp: 0,
            temp_hp: 0,
            critical: false,
            failures: 0,
            expect_hp: 0,
            expect_failures_added: 0,
            expect_failures: 0,
            expect_instant_death: false,
            expect_dead: false,
        };
        let cases = [
            Case {
                id: "drop_to_zero_adds_no_failure",
                raw: 25,
                hp: 20,
                ..base
            },
            Case {
                id: "hit_at_zero_adds_one_failure",
                raw: 5,
                expect_failures_added: 1,
                expect_failures: 1,
                ..base
            },
            Case {
                id: "critical_hit_at_zero_adds_two_failures",
                raw: 5,
                critical: true,
                expect_failures_added: 2,
                expect_failures: 2,
                ..base
            },
            Case {
                id: "third_failure_kills",
                raw: 5,
                failures: 2,
                expect_failures_added: 1,
                expect_failures: 3,
                expect_dead: true,
                ..base
            },
            Case {
                id: "critical_with_two_failures_caps_at_three",
                raw: 5,
                critical: true,
                failures: 2,
                expect_failures_added: 2,
                expect_failures: 3,
                expect_dead: true,
                ..base
            },
            Case {
                id: "massive_damage_at_zero_is_instant_death",
                raw: 20,
                expect_instant_death: true,
                expect_dead: true,
                ..base
            },
            Case {
                id: "massive_overflow_from_positive_hp_is_instant_death",
                raw: 45,
                hp: 20,
                expect_instant_death: true,
                expect_dead: true,
                ..base
            },
            Case {
                id: "temp_hp_absorbing_everything_at_zero_adds_no_failure",
                raw: 4,
                temp_hp: 5,
                ..base
            },
            Case {
                id: "immune_hit_at_zero_adds_no_failure",
                raw: 30,
                affinity: DamageAffinity::Immune,
                ..base
            },
            Case {
                id: "vulnerable_near_i32_max_saturates_without_overflow",
                raw: i32::MAX - 1,
                affinity: DamageAffinity::Vulnerable,
                hp: 20,
                expect_instant_death: true,
                expect_dead: true,
                ..base
            },
        ];
        for c in cases {
            let r = resolve_damage_application(
                c.raw, c.affinity, c.hp, 20, c.temp_hp, false, c.critical, c.failures,
            );
            assert_eq!(r.new_hp, c.expect_hp, "case {} new_hp", c.id);
            assert_eq!(
                r.death_save_failures_added, c.expect_failures_added,
                "case {} failures_added",
                c.id
            );
            assert_eq!(
                r.new_death_save_failures, c.expect_failures,
                "case {} failures",
                c.id
            );
            assert_eq!(
                r.instant_death, c.expect_instant_death,
                "case {} instant_death",
                c.id
            );
            assert_eq!(r.dead, c.expect_dead, "case {} dead", c.id);
            assert_eq!(
                r.unconscious,
                r.new_hp == 0 && !c.expect_dead,
                "case {} unconscious",
                c.id
            );
        }
    }
}
