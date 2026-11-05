/**
 * ============================================================================
 * INVITE REDEMPTION SCREEN (auth/InviteRedemptionScreen.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Opened from a `CampaignInvite` link (`/?invite=<token>`). Shows where the
 * link leads, then performs `InviteRedemption` (ADR-0039): a visitor creates
 * a real `Member` account (display name, email, password) and joins as a
 * `Player` in one step; a signed-in user joins with one click. This replaces
 * the removed guest-session onboarding (`GuestSessionUpgrade`), so an invited
 * player never ends up with an unrecoverable account.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Preview Before Credentials`:
 *    - `POST /invites/preview` runs first. A revoked, expired, exhausted or
 *      unknown link explains itself and never shows the account form.
 * 2. `One Account Per Person`:
 *    - A signed-in user only sees "Join"; the redeem call then carries no
 *      credentials and the server adds the membership to that account. A
 *      visitor who already has an account can switch to "Sign in" first.
 * 3. `Every Server Code Has A Message`:
 *    - `404 INVITE_NOT_FOUND` and `410 INVITE_REVOKED/EXPIRED/EXHAUSTED` end
 *      the form with an explanation; `409 EMAIL_ALREADY_EXISTS`,
 *      `INVALID_EMAIL`, `INVALID_DISPLAY_NAME` and `WEAK_PASSWORD` flag their
 *      field; anything else shows a generic retryable message.
 * 4. `Live Regions Exist Before Their Message`:
 *    - The link-state alert region is always mounted and filled after the
 *      async preview, so screen readers announce it.
 * 5. `Focusable While Busy`:
 *    - Submit buttons use `aria-disabled` + `aria-busy` and ignore repeated
 *      activation, so focus is kept and a double click cannot redeem twice.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * mount -> `previewInvite(token)` -> `active` ? form : explanation
 * ├── signed out, "Create account" -> `redeemInvite(token, account)` (201).
 * ├── signed out, "Sign in" -> `login` -> signed-in branch.
 * └── signed in -> `redeemInvite(token)` (200) -> campaign active -> `onDone()`.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type InvitePreview, type InviteStatus } from "../api/client.ts";
import { LocaleToggle } from "../components/ShellToggles.tsx";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { formatEpochSeconds, t, type MessageKey } from "../i18n/index.ts";
import { AccountField, apiErrorKey } from "./accountForm.tsx";

/** Props for `InviteRedemptionScreen`. */
export interface InviteRedemptionScreenProps {
  client: ApiClient;
  /** Raw invite token read from `?invite=` (already stripped from the address bar). */
  token: string;
  /** Leaves the screen: after joining (campaign active) or when the user declines. */
  onDone: () => void;
}

type Mode = "create" | "signin";
type Field = "email" | "displayName" | "password";
type LinkState = { kind: "loading" } | { kind: "ready"; preview: InvitePreview } | { kind: "unavailable"; reason: MessageKey };

const ERROR_ID = "invite-error";

const UNAVAILABLE: Record<string, MessageKey> = {
  INVITE_NOT_FOUND: "invite.unavailable.notFound",
  INVITE_REVOKED: "invite.unavailable.revoked",
  INVITE_EXPIRED: "invite.unavailable.expired",
  INVITE_EXHAUSTED: "invite.unavailable.exhausted",
};

const STATUS_UNAVAILABLE: Record<Exclude<InviteStatus, "active">, MessageKey> = {
  revoked: "invite.unavailable.revoked",
  expired: "invite.unavailable.expired",
  exhausted: "invite.unavailable.exhausted",
};

const FIELD_ERRORS: Record<string, MessageKey> = {
  EMAIL_ALREADY_EXISTS: "invite.error.emailTaken",
  INVALID_EMAIL: "auth.error.invalidEmail",
  INVALID_DISPLAY_NAME: "auth.error.invalidDisplayName",
  WEAK_PASSWORD: "auth.error.weakPassword",
  INVALID_CREDENTIALS: "auth.error.invalidCredentials",
};

const ERROR_FIELDS: Partial<Record<MessageKey, readonly Field[]>> = {
  "invite.error.emailTaken": ["email"],
  "auth.error.invalidEmail": ["email"],
  "auth.error.invalidDisplayName": ["displayName"],
  "auth.error.weakPassword": ["password"],
  "auth.error.invalidCredentials": ["email", "password"],
};

