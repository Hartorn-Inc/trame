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
import {
  themeModeSignal,
  resolvedThemeSignal,
  setThemeMode,
} from './signals/themeSignal.ts';

export const appStatusSignal = signal<'ready' | 'connecting' | 'connected'>('ready');
export const appThemeSignal = themeModeSignal;
export const setAppTheme = setThemeMode;

export function App() {
  return (
    <div
      data-testid="trame-app-root"
      data-theme={themeModeSignal.value}
      data-resolved-theme={resolvedThemeSignal.value}
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
        <h1 class="ds-brand-title" style={{ margin: 0 }}>TRAME VTT</h1>
        <span
          data-testid="trame-status-badge"
          role="status"
          aria-live="polite"
          class="atlas-tabular-nums"
        >
          {appStatusSignal.value}
        </span>
      </header>
      <main style={{ flex: 1 }} />
    </div>
  );
}
