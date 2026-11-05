/**
 * ============================================================================
 * CAMPAIGN INVITE MANAGEMENT DIALOG (lobby/CampaignInviteDialog.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * The Game Master's control over who can join a campaign (SEC7, ADR-0039):
 * mint the campaign's single `CampaignInvite` with a bounded lifetime and
 * use count, copy it, see its status, revoke it, review every
 * `InviteRedemption`, and remove a member (which also disconnects their live
 * table sockets). Without bounds and visibility a leaked link would let
 * anyone in, unnoticed.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Bounded Links`:
 *    - Lifetime is chosen from fixed options up to 7 days (`604800 s`), and
 *      max uses must be an integer in `1..=100` (default 8). Out-of-range
 *      input is flagged locally; the server enforces the same bounds.
 * 2. `URL Shown Once`:
 *    - The server returns the URL and token only when minting (storage keeps
 *      a hash). Reopening the dialog shows the status of the active link and
 *      explains that sharing it again requires a new link, which revokes the
 *      old one.
 * 3. `Destructive Actions Confirmed`:
 *    - Removing a member is a two-step action (Remove -> Confirm removal);
 *      revoking needs no confirmation because a new link can be minted.
 * 4. `Only Current Members Are Removable`:
 *    - Redemptions are cross-checked with `GET .../members`; the GM role is
 *      never offered for removal, and removed users read "No longer a member".
 * 5. `Modal Keyboard Contract`:
 *    - `useModalFocusTrap` (Tab cycles, Escape closes, focus returns to the
 *      lobby button). After a request removes the focused control, focus is
 *      moved to the next logical control instead of being dropped.
 * 6. `Announced Outcomes`:
 *    - A persistent `role="status"` region announces minted, copied, revoked
 *      and removed results; failures use `role="alert"`.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * mount -> [`getActiveInvite`, `listInviteRedemptions`, `listMembers`]
 * create -> `createCampaignInvite({ ttlSeconds, maxUses })` -> URL focused
 * revoke -> `revokeCampaignInvite` -> status `revoked`
 * remove -> confirm -> `removeCampaignMember` -> members reloaded.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient, CampaignInvite, InviteRedemptionRecord, InviteStatus } from "../api/client.ts";
import type { Campaign } from "../api/session.ts";
import { apiErrorKey } from "../auth/accountForm.tsx";
import { useModalFocusTrap } from "../components/a11y/useModalFocusTrap.ts";
import { formatEpochSeconds, t, type MessageKey } from "../i18n/index.ts";

/** Longest invite lifetime the server accepts: 7 days in seconds. */
export const MAX_INVITE_TTL_SECONDS = 604_800;
/** Highest `max_uses` the server accepts. */
export const MAX_INVITE_MAX_USES = 100;
/** Default `max_uses` (spec user story 12). */
export const DEFAULT_INVITE_MAX_USES = 8;

/** Lifetime choices in seconds: 1 hour, 1 day, 3 days, 7 days (default). */
const TTL_OPTIONS: ReadonlyArray<{ seconds: number; label: MessageKey }> = [
  { seconds: 3_600, label: "invites.ttl.hour" },
  { seconds: 86_400, label: "invites.ttl.day" },
  { seconds: 259_200, label: "invites.ttl.threeDays" },
  { seconds: MAX_INVITE_TTL_SECONDS, label: "invites.ttl.week" },
];

const STATUS_KEYS: Record<InviteStatus, MessageKey> = {
  active: "invites.status.active",
  revoked: "invites.status.revoked",
  expired: "invites.status.expired",
  exhausted: "invites.status.exhausted",
};

const ERRORS: Record<string, MessageKey> = {
  GM_REQUIRED: "invites.error.gmRequired",
  INVALID_MAX_USES: "invites.error.maxUses",
  NO_ACTIVE_INVITE: "invites.error.noActive",
  CANNOT_REMOVE_GM: "invites.error.cannotRemoveGm",
  MEMBER_NOT_FOUND: "invites.error.memberGone",
};

