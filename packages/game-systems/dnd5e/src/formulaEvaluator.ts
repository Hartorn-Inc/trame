/**
 * ============================================================================
 * DERIVED-FORMULA EVALUATOR SEAM (formulaEvaluator.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Single entry point through which every `derivedDAG` formula of the D&D 5e
 * game system is evaluated (`evaluateDerivedDag`). Before this seam existed,
 * the package carried two hand-written derived-stat paths (one per actor
 * representation) that silently disagreed with each other and with the Rust
 * engine. ADR-0001 (amendment G1) makes the `trame-engine` WASM export
 * `evaluate_derived_dag` the only formula evaluator; until that export ships,
 * this module provides a reference evaluator with the same grammar and the
 * same fail-closed semantics, and lets the bridge install the WASM evaluator
 * at runtime without touching any caller (`setDerivedDagEvaluator`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `One Seam`:
 *      - All formula evaluation in this package goes through
 *        `evaluateDerivedDag`; no module computes a `system.json` rule inline.
 *   2. `Grammar Parity With trame-engine::rules::eval_formula_expr`:
 *      - Numbers, identifiers (`[A-Za-z_][A-Za-z0-9_.]*`), `+ - * /`, unary
 *        `+`/`-`, parentheses, and the built-ins `floor`, `ceil`, `round`
 *        (half away from zero, like Rust `f64::round`), `abs`, `min`, `max`.
 *   3. `Fail Closed`:
 *      - Unknown variables, division by zero, malformed tokens and cyclic
 *        formula graphs throw `FormulaEvaluationError`; nothing defaults to 0.
 *   4. `Deterministic Topological Order`:
 *      - Kahn's algorithm with lexicographically sorted ready queues, matching
 *        the Rust engine's ordering so both produce identical results.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `evaluateDerivedDag(baseAttributes, derivedFormulas)`
 *     ├── 1. Delegate to the installed evaluator (WASM once S4 lands).
 *     └── 2. Otherwise run the reference evaluator:
 *           ├── a. Topologically sort formulas by identifier dependencies.
 *           ├── b. Evaluate each expression against the growing environment.
 *           └── c. Return base attributes merged with every derived value.
 * ============================================================================
 */

/**
 * Pure evaluator contract shared by the TypeScript reference implementation
 * and the future `trame-engine` WASM export (`evaluate_derived_dag`).
 *
 * Receives raw base attributes and `targetAttr -> expression` formulas, and
 * returns the base attributes merged with every evaluated derived attribute.
 * Must throw on unknown variables, cycles and malformed expressions.
 */
export type DerivedDagEvaluator = (
  baseAttributes: Readonly<Record<string, number>>,
  derivedFormulas: Readonly<Record<string, string>>
) => Record<string, number>;

/** Error raised when a formula graph cannot be evaluated. */
export class FormulaEvaluationError extends Error {
  /** Derived attribute whose formula failed, when known. */
  readonly target: string | undefined;

  constructor(message: string, target?: string) {
    super(target ? `derivedDAG.${target}: ${message}` : message);
    this.name = "FormulaEvaluationError";
    this.target = target;
  }
}

const BUILTIN_FUNCTIONS = new Set(["floor", "ceil", "round", "min", "max", "abs"]);

let installedEvaluator: DerivedDagEvaluator | null = null;

/**
 * Installs the evaluator used by `evaluateDerivedDag` (the WASM engine
 * bridge calls this after async init). Passing `null` restores the
 * TypeScript reference evaluator.
 */
export function setDerivedDagEvaluator(evaluator: DerivedDagEvaluator | null): void {
  installedEvaluator = evaluator;
}

/**
 * Evaluates `derivedFormulas` over `baseAttributes` with the installed
 * evaluator, falling back to `referenceEvaluateDerivedDag`.
 */
export function evaluateDerivedDag(
  baseAttributes: Readonly<Record<string, number>>,
  derivedFormulas: Readonly<Record<string, string>>
): Record<string, number> {
  return (installedEvaluator ?? referenceEvaluateDerivedDag)(baseAttributes, derivedFormulas);
}

/**
 * Returns the identifiers referenced by `expr`, excluding numbers and the
 * built-in function names.
 */
export function extractFormulaIdentifiers(expr: string): string[] {
  const out = new Set<string>();
  for (const match of expr.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
    if (!BUILTIN_FUNCTIONS.has(match[0])) {
      out.add(match[0]);
    }
  }
  return [...out];
}

/**
 * TypeScript reference implementation of the `DerivedDagEvaluator` contract,
 * kept grammar- and order-compatible with `trame-engine`.
 */
