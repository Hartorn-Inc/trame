/**
 * ============================================================================
 * LEGACY GUEST BIND PROMPT (auth/GuestBindPrompt.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Guest sessions are no longer issued (ADR-0039), but a user may still hold
 * one from before. Such an account has no credentials: losing the cookie
 * loses its characters. This lobby panel asks for an email and password and
 * binds them to the guest account (`POST /api/v1/auth/bind`), turning it into
 * a real, recoverable account with the same characters and memberships.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Rendered Only For Guests`:
 *    - The lobby mounts this panel only while `session.user.isGuest` is true;
 *      after a successful bind the refreshed `/auth/me` user is no longer a
 *      guest and the panel disappears.
 * 2. `Errors Point At Their Field`:
 *    - `EMAIL_ALREADY_EXISTS` flags the email, `WEAK_PASSWORD` the password,
 *      through `aria-invalid` + `aria-describedby`. The `role="alert"`
 *      region is always mounted so screen readers announce new text.
 * 3. `Focusable While Busy`:
 *    - Submit uses `aria-disabled` + `aria-busy` and ignores repeats.
 * ============================================================================
 */
import { useState } from "preact/hooks";
import type { ApiClient } from "../api/client.ts";
import { t, type MessageKey } from "../i18n/index.ts";
import { AccountField, apiErrorKey } from "./accountForm.tsx";

/** Props for `GuestBindPrompt`. */
export interface GuestBindPromptProps {
  client: ApiClient;
  /** Called after the guest account is bound (the lobby announces it and moves focus). */
  onBound: () => void;
}

type Field = "email" | "password";

const ERROR_ID = "bind-error";

const ERRORS: Record<string, MessageKey> = {
  EMAIL_ALREADY_EXISTS: "auth.error.emailTaken",
  INVALID_EMAIL: "auth.error.invalidEmail",
  WEAK_PASSWORD: "auth.error.weakPassword",
};

const ERROR_FIELDS: Partial<Record<MessageKey, readonly Field[]>> = {
  "auth.error.emailTaken": ["email"],
  "auth.error.invalidEmail": ["email"],
  "auth.error.weakPassword": ["password"],
};

/** Lobby panel binding email + password to a legacy guest account. */
export function GuestBindPrompt({ client, onBound }: GuestBindPromptProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const invalid = error ? (ERROR_FIELDS[error] ?? []) : [];
  const errorIdFor = (field: Field) => (invalid.includes(field) ? ERROR_ID : null);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.bindGuestAccount({ email, password });
      onBound();
    } catch (err) {
      setError(apiErrorKey(err, ERRORS));
      setSubmitting(false);
    }
  };

  return (
    <section class="ds-panel ds-stack" aria-labelledby="bind-title" data-testid="guest-bind-prompt">
      <h2 id="bind-title" class="ds-panel-title">
        <span aria-hidden="true">! </span>
        {t("bind.title")}
      </h2>
      <p>{t("bind.body")}</p>
      <form data-testid="bind-form" onSubmit={onSubmit} class="ds-stack">
        <AccountField
          id="bind-email"
          label={t("auth.email")}
          type="email"
          autocomplete="email"
          value={email}
          onInput={setEmail}
          errorId={errorIdFor("email")}
        />
        <AccountField
          id="bind-password"
          label={t("auth.password")}
          type="password"
          autocomplete="new-password"
          value={password}
          onInput={setPassword}
          hint={t("setup.passwordHint")}
          errorId={errorIdFor("password")}
        />
        <div role="alert" data-testid="bind-error-region">
          {error && (
            <p id={ERROR_ID} data-testid="bind-error" class="ds-field-error">
              {t(error)}
            </p>
          )}
        </div>
        <button
          type="submit"
          class="ds-btn ds-btn-primary"
          data-testid="bind-submit"
          aria-disabled={submitting ? "true" : undefined}
          aria-busy={submitting ? "true" : undefined}
        >
          {submitting ? t("auth.submitting") : t("bind.submit")}
        </button>
      </form>
    </section>
  );
}