const MAX_USES_ERROR_ID = "invite-max-uses-error";

/** Props for `CampaignInviteDialog`. */
export interface CampaignInviteDialogProps {
  client: ApiClient;
  /** Campaign whose invite is managed; the caller must be its GM. */
  campaign: Campaign;
  onClose: () => void;
}

/** Parses the max-uses field; `null` unless it is an integer in `1..=100`. */
export function parseMaxUses(raw: string): number | null {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 && value <= MAX_INVITE_MAX_USES ? value : null;
}

/** GM dialog: mint, copy, revoke the campaign invite; list redemptions; remove members. */
export function CampaignInviteDialog({ client, campaign, onClose }: CampaignInviteDialogProps) {
  const [loaded, setLoaded] = useState<"loading" | "ready" | "failed">("loading");
  const [invite, setInvite] = useState<CampaignInvite | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<InviteRedemptionRecord[]>([]);
  const [memberRoles, setMemberRoles] = useState<Record<string, string>>({});
  const [ttlSeconds, setTtlSeconds] = useState(MAX_INVITE_TTL_SECONDS);
  const [maxUses, setMaxUses] = useState(String(DEFAULT_INVITE_MAX_USES));
  const [maxUsesInvalid, setMaxUsesInvalid] = useState(false);
  const [busy, setBusy] = useState<"create" | "revoke" | "remove" | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);
  const redemptionsTitleRef = useRef<HTMLHeadingElement | null>(null);
  const focusUrl = useRef(false);
  const inFlight = useRef(false);

  useModalFocusTrap(dialogRef, { onEscape: onClose });

  const loadMembers = async () => {
    const members = await client.listMembers(campaign.id);
    setMemberRoles(Object.fromEntries(members.map((m) => [m.userId, m.role])));
  };

  useEffect(() => {
    Promise.all([client.getActiveInvite(campaign.id), client.listInviteRedemptions(campaign.id), loadMembers()]).then(
      ([active, list]) => {
        setInvite(active);
        setRedemptions(list);
        setLoaded("ready");
      },
      () => setLoaded("failed"),
    );
  }, [client, campaign.id]);

  useEffect(() => {
    if (focusUrl.current && urlRef.current) {
      focusUrl.current = false;
      urlRef.current.focus();
      urlRef.current.select?.();
    }
  }, [inviteUrl]);

  /** Runs one request at a time (invariant 5 relies on a single pending action). */
  const guarded = async (kind: "create" | "revoke" | "remove", action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(apiErrorKey(err, ERRORS, "invites.error.generic"));
    }
    inFlight.current = false;
    setBusy(null);
  };

  const onCreate = (e: Event) => {
    e.preventDefault();
    const uses = parseMaxUses(maxUses);
    setMaxUsesInvalid(uses === null);
    if (uses === null) return;
    void guarded("create", async () => {
      const created = await client.createCampaignInvite(campaign.id, { ttlSeconds, maxUses: uses });
      focusUrl.current = true;
      setInvite(created);
      setInviteUrl(created.inviteUrl);
      setAnnouncement(t("invites.created"));
    });
  };

  const onRevoke = () =>
    guarded("revoke", async () => {
      const revoked = await client.revokeCampaignInvite(campaign.id);
      setInvite(revoked);
      setInviteUrl(null);
      setAnnouncement(t("invites.revoked"));
      createRef.current?.focus();
    });

  const onCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setAnnouncement(t("invites.copied"));
    } catch {
      urlRef.current?.select?.();
      setAnnouncement(t("invites.copyManual"));
    }
  };

  const onRemove = (record: InviteRedemptionRecord) => {
    if (confirmRemoveId !== record.userId) {
      setConfirmRemoveId(record.userId);
      return;
    }
    void guarded("remove", async () => {
      try {
        await client.removeCampaignMember(campaign.id, record.userId);
        setAnnouncement(t("invites.removed", { name: record.displayName }));
      } finally {
        setConfirmRemoveId(null);
        await loadMembers().catch(() => undefined);
        redemptionsTitleRef.current?.focus();
      }
    });
  };

  const renderInviteState = () => {
    if (!invite) return <p data-testid="invite-none">{t("invites.none")}</p>;
    return (
      <div class="ds-stack-sm" data-testid="invite-current">
        <span class="ds-cluster" style={{ gap: "var(--atlas-space-xs)" }}>
          <span class="ds-badge" data-testid="invite-status">
            {t(STATUS_KEYS[invite.status])}
          </span>
          <span class="ds-meta atlas-tabular-nums" data-testid="invite-uses">
            {t("invites.uses", { used: invite.useCount, max: invite.maxUses })}
          </span>
        </span>
        <span class="ds-meta" data-testid="invite-expiry">
          {t("invites.expires", { date: formatEpochSeconds(invite.expiresAt) })}
        </span>
        {inviteUrl ? (
          <div class="ds-cluster" style={{ alignItems: "flex-end" }}>
            <label class="ds-field" for="invite-url" style={{ flex: "1 1 16rem" }}>
              <span class="ds-field-label">{t("lobby.inviteLink", { name: campaign.name })}</span>
              <input id="invite-url" data-testid="invite-url" ref={urlRef} class="ds-input" type="text" readOnly value={inviteUrl} />
            </label>
            <button type="button" class="ds-btn ds-btn-secondary" data-testid="invite-copy" onClick={onCopy}>
              {t("invites.copy")}
            </button>
          </div>
        ) : (
          invite.status === "active" && <p class="ds-hint">{t("invites.urlHidden")}</p>
        )}
        {invite.status === "active" && (
          <div>
            <button
              type="button"
              class="ds-btn ds-btn-danger"
              data-testid="invite-revoke"
              aria-busy={busy === "revoke" ? "true" : undefined}
              aria-disabled={busy === "revoke" ? "true" : undefined}
              onClick={onRevoke}
            >
              {t("invites.revoke")}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderRedemption = (record: InviteRedemptionRecord) => {
    const role = memberRoles[record.userId];
    const confirming = confirmRemoveId === record.userId;
    return (
      <li key={`${record.inviteId}-${record.userId}`} class="ds-row" style={{ flexWrap: "wrap" }} data-testid={`redemption-${record.userId}`}>
        <div class="ds-stack-sm" style={{ gap: "var(--atlas-space-xs)" }}>
          <strong>{record.displayName}</strong>
          <span class="ds-meta">{t("invites.joinedAt", { date: formatEpochSeconds(record.redeemedAt) })}</span>
        </div>
        {role === undefined ? (
          <span class="ds-meta" data-testid={`redemption-gone-${record.userId}`}>
            {t("invites.noLongerMember")}
          </span>
        ) : (
          role.toUpperCase() !== "GM" && (
            <span class="ds-cluster">
              <button
                type="button"
                class="ds-btn ds-btn-danger"
                data-testid={`member-remove-${record.userId}`}
                aria-label={t(confirming ? "invites.confirmRemoveAria" : "invites.removeAria", { name: record.displayName })}
                aria-busy={busy === "remove" && confirming ? "true" : undefined}
                aria-disabled={busy === "remove" && confirming ? "true" : undefined}
                onClick={() => onRemove(record)}
              >
                {t(confirming ? "invites.confirmRemove" : "invites.remove")}
              </button>
              {confirming && busy !== "remove" && (
                <button type="button" class="ds-btn ds-btn-secondary" data-testid={`member-remove-cancel-${record.userId}`} onClick={() => setConfirmRemoveId(null)}>
                  {t("invites.cancel")}
                </button>
              )}
            </span>
          )
        )}
      </li>
    );
  };

  return (
    <div
      ref={dialogRef}
      data-testid="invite-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-dialog-title"
      tabIndex={-1}
      class="ds-modal-backdrop"
    >
      <div class="ds-modal">
        <header class="ds-modal-header">
          <h2 id="invite-dialog-title" class="ds-modal-title">
            {t("lobby.inviteAria", { name: campaign.name })}
          </h2>
        </header>
        <div class="ds-modal-body ds-stack">
          <p role="status" class="ds-visually-hidden" data-testid="invite-dialog-status">
            {loaded === "loading" ? t("invites.loading") : announcement}
          </p>
          <div role="alert" data-testid="invite-dialog-alert">
            {loaded === "failed" && <p class="ds-field-error">{t("invites.loadFailed")}</p>}
            {error && (
              <p class="ds-field-error" data-testid="invite-dialog-error">
                {t(error)}
              </p>
            )}
          </div>
          {loaded === "loading" && <p aria-hidden="true">{t("invites.loading")}</p>}

          {loaded === "ready" && (
            <>
              <section class="ds-stack-sm" aria-labelledby="invite-current-title">
                <h3 id="invite-current-title" class="ds-section-title" style={{ margin: 0 }}>
                  {t("invites.currentTitle")}
                </h3>
                {renderInviteState()}
              </section>

              <form class="ds-stack-sm" data-testid="invite-create-form" onSubmit={onCreate} aria-labelledby="invite-new-title">
                <h3 id="invite-new-title" class="ds-section-title" style={{ margin: 0 }}>
                  {t("invites.newTitle")}
                </h3>
                <div class="ds-grid-2">
                  <label class="ds-field" for="invite-ttl">
                    <span class="ds-field-label">{t("invites.ttl")}</span>
                    <select
                      id="invite-ttl"
                      data-testid="invite-ttl"
                      class="ds-input"
                      value={String(ttlSeconds)}
                      onChange={(e) => setTtlSeconds(Number((e.currentTarget as HTMLSelectElement).value))}
                    >
                      {TTL_OPTIONS.map((o) => (
                        <option key={o.seconds} value={String(o.seconds)}>
                          {t(o.label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label class="ds-field" for="invite-max-uses">
                    <span class="ds-field-label">{t("invites.maxUses")}</span>
                    <input
                      id="invite-max-uses"
                      data-testid="invite-max-uses"
                      class="ds-input atlas-tabular-nums"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_INVITE_MAX_USES}
                      step={1}
                      required
                      value={maxUses}
                      aria-invalid={maxUsesInvalid ? "true" : undefined}
                      aria-describedby={maxUsesInvalid ? MAX_USES_ERROR_ID : undefined}
                      onInput={(e) => setMaxUses((e.currentTarget as HTMLInputElement).value)}
                    />
                  </label>
                </div>
                {maxUsesInvalid && (
                  <p id={MAX_USES_ERROR_ID} role="alert" class="ds-field-error" data-testid="invite-max-uses-error">
                    {t("invites.error.maxUses")}
                  </p>
                )}
                {invite?.status === "active" && <p class="ds-hint">{t("invites.replaceHint")}</p>}
                <div>
                  <button
                    type="submit"
                    ref={createRef}
                    class="ds-btn ds-btn-primary"
                    data-testid="invite-create"
                    aria-busy={busy === "create" ? "true" : undefined}
                    aria-disabled={busy === "create" ? "true" : undefined}
                  >
                    {busy === "create" ? t("lobby.inviteCreating") : t(invite?.status === "active" ? "invites.replace" : "invites.create")}
                  </button>
                </div>
              </form>

              <section class="ds-stack-sm" aria-labelledby="invite-redemptions-title">
                <h3 id="invite-redemptions-title" ref={redemptionsTitleRef} tabIndex={-1} class="ds-section-title" style={{ margin: 0 }}>
                  {t("invites.redemptionsTitle")}
                </h3>
                {redemptions.length === 0 ? (
                  <p class="ds-hint" data-testid="redemptions-empty">
                    {t("invites.redemptionsEmpty")}
                  </p>
                ) : (
                  <ul role="list" class="ds-list-plain ds-stack-sm" data-testid="redemptions-list">
                    {redemptions.map(renderRedemption)}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
        <div class="ds-modal-footer" style={{ justifyContent: "flex-end" }}>
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="invite-dialog-close" onClick={onClose}>
            {t("action.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
