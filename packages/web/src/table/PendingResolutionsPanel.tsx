/**
 * ============================================================================
 * PENDING RESOLUTIONS LIST (table/PendingResolutionsPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lists every `PendingResolution` (ADR-0042) the viewer receives that the
 * resolution card is not showing: for the GM, every attack or area a player
 * rolled against monsters and left to the GM; for a player, their own
 * resolutions they closed before applying. Each entry offers Apply (and, for
 * the GM, adjust and Dismiss), so a resolution is never stranded.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Projection Is The List`:
 *    - Entries come from `pending_resolutions` of the projected state, which
 *      the room already filtered (GM: all; player: their own, with hidden
 *      rolls stripped), so this panel cannot widen what a player sees.
 * 2. `Announced, Not Focused`:
 *    - The count is a polite status region so the GM hears a new entry
 *      without losing focus on the board; the panel is absent when empty.
 * ============================================================================
 */
import type { ApiClient } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { activeResolutionIdSignal } from './actionResolution.ts';
import { ResolutionReview } from './ResolutionReview.tsx';

export interface PendingResolutionsPanelProps {
  client: ApiClient;
  isGm: boolean;
}

export function PendingResolutionsPanel({ client, isGm }: PendingResolutionsPanelProps) {
  const active = activeResolutionIdSignal.value;
  const entries = Object.values(client.state.table.value?.pending_resolutions ?? {})
    .filter((resolution) => resolution.id !== active)
    .sort((a, b) => a.sequence - b.sequence);
  if (entries.length === 0) return null;
  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('resolution.pendingRegion')} data-testid="pending-resolutions">
      <h3 class="ds-panel-title">{t('resolution.pendingTitle')}</h3>
      <p class="ds-hint" role="status" aria-live="polite" data-testid="pending-resolutions-count">
        {t('resolution.pendingCount', { count: entries.length })}
      </p>
      {entries.map((resolution) => (
        <article key={resolution.id} class="ds-stack-sm" data-testid={`pending-${resolution.id}`} aria-label={resolution.action_name}>
          <h4 class="ds-meta">{resolution.action_name}</h4>
          <ResolutionReview client={client} isGm={isGm} resolution={resolution} testIdPrefix={`pending-${resolution.id}`} />
        </article>
      ))}
    </section>
  );
}
