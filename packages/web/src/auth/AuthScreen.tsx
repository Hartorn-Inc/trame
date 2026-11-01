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
 * 2. `Accessible Errors`:
 *    - Errors render in a `role="alert"` region; the mode switch is a pair of
 *      `aria-pressed` buttons inside a labelled group.
 * 3. `ATLAS v1.1 Only`:
 *    - Layout uses `ds-*` primitives and `--atlas-*` tokens, no raw colors.
 * ============================================================================
 */
import { useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../api/client.ts";
import { t, type MessageKey } from "../i18n/index.ts";

/** Props for `AuthScreen`. */
export interface AuthScreenProps {
  client: ApiClient;
}

type AuthMode = "login" | "register";

const ERROR_KEYS: Record<string, MessageKey> = {
  EMAIL_ALREADY_EXISTS: "auth.error.emailTaken",
  INVALID_EMAIL: "auth.error.invalidEmail",
  INVALID_DISPLAY_NAME: "auth.error.invalidDisplayName",
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
  const inviteFailed = client.state.inviteError.value !== null;

  const onSubmit = async (e: Event) => {
    e.preventDefault();
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
      onClick={() => {
        setMode(value);
        setError(null);
      }}
    >
      {t(label)}
    </button>
  );

  return (
    <main
      class="ds-app-shell"
      data-testid="auth-screen"
      style={{ alignItems: "center", justifyContent: "center", padding: "var(--atlas-space-lg)" }}
    >
      <section
        class="ds-panel"
        aria-labelledby="auth-title"
        style={{ width: "100%", maxWidth: "26rem", display: "flex", flexDirection: "column", gap: "var(--atlas-space-md)" }}
      >
        <h1 id="auth-title" class="ds-brand-title" style={{ margin: 0 }}>
          {t("auth.title")}
        </h1>

        {inviteFailed && (
          <p data-testid="auth-invite-error" role="alert" style={{ margin: 0, color: "var(--atlas-danger)" }}>
            {t("auth.inviteFailed")}
          </p>
        )}

        <div role="group" aria-label={t("auth.modeLabel")} style={{ display: "flex", gap: "var(--atlas-space-sm)" }}>
          {modeButton("login", "auth.mode.login")}
          {modeButton("register", "auth.mode.register")}
        </div>

        <form
          data-testid="auth-form"
          onSubmit={onSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "var(--atlas-space-md)" }}
        >
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
            />
          </label>

          {error && (
            <p data-testid="auth-error" role="alert" style={{ margin: 0, color: "var(--atlas-danger)" }}>
              {t(error)}
            </p>
          )}

          <button type="submit" class="ds-btn ds-btn-primary" data-testid="auth-submit" disabled={submitting}>
            {submitting ? t("auth.submitting") : t(mode === "login" ? "auth.submit.login" : "auth.submit.register")}
          </button>
        </form>
      </section>
    </main>
  );
}
