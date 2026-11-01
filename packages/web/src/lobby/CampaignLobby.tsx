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
 * 2. `One Invite Request At A Time`:
 *    - While a link is being minted the button is `aria-disabled` +
 *      `aria-busy` and ignores clicks, so repeated clicks cannot mint several
 *      live invite tokens.
 * 3. `Explicit Loading / Error / Empty States`:
 *    - The list is never blank without explanation: it shows a busy message,
 *      a retryable error, or the cartographic `AtlasEmptyState`.
 * 4. `Announced Outcomes`:
 *    - A persistent `role="status"` region announces created campaigns and
 *      ready invite links; the new invite URL field also receives focus.
 * 5. `ATLAS v1.1 Only`:
 *    - Layout uses `ds-*` primitives and `--atlas-*` tokens, no raw colors.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient } from "../api/client.ts";
import type { Campaign } from "../api/session.ts";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { AtlasEmptyState } from "../components/icons/AtlasEmptyStates.tsx";
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
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [inviteFailedId, setInviteFailedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const focusInviteId = useRef<string | null>(null);
  const pendingInvites = useRef(new Set<string>());

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
    setCreateFailed(false);
    try {
      const campaign = await client.createCampaign({ name: trimmed });
      setName("");
      setAnnouncement(t("lobby.created", { name: campaign.name }));
    } catch {
      setCreateFailed(true);
    }
    setCreating(false);
  };

  const onInvite = async (campaign: Campaign) => {
    if (pendingInvites.current.has(campaign.id)) return;
    pendingInvites.current.add(campaign.id);
    setInvitingId(campaign.id);
    setInviteFailedId(null);
    try {
      const invite = await client.createCampaignInvite(campaign.id);
      focusInviteId.current = campaign.id;
      setInvites((prev) => ({ ...prev, [campaign.id]: invite.inviteUrl }));
      setAnnouncement(t("lobby.inviteReady", { name: campaign.name }));
    } catch {
      setInviteFailedId(campaign.id);
    }
    pendingInvites.current.delete(campaign.id);
    setInvitingId(null);
  };

  const focusNewInvite = (campaignId: string) => (el: HTMLInputElement | null) => {
    if (el && focusInviteId.current === campaignId) {
      focusInviteId.current = null;
      el.focus();
      el.select?.();
    }
  };

  const renderCampaign = (campaign: Campaign) => {
    const pending = invitingId === campaign.id;
    return (
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
                aria-label={
                  pending
                    ? t("lobby.inviteCreatingAria", { name: campaign.name })
                    : t("lobby.inviteAria", { name: campaign.name })
                }
                aria-busy={pending ? "true" : undefined}
                aria-disabled={pending ? "true" : undefined}
                onClick={() => onInvite(campaign)}
              >
                {pending ? t("lobby.inviteCreating") : t("lobby.invite")}
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
              ref={focusNewInvite(campaign.id)}
              class="ds-input"
              type="text"
              readOnly
              value={invites[campaign.id]}
            />
          </label>
        )}
        {inviteFailedId === campaign.id && (
          <p role="alert" class="ds-field-error">
            {t("lobby.inviteFailed")}
          </p>
        )}
      </li>
    );
  };

  return (
    <main
      data-testid="campaign-lobby"
      class="ds-stack"
      style={{ gap: "var(--atlas-space-lg)", padding: "var(--atlas-space-lg)", maxWidth: "48rem", width: "100%", margin: "0 auto" }}
    >
      <p role="status" class="ds-visually-hidden" data-testid="lobby-status">
        {loadState === "loading" ? t("lobby.loading") : announcement}
      </p>
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
          <AtlasEmptyState kind="campaigns" data-testid="lobby-empty" heading={t("lobby.emptyHeading")} body={t("lobby.emptyBody")} />
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
        {createFailed && (
          <p role="alert" data-testid="lobby-create-error" class="ds-field-error">
            {t("lobby.createFailed")}
          </p>
        )}
      </section>
    </main>
  );
}
