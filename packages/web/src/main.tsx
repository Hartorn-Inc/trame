/**
 * ============================================================================ 
 * TRAME BROWSER APPLICATION ENTRYPOINT (main.tsx)
 * ============================================================================ 
 *
 * PURPOSE:
 * --------
 * Mounts the root Preact application into `#app` inside `index.html` and loads
 * the ATLAS v1.1 design token stylesheet (`tokens.css`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Preact + @preact/signals`:
 *      - Uses `render` from `preact` and reactive `@preact/signals` state
 *        (`PreactSignalState`) so high-frequency WebSocket updates bypass
 *        full-tree Virtual DOM reconciliation.
 *   2. `Single Formula Evaluator (G1)`:
 *      - Instantiates the `trame-engine` WASM once at startup and installs its
 *        `evaluateDerivedDag` as the D&D 5e pack's derived-stat evaluator
 *        before the first render, so character sheets compute with the same
 *        Rust code as the server. If the WASM fails to load, the app still
 *        renders and derived-stat evaluation fails closed.
 *   3. `Full SRD Before Sheets`:
 *      - Loads the generated SRD packs (lazy chunks, in parallel with the
 *        WASM) into `CompendiumResolver.getDefault()` before the first
 *        render, because sheet derivations resolve spells and items
 *        synchronously. If the packs fail to load, sheets fall back to the
 *        curated catalog and skip pack-only spells.
 * ============================================================================
 */

import { render } from 'preact';
import './styles/tokens.css';
import { App } from './App.tsx';
import { evaluateDerivedDag, initEngine } from './engine/wasmBridge.ts';
import { setDerivedDagEvaluator } from '../../game-systems/dnd5e/src/formulaEvaluator.ts';
import { installFullSystemSrd } from '../../game-systems/dnd5e/src/srdPacks.ts';

const container = document.getElementById('app');
void Promise.allSettled([
  initEngine().then(() => setDerivedDagEvaluator(evaluateDerivedDag)),
  installFullSystemSrd(),
]).then(() => {
  if (container) {
    render(<App />, container);
  }
});
