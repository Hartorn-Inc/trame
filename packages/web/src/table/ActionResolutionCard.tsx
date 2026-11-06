/**
 * ============================================================================
 * ACTION RESOLUTION CARD (table/ActionResolutionCard.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * The table side of decision D6. When a sheet attack or spell is pending
 * (`pendingActionSignal`), this card collects its targets (board clicks or the
 * checklist) or places its area (board click or "centre on token", then
 * `PROJECT_AOE`), rolls through the server, and shows each target's outcome
 * and damage for review. Only an explicit Apply sends `APPLY_DAMAGE` with the
 * damage type and the critical flag, so a misclick never changes HP.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Explicit Apply`:
 *    - Rolling never touches HP. Apply is disabled while any outcome is
 *      `unknown` (hidden AC or save bonus); the user rules it with buttons.
 * 2. `GM Adjusts, Server Decides Affinity`:
 *    - The GM can edit every amount and the damage type before Apply; the
 *      server derives resistance, vulnerability and immunity from the type.
 * 3. `Room Authority`:
 *    - A player's Apply is sent only for tokens they control (the room
 *      refuses the rest); other targets say the GM applies them, and every
 *      roll is public in the dice log so the GM sees the numbers.
 * 4. `Engine Targets For Areas`:
 *    - Area targets are the `affected_token_ids` of the engine's
 *      `AOE_PROJECTED` event for this template id, never a client guess.
 *      A concentration spell projects a persistent zone bound to the caster.
 * 5. `Keyboard Reachable`:
 *    - Every board gesture has a form control twin (target checklist,
 *      "centre on token" select); the heading takes focus when the card
 *      opens so keyboard users land on it.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `ActionResolutionCard` (keyed by the pending template id)
 * ├── attack: targets -> Roll -> `resolveTargets` -> review.
 * ├── area:   place -> Project (`PROJECT_AOE`) -> `AOE_PROJECTED` -> `resolveTargets`.
 * ├── review: rule unknown outcomes, GM edits amounts / type.
 * └── Apply -> `APPLY_DAMAGE` per applicable target -> `cancelAction()`.
 * ============================================================================
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { Uuid } from '../api/wire.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import {
  actionTargetIdsSignal,
  areaOriginSignal,
  areaProjectedSignal,
  areaTemplateIdSignal,
  attackerContext,
  cancelAction,
  deriveSheet,
  isReadyToApply,
  pendingActionSignal,
  pendingAreaTemplate,
  resolvableFor,
  resolveTargets,
  restDiceRoller,
  ruleAttack,
  ruleSave,
  targetContext,
  toggleActionTarget,
  type DiceRoller,
  type PendingAction,
  type ResolvableAction,
  type TargetResolution,
} from './actionResolution.ts';
import { applyDamage, DAMAGE_TYPES, projectAoe, type DamageType } from './commands.ts';
import { boardMetrics } from './scene/tableScene.ts';
import { listTableTokens, type TableToken } from './tableView.ts';

export interface ActionResolutionCardProps {
  campaignId: Uuid;
  client: ApiClient;
  isGm: boolean;
  /** Dice roller; defaults to public REST rolls (tests inject a scripted one). */
  roller?: DiceRoller;
}

/** Renders the card while an action is pending; a new action remounts it with fresh state. */
export function ActionResolutionCard(props: ActionResolutionCardProps) {
  const pending = pendingActionSignal.value;
  if (!pending) return null;
  return <PendingActionCard key={areaTemplateIdSignal.value} pending={pending} {...props} />;
}

function tokenCenter(token: TableToken, cellPx: number) {
  return { x: token.topLeft.x + (token.gridW * cellPx) / 2, y: token.topLeft.y + (token.gridH * cellPx) / 2 };
}

function outcomeLabel(result: TargetResolution): string {
  return t(`resolution.outcome.${result.outcome}` as MessageKey);
}

function rollLine(result: TargetResolution): string | null {
  if (result.total === null) return null;
  const line = result.natural === null ? t('resolution.rollTotal', { total: result.total }) : t('resolution.rollLine', { total: result.total, natural: result.natural });
  if (result.mode === 'normal') return line;
  const sources = result.mode === 'advantage' ? result.advantageSources : result.disadvantageSources;
  const mode = t(`resolution.mode.${result.mode}` as MessageKey);
  return `${line}, ${sources.length ? t('resolution.modeSources', { mode, sources: sources.join(', ') }) : mode}`;
}

function actionSummary(action: ResolvableAction): string {
  if (action.attackBonus !== null) return t('resolution.attackBonus', { bonus: action.attackBonus >= 0 ? `+${action.attackBonus}` : String(action.attackBonus) });
  if (action.save) return t('resolution.save', { ability: action.save.ability.toUpperCase(), dc: action.save.dc });
  return t('resolution.autoHit');
}

