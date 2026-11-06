/**
 * ============================================================================
 * TOKEN CONDITIONS, GM RULINGS & AUTOMATED EFFECTS (table/TokenConditionsPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lets the controller of the selected token set its SRD conditions
 * (`SET_TOKEN_CONDITIONS`) and the Game Master rule on any condition or
 * automated effect (`CONDITION_OVERRIDE` FORCE / REMOVE / clear). It lists
 * the effects in force (Speed 0, Incapacitated, automatic STR/DEX saving
 * throw failures, resistance to all damage, exhaustion) as resolved by the
 * dnd5e `resolveConditionEffects`, which the engine mirrors to refuse moves
 * (`SpeedZero`) and reactions.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Permission Mirror`:
 *    - Condition toggles render for controlled tokens (GM: any token;
 *      player: owned). Rulings render for the GM only; the server refuses
 *      them from players anyway.
 * 2. `Whole-List Replace`:
 *    - Each toggle sends the full new condition list, so two quick toggles
 *      never race into a partial merge on the server.
 * 3. `Effects From Rulings`:
 *    - The effect list is computed from the projected conditions and
 *      `condition_overrides`, the same inputs the engine uses (parity test in
 *      `tests/engine/wasmParity.test.ts`).
 * 4. `Not Colour Alone`:
 *    - Active conditions are `aria-pressed` toggles with text; each effect
 *      is a sentence.
 * ============================================================================
 */
import type { ApiClient } from '../api/client.ts';
import { selectedTokenIdSignal } from '../api/session.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import {
  CONDITION_RULES,
  normalizeConditionId,
  resolveConditionEffects,
  type ConditionOverrideRuling,
} from '../../../game-systems/dnd5e/src/conditions.ts';
import { conditionOverride, setTokenConditions, type ConditionOverrideMode, type ConditionOverrideSubject } from './commands.ts';
import { listTableTokens } from './tableView.ts';

/** SRD 5.2.1 condition ids offered by the picker. */
export const CONDITION_IDS: readonly string[] = Object.keys(CONDITION_RULES);

export interface TokenConditionsPanelProps {
  client: ApiClient;
  isGm?: boolean;
}

function rulingOf(overrides: readonly ConditionOverrideRuling[], subject: ConditionOverrideSubject, id: string): ConditionOverrideMode {
  return overrides.find((o) => o.subject === subject && o.id === id)?.mode ?? null;
}

function RulingSelect(props: {
  testId: string;
  label: string;
  value: ConditionOverrideMode;
  onChange: (mode: ConditionOverrideMode) => void;
}) {
  return (
    <select
      class="ds-input ds-input-compact"
      data-testid={props.testId}
      aria-label={props.label}
      value={props.value ?? ''}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        props.onChange(raw === 'FORCE' || raw === 'REMOVE' ? raw : null);
      }}
    >
      <option value="">{t('conditions.ruling.none')}</option>
      <option value="FORCE">{t('conditions.ruling.FORCE')}</option>
      <option value="REMOVE">{t('conditions.ruling.REMOVE')}</option>
    </select>
  );
}

export function TokenConditionsPanel({ client, isGm = false }: TokenConditionsPanelProps) {
  const token = listTableTokens(client.state.table.value).find((tok) => tok.id === selectedTokenIdSignal.value);
  if (!token) return null;
  const current = token.conditions.map(normalizeConditionId);
  const effects = resolveConditionEffects({ conditions: current, overrides: token.conditionOverrides });
  const conditionName = (id: string) => t(`conditions.name.${id}` as MessageKey);
  const toggle = (id: string) => {
    const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
    client.submitCommand(setTokenConditions(token.id, next));
  };
  const rule = (subject: ConditionOverrideSubject, id: string, mode: ConditionOverrideMode) =>
    client.submitCommand(conditionOverride(token.id, subject, id, mode));

  const summary: string[] = [];
  if (effects.speedZero) summary.push(t('conditions.effect.speedZero'));
  if (effects.incapacitated) summary.push(t('conditions.effect.incapacitated'));
  if (effects.autoFailSaves.length > 0) summary.push(t('conditions.effect.autoFailSaves'));
  if (effects.resistsAllDamage) summary.push(t('conditions.effect.resistAll'));
  if (effects.effectiveConditions.includes('exhaustion')) {
    summary.push(effects.exhaustionApplies ? t('conditions.effect.exhaustion') : t('conditions.effect.exhaustionSuspended'));
  }
  const ruledEffects = isGm
    ? [...new Set([...effects.activeEffects, ...token.conditionOverrides.filter((o) => o.subject === 'EFFECT').map((o) => o.id)])]
    : [];

  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('conditions.title', { name: token.name })} data-testid="conditions-panel">
      <h3 class="ds-panel-title">{t('conditions.heading')}</h3>
      {token.controlled ? (
        <div class="ds-cluster" role="group" aria-label={t('conditions.picker')}>
          {CONDITION_IDS.map((id) => (
            <button
              key={id}
              type="button"
              class="ds-btn ds-btn-ghost ds-btn-sm"
              data-testid={`condition-${id}`}
              aria-pressed={current.includes(id) ? 'true' : 'false'}
              onClick={() => toggle(id)}
            >
              {conditionName(id)}
            </button>
          ))}
        </div>
      ) : (
        <p class="ds-hint" data-testid="conditions-readonly">
          {current.length > 0 ? current.map(conditionName).join(', ') : t('conditions.none')}
        </p>
      )}
      <ul class="ds-stack-sm" data-testid="conditions-effects" aria-label={t('conditions.effectsTitle')}>
        {summary.length > 0 ? summary.map((line) => <li key={line}>{line}</li>) : <li>{t('conditions.noEffects')}</li>}
      </ul>
      {isGm && token.controlled ? (
        <details class="ds-stack-sm" data-testid="conditions-rulings">
          <summary>{t('conditions.rulingsTitle')}</summary>
          {CONDITION_IDS.map((id) => (
            <div key={id} class="ds-cluster">
              <span class="ds-field-label">{conditionName(id)}</span>
              <RulingSelect
                testId={`ruling-condition-${id}`}
                label={t('conditions.rulingFor', { name: conditionName(id) })}
                value={rulingOf(token.conditionOverrides, 'CONDITION', id)}
                onChange={(mode) => rule('CONDITION', id, mode)}
              />
            </div>
          ))}
          {ruledEffects.map((id) => (
            <div key={id} class="ds-cluster">
              <span class="ds-field-label">{t('conditions.effectId', { id })}</span>
              <RulingSelect
                testId={`ruling-effect-${id}`}
                label={t('conditions.rulingFor', { name: id })}
                value={rulingOf(token.conditionOverrides, 'EFFECT', id)}
                onChange={(mode) => rule('EFFECT', id, mode)}
              />
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
