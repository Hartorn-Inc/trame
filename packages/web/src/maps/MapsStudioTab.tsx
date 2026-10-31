import { signal } from '@preact/signals';
import type { CampaignMapScene, StudioWallSegment, StagedToken, UserRole } from './types.ts';
import { toggleDoorState } from './domain.ts';
import { SceneAtlas } from './SceneAtlas.tsx';

export interface MapsStudioTabProps {
  campaignId: string;
  userRole: UserRole;
  initialScenes?: CampaignMapScene[];
  onActivateScene?: (scene: CampaignMapScene) => void;
  onSaveScene?: (scene: CampaignMapScene) => Promise<void>;
}

export function MapsStudioTab({
  campaignId,
  userRole,
  initialScenes = [],
  onActivateScene,
  onSaveScene,
}: MapsStudioTabProps) {
  if (userRole !== 'GM') {
    return <SceneAtlas campaignId={campaignId} scenes={initialScenes} />;
  }

  const scenesSignal = signal<CampaignMapScene[]>(initialScenes);
  const selectedSceneIdSignal = signal<string | null>(initialScenes[0]?.id ?? null);
  const isSavingSignal = signal<boolean>(false);

  const selectedScene = scenesSignal.value.find((s) => s.id === selectedSceneIdSignal.value) ?? null;

  const handleDoorToggle = (wallId: string) => {
    if (!selectedScene) return;
    const updatedWalls = selectedScene.walls.map((w) => (w.id === wallId ? toggleDoorState(w) : w));
    const updatedScene: CampaignMapScene = { ...selectedScene, walls: updatedWalls };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleAddStagedMonster = (templateKey: StagedToken['templateKey']) => {
    if (!selectedScene) return;
    const newToken: StagedToken = {
      id: `token-${Date.now()}`,
      name: templateKey,
      templateKey,
      x: selectedScene.spawnPoint.x + 20,
      y: selectedScene.spawnPoint.y + 20,
      elevationFt: 0,
      visibilityChannel: 'GmHidden',
      ownerUserId: null,
      hpCurrent: 10,
      hpMax: 10,
    };
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      stagedTokens: [...selectedScene.stagedTokens, newToken],
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleToggleRevealed = () => {
    if (!selectedScene) return;
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      revealedToPlayers: !selectedScene.revealedToPlayers,
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleSave = async () => {
    if (!selectedScene || !onSaveScene) return;
    isSavingSignal.value = true;
    try {
      await onSaveScene(selectedScene);
    } finally {
      isSavingSignal.value = false;
    }
  };

  return (
    <div class="maps-studio-tab" data-testid="maps-studio-tab" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--atlas-space-md)' }}>
      <header class="maps-studio-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--atlas-text-lg)' }}>Map Prep Studio</h2>
          <span class="atlas-tabular-nums" style={{ fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>Campaign: {campaignId}</span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--atlas-space-sm)' }}>
          <button
            type="button"
            data-testid="toggle-revealed-btn"
            onClick={handleToggleRevealed}
            style={{ padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', background: 'var(--atlas-surface-elevated)' }}
          >
            {selectedScene?.revealedToPlayers ? 'Revealed in Atlas' : 'Hidden from Atlas'}
          </button>
          <button
            type="button"
            data-testid="activate-scene-btn"
            disabled={!selectedScene}
            onClick={() => selectedScene && onActivateScene?.(selectedScene)}
            style={{ padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', background: 'var(--atlas-action)', color: 'var(--atlas-action-text)' }}
          >
            Activate Scene
          </button>
          <button
            type="button"
            data-testid="save-scene-btn"
            disabled={!selectedScene || isSavingSignal.value}
            onClick={handleSave}
            style={{ padding: 'var(--atlas-space-xs) var(--atlas-space-sm)' }}
          >
            {isSavingSignal.value ? 'Saving...' : 'Save Scene'}
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 'var(--atlas-space-md)', flex: 1, minHeight: 0 }}>
        <aside style={{ width: '240px', borderRight: '1px solid var(--atlas-border)', display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-sm)' }}>
          <h3>Scenes</h3>
          <ul data-testid="scenes-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {scenesSignal.value.map((scene) => (
              <li key={scene.id}>
                <button
                  type="button"
                  data-testid={`scene-item-${scene.id}`}
                  onClick={() => { selectedSceneIdSignal.value = scene.id; }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: 'var(--atlas-space-xs) var(--atlas-space-sm)',
                    fontWeight: scene.id === selectedSceneIdSignal.value ? 'bold' : 'normal',
                    background: scene.id === selectedSceneIdSignal.value ? 'var(--atlas-surface-elevated)' : 'transparent',
                  }}
                >
                  {scene.title}
                </button>
              </li>
            ))}
          </ul>

          <hr style={{ borderColor: 'var(--atlas-border)', margin: 'var(--atlas-space-sm) 0' }} />
          <h4>1-Click Templates</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-xs)' }}>
            {(['Goblin', 'Bandit', 'Guard', 'Skeleton', 'Wolf', 'Ogre', 'Boss'] as const).map((tmpl) => (
              <button
                key={tmpl}
                type="button"
                data-testid={`template-${tmpl}`}
                onClick={() => handleAddStagedMonster(tmpl)}
                style={{ textAlign: 'left', padding: 'var(--atlas-space-xs)' }}
              >
                + {tmpl} (Hidden)
              </button>
            ))}
          </div>
        </aside>

        <main data-testid="canvas-editor" style={{ flex: 1, border: '1px solid var(--atlas-border)', position: 'relative', overflow: 'hidden' }}>
          {selectedScene ? (
            <div style={{ padding: 'var(--atlas-space-md)' }}>
              <h4>Active Canvas: {selectedScene.title}</h4>
              <p>Walls: {selectedScene.walls.length} | Lights: {selectedScene.lights.length} | Staged Tokens: {selectedScene.stagedTokens.length}</p>
              <div data-testid="doors-list">
                {selectedScene.walls.filter((w) => w.wallType === 'Door').map((door) => (
                  <div key={door.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--atlas-space-sm)' }}>
                    <span>Door ({door.id}): {door.doorState?.isOpen ? 'Open' : 'Closed'}</span>
                    <button
                      type="button"
                      data-testid={`toggle-door-${door.id}`}
                      onClick={() => handleDoorToggle(door.id)}
                    >
                      Toggle Door
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>No scene selected</div>
          )}
        </main>
      </div>
    </div>
  );
}
