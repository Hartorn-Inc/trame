/**
 * ============================================================================
 * TRAME ROOT APPLICATION SHELL (App.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Root Preact shell: boots the session, guards every screen behind
 * authentication, and routes between the owner setup page, the
 * `InviteRedemption` screen, the sign-in screen, the campaign lobby (with the
 * Owner's account administration), and the live campaign workspace.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Entry Route Before The Guard`:
 *    - Nothing renders until `bootstrapSession` returns the entry route, so
 *      `/setup?token=` and `?invite=` reach their screens (signed in or not)
 *      instead of flashing the sign-in form or the lobby.
 * 2. `Server-Owned Identity`:
 *    - Screens render from `session.status` / `session.user`, which only
 *      `ApiClient` writes after the server answers.
 * 3. `One Room Socket`:
 *    - The room socket follows `session.activeCampaignId`: it is opened when a
 *      campaign is selected and closed when leaving it or unmounting.
 * 4. `PreactSignalState`:
 *    - Signals drive view transitions without full-tree re-renders.
 * 5. `Connection Feedback On Every Campaign Layout`:
 *    - Desktop and mobile companion layouts both mount `ConnectionBanner`,
 *      `WalQuarantineBanner` and `CommandFeedbackToasts`, which own the only
 *      connection, recovery and action-failure live regions (the header
 *      badge is plain text).
 * 6. `SRD Packs Never Block`:
 *    - The shell renders while the SRD packs load; `SrdLoadingNotice` says
 *      so, and reading `srdStatusSignal` re-renders the tree (sheets derive
 *      again) when the full catalog arrives (`srdLoading.ts`).
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `App` mount
 * ├── 1. `bootstrapSession` -> entry route + status `authenticated` | `anonymous`.
 * ├── 2. route `setup` -> `OwnerSetupScreen`; `reset` -> `PasswordResetScreen`;
 * │      route `invite` -> `InviteRedemptionScreen`.
 * ├── 3. `anonymous` -> `AuthScreen`.
 * ├── 4. `authenticated`, no campaign -> `CampaignLobby` | `InstanceAdminPanel` (Owner).
 * └── 5. campaign selected -> `client.connect(id)` + `CampaignWorkspace`.
 * ============================================================================
 */

import { computed, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { APP_ROUTE, bootstrapSession, type BootLocation, type BootRoute } from './api/bootstrap.ts';
import { apiClient, type ApiClient } from './api/client.ts';
import { AccountSettingsDialog } from './auth/AccountSettingsDialog.tsx';
import { AuthScreen } from './auth/AuthScreen.tsx';
import { InviteRedemptionScreen } from './auth/InviteRedemptionScreen.tsx';
import { OwnerSetupScreen } from './auth/OwnerSetupScreen.tsx';
import { PasswordResetScreen } from './auth/PasswordResetScreen.tsx';
import { CommandFeedbackToasts, ConnectionBanner, WalQuarantineBanner } from './components/RoomConnectionFeedback.tsx';
import { LocaleToggle, UnitsToggle } from './components/ShellToggles.tsx';
import { mobileCompanionOverrideSignal, t } from './i18n/index.ts';
import { CampaignLobby } from './lobby/CampaignLobby.tsx';
import { InstanceAdminPanel } from './lobby/InstanceAdminPanel.tsx';
import type { UserRole } from './maps/types.ts';
import { MobileCompanionView } from './mobile/MobileCompanionView.tsx';
import { srdStatusSignal } from './srdLoading.ts';
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
  /** Location read by the bootstrap (`/setup?token=`, `?invite=`). */
  location?: BootLocation;
  /** Rewrites the address bar without navigation (strips invite and setup tokens). */
  replaceUrl?: (url: string) => void;
}

function browserReplaceUrl(url: string): void {
  if (typeof history !== 'undefined') history.replaceState(history.state, '', url);
}

function toUserRole(role: string | undefined): UserRole {
  return role === 'GM' || role === 'SPECTATOR' ? role : 'PLAYER';
}

interface ShellHeaderProps {
  client: ApiClient;
  inCampaign: boolean;
  /** Opens the account settings dialog (lobby only). */
  onOpenAccount?: () => void;
  /** Opens the Owner's account administration (lobby, Owner only). */
  onOpenAdmin?: () => void;
}

