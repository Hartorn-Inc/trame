/**
 * ============================================================================
 * SELECTED TOKEN VITALS: DAMAGE & HEAL CONTROLS (table/TokenVitalsPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Shows the selected token's health and lets whoever controls it apply raw
 * damage (`APPLY_DAMAGE`) or healing (`HEAL_ACTOR`). The engine resolves
 * temporary hit points, resistance, concentration, and death saves, then
 * syncs the linked actor sheet (ADR-0037).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Controlled Tokens Only`:
 *    - Controls render for tokens in the recipient's `tokens` map (GM: all;
 *      player: owned). Public tokens show their health tier only.
 * 2. `Positive Integers`:
 *    - The amount is a whole number `>= 1`; the buttons stay disabled
 *      otherwise, so a stray `0` or `-5` never reaches the engine.
 * 3. `Linked Sheet`:
 *    - "Open sheet" appears only when the token links an actor sheet the
 *      client has loaded; players only receive their own sheets.
 * ============================================================================
 */
import { useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import { selectedActorIdSignal, selectedTokenIdSignal } from '../api/session.ts';
import { isSheetDrawerOpenSignal } from '../hud/HudDrawers.tsx';
import { t } from '../i18n/index.ts';
import { applyDamage, healActor } from './commands.ts';
import { listTableTokens } from './tableView.ts';

export interface TokenVitalsPanelProps {
  client: ApiClient;
}

export function TokenVitalsPanel({ client }: TokenVitalsPanelProps) {
  const [amount, setAmount] = useState('');
  const token = listTableTokens(client.state.table.value).find((tok) => tok.id === selectedTokenIdSignal.value);
  if (!token) {
    return <p class="ds-hint" data-testid="vitals-none">{t('vitals.noSelection')}</p>;
  }

  const value = Number(amount);
  const valid = Number.isInteger(value) && value >= 1;
  const hasSheet = token.actorId !== null && client.state.actors.value[token.actorId] !== undefined;
  const submit = (kind: 'damage' | 'heal') => {
    if (!valid) return;
    client.submitCommand(kind === 'damage' ? applyDamage(token.id, value) : healActor(token.id, value));
    setAmount('');
  };

  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('vitals.title', { name: token.name })} data-testid="vitals-panel">
      <h3 class="ds-panel-title">{token.name}</h3>
      <p class="ds-value" data-testid="vitals-hp">
        {token.hp !== null && token.maxHp !== null
          ? t('vitals.hp', { hp: token.hp, max: token.maxHp, temp: token.tempHp ?? 0 })
          : t(`table.tier.${token.bloodied ?? 'UNHURT'}` as 'table.tier.UNHURT')}
      </p>
      {token.controlled ? (
        <div class="ds-cluster">
          <label class="ds-field-label" for="vitals-amount">{t('vitals.amount')}</label>
          <input
            id="vitals-amount"
            type="number"
            min={1}
            step={1}
            class="ds-input ds-input-compact"
            data-testid="vitals-amount"
            value={amount}
            onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
          />
          <button type="button" class="ds-btn ds-btn-danger" data-testid="vitals-damage" disabled={!valid} onClick={() => submit('damage')}>
            {t('vitals.damage')}
          </button>
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="vitals-heal" disabled={!valid} onClick={() => submit('heal')}>
            {t('vitals.heal')}
          </button>
        </div>
      ) : null}
      {hasSheet ? (
        <button
          type="button"
          class="ds-btn ds-btn-ghost"
          data-testid="vitals-open-sheet"
          onClick={() => {
            selectedActorIdSignal.value = token.actorId;
            isSheetDrawerOpenSignal.value = true;
          }}
        >
          {t('vitals.openSheet')}
        </button>
      ) : null}
    </section>
  );
}
