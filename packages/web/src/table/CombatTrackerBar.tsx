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
 * 2. `Totals From Session`:
 *    - Totals come from `session.initiativeTotals` (the snapshot's
 *      `initiative_totals`, then initiative rolls and `INITIATIVE_UPDATED`);
 *      a total that is not known yet shows a dash.
 * 3. `Non-Color Turn Marker`:
 *    - The active row carries `aria-current="true"` and a text marker in
 *      addition to the highlight; the live region announces turn changes.
 * 4. `Always-Mounted Action-Required Live Regions & Direct Death-Save Prompt`:
 *    - Polite live regions (`combat-turn-live` and `combat-dying-live`) remain
 *      mounted across exploration and turn-by-turn transitions so screen
 *      readers never drop an announcement mounted alongside its first string,
 *      firing only on post-mount state transitions (`Your turn: <token>` and
 *      `<token> is dying: roll a death save`).
 *    - Whenever a controlled token is in `dying` phase (`0 HP`, neither stable
 *      nor dead), a reachable death-save prompt renders directly in the combat
 *      HUD (`RECORD_DEATH_SAVE` with `d20: null`) without requiring the player
 *      to select their token on the canvas first.
 * ============================================================================
 */
import { useRef } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { Uuid } from '../api/wire.ts';
import { t } from '../i18n/index.ts';
import { advanceTurn, endTurnByTurn, recordDeathSave, setInitiativeTotal, startTurnByTurn } from './commands.ts';
import { activeTurnTokenId, deathSavePhase, initiativeEntries, listTableTokens, type TableToken } from './tableView.ts';

export interface CombatTrackerBarProps {
  /** Connected live-table API client supplying projected table and user state. */
  client: ApiClient;
  /** Whether the viewer holds the Game Master role on the active campaign. */
  isGm: boolean;
}

/**
 * Returns `true` when `token` is acted on by the current viewer's turn: any
 * token in `state.tokens` for a player, and unowned or GM-owned tokens for the
 * GM (so a player-owned hero's turn does not announce as the GM's own turn).
 */
function isViewerTurnToken(token: TableToken, userId: Uuid | null, isGm: boolean): boolean {
  if (!token.controlled) return false;
  if (!isGm) return true;
  return token.ownerUserId === null || token.ownerUserId === userId;
}

export function CombatTrackerBar({ client, isGm }: CombatTrackerBarProps) {
  const table = client.state.table.value;
  const userId = client.state.user.value?.id ?? null;
  const tokens = listTableTokens(table);
  const activeId = activeTurnTokenId(table);
  const activeToken = activeId !== null ? tokens.find((tok) => tok.id === activeId) ?? null : null;
  const inCombat = table?.mode === 'TURN_BY_TURN';

  const prevTurnKeyRef = useRef<string | null>(null);
  const prevDyingKeyRef = useRef<string | null>(null);
  const lastTurnRef = useRef<{ tokenId: Uuid; repeat: boolean } | null>(null);
  const lastDyingRef = useRef<{ tokenId: Uuid; repeat: boolean } | null>(null);

  if (!table) {
    prevTurnKeyRef.current = null;
    prevDyingKeyRef.current = null;
    lastTurnRef.current = null;
    lastDyingRef.current = null;
  } else {
    const turnKey = inCombat && activeId !== null ? `${table.round}:${table.active_turn_index}:${activeId}` : 'idle';
    const viewerOwnsTurn = Boolean(inCombat && activeToken && isViewerTurnToken(activeToken, userId, isGm));
    const activeDying = Boolean(viewerOwnsTurn && activeToken && deathSavePhase(activeToken) === 'dying');
    const dyingKey = activeDying && activeToken ? `${table.round}:${table.active_turn_index}:${activeToken.id}` : 'none';

    if (prevTurnKeyRef.current === null) {
      prevTurnKeyRef.current = turnKey;
    } else if (prevTurnKeyRef.current !== turnKey) {
      if (viewerOwnsTurn && activeToken) {
        const prev = lastTurnRef.current;
        const same = prev !== null && prev.tokenId === activeToken.id;
        lastTurnRef.current = { tokenId: activeToken.id, repeat: same ? !prev.repeat : false };
      } else {
        lastTurnRef.current = null;
      }
      prevTurnKeyRef.current = turnKey;
    }

    if (prevDyingKeyRef.current === null) {
      prevDyingKeyRef.current = dyingKey;
    } else if (prevDyingKeyRef.current !== dyingKey) {
      if (activeDying && activeToken) {
        const prev = lastDyingRef.current;
        const same = prev !== null && prev.tokenId === activeToken.id;
        lastDyingRef.current = { tokenId: activeToken.id, repeat: same ? !prev.repeat : false };
      } else {
        lastDyingRef.current = null;
      }
      prevDyingKeyRef.current = dyingKey;
    }
  }

  const turnNoticeState = lastTurnRef.current;
  const turnNoticeToken = turnNoticeState ? tokens.find((tok) => tok.id === turnNoticeState.tokenId) : undefined;
  const turnBase = turnNoticeState
    ? t('combat.yourTurn', { name: turnNoticeToken?.name || t('combat.hidden') })
    : '';
  const turnNotice = turnBase && turnNoticeState?.repeat ? `${turnBase}\u200B` : turnBase;

  const dyingNoticeState = lastDyingRef.current;
  const dyingNoticeToken = dyingNoticeState ? tokens.find((tok) => tok.id === dyingNoticeState.tokenId) : undefined;
  const dyingBase = dyingNoticeState
    ? t('deathSave.turnPrompt', { name: dyingNoticeToken?.name || t('combat.hidden') })
    : '';
  const dyingNotice = dyingBase && dyingNoticeState?.repeat ? `${dyingBase}\u200B` : dyingBase;

  const dyingTokens = tokens.filter((tok) => tok.controlled && deathSavePhase(tok) === 'dying');
  const entries = inCombat ? initiativeEntries(table, client.state.initiativeTotals.value) : [];
  const active = entries.find((entry) => entry.isActive);
  const ownsActive = activeId !== null && table?.tokens[activeId]?.owner_user_id === userId;

  return (
    <>
      <p class="ds-visually-hidden" role="status" aria-live="polite" data-testid="combat-turn-live">
        {turnNotice}
      </p>
      <p class="ds-visually-hidden" role="status" aria-live="polite" data-testid="combat-dying-live">
        {dyingNotice}
      </p>
      {!table ? null : !inCombat ? (
        isGm ? (
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
        ) : null
      ) : (
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
      )}
      {dyingTokens.length > 0 ? (
        <section class="ds-panel ds-stack-sm" aria-label={t('deathSave.promptRegion')} data-testid="death-save-prompt">
          <h3 class="ds-panel-title">{t('deathSave.promptTitle')}</h3>
          {dyingTokens.map((tok) => (
            <div key={tok.id} class="ds-cluster" data-testid={`death-save-entry-${tok.id}`}>
              <p class="ds-value">{t('deathSave.turnPrompt', { name: tok.name })}</p>
              <p class="ds-hint" data-testid={`death-save-counters-${tok.id}`}>
                {t('vitals.deathCounters', { successes: tok.deathSaves.successes, failures: tok.deathSaves.failures })}
              </p>
              <button
                type="button"
                class="ds-btn ds-btn-primary ds-btn-sm"
                aria-label={t('deathSave.rollFor', { name: tok.name })}
                data-testid={`death-save-roll-${tok.id}`}
                onClick={() => client.submitCommand(recordDeathSave(tok.id))}
              >
                {t('vitals.deathRoll')}
              </button>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
