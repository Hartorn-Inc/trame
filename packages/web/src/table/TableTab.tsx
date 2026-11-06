/**
 * ============================================================================
 * LIVE TABLE TAB (table/TableTab.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Composes the live table: GM toolbar, combat tracker, reaction prompts,
 * board, selected-token vitals, conditions and cover suggestion, and dice
 * tray (the sheet/compendium drawers
 * are mounted by the workspace). Each child reads the session signals itself;
 * this module only lays them out.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Rejections Are Visible`:
 *    - Every `CommandRejected` is shown by the app-level
 *      `CommandFeedbackToasts` (named after the refused action), so a blocked
 *      move or an illegal command is explained on every tab.
 * 2. `Connection Gate`:
 *    - Before the first snapshot the tab shows a busy state instead of an
 *      empty board, so nobody acts on a table that is not loaded yet.
 * ============================================================================
 */
import type { ApiClient } from '../api/client.ts';
import { isCompendiumDrawerOpenSignal } from '../hud/HudDrawers.tsx';
import { t } from '../i18n/index.ts';
import { CombatTrackerBar } from './CombatTrackerBar.tsx';
import { DiceTray } from './DiceTray.tsx';
import { GmOverrideToolbar } from './GmOverrideToolbar.tsx';
import { ReactionBanner } from './ReactionBanner.tsx';
import { TableCanvas } from './TableCanvas.tsx';
import { CoverSuggestionPanel } from './CoverSuggestionPanel.tsx';
import { TokenConditionsPanel } from './TokenConditionsPanel.tsx';
import { TokenVitalsPanel } from './TokenVitalsPanel.tsx';

export interface TableTabProps {
  campaignId: string;
  client: ApiClient;
  isGm: boolean;
}

export function TableTab({ campaignId, client, isGm }: TableTabProps) {
  if (!client.state.table.value) {
    return (
      <p class="ds-hint" aria-busy="true" data-testid="table-loading">
        {t('table.loading')}
      </p>
    );
  }
  return (
    <div class="ds-table-layout" data-testid="table-tab">
      <div class="ds-stack-sm ds-table-main">
        <GmOverrideToolbar client={client} isGm={isGm} />
        <CombatTrackerBar client={client} isGm={isGm} />
        <ReactionBanner client={client} isGm={isGm} />
        <TableCanvas campaignId={campaignId} client={client} isGm={isGm} />
      </div>
      <aside class="ds-stack-sm ds-table-side" aria-label={t('table.sidebar')}>
        <TokenVitalsPanel client={client} isGm={isGm} />
        <TokenConditionsPanel client={client} isGm={isGm} />
        <CoverSuggestionPanel client={client} />
        <DiceTray client={client} />
        <button
          type="button"
          class="ds-btn ds-btn-secondary"
          data-testid="open-compendium"
          onClick={() => {
            isCompendiumDrawerOpenSignal.value = true;
          }}
        >
          {t('table.openCompendium')}
        </button>
      </aside>
    </div>
  );
}
