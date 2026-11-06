/**
 * ============================================================================
 * SELECTED TOKEN VITALS: DAMAGE, HEALING, CONCENTRATION & DEATH SAVING THROWS
 * (table/TokenVitalsPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Shows the selected token's health and lets whoever controls it apply typed
 * damage (`APPLY_DAMAGE` with `damage_type` and `is_critical`) or healing
 * (`HEAL_ACTOR`), toggle concentration (`SET_CONCENTRATION`) and roll death
 * saving throws (`RECORD_DEATH_SAVE`). The engine resolves affinities,
 * temporary hit points, concentration and the SRD death saving throw counters,
 * then syncs the linked actor sheet (ADR-0037); this panel only asks.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Controlled Tokens Only`:
 *    - Controls render for tokens in the recipient's `tokens` map (GM: all;
 *      player: owned). Public tokens show their health tier only.
 * 2. `Positive Integers`:
 *    - The amount is a whole number `>= 1`; the buttons stay disabled
 *      otherwise, so a stray `0` or `-5` never reaches the engine.
 * 3. `Typed Damage`:
 *    - The damage type defaults to untyped; a typed hit lets the engine apply
 *      the token's resistances, immunities and vulnerabilities. Critical adds
 *      two death saving throw failures instead of one at 0 HP.
 * 4. `Server-Rolled Death Saving Throws`:
 *    - "Roll death saving throw" sends `d20: null` so the server rolls; only
 *      the GM may enter a physical die (`1..=20`). Counters, stability and
 *      death come back from the projection; nothing is computed here.
 * 5. `Linked Sheet`:
 *    - "Open sheet" appears only when the token links an actor sheet the
 *      client has loaded; players only receive their own sheets.
 * ============================================================================
 */
import { useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import { selectedActorIdSignal, selectedTokenIdSignal } from '../api/session.ts';
import { isSheetDrawerOpenSignal } from '../hud/HudDrawers.tsx';
import { t, type MessageKey } from '../i18n/index.ts';
import { applyDamage, DAMAGE_TYPES, healActor, recordDeathSave, setConcentration, type DamageType } from './commands.ts';
import { deathSavePhase, listTableTokens, type TableToken } from './tableView.ts';

export interface TokenVitalsPanelProps {
  client: ApiClient;
  /** Game Master view: enables the physical die entry for death saving throws. */
  isGm?: boolean;
}

function DeathSaves({ client, token, isGm }: { client: ApiClient; token: TableToken; isGm: boolean }) {
  const [die, setDie] = useState('');
  const phase = deathSavePhase(token);
  if (phase === 'conscious' || phase === 'unknown') return null;
  const dieValue = Number(die);
  const dieValid = Number.isInteger(dieValue) && dieValue >= 1 && dieValue <= 20;
  return (
    <div class="ds-stack-sm" data-testid="vitals-death-saves">
      <p class="ds-value" data-testid="vitals-death-state" aria-live="polite">
        {t(`vitals.deathState.${phase}` as MessageKey)}
      </p>
      <p class="ds-hint" data-testid="vitals-death-counters">
        {t('vitals.deathCounters', { successes: token.deathSaves.successes, failures: token.deathSaves.failures })}
      </p>
      {phase === 'dying' && token.controlled ? (
        <div class="ds-cluster">
          <button
            type="button"
            class="ds-btn ds-btn-secondary"
            data-testid="vitals-death-roll"
            onClick={() => client.submitCommand(recordDeathSave(token.id))}
          >
            {t('vitals.deathRoll')}
          </button>
          {isGm ? (
            <>
              <label class="ds-field-label" for="vitals-death-die">{t('vitals.deathDie')}</label>
              <input
                id="vitals-death-die"
                type="number"
                min={1}
                max={20}
                step={1}
                class="ds-input ds-input-compact"
                data-testid="vitals-death-die"
                value={die}
                onInput={(e) => setDie((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="ds-btn ds-btn-ghost"
                data-testid="vitals-death-record"
                disabled={!dieValid}
                onClick={() => {
                  client.submitCommand(recordDeathSave(token.id, dieValue));
                  setDie('');
                }}
              >
                {t('vitals.deathRecord')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TokenVitalsPanel({ client, isGm = false }: TokenVitalsPanelProps) {
  const [amount, setAmount] = useState('');
  const [damageType, setDamageType] = useState<DamageType | ''>('');
  const [critical, setCritical] = useState(false);
  const token = listTableTokens(client.state.table.value).find((tok) => tok.id === selectedTokenIdSignal.value);
  if (!token) {
    return <p class="ds-hint" data-testid="vitals-none">{t('vitals.noSelection')}</p>;
  }

  const value = Number(amount);
  const valid = Number.isInteger(value) && value >= 1;
  const hasSheet = token.actorId !== null && client.state.actors.value[token.actorId] !== undefined;
  const submit = (kind: 'damage' | 'heal') => {
    if (!valid) return;
    client.submitCommand(
      kind === 'damage' ? applyDamage(token.id, value, { damageType: damageType || null, critical }) : healActor(token.id, value),
    );
    setAmount('');
    setCritical(false);
  };

  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('vitals.title', { name: token.name })} data-testid="vitals-panel">
      <h3 class="ds-panel-title">{token.name}</h3>
      {token.statBlockName ? (
        <p class="ds-hint" data-testid="vitals-stat-block">{t('vitals.statBlock', { name: token.statBlockName })}</p>
      ) : null}
      <p class="ds-value" data-testid="vitals-hp">
        {token.hp !== null && token.maxHp !== null
          ? t('vitals.hp', { hp: token.hp, max: token.maxHp, temp: token.tempHp ?? 0 })
          : t(`table.tier.${token.bloodied ?? 'UNHURT'}` as 'table.tier.UNHURT')}
      </p>
      {token.controlled ? (
        <>
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
            <label class="ds-field-label" for="vitals-damage-type">{t('vitals.damageType')}</label>
            <select
              id="vitals-damage-type"
              class="ds-input"
              data-testid="vitals-damage-type"
              value={damageType}
              onChange={(e) => setDamageType((e.target as HTMLSelectElement).value as DamageType | '')}
            >
              <option value="">{t('vitals.damageUntyped')}</option>
              {DAMAGE_TYPES.map((type) => (
                <option key={type} value={type}>{t(`damage.type.${type}` as MessageKey)}</option>
              ))}
            </select>
            <button
              type="button"
              class="ds-btn ds-btn-ghost"
              data-testid="vitals-critical"
              aria-pressed={critical ? 'true' : 'false'}
              onClick={() => setCritical(!critical)}
            >
              {t('vitals.critical')}
            </button>
          </div>
          <div class="ds-cluster">
            <button type="button" class="ds-btn ds-btn-danger" data-testid="vitals-damage" disabled={!valid} onClick={() => submit('damage')}>
              {t('vitals.damage')}
            </button>
            <button type="button" class="ds-btn ds-btn-secondary" data-testid="vitals-heal" disabled={!valid} onClick={() => submit('heal')}>
              {t('vitals.heal')}
            </button>
            <button
              type="button"
              class="ds-btn ds-btn-ghost"
              data-testid="vitals-concentration"
              aria-pressed={token.concentrating ? 'true' : 'false'}
              onClick={() => client.submitCommand(setConcentration(token.id, !token.concentrating))}
            >
              {token.concentrating ? t('vitals.concentrationEnd') : t('vitals.concentrationStart')}
            </button>
          </div>
        </>
      ) : null}
      <DeathSaves client={client} token={token} isGm={isGm} />
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
