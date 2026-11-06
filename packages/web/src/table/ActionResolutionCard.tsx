/**
 * ============================================================================
 * ACTION RESOLUTION CARD (table/ActionResolutionCard.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * The table side of decision D6. When a sheet attack or spell, or a monster's
 * stat block action, is pending (`pendingActionSignal`), this card collects
 * its targets (board clicks or the checklist) or places its area (board click
 * or "centre on token", then `PROJECT_AOE`), asks the server to roll it with
 * `RESOLVE_ACTION`, and shows the server's `PendingResolution` for review and
 * the explicit Apply (`ResolutionReview`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server Rolls, Client Reviews`:
 *    - The card never rolls dice or compares numbers. A player attacking a
 *      monster sees hit / miss / critical and the damage, never its AC; an
 *      area shows success / failure per monster, never its save bonus.
 * 2. `Explicit Apply, Once`:
 *    - Rolling never touches HP; Apply references the resolution id, and the
 *      engine applies each target at most once (`ResolutionReview`).
 * 3. `Engine Targets For Areas`:
 *    - Area targets are the `affected_token_ids` of the engine's
 *      `AOE_PROJECTED` event for this template id, never a client guess.
 *      A concentration spell projects a persistent zone bound to the caster.
 * 4. `Keyboard Reachable, Announced`:
 *    - Every board gesture has a form control twin (target checklist,
 *      "centre on token" select); the heading takes focus when the card
 *      opens and again when the result arrives, and the outcome summary is a
 *      polite live region.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `ActionResolutionCard` (keyed by the pending template id)
 * ├── attack / monster: targets -> Roll -> `RESOLVE_ACTION`.
 * ├── area: place -> Project (`PROJECT_AOE`) -> `AOE_PROJECTED` -> `RESOLVE_ACTION`.
 * ├── `ACTION_RESOLVED` (projection) -> `ResolutionReview`.
 * └── Apply -> `APPLY_RESOLUTION` -> `cancelAction()`.
 * ============================================================================
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { Uuid, WirePendingResolution } from '../api/wire.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import {
  actionTargetIdsSignal,
  activeResolutionIdSignal,
  areaOriginSignal,
  areaProjectedSignal,
  areaTemplateIdSignal,
  attackerContext,
  buildActionRequest,
  cancelAction,
  newUuid,
  pendingActionSignal,
  pendingAreaTemplate,
  pendingResolvable,
  targetContext,
  targetRollMode,
  toggleActionTarget,
  type PendingAction,
  type ResolvableAction,
} from './actionResolution.ts';
import { projectAoe, resolveAction } from './commands.ts';
import { OUTCOME_KEYS, ResolutionReview } from './ResolutionReview.tsx';
import { boardMetrics } from './scene/tableScene.ts';
import { listTableTokens, type TableToken } from './tableView.ts';

export interface ActionResolutionCardProps {
  client: ApiClient;
  isGm: boolean;
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

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function actionSummary(action: ResolvableAction): string {
  if (action.attackBonus !== null) return t('resolution.attackBonus', { bonus: signed(action.attackBonus) });
  if (action.save) return t('resolution.save', { ability: action.save.ability.toUpperCase(), dc: action.save.dc });
  return t('resolution.autoHit');
}

/** One sentence for the live region: "Goblin: hit. Orc: miss." */
function outcomeAnnouncement(resolution: WirePendingResolution, names: Map<Uuid, string>): string {
  return resolution.targets
    .map((target) => `${names.get(target.token_id) || t('resolution.unknownTarget')}: ${t(OUTCOME_KEYS[target.outcome])}`)
    .join('. ');
}

