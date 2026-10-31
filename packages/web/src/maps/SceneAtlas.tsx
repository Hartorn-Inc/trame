import { useSignal } from '@preact/signals';
import type { CampaignMapScene } from './types.ts';
import { filterScenesForRole, mapBackendSceneToFrontend } from './domain.ts';
import { EmptyMapAtlasSvg } from '../components/icons/AtlasEmptyStates.tsx';

export interface SceneAtlasProps {
  campaignId: string;
  scenes: CampaignMapScene[];
  onSelectScene?: (scene: CampaignMapScene) => void;
}

export function SceneAtlas({ campaignId, scenes, onSelectScene }: SceneAtlasProps) {
  const normalizedScenes = scenes.map((s) =>
    'walls' in s && Array.isArray((s as any).walls) ? (s as CampaignMapScene) : mapBackendSceneToFrontend(s),
  );
  const filteredScenes = filterScenesForRole(normalizedScenes, 'PLAYER');
  let activePreviewSceneSignal: { value: CampaignMapScene | null };
  try {
    activePreviewSceneSignal = useSignal<CampaignMapScene | null>(null);
  } catch {
    activePreviewSceneSignal = { value: null };
  }

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
            <h3 style={{ margin: 0 }}>{activePreviewSceneSignal.value.title}</h3>
            <button
              type="button"
              data-testid="close-preview-btn"
              onClick={() => { activePreviewSceneSignal.value = null; }}
              style={{
                minHeight: '40px',
                padding: 'var(--atlas-space-xs) var(--atlas-space-sm)',
                background: 'var(--atlas-surface-raised)',
                color: 'var(--atlas-text)',
                border: '1px solid var(--atlas-border)',
                borderRadius: 'var(--atlas-radius-sm)',
                cursor: 'pointer',
              }}
            >
              Back to Gallery
            </button>
          </div>
          <div data-testid="atlas-map-canvas" style={{ width: '100%', height: '400px', background: 'var(--atlas-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span>Viewing {activePreviewSceneSignal.value.title} ({activePreviewSceneSignal.value.walls.length} visible walls)</span>
          </div>
        </div>
      ) : (
        <div data-testid="scene-atlas-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--atlas-space-md)' }}>
          {filteredScenes.length === 0 ? (
            <div data-testid="empty-atlas" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--atlas-space-lg)', color: 'var(--atlas-text-muted)', gridColumn: '1 / -1' }}>
              <EmptyMapAtlasSvg width={160} height={100} />
              <h3 style={{ margin: 'var(--atlas-space-sm) 0 0 0', color: 'var(--atlas-text)' }}>No maps revealed</h3>
              <p style={{ margin: 'var(--atlas-space-xs) 0 0 0', color: 'var(--atlas-text-muted)', fontSize: 'var(--atlas-text-xs)' }}>
                No maps revealed by GM yet.
              </p>
            </div>
          ) : (
            filteredScenes.map((scene) => (
              <button
                type="button"
                key={scene.id}
                class="atlas-card"
                data-testid={`atlas-card-${scene.id}`}
                onClick={() => {
                  activePreviewSceneSignal.value = scene;
                  onSelectScene?.(scene);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activePreviewSceneSignal.value = scene;
                    onSelectScene?.(scene);
                  }
                }}
                style={{
                  border: '1px solid var(--atlas-border)',
                  borderRadius: 'var(--atlas-radius-md)',
                  padding: 'var(--atlas-space-sm)',
                  cursor: 'pointer',
                  background: 'var(--atlas-surface-raised)',
                  textAlign: 'left',
                  color: 'inherit',
                  font: 'inherit',
                }}
              >
                <div style={{ height: '120px', background: 'var(--atlas-bg)', marginBottom: 'var(--atlas-space-xs)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>Map Thumbnail</span>
                </div>
                <h4 style={{ margin: 0, fontSize: 'var(--atlas-text-sm)' }}>{scene.title}</h4>
                <p style={{ margin: 0, fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>Dimensions: {scene.widthPx}x{scene.heightPx}</p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
