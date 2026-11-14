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
 *      is a sentence. Advantage / disadvantage sources (`ROLL_MODE_RULES`)
 *      are listed by condition and rule (`effectLabel`), never by raw id.
 * 5. `Exhaustion Level On The Sheet`:
 *    - The stepper (0..`MAX_EXHAUSTION_LEVEL`) updates exhaustion on the
 *      token's linked actor sheet through `applyExhaustion`, where the DAG
 *      turns it into `-2 * level` on d20 tests, `-5 ft * level` of Speed, and
 *      death (`isDead` / `deathSaves.isDead`) at `MAX_EXHAUSTION_LEVEL`.
 *      Moving off 0 adds the `exhaustion` condition and returning to 0 removes
 *      it, so the token and the sheet never disagree. Tokens without a loaded
 *      sheet only get the condition toggle.
 * ============================================================================
 */
import { signal } from '@preact/signals';
import type { ApiClient } from '../api/client.ts';
import { selectedTokenIdSignal } from '../api/session.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import {
  CONDITION_RULES,
  MAX_EXHAUSTION_LEVEL,
  ROLL_MODE_RULES,
  normalizeConditionId,
  resolveConditionEffects,
  type ConditionOverrideRuling,
  type ConditionRule,
} from '../../../game-systems/dnd5e/src/conditions.ts';
import {
  applyExhaustion,
  type Dnd5eActorData,
  type Dnd5eActorSheet,
} from '../../../game-systems/dnd5e/src/index.ts';
import { saveActorSheet } from '../sheet/sheetPersistence.ts';
import { conditionOverride, setTokenConditions, type ConditionOverrideMode, type ConditionOverrideSubject } from './commands.ts';
import { listTableTokens } from './tableView.ts';

/** SRD 5.2.1 condition ids offered by the picker. */
export const CONDITION_IDS: readonly string[] = Object.keys(CONDITION_RULES);

/** The last exhaustion level change was not saved (version conflict or request error). */
const exhaustionSaveFailedSignal = signal(false);

