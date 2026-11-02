/**
 * ============================================================================
 * DERIVED-FORMULA EVALUATOR SEAM (formulaEvaluator.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Single entry point through which every `derivedDAG` formula of the D&D 5e
 * game system is evaluated (`evaluateDerivedDag`). ADR-0001 (amendment G1)
 * makes the `trame-engine` WASM export `evaluateDerivedDag` the only formula
 * evaluator, so this package carries no formula interpreter of its own: the
 * runtime installs the WASM evaluator once (`setDerivedDagEvaluator`) and every
 * caller goes through this seam. Without it, client sheets and the Rust server
 * could drift on the same rule.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `One Seam, One Evaluator`:
 *      - All formula evaluation in this package goes through
 *        `evaluateDerivedDag`; no module computes a `system.json` rule inline.
 *      - Installers: the browser calls `setDerivedDagEvaluator` with the
 *        `wasmBridge.ts` export after `initEngine()`; Node consumers import
 *        `src/node.ts`, which loads `packages/trame-engine-node`.
 *   2. `Fail Closed When Missing`:
 *      - Evaluating before an evaluator is installed throws instead of
 *        falling back to a second implementation that could disagree.
 *   3. `Fail Closed On Bad Formulas`:
 *      - The WASM evaluator throws on unknown variables, cycles and syntax
 *        errors; nothing defaults to `0`.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `evaluateDerivedDag(baseAttributes, derivedFormulas, activeEffects?)`
 *     ├── 1. Reject the call when no evaluator is installed.
 *     └── 2. Delegate to the installed evaluator (trame-engine WASM).
 * ============================================================================
 */

/**
 * Evaluator contract implemented by the `trame-engine` WASM export
 * `evaluateDerivedDag`.
 *
 * Receives raw base attributes, `targetAttr -> expression` formulas and
 * optional active effects (engine snake_case `ActiveEffect` objects run
 * through the 5-phase modifier pipeline), and returns the base attributes
 * merged with every evaluated derived attribute. Must throw on unknown
 * variables, cycles and malformed expressions.
 */
export type DerivedDagEvaluator = (
  baseAttributes: Record<string, number>,
  derivedFormulas: Record<string, string>,
  activeEffects?: unknown[]
) => Record<string, number>;

const BUILTIN_FUNCTIONS = new Set(["floor", "ceil", "round", "min", "max", "abs"]);

let installedEvaluator: DerivedDagEvaluator | null = null;

/**
 * Installs the evaluator used by `evaluateDerivedDag`: the browser installs
 * the `wasmBridge.ts` export after `initEngine()`, Node imports `src/node.ts`.
 * Passing `null` uninstalls it (tests only).
 */
export function setDerivedDagEvaluator(evaluator: DerivedDagEvaluator | null): void {
  installedEvaluator = evaluator;
}

/** Returns the installed evaluator, or `null` before the engine is ready. */
export function getDerivedDagEvaluator(): DerivedDagEvaluator | null {
  return installedEvaluator;
}

/**
 * Evaluates `derivedFormulas` over `baseAttributes` (and optional engine
 * `activeEffects`) with the installed WASM evaluator.
 * Throws when no evaluator has been installed yet.
 */
export function evaluateDerivedDag(
  baseAttributes: Readonly<Record<string, number>>,
  derivedFormulas: Readonly<Record<string, string>>,
  activeEffects?: unknown[]
): Record<string, number> {
  if (!installedEvaluator) {
    throw new Error(
      "No derivedDAG evaluator installed: call setDerivedDagEvaluator() with the trame-engine WASM evaluateDerivedDag first"
    );
  }
  return installedEvaluator({ ...baseAttributes }, { ...derivedFormulas }, activeEffects);
}

/**
 * Returns the identifiers referenced by `expr`, excluding numbers and the
 * built-in function names (`floor`, `ceil`, `round`, `min`, `max`, `abs`).
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
