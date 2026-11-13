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
 *    - A visually-hidden polite status region (`pending-resolutions-count`)
 *      stays mounted even when `0` entries are pending so screen readers
 *      reliably announce `0 -> 1` and `1 -> 0` count transitions without
 *      losing focus on the board; the visible panel (`pending-resolutions`)
 *      remains absent when empty.
 * 3. `Attacker Attribution`:
 *    - Each entry resolves `attacker_token_id` against the visible table
 *      tokens to render `<attacker>: <action>`, falling back to `<action>`
 *      when no attacker token is present or known.
 * ============================================================================
 */
import { useRef } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { WirePendingResolution } from '../api/wire.ts';
import { t } from '../i18n/index.ts';
import { activeResolutionIdSignal } from './actionResolution.ts';
import { ResolutionReview } from './ResolutionReview.tsx';
import { listTableTokens } from './tableView.ts';

export interface PendingResolutionsPanelProps {
  /** Connected live-table API client supplying projected table state. */
  client: ApiClient;
  /** Whether the viewer holds the Game Master role on the active campaign. */
  isGm: boolean;
}

export function PendingResolutionsPanel({ client, isGm }: PendingResolutionsPanelProps) {
  const state = client.state.table.value;
  const active = activeResolutionIdSignal.value;
  const entries = Object.values(state?.pending_resolutions ?? {})
    .filter((resolution) => resolution.id !== active)
    .sort((a, b) => a.sequence - b.sequence);
  const tokenNames = new Map(
    listTableTokens(state)
      .filter((tok) => tok.name.trim() !== '')
      .map((tok) => [tok.id, tok.name]),
  );

  const hadEntriesRef = useRef(false);
  if (!state) {
    hadEntriesRef.current = false;
  } else if (entries.length > 0) {
    hadEntriesRef.current = true;
  }
  const countNotice = entries.length > 0 || hadEntriesRef.current ? t('resolution.pendingCount', { count: entries.length }) : '';

  const entryHeading = (resolution: WirePendingResolution): string => {
    const attacker = resolution.attacker_token_id ? tokenNames.get(resolution.attacker_token_id) : undefined;
    return attacker ? t('resolution.pendingAttacker', { attacker, action: resolution.action_name }) : resolution.action_name;
  };

  return (
    <>
      <p class="ds-visually-hidden" role="status" aria-live="polite" data-testid="pending-resolutions-count">
        {countNotice}
      </p>
      {entries.length > 0 ? (
        <section class="ds-panel ds-stack-sm" aria-label={t('resolution.pendingRegion')} data-testid="pending-resolutions">
          <h3 class="ds-panel-title">{t('resolution.pendingTitle')}</h3>
          <p class="ds-hint" aria-hidden="true">
            {t('resolution.pendingCount', { count: entries.length })}
          </p>
          {entries.map((resolution) => {
            const heading = entryHeading(resolution);
            return (
              <article key={resolution.id} class="ds-stack-sm" data-testid={`pending-${resolution.id}`} aria-label={heading}>
                <h4 class="ds-meta" data-testid={`pending-${resolution.id}-heading`}>{heading}</h4>
                <ResolutionReview client={client} isGm={isGm} resolution={resolution} testIdPrefix={`pending-${resolution.id}`} />
              </article>
            );
          })}
        </section>
      ) : null}
    </>
  );
}
