/**
 * ============================================================================
 * TRAME ROOT APPLICATION SHELL (App.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Provides the root Preact shell for the TRAME browser client (`CampaignLobby`
 * and `CampaignWorkspace`) using ATLAS v1.1 semantic tokens (`tokens.css`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `PreactSignalState`:
 *      - Top-level reactive signals drive view transitions and theme switching
 *        (`dark`, `light`, `system`) without full-tree re-renders.
 *   2. Zero inline raw hex colors: all colors resolve via `var(--atlas-*)`.
 * ============================================================================
 */

import { signal } from '@preact/signals';
import type { AtlasThemeMode } from './canvas/CanvasThemePalette.ts';

export const appStatusSignal = signal<'ready' | 'connecting' | 'connected'>('ready');
export const appThemeSignal = signal<AtlasThemeMode>('dark');

export function setAppTheme(mode: AtlasThemeMode): void {
  appThemeSignal.value = mode;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

export function App() {
  return (
    <main
      data-testid="trame-app-root"
      data-theme={appThemeSignal.value}
      class="ds-app-shell"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      <header
        class="ds-topbar"
        style={{
          padding: 'var(--atlas-space-sm) var(--atlas-space-md)',
          borderBottom: '1px solid var(--atlas-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--atlas-surface)',
          color: 'var(--atlas-text)',
        }}
      >
        <strong class="ds-brand-title">TRAME VTT</strong>
        <span data-testid="trame-status-badge" class="atlas-tabular-nums">
          {appStatusSignal.value}
        </span>
      </header>
    </main>
  );
}
