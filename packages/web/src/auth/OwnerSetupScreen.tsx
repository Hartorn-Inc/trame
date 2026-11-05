/**
 * ============================================================================
 * OWNER SETUP SCREEN (auth/OwnerSetupScreen.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lets whoever holds the one-time setup URL logged by a fresh server
 * (`/setup?token=<hex>`, ADR-0039) claim the instance as its `Owner`. Without
 * this screen the token could only be redeemed with raw HTTP calls, and an
 * instance with closed registration would have no way to get its first
 * account.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Token Checked Before Credentials`:
 *    - `POST /instance/bootstrap/status` runs on mount; the form only renders
 *      for a `valid` token. `expired` and `invalid` explain how to get a new
 *      URL instead of collecting a password that would be refused.
 * 2. `Locked Email Is Read-Only`:
 *    - With `TRAME_BOOTSTRAP_OWNER_EMAIL`, the status returns `locked_email`;
 *      the email field is prefilled and read-only, so the claim cannot fail
 *      with `EMAIL_LOCKED` through a typo.
 * 3. `Token-Level Failures End The Form`:
 *    - `INVALID_SETUP_TOKEN`, `OWNER_EXISTS` and `SETUP_TOKEN_EXPIRED` on
 *      submit switch to the matching explanation; field-level codes
 *      (`INVALID_EMAIL`, `WEAK_PASSWORD`, ...) flag their field.
 * 4. `Live Region Exists Before Its Message`:
 *    - The token-state alert region is always mounted and filled after the
 *      async check, because screen readers ignore live regions inserted
 *      together with their text.
 * 5. `Token Never In The Address Bar`:
 *    - The bootstrap strips `?token=` before this screen mounts; the token
 *      lives only in props.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * mount -> `getSetupTokenStatus(token)` -> `valid` form | explanation
 * submit -> `bootstrapOwner` -> session user set -> `onDone()` -> lobby.
 * ============================================================================
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../api/client.ts";
import { LocaleToggle } from "../components/ShellToggles.tsx";
import { useFocusOnMount } from "../components/a11y/useFocusOnMount.ts";
import { t, type MessageKey } from "../i18n/index.ts";
import { AccountField, apiErrorKey } from "./accountForm.tsx";

/** Props for `OwnerSetupScreen`. */
export interface OwnerSetupScreenProps {
  client: ApiClient;
  /** Raw setup token from `/setup?token=`; empty when the URL had none. */
  token: string;
  /** Called once the Owner account exists and is signed in. */
  onDone: () => void;
}

type Phase = "checking" | "valid" | "expired" | "invalid" | "checkFailed";
type Field = "email" | "displayName" | "password";

const ERROR_ID = "setup-error";

const FIELD_ERRORS: Record<string, MessageKey> = {
  EMAIL_LOCKED: "setup.error.emailLocked",
  INVALID_CREDENTIALS: "setup.error.existingAccount",
  EMAIL_ALREADY_EXISTS: "setup.error.existingAccount",
  INVALID_EMAIL: "auth.error.invalidEmail",
  INVALID_DISPLAY_NAME: "auth.error.invalidDisplayName",
  WEAK_PASSWORD: "auth.error.weakPassword",
};

const ERROR_FIELDS: Partial<Record<MessageKey, readonly Field[]>> = {
  "setup.error.emailLocked": ["email"],
  "setup.error.existingAccount": ["password"],
  "auth.error.invalidEmail": ["email"],
  "auth.error.invalidDisplayName": ["displayName"],
  "auth.error.weakPassword": ["password"],
};

const TERMINAL_PHASES: Record<string, Phase> = {
  INVALID_SETUP_TOKEN: "invalid",
  OWNER_EXISTS: "invalid",
  SETUP_TOKEN_EXPIRED: "expired",
};

