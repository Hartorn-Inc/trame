import { signal } from '@preact/signals';
import type { CampaignMapScene } from './types.ts';
import { filterScenesForRole } from './domain.ts';

export interface SceneAtlasProps {
  campaignId: string;
  scenes: CampaignMapScene[];
  onSelectScene?: (scene: CampaignMapScene) => void;
}

export function SceneAtlas({ campaignId, scenes, onSelectScene }: SceneAtlasProps) {
  const filteredScenes = filterScenesForRole(scenes, 'PLAYER');
  const activePreviewSceneSignal = signal<CampaignMapScene | null>(null);

  return (
    <div class="scene-atlas" data-testid="scene-atlas" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--atlas-space-md)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--atlas-text-lg)' }}>Scene Atlas</h2>
          <span class="atlas-tabular-nums" style={{ fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>Campaign: {campaignId}</span>
        </div>
      </header>

      {activePreviewSceneSignal.value ? (
        <div data-testid="scene-atlas-preview" style={{ flex: 1, border: '1px solid var(--atlas-border)', padding: 'var(--atlas-space-md)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--atlas-space-md)' }}>
            <h3>{activePreviewSceneSignal.value.title}</h3>
            <button
              type="button"
              data-testid="close-preview-btn"
              onClick={() => { activePreviewSceneSignal.value = null; }}
            >
              Back to Gallery
            </button>
          </div>
          <div data-testid="atlas-map-canvas" style={{ width: '100%', height: '400px', background: 'var(--atlas-surface-sunken)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span>Viewing {activePreviewSceneSignal.value.title} ({activePreviewSceneSignal.value.walls.length} visible walls)</span>
          </div>
        </div>
      ) : (
        <div data-testid="scene-atlas-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--atlas-space-md)' }}>
          {filteredScenes.length === 0 ? (
            <div data-testid="empty-atlas" style={{ color: 'var(--atlas-text-muted)' }}>No maps revealed by GM yet.</div>
          ) : (
            filteredScenes.map((scene) => (
              <div
                key={scene.id}
                data-testid={`atlas-card-${scene.id}`}
                onClick={() => {
                  activePreviewSceneSignal.value = scene;
                  onSelectScene?.(scene);
                }}
                style={{
                  border: '1px solid var(--atlas-border)',
                  borderRadius: 'var(--atlas-radius-md)',
                  padding: 'var(--atlas-space-sm)',
                  cursor: 'pointer',
                  background: 'var(--atlas-surface-elevated)',
                }}
              >
                <div style={{ height: '120px', background: 'var(--atlas-surface-sunken)', marginBottom: 'var(--atlas-space-xs)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>Map Thumbnail</span>
                </div>
                <h4 style={{ margin: 0, fontSize: 'var(--atlas-text-sm)' }}>{scene.title}</h4>
                <p style={{ margin: 0, fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>Dimensions: {scene.widthPx}x{scene.heightPx}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
