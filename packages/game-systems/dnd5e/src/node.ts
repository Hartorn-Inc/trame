/**
 * ============================================================================
 * NODE WASM EVALUATOR INSTALLER (node.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Installs the Node-target `trame-engine` WASM `evaluateDerivedDag`
 * (`make wasm` -> `packages/trame-engine-node/`, gitignored) as the pack's
 * derived-stat evaluator when the pack runs under Node (tests, scripts).
 * Browsers must not import this module: it loads the WASM with `fs`; the web
 * app installs `wasmBridge.ts` instead (`packages/web/src/main.tsx`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Side-Effect Import`:
 *      - Importing this module installs the evaluator once; it is not
 *        re-exported from `index.ts` so browser bundles never pull in `fs`.
 *   2. `JSON Wire Contract`:
 *      - The export takes `{ baseAttributes, derivedFormulas, activeEffects }`
 *        as JSON and returns `{ [attribute]: number }` as JSON; it throws on
 *        unknown variables, cycles and syntax errors.
 * ============================================================================
 */

import { evaluateDerivedDag as wasmEvaluateDerivedDag } from "../../../trame-engine-node/trame_engine.js";
import { type DerivedDagEvaluator, setDerivedDagEvaluator } from "./formulaEvaluator.ts";

/** `DerivedDagEvaluator` backed by the Node-target `trame-engine` WASM build. */
export const nodeWasmDerivedDagEvaluator: DerivedDagEvaluator = (
  baseAttributes,
  derivedFormulas,
  activeEffects = []
) =>
  JSON.parse(
    wasmEvaluateDerivedDag(JSON.stringify({ baseAttributes, derivedFormulas, activeEffects }))
  ) as Record<string, number>;

setDerivedDagEvaluator(nodeWasmDerivedDagEvaluator);