const PHASE_MESSAGES: Record<"expired" | "invalid" | "checkFailed", MessageKey> = {
  expired: "setup.expired",
  invalid: "setup.invalid",
  checkFailed: "setup.checkFailed",
};

/** Claims a fresh instance as its `Owner` from the logged setup URL. */
export function OwnerSetupScreen({ client, token, onDone }: OwnerSetupScreenProps) {
  const [phase, setPhase] = useState<Phase>(token ? "checking" : "invalid");
  const [lockedEmail, setLockedEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useFocusOnMount(titleRef);

  useEffect(() => {
    if (!token) return;
    client.getSetupTokenStatus(token).then(
      (check) => {
        setLockedEmail(check.lockedEmail);
        if (check.lockedEmail) setEmail(check.lockedEmail);
        setPhase(check.status);
      },
      () => setPhase("checkFailed"),
    );
  }, [client, token]);

  const invalid = error ? (ERROR_FIELDS[error] ?? []) : [];
  const errorIdFor = (field: Field) => (invalid.includes(field) ? ERROR_ID : null);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.bootstrapOwner({ token, email, password, displayName });
      onDone();
    } catch (err) {
      const terminal = err instanceof ApiError && err.code ? TERMINAL_PHASES[err.code] : undefined;
      if (terminal) setPhase(terminal);
      else setError(apiErrorKey(err, FIELD_ERRORS));
      setSubmitting(false);
    }
  };

  return (
    <main
      class="ds-app-shell"
      data-testid="owner-setup-screen"
      style={{ alignItems: "center", justifyContent: "center", padding: "var(--atlas-space-lg)" }}
    >
      <section class="ds-panel ds-stack" aria-labelledby="setup-title" style={{ width: "100%", maxWidth: "28rem" }}>
        <div class="ds-row">
          <h1 id="setup-title" ref={titleRef} tabIndex={-1} class="ds-brand-title" style={{ margin: 0 }}>
            {t("setup.title")}
          </h1>
          <LocaleToggle />
        </div>

        {phase === "checking" && (
          <p data-testid="setup-checking">
            {t("setup.checking")}
          </p>
        )}

        <div role="alert" data-testid="setup-alert-region">
          {(phase === "expired" || phase === "invalid" || phase === "checkFailed") && (
            <div data-testid={`setup-${phase}`} class="ds-stack-sm">
              <p class="ds-field-error">{t(PHASE_MESSAGES[phase])}</p>
              <p class="ds-hint">{t("setup.howToGetUrl")}</p>
            </div>
          )}
        </div>

        {phase === "valid" && (
          <form data-testid="setup-form" onSubmit={onSubmit} class="ds-stack">
            <p>{t("setup.intro")}</p>
            <AccountField
              id="setup-email"
              label={t("auth.email")}
              type="email"
              autocomplete="email"
              value={email}
              onInput={setEmail}
              readOnly={lockedEmail !== null}
              hint={lockedEmail ? t("setup.emailLockedHint") : undefined}
              errorId={errorIdFor("email")}
            />
            <AccountField
              id="setup-display-name"
              label={t("auth.displayName")}
              type="text"
              autocomplete="nickname"
              value={displayName}
              onInput={setDisplayName}
              errorId={errorIdFor("displayName")}
            />
            <AccountField
              id="setup-password"
              label={t("auth.password")}
              type="password"
              autocomplete="new-password"
              value={password}
              onInput={setPassword}
              hint={t("setup.passwordHint")}
              errorId={errorIdFor("password")}
            />
            {error && (
              <p id={ERROR_ID} data-testid="setup-error" role="alert" class="ds-field-error">
                {t(error)}
              </p>
            )}
            <button
              type="submit"
              class="ds-btn ds-btn-primary"
              data-testid="setup-submit"
              aria-disabled={submitting ? "true" : undefined}
              aria-busy={submitting ? "true" : undefined}
            >
              {submitting ? t("auth.submitting") : t("setup.submit")}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
