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
 * 3. `Announced Result`:
 *    - The last `CONCENTRATION_CHECK_ROLLED` result is a polite live region.
 * ============================================================================
 */
import { resolveSavingThrowMode } from '../../../game-systems/dnd5e/src/index.ts';
import type { ApiClient } from '../api/client.ts';
import type { Uuid } from '../api/wire.ts';
import { t } from '../i18n/index.ts';
import { rollConcentrationCheck } from './commands.ts';
import { listTableTokens } from './tableView.ts';

const WIRE_MODE = { normal: 'NORMAL', advantage: 'ADVANTAGE', disadvantage: 'DISADVANTAGE' } as const;

export interface ConcentrationCheckPromptProps {
  client: ApiClient;
}

export function ConcentrationCheckPrompt({ client }: ConcentrationCheckPromptProps) {
  const state = client.state.table.value;
  const checks = Object.entries(state?.pending_concentration_checks ?? {}).filter(([, dcs]) => dcs.length > 0);
  const tokens = listTableTokens(state);
  const rolled = [...client.state.lastEvents.value].reverse().find((ev) => ev.event === 'CONCENTRATION_CHECK_ROLLED');
  const rolledName = rolled ? tokens.find((tok) => tok.id === rolled.token_id)?.name : undefined;
  if (checks.length === 0 && !rolled) return null;

  const roll = (tokenId: Uuid) => {
    const token = tokens.find((tok) => tok.id === tokenId);
    const mode = token ? resolveSavingThrowMode({ conditions: token.conditions, overrides: token.conditionOverrides }, 'con').mode : 'normal';
    client.submitCommand(rollConcentrationCheck(tokenId, WIRE_MODE[mode]));
  };

  return (
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
      <p class="ds-hint" role="status" aria-live="polite" data-testid="concentration-result">
        {rolled
          ? t(rolled.success ? 'concentration.held' : 'concentration.lost', {
              name: rolledName ?? t('resolution.unknownTarget'),
              total: Number(rolled.total),
              dc: Number(rolled.dc),
            })
          : ''}
      </p>
    </section>
  );
}
