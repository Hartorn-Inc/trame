/**
 * ============================================================================
 * PASSWORD RESET SCREEN (auth/PasswordResetScreen.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lets the holder of a one-time reset link (`/reset-password?token=<hex>`,
 * minted by the `Owner` from the admin panel or by the server CLI
 * `trame-server owner-reset-link`) choose a new password. Without this
 * screen a locked-out player could only be recovered with raw HTTP calls.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Token Checked Before The Password`:
 *    - `POST /auth/password-reset/status` runs on mount; the form only renders
 *      for a `valid` link. `expired` and `invalid` explain how to get a new
 *      link instead of collecting a password that would be refused.
 * 2. `Account Shown Read-Only`:
 *    - The status names the account email, shown as text so the user knows
 *      whose password they are changing; nothing about identity is editable.
 * 3. `Token-Level Failures End The Form`:
 *    - `INVALID_RESET_TOKEN` and `RESET_TOKEN_EXPIRED` on submit switch to the
 *      matching explanation; `WEAK_PASSWORD` flags the password field.
 * 4. `No Session Survives`:
 *    - The server revokes every session of the account and issues none. On
 *      success the screen re-reads `/auth/me` so a session revoked in this
 *      browser drops to `anonymous`, then offers the sign-in form.
 * 5. `Live Region Exists Before Its Message`:
 *    - Alert regions are always mounted and filled later (screen readers
 *      ignore live regions inserted together with their text).
 * 6. `Token Never In The Address Bar`:
 *    - The bootstrap strips `?token=` before this screen mounts.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * mount -> `getPasswordResetStatus(token)` -> `valid` form | explanation
 * submit -> `resetPassword` -> `restoreSession` -> `done` -> `onDone()` -> sign-in.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../api/client.ts";
import { LocaleToggle, ThemeToggle } from "../components/ShellToggles.tsx";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { t, type MessageKey } from "../i18n/index.ts";
import { AccountField, apiErrorKey } from "./accountForm.tsx";

/** Props for `PasswordResetScreen`. */
export interface PasswordResetScreenProps {
  client: ApiClient;
  /** Raw reset token from `/reset-password?token=`; empty when the URL had none. */
  token: string;
  /** Leaves the reset page for the normal app (sign-in form). */
  onDone: () => void;
}

type Phase = "checking" | "valid" | "done" | "expired" | "invalid" | "checkFailed";

const ERROR_ID = "reset-error";

const FIELD_ERRORS: Record<string, MessageKey> = {
  WEAK_PASSWORD: "auth.error.weakPassword",
};

const TERMINAL_PHASES: Record<string, Phase> = {
  INVALID_RESET_TOKEN: "invalid",
  RESET_TOKEN_EXPIRED: "expired",
};

const PHASE_MESSAGES: Record<"expired" | "invalid" | "checkFailed", MessageKey> = {
  expired: "reset.expired",
  invalid: "reset.invalid",
  checkFailed: "reset.checkFailed",
};

/** Sets a new password from a one-time reset link. */
export function PasswordResetScreen({ client, token, onDone }: PasswordResetScreenProps) {
  const [phase, setPhase] = useState<Phase>(token ? "checking" : "invalid");
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);

  useFocusOnMount(titleRef);

  useEffect(() => {
    if (!token) return;
    client.getPasswordResetStatus(token).then(
      (check) => {
        setEmail(check.email);
        setPhase(check.status);
      },
      () => setPhase("checkFailed"),
    );
  }, [client, token]);

  useEffect(() => {
    if (phase === "done") doneRef.current?.focus();
  }, [phase]);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.resetPassword(token, password);
      await client.restoreSession().catch(() => undefined);
      setPhase("done");
    } catch (err) {
      const terminal = err instanceof ApiError && err.code ? TERMINAL_PHASES[err.code] : undefined;
      if (terminal) setPhase(terminal);
      else setError(apiErrorKey(err, FIELD_ERRORS));
    }
    setSubmitting(false);
  };

  return (
    <main
      class="ds-app-shell"
      data-testid="password-reset-screen"
      style={{ alignItems: "center", justifyContent: "center", padding: "var(--atlas-space-lg)" }}
    >
      <section class="ds-panel ds-stack" aria-labelledby="reset-title" style={{ width: "100%", maxWidth: "28rem" }}>
        <div class="ds-row">
          <h1 id="reset-title" ref={titleRef} tabIndex={-1} class="ds-brand-title" style={{ margin: 0 }}>
            {t("reset.title")}
          </h1>
          <div class="ds-cluster">
            <ThemeToggle />
            <LocaleToggle />
          </div>
        </div>

        {phase === "checking" && <p data-testid="reset-checking">{t("reset.checking")}</p>}

        <div role="alert" data-testid="reset-alert-region">
          {(phase === "expired" || phase === "invalid" || phase === "checkFailed") && (
            <div data-testid={`reset-${phase}`} class="ds-stack-sm">
              <p class="ds-field-error">{t(PHASE_MESSAGES[phase])}</p>
              <p class="ds-hint">{t("reset.howToGetLink")}</p>
            </div>
          )}
        </div>

        <div role="status" data-testid="reset-status-region">
          {phase === "done" && <p data-testid="reset-done">{t("reset.done")}</p>}
        </div>

        {phase === "done" && (
          <button ref={doneRef} type="button" class="ds-btn ds-btn-primary" data-testid="reset-sign-in" onClick={onDone}>
            {t("reset.signIn")}
          </button>
        )}

        {phase === "valid" && (
          <form data-testid="reset-form" onSubmit={onSubmit} class="ds-stack">
            <p data-testid="reset-account">{email ? t("reset.intro", { email }) : t("reset.introNoEmail")}</p>
            <AccountField
              id="reset-password"
              label={t("reset.newPassword")}
              type="password"
              autocomplete="new-password"
              value={password}
              onInput={setPassword}
              hint={t("setup.passwordHint")}
              errorId={error ? ERROR_ID : null}
            />
            <div role="alert" data-testid="reset-error-region">
              {error && (
                <p id={ERROR_ID} data-testid="reset-error" class="ds-field-error">
                  {t(error)}
                </p>
              )}
            </div>
            <button
              type="submit"
              class="ds-btn ds-btn-primary"
              data-testid="reset-submit"
              aria-disabled={submitting ? "true" : undefined}
              aria-busy={submitting ? "true" : undefined}
            >
              {submitting ? t("auth.submitting") : t("reset.submit")}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
