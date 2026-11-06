/**
 * ============================================================================
 * ACCOUNT FORM FIELDS & SERVER ERROR MAPPING (auth/accountForm.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Shared building blocks of the account screens (owner setup,
 * `InviteRedemption`, legacy guest bind): one labelled input primitive and
 * one translation of server `{ code, error }` bodies into localized messages,
 * so every form announces and associates errors the same way.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Errors Point At Their Field`:
 *    - A field whose `errorId` is set gets `aria-invalid` and lists that id in
 *      `aria-describedby`, so a screen reader re-reads the `role="alert"`
 *      message when the user returns to the field.
 * 2. `Hints Stay Outside The Label`:
 *    - A hint is a sibling paragraph referenced by `aria-describedby`, so it
 *      never becomes part of the field's accessible name.
 * 3. `Server Codes Are Authoritative`:
 *    - `apiErrorKey` maps known codes, then `429` (throttled), then falls back
 *      to a generic message; the raw server text is never shown to users.
 * ============================================================================
 */
import { ApiError } from "../api/client.ts";
import type { Ref } from "preact";
import type { MessageKey } from "../i18n/index.ts";

/** Props for `AccountField`. */
export interface AccountFieldProps {
  /** DOM id, also used as `data-testid`. */
  id: string;
  /** Visible label text (already translated). */
  label: string;
  type: "email" | "text" | "password";
  /** HTML `autocomplete` token, e.g. `email`, `new-password`. */
  autocomplete: string;
  value: string;
  onInput: (value: string) => void;
  /** Id of the alert describing this field's current error; `null` when valid. */
  errorId?: string | null;
  /** Locked value (e.g. the owner email fixed by `TRAME_BOOTSTRAP_OWNER_EMAIL`). */
  readOnly?: boolean;
  /** Help text rendered under the field (already translated). */
  hint?: string;
  /** Virtual keyboard hint; `numeric` for one-time codes. */
  inputMode?: "numeric";
  /** Ref to the `<input>`, for screens that move focus to a field that just appeared. */
  inputRef?: Ref<HTMLInputElement>;
}

/** Labelled `ds-input` with error and hint association (invariants 1-2). */
export function AccountField(props: AccountFieldProps) {
  const hintId = props.hint ? `${props.id}-hint` : null;
  const describedBy = [props.errorId, hintId].filter(Boolean).join(" ");
  // Preact types `type` as a discriminated union; the three variants accept identical attributes here.
  const inputType = props.type as "text";
  return (
    <>
      <label class="ds-field" for={props.id}>
        <span class="ds-field-label">{props.label}</span>
        <input
          id={props.id}
          ref={props.inputRef}
          data-testid={props.id}
          class="ds-input"
          type={inputType}
          autocomplete={props.autocomplete}
          inputMode={props.inputMode}
          required
          readOnly={props.readOnly}
          value={props.value}
          aria-invalid={props.errorId ? "true" : undefined}
          aria-describedby={describedBy || undefined}
          onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      {hintId && (
        <p id={hintId} class="ds-hint">
          {props.hint}
        </p>
      )}
    </>
  );
}

/**
 * Localized message for a failed request: the entry of `codes` for the server
 * error code, `auth.error.rateLimited` for `429`, otherwise `fallback`.
 */
export function apiErrorKey(
  err: unknown,
  codes: Readonly<Record<string, MessageKey>>,
  fallback: MessageKey = "auth.error.generic",
): MessageKey {
  if (err instanceof ApiError) {
    if (err.code && codes[err.code]) return codes[err.code];
    if (err.status === 429) return "auth.error.rateLimited";
  }
  return fallback;
}