export const referenceEvaluateDerivedDag: DerivedDagEvaluator = (baseAttributes, derivedFormulas) => {
  const env: Record<string, number> = { ...baseAttributes };
  for (const target of topologicalOrder(derivedFormulas)) {
    try {
      env[target] = evaluateExpression(derivedFormulas[target], env);
    } catch (err) {
      throw new FormulaEvaluationError((err as Error).message, target);
    }
  }
  return env;
};

function topologicalOrder(formulas: Readonly<Record<string, string>>): string[] {
  const keys = Object.keys(formulas);
  const inDegree = new Map<string, number>(keys.map((k) => [k, 0]));
  const dependents = new Map<string, string[]>();
  for (const target of keys) {
    for (const dep of extractFormulaIdentifiers(formulas[target])) {
      if (inDegree.has(dep)) {
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
        dependents.set(dep, [...(dependents.get(dep) ?? []), target]);
      }
    }
  }

  const queue = keys.filter((k) => inDegree.get(k) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    const ready: string[] = [];
    for (const child of dependents.get(node) ?? []) {
      const remaining = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
    queue.push(...ready.sort());
  }

  if (order.length !== keys.length) {
    const stuck = keys.find((k) => (inDegree.get(k) ?? 0) > 0);
    throw new FormulaEvaluationError("cyclic dependency detected", stuck);
  }
  return order;
}

type OperatorChar = "+" | "-" | "*" | "/" | "(" | ")" | ",";

type Token =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: OperatorChar };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if ("+-*/(),".includes(ch)) {
      tokens.push({ kind: "op", op: ch as OperatorChar });
      i += 1;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9.]+/.exec(expr.slice(i))![0];
      const value = Number(match);
      if (Number.isNaN(value)) throw new Error(`invalid number '${match}'`);
      tokens.push({ kind: "num", value });
      i += match.length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(expr.slice(i))![0];
      tokens.push({ kind: "ident", name: match });
      i += match.length;
    } else {
      throw new Error(`unexpected character '${ch}'`);
    }
  }
  return tokens;
}

function evaluateExpression(expr: string, env: Readonly<Record<string, number>>): number {
  const tokens = tokenize(expr);
  let pos = 0;

  const isOp = (op: string): boolean => {
    const t = tokens[pos];
    return t !== undefined && t.kind === "op" && t.op === op;
  };

  const parseAddSub = (): number => {
    let left = parseMulDiv();
    while (isOp("+") || isOp("-")) {
      const plus = isOp("+");
      pos += 1;
      const right = parseMulDiv();
      left = plus ? left + right : left - right;
    }
    return left;
  };

  const parseMulDiv = (): number => {
    let left = parseUnary();
    while (isOp("*") || isOp("/")) {
      const times = isOp("*");
      pos += 1;
      const right = parseUnary();
      if (!times && Math.abs(right) < 1e-12) throw new Error("division by zero");
      left = times ? left * right : left / right;
    }
    return left;
  };

  const parseUnary = (): number => {
    if (isOp("-")) {
      pos += 1;
      return -parseUnary();
    }
    if (isOp("+")) {
      pos += 1;
      return parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    const token = tokens[pos];
    if (token === undefined) throw new Error("unexpected end of expression");
    pos += 1;
    if (token.kind === "num") return token.value;
    if (token.kind === "op") {
      if (token.op !== "(") throw new Error(`unexpected token '${token.op}'`);
      const value = parseAddSub();
      if (!isOp(")")) throw new Error("missing closing parenthesis");
      pos += 1;
      return value;
    }
    if (isOp("(")) {
      pos += 1;
      const args: number[] = [];
      if (!isOp(")")) {
        args.push(parseAddSub());
        while (isOp(",")) {
          pos += 1;
          args.push(parseAddSub());
        }
      }
      if (!isOp(")")) throw new Error(`missing closing ')' for function '${token.name}'`);
      pos += 1;
      return callBuiltin(token.name, args);
    }
    if (!Object.hasOwn(env, token.name)) throw new Error(`unknown variable '${token.name}'`);
    return env[token.name];
  };

  const value = parseAddSub();
  if (pos < tokens.length) throw new Error(`unexpected token at position ${pos}`);
  return value;
}

function callBuiltin(name: string, args: number[]): number {
  if (args.length === 1) {
    const [x] = args;
    switch (name) {
      case "floor":
        return Math.floor(x);
      case "ceil":
        return Math.ceil(x);
      case "round":
        return Math.sign(x) * Math.round(Math.abs(x));
      case "abs":
        return Math.abs(x);
    }
  }
  if (args.length > 0 && name === "min") return Math.min(...args);
  if (args.length > 0 && name === "max") return Math.max(...args);
  throw new Error(`unsupported function call '${name}' with ${args.length} args`);
}
