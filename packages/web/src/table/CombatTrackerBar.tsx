/**
 * ============================================================================
 * COMBAT TRACKER BAR (table/CombatTrackerBar.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Shows the initiative order, each combatant's rolled total, the round, and
 * whose turn it is, and exposes the turn commands: the GM starts combat (the
 * server rolls `1d20 + dex_mod` for every token), edits totals, advances, and
 * ends combat; a player may end their own token's turn.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Engine-Owned Order`:
 *    - The order and active index come from the projection; the bar never
 *      re-sorts. `SET_INITIATIVE_TOTAL` lets the engine re-sort.
 * 2. `Totals From Events`:
 *    - Totals come from `session.initiativeTotals` (initiative rolls and
 *      `INITIATIVE_UPDATED`); a total that is not known yet shows a dash.
 * 3. `Non-Color Turn Marker`:
 *    - The active row carries `aria-current="true"` and a text marker in
 *      addition to the highlight; the live region announces turn changes.
 * ============================================================================
 */
import type { ApiClient } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { advanceTurn, endTurnByTurn, setInitiativeTotal, startTurnByTurn } from './commands.ts';
import { activeTurnTokenId, initiativeEntries } from './tableView.ts';

export interface CombatTrackerBarProps {
  client: ApiClient;
  isGm: boolean;
}

export function CombatTrackerBar({ client, isGm }: CombatTrackerBarProps) {
  const table = client.state.table.value;
  if (!table) return null;

  if (table.mode !== 'TURN_BY_TURN') {
    return isGm ? (
      <div class="ds-tracker" data-testid="combat-tracker">
        <button
          type="button"
          class="ds-btn ds-btn-primary"
          data-testid="combat-start"
          disabled={Object.keys(table.tokens).length === 0}
          onClick={() => client.submitCommand(startTurnByTurn([]))}
        >
          {t('combat.start')}
        </button>
      </div>
    ) : null;
  }

  const entries = initiativeEntries(table, client.state.initiativeTotals.value);
  const activeId = activeTurnTokenId(table);
  const active = entries.find((entry) => entry.isActive);
  const userId = client.state.user.value?.id ?? null;
  const ownsActive = activeId !== null && table.tokens[activeId]?.owner_user_id === userId;

  return (
    <nav class="ds-tracker" aria-label={t('combat.tracker')} data-testid="combat-tracker">
      <span class="ds-value" data-testid="combat-round">{t('combat.round', { round: table.round })}</span>
      <ol class="ds-tracker-list">
        {entries.map((entry) => (
          <li
            key={entry.tokenId}
            class={`ds-tracker-item${entry.isActive ? ' is-active' : ''}`}
            aria-current={entry.isActive ? 'true' : undefined}
            data-testid={`initiative-${entry.tokenId}`}
          >
            {entry.isActive ? <span aria-hidden="true">▶</span> : null}
            <span>{entry.name || t('combat.hidden')}</span>
            {isGm ? (
              <input
                type="number"
                class="ds-input ds-input-compact"
                aria-label={t('combat.totalFor', { name: entry.name })}
                data-testid={`initiative-total-${entry.tokenId}`}
                value={entry.total ?? ''}
                onChange={(e) => {
                  const value = Number((e.target as HTMLInputElement).value);
                  if (Number.isFinite(value)) client.submitCommand(setInitiativeTotal(entry.tokenId, value));
                }}
              />
            ) : (
              <span class="ds-meta" data-testid={`initiative-value-${entry.tokenId}`}>{entry.total ?? '—'}</span>
            )}
          </li>
        ))}
      </ol>
      <span role="status" class="ds-meta" data-testid="combat-active">
        {active ? t('combat.activeTurn', { name: active.name }) : t('combat.noActiveTurn')}
      </span>
      {isGm || ownsActive ? (
        <button type="button" class="ds-btn ds-btn-secondary" data-testid="combat-next" onClick={() => client.submitCommand(advanceTurn())}>
          {isGm ? t('combat.next') : t('combat.endMyTurn')}
        </button>
      ) : null}
      {isGm ? (
        <button type="button" class="ds-btn ds-btn-ghost" data-testid="combat-end" onClick={() => client.submitCommand(endTurnByTurn())}>
          {t('combat.end')}
        </button>
      ) : null}
    </nav>
  );
}
