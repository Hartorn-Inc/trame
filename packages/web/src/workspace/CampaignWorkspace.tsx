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
 * 5. `Full Catalog`:
 *    - Both compendium views list `CompendiumResolver.getDefault()`, which
 *      `main.tsx` replaced with the full SRD 5.2.1 packs before the first
 *      render; a GM with a loaded table can spawn any monster from them.
 * 6. `Staged Spawns, Honest Announcements`:
 *    - A monster spawns hidden from players at the GM's selected cell, else
 *      at the board viewport centre (`spawnTopLeft`). The status line says
 *      "spawned" only once the token is in the projection (`CommandAccepted`)
 *      and reports a `SPAWN_TOKEN` rejection instead.
 * ============================================================================
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { CompendiumResolver, SRD_521_ATTRIBUTION } from '../../../game-systems/dnd5e/src/index.ts';
import { apiClient, type ApiClient } from '../api/client.ts';
import { selectedCellSignal, viewportCenterSignal } from '../api/session.ts';
import {
  CompendiumDrawer,
  monsterSpawnCommand,
  monsterStatBlockOf,
  type CompendiumEntry,
} from '../compendium/CompendiumDrawer.tsx';
import { HudDrawers } from '../hud/HudDrawers.tsx';
import { t, type MessageKey } from '../i18n/index.ts';
import { MapsWorkspaceTab } from '../maps/MapsWorkspaceTab.tsx';
import type { UserRole } from '../maps/types.ts';
import { TableTab } from '../table/TableTab.tsx';
import { spawnTopLeft, uniqueTokenName } from '../table/tableView.ts';
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

/** Spawn sent and not yet answered (invariant 6). */
interface PendingSpawn {
  tokenId: string;
  name: string;
  /** Highest `commandFeedback` id when the spawn was sent; newer `SPAWN_TOKEN` entries reject it. */
  feedbackFloor: number;
}

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
  const [spawnStatus, setSpawnStatus] = useState('');
  const [pendingSpawn, setPendingSpawn] = useState<PendingSpawn | null>(null);
  const isGm = userRole === 'GM';
  const compendium = useMemo(() => CompendiumResolver.getDefault().list(), []);
  const table = client.state.table.value;
  const feedback = client.state.commandFeedback.value;

  useEffect(() => {
    if (!pendingSpawn) return;
    const { tokenId, name, feedbackFloor } = pendingSpawn;
    if (table?.tokens?.[tokenId]) {
      setSpawnStatus(t('compendium.spawned', { name }));
      setPendingSpawn(null);
    } else if (feedback.some((f) => f.id > feedbackFloor && f.action === 'SPAWN_TOKEN')) {
      setSpawnStatus(t('compendium.spawnRejected', { name }));
      setPendingSpawn(null);
    }
  }, [table, feedback, pendingSpawn]);

  const spawnMonster = (entry: CompendiumEntry) => {
    const statBlock = monsterStatBlockOf(entry);
    if (!statBlock) return;
    const name = uniqueTokenName(entry.name, table);
    const tokenId = crypto.randomUUID();
    const at = spawnTopLeft(table, selectedCellSignal.value, viewportCenterSignal.value);
    const feedbackFloor = Math.max(-1, ...feedback.map((f) => f.id));
    if (!client.submitCommand(monsterSpawnCommand(entry, statBlock, name, at, tokenId))) {
      setSpawnStatus(t('tray.offline'));
      return;
    }
    setSpawnStatus(t('compendium.spawning', { name }));
    setPendingSpawn({ tokenId, name, feedbackFloor });
  };
  const onSpawnMonster = isGm && table !== null ? spawnMonster : undefined;

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
            <CompendiumDrawer isOpen entries={compendium} systemId="dnd5e" onClose={() => setTab('table')} onSpawnMonster={onSpawnMonster} />
            <section class="ds-panel" aria-labelledby="srd-attribution-title" data-testid="srd-attribution">
              <h2 id="srd-attribution-title" class="ds-panel-title">{t('compendium.attributionTitle')}</h2>
              <p class="ds-meta" lang="en">{SRD_521_ATTRIBUTION}</p>
            </section>
          </div>
        )}
      </div>
      <p role="status" class="ds-meta" data-testid="workspace-spawn-status">{spawnStatus}</p>
      <HudDrawers
        campaignId={campaignId}
        client={client}
        isTableCanvasMounted={tab === 'table'}
        compendiumEntries={compendium}
        onSpawnMonster={onSpawnMonster}
      />
    </div>
  );
}
