/**
 * ============================================================================
 * ACCOUNT SETTINGS DIALOG & TOTP ENROLLMENT (auth/AccountSettingsDialog.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Account menu opened from the lobby header: shows who is signed in, their
 * `InstanceRole` and what it allows, and lets the user turn on two-factor
 * authentication (TOTP). TOTP stays optional (spec D16), but the `Owner`
 * account controls every other account, so its recommendation is worded more
 * strongly. Without the enrollment flow the recommendation would be a dead
 * end: no other screen enables TOTP.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Modal Keyboard Contract`:
 *    - `role="dialog"` + `aria-modal`, labelled by its title, with
 *      `useModalFocusTrap` (Tab cycles inside, Escape closes, focus returns
 *      to the header button).
 * 2. `Non-Color Emphasis`:
 *    - The recommendation carries a `!` glyph and distinct wording for the
 *      `Owner`; color is never the only signal.
 * 3. `Server-Owned Flags`:
 *    - `instanceRole` and `totpEnabled` come from `/auth/me`; TOTP counts as
 *      on only after `POST /auth/totp/enable` accepted a code.
 * 4. `Pending Secret Until Confirmed`:
 *    - `POST /auth/totp/setup` returns a pending secret (Base32 key and
 *      `otpauth://` link); sign-in is unaffected until a code from the
 *      authenticator confirms it, so abandoning the dialog never locks the
 *      user out.
 * 5. `Persistent Live Regions`:
 *    - The TOTP status and error regions are always mounted and only their
 *      text changes, so screen readers announce progress and failures.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * "Set up" -> `setupTotp()` -> key + link + code field
 * "Turn on" -> `enableTotp(code)` -> user `totpEnabled` -> confirmation text.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type TotpEnrollment } from "../api/client.ts";
import type { AuthUser, InstanceRole } from "../api/session.ts";
import { useModalFocusTrap } from "../components/a11y/useModalFocusTrap.ts";
import { t, type MessageKey } from "../i18n/index.ts";
import { AccountField, apiErrorKey } from "./accountForm.tsx";

/** Props for `AccountSettingsDialog`. */
export interface AccountSettingsDialogProps {
  client: ApiClient;
  user: AuthUser;
  onClose: () => void;
}

/** Badge label of each `InstanceRole`. */
export const INSTANCE_ROLE_KEYS: Record<InstanceRole, MessageKey> = {
  OWNER: "instanceRole.OWNER",
  HOST: "instanceRole.HOST",
  MEMBER: "instanceRole.MEMBER",
};

const ROLE_DESCRIPTION_KEYS: Record<InstanceRole, MessageKey> = {
  OWNER: "account.roleHelp.OWNER",
  HOST: "account.roleHelp.HOST",
  MEMBER: "account.roleHelp.MEMBER",
};

const TOTP_ERROR_ID = "account-totp-error";

/** Enrollment progress: not started, requesting the secret, or waiting for the confirming code. */
type Enrollment = { step: "idle" } | { step: "preparing" } | { step: "confirm"; enrollment: TotpEnrollment };

function totpErrorKey(err: unknown): MessageKey {
  if (err instanceof ApiError && err.status === 401) return "auth.error.invalidTotp";
  return apiErrorKey(err, {});
}

