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
 *   3. `SRD Packs In The Background`:
 *      - The generated SRD packs (lazy chunks) start loading in parallel with
 *        the WASM but never delay the first render. Until they are installed
 *        in `CompendiumResolver.getDefault()`, sheets derive from the curated
 *        catalog and skip pack-only spells; `srdLoading.ts` shows a notice and
 *        re-renders the app (sheets derive again) when they arrive.
 * ============================================================================
 */

import { render } from 'preact';
import './styles/tokens.css';
import { App } from './App.tsx';
import { evaluateDerivedDag, initEngine } from './engine/wasmBridge.ts';
import { setDerivedDagEvaluator } from '../../game-systems/dnd5e/src/formulaEvaluator.ts';
import { loadSrdInBackground } from './srdLoading.ts';

const container = document.getElementById('app');
void loadSrdInBackground();
void initEngine()
  .then(() => setDerivedDagEvaluator(evaluateDerivedDag))
  .catch(() => undefined)
  .then(() => {
    if (container) {
      render(<App />, container);
    }
  });
