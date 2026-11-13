/**
 * ============================================================================
 * CONCENTRATION CHECK PROMPT (table/ConcentrationCheckPrompt.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Story 58: when a concentrating token takes damage, the engine opens a
 * `ConcentrationCheckPrompt` (DC `max(10, floor(damage / 2))`, at most 30).
 * This panel shows "CON save DC N" to the token's controller (the GM for
 * monsters) with a Roll button; the room rolls the save, and a failure ends
 * concentration and its persistent area.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server Rolls`:
 *    - Roll sends `ROLL_CONCENTRATION_CHECK` without dice; the room rolls with
 *      the Constitution save bonus of the sheet or stat block. The roll mode
 *      comes from the token's conditions (the controller's own token).
 * 2. `Oldest DC First`:
 *    - Several hits before a roll queue several checks; the prompt shows the
 *      oldest one, as the engine resolves them in order.
 * 3. `Announced Prompt & Result`:
 *    - An always-mounted polite live region (`concentration-check-live`)
 *      stays in the DOM even when no check is queued so screen readers
 *      announce `Concentration check DC <N> for <token>` on post-mount state
 *      transitions without dropping text mounted simultaneously with its node.
 *    - The last `CONCENTRATION_CHECK_ROLLED` result is a polite live region.
 *      It is kept across later table events (`lastEvents` only holds the
 *      latest batch) until the user dismisses it, another result replaces
 *      it, or a new check is queued.
 * ============================================================================
 */
import { useRef, useState } from 'preact/hooks';
import { resolveSavingThrowMode } from '../../../game-systems/dnd5e/src/index.ts';
import type { ApiClient } from '../api/client.ts';
import type { Uuid, WireTrameEvent } from '../api/wire.ts';
import { t } from '../i18n/index.ts';
import { rollConcentrationCheck } from './commands.ts';
import { listTableTokens } from './tableView.ts';

const WIRE_MODE = { normal: 'NORMAL', advantage: 'ADVANTAGE', disadvantage: 'DISADVANTAGE' } as const;

export interface ConcentrationCheckPromptProps {
  /** Connected live-table API client supplying projected table and event state. */
  client: ApiClient;
}

export function ConcentrationCheckPrompt({ client }: ConcentrationCheckPromptProps) {
  const state = client.state.table.value;
  const checks = Object.entries(state?.pending_concentration_checks ?? {}).filter(([, dcs]) => dcs.length > 0);
  const controlledChecks = checks.filter(([tokenId]) => Boolean(state?.tokens[tokenId]));
  const tokens = listTableTokens(state);
  const queued = checks.reduce((sum, [, dcs]) => sum + dcs.length, 0);

  const prevChecksRef = useRef<Map<Uuid, number[]> | null>(null);
  const lastCheckRef = useRef<{ tokenId: Uuid; dc: number; repeat: boolean } | null>(null);
  if (!state) {
    prevChecksRef.current = null;
    lastCheckRef.current = null;
  } else {
    const nextChecks = new Map<Uuid, number[]>(controlledChecks.map(([id, dcs]) => [id as Uuid, [...dcs]]));
    if (prevChecksRef.current === null) {
      prevChecksRef.current = nextChecks;
    } else {
      const prevChecks = prevChecksRef.current;
      if (controlledChecks.length === 0) {
        lastCheckRef.current = null;
      } else {
        let triggered: { tokenId: Uuid; dc: number } | null = null;
        for (const [rawId, dcs] of controlledChecks) {
          const tokenId = rawId as Uuid;
          const prev = prevChecks.get(tokenId);
          if (!prev || prev.length === 0) {
            triggered = { tokenId, dc: dcs[0] };
            break;
          }
          if (dcs.length > prev.length) {
            triggered = { tokenId, dc: dcs[dcs.length - 1] };
            break;
          }
          if (dcs[0] !== prev[0]) {
            triggered = { tokenId, dc: dcs[0] };
            break;
          }
        }
        if (triggered) {
          const prev = lastCheckRef.current;
          const same = prev !== null && prev.tokenId === triggered.tokenId && prev.dc === triggered.dc;
          lastCheckRef.current = { ...triggered, repeat: same ? !prev.repeat : false };
        }
      }
      prevChecksRef.current = nextChecks;
    }
  }

  const checkNoticeState = lastCheckRef.current;
  const checkNoticeName = checkNoticeState
    ? tokens.find((tok) => tok.id === checkNoticeState.tokenId)?.name ?? t('resolution.unknownTarget')
    : '';
  const checkNoticeBase = checkNoticeState
    ? t('concentration.announce', { dc: checkNoticeState.dc, name: checkNoticeName })
    : '';
  const checkNotice = checkNoticeBase && checkNoticeState?.repeat ? `${checkNoticeBase}\u200B` : checkNoticeBase;

  const kept = useRef<WireTrameEvent | null>(null);
  const seen = useRef<WireTrameEvent | undefined>(undefined);
  const queuedBefore = useRef(queued);
  const [dismissed, setDismissed] = useState<WireTrameEvent | null>(null);
  const latest = [...client.state.lastEvents.value].reverse().find((ev) => ev.event === 'CONCENTRATION_CHECK_ROLLED');
  if (latest && latest !== seen.current) kept.current = latest;
  else if (queued > queuedBefore.current) kept.current = null;
  seen.current = latest;
  queuedBefore.current = queued;
  const rolled = kept.current !== dismissed ? kept.current : null;

  const rolledName = rolled ? tokens.find((tok) => tok.id === rolled.token_id)?.name : undefined;

  const roll = (tokenId: Uuid) => {
    const token = tokens.find((tok) => tok.id === tokenId);
    const mode = token ? resolveSavingThrowMode({ conditions: token.conditions, overrides: token.conditionOverrides }, 'con').mode : 'normal';
    client.submitCommand(rollConcentrationCheck(tokenId, WIRE_MODE[mode]));
  };

  return (
    <>
      <p class="ds-visually-hidden" role="status" aria-live="polite" data-testid="concentration-check-live">
        {checkNotice}
      </p>
      {checks.length > 0 || rolled ? (
        <section class="ds-panel ds-stack-sm" aria-label={t('concentration.region')} data-testid="concentration-prompt">
          <h3 class="ds-panel-title">{t('concentration.title')}</h3>
          {checks.map(([tokenId, dcs]) => {
            const name = tokens.find((tok) => tok.id === tokenId)?.name ?? t('resolution.unknownTarget');
            return (
              <div key={tokenId} class="ds-cluster" data-testid={`concentration-check-${tokenId}`}>
                <p class="ds-value">{t('concentration.prompt', { name, dc: dcs[0] })}</p>
                <button type="button" class="ds-btn ds-btn-primary ds-btn-sm" data-testid={`concentration-roll-${tokenId}`} onClick={() => roll(tokenId as Uuid)}>
                  {t('concentration.roll')}
                </button>
              </div>
            );
          })}
          <div class="ds-cluster">
            <p class="ds-hint" role="status" aria-live="polite" data-testid="concentration-result">
              {rolled
                ? t(rolled.success ? 'concentration.held' : 'concentration.lost', {
                    name: rolledName ?? t('resolution.unknownTarget'),
                    total: Number(rolled.total),
                    dc: Number(rolled.dc),
                  })
                : ''}
            </p>
            {rolled ? (
              <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-testid="concentration-dismiss" onClick={() => setDismissed(rolled)}>
                {t('concentration.dismiss')}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
