/**
 * ============================================================================
 * AUTHENTICATION & CAMPAIGN LOBBY COMPONENT (components/Lobby.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Renders the TRAME Campaign Lobby and Authentication Gateway:
 * 1. Register / Login with OWASP Argon2id credentials.
 * 2. 1-Click Magic Link Invite JWT redemption (including `?token=...` URL auto-redemption).
 * 3. Guest-to-Permanent account graduation (`POST /api/v1/auth/bind-account`).
 * 4. Campaign list, new campaign creation, `.trame` ZIP archive import & export,
 *    and 1-click Magic Link invite generation.
 * ============================================================================
 */

import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  apiBindGuestAccount,
  apiCreateCampaign,
  apiGetCampaign,
  apiImportArchive,
  apiListCampaigns,
  apiListNotes,
  apiLogin,
  apiLogout,
  apiMintInvite,
  apiPresignAssetUrl,
  apiRedeemMagicLink,
  apiRegister,
  globalWsClient,
} from '../net/wsClient.ts';
import {
  type CampaignSummary,
  activeCampaignSignal,
  campaignsSignal,
  currentUserSignal,
  lastErrorBannerSignal,
  mapImageUrlSignal,
  revealedHandoutsSignal,
  wikiNotesSignal,
} from '../store/signals.ts';

