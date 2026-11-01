/**
 * ============================================================================
 * MAPS WORKSPACE TAB: PERSISTENCE, IMPORT & ACTIVATION (maps/MapsWorkspaceTab.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Binds the local scene editor (`MapsStudioTab`) and the player `SceneAtlas`
 * to the campaign server: loads scenes, saves edits, imports Universal VTT
 * files, uploads background images through the asset route, and activates a
 * scene on the live table.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Role-Filtered Read`:
 *    - `GET .../maps` is filtered by the server; players get the revealed
 *      scenes only and see the read-only atlas, never the editor.
 * 2. `Whole-List Save`:
 *    - `PUT .../maps` replaces every scene, so a save always sends the full
 *      list with the edited scene swapped in (or appended when new).
 * 3. `Save Before Activate`:
 *    - `ACTIVATE_SCENE` carries only the id; the server resolves the stored
 *      payload. The scene is saved first so unsaved edits (or a scene that
 *      only exists locally) are what the table loads.
 * 4. `Backgrounds Are Asset Keys`:
 *    - An uploaded image is stored as its object key in
 *      `background_image_url` (the same shape the UVTT import produces); the
 *      table presigns it at render time, so no expiring URL is persisted.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * mount -> `getMaps` -> editor keyed by `revision`
 * ├── import  -> `importMap` -> append scene -> `revision++`
 * ├── upload  -> `uploadAsset` -> set key on scene -> `saveMaps` -> `revision++`
 * ├── save    -> `saveMaps(all)`
 * └── activate -> `saveMaps(all)` -> WS `ACTIVATE_SCENE { scene_id }`
 * ============================================================================
 */
import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { Uuid } from '../api/wire.ts';
import { t } from '../i18n/index.ts';
import { activateScene } from '../table/commands.ts';
import { mapBackendSceneToFrontend, mapFrontendSceneToBackend } from './domain.ts';
import { MapsStudioTab } from './MapsStudioTab.tsx';
import { SceneAtlas } from './SceneAtlas.tsx';
import type { CampaignMapScene } from './types.ts';

const UVTT_ACCEPT = '.uvtt,.dd2vtt,application/json';
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

export interface MapsWorkspaceTabProps {
  campaignId: Uuid;
  client: ApiClient;
  isGm: boolean;
}

/** Returns `scenes` with `scene` replacing the entry of the same id, or appended. */
export function upsertScene(scenes: CampaignMapScene[], scene: CampaignMapScene): CampaignMapScene[] {
  return scenes.some((s) => s.id === scene.id) ? scenes.map((s) => (s.id === scene.id ? scene : s)) : [...scenes, scene];
}

/** Strips the extension from an uploaded file name for the default scene name. */
export function sceneNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || fileName;
}

export function MapsWorkspaceTab({ campaignId, client, isGm }: MapsWorkspaceTabProps) {
  const [scenes, setScenes] = useState<CampaignMapScene[]>([]);
  const [revision, setRevision] = useState(0);
  const [backgroundSceneId, setBackgroundSceneId] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .getMaps(campaignId)
      .then((raw) => {
        setScenes(raw.map(mapBackendSceneToFrontend));
        setRevision((r) => r + 1);
      })
      .catch(() => setError(t('mapsTab.loadFailed')));
  }, [client, campaignId]);

  const run = async (action: () => Promise<string>) => {
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const persist = async (next: CampaignMapScene[]) => {
    await client.saveMaps(campaignId, next.map(mapFrontendSceneToBackend));
    setScenes(next);
  };

  const saveScene = (scene: CampaignMapScene) =>
    run(async () => {
      await persist(upsertScene(scenes, scene));
      return t('mapsTab.saved', { name: scene.title });
    });

  const activate = (scene: CampaignMapScene) =>
    run(async () => {
      const stored = mapFrontendSceneToBackend(scene);
      const stable = { ...scene, id: String(stored.id) };
      await persist(upsertScene(scenes, stable));
      if (!client.submitCommand(activateScene(stable.id))) throw new Error(t('tray.offline'));
      return t('mapsTab.activated', { name: scene.title });
    });

  const importUvtt = (file: File) =>
    run(async () => {
      const raw = await client.importMap(campaignId, file, sceneNameFromFile(file.name));
      const scene = mapBackendSceneToFrontend(raw);
      setScenes((prev) => upsertScene(prev, scene));
      setRevision((r) => r + 1);
      return t('mapsTab.imported', { name: scene.title });
    });

  const uploadBackground = (file: File) =>
    run(async () => {
      const target = scenes.find((s) => s.id === backgroundSceneId);
      if (!target) throw new Error(t('mapsTab.pickScene'));
      const asset = await client.uploadAsset(campaignId, file, file.type || 'application/octet-stream');
      await persist(upsertScene(scenes, { ...target, backgroundImageUrl: asset.key }));
      setRevision((r) => r + 1);
      return t('mapsTab.backgroundSaved', { name: target.title });
    });

  if (!isGm) {
    return <SceneAtlas key={revision} campaignId={campaignId} scenes={scenes} />;
  }

  return (
    <div class="ds-stack" data-testid="maps-workspace">
      <section class="ds-panel ds-cluster" aria-labelledby="maps-assets-title">
        <h2 id="maps-assets-title" class="ds-panel-title">{t('mapsTab.assetsTitle')}</h2>
        <label class="ds-btn ds-btn-secondary">
          {t('mapsTab.importUvtt')}
          <input
            type="file"
            class="ds-visually-hidden"
            accept={UVTT_ACCEPT}
            data-testid="maps-import-uvtt"
            onChange={(e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) void importUvtt(file);
            }}
          />
        </label>
        <label class="ds-field-label" for="maps-background-scene">{t('mapsTab.backgroundScene')}</label>
        <select
          id="maps-background-scene"
          class="ds-input ds-input-compact"
          data-testid="maps-background-scene"
          value={backgroundSceneId}
          onChange={(e) => setBackgroundSceneId((e.target as HTMLSelectElement).value)}
        >
          <option value="">{t('mapsTab.pickScene')}</option>
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <label class="ds-btn ds-btn-secondary" aria-disabled={!backgroundSceneId}>
          {t('mapsTab.uploadBackground')}
          <input
            type="file"
            class="ds-visually-hidden"
            accept={IMAGE_ACCEPT}
            disabled={!backgroundSceneId}
            data-testid="maps-upload-background"
            onChange={(e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) void uploadBackground(file);
            }}
          />
        </label>
      </section>
      <p role="status" class="ds-meta" data-testid="maps-status">{status ?? ''}</p>
      {error ? <p role="alert" class="ds-field-error" data-testid="maps-error">{error}</p> : null}
      <MapsStudioTab
        key={revision}
        campaignId={campaignId}
        userRole="GM"
        initialScenes={scenes}
        onSaveScene={saveScene}
        onActivateScene={(scene) => void activate(scene)}
      />
    </div>
  );
}
