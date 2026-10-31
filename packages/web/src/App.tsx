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

import { signal, computed } from '@preact/signals';
import { mobileCompanionOverrideSignal } from './i18n/index.ts';
import { MobileCompanionView } from './mobile/MobileCompanionView.tsx';

export const appStatusSignal = signal<'ready' | 'connecting' | 'connected'>('ready');
export const windowWidthSignal = signal<number>(typeof window !== 'undefined' ? window.innerWidth : 1024);

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    windowWidthSignal.value = window.innerWidth;
  });
}

export function App() {
  const isMobile = computed(() => mobileCompanionOverrideSignal.value || windowWidthSignal.value < 768);

  if (isMobile.value) {
    return <MobileCompanionView />;
  }

  return (
    <main data-testid="trame-app-root" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '0.75rem 1.25rem',
          borderBottom: '1px solid var(--atlas-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--atlas-surface)',
        }}
      >
        <strong>TRAME VTT</strong>
        <span data-testid="trame-status-badge">{appStatusSignal.value}</span>
      </header>
    </main>
  );
}
