/**
 * ============================================================================
 * CAMPAIGN WORKSPACE: FIVE-TAB SHELL (workspace/CampaignWorkspace.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Desktop shell for an open campaign: Table, Maps, Actors, Documents, and
 * Compendium tabs, with the HUD drawers (sheet + compendium) layered on top
 * so a token click or "Open sheet" shows the stored sheet from any tab.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Role Comes From The Server`:
 *    - `userRole` is the campaign membership role from `GET /campaigns`; it
 *      only chooses which controls render. Every GM action is still checked
 *      by the server (REST routes and table commands).
 * 2. `One Tab Mounted`:
 *    - Only the active panel renders, so the board and its socket-driven
 *      children do not re-render behind the Maps editor.
 * 3. `WAI-ARIA Tabs`:
 *    - Roving `tabIndex`, Left/Right/Home/End move focus and selection, and
 *      each `tab` controls exactly one `tabpanel` by id.
 * 4. `Verbatim SRD Notice`:
 *    - The Compendium tab shows `SRD_521_ATTRIBUTION` unmodified (CC-BY-4.0
 *      requires the exact text), marked `lang="en"` inside a localized UI.
 * ============================================================================
 */
import { useState } from 'preact/hooks';
import { SRD_521_ATTRIBUTION, SYSTEM_SRD } from '../../../game-systems/dnd5e/src/index.ts';
import { apiClient, type ApiClient } from '../api/client.ts';
import { CompendiumDrawer } from '../compendium/CompendiumDrawer.tsx';
import { HudDrawers } from '../hud/HudDrawers.tsx';
import { t, type MessageKey } from '../i18n/index.ts';
import { MapsWorkspaceTab } from '../maps/MapsWorkspaceTab.tsx';
import type { UserRole } from '../maps/types.ts';
import { TableTab } from '../table/TableTab.tsx';
import { ActorsTab } from './ActorsTab.tsx';
import { CampaignDocumentsTab } from './CampaignDocumentsTab.tsx';

/** Workspace tabs, in display order. */
export const WORKSPACE_TABS = ['table', 'maps', 'actors', 'documents', 'compendium'] as const;
export type WorkspaceTabId = (typeof WORKSPACE_TABS)[number];

const TAB_LABEL: Record<WorkspaceTabId, MessageKey> = {
  table: 'workspace.tab.table',
  maps: 'workspace.tab.maps',
  actors: 'workspace.tab.actors',
  documents: 'workspace.tab.documents',
  compendium: 'workspace.tab.compendium',
};

export interface CampaignWorkspaceProps {
  campaignId: string;
  /** Caller's membership role in this campaign. */
  userRole: UserRole;
  /** REST + socket gateway; defaults to the app-wide client. */
  client?: ApiClient;
  /** Initially selected tab. */
  activeTab?: WorkspaceTabId;
}

/** Index of the tab reached from `index` by a tablist navigation key, or `null`. */
export function nextTabIndex(index: number, key: string, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function CampaignWorkspace({ campaignId, userRole, client = apiClient, activeTab = 'table' }: CampaignWorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTabId>(activeTab);
  const isGm = userRole === 'GM';

  const onTabKeyDown = (e: KeyboardEvent) => {
    const next = nextTabIndex(WORKSPACE_TABS.indexOf(tab), e.key, WORKSPACE_TABS.length);
    if (next === null) return;
    e.preventDefault();
    const id = WORKSPACE_TABS[next];
    setTab(id);
    (typeof document !== 'undefined' ? document.getElementById?.(`workspace-tab-${id}`) : null)?.focus();
  };

  return (
    <div class="ds-stack" data-testid="campaign-workspace">
      <div class="ds-tablist" role="tablist" aria-label={t('workspace.tabsLabel')} onKeyDown={onTabKeyDown}>
        {WORKSPACE_TABS.map((id) => (
          <button
            key={id}
            id={`workspace-tab-${id}`}
            type="button"
            role="tab"
            class="ds-tab"
            aria-selected={tab === id}
            aria-controls={`workspace-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            data-testid={`workspace-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
      </div>
      <div
        id={`workspace-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`workspace-tab-${tab}`}
        data-testid={`workspace-panel-${tab}`}
      >
        {tab === 'table' && <TableTab campaignId={campaignId} client={client} isGm={isGm} />}
        {tab === 'maps' && <MapsWorkspaceTab campaignId={campaignId} client={client} isGm={isGm} />}
        {tab === 'actors' && <ActorsTab campaignId={campaignId} client={client} isGm={isGm} />}
        {tab === 'documents' && <CampaignDocumentsTab campaignId={campaignId} client={client} isGm={isGm} />}
        {tab === 'compendium' && (
          <div class="ds-stack">
            <CompendiumDrawer isOpen entries={SYSTEM_SRD} systemId="dnd5e" onClose={() => setTab('table')} />
            <section class="ds-panel" aria-labelledby="srd-attribution-title" data-testid="srd-attribution">
              <h2 id="srd-attribution-title" class="ds-panel-title">{t('compendium.attributionTitle')}</h2>
              <p class="ds-meta" lang="en">{SRD_521_ATTRIBUTION}</p>
            </section>
          </div>
        )}
      </div>
      <HudDrawers campaignId={campaignId} client={client} isTableCanvasMounted={tab === 'table'} compendiumEntries={SYSTEM_SRD} />
    </div>
  );
}