/** Previews a campaign invite and redeems it into a real account or membership. */
export function InviteRedemptionScreen({ client, token, onDone }: InviteRedemptionScreenProps) {
  const user = client.state.user.value;
  const [link, setLink] = useState<LinkState>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("create");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useFocusOnMount(titleRef);

  const loadPreview = () => {
    setLink({ kind: "loading" });
    client.previewInvite(token).then(
      (preview) =>
        setLink(
          preview.status === "active"
            ? { kind: "ready", preview }
            : { kind: "unavailable", reason: STATUS_UNAVAILABLE[preview.status] },
        ),
      (err) => setLink({ kind: "unavailable", reason: apiErrorKey(err, UNAVAILABLE, "invite.unavailable.checkFailed") }),
    );
  };

  useEffect(loadPreview, [client, token]);

  const invalid = error ? (ERROR_FIELDS[error] ?? []) : [];
  const errorIdFor = (field: Field) => (invalid.includes(field) ? ERROR_ID : null);

  const run = async (action: () => Promise<unknown>, leaveOnSuccess: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await action();
      setSubmitting(false);
      if (leaveOnSuccess) onDone();
    } catch (err) {
      const gone = err instanceof ApiError && err.code ? UNAVAILABLE[err.code] : undefined;
      if (gone) setLink({ kind: "unavailable", reason: gone });
      else setError(apiErrorKey(err, FIELD_ERRORS));
      setSubmitting(false);
    }
  };

  const onCreate = (e: Event) => {
    e.preventDefault();
    void run(() => client.redeemInvite(token, { email, password, displayName }), true);
  };

  const onSignIn = (e: Event) => {
    e.preventDefault();
    void run(() => client.login({ email, password }), false);
  };

  const onJoin = () => {
    void run(() => client.redeemInvite(token), true);
  };

  const busyProps = submitting ? { "aria-disabled": "true" as const, "aria-busy": "true" as const } : {};

  const modeButton = (value: Mode, label: MessageKey) => (
    <button
      type="button"
      class="ds-btn ds-btn-secondary"
      data-testid={`invite-mode-${value}`}
      aria-pressed={mode === value ? "true" : "false"}
      disabled={submitting}
      onClick={() => {
        setMode(value);
        setError(null);
      }}
    >
      {mode === value && <span aria-hidden="true">✓</span>}
      {t(label)}
    </button>
  );

  const errorAlert = error && (
    <p id={ERROR_ID} data-testid="invite-error" role="alert" class="ds-field-error">
      {t(error)}
    </p>
  );

  const renderReady = (preview: InvitePreview) => (
    <div class="ds-stack" data-testid="invite-ready">
      <div class="ds-stack-sm">
        <p data-testid="invite-campaign">
          {preview.campaignName
            ? t("invite.campaign", { name: preview.campaignName })
            : t("invite.campaignUnnamed")}
        </p>
        <p class="ds-hint">{t("invite.expires", { date: formatEpochSeconds(preview.expiresAt) })}</p>
      </div>

      {user ? (
        <div class="ds-stack">
          <p>{t("invite.signedInAs", { name: user.displayName })}</p>
          {errorAlert}
          <div class="ds-cluster">
            <button type="button" class="ds-btn ds-btn-primary" data-testid="invite-join" onClick={onJoin} {...busyProps}>
              {submitting ? t("auth.submitting") : t("invite.join")}
            </button>
            <button type="button" class="ds-btn ds-btn-secondary" data-testid="invite-dismiss" onClick={onDone}>
              {t("invite.notNow")}
            </button>
          </div>
        </div>
      ) : (
        <div class="ds-stack">
          <div role="group" aria-label={t("auth.modeLabel")} class="ds-cluster">
            {modeButton("create", "invite.mode.create")}
            {modeButton("signin", "auth.mode.login")}
          </div>
          <form data-testid="invite-form" onSubmit={mode === "create" ? onCreate : onSignIn} class="ds-stack">
            {mode === "create" && (
              <AccountField
                id="invite-display-name"
                label={t("auth.displayName")}
                type="text"
                autocomplete="nickname"
                value={displayName}
                onInput={setDisplayName}
                errorId={errorIdFor("displayName")}
              />
            )}
            <AccountField
              id="invite-email"
              label={t("auth.email")}
              type="email"
              autocomplete="email"
              value={email}
              onInput={setEmail}
              errorId={errorIdFor("email")}
            />
            <AccountField
              id="invite-password"
              label={t("auth.password")}
              type="password"
              autocomplete={mode === "create" ? "new-password" : "current-password"}
              value={password}
              onInput={setPassword}
              hint={mode === "create" ? t("setup.passwordHint") : undefined}
              errorId={errorIdFor("password")}
            />
            {errorAlert}
            <button type="submit" class="ds-btn ds-btn-primary" data-testid="invite-submit" {...busyProps}>
              {submitting ? t("auth.submitting") : t(mode === "create" ? "invite.submit.create" : "auth.submit.login")}
            </button>
          </form>
        </div>
      )}
    </div>
  );

  return (
    <main
      class="ds-app-shell"
      data-testid="invite-redemption-screen"
      style={{ alignItems: "center", justifyContent: "center", padding: "var(--atlas-space-lg)" }}
    >
      <section class="ds-panel ds-stack" aria-labelledby="invite-title" style={{ width: "100%", maxWidth: "28rem" }}>
        <div class="ds-row">
          <h1 id="invite-title" ref={titleRef} tabIndex={-1} class="ds-brand-title" style={{ margin: 0 }}>
            {t("invite.title")}
          </h1>
          <LocaleToggle />
        </div>

        {link.kind === "loading" && <p data-testid="invite-loading">{t("invite.loading")}</p>}

        <div role="alert" data-testid="invite-alert-region">
          {link.kind === "unavailable" && (
            <p data-testid="invite-unavailable" class="ds-field-error">
              {t(link.reason)}
            </p>
          )}
        </div>

        {link.kind === "unavailable" && (
          <div class="ds-cluster">
            {link.reason === "invite.unavailable.checkFailed" && (
              <button type="button" class="ds-btn ds-btn-secondary" data-testid="invite-retry" onClick={loadPreview}>
                {t("lobby.retry")}
              </button>
            )}
            <button type="button" class="ds-btn ds-btn-primary" data-testid="invite-leave" onClick={onDone}>
              {t(user ? "invite.toCampaigns" : "invite.toSignIn")}
            </button>
          </div>
        )}

        {link.kind === "ready" && renderReady(link.preview)}
      </section>
    </main>
  );
}
