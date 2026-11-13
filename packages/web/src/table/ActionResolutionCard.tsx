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
 *    - The card keeps the last copy of its resolution, so when the GM applies
 *      or dismisses it from the pending list the result stays on screen as
 *      fully applied instead of falling back to "Rolling…".
 * 3. `Engine Targets For Areas`:
 *    - Area targets are the `affected_token_ids` of the engine's
 *      `AOE_PROJECTED` event for this template id, never a client guess.
 *      A concentration spell projects a persistent zone bound to the caster.
 *    - The only client-side removal is the caster of a cone, line or
 *      emanation: these start at the caster's centre, which the engine's
 *      centre-point test always counts, yet they never affect their caster.
 * 4. `Keyboard Reachable, Announced`:
 *    - Every board gesture has a form control twin (target checklist,
 *      "centre on token" select); the heading takes focus when the card
 *      opens and again when the result arrives, and the outcome summary is a
 *      polite live region.
 * 5. `Beams, Darts And Chosen Types`:
 *    - An action with several beams, darts or rays shows a count per checked
 *      target (all on the first one by default); Roll waits until every
 *      instance is aimed, then sends one request per beam or ray, or one per
 *      target for darts (`buildActionRequests`). The first result stays on
 *      the card, the others join the pending list.
 *    - A spell with alternative damage types (Spirit Guardians) shows a type
 *      picker; the picked type is the only type sent.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `ActionResolutionCard` (keyed by the pending template id)
 * ├── attack / monster: targets -> Roll -> `RESOLVE_ACTION`.
 * ├── area (spell, or monster action with an area):
 * │     place -> Project (`PROJECT_AOE`) -> `AOE_PROJECTED` -> `RESOLVE_ACTION`.
 * │     Refused roll -> Roll again (same engine targets) or Move area
 * │     (place and project again; the new `AOE_PROJECTED` gives the targets).
 * ├── `ACTION_RESOLVED` (projection) -> `ResolutionReview`.
 * └── Apply -> `APPLY_RESOLUTION` -> `cancelAction()`.
 * ============================================================================
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DamageType } from '../../../game-systems/dnd5e/src/index.ts';
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
  buildActionRequests,
  cancelAction,
  isAreaAction,
  newUuid,
  pendingActionSignal,
  pendingAreaTemplate,
  pendingResolvable,
  targetContext,
  targetRollMode,
  toggleActionTarget,
  type ExtraDamagePart,
  type PendingAction,
  type ResolvableAction,
} from './actionResolution.ts';
import { projectAoe, resolveAction } from './commands.ts';
import { OUTCOME_KEYS, ResolutionReview } from './ResolutionReview.tsx';
import { boardMetrics } from './scene/tableScene.ts';
import { listTableTokens, type TableToken } from './tableView.ts';

/**
 * Area shapes anchored on the caster's centre (`areaTemplate`): the engine's
 * centre-point test always counts the caster's own cell, but a cone, a line or
 * an emanation never affects its caster (invariant 3).
 */
const CASTER_EXCLUDED_SHAPES: ReadonlySet<string> = new Set(['cone', 'line', 'emanation']);

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

/** `"2d6 Poison"`, `"1d4+2 Fire"`, `"5 Cold"` for flat damage. */
function extraPartLabel(part: ExtraDamagePart): string {
  const expression = `${part.dice}${part.modifier ? signed(part.modifier) : ''}`.replace(/^\+/, '');
  return `${expression} ${t(`damage.type.${part.type}` as MessageKey)}`;
}

function actionSummary(action: ResolvableAction): string {
  if (action.attackBonus !== null) return t('resolution.attackBonus', { bonus: signed(action.attackBonus) });
  if (action.save) return t('resolution.save', { ability: action.save.ability.toUpperCase(), dc: action.save.dc });
  return t(action.rider ? 'resolution.rider' : 'resolution.autoHit');
}

