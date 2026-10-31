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
 *   2. `ImpeccableDesignTokens`:
 *      - All colors and styling strictly use ATLAS v1.1 CSS custom properties.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. Initialize reactive application state.
 *   2. Render active view (`CampaignLobby` or active campaign table).
 * ============================================================================
 */

import { signal } from '@preact/signals';
import {
  localeSignal,
  mobileCompanionOverrideSignal,
  unitSystemSignal,
} from './i18n/index.ts';
import { MobileCompanionView } from './mobile/MobileCompanionView.tsx';
import {
  DocumentsWorkspaceTab,
  HandoutRevealModal,
} from './workspace/DocumentsWorkspaceTab.tsx';

export const appStatusSignal = signal<'ready' | 'connecting' | 'connected'>('ready');
export const windowWidthSignal = signal<number>(
  typeof window !== 'undefined' ? window.innerWidth : 1024,
);

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    windowWidthSignal.value = window.innerWidth;
  });
}

export function App() {
  const isMobile = mobileCompanionOverrideSignal.value || windowWidthSignal.value < 768;

  return (
    <>
      {isMobile ? (
        <MobileCompanionView />
      ) : (
        <div
          data-testid="trame-app-root"
          style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
        >
          <header
            style={{
              padding: '0.75rem 1.25rem',
              borderBottom: '1px solid var(--atlas-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'var(--atlas-surface)',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <strong>TRAME VTT</strong>
              <span data-testid="trame-status-badge">{appStatusSignal.value}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                type="button"
                data-testid="header-locale-toggle"
                aria-label="Toggle language"
                class="ds-btn ds-btn-secondary"
                onClick={() => {
                  localeSignal.value = localeSignal.value === 'en' ? 'fr' : 'en';
                }}
              >
                {localeSignal.value === 'fr' ? 'FR' : 'EN'}
              </button>
              <button
                type="button"
                data-testid="header-units-toggle"
                aria-label="Toggle grid units"
                class="ds-btn ds-btn-secondary"
                onClick={() => {
                  unitSystemSignal.value =
                    unitSystemSignal.value === 'imperial_ft' ? 'metric_m' : 'imperial_ft';
                }}
              >
                {unitSystemSignal.value === 'imperial_ft' ? '5 ft' : '1.5 m'}
              </button>
              <button
                type="button"
                data-testid="header-companion-toggle"
                aria-label="Toggle companion mode"
                aria-pressed={mobileCompanionOverrideSignal.value}
                class={`ds-btn ${mobileCompanionOverrideSignal.value ? 'ds-btn-primary' : 'ds-btn-secondary'}`}
                onClick={() => {
                  mobileCompanionOverrideSignal.value = !mobileCompanionOverrideSignal.value;
                }}
              >
                Companion Mode
              </button>
            </div>
          </header>

          <main style={{ flex: 1, overflowY: 'auto' }}>
            <DocumentsWorkspaceTab />
          </main>
        </div>
      )}
      <HandoutRevealModal />
    </>
  );
}
