/**
 * ============================================================================
 * TRAME ROOT APPLICATION SHELL (App.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Provides the root Preact shell for the TRAME browser client:
 *   1. Restores authenticated session (`GET /api/v1/auth/me`) on startup.
 *   2. Renders `Lobby` when `activeCampaignSignal.value === null`.
 *   3. Renders the live Tabletop Workspace (`TableCanvas` + `HudDrawers`)
 *      when a campaign is active.
 * ============================================================================
 */

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  activeCampaignSignal,
  campaignsSignal,
  currentUserSignal,
  lastErrorBannerSignal,
  wsConnectionStateSignal,
} from './store/signals.ts';
import {
  apiFetchMe,
  apiListCampaigns,
  apiLogout,
  globalWsClient,
} from './net/wsClient.ts';
import { Lobby } from './components/Lobby.tsx';
import { CampaignWorkspace } from './components/CampaignWorkspace.tsx';

export const appStatusSignal = signal<'ready' | 'connecting' | 'connected'>('ready');

export function App() {
  const activeCampaign = activeCampaignSignal.value;
  const currentUser = currentUserSignal.value;
  const wsStatus = wsConnectionStateSignal.value;
  const errorBanner = lastErrorBannerSignal.value;

  useEffect(() => {
    apiFetchMe()
      .then(async (user) => {
        if (user) {
          currentUserSignal.value = user;
          const list = await apiListCampaigns();
          campaignsSignal.value = list;
        }
      })
      .catch(() => {});
  }, []);

  async function handleLogout() {
    globalWsClient.disconnect();
    await apiLogout().catch(() => {});
    currentUserSignal.value = null;
    activeCampaignSignal.value = null;
    lastErrorBannerSignal.value = null;
  }

  function handleBackToLobby() {
    globalWsClient.disconnect();
    activeCampaignSignal.value = null;
  }

  return (
    <main
      data-testid="trame-app-root"
      style={{
        minHeight: '100vh',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#0b0e14',
        color: '#e2e8f0',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '0.6rem 1.15rem',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#131722',
          zIndex: 30,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <strong style={{ fontSize: '1.05rem', letterSpacing: '0.03em', color: '#f8fafc' }}>
            TRAME VTT
          </strong>

          {activeCampaign && (
            <>
              <button
                type="button"
                data-testid="back-to-lobby-btn"
                onClick={handleBackToLobby}
                style={{
                  padding: '0.3rem 0.65rem',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: '#1e293b',
                  color: '#cbd5e1',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                }}
              >
                ← Lobby
              </button>
              <span
                data-testid="active-campaign-header-name"
                style={{ fontWeight: 600, fontSize: '0.9rem', color: '#93c5fd' }}
              >
                {activeCampaign.name} ({activeCampaign.role})
              </span>
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {errorBanner && (
            <div
              role="alert"
              aria-live="assertive"
              tabIndex={0}
              aria-label={`Dismiss error: ${errorBanner}`}
              data-testid="trame-status-banner"
              onClick={() => {
                lastErrorBannerSignal.value = null;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
                  e.preventDefault();
                  lastErrorBannerSignal.value = null;
                }
              }}
              style={{
                padding: '0.25rem 0.65rem',
                borderRadius: '6px',
                background: 'rgba(239, 68, 68, 0.18)',
                border: '1px solid #ef4444',
                color: '#fca5a5',
                fontSize: '0.78rem',
                cursor: 'pointer',
              }}
            >
              {errorBanner}
            </div>
          )}

          <span
            data-testid="trame-status-badge"
            style={{
              fontSize: '0.75rem',
              padding: '0.2rem 0.55rem',
              borderRadius: '999px',
              background:
                wsStatus === 'connected'
                  ? 'rgba(34, 197, 94, 0.2)'
                  : wsStatus === 'connecting'
                    ? 'rgba(234, 179, 8, 0.2)'
                    : 'rgba(148, 163, 184, 0.15)',
              color:
                wsStatus === 'connected'
                  ? '#4ade80'
                  : wsStatus === 'connecting'
                    ? '#fde047'
                    : '#94a3b8',
              fontWeight: 600,
            }}
          >
            {activeCampaign ? wsStatus : appStatusSignal.value}
          </span>

          {currentUser && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span data-testid="current-user-badge" style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                {currentUser.display_name || currentUser.email}
                {currentUser.is_ephemeral ? ' (Guest)' : ''}
              </span>
              <button
                type="button"
                data-testid="logout-btn"
                onClick={handleLogout}
                style={{
                  padding: '0.25rem 0.55rem',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: 'transparent',
                  color: '#94a3b8',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </header>

      {!activeCampaign ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <Lobby />
        </div>
      ) : (
        <div
          data-testid="trame-table-workspace"
          style={{
            flex: 1,
            display: 'flex',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <CampaignWorkspace />
        </div>
      )}
    </main>
  );
}