function ShellHeader({ client, inCampaign, onOpenAccount, onOpenAdmin }: ShellHeaderProps) {
  const connection = client.state.connection.value;
  return (
    <header class="ds-topbar" style={{ flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--atlas-space-sm)' }}>
        <strong class="ds-brand-title">{t('shell.brand')}</strong>
        {inCampaign && (
          <span data-testid="trame-status-badge">{t(`shell.connection.${connection}`)}</span>
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
        {onOpenAdmin && (
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="header-instance-admin" onClick={onOpenAdmin}>
            {t('shell.instanceAdmin')}
          </button>
        )}
        {onOpenAccount && (
          <button
            type="button"
            class="ds-btn ds-btn-secondary"
            data-testid="header-account"
            aria-haspopup="dialog"
            onClick={onOpenAccount}
          >
            {t('shell.account')}
          </button>
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
    return (
      <>
        <ConnectionBanner client={client} />
        <WalQuarantineBanner client={client} />
        <MobileCompanionView campaignId={campaignId} client={client} isGm={campaign?.role === 'GM'} />
        <CommandFeedbackToasts client={client} />
      </>
    );
  }

  return (
    <div class="ds-app-shell" data-testid="trame-app-root">
      <ShellHeader client={client} inCampaign />
      <ConnectionBanner client={client} />
      <WalQuarantineBanner client={client} />
      <main style={{ flex: 1, overflowY: 'auto' }}>
        <CampaignWorkspace campaignId={campaignId} userRole={toUserRole(campaign?.role)} client={client} />
      </main>
      <CommandFeedbackToasts client={client} />
    </div>
  );
}

/** Lobby shell: campaign list or, for the Owner, account administration, plus the account dialog. */
function LobbyView({ client }: { client: ApiClient }) {
  const [view, setView] = useState<'lobby' | 'admin'>('lobby');
  const [accountOpen, setAccountOpen] = useState(false);
  const user = client.state.user.value;
  const isOwner = user?.instanceRole === 'OWNER';

  return (
    <div class="ds-app-shell">
      <ShellHeader
        client={client}
        inCampaign={false}
        onOpenAccount={() => setAccountOpen(true)}
        onOpenAdmin={isOwner && view === 'lobby' ? () => setView('admin') : undefined}
      />
      {isOwner && view === 'admin' ? (
        <InstanceAdminPanel client={client} onBack={() => setView('lobby')} />
      ) : (
        <CampaignLobby client={client} />
      )}
      {accountOpen && user && <AccountSettingsDialog client={client} user={user} onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

/** Root shell: session bootstrap, entry routes, auth guard, lobby, and campaign workspace. */
export function App({ client = apiClient, location, replaceUrl = browserReplaceUrl }: AppProps = {}) {
  const [route, setRoute] = useState<BootRoute | null>(null);

  useEffect(() => {
    const loc = location ?? (typeof window !== 'undefined' ? window.location : { pathname: '/', search: '', hash: '' });
    void bootstrapSession(client, loc, replaceUrl).then(setRoute);
  }, [client]);

  const status = client.state.status.value;
  const campaignId = client.state.activeCampaignId.value;
  // Read so the tree re-renders, and sheets derive again, when the SRD packs arrive.
  void srdStatusSignal.value;
  const leaveEntryRoute = () => setRoute(APP_ROUTE);

  if (status === 'restoring' || route === null) {
    return (
      <main class="ds-app-shell" data-testid="app-restoring" aria-busy="true" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p>{t('shell.loading')}</p>
      </main>
    );
  }

  if (route.kind === 'setup') {
    return <OwnerSetupScreen client={client} token={route.token} onDone={leaveEntryRoute} />;
  }

  if (route.kind === 'reset') {
    return <PasswordResetScreen client={client} token={route.token} onDone={leaveEntryRoute} />;
  }

  if (route.kind === 'invite') {
    return <InviteRedemptionScreen client={client} token={route.token} onDone={leaveEntryRoute} />;
  }

  if (status === 'anonymous') {
    return <AuthScreen client={client} />;
  }

  return (
    <>
      <SrdLoadingNotice />
      {campaignId ? <CampaignView client={client} campaignId={campaignId} /> : <LobbyView client={client} />}
      <HandoutRevealModal />
    </>
  );
}

/** Non-blocking notice while the full SRD packs load in the background (`srdLoading.ts`). */
export function SrdLoadingNotice() {
  const status = srdStatusSignal.value;
  if (status === 'ready') return null;
  return (
    <p class="ds-hint" role="status" aria-busy={status === 'loading' ? 'true' : 'false'} data-testid="srd-loading">
      {t(status === 'loading' ? 'shell.srdLoading' : 'shell.srdFallback')}
    </p>
  );
}
