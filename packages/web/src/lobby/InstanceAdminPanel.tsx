/**
 * ============================================================================
 * INSTANCE ADMINISTRATION PANEL (lobby/InstanceAdminPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * The `Owner`'s view of every account on the instance (ADR-0039): who has
 * access, with which `InstanceRole`, and whether two-factor authentication is
 * on. The `Owner` promotes trusted `Member`s to `Host` (allowed to create
 * campaigns) and demotes them back, and mints one-time password reset links
 * for locked-out players (spec story 15). Without it the Owner could not
 * curate who creates campaigns, or recover an account, short of editing the
 * database.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Owner Is Immutable`:
 *    - The `Owner` row offers no action; the server also refuses it
 *      (`409 CANNOT_CHANGE_OWNER`), which maps to the same explanation.
 * 2. `Server Answer Is The Row`:
 *    - A role change replaces the row with the `user` returned by the server
 *      rather than flipping it optimistically, so the list never shows a
 *      role the server did not store.
 * 3. `One Change Per Row At A Time`:
 *    - The pending row's button is `aria-disabled` + `aria-busy` and ignores
 *      clicks; focus stays on it.
 * 4. `Announced Outcomes`:
 *    - A persistent `role="status"` region announces each role change; text
 *      badges carry the role so it is never conveyed by color.
 *    - Load and per-row errors fill `role="alert"` regions that are mounted
 *      before their text, so screen readers announce them.
 * 5. `Reset Link Shown Once`:
 *    - The server stores only the token hash, so the minted URL lives in
 *      component state for the row until the panel closes; minting again
 *      replaces (and invalidates) the previous link. Guest rows have no
 *      email to sign in with and offer no reset.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * mount -> `listInstanceUsers()` -> rows
 * promote/demote -> `setInstanceRole(id, HOST|MEMBER)` -> row replaced + announced.
 * reset link -> `mintPasswordReset(id)` -> copyable URL + expiry on the row + announced.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient, InstanceUser, PasswordResetLink } from "../api/client.ts";
import { INSTANCE_ROLE_KEYS } from "../auth/AccountSettingsDialog.tsx";
import { apiErrorKey } from "../auth/accountForm.tsx";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { formatEpochSeconds, t, type MessageKey } from "../i18n/index.ts";

/** Props for `InstanceAdminPanel`. */
export interface InstanceAdminPanelProps {
  client: ApiClient;
  /** Returns to the campaign lobby. */
  onBack: () => void;
}

type LoadState = "loading" | "ready" | "failed";

const ROLE_ERRORS: Record<string, MessageKey> = {
  CANNOT_CHANGE_OWNER: "admin.error.owner",
  OWNER_REQUIRED: "admin.error.notOwner",
  USER_NOT_FOUND: "admin.error.notFound",
};

const RESET_ERRORS: Record<string, MessageKey> = {
  OWNER_REQUIRED: "admin.error.notOwner",
  USER_NOT_FOUND: "admin.error.notFound",
  GUEST_ACCOUNT: "admin.reset.error.guest",
};