function PendingActionCard({ client, isGm, pending }: ActionResolutionCardProps & { pending: PendingAction }) {
  const state = client.state.table.value;
  const tokens = listTableTokens(state);
  const sources = { state, tokens, sheets: client.state.actors.value };
  const action = pendingResolvable(sources, pending);
  const attacker = attackerContext(sources, pending);
  const { cellPx } = boardMetrics(state);
  const names = new Map(tokens.map((tok) => [tok.id, tok.name]));

  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [noneAffected, setNoneAffected] = useState(false);
  const [modeSources, setModeSources] = useState<Record<Uuid, string[]>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);
  const resolutionId = activeResolutionIdSignal.value;
  const events = client.state.lastEvents.value;
  const resolved =
    (resolutionId ? state?.pending_resolutions?.[resolutionId] : undefined) ??
    (events.find((ev) => ev.event === 'ACTION_RESOLVED' && (ev.resolution as WirePendingResolution | undefined)?.id === resolutionId)?.resolution as
      | WirePendingResolution
      | undefined);

  useEffect(() => headingRef.current?.focus(), [resolved !== undefined]);

  const feedback = client.state.commandFeedback.value;
  const feedbackSeen = useRef(feedback.length ? feedback[feedback.length - 1].id : -1);
  useEffect(() => {
    const rejected = feedback.find((f) => f.id > feedbackSeen.current && f.action === 'RESOLVE_ACTION');
    if (feedback.length) feedbackSeen.current = Math.max(feedbackSeen.current, ...feedback.map((f) => f.id));
    if (!rejected || resolved) return;
    setSent(false);
    activeResolutionIdSignal.value = null;
    setError(t('resolution.rejected'));
  }, [feedback]);

  const resolveFor = (targets: TableToken[]) => {
    if (!action) return;
    setSent(true);
    if (targets.length === 0) {
      setNoneAffected(true);
      return;
    }
    const contexts = targets.map((tok) => targetContext(sources, tok, attacker.tokenId));
    const id = newUuid();
    setModeSources(
      Object.fromEntries(
        contexts.map((target) => {
          const mode = targetRollMode(action, attacker, target);
          return [target.tokenId, mode.mode === 'advantage' ? mode.advantageSources : mode.disadvantageSources];
        }),
      ),
    );
    if (!client.submitCommand(resolveAction(buildActionRequest(action, attacker, contexts, id)))) {
      setSent(false);
      setError(t('resolution.offline'));
      return;
    }
    setError(null);
    activeResolutionIdSignal.value = id;
  };

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
      {t(sent ? 'resolution.close' : 'resolution.cancel')}
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
  const picking = !sent && pending.kind !== 'area';

  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('resolution.region')} data-testid="action-card" aria-busy={sent && !resolved ? 'true' : 'false'}>
      <h3 class="ds-panel-title" tabIndex={-1} ref={headingRef}>
        {t('resolution.title', { name: action.name })}
      </h3>
      <p class="ds-hint" data-testid="action-summary">{actionSummary(action)}</p>
      {action.secondarySave ? (
        <p class="ds-hint" data-testid="action-secondary-save">
          {t('resolution.secondarySave', { ability: action.secondarySave.ability.toUpperCase(), dc: action.secondarySave.dc })}
        </p>
      ) : null}
      {action.otherDamageTypes?.length ? (
        <p class="ds-hint" data-testid="action-other-damage">
          {t('resolution.otherDamage', { types: action.otherDamageTypes.map((type) => t(`damage.type.${type}` as MessageKey)).join(', ') })}
        </p>
      ) : null}

      {picking ? (
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
            disabled={targetIds.length === 0}
            onClick={() => resolveFor(tokens.filter((tok) => targetIds.includes(tok.id)))}
          >
            {t('resolution.roll')}
          </button>
        </fieldset>
      ) : null}

      {!sent && pending.kind === 'area' ? (
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
              <button type="button" class="ds-btn ds-btn-primary" data-testid="action-area-project" disabled={!template} onClick={project}>
                {t('resolution.project')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <p class="ds-hint" role="status" aria-live="polite" data-testid="action-status">
        {noneAffected ? t('resolution.noneAffected') : resolved ? outcomeAnnouncement(resolved, names) : sent ? t('resolution.rolling') : ''}
      </p>

      {resolved ? (
        <ResolutionReview client={client} isGm={isGm} resolution={resolved} testIdPrefix="action" modeSources={modeSources} onDone={cancelAction} />
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
