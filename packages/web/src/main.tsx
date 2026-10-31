/**
 * ============================================================================
 * TRAME BROWSER APPLICATION ENTRYPOINT (main.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Mounts the root Preact application into `#app` inside `index.html`.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Preact + @preact/signals`:
 *      - Uses `render` from `preact` and reactive `@preact/signals` state
 *        (`PreactSignalState`) so high-frequency WebSocket updates bypass
 *        full-tree Virtual DOM reconciliation.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. Locate `#app` mount container in DOM.
 *   2. Render root `<App />` component.
 * ============================================================================
 */

import { render } from 'preact';
import { App } from './App.tsx';

const container = document.getElementById('app');
if (container) {
  render(<App />, container);
}
