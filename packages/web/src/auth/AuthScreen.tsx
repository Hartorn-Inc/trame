/**
 * ============================================================================
 * SIGN-IN / REGISTRATION SCREEN (auth/AuthScreen.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Rendered by the auth guard when no session exists. Lets a user sign in
 * through `ApiClient`, which sets `session.user` and moves the shell to the
 * campaign lobby. Public registration exists only where the server accepts
 * it (`TRAME_ENV=dev`); elsewhere accounts come from owner setup or an
 * invite link (ADR-0039).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Registration Follows The Server`:
 *    - `GET /api/v1/instance` decides: the "Create account" mode renders only
 *      when `registration_open` is true. Until it answers, or when it fails,
 *      the screen fails closed to sign-in only plus an invite explanation.
 * 2. `Server-Side Validation Is Authoritative`:
 *    - Server error codes (`EMAIL_ALREADY_EXISTS`, `INVALID_EMAIL`, ...) map to
 *      localized messages; the form does no duplicate validation beyond the
 *      native `required` / `type="email"` hints.
 * 3. `Errors Point At Their Field`:
 *    - The field an error refers to gets `aria-invalid` and `aria-describedby`
 *      pointing at the `role="alert"` message, so the error is read again when
 *      the user returns to that field.
 * 4. `Focusable While Busy`:
 *    - Submit uses `aria-disabled` + `aria-busy` instead of `disabled`, so
 *      focus is not dropped to `<body>` while the request is in flight.
 * 5. `TOTP Step On Demand`:
 *    - `401 MFA_REQUIRED` (or `INVALID_TOTP_CODE`) adds a 6-digit code field
 *      under the kept email and password and moves focus to it; the next
 *      submit sends `totp_code`. Accounts without TOTP never see the field.
 * 5. `ATLAS v1.1 Only`:
 *    - Layout uses `ds-*` primitives and `--atlas-*` tokens, no raw colors.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, INVALID_TOTP_CODE, MFA_REQUIRED, type ApiClient } from "../api/client.ts";
import { LocaleToggle } from "../components/ShellToggles.tsx";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { t, type MessageKey } from "../i18n/index.ts";

/** Props for `AuthScreen`. */
export interface AuthScreenProps {
  client: ApiClient;
}

type AuthMode = "login" | "register";
type AuthField = "email" | "displayName" | "password" | "totp";

const ERROR_ID = "auth-error";
const TOTP_HINT_ID = "auth-totp-hint";

const ERROR_KEYS: Record<string, MessageKey> = {
  EMAIL_ALREADY_EXISTS: "auth.error.emailTaken",
  INVALID_EMAIL: "auth.error.invalidEmail",
  INVALID_DISPLAY_NAME: "auth.error.invalidDisplayName",
  WEAK_PASSWORD: "auth.error.weakPassword",
  REGISTRATION_CLOSED: "auth.error.registrationClosed",
  [INVALID_TOTP_CODE]: "auth.error.invalidTotp",
};

/** Fields each error message describes; `auth.error.generic` points at none. */
const ERROR_FIELDS: Partial<Record<MessageKey, readonly AuthField[]>> = {
  "auth.error.emailTaken": ["email"],
  "auth.error.invalidEmail": ["email"],
  "auth.error.invalidDisplayName": ["displayName"],
  "auth.error.weakPassword": ["password"],
  "auth.error.invalidCredentials": ["email", "password"],
  "auth.error.invalidTotp": ["totp"],
};

/** `true` when a sign-in failure means the account needs (another) TOTP code. */
function needsTotp(err: unknown): boolean {
  return err instanceof ApiError && (err.code === MFA_REQUIRED || err.code === INVALID_TOTP_CODE);
}

function errorKey(err: unknown): MessageKey {
  if (err instanceof ApiError) {
    if (err.code && ERROR_KEYS[err.code]) return ERROR_KEYS[err.code];
    if (err.status === 401) return "auth.error.invalidCredentials";
    if (err.status === 429) return "auth.error.rateLimited";
  }
  return "auth.error.generic";
}

/** Sign-in form (plus registration where the server allows it) shown to anonymous users. */
export function AuthScreen({ client }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [totpStep, setTotpStep] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const totpRef = useRef<HTMLInputElement | null>(null);

  useFocusOnMount(titleRef);
  useEffect(() => {
    if (totpStep) totpRef.current?.focus();
  }, [totpStep]);
  useEffect(() => {
    client.getInstanceInfo().then(
      (info) => setRegistrationOpen(info.registrationOpen),
      () => setRegistrationOpen(false),
    );
  }, [client]);

  const activeMode: AuthMode = registrationOpen ? mode : "login";
  const invalidFields = error ? (ERROR_FIELDS[error] ?? []) : [];
  const fieldErrorProps = (field: AuthField) =>
    invalidFields.includes(field) ? { "aria-invalid": "true" as const, "aria-describedby": ERROR_ID } : {};

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (activeMode === "login") {
        await client.login({ email, password, totpCode: totpStep ? totpCode.trim() : undefined });
      } else {
        await client.register({ email, displayName, password });
      }
    } catch (err) {
      if (needsTotp(err)) setTotpStep(true);
      setError(err instanceof ApiError && err.code === MFA_REQUIRED ? null : errorKey(err));
      setSubmitting(false);
    }
  };

  const modeButton = (value: AuthMode, label: MessageKey) => (
    <button
      type="button"
      class="ds-btn ds-btn-secondary"
      data-testid={`auth-mode-${value}`}
      aria-pressed={activeMode === value ? "true" : "false"}
      disabled={submitting}
      onClick={() => {
        setMode(value);
        setError(null);
        setTotpStep(false);
      }}
    >
      {activeMode === value && <span aria-hidden="true">✓</span>}
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

        {registrationOpen ? (
          <div role="group" aria-label={t("auth.modeLabel")} class="ds-cluster">
            {modeButton("login", "auth.mode.login")}
            {modeButton("register", "auth.mode.register")}
          </div>
        ) : (
          <p class="ds-hint" data-testid="auth-invite-only">
            {t("auth.inviteOnly")}
          </p>
        )}

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

          {activeMode === "register" && (
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
              autocomplete={activeMode === "login" ? "current-password" : "new-password"}
              required
              value={password}
              onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
              {...fieldErrorProps("password")}
            />
          </label>

          {activeMode === "login" && totpStep && (
            <>
              <label class="ds-field" for="auth-totp">
                <span class="ds-field-label">{t("auth.totp")}</span>
                <input
                  id="auth-totp"
                  ref={totpRef}
                  data-testid="auth-totp"
                  class="ds-input atlas-tabular-nums"
                  type="text"
                  inputMode="numeric"
                  autocomplete="one-time-code"
                  required
                  value={totpCode}
                  onInput={(e) => setTotpCode((e.currentTarget as HTMLInputElement).value)}
                  aria-invalid={invalidFields.includes("totp") ? "true" : undefined}
                  aria-describedby={invalidFields.includes("totp") ? `${ERROR_ID} ${TOTP_HINT_ID}` : TOTP_HINT_ID}
                />
              </label>
              <p id={TOTP_HINT_ID} class="ds-hint" data-testid="auth-totp-hint">
                {t("auth.totpRequired")}
              </p>
            </>
          )}

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
            {submitting ? t("auth.submitting") : t(activeMode === "login" ? "auth.submit.login" : "auth.submit.register")}
          </button>
        </form>
      </section>
    </main>
  );
}