/** Account summary with the TOTP recommendation (stronger for the Owner) and enrollment. */
export function AccountSettingsDialog({ client, user, onClose }: AccountSettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const codeFormRef = useRef<HTMLFormElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment>({ step: "idle" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);
  useModalFocusTrap(dialogRef, { onEscape: onClose });

  // The control that held focus unmounts on each step change; move focus to the next one instead of `<body>`.
  useEffect(() => {
    if (enrollment.step === "confirm") codeFormRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [enrollment.step]);
  useEffect(() => {
    if (justEnabled) closeRef.current?.focus();
  }, [justEnabled]);
  const isOwner = user.instanceRole === "OWNER";
  const busyProps = busy ? { "aria-disabled": "true" as const, "aria-busy": "true" as const } : {};

  const startSetup = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setEnrollment({ step: "preparing" });
    try {
      setEnrollment({ step: "confirm", enrollment: await client.setupTotp() });
    } catch (err) {
      setEnrollment({ step: "idle" });
      setError(totpErrorKey(err));
    }
    setBusy(false);
  };

  const confirm = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.enableTotp(code.trim());
      setJustEnabled(true);
      setEnrollment({ step: "idle" });
    } catch (err) {
      setError(totpErrorKey(err));
    }
    setBusy(false);
  };

  const renderEnrollment = () => {
    if (enrollment.step !== "confirm") {
      return (
        <div>
          <button type="button" class="ds-btn ds-btn-primary" data-testid="account-totp-setup" onClick={startSetup} {...busyProps}>
            {t("account.totp.setup")}
          </button>
        </div>
      );
    }
    const { secret, otpauthUrl } = enrollment.enrollment;
    return (
      <form ref={codeFormRef} class="ds-stack-sm" data-testid="account-totp-form" onSubmit={confirm}>
        <p class="ds-hint">{t("account.totp.instructions")}</p>
        <a class="ds-btn ds-btn-secondary" href={otpauthUrl} data-testid="account-totp-link">
          {t("account.totp.openApp")}
        </a>
        <span class="ds-field-label">{t("account.totp.secret")}</span>
        <code class="atlas-tabular-nums" data-testid="account-totp-secret" style={{ overflowWrap: "anywhere" }}>
          {secret}
        </code>
        <AccountField
          id="account-totp-code"
          label={t("account.totp.code")}
          type="text"
          inputMode="numeric"
          autocomplete="one-time-code"
          value={code}
          onInput={setCode}
          errorId={error ? TOTP_ERROR_ID : null}
        />
        <div>
          <button type="submit" class="ds-btn ds-btn-primary" data-testid="account-totp-confirm" {...busyProps}>
            {busy ? t("auth.submitting") : t("account.totp.confirm")}
          </button>
        </div>
      </form>
    );
  };

  return (
    <div
      ref={dialogRef}
      data-testid="account-settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-title"
      tabIndex={-1}
      class="ds-modal-backdrop"
    >
      <div class="ds-modal ds-modal-narrow">
        <header class="ds-modal-header">
          <h2 id="account-title" class="ds-modal-title">
            {t("account.title")}
          </h2>
        </header>
        <div class="ds-modal-body ds-stack">
          <div class="ds-stack-sm">
            <strong data-testid="account-display-name">{user.displayName}</strong>
            <span class="ds-meta">{user.email}</span>
            <span>
              <span class="ds-badge" data-testid="account-instance-role">
                {t(INSTANCE_ROLE_KEYS[user.instanceRole])}
              </span>
            </span>
            <p class="ds-hint">{t(ROLE_DESCRIPTION_KEYS[user.instanceRole])}</p>
          </div>

          <section class="ds-inset ds-stack-sm" aria-labelledby="account-totp-title" data-testid="account-totp">
            <h3 id="account-totp-title" class="ds-section-title" style={{ margin: 0 }}>
              {t("account.totp.title")}
            </h3>
            <p role="status" data-testid="account-totp-status">
              {justEnabled ? t("account.totp.enabledNow") : enrollment.step === "preparing" ? t("account.totp.preparing") : ""}
            </p>
            {user.totpEnabled ? (
              !justEnabled && <p data-testid="account-totp-enabled">{t("account.totp.enabled")}</p>
            ) : (
              <>
                <p data-testid={isOwner ? "account-totp-nudge-owner" : "account-totp-nudge"}>
                  <span aria-hidden="true">! </span>
                  {t(isOwner ? "account.totp.nudgeOwner" : "account.totp.nudge")}
                </p>
                {renderEnrollment()}
              </>
            )}
            <div role="alert" data-testid="account-totp-alert-region">
              {error && (
                <p id={TOTP_ERROR_ID} class="ds-field-error" data-testid="account-totp-error">
                  {t(error)}
                </p>
              )}
            </div>
          </section>
        </div>
        <div class="ds-modal-footer" style={{ justifyContent: "flex-end" }}>
          <button type="button" ref={closeRef} class="ds-btn ds-btn-secondary" data-testid="account-close" onClick={onClose}>
            {t("action.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
