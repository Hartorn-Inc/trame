/**
 * ============================================================================
 * TRAME ROOT APPLICATION SHELL (App.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Root Preact shell: boots the session, guards every screen behind
 * authentication, and routes between the sign-in screen, the campaign lobby,
 * and the live campaign workspace.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `GuestSessionUpgrade Before The Guard`:
 *    - `bootstrapSession` redeems `?invite=` before the guard decides, so an
 *      invited player lands in the workspace instead of the sign-in form.
 * 2. `Server-Owned Identity`:
 *    - Screens render from `session.status` / `session.user`, which only
 *      `ApiClient` writes after the server answers.
 * 3. `One Room Socket`:
 *    - The room socket follows `session.activeCampaignId`: it is opened when a
 *      campaign is selected and closed when leaving it or unmounting.
 * 4. `PreactSignalState`:
 *    - Signals drive view transitions without full-tree re-renders.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `App` mount
 * ├── 1. `bootstrapSession` -> status `authenticated` | `anonymous`.
 * ├── 2. `restoring` -> busy message; `anonymous` -> `AuthScreen`.
 * ├── 3. `authenticated`, no campaign -> `CampaignLobby`.
 * └── 4. campaign selected -> `client.connect(id)` + `CampaignWorkspace`.
 * ============================================================================
 */

import { computed, signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { bootstrapSession, type BootLocation } from './api/bootstrap.ts';
import { apiClient, type ApiClient } from './api/client.ts';
import { AuthScreen } from './auth/AuthScreen.tsx';
import { LocaleToggle, UnitsToggle } from './components/ShellToggles.tsx';
import { mobileCompanionOverrideSignal, t } from './i18n/index.ts';
import { CampaignLobby } from './lobby/CampaignLobby.tsx';
import type { UserRole } from './maps/types.ts';
import { MobileCompanionView } from './mobile/MobileCompanionView.tsx';
import { CampaignWorkspace } from './workspace/CampaignWorkspace.tsx';
import {
  HandoutRevealModal,
  dispatchHandoutRevealedFrame,
} from './workspace/DocumentsWorkspaceTab.tsx';

export const windowWidthSignal = signal<number>(
  typeof window !== 'undefined' ? window.innerWidth : 1024,
);
export const shouldMountCanvas = computed(
  () => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768,
);

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => {
    windowWidthSignal.value = window.innerWidth;
  });
}

apiClient.onHandoutRevealed = (handout) => {
  dispatchHandoutRevealedFrame({
    handout_id: handout.handout_id,
    title: handout.title,
    content: handout.content,
    revealed_by: handout.revealed_by,
    timestamp: handout.timestamp,
  });
};

/** Props for `App`; defaults bind to the browser. Tests inject a mocked client. */
export interface AppProps {
  client?: ApiClient;
  /** Location read by the bootstrap (`?invite=`). */
  location?: BootLocation;
  /** Rewrites the address bar without navigation (strips a consumed invite). */
  replaceUrl?: (url: string) => void;
}

function browserReplaceUrl(url: string): void {
  if (typeof history !== 'undefined') history.replaceState(history.state, '', url);
}

function toUserRole(role: string | undefined): UserRole {
  return role === 'GM' || role === 'SPECTATOR' ? role : 'PLAYER';
}

function ShellHeader({ client, inCampaign }: { client: ApiClient; inCampaign: boolean }) {
  const connection = client.state.connection.value;
  return (
    <header class="ds-topbar" style={{ flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--atlas-space-sm)' }}>
        <strong class="ds-brand-title">{t('shell.brand')}</strong>
        {inCampaign && (
          <span data-testid="trame-status-badge" role="status">
            {t(`shell.connection.${connection}`)}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--atlas-space-sm)', flexWrap: 'wrap' }}>
        {inCampaign && (
          <button
            type="button"
            class="ds-btn ds-btn-secondary"
            data-testid="header-back-to-lobby"
            onClick={() => {
              client.state.activeCampaignId.value = null;
            }}
          >
            {t('shell.backToLobby')}
          </button>
        )}
        <LocaleToggle />
        {inCampaign && (
          <>
            <UnitsToggle />
            <button
              type="button"
              data-testid="header-companion-toggle"
              aria-label={t('shell.toggleCompanion')}
              aria-pressed={mobileCompanionOverrideSignal.value}
              class={`ds-btn ${mobileCompanionOverrideSignal.value ? 'ds-btn-primary' : 'ds-btn-secondary'}`}
              onClick={() => {
                mobileCompanionOverrideSignal.value = !mobileCompanionOverrideSignal.value;
              }}
            >
              {t('shell.companionMode')}
            </button>
          </>
        )}
        <button
          type="button"
          class="ds-btn ds-btn-secondary"
          data-testid="header-sign-out"
          onClick={() => {
            void client.logout();
          }}
        >
          {t('shell.signOut')}
        </button>
      </div>
    </header>
  );
}

function CampaignView({ client, campaignId }: { client: ApiClient; campaignId: string }) {
  const campaign = client.state.campaigns.value.find((c) => c.id === campaignId);

  useEffect(() => {
    client.connect(campaignId);
    return () => client.disconnect();
  }, [client, campaignId]);

  useEffect(() => {
    if (!campaign) {
      client.listCampaigns().catch(() => undefined);
    }
  }, [client, campaignId]);

  if (!shouldMountCanvas.value) {
    return <MobileCompanionView />;
  }

  return (
    <div class="ds-app-shell" data-testid="trame-app-root">
      <ShellHeader client={client} inCampaign />
      <main style={{ flex: 1, overflowY: 'auto' }}>
        <CampaignWorkspace campaignId={campaignId} userRole={toUserRole(campaign?.role)} />
      </main>
    </div>
  );
}

/** Root shell: session bootstrap, auth guard, lobby, and campaign workspace. */
export function App({ client = apiClient, location, replaceUrl = browserReplaceUrl }: AppProps = {}) {
  useEffect(() => {
    const loc = location ?? (typeof window !== 'undefined' ? window.location : { pathname: '/', search: '', hash: '' });
    void bootstrapSession(client, loc, replaceUrl);
  }, [client]);

  const status = client.state.status.value;
  const campaignId = client.state.activeCampaignId.value;

  if (status === 'restoring') {
    return (
      <main class="ds-app-shell" data-testid="app-restoring" aria-busy="true" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p>{t('shell.loading')}</p>
      </main>
    );
  }

  if (status === 'anonymous') {
    return <AuthScreen client={client} />;
  }

  return (
    <>
      {campaignId ? (
        <CampaignView client={client} campaignId={campaignId} />
      ) : (
        <div class="ds-app-shell">
          <ShellHeader client={client} inCampaign={false} />
          <CampaignLobby client={client} />
        </div>
      )}
      <HandoutRevealModal />
    </>
  );
}