export function Lobby() {
  const authTab = useSignal<'login' | 'register' | 'magic'>('register');
  const email = useSignal('gm@trame.local');
  const displayName = useSignal('Archmage Seren');
  const password = useSignal('HighEntropyPassw0rd2026!');
  const magicToken = useSignal('');
  const magicNickname = useSignal('Adventurer');

  const newCampaignName = useSignal('Obsidian Spire Expedition');
  const newCampaignSystem = useSignal('dnd5e');
  const mintedInviteToken = useSignal<string | null>(null);
  const statusMsg = useSignal<string | null>(null);
  const bindEmail = useSignal('');
  const bindPassword = useSignal('');

  const user = currentUserSignal.value;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token') ?? params.get('invite');
    if (urlToken && !currentUserSignal.value) {
      magicToken.value = urlToken;
      authTab.value = 'magic';
    }
  }, []);

  const refreshCampaigns = async () => {
    try {
      campaignsSignal.value = await apiListCampaigns();
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  };

  const enterCampaignTable = async (camp: CampaignSummary) => {
    try {
      const fullCamp = await apiGetCampaign(camp.id);
      activeCampaignSignal.value = fullCamp;
      if (fullCamp.active_map_hash) {
        try {
          mapImageUrlSignal.value = await apiPresignAssetUrl(fullCamp.id, fullCamp.active_map_hash);
        } catch {
          mapImageUrlSignal.value = null;
        }
      } else {
        mapImageUrlSignal.value = null;
      }
      try {
        const notesData = await apiListNotes(fullCamp.id);
        wikiNotesSignal.value = notesData.notes;
        revealedHandoutsSignal.value = notesData.handouts;
      } catch {
        // ignore
      }
      if (currentUserSignal.value) {
        globalWsClient.connect(fullCamp.id, currentUserSignal.value.id, fullCamp.role);
      }
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  };

  const handleAuthSubmit = async (e: Event) => {
    e.preventDefault();
    lastErrorBannerSignal.value = null;
    statusMsg.value = null;
    try {
      if (authTab.value === 'register') {
        const u = await apiRegister(email.value, displayName.value, password.value);
        currentUserSignal.value = u;
        await refreshCampaigns();
      } else if (authTab.value === 'login') {
        const u = await apiLogin(email.value, password.value);
        currentUserSignal.value = u;
        await refreshCampaigns();
      } else {
        const res = await apiRedeemMagicLink(magicToken.value.trim(), magicNickname.value.trim());
        currentUserSignal.value = res.user;
        await refreshCampaigns();
        const joined = campaignsSignal.value.find((c) => c.id === res.campaign_id);
        if (joined) {
          await enterCampaignTable(joined);
        }
      }
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  };

  const handleCreateCampaign = async (e: Event) => {
    e.preventDefault();
    if (!newCampaignName.value.trim()) return;
    try {
      const created = await apiCreateCampaign(newCampaignName.value.trim(), newCampaignSystem.value);
      campaignsSignal.value = [created, ...campaignsSignal.value];
      statusMsg.value = `Created campaign "${created.name}"`;
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  };

  const handleMintInvite = async (campaignId: string, role = 'PLAYER') => {
    try {
      const res = await apiMintInvite(campaignId, role);
      mintedInviteToken.value = res.token;
      statusMsg.value = `Minted ${role} Magic Link invite token`;
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  };

  const handleImportTrameFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const res = await apiImportArchive(buf, true);
      statusMsg.value = `Imported campaign archive "${res.name}"`;
      await refreshCampaigns();
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  };

  const handleBindGuest = async (e: Event) => {
    e.preventDefault();
    try {
      await apiBindGuestAccount(bindEmail.value, bindPassword.value);
      if (currentUserSignal.value) {
        currentUserSignal.value = {
          ...currentUserSignal.value,
          email: bindEmail.value,
          is_guest: false,
          is_ephemeral: false,
        };
      }
      statusMsg.value = 'Guest account permanently bound to email & Argon2id credentials';
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  };

  if (!user) {
    return (
      <div
        data-testid="lobby-auth-container"
        style={{
          maxWidth: '480px',
          margin: '3rem auto',
          padding: '1.75rem',
          background: '#161b26',
          borderRadius: '12px',
          border: '1px solid #262f40',
          boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        }}
      >
        <h1 style={{ margin: '0 0 0.5rem 0', fontSize: '1.4rem', color: '#f8fafc' }}>
          TRAME — Tactical Virtual Tabletop
        </h1>
        <p style={{ margin: '0 0 1.25rem 0', fontSize: '0.9rem', color: '#94a3b8' }}>
          High-craft 2.5D BVH line-of-sight, deterministic ChaCha20 dice, and portable .trame archives.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
          {(['register', 'login', 'magic'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              data-testid={`auth-tab-${tab}`}
              onClick={() => {
                authTab.value = tab;
                lastErrorBannerSignal.value = null;
              }}
              style={{
                flex: 1,
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                border: '1px solid #334155',
                background: authTab.value === tab ? '#3b82f6' : '#1e293b',
                color: '#f8fafc',
                cursor: 'pointer',
                fontWeight: 600,
                textTransform: 'capitalize',
              }}
            >
              {tab === 'magic' ? 'Magic Invite' : tab}
            </button>
          ))}
        </div>

        <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {authTab.value !== 'magic' ? (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem' }}>
                <span>Email Address</span>
                <input
                  data-testid="auth-email-input"
                  type="email"
                  value={email.value}
                  onInput={(e) => (email.value = (e.currentTarget as HTMLInputElement).value)}
                  required
                  style={{
                    padding: '0.55rem 0.75rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#0f172a',
                    color: '#f8fafc',
                  }}
                />
              </label>

              {authTab.value === 'register' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem' }}>
                  <span>Display Name</span>
                  <input
                    data-testid="auth-displayname-input"
                    type="text"
                    value={displayName.value}
                    onInput={(e) => (displayName.value = (e.currentTarget as HTMLInputElement).value)}
                    required
                    style={{
                      padding: '0.55rem 0.75rem',
                      borderRadius: '6px',
                      border: '1px solid #334155',
                      background: '#0f172a',
                      color: '#f8fafc',
                    }}
                  />
                </label>
              )}

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem' }}>
                <span>Password (Argon2id)</span>
                <input
                  data-testid="auth-password-input"
                  type="password"
                  value={password.value}
                  onInput={(e) => (password.value = (e.currentTarget as HTMLInputElement).value)}
                  required
                  style={{
                    padding: '0.55rem 0.75rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#0f172a',
                    color: '#f8fafc',
                  }}
                />
              </label>
            </>
          ) : (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem' }}>
                <span>Magic Link Invite Token (JWT)</span>
                <input
                  data-testid="auth-magic-token-input"
                  type="text"
                  value={magicToken.value}
                  onInput={(e) => (magicToken.value = (e.currentTarget as HTMLInputElement).value)}
                  placeholder="Paste invite JWT token..."
                  required
                  style={{
                    padding: '0.55rem 0.75rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#0f172a',
                    color: '#f8fafc',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem' }}>
                <span>Table Nickname</span>
                <input
                  data-testid="auth-magic-nickname-input"
                  type="text"
                  value={magicNickname.value}
                  onInput={(e) => (magicNickname.value = (e.currentTarget as HTMLInputElement).value)}
                  required
                  style={{
                    padding: '0.55rem 0.75rem',
                    borderRadius: '6px',
                    border: '1px solid #334155',
                    background: '#0f172a',
                    color: '#f8fafc',
                  }}
                />
              </label>
            </>
          )}

          <button
            data-testid="auth-submit-btn"
            type="submit"
            style={{
              marginTop: '0.4rem',
              padding: '0.65rem 1rem',
              borderRadius: '6px',
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {authTab.value === 'register'
              ? 'Create Account & Enter Lobby'
              : authTab.value === 'login'
                ? 'Sign In'
                : 'Join Campaign via Magic Link'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div
      data-testid="campaign-lobby-view"
      style={{
        maxWidth: '960px',
        margin: '2rem auto',
        padding: '0 1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1rem 1.25rem',
          background: '#161b26',
          borderRadius: '10px',
          border: '1px solid #262f40',
        }}
      >
        <div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f8fafc' }}>
            Welcome, {user.display_name}
          </div>
          <div style={{ fontSize: '0.82rem', color: '#94a3b8' }}>
            {user.email} {user.is_guest ? '(Guest Session)' : '(Permanent Account)'}
          </div>
        </div>
        <button
          data-testid="lobby-logout-btn"
          type="button"
          onClick={async () => {
            await apiLogout();
            currentUserSignal.value = null;
            campaignsSignal.value = [];
          }}
          style={{
            padding: '0.45rem 0.85rem',
            borderRadius: '6px',
            border: '1px solid #475569',
            background: '#1e293b',
            color: '#e2e8f0',
            cursor: 'pointer',
          }}
        >
          Sign Out
        </button>
      </div>

      {statusMsg.value && (
        <div
          data-testid="lobby-status-banner"
          style={{
            padding: '0.75rem 1rem',
            borderRadius: '8px',
            background: 'rgba(16, 185, 129, 0.15)',
            border: '1px solid #10b981',
            color: '#6ee7b7',
            fontSize: '0.88rem',
          }}
        >
          {statusMsg.value}
        </div>
      )}

      {mintedInviteToken.value && (
        <div
          data-testid="minted-invite-box"
          style={{
            padding: '0.85rem 1rem',
            borderRadius: '8px',
            background: '#1e293b',
            border: '1px solid #3b82f6',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
          }}
        >
          <label
            htmlFor="minted-invite-token-input"
            style={{ fontSize: '0.82rem', fontWeight: 600, color: '#93c5fd' }}
          >
            1-Click Player Magic Link Invite Token:
          </label>
          <input
            id="minted-invite-token-input"
            aria-label="1-Click Player Magic Link Invite Token"
            data-testid="minted-invite-token-input"
            type="text"
            readOnly
            value={mintedInviteToken.value}
            style={{
              width: '100%',
              padding: '0.45rem',
              borderRadius: '4px',
              border: '1px solid #334155',
              background: '#0f172a',
              color: '#f8fafc',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
            }}
          />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
        <form
          onSubmit={handleCreateCampaign}
          style={{
            padding: '1.25rem',
            background: '#161b26',
            borderRadius: '10px',
            border: '1px solid #262f40',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: '#f8fafc' }}>Create New Campaign</h2>
          <input
            aria-label="Campaign Name"
            data-testid="create-campaign-name-input"
            type="text"
            value={newCampaignName.value}
            onInput={(e) => (newCampaignName.value = (e.currentTarget as HTMLInputElement).value)}
            placeholder="Campaign Name..."
            required
            style={{
              padding: '0.55rem 0.75rem',
              borderRadius: '6px',
              border: '1px solid #334155',
              background: '#0f172a',
              color: '#f8fafc',
            }}
          />
          <button
            data-testid="create-campaign-submit-btn"
            type="submit"
            style={{
              padding: '0.6rem 1rem',
              borderRadius: '6px',
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + Create Campaign
          </button>
        </form>

        <div
          style={{
            padding: '1.25rem',
            background: '#161b26',
            borderRadius: '10px',
            border: '1px solid #262f40',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: '#f8fafc' }}>
            Import Portable .trame Archive
          </h2>
          <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>
            Restore a streaming PKWARE ZIP `.trame` archive with automatic SHA-256 verification.
          </p>
          <input
            aria-label="Import Portable .trame Archive File"
            data-testid="import-trame-file-input"
            type="file"
            accept=".trame,.zip"
            onChange={handleImportTrameFile}
            style={{ fontSize: '0.85rem', color: '#cbd5e1' }}
          />
        </div>
      </div>

      {user.is_guest && (
        <form
          onSubmit={handleBindGuest}
          style={{
            padding: '1rem 1.25rem',
            background: '#1e293b',
            borderRadius: '10px',
            border: '1px solid #f59e0b',
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <strong style={{ fontSize: '0.88rem', color: '#fcd34d' }}>Bind Guest Account:</strong>
          <input
            aria-label="Permanent Email"
            data-testid="bind-guest-email-input"
            type="email"
            placeholder="Permanent Email"
            value={bindEmail.value}
            onInput={(e) => (bindEmail.value = (e.currentTarget as HTMLInputElement).value)}
            required
            style={{
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#f8fafc',
            }}
          />
          <input
            aria-label="Strong Password"
            data-testid="bind-guest-password-input"
            type="password"
            placeholder="Strong Password"
            value={bindPassword.value}
            onInput={(e) => (bindPassword.value = (e.currentTarget as HTMLInputElement).value)}
            required
            style={{
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid #475569',
              background: '#0f172a',
              color: '#f8fafc',
            }}
          />
          <button
            data-testid="bind-guest-submit-btn"
            type="submit"
            style={{
              padding: '0.45rem 0.85rem',
              borderRadius: '6px',
              border: 'none',
              background: '#d97706',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Save Permanent Account
          </button>
        </form>
      )}

      <div
        style={{
          padding: '1.25rem',
          background: '#161b26',
          borderRadius: '10px',
          border: '1px solid #262f40',
        }}
      >
        <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem', color: '#f8fafc' }}>
          Your Campaigns ({campaignsSignal.value.length})
        </h2>
        {campaignsSignal.value.length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: '0.9rem', margin: 0 }}>
            No campaigns yet. Create one above to launch the live tabletop!
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {campaignsSignal.value.map((camp) => (
              <div
                key={camp.id}
                data-testid={`campaign-card-${camp.id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.85rem 1rem',
                  background: '#0f172a',
                  borderRadius: '8px',
                  border: '1px solid #334155',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, color: '#f8fafc' }}>{camp.name}</div>
                  <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                    System: {camp.system.toUpperCase()} • Role: {camp.role}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {camp.role.toUpperCase() === 'GM' && (
                    <button
                      type="button"
                      data-testid={`mint-invite-btn-${camp.id}`}
                      onClick={() => handleMintInvite(camp.id, 'PLAYER')}
                      style={{
                        padding: '0.45rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid #3b82f6',
                        background: 'transparent',
                        color: '#93c5fd',
                        fontSize: '0.82rem',
                        cursor: 'pointer',
                      }}
                    >
                      Invite Link
                    </button>
                  )}
                  <a
                    href={`/api/v1/campaigns/${camp.id}/export`}
                    download={`campaign-${camp.id}.trame`}
                    data-testid={`export-campaign-btn-${camp.id}`}
                    style={{
                      padding: '0.45rem 0.75rem',
                      borderRadius: '6px',
                      border: '1px solid #475569',
                      color: '#cbd5e1',
                      textDecoration: 'none',
                      fontSize: '0.82rem',
                    }}
                  >
                    Export .trame
                  </a>
                  <button
                    type="button"
                    data-testid={`launch-table-btn-${camp.id}`}
                    onClick={() => enterCampaignTable(camp)}
                    style={{
                      padding: '0.45rem 0.95rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#10b981',
                      color: '#064e3b',
                      fontWeight: 700,
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                    }}
                  >
                    Launch Table
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
