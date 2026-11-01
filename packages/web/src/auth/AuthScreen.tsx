/**
 * ============================================================================
 * SIGN-IN / REGISTRATION SCREEN (auth/AuthScreen.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Rendered by the auth guard when no session exists. Lets a user sign in or
 * create an account through `ApiClient`, which sets `session.user` and moves
 * the shell to the campaign lobby.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server-Side Validation Is Authoritative`:
 *    - Server error codes (`EMAIL_ALREADY_EXISTS`, `INVALID_EMAIL`, ...) map to
 *      localized messages; the form does no duplicate validation beyond the
 *      native `required` / `type="email"` hints.
 * 2. `Errors Point At Their Field`:
 *    - The field an error refers to gets `aria-invalid` and `aria-describedby`
 *      pointing at the `role="alert"` message, so the error is read again when
 *      the user returns to that field.
 * 3. `Live Region Exists Before Its Message`:
 *    - The invite-failure region is mounted empty and filled after mount;
 *      screen readers ignore live regions inserted together with their text.
 * 4. `Focusable While Busy`:
 *    - Submit uses `aria-disabled` + `aria-busy` instead of `disabled`, so
 *      focus is not dropped to `<body>` while the request is in flight.
 * 5. `ATLAS v1.1 Only`:
 *    - Layout uses `ds-*` primitives and `--atlas-*` tokens, no raw colors.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../api/client.ts";
import { LocaleToggle } from "../components/ShellToggles.tsx";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { t, type MessageKey } from "../i18n/index.ts";

/** Props for `AuthScreen`. */
export interface AuthScreenProps {
  client: ApiClient;
}

type AuthMode = "login" | "register";
type AuthField = "email" | "displayName" | "password";

const ERROR_ID = "auth-error";

const ERROR_KEYS: Record<string, MessageKey> = {
  EMAIL_ALREADY_EXISTS: "auth.error.emailTaken",
  INVALID_EMAIL: "auth.error.invalidEmail",
  INVALID_DISPLAY_NAME: "auth.error.invalidDisplayName",
};

/** Fields each error message describes; `auth.error.generic` points at none. */
const ERROR_FIELDS: Partial<Record<MessageKey, readonly AuthField[]>> = {
  "auth.error.emailTaken": ["email"],
  "auth.error.invalidEmail": ["email"],
  "auth.error.invalidDisplayName": ["displayName"],
  "auth.error.invalidCredentials": ["email", "password"],
};

function errorKey(err: unknown): MessageKey {
  if (err instanceof ApiError) {
    if (err.code && ERROR_KEYS[err.code]) return ERROR_KEYS[err.code];
    if (err.status === 401) return "auth.error.invalidCredentials";
  }
  return "auth.error.generic";
}

/** Sign-in and registration form shown to anonymous users. */
export function AuthScreen({ client }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [showInviteError, setShowInviteError] = useState(false);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const inviteFailed = client.state.inviteError.value !== null;

  useFocusOnMount(titleRef);
  useEffect(() => setShowInviteError(inviteFailed), [inviteFailed]);

  const invalidFields = error ? (ERROR_FIELDS[error] ?? []) : [];
  const fieldErrorProps = (field: AuthField) =>
    invalidFields.includes(field) ? { "aria-invalid": "true" as const, "aria-describedby": ERROR_ID } : {};

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "login") {
        await client.login({ email, password });
      } else {
        await client.register({ email, displayName, password });
      }
    } catch (err) {
      setError(errorKey(err));
      setSubmitting(false);
    }
  };

  const modeButton = (value: AuthMode, label: MessageKey) => (
    <button
      type="button"
      class="ds-btn ds-btn-secondary"
      data-testid={`auth-mode-${value}`}
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

  return (
    <main class="ds-app-shell" data-testid="auth-screen" style={{ alignItems: "center", justifyContent: "center", padding: "var(--atlas-space-lg)" }}>
      <section class="ds-panel ds-stack" aria-labelledby="auth-title" style={{ width: "100%", maxWidth: "26rem" }}>
        <div class="ds-row">
          <h1 id="auth-title" ref={titleRef} tabIndex={-1} class="ds-brand-title" style={{ margin: 0 }}>
            {t("auth.title")}
          </h1>
          <LocaleToggle />
        </div>

        <div role="alert" data-testid="auth-invite-region">
          {showInviteError && (
            <p data-testid="auth-invite-error" class="ds-field-error">
              {t("auth.inviteFailed")}
            </p>
          )}
        </div>

        <div role="group" aria-label={t("auth.modeLabel")} class="ds-cluster">
          {modeButton("login", "auth.mode.login")}
          {modeButton("register", "auth.mode.register")}
        </div>

        <form data-testid="auth-form" onSubmit={onSubmit} class="ds-stack">
          <label class="ds-field" for="auth-email">
            <span class="ds-field-label">{t("auth.email")}</span>
            <input
              id="auth-email"
              data-testid="auth-email"
              class="ds-input"
              type="email"
              autocomplete="email"
              required
              value={email}
              onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
              {...fieldErrorProps("email")}
            />
          </label>

          {mode === "register" && (
            <label class="ds-field" for="auth-display-name">
              <span class="ds-field-label">{t("auth.displayName")}</span>
              <input
                id="auth-display-name"
                data-testid="auth-display-name"
                class="ds-input"
                type="text"
                autocomplete="nickname"
                required
                value={displayName}
                onInput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)}
                {...fieldErrorProps("displayName")}
              />
            </label>
          )}

          <label class="ds-field" for="auth-password">
            <span class="ds-field-label">{t("auth.password")}</span>
            <input
              id="auth-password"
              data-testid="auth-password"
              class="ds-input"
              type="password"
              autocomplete={mode === "login" ? "current-password" : "new-password"}
              required
              value={password}
              onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
              {...fieldErrorProps("password")}
            />
          </label>

          {error && (
            <p id={ERROR_ID} data-testid="auth-error" role="alert" class="ds-field-error">
              {t(error)}
            </p>
          )}

          <button
            type="submit"
            class="ds-btn ds-btn-primary"
            data-testid="auth-submit"
            aria-disabled={submitting ? "true" : undefined}
            aria-busy={submitting ? "true" : undefined}
          >
            {submitting ? t("auth.submitting") : t(mode === "login" ? "auth.submit.login" : "auth.submit.register")}
          </button>
        </form>
      </section>
    </main>
  );
}
