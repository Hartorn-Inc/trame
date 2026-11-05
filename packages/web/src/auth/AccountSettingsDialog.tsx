/**
 * ============================================================================
 * ACCOUNT SETTINGS DIALOG & TOTP RECOMMENDATION (auth/AccountSettingsDialog.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Account menu opened from the lobby header: shows who is signed in, their
 * `InstanceRole` and what it allows, and recommends two-factor authentication
 * (TOTP) when it is off. TOTP stays optional (spec D16), but the `Owner`
 * account controls every other account, so its recommendation is worded more
 * strongly.
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
 *    - `instanceRole` and `totpEnabled` come from `/auth/me`; the dialog
 *      grants nothing by itself.
 * ============================================================================
 */
import { useRef } from "preact/hooks";
import type { AuthUser, InstanceRole } from "../api/session.ts";
import { useModalFocusTrap } from "../components/a11y/useModalFocusTrap.ts";
import { t, type MessageKey } from "../i18n/index.ts";

/** Props for `AccountSettingsDialog`. */
export interface AccountSettingsDialogProps {
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

/** Account summary with the TOTP recommendation (stronger for the Owner). */
export function AccountSettingsDialog({ user, onClose }: AccountSettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap(dialogRef, { onEscape: onClose });
  const isOwner = user.instanceRole === "OWNER";

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

          <section class="ds-inset" aria-labelledby="account-totp-title" data-testid="account-totp">
            <h3 id="account-totp-title" class="ds-section-title" style={{ margin: 0 }}>
              {t("account.totp.title")}
            </h3>
            {user.totpEnabled ? (
              <p data-testid="account-totp-enabled">{t("account.totp.enabled")}</p>
            ) : (
              <p data-testid={isOwner ? "account-totp-nudge-owner" : "account-totp-nudge"}>
                <span aria-hidden="true">! </span>
                {t(isOwner ? "account.totp.nudgeOwner" : "account.totp.nudge")}
              </p>
            )}
          </section>
        </div>
        <div class="ds-modal-footer" style={{ justifyContent: "flex-end" }}>
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="account-close" onClick={onClose}>
            {t("action.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
