import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client, type ApiClient } from "../api/client.ts";
import { appSignals } from "../state/appSignals.ts";
import type { AuthUser } from "../types/index.ts";

export interface AuthScreenProps {
  children?: ComponentChildren;
  client?: ApiClient;
  onSuccess?: (user: AuthUser) => void;
  onNavigateToLobby?: () => void;
  initialMode?: "register" | "login";
}

export function AuthScreen(props: AuthScreenProps): JSX.Element {
  const activeClient = props.client || client;
  const [mode, setMode] = useState<"register" | "login">(props.initialMode || "register");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e?: { preventDefault: () => void }): Promise<void> => {
    e?.preventDefault();
    setErrorMessage(null);

    const cleanEmail = email.trim();
    if (!cleanEmail || !cleanEmail.includes("@") || !cleanEmail.includes(".")) {
      setErrorMessage("Please enter a valid email address containing '@' and domain.");
      return;
    }

    if (mode === "register") {
      const cleanName = displayName.trim();
      if (cleanName.length < 2 || cleanName.length > 100) {
        setErrorMessage("Display name must be between 2 and 100 characters.");
        return;
      }
    }

    if (password.length < 8) {
      setErrorMessage("Password must be at least 8 characters long for security.");
      return;
    }

    setLoading(true);
    try {
      let user: AuthUser;
      if (mode === "register") {
        user = await activeClient.register({
          email: cleanEmail,
          displayName: displayName.trim(),
          password,
        });
      } else {
        user = await activeClient.login({
          email: cleanEmail,
          password,
        });
      }
      appSignals.authUserSignal.value = user;
      props.onSuccess?.(user);
      props.onNavigateToLobby?.();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      role="main"
      aria-labelledby="auth-heading"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--atlas-bg)",
        color: "var(--atlas-text)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "1rem",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "440px",
          backgroundColor: "var(--atlas-surface)",
          border: "1px solid var(--atlas-surface)",
          borderRadius: "8px",
          padding: "2rem",
          boxShadow: "0 10px 25px -5px var(--atlas-surface-raised)",
        }}
      >
        <header style={{ marginBottom: "1.5rem", textAlign: "center" }}>
          <h1 id="auth-heading" style={{ fontSize: "1.5rem", margin: "0 0 0.5rem 0", color: "var(--atlas-action)" }}>
            {mode === "register" ? "Create TRAME Account" : "Sign In to TRAME"}
          </h1>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}>
            {mode === "register"
              ? "Register as a Game Master to host authoritative campaigns"
              : "Enter your credentials to access your campaign lobby"}
          </p>
        </header>

        {errorMessage && (
          <div
            role="alert"
            aria-live="polite"
            data-testid="auth-error-banner"
            style={{
              backgroundColor: "var(--atlas-info)",
              color: "var(--atlas-info)",
              border: "1px solid var(--atlas-info)",
              borderRadius: "6px",
              padding: "0.75rem 1rem",
              marginBottom: "1.25rem",
              fontSize: "0.875rem",
            }}
          >
            {errorMessage}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          noValidate
          aria-label={mode === "register" ? "Registration form" : "Login form"}
          data-testid="auth-form"
        >
          <div style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="auth-email"
              style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}
            >
              Email Address <span aria-hidden="true" style={{ color: "var(--atlas-danger)" }}>*</span>
            </label>
            <input
              id="auth-email"
              name="email"
              type="email"
              value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              required
              aria-required="true"
              data-testid="auth-email-input"
              style={{
                width: "100%",
                padding: "0.625rem 0.75rem",
                backgroundColor: "var(--atlas-bg)",
                border: "1px solid var(--atlas-border)",
                borderRadius: "4px",
                color: "var(--atlas-text)",
                fontSize: "1rem",
                outlineColor: "var(--atlas-action)",
                boxSizing: "border-box",
              }}
            />
          </div>

          {mode === "register" && (
            <div style={{ marginBottom: "1rem" }}>
              <label
                htmlFor="auth-display-name"
                style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}
              >
                Display Name <span aria-hidden="true" style={{ color: "var(--atlas-danger)" }}>*</span>
              </label>
              <input
                id="auth-display-name"
                name="displayName"
                type="text"
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                required
                aria-required="true"
                data-testid="auth-display-name-input"
                style={{
                  width: "100%",
                  padding: "0.625rem 0.75rem",
                  backgroundColor: "var(--atlas-bg)",
                  border: "1px solid var(--atlas-border)",
                  borderRadius: "4px",
                  color: "var(--atlas-text)",
                  fontSize: "1rem",
                  outlineColor: "var(--atlas-action)",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}

          <div style={{ marginBottom: "1.5rem" }}>
            <label
              htmlFor="auth-password"
              style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}
            >
              Password <span aria-hidden="true" style={{ color: "var(--atlas-danger)" }}>*</span>
            </label>
            <input
              id="auth-password"
              name="password"
              type="password"
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              required
              aria-required="true"
              data-testid="auth-password-input"
              style={{
                width: "100%",
                padding: "0.625rem 0.75rem",
                backgroundColor: "var(--atlas-bg)",
                border: "1px solid var(--atlas-border)",
                borderRadius: "4px",
                color: "var(--atlas-text)",
                fontSize: "1rem",
                outlineColor: "var(--atlas-action)",
                boxSizing: "border-box",
              }}
            />
            <small style={{ color: "var(--atlas-text-muted)", fontSize: "0.75rem", display: "block", marginTop: "0.25rem" }}>
              Minimum 8 characters (OWASP Argon2id protected)
            </small>
          </div>

          <button
            type="submit"
            disabled={loading}
            data-testid="auth-submit-btn"
            style={{
              width: "100%",
              padding: "0.75rem",
              backgroundColor: loading ? "var(--atlas-border)" : "var(--atlas-action)",
              color: "var(--atlas-bg)",
              fontWeight: 600,
              fontSize: "1rem",
              border: "none",
              borderRadius: "4px",
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background-color 0.2s",
            }}
          >
            {loading ? "Verifying..." : mode === "register" ? "Register Account" : "Sign In"}
          </button>
        </form>

        <footer style={{ marginTop: "1.5rem", textAlign: "center", fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}>
          {mode === "register" ? (
            <span>
              Already registered?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setErrorMessage(null);
                }}
                data-testid="toggle-auth-mode-btn"
                style={{ background: "none", border: "none", color: "var(--atlas-info)", cursor: "pointer", textDecoration: "underline" }}
              >
                Sign In
              </button>
            </span>
          ) : (
            <span>
              Need an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("register");
                  setErrorMessage(null);
                }}
                data-testid="toggle-auth-mode-btn"
                style={{ background: "none", border: "none", color: "var(--atlas-info)", cursor: "pointer", textDecoration: "underline" }}
              >
                Register Account
              </button>
            </span>
          )}
        </footer>
      </div>
    </main>
  );
}
