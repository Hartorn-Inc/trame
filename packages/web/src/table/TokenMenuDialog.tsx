/**
 * ============================================================================
 * TOKEN ACTIONS MENU (table/TokenMenuDialog.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Modal action menu for one token, opened from the board (right-click,
 * Shift+F10 / ContextMenu key on a token, or the "Token actions" button).
 * Offers Disengage (`SET_DISENGAGED`) to whoever controls the token and, for
 * the Game Master, reveal / hide (`SET_TOKEN_VISIBILITY`), teleport
 * (`MOVE_TOKEN gm_teleport`), a remaining-speed override
 * (`GM_OVERRIDE_TOKEN_RESOURCES`) and removal (`REMOVE_TOKEN`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Permission Mirror`:
 *    - GM entries render only for the GM; Disengage only for a controlled
 *      token (GM: any; player: owned). The server re-checks every command.
 * 2. `Modal Focus`:
 *    - `useModalFocusTrap` keeps Tab inside, Escape closes and focus returns
 *      to the token that opened the menu.
 * 3. `Teleport Is Two-Step`:
 *    - "Teleport" closes the menu and arms the board (`onTeleport`); the next
 *      board click or arrow key sends the move with `gm_teleport: true`.
 * 4. `Non-Negative Speed`:
 *    - The speed override accepts whole feet `>= 0`; otherwise the button is
 *      disabled.
 * 5. `Removal Is Confirmed`:
 *    - "Remove token" only asks; `REMOVE_TOKEN` is sent by the confirm button
 *      that replaces it (focused), so a stray click cannot delete a token.
 *      Cancel restores the menu.
 * ============================================================================
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import { useModalFocusTrap } from '../components/a11y/useModalFocusTrap.ts';
import { t } from '../i18n/index.ts';
import { overrideRemainingSpeed, removeToken, setDisengaged, setTokenVisibility } from './commands.ts';
import type { TableToken } from './tableView.ts';

export interface TokenMenuDialogProps {
  client: ApiClient;
  token: TableToken;
  isGm: boolean;
  onClose: () => void;
  /** Arms GM teleport for `token` (invariant 3). */
  onTeleport: (token: TableToken) => void;
}

export function TokenMenuDialog({ client, token, isGm, onClose, onTeleport }: TokenMenuDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [speed, setSpeed] = useState(token.speedRemainingFt !== null ? String(token.speedRemainingFt) : '');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const askedRemove = useRef(false);
  useModalFocusTrap(dialogRef, { onEscape: onClose });
  useLayoutEffect(() => {
    if (confirmRemove) confirmRef.current?.focus();
    else if (askedRemove.current) removeRef.current?.focus();
    askedRemove.current = confirmRemove;
  }, [confirmRemove]);
  const speedValue = Number(speed);
  const speedValid = speed !== '' && Number.isInteger(speedValue) && speedValue >= 0;
  const send = (command: Parameters<ApiClient['submitCommand']>[0]) => {
    client.submitCommand(command);
    onClose();
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-menu-title"
      tabIndex={-1}
      class="ds-modal-backdrop"
      data-testid="token-menu"
    >
      <div class="ds-modal ds-modal-narrow">
        <header class="ds-modal-header">
          <h2 id="token-menu-title" class="ds-modal-title">{t('tokenMenu.title', { name: token.name })}</h2>
        </header>
        <div class="ds-modal-body ds-stack-sm">
          {token.controlled ? (
            <button
              type="button"
              class="ds-btn ds-btn-secondary"
              data-testid="token-menu-disengage"
              onClick={() => send(setDisengaged(token.id, !token.disengaged))}
            >
              {token.disengaged ? t('tokenMenu.disengageEnd') : t('tokenMenu.disengage')}
            </button>
          ) : null}
          {isGm ? (
            <>
              <button
                type="button"
                class="ds-btn ds-btn-secondary"
                data-testid="token-menu-visibility"
                onClick={() => send(setTokenVisibility(token.id, !token.gmHidden, token.invisible))}
              >
                {token.gmHidden ? t('tokenMenu.reveal') : t('tokenMenu.hide')}
              </button>
              <button
                type="button"
                class="ds-btn ds-btn-secondary"
                data-testid="token-menu-teleport"
                onClick={() => {
                  onTeleport(token);
                  onClose();
                }}
              >
                {t('tokenMenu.teleport')}
              </button>
              <div class="ds-cluster">
                <label class="ds-field-label" for="token-menu-speed">{t('tokenMenu.speed')}</label>
                <input
                  id="token-menu-speed"
                  type="number"
                  min={0}
                  step={5}
                  class="ds-input ds-input-compact"
                  data-testid="token-menu-speed"
                  value={speed}
                  onInput={(e) => setSpeed((e.target as HTMLInputElement).value)}
                />
                <button
                  type="button"
                  class="ds-btn ds-btn-secondary"
                  data-testid="token-menu-speed-apply"
                  disabled={!speedValid}
                  onClick={() => send(overrideRemainingSpeed(token.id, speedValue))}
                >
                  {t('tokenMenu.speedApply')}
                </button>
              </div>
              {confirmRemove ? (
                <div class="ds-cluster" role="group" aria-labelledby="token-menu-remove-question">
                  <p id="token-menu-remove-question" class="ds-hint" data-testid="token-menu-remove-question">
                    {t('tokenMenu.removeQuestion', { name: token.name })}
                  </p>
                  <button
                    ref={confirmRef}
                    type="button"
                    class="ds-btn ds-btn-danger"
                    data-testid="token-menu-remove-confirm"
                    onClick={() => send(removeToken(token.id))}
                  >
                    {t('tokenMenu.removeConfirm')}
                  </button>
                  <button type="button" class="ds-btn ds-btn-ghost" data-testid="token-menu-remove-cancel" onClick={() => setConfirmRemove(false)}>
                    {t('tokenMenu.removeCancel')}
                  </button>
                </div>
              ) : (
                <button ref={removeRef} type="button" class="ds-btn ds-btn-danger" data-testid="token-menu-remove" onClick={() => setConfirmRemove(true)}>
                  {t('tokenMenu.remove')}
                </button>
              )}
            </>
          ) : null}
          {!token.controlled && !isGm ? <p class="ds-hint">{t('tokenMenu.noActions')}</p> : null}
        </div>
        <footer class="ds-modal-footer">
          <button type="button" class="ds-btn ds-btn-ghost" data-testid="token-menu-close" onClick={onClose}>
            {t('tokenMenu.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
