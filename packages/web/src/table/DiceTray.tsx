/**
 * ============================================================================
 * LIVE TABLE DICE TRAY (table/DiceTray.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Free-form table rolls over the room socket (`RollDice`) and the shared roll
 * log. Sheet rolls use REST `POST .../dice/roll` instead (they must work
 * without a socket); both land in `session.diceLog` through `DiceRolled`.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server-Rolled`:
 *    - The tray never rolls locally; results only appear once the server
 *      broadcasts them, so every client sees the same numbers.
 * 2. `Visibility Respected`:
 *    - `GmOnly` / `BlindGm` rolls reach players masked (`blind_masked`,
 *      `total: null`); the log shows them as hidden instead of a number.
 * 3. `Offline Feedback`:
 *    - When the socket is not open the roll is refused with an alert rather
 *      than silently dropped.
 * ============================================================================
 */
import { useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { WireRollVisibility } from '../api/wire.ts';
import { t, type MessageKey } from '../i18n/index.ts';

/** Number of most recent rolls shown in the log. */
const VISIBLE_ROLLS = 8;
const VISIBILITIES: WireRollVisibility[] = ['Public', 'GmOnly', 'BlindGm'];

export interface DiceTrayProps {
  client: ApiClient;
}

export function DiceTray({ client }: DiceTrayProps) {
  const [expression, setExpression] = useState('1d20');
  const [visibility, setVisibility] = useState<WireRollVisibility>('Public');
  const [error, setError] = useState<string | null>(null);
  const rolls = client.state.diceLog.value.slice(-VISIBLE_ROLLS).reverse();

  const roll = (e: Event) => {
    e.preventDefault();
    const expr = expression.trim();
    if (!expr) return;
    setError(client.rollDice(expr, visibility, '') ? null : t('tray.offline'));
  };

  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('tray.title')} data-testid="dice-tray">
      <h3 class="ds-panel-title">{t('tray.title')}</h3>
      <form class="ds-cluster" onSubmit={roll}>
        <label class="ds-visually-hidden" for="tray-expression">{t('tray.expression')}</label>
        <input
          id="tray-expression"
          class="ds-input"
          data-testid="tray-expression"
          value={expression}
          onInput={(e) => setExpression((e.target as HTMLInputElement).value)}
        />
        <label class="ds-visually-hidden" for="tray-visibility">{t('tray.visibility')}</label>
        <select
          id="tray-visibility"
          class="ds-input"
          data-testid="tray-visibility"
          value={visibility}
          onChange={(e) => setVisibility((e.target as HTMLSelectElement).value as WireRollVisibility)}
        >
          {VISIBILITIES.map((v) => (
            <option key={v} value={v}>{t(`tray.visibility.${v}` as MessageKey)}</option>
          ))}
        </select>
        <button type="submit" class="ds-btn ds-btn-primary" data-testid="tray-roll">{t('tray.roll')}</button>
      </form>
      {error ? <p class="ds-field-error" role="alert">{error}</p> : null}
      <ul class="ds-list-plain ds-scroll-list" aria-live="polite" data-testid="tray-log">
        {rolls.map((r) => (
          <li key={r.roll_id} class="ds-row">
            <span class="ds-meta">{r.reason || r.expression}</span>
            <span class="ds-value">{r.total === null ? t('tray.hidden') : t('tray.result', { expression: r.expression, total: r.total })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
