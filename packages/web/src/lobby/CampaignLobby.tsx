/**
 * ============================================================================
 * CAMPAIGN LOBBY (lobby/CampaignLobby.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * First screen after sign-in: lists the caller's campaigns, opens one (which
 * sets `session.activeCampaignId` and lets the shell connect the room
 * socket), creates new campaigns, and lets a GM mint an invite link.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `GM-Only Invite Control`:
 *    - The invite button renders only for campaigns where the caller's role
 *      is `GM`. The server (`POST /api/v1/campaigns/{id}/invites`) remains the
 *      authority; the UI just avoids offering a call that would be refused.
 * 2. `Explicit Loading / Error / Empty States`:
 *    - The list is never blank without explanation: it shows a busy message,
 *      a retryable error, or an empty-state hint.
 * 3. `ATLAS v1.1 Only`:
 *    - Layout uses `ds-*` primitives and `--atlas-*` tokens, no raw colors.
 * ============================================================================
 */
import { useEffect, useState } from "preact/hooks";
import type { ApiClient } from "../api/client.ts";
import type { Campaign } from "../api/session.ts";
import { t, type MessageKey } from "../i18n/index.ts";

/** Props for `CampaignLobby`. */
export interface CampaignLobbyProps {
  client: ApiClient;
}

type LoadState = "loading" | "ready" | "failed";

const ROLE_KEYS: Record<string, MessageKey> = {
  GM: "lobby.role.GM",
  PLAYER: "lobby.role.PLAYER",
  SPECTATOR: "lobby.role.SPECTATOR",
};

/** Campaign list, creation form, and GM invite minting. */
export function CampaignLobby({ client }: CampaignLobbyProps) {
  const campaigns = client.state.campaigns.value;
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [name, setName] = useState("");
  const [createFailed, setCreateFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [invites, setInvites] = useState<Record<string, string>>({});
  const [inviteFailedId, setInviteFailedId] = useState<string | null>(null);

  const load = () => {
    setLoadState("loading");
    client.listCampaigns().then(
      () => setLoadState("ready"),
      () => setLoadState("failed"),
    );
  };

  useEffect(load, [client]);

  const onCreate = async (e: Event) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateFailed(false);
    try {
      await client.createCampaign({ name: trimmed });
      setName("");
    } catch {
      setCreateFailed(true);
    }
    setCreating(false);
  };

  const onInvite = async (campaign: Campaign) => {
    setInviteFailedId(null);
    try {
      const invite = await client.createCampaignInvite(campaign.id);
      setInvites((prev) => ({ ...prev, [campaign.id]: invite.inviteUrl }));
    } catch {
      setInviteFailedId(campaign.id);
    }
  };

  const renderCampaign = (campaign: Campaign) => (
    <li
      key={campaign.id}
      class="ds-panel"
      data-testid={`lobby-campaign-${campaign.id}`}
      style={{ display: "flex", flexDirection: "column", gap: "var(--atlas-space-sm)" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--atlas-space-sm)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--atlas-space-xs)" }}>
          <strong>{campaign.name}</strong>
          <span style={{ color: "var(--atlas-text-muted)", fontSize: "var(--atlas-text-sm)" }}>
            {ROLE_KEYS[campaign.role] ? t(ROLE_KEYS[campaign.role]) : campaign.role}
          </span>
        </div>
        <div style={{ display: "flex", gap: "var(--atlas-space-sm)" }}>
          {campaign.role === "GM" && (
            <button
              type="button"
              class="ds-btn ds-btn-secondary"
              data-testid={`lobby-invite-${campaign.id}`}
              aria-label={t("lobby.inviteAria", { name: campaign.name })}
              onClick={() => onInvite(campaign)}
            >
              {t("lobby.invite")}
            </button>
          )}
          <button
            type="button"
            class="ds-btn ds-btn-primary"
            data-testid={`lobby-open-${campaign.id}`}
            aria-label={t("lobby.openAria", { name: campaign.name })}
            onClick={() => {
              client.state.activeCampaignId.value = campaign.id;
            }}
          >
            {t("lobby.open")}
          </button>
        </div>
      </div>
      {invites[campaign.id] && (
        <label class="ds-field" for={`lobby-invite-url-${campaign.id}`}>
          <span class="ds-field-label">{t("lobby.inviteLink", { name: campaign.name })}</span>
          <input
            id={`lobby-invite-url-${campaign.id}`}
            data-testid={`lobby-invite-url-${campaign.id}`}
            class="ds-input"
            type="text"
            readOnly
            value={invites[campaign.id]}
          />
        </label>
      )}
      {inviteFailedId === campaign.id && (
        <p role="alert" style={{ margin: 0, color: "var(--atlas-danger)" }}>
          {t("lobby.inviteFailed")}
        </p>
      )}
    </li>
  );

  return (
    <main
      data-testid="campaign-lobby"
      style={{ display: "flex", flexDirection: "column", gap: "var(--atlas-space-lg)", padding: "var(--atlas-space-lg)", maxWidth: "48rem", width: "100%", margin: "0 auto" }}
    >
      <section aria-labelledby="lobby-title" style={{ display: "flex", flexDirection: "column", gap: "var(--atlas-space-md)" }}>
        <h1 id="lobby-title" class="ds-panel-title">
          {t("lobby.title")}
        </h1>
        {loadState === "loading" && (
          <p data-testid="lobby-loading" aria-busy="true">
            {t("lobby.loading")}
          </p>
        )}
        {loadState === "failed" && (
          <div role="alert" data-testid="lobby-load-error" style={{ display: "flex", gap: "var(--atlas-space-sm)", alignItems: "center" }}>
            <span style={{ color: "var(--atlas-danger)" }}>{t("lobby.loadFailed")}</span>
            <button type="button" class="ds-btn ds-btn-secondary" onClick={load}>
              {t("lobby.retry")}
            </button>
          </div>
        )}
        {loadState === "ready" && campaigns.length === 0 && <p data-testid="lobby-empty">{t("lobby.empty")}</p>}
        {campaigns.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--atlas-space-sm)" }}>
            {campaigns.map(renderCampaign)}
          </ul>
        )}
      </section>

      <section class="ds-panel" aria-labelledby="lobby-create-title">
        <h2 id="lobby-create-title" class="ds-panel-title">
          {t("lobby.createTitle")}
        </h2>
        <form
          data-testid="lobby-create-form"
          onSubmit={onCreate}
          style={{ display: "flex", gap: "var(--atlas-space-sm)", alignItems: "flex-end", flexWrap: "wrap", marginTop: "var(--atlas-space-md)" }}
        >
          <label class="ds-field" for="lobby-campaign-name" style={{ flex: "1 1 16rem" }}>
            <span class="ds-field-label">{t("lobby.campaignName")}</span>
            <input
              id="lobby-campaign-name"
              data-testid="lobby-campaign-name"
              class="ds-input"
              type="text"
              required
              value={name}
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="ds-btn ds-btn-primary" data-testid="lobby-create" disabled={creating}>
            {t("lobby.create")}
          </button>
        </form>
        {createFailed && (
          <p role="alert" data-testid="lobby-create-error" style={{ color: "var(--atlas-danger)" }}>
            {t("lobby.createFailed")}
          </p>
        )}
      </section>
    </main>
  );
}
