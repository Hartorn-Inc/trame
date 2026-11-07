/**
 * ============================================================================
 * CAMPAIGN LOBBY (lobby/CampaignLobby.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * First screen after sign-in: lists the caller's campaigns, opens one (which
 * sets `session.activeCampaignId` and lets the shell connect the room
 * socket), creates new campaigns for `Host` / `Owner` accounts, opens the
 * Game Master's `CampaignInvite` management, and prompts legacy guests to
 * bind a real login.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Creation Follows InstanceRole`:
 *    - The create-campaign form renders only for `HOST` and `OWNER`; a
 *      `MEMBER` reads why and how to join instead. The server still refuses
 *      creation (`403 HOST_REQUIRED`), which maps to the same explanation.
 * 2. `GM-Only Invite Control`:
 *    - The invite button renders only for campaigns where the caller's role
 *      is `GM`; it opens `CampaignInviteDialog`. The server remains the
 *      authority (`403 GM_REQUIRED`).
 * 3. `Explicit Loading / Error / Empty States`:
 *    - The list is never blank without explanation: it shows a busy message,
 *      a retryable error, or the cartographic `AtlasEmptyState`.
 * 4. `Announced Outcomes`:
 *    - A persistent `role="status"` region announces created campaigns and a
 *      bound guest account.
 * 5. `ATLAS v1.1 Only`:
 *    - Layout uses `ds-*` primitives and `--atlas-*` tokens, no raw colors.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../api/client.ts";
import type { Campaign } from "../api/session.ts";
import { GuestBindPrompt } from "../auth/GuestBindPrompt.tsx";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { AtlasEmptyState } from "../components/icons/AtlasEmptyStates.tsx";
import { t, type MessageKey } from "../i18n/index.ts";
import { CampaignInviteDialog } from "./CampaignInviteDialog.tsx";

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

/** Campaign list, Host/Owner campaign creation, GM invite management, guest bind prompt. */
export function CampaignLobby({ client }: CampaignLobbyProps) {
  const campaigns = client.state.campaigns.value;
  const user = client.state.user.value;
  const canCreate = user?.instanceRole === "HOST" || user?.instanceRole === "OWNER";
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<MessageKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [inviteFor, setInviteFor] = useState<Campaign | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useFocusOnMount(titleRef);

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
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const campaign = await client.createCampaign({ name: trimmed });
      setName("");
      setAnnouncement(t("lobby.created", { name: campaign.name }));
    } catch (err) {
      setCreateError(err instanceof ApiError && err.code === "HOST_REQUIRED" ? "lobby.createRestricted" : "lobby.createFailed");
    }
    setCreating(false);
  };

  const renderCampaign = (campaign: Campaign) => (
    <li key={campaign.id} class="ds-panel ds-stack-sm" data-testid={`lobby-campaign-${campaign.id}`}>
      <div class="ds-row" style={{ flexWrap: "wrap" }}>
        <div class="ds-stack-sm" style={{ gap: "var(--atlas-space-xs)" }}>
          <strong>{campaign.name}</strong>
          <span class="ds-meta">{ROLE_KEYS[campaign.role] ? t(ROLE_KEYS[campaign.role]) : campaign.role}</span>
        </div>
        <div class="ds-cluster">
          {campaign.role === "GM" && (
            <button
              type="button"
              class="ds-btn ds-btn-secondary"
              data-testid={`lobby-invite-${campaign.id}`}
              aria-label={t("lobby.inviteAria", { name: campaign.name })}
              aria-haspopup="dialog"
              onClick={() => setInviteFor(campaign)}
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
    </li>
  );

  return (
    <main
      data-testid="campaign-lobby"
      class="ds-stack"
      style={{ gap: "var(--atlas-space-lg)", padding: "var(--atlas-space-lg)", maxWidth: "48rem", width: "100%", margin: "0 auto" }}
    >
      <p role="status" class="ds-visually-hidden" data-testid="lobby-status">
        {loadState === "loading" ? t("lobby.loading") : announcement}
      </p>
      {user?.isGuest && (
        <GuestBindPrompt
          client={client}
          onBound={() => {
            setAnnouncement(t("bind.done"));
            titleRef.current?.focus();
          }}
        />
      )}
      <section aria-labelledby="lobby-title" class="ds-stack">
        <h1 id="lobby-title" ref={titleRef} tabIndex={-1} class="ds-panel-title">
          {t("lobby.title")}
        </h1>
        {loadState === "loading" && (
          <p data-testid="lobby-loading" aria-hidden="true">
            {t("lobby.loading")}
          </p>
        )}
        {loadState === "failed" && (
          <div role="alert" data-testid="lobby-load-error" class="ds-cluster">
            <span class="ds-field-error">{t("lobby.loadFailed")}</span>
            <button type="button" class="ds-btn ds-btn-secondary" onClick={load}>
              {t("lobby.retry")}
            </button>
          </div>
        )}
        {loadState === "ready" && campaigns.length === 0 && (
          <AtlasEmptyState
            kind="campaigns"
            data-testid="lobby-empty"
            heading={t("lobby.emptyHeading")}
            body={t(canCreate ? "lobby.emptyBody" : "lobby.emptyBodyMember")}
          />
        )}
        {campaigns.length > 0 && (
          <ul role="list" class="ds-list-plain ds-stack-sm">
            {campaigns.map(renderCampaign)}
          </ul>
        )}
      </section>

      <section class="ds-panel ds-stack" aria-labelledby="lobby-create-title">
        <h2 id="lobby-create-title" class="ds-panel-title">
          {t("lobby.createTitle")}
        </h2>
        {canCreate ? (
          <form data-testid="lobby-create-form" onSubmit={onCreate} class="ds-cluster" style={{ alignItems: "flex-end" }}>
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
            <button
              type="submit"
              class="ds-btn ds-btn-primary"
              data-testid="lobby-create"
              aria-disabled={creating ? "true" : undefined}
              aria-busy={creating ? "true" : undefined}
            >
              {t("lobby.create")}
            </button>
          </form>
        ) : (
          <p data-testid="lobby-create-restricted">{t("lobby.createRestricted")}</p>
        )}
        {createError && (
          <p role="alert" data-testid="lobby-create-error" class="ds-field-error">
            {t(createError)}
          </p>
        )}
      </section>

      {inviteFor && <CampaignInviteDialog client={client} campaign={inviteFor} onClose={() => setInviteFor(null)} />}
    </main>
  );
}
