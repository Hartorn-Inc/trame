import { useSignal } from '@preact/signals';
import type { CampaignMapScene, UserRole } from '../maps/types.ts';
import { mapBackendSceneToFrontend } from '../maps/domain.ts';
import { MapsStudioTab } from '../maps/MapsStudioTab.tsx';
import { SceneAtlas } from '../maps/SceneAtlas.tsx';

export interface CampaignWorkspaceProps {
  campaignId: string;
  userRole: UserRole;
  activeTab?: number;
  scenes?: CampaignMapScene[];
  onActivateScene?: (scene: CampaignMapScene) => void;
  onSaveScene?: (scene: CampaignMapScene) => Promise<void>;
}

export function CampaignWorkspace({
  campaignId,
  userRole,
  activeTab = 0,
  scenes = [],
  onActivateScene,
  onSaveScene,
}: CampaignWorkspaceProps) {
  let activeTabSignal: { value: number };
  try {
    activeTabSignal = useSignal<number>(activeTab);
  } catch {
    activeTabSignal = { value: activeTab };
  }

  const normalizedScenes = scenes.map((s) =>
    'walls' in s && Array.isArray((s as any).walls) ? (s as CampaignMapScene) : mapBackendSceneToFrontend(s),
  );

  const tabs = [
    { id: 0, label: 'Table' },
    { id: 1, label: 'Journal' },
    { id: 2, label: userRole === 'GM' ? 'Maps Studio' : 'Scene Atlas' },
  ];

  return (
    <div class="campaign-workspace" data-testid="campaign-workspace" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <nav
        class="workspace-tab-bar"
        role="tablist"
        aria-label="Campaign workspace tabs"
        style={{ display: 'flex', borderBottom: '1px solid var(--atlas-border)', gap: 'var(--atlas-space-sm)', padding: '0 var(--atlas-space-md)' }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTabSignal.value === tab.id}
            aria-controls={`tab-content-${tab.id}`}
            data-testid={`tab-${tab.id}`}
            onClick={() => { activeTabSignal.value = tab.id; }}
            style={{
              padding: 'var(--atlas-space-sm) var(--atlas-space-md)',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTabSignal.value === tab.id ? '2px solid var(--atlas-action)' : '2px solid transparent',
              fontWeight: activeTabSignal.value === tab.id ? 'bold' : 'normal',
              cursor: 'pointer',
              color: 'inherit',
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div class="workspace-tab-content" style={{ flex: 1, padding: 'var(--atlas-space-md)', minHeight: 0 }}>
        {activeTabSignal.value === 0 && (
          <div id="tab-content-0" role="tabpanel" aria-labelledby="tab-0" data-testid="tab-content-0">Table View</div>
        )}
        {activeTabSignal.value === 1 && (
          <div id="tab-content-1" role="tabpanel" aria-labelledby="tab-1" data-testid="tab-content-1">Journal View</div>
        )}
        {activeTabSignal.value === 2 && (
          <div id="tab-content-2" role="tabpanel" aria-labelledby="tab-2" style={{ height: '100%' }}>
            {userRole === 'GM' ? (
              <MapsStudioTab
                campaignId={campaignId}
                userRole={userRole}
                initialScenes={normalizedScenes}
                onActivateScene={onActivateScene}
                onSaveScene={onSaveScene}
              />
            ) : (
              <SceneAtlas
                campaignId={campaignId}
                scenes={normalizedScenes}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