export interface TokenConditionsPanelProps {
  client: ApiClient;
  /** Campaign of the table; the exhaustion stepper saves the linked actor sheet in it. */
  campaignId?: string;
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

/** `"Poisoned: disadvantage on its attack rolls"` for a `"<condition>.<rule>"` effect id. */
export function effectLabel(id: string): string {
  const [condition, rule] = id.split('.');
  if (!rule) return t('conditions.effectId', { id });
  return t('conditions.effectLabel', {
    condition: t(`conditions.name.${condition}` as MessageKey),
    rule: t(`conditions.rule.${rule}` as MessageKey),
  });
}

function ExhaustionStepper(props: { level: number; onChange: (level: number) => void }) {
  const { level } = props;
  return (
    <div class="ds-cluster" role="group" aria-label={t('conditions.exhaustion.group')} data-testid="exhaustion-stepper">
      <span class="ds-field-label">{t('conditions.exhaustion.label')}</span>
      <button
        type="button"
        class="ds-btn ds-btn-ghost ds-btn-sm"
        data-testid="exhaustion-decrease"
        aria-label={t('conditions.exhaustion.decrease')}
        disabled={level <= 0}
        onClick={() => props.onChange(level - 1)}
      >
        −
      </button>
      <output class="atlas-tabular-nums" data-testid="exhaustion-level" aria-live="polite">
        {t('conditions.exhaustion.value', { level, max: MAX_EXHAUSTION_LEVEL })}
      </output>
      <button
        type="button"
        class="ds-btn ds-btn-ghost ds-btn-sm"
        data-testid="exhaustion-increase"
        aria-label={t('conditions.exhaustion.increase')}
        disabled={level >= MAX_EXHAUSTION_LEVEL}
        onClick={() => props.onChange(level + 1)}
      >
        +
      </button>
    </div>
  );
}

/** Reads the actor's exhaustion level (`0..=MAX_EXHAUSTION_LEVEL`), or `null` when no sheet is loaded. */
function readActorExhaustion(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  if ('attributes' in data && data.attributes && typeof data.attributes === 'object') {
    const raw = (data.attributes as { exhaustion?: unknown }).exhaustion;
    return Math.min(MAX_EXHAUSTION_LEVEL, Math.max(0, Number(raw ?? 0) || 0));
  }
  if ('exhaustionLevel' in data && typeof (data as { exhaustionLevel?: unknown }).exhaustionLevel === 'number') {
    const raw = (data as { exhaustionLevel: number }).exhaustionLevel;
    return Math.min(MAX_EXHAUSTION_LEVEL, Math.max(0, Number(raw) || 0));
  }
  return null;
}

/**
 * Routes a target exhaustion `level` (`0..=MAX_EXHAUSTION_LEVEL`) through `applyExhaustion`
 * so reaching level `6` sets `isDead: true` / `deathSaves.isDead: true` without losing fields.
 */
function applyActorExhaustionLevel(data: unknown, level: number): unknown {
  const target = Math.min(MAX_EXHAUSTION_LEVEL, Math.max(0, level));
  if (data && typeof data === 'object') {
    if ('attributes' in data && data.attributes && typeof data.attributes === 'object') {
      const current = Number((data.attributes as { exhaustion?: unknown }).exhaustion ?? 0) || 0;
      return applyExhaustion(data as Dnd5eActorData, target - current);
    }
    if ('exhaustionLevel' in data) {
      const current = Number((data as { exhaustionLevel?: unknown }).exhaustionLevel ?? 0) || 0;
      const next = applyExhaustion(data as Dnd5eActorSheet, target - current) as Dnd5eActorSheet & { isDead?: boolean };
      if ('isDead' in next && next.exhaustionLevel >= MAX_EXHAUSTION_LEVEL) {
        next.isDead = true;
      }
      return next;
    }
    return applyExhaustion(
      { ...(data as Record<string, unknown>), attributes: { exhaustion: 0 } } as unknown as Dnd5eActorData,
      target,
    );
  }
  return applyExhaustion({ attributes: { exhaustion: 0 } } as unknown as Dnd5eActorData, target);
}

export function TokenConditionsPanel({ client, campaignId, isGm = false }: TokenConditionsPanelProps) {
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

  const actor = token.actorId ? client.state.actors.value[token.actorId] : undefined;
  const exhaustion = readActorExhaustion(actor?.data);
  const setExhaustion = (level: number) => {
    if (!token.actorId || !campaignId) return;
    exhaustionSaveFailedSignal.value = false;
    const has = current.includes('exhaustion');
    saveActorSheet(client, campaignId, token.actorId, applyActorExhaustionLevel(actor?.data, level))
      .then((outcome) => {
        if (outcome.status !== 'saved') {
          exhaustionSaveFailedSignal.value = true;
          return;
        }
        if (level > 0 && !has) client.submitCommand(setTokenConditions(token.id, [...current, 'exhaustion']));
        if (level === 0 && has) client.submitCommand(setTokenConditions(token.id, current.filter((c) => c !== 'exhaustion')));
      })
      .catch(() => {
        exhaustionSaveFailedSignal.value = true;
      });
  };

  const summary: string[] = [];
  if (effects.speedZero) summary.push(t('conditions.effect.speedZero'));
  if (effects.incapacitated) summary.push(t('conditions.effect.incapacitated'));
  if (effects.autoFailSaves.length > 0) summary.push(t('conditions.effect.autoFailSaves'));
  if (effects.resistsAllDamage) summary.push(t('conditions.effect.resistAll'));
  for (const id of effects.activeEffects) {
    if (ROLL_MODE_RULES.has(id.split('.')[1] as ConditionRule)) summary.push(effectLabel(id));
  }
  if (effects.effectiveConditions.includes('exhaustion')) {
    if (!effects.exhaustionApplies) summary.push(t('conditions.effect.exhaustionSuspended'));
    else if (exhaustion) {
      summary.push(t('conditions.effect.exhaustionLevel', { level: exhaustion, penalty: 2 * exhaustion, speed: 5 * exhaustion }));
      if (exhaustion >= MAX_EXHAUSTION_LEVEL) summary.push(t('conditions.effect.exhaustionDeath'));
    } else summary.push(t('conditions.effect.exhaustion'));
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
      {token.controlled && exhaustion !== null ? <ExhaustionStepper level={exhaustion} onChange={setExhaustion} /> : null}
      {exhaustionSaveFailedSignal.value ? (
        <p class="ds-hint" role="alert" data-testid="exhaustion-save-failed">
          {t('conditions.exhaustion.saveFailed')}
        </p>
      ) : null}
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
              <span class="ds-field-label">{effectLabel(id)}</span>
              <RulingSelect
                testId={`ruling-effect-${id}`}
                label={t('conditions.rulingFor', { name: effectLabel(id) })}
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
