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
 * ============================================================================
 */

import { render } from 'preact';
import './styles/tokens.css';
import { App } from './App.tsx';

render(<App />, document.getElementById('app')!);