/** Owner-only account list with Host promotion and demotion. */
export function InstanceAdminPanel({ client, onBack }: InstanceAdminPanelProps) {
  const [users, setUsers] = useState<InstanceUser[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<{ userId: string; key: MessageKey } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [resetLink, setResetLink] = useState<{ userId: string; link: PasswordResetLink } | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const pending = useRef(false);
  const resetUrlRef = useRef<HTMLInputElement | null>(null);

  useFocusOnMount(titleRef);

  const load = () => {
    setLoadState("loading");
    client.listInstanceUsers().then(
      (list) => {
        setUsers(list);
        setLoadState("ready");
      },
      () => setLoadState("failed"),
    );
  };

  useEffect(load, [client]);

  const changeRole = async (user: InstanceUser, role: "HOST" | "MEMBER") => {
    if (pending.current) return;
    pending.current = true;
    setPendingId(user.id);
    setError(null);
    try {
      const updated = await client.setInstanceRole(user.id, role);
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setAnnouncement(
        t(role === "HOST" ? "admin.promoted" : "admin.demoted", { name: updated.displayName || updated.email }),
      );
    } catch (err) {
      setError({ userId: user.id, key: apiErrorKey(err, ROLE_ERRORS, "admin.error.generic") });
    }
    pending.current = false;
    setPendingId(null);
  };

  const mintReset = async (user: InstanceUser) => {
    if (pending.current) return;
    pending.current = true;
    setPendingId(user.id);
    setError(null);
    try {
      setResetLink({ userId: user.id, link: await client.mintPasswordReset(user.id) });
      setAnnouncement(t("admin.reset.minted", { name: user.displayName || user.email }));
    } catch (err) {
      setError({ userId: user.id, key: apiErrorKey(err, RESET_ERRORS, "admin.reset.error.generic") });
    }
    pending.current = false;
    setPendingId(null);
  };

  const copyReset = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setAnnouncement(t("admin.reset.copied"));
    } catch {
      resetUrlRef.current?.select?.();
      setAnnouncement(t("invites.copyManual"));
    }
  };

  const renderReset = (user: InstanceUser) => {
    if (user.isGuest) return null;
    const busy = pendingId === user.id;
    const minted = resetLink?.userId === user.id ? resetLink.link : null;
    return (
      <div class="ds-stack-sm">
        <div>
          <button
            type="button"
            class="ds-btn ds-btn-secondary"
            data-testid={`admin-reset-${user.id}`}
            aria-label={t("admin.reset.mintAria", { name: user.displayName || user.email })}
            aria-busy={busy ? "true" : undefined}
            aria-disabled={busy ? "true" : undefined}
            onClick={() => mintReset(user)}
          >
            {t(minted ? "admin.reset.mintAgain" : "admin.reset.mint")}
          </button>
        </div>
        {minted && (
          <div class="ds-stack-sm" data-testid={`admin-reset-link-${user.id}`}>
            <div class="ds-cluster" style={{ alignItems: "flex-end" }}>
              <label class="ds-field" for="admin-reset-url" style={{ flex: "1 1 16rem" }}>
                <span class="ds-field-label">{t("admin.reset.linkLabel", { name: user.displayName || user.email })}</span>
                <input id="admin-reset-url" ref={resetUrlRef} data-testid="admin-reset-url" class="ds-input" type="text" readOnly value={minted.resetUrl} />
              </label>
              <button type="button" class="ds-btn ds-btn-secondary" data-testid="admin-reset-copy" onClick={() => copyReset(minted.resetUrl)}>
                {t("invites.copy")}
              </button>
            </div>
            <p class="ds-hint" data-testid="admin-reset-expiry">
              {t("admin.reset.hint", { date: formatEpochSeconds(minted.expiresAt) })}
            </p>
          </div>
        )}
      </div>
    );
  };

  const renderAction = (user: InstanceUser) => {
    if (user.instanceRole === "OWNER") {
      return <span class="ds-meta">{t("admin.ownerFixed")}</span>;
    }
    const target = user.instanceRole === "HOST" ? "MEMBER" : "HOST";
    const busy = pendingId === user.id;
    const name = user.displayName || user.email;
    return (
      <button
        type="button"
        class="ds-btn ds-btn-secondary"
        data-testid={`admin-role-${user.id}`}
        aria-label={t(target === "HOST" ? "admin.promoteAria" : "admin.demoteAria", { name })}
        aria-busy={busy ? "true" : undefined}
        aria-disabled={busy ? "true" : undefined}
        onClick={() => changeRole(user, target)}
      >
        {t(target === "HOST" ? "admin.promote" : "admin.demote")}
      </button>
    );
  };

  return (
    <main
      data-testid="instance-admin"
      class="ds-stack"
      style={{ gap: "var(--atlas-space-lg)", padding: "var(--atlas-space-lg)", maxWidth: "48rem", width: "100%", margin: "0 auto" }}
    >
      <p role="status" class="ds-visually-hidden" data-testid="admin-status">
        {loadState === "loading" ? t("admin.loading") : announcement}
      </p>
      <section aria-labelledby="admin-title" class="ds-stack">
        <div class="ds-row" style={{ flexWrap: "wrap" }}>
          <h1 id="admin-title" ref={titleRef} tabIndex={-1} class="ds-panel-title">
            {t("admin.title")}
          </h1>
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="admin-back" onClick={onBack}>
            {t("shell.backToLobby")}
          </button>
        </div>
        <p class="ds-hint">{t("admin.intro")}</p>
        {loadState === "loading" && <p aria-hidden="true">{t("admin.loading")}</p>}
        <div role="alert">
          {loadState === "failed" && (
            <div data-testid="admin-load-error" class="ds-cluster">
              <span class="ds-field-error">{t("admin.loadFailed")}</span>
              <button type="button" class="ds-btn ds-btn-secondary" onClick={load}>
                {t("lobby.retry")}
              </button>
            </div>
          )}
        </div>
        {users.length > 0 && (
          <ul role="list" class="ds-list-plain ds-stack-sm">
            {users.map((user) => (
              <li key={user.id} class="ds-panel ds-stack-sm" data-testid={`admin-user-${user.id}`}>
                <div class="ds-row" style={{ flexWrap: "wrap" }}>
                  <div class="ds-stack-sm" style={{ gap: "var(--atlas-space-xs)" }}>
                    <strong>{user.displayName}</strong>
                    <span class="ds-meta">{user.email}</span>
                    <span class="ds-cluster" style={{ gap: "var(--atlas-space-xs)" }}>
                      <span class="ds-badge" data-testid={`admin-role-badge-${user.id}`}>
                        {t(INSTANCE_ROLE_KEYS[user.instanceRole])}
                      </span>
                      {user.isGuest && <span class="ds-badge">{t("admin.guest")}</span>}
                      <span class="ds-badge">{t(user.totpEnabled ? "admin.totpOn" : "admin.totpOff")}</span>
                    </span>
                  </div>
                  {renderAction(user)}
                </div>
                {renderReset(user)}
                <div role="alert" data-testid={`admin-error-region-${user.id}`}>
                  {error?.userId === user.id && (
                    <p class="ds-field-error" data-testid={`admin-error-${user.id}`}>
                      {t(error.key)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