/** Instances aimed at each checked target: the edited count, else all on the first target (invariant 5). */
function instanceCounts(targetIds: readonly Uuid[], edited: Readonly<Record<Uuid, number>>, total: number): Record<Uuid, number> {
  return Object.fromEntries(targetIds.map((id, i) => [id, edited[id] ?? (i === 0 ? total : 0)]));
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
  const [damageType, setDamageType] = useState<DamageType | null>(null);
  const [editedCounts, setEditedCounts] = useState<Record<Uuid, number>>({});
  const resolvable = pendingResolvable(sources, pending);
  const action = resolvable && damageType ? { ...resolvable, damageType } : resolvable;
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
  /** Last copy seen of the active resolution: it leaves the projection once applied or dismissed elsewhere (invariant 2). */
  const lastResolved = useRef<WirePendingResolution | undefined>(undefined);
  const seen =
    (resolutionId ? state?.pending_resolutions?.[resolutionId] : undefined) ??
    (events.find((ev) => ev.event === 'ACTION_RESOLVED' && (ev.resolution as WirePendingResolution | undefined)?.id === resolutionId)?.resolution as
      | WirePendingResolution
      | undefined);
  if (seen) lastResolved.current = seen;
  const resolved = resolutionId && lastResolved.current?.id === resolutionId ? lastResolved.current : undefined;

  useEffect(() => headingRef.current?.focus(), [resolved !== undefined]);

  const isArea = isAreaAction(pending);
  const templateId = areaTemplateIdSignal.value;
  const projected = areaProjectedSignal.value;
  /** Tokens the engine put in the projected area, kept so a refused roll can be sent again. */
  const [areaTargetIds, setAreaTargetIds] = useState<Uuid[] | null>(null);
  /** `lastEvents` already consumed for this projection; a re-projection ignores them. */
  const consumedEvents = useRef<unknown>(null);

  const feedback = client.state.commandFeedback.value;
  const feedbackSeen = useRef(feedback.length ? feedback[feedback.length - 1].id : -1);
  useEffect(() => {
    const fresh = feedback.filter((f) => f.id > feedbackSeen.current);
    if (feedback.length) feedbackSeen.current = Math.max(feedbackSeen.current, ...feedback.map((f) => f.id));
    if (fresh.some((f) => f.action === 'PROJECT_AOE' && f.kind !== 'notConnected') && isArea && areaTargetIds === null) {
      areaProjectedSignal.value = false;
      setError(t('resolution.projectRejected'));
      return;
    }
    if (!fresh.some((f) => f.action === 'RESOLVE_ACTION') || resolved) return;
    setSent(false);
    activeResolutionIdSignal.value = null;
    setError(t('resolution.rejected'));
  }, [feedback]);

  /** Rolls `targets`; `counts` aims beams, darts or rays per target (invariant 5). */
  const resolveFor = (targets: TableToken[], counts?: Readonly<Record<Uuid, number>>) => {
    if (!action) return;
    setSent(true);
    if (targets.length === 0) {
      setNoneAffected(true);
      return;
    }
    const contexts = targets.map((tok) => targetContext(sources, tok, attacker.tokenId));
    setModeSources(
      Object.fromEntries(
        contexts.map((target) => {
          const mode = targetRollMode(action, attacker, target);
          return [target.tokenId, mode.mode === 'advantage' ? mode.advantageSources : mode.disadvantageSources];
        }),
      ),
    );
    const allocations = contexts
      .map((target) => ({ target, count: counts?.[target.tokenId] ?? 1 }))
      .filter((allocation) => allocation.count > 0);
    const requests = buildActionRequests(action, attacker, allocations, newUuid);
    if (!requests.every((request) => client.submitCommand(resolveAction(request)))) {
      setSent(false);
      setError(t('resolution.offline'));
      return;
    }
    setError(null);
    activeResolutionIdSignal.value = requests[0].resolution_id;
  };

  useEffect(() => {
    if (!isArea || !projected || areaTargetIds !== null || !action || events === consumedEvents.current) return;
    const hit = events.find((ev) => ev.event === 'AOE_PROJECTED' && (ev.template as { id?: string } | undefined)?.id === templateId);
    if (!hit) return;
    consumedEvents.current = events;
    const ids = (hit.affected_token_ids as Uuid[] | undefined) ?? [];
    const excluded = action.area && CASTER_EXCLUDED_SHAPES.has(action.area.shape) ? attacker.tokenId : null;
    const targets = tokens.filter((tok) => ids.includes(tok.id) && tok.id !== excluded);
    setAreaTargetIds(targets.map((tok) => tok.id));
    resolveFor(targets);
  }, [events, projected]);

  /** After a refused roll: place and project the area again (the next `AOE_PROJECTED` gives the targets). */
  const moveArea = () => {
    consumedEvents.current = events;
    setAreaTargetIds(null);
    setNoneAffected(false);
    setError(null);
    areaProjectedSignal.value = false;
  };

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
  const template = isArea ? pendingAreaTemplate(state) : null;
  const project = () => {
    if (!template) return;
    setError(null);
    if (client.submitCommand(projectAoe(template, action.concentration))) areaProjectedSignal.value = true;
    else setError(t('resolution.offline'));
  };
  const picking = !sent && !isArea;
  const retryArea = !sent && isArea && areaTargetIds !== null;
  const instances = action.instances && action.instances.count > 1 ? action.instances : null;
  const counts = instances ? instanceCounts(targetIds, editedCounts, instances.count) : undefined;
  const aimed = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;

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
      {action.extraDamage?.length ? (
        <p class="ds-hint" data-testid="action-extra-damage">
          {t('resolution.extraDamage', { parts: action.extraDamage.map(extraPartLabel).join(', ') })}
        </p>
      ) : null}
      {instances ? (
        <p class="ds-hint" data-testid="action-instances">
          {t(`resolution.instances.${instances.unit}` as MessageKey, { count: instances.count })}
        </p>
      ) : null}
      {action.damageTypeOptions?.length && !sent ? (
        <div class="ds-stack-sm">
          <label class="ds-field-label" for="action-damage-type">{t('resolution.damageType')}</label>
          <select
            id="action-damage-type"
            class="ds-input"
            data-testid="action-damage-type"
            value={action.damageType ?? ''}
            onChange={(e) => setDamageType((e.target as HTMLSelectElement).value as DamageType)}
          >
            {action.damageTypeOptions.map((type) => (
              <option key={type} value={type}>{t(`damage.type.${type}` as MessageKey)}</option>
            ))}
          </select>
        </div>
      ) : null}

      {picking ? (
        <fieldset class="ds-stack-sm">
          <legend class="ds-field-label">{t('resolution.targets')}</legend>
          <p class="ds-hint">{t('resolution.pickTargets')}</p>
          {tokens
            .filter((tok) => tok.id !== attacker.tokenId)
            .map((tok) => (
              <div key={tok.id} class="ds-cluster">
                <label class="ds-cluster">
                  <input
                    type="checkbox"
                    data-testid={`action-target-${tok.id}`}
                    checked={targetIds.includes(tok.id)}
                    onChange={() => toggleActionTarget(tok.id)}
                  />
                  {tok.name}
                </label>
                {instances && counts && targetIds.includes(tok.id) ? (
                  <input
                    type="number"
                    class="ds-input"
                    min={0}
                    max={instances.count}
                    data-testid={`action-instances-${tok.id}`}
                    aria-label={t(`resolution.instancesAt.${instances.unit}` as MessageKey, { name: tok.name })}
                    value={counts[tok.id]}
                    onInput={(e) => {
                      const value = Math.max(0, Math.min(instances.count, Math.trunc(Number((e.target as HTMLInputElement).value) || 0)));
                      setEditedCounts({ ...editedCounts, [tok.id]: value });
                    }}
                  />
                ) : null}
              </div>
            ))}
          {instances && targetIds.length > 0 && aimed !== instances.count ? (
            <p class="ds-hint" role="status" data-testid="action-instances-left">
              {t(`resolution.instancesLeft.${instances.unit}` as MessageKey, { aimed, count: instances.count })}
            </p>
          ) : null}
          <button
            type="button"
            class="ds-btn ds-btn-primary"
            data-testid="action-roll"
            disabled={targetIds.length === 0 || (instances !== null && aimed !== instances.count)}
            onClick={() => resolveFor(tokens.filter((tok) => targetIds.includes(tok.id)), counts)}
          >
            {t('resolution.roll')}
          </button>
        </fieldset>
      ) : null}

      {retryArea ? (
        <div class="ds-cluster">
          <button
            type="button"
            class="ds-btn ds-btn-primary"
            data-testid="action-roll-again"
            onClick={() => resolveFor(tokens.filter((tok) => areaTargetIds.includes(tok.id)))}
          >
            {t('resolution.rollAgain')}
          </button>
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="action-area-move" onClick={moveArea}>
            {t('resolution.moveArea')}
          </button>
        </div>
      ) : null}

      {!sent && isArea && !retryArea ? (
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