function PendingActionCard({ campaignId, client, isGm, roller, pending }: ActionResolutionCardProps & { pending: PendingAction }) {
  const state = client.state.table.value;
  const tokens = listTableTokens(state);
  const sheets = client.state.actors.value;
  const derived = deriveSheet(sheets[pending.actorId]?.data);
  const action = derived ? resolvableFor(pending, derived) : null;
  const roll = roller ?? restDiceRoller(client, campaignId);
  const sources = { state, tokens, sheets };
  const attacker = attackerContext(sources, pending.actorId);
  const { cellPx } = boardMetrics(state);

  const [results, setResults] = useState<TargetResolution[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [damageType, setDamageType] = useState<DamageType | ''>((action?.damageType as DamageType | null) ?? '');
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headingRef.current?.focus(), []);

  const run = async (work: () => Promise<TargetResolution[]>) => {
    setBusy(true);
    setError(null);
    try {
      setResults(await work());
    } catch {
      setError(t('resolution.rollFailed'));
    } finally {
      setBusy(false);
    }
  };

  const resolveFor = (targets: TableToken[]) => {
    if (!action) return;
    void run(() => resolveTargets(action, attacker, targets.map((tok) => targetContext(sources, tok, attacker.tokenId)), roll));
  };

  const events = client.state.lastEvents.value;
  const templateId = areaTemplateIdSignal.value;
  const projected = areaProjectedSignal.value;
  const areaResolved = useRef(false);
  useEffect(() => {
    if (pending.kind !== 'area' || !projected || areaResolved.current || !action) return;
    const hit = events.find((ev) => ev.event === 'AOE_PROJECTED' && (ev.template as { id?: string } | undefined)?.id === templateId);
    if (!hit) return;
    areaResolved.current = true;
    const ids = (hit.affected_token_ids as Uuid[] | undefined) ?? [];
    const excluded = action.area?.shape === 'emanation' ? attacker.tokenId : null;
    resolveFor(tokens.filter((tok) => ids.includes(tok.id) && tok.id !== excluded));
  }, [events, projected]);

  const close = (
    <button type="button" class="ds-btn ds-btn-ghost" data-testid="action-cancel" onClick={cancelAction}>
      {t(results ? 'resolution.close' : 'resolution.cancel')}
    </button>
  );

  if (!action) {
    return (
      <section class="ds-panel ds-stack-sm" aria-label={t('resolution.region')} data-testid="action-card">
        <p class="ds-hint" role="status">{t('resolution.unavailable')}</p>
        {close}
      </section>
    );
  }

  const targetIds = actionTargetIdsSignal.value;
  const template = pending.kind === 'area' ? pendingAreaTemplate(state) : null;
  const project = () => {
    if (!template) return;
    if (client.submitCommand(projectAoe(template, action.concentration))) areaProjectedSignal.value = true;
    else setError(t('resolution.offline'));
  };

  const canApplyTo = (tokenId: Uuid) => isGm || tokens.some((tok) => tok.id === tokenId && tok.controlled);
  const applicable = (results ?? []).filter((r) => r.damage > 0 && canApplyTo(r.tokenId));
  const apply = () => {
    for (const r of applicable) {
      if (!client.submitCommand(applyDamage(r.tokenId, r.damage, { damageType: damageType || null, critical: r.critical }))) {
        setError(t('resolution.offline'));
        return;
      }
    }
    cancelAction();
  };

  const update = (next: TargetResolution) => setResults((prev) => (prev ?? []).map((r) => (r.tokenId === next.tokenId ? next : r)));
  const ruleUnknown = (result: TargetResolution, outcome: 'hit' | 'critical' | 'miss' | 'success' | 'failure') => {
    if (outcome === 'success' || outcome === 'failure') {
      update(ruleSave(result, outcome, action));
      return;
    }
    setBusy(true);
    ruleAttack(result, outcome, action, roll)
      .then(update)
      .catch(() => setError(t('resolution.rollFailed')))
      .finally(() => setBusy(false));
  };

  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('resolution.region')} data-testid="action-card" aria-busy={busy ? 'true' : 'false'}>
      <h3 class="ds-panel-title" tabIndex={-1} ref={headingRef}>
        {t('resolution.title', { name: action.name })}
      </h3>
      <p class="ds-hint" data-testid="action-summary">{actionSummary(action)}</p>

      {!results && pending.kind === 'attack' ? (
        <fieldset class="ds-stack-sm">
          <legend class="ds-field-label">{t('resolution.targets')}</legend>
          <p class="ds-hint">{t('resolution.pickTargets')}</p>
          {tokens
            .filter((tok) => tok.id !== attacker.tokenId)
            .map((tok) => (
              <label key={tok.id} class="ds-cluster">
                <input
                  type="checkbox"
                  data-testid={`action-target-${tok.id}`}
                  checked={targetIds.includes(tok.id)}
                  onChange={() => toggleActionTarget(tok.id)}
                />
                {tok.name}
              </label>
            ))}
          <button
            type="button"
            class="ds-btn ds-btn-primary"
            data-testid="action-roll"
            disabled={busy || targetIds.length === 0}
            onClick={() => resolveFor(tokens.filter((tok) => targetIds.includes(tok.id)))}
          >
            {t('resolution.roll')}
          </button>
        </fieldset>
      ) : null}

      {!results && pending.kind === 'area' ? (
        <div class="ds-stack-sm">
          <p class="ds-hint" data-testid="action-area-hint" role="status">
            {projected ? t('resolution.waiting') : template ? t('resolution.areaPlaced') : t('resolution.placeArea')}
          </p>
          {!projected ? (
            <>
              <label class="ds-field-label" for="action-area-token">{t('resolution.placeOn')}</label>
              <select
                id="action-area-token"
                class="ds-input"
                data-testid="action-area-token"
                value=""
                onChange={(e) => {
                  const tok = tokens.find((x) => x.id === (e.target as HTMLSelectElement).value);
                  if (tok) areaOriginSignal.value = tokenCenter(tok, cellPx);
                }}
              >
                <option value="">{t('resolution.placeNone')}</option>
                {tokens.map((tok) => (
                  <option key={tok.id} value={tok.id}>{tok.name}</option>
                ))}
              </select>
              <button type="button" class="ds-btn ds-btn-primary" data-testid="action-area-project" disabled={!template || busy} onClick={project}>
                {t('resolution.project')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {busy ? <p class="ds-hint" role="status">{t('resolution.rolling')}</p> : null}

      {results ? (
        <div class="ds-stack-sm">
          {results.length === 0 ? <p class="ds-hint" data-testid="action-none-affected">{t('resolution.noneAffected')}</p> : null}
          <ul class="ds-stack-sm" aria-label={t('resolution.results')}>
            {results.map((r) => {
              const line = rollLine(r);
              const unknownChoices: Array<'hit' | 'critical' | 'miss' | 'success' | 'failure'> =
                r.outcome !== 'unknown' ? [] : action.attackBonus !== null ? ['hit', 'critical', 'miss'] : ['success', 'failure'];
              return (
                <li key={r.tokenId} class="ds-stack-sm" data-testid={`action-result-${r.tokenId}`}>
                  <p class="ds-value">
                    <strong>{r.name}</strong>: <span data-testid={`action-outcome-${r.tokenId}`}>{outcomeLabel(r)}</span>
                    {line ? <span class="ds-hint"> ({line})</span> : null}
                  </p>
                  {unknownChoices.length ? (
                    <div class="ds-cluster" role="group" aria-label={t('resolution.ruleFor', { name: r.name })}>
                      {unknownChoices.map((choice) => (
                        <button
                          key={choice}
                          type="button"
                          class="ds-btn ds-btn-secondary ds-btn-sm"
                          data-testid={`action-rule-${r.tokenId}-${choice}`}
                          disabled={busy}
                          onClick={() => ruleUnknown(r, choice)}
                        >
                          {t(`resolution.outcome.${choice}` as MessageKey)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {isGm ? (
                    <label class="ds-cluster">
                      <span class="ds-field-label">{t('resolution.damageFor', { name: r.name })}</span>
                      <input
                        type="number"
                        min={0}
                        class="ds-input ds-input-compact"
                        data-testid={`action-damage-${r.tokenId}`}
                        value={String(r.damage)}
                        onInput={(e) => update({ ...r, damage: Math.max(0, Math.trunc(Number((e.target as HTMLInputElement).value) || 0)) })}
                      />
                    </label>
                  ) : (
                    <p class="ds-value" data-testid={`action-damage-${r.tokenId}`}>
                      {t('resolution.damageValue', { damage: r.damage })}
                    </p>
                  )}
                  {!canApplyTo(r.tokenId) && r.damage > 0 ? <p class="ds-hint">{t('resolution.gmApplies')}</p> : null}
                </li>
              );
            })}
          </ul>
          {isGm ? (
            <>
              <label class="ds-field-label" for="action-damage-type">{t('resolution.damageType')}</label>
              <select
                id="action-damage-type"
                class="ds-input"
                data-testid="action-damage-type"
                value={damageType}
                onChange={(e) => setDamageType((e.target as HTMLSelectElement).value as DamageType | '')}
              >
                <option value="">{t('resolution.untyped')}</option>
                {DAMAGE_TYPES.map((type) => (
                  <option key={type} value={type}>{t(`damage.type.${type}` as MessageKey)}</option>
                ))}
              </select>
            </>
          ) : (
            <p class="ds-hint" data-testid="action-damage-type">
              {t('resolution.damageTypeValue', { type: damageType ? t(`damage.type.${damageType}` as MessageKey) : t('resolution.untyped') })}
            </p>
          )}
          <button
            type="button"
            class="ds-btn ds-btn-primary"
            data-testid="action-apply"
            disabled={busy || !isReadyToApply(results) || applicable.length === 0}
            onClick={apply}
          >
            {t('resolution.apply')}
          </button>
        </div>
      ) : null}

      {error ? (
        <p class="ds-field-error" role="alert" data-testid="action-error">
          {error}
        </p>
      ) : null}
      {close}
    </section>
  );
}
