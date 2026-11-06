/**
 * ============================================================================
 * PENDING RESOLUTION REVIEW & APPLY (table/ResolutionReview.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Renders one server-held `PendingResolution` (ADR-0042): each target's
 * outcome, the roll when the viewer may see it, and the server-rolled damage,
 * with the explicit Apply of decision D6. The resolution card shows the one
 * it just rolled; the pending list shows every other one, so a resolution
 * left unapplied is never lost.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server Numbers Only`:
 *    - Outcomes, d20s, totals and damage come from the server. A target the
 *      viewer does not control arrives without d20s or total, so nothing
 *      here can reveal a monster's AC or save bonus.
 * 2. `Apply Exactly Once`:
 *    - Apply sends `APPLY_RESOLUTION`; the engine refuses a target already
 *      applied, so a double click or a retry after a partial failure never
 *      damages twice. Applied targets are read from the projection.
 * 3. `GM Adjusts, Issuer Applies As Rolled`:
 *    - Only the GM edits amounts, the critical flag and the damage type;
 *      edited targets are applied one by one with an adjustment. The issuer
 *      applies the rolled values for every remaining target.
 * ============================================================================
 */
import { useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { Uuid, WirePendingResolution, WireResolvedTarget, WireRollMode, WireTargetOutcome } from '../api/wire.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { applyResolution, DAMAGE_TYPES, dismissResolution, type DamageType } from './commands.ts';

export const OUTCOME_KEYS: Record<WireTargetOutcome, MessageKey> = {
  HIT: 'resolution.outcome.hit',
  CRITICAL: 'resolution.outcome.critical',
  MISS: 'resolution.outcome.miss',
  BLOCKED: 'resolution.outcome.blocked',
  SAVE_SUCCESS: 'resolution.outcome.success',
  SAVE_FAILURE: 'resolution.outcome.failure',
};

const MODE_KEYS: Partial<Record<WireRollMode, MessageKey>> = {
  ADVANTAGE: 'resolution.mode.advantage',
  DISADVANTAGE: 'resolution.mode.disadvantage',
};

/** Kept natural d20 of a target's roll (`null` without a visible roll). */
function keptD20(target: WireResolvedTarget): number | null {
  if (target.d20_rolls.length === 0) return null;
  if (target.roll_mode === 'ADVANTAGE') return Math.max(...target.d20_rolls);
  if (target.roll_mode === 'DISADVANTAGE') return Math.min(...target.d20_rolls);
  return target.d20_rolls[0];
}

function rollLine(target: WireResolvedTarget, sources: readonly string[] | undefined): string | null {
  const modeKey = MODE_KEYS[target.roll_mode];
  const mode = modeKey ? t(modeKey) : null;
  const withSources = mode && sources?.length ? t('resolution.modeSources', { mode, sources: sources.join(', ') }) : mode;
  if (target.total === null) return withSources;
  const natural = keptD20(target);
  const line = natural === null ? t('resolution.rollTotal', { total: target.total }) : t('resolution.rollLine', { total: target.total, natural });
  return withSources ? `${line}, ${withSources}` : line;
}

export interface ResolutionReviewProps {
  client: ApiClient;
  isGm: boolean;
  /** Latest known copy (the `ACTION_RESOLVED` payload or the projected entry). */
  resolution: WirePendingResolution;
  /** Prefix of every `data-testid` (`action` in the card, `pending-<id>` in the list). */
  testIdPrefix: string;
  /** Advantage / disadvantage sources computed locally, by target. */
  modeSources?: Readonly<Record<Uuid, readonly string[]>>;
  /** Called after Apply or Dismiss was sent. */
  onDone?: () => void;
}

/** Edits the GM made to one target before Apply. */
interface TargetEdit {
  damage: number;
  critical: boolean;
}

export function ResolutionReview({ client, isGm, resolution, testIdPrefix: p, modeSources, onDone }: ResolutionReviewProps) {
  const table = client.state.table.value;
  const projected = table?.pending_resolutions?.[resolution.id];
  // Gone from the projection: fully applied or dismissed elsewhere (invariant 2).
  const current = projected ?? { ...resolution, targets: resolution.targets.map((target) => ({ ...target, applied: true })) };
  const names = new Map(
    [...Object.values(table?.tokens ?? {}), ...Object.values(table?.public_tokens ?? {})].map((tok) => [tok.id, tok.name ?? '']),
  );
  const [edits, setEdits] = useState<Record<Uuid, TargetEdit>>(() =>
    Object.fromEntries(resolution.targets.map((target) => [target.token_id, { damage: target.damage, critical: target.is_critical }])),
  );
  const [damageType, setDamageType] = useState<string>(resolution.damage_type ?? '');
  const [error, setError] = useState<string | null>(null);
  const remaining = current.targets.filter((target) => !target.applied);
  const typeLabel = (type: string) => (type ? t(`damage.type.${type}` as MessageKey) : t('resolution.untyped'));

  const send = (commands: ReturnType<typeof applyResolution>[]) => {
    for (const command of commands) {
      if (!client.submitCommand(command)) {
        setError(t('resolution.offline'));
        return;
      }
    }
    onDone?.();
  };

  const apply = () => {
    const typeChanged = damageType !== (current.damage_type ?? '');
    const edited = (target: WireResolvedTarget) => {
      const edit = edits[target.token_id];
      return edit !== undefined && (edit.damage !== target.damage || edit.critical !== target.is_critical);
    };
    if (!isGm || (!typeChanged && !remaining.some(edited))) {
      send([applyResolution(current.id)]);
      return;
    }
    send(
      remaining.map((target) => {
        const edit = edits[target.token_id] ?? { damage: target.damage, critical: target.is_critical };
        return applyResolution(current.id, target.token_id, {
          damage: edit.damage !== target.damage ? edit.damage : null,
          damage_type: typeChanged ? damageType : null,
          is_critical: edit.critical !== target.is_critical ? edit.critical : null,
        });
      }),
    );
  };

  const edit = (tokenId: Uuid, change: Partial<TargetEdit>) =>
    setEdits((prev) => ({ ...prev, [tokenId]: { ...(prev[tokenId] ?? { damage: 0, critical: false }), ...change } }));

  return (
    <div class="ds-stack-sm">
      <ul class="ds-stack-sm" aria-label={t('resolution.results')}>
        {current.targets.map((target) => {
          const name = names.get(target.token_id) || t('resolution.unknownTarget');
          const line = rollLine(target, modeSources?.[target.token_id]);
          const editable = isGm && !target.applied;
          const value = edits[target.token_id] ?? { damage: target.damage, critical: target.is_critical };
          return (
            <li key={target.token_id} class="ds-stack-sm" data-testid={`${p}-result-${target.token_id}`}>
              <p class="ds-value">
                <strong>{name}</strong>: <span data-testid={`${p}-outcome-${target.token_id}`}>{t(OUTCOME_KEYS[target.outcome])}</span>
                {line ? <span class="ds-hint"> ({line})</span> : null}
              </p>
              {editable ? (
                <div class="ds-cluster">
                  <label class="ds-cluster">
                    <span class="ds-field-label">{t('resolution.damageFor', { name })}</span>
                    <input
                      type="number"
                      min={0}
                      class="ds-input ds-input-compact"
                      data-testid={`${p}-damage-${target.token_id}`}
                      value={String(value.damage)}
                      onInput={(e) => edit(target.token_id, { damage: Math.max(0, Math.trunc(Number((e.target as HTMLInputElement).value) || 0)) })}
                    />
                  </label>
                  <label class="ds-cluster">
                    <input
                      type="checkbox"
                      data-testid={`${p}-critical-${target.token_id}`}
                      checked={value.critical}
                      onChange={(e) => edit(target.token_id, { critical: (e.target as HTMLInputElement).checked })}
                    />
                    {t('resolution.critical')}
                  </label>
                </div>
              ) : (
                <p class="ds-value" data-testid={`${p}-damage-${target.token_id}`}>
                  {t('resolution.damageValue', { damage: target.damage })}
                  {target.applied && target.damage > 0 ? ` (${t('resolution.applied')})` : ''}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {isGm && remaining.length > 0 ? (
        <>
          <label class="ds-field-label" for={`${p}-damage-type`}>{t('resolution.damageType')}</label>
          <select
            id={`${p}-damage-type`}
            class="ds-input"
            data-testid={`${p}-damage-type`}
            value={damageType}
            onChange={(e) => setDamageType((e.target as HTMLSelectElement).value as DamageType | '')}
          >
            <option value="">{t('resolution.untyped')}</option>
            {DAMAGE_TYPES.map((type) => (
              <option key={type} value={type}>{typeLabel(type)}</option>
            ))}
          </select>
        </>
      ) : (
        <p class="ds-hint" data-testid={`${p}-damage-type`}>
          {t('resolution.damageTypeValue', { type: typeLabel(current.damage_type ?? '') })}
        </p>
      )}
      {remaining.length === 0 ? <p class="ds-hint" data-testid={`${p}-nothing-left`}>{t('resolution.nothingToApply')}</p> : null}
      <div class="ds-cluster">
        <button type="button" class="ds-btn ds-btn-primary" data-testid={`${p}-apply`} disabled={remaining.length === 0} onClick={apply}>
          {t('resolution.apply')}
        </button>
        {isGm && remaining.length > 0 ? (
          <button type="button" class="ds-btn ds-btn-ghost" data-testid={`${p}-dismiss`} onClick={() => send([dismissResolution(current.id)])}>
            {t('resolution.dismiss')}
          </button>
        ) : null}
      </div>
      {error ? (
        <p class="ds-field-error" role="alert" data-testid={`${p}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
