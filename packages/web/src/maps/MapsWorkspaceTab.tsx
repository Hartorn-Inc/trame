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
 * 2. `Whole-List Save With A Version`:
 *    - `PUT .../maps` replaces every scene, so a save always sends the full
 *      list with the edited scene swapped in (or appended when new).
 *    - The list carries one `version`; each save sends it as
 *      `expected_version`. A stale save (`409 VERSION_CONFLICT`) changes
 *      nothing and stops the action (no activation follows); the GM then
 *      reloads the latest list or overwrites it at `current_version`.
 *    - Import bumps the version on the server, so the list is re-read after
 *      every import instead of guessing the new version.
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
 * mount -> `getMaps` -> scenes + version, editor keyed by `revision`
 * ├── import  -> `importMap` -> `getMaps` (new version) -> `revision++`
 * ├── upload  -> `uploadAsset` -> set key on scene -> `saveMaps` -> `revision++`
 * ├── save    -> `saveMaps(all, version)` -> new version | conflict panel
 * ├── activate -> `saveMaps(all, version)` -> WS `ACTIVATE_SCENE { scene_id }`
 * └── conflict -> reload (`getMaps`) | overwrite (`saveMaps(pending, current_version)`)
 * ============================================================================
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, VERSION_CONFLICT, type ApiClient } from '../api/client.ts';
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

/** A save rejected as stale: the server's version and the list that was not saved. */
export class SceneConflict extends Error {
  constructor(
    /** Server's scene-list version, when reported. */
    readonly currentVersion: number | null,
    /** Full scene list the GM tried to save. */
    readonly pending: CampaignMapScene[],
  ) {
    super(VERSION_CONFLICT);
  }
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

  const [version, setVersion] = useState(0);
  const [conflict, setConflict] = useState<SceneConflict | null>(null);

  const reload = async () => {
    const maps = await client.getMaps(campaignId);
    setScenes(maps.scenes.map(mapBackendSceneToFrontend));
    setVersion(maps.version);
    setRevision((r) => r + 1);
  };

  useEffect(() => {
    reload().catch(() => setError(t('mapsTab.loadFailed')));
  }, [client, campaignId]);

  const run = async (action: () => Promise<string>) => {
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setStatus(null);
      if (!(err instanceof SceneConflict)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const persist = async (next: CampaignMapScene[], expectedVersion = version) => {
    try {
      setVersion(await client.saveMaps(campaignId, next.map(mapFrontendSceneToBackend), expectedVersion));
    } catch (err) {
      if (!(err instanceof ApiError && err.code === VERSION_CONFLICT)) throw err;
      const current = err.body.current_version;
      const stale = new SceneConflict(typeof current === 'number' ? current : null, next);
      setConflict(stale);
      throw stale;
    }
    setScenes(next);
    setConflict(null);
  };

  const reloadLatest = () =>
    run(async () => {
      await reload();
      setConflict(null);
      return t('mapsTab.reloaded');
    });

  const overwrite = () =>
    run(async () => {
      if (!conflict) return '';
      const target = conflict.currentVersion ?? (await client.getMaps(campaignId)).version;
      await persist(conflict.pending, target);
      setRevision((r) => r + 1);
      return t('mapsTab.saved', { name: conflict.pending.map((s) => s.title).join(', ') });
    });

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
      await reload();
      return t('mapsTab.imported', { name: mapBackendSceneToFrontend(raw).title });
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
      {conflict ? (
        <div class="ds-panel ds-stack-sm" role="alert" data-testid="maps-version-conflict">
          <p class="ds-field-error">{t('mapsTab.conflict', { version: conflict.currentVersion ?? '?' })}</p>
          <div class="ds-cluster">
            <button type="button" class="ds-btn ds-btn-secondary" data-testid="maps-conflict-reload" onClick={() => void reloadLatest()}>
              {t('sheetHeader.conflict.reload')}
            </button>
            <button type="button" class="ds-btn ds-btn-danger" data-testid="maps-conflict-overwrite" onClick={() => void overwrite()}>
              {t('sheetHeader.conflict.overwrite')}
            </button>
          </div>
        </div>
      ) : null}
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
