/**
 * ============================================================================
 * TRAME ROOT APPLICATION SHELL (App.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Provides the root Preact shell for the TRAME browser client (`CampaignLobby`
 * and live tabletop workspace).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `PreactSignalState`:
 *      - Top-level reactive signals drive view transitions without full-tree
 *        re-renders.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. Initialize reactive application state.
 *   2. Render active view (`CampaignLobby` or active campaign table).
 * ============================================================================
 */

import { signal } from '@preact/signals';

export const appStatusSignal = signal<'ready' | 'connecting' | 'connected'>('ready');

export function App() {
  return (
    <main data-testid="trame-app-root" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '0.75rem 1.25rem',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#131722',
        }}
      >
        <strong>TRAME VTT</strong>
        <span data-testid="trame-status-badge">{appStatusSignal.value}</span>
      </header>
    </main>
  );
}
