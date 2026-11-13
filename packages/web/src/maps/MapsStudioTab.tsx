import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { CampaignMapScene, StudioLightSource, AudioEmitterConfig, UserRole, WallType } from './types.ts';
import { CompendiumDrawer, type CompendiumEntry } from '../compendium/CompendiumDrawer.tsx';
import { QUICK_PICK_MONSTERS, SRD_MONSTER_PREFIX, srdMonsterEntries, stageSrdMonster } from './monsterStaging.ts';
import { applyTerrainBrush, cellAtPoint, hasCell, moveTerrainCursor, sceneGridSize } from './terrainBrush.ts';
import type { GridCell } from '../engine/wasmBridge.ts';
import { createStarterDungeonScene, generateEntityUuid, mapBackendSceneToFrontend, toggleDoorState } from './domain.ts';
import { SceneAtlas } from './SceneAtlas.tsx';
import { DARK_CANVAS_PALETTE, SHARED_WALL_KINDS, type CanonicalWallKind } from '../canvas/CanvasThemePalette.ts';
import type { Point2D } from '../engine/wasmBridge.ts';
import { session } from '../api/session.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { flipOneWay, scenePoint, snapToGridCorner, wallFromDrag } from './wallDrawing.ts';
import { glyphPath, wallGlyphs } from '../canvas/wallGlyphs.ts';

/** Studio canvas zoom bounds and step (the SVG is resized inside a scrolling viewport). */
const STUDIO_MIN_ZOOM = 1;
const STUDIO_MAX_ZOOM = 6;
const STUDIO_ZOOM_STEP = 1.5;

/**
 * Canvas tool: `walls` draws walls by dragging; `paint` / `erase` mark or clear
 * difficult-terrain cells (mouse drag, or arrow keys + Space on the focused canvas).
 */
export type StudioTool = 'walls' | 'paint' | 'erase';

const STUDIO_TOOL_LABEL_KEYS: Record<StudioTool, MessageKey> = {
  walls: 'maps.tool.walls',
  paint: 'maps.tool.paintTerrain',
  erase: 'maps.tool.eraseTerrain',
};

/** Wall being drawn by a canvas drag, in scene pixels. */
interface WallDrag {
  start: Point2D;
  end: Point2D;
}

const WALL_TYPE_LABEL_KEYS: Record<WallType, MessageKey> = {
  Normal: 'maps.wallType.normal',
  Window: 'maps.wallType.window',
  Terrain: 'maps.wallType.terrain',
  OneWay: 'maps.wallType.oneWay',
  Door: 'maps.wallType.door',
  SecretDoor: 'maps.wallType.secretDoor',
  Illusion: 'maps.wallType.illusion',
};

export interface MapsStudioTabProps {
  campaignId: string;
  /** Human-readable campaign title; resolved from session campaigns when omitted. */
  campaignName?: string;
  userRole: UserRole;
  initialScenes?: CampaignMapScene[];
  onActivateScene?: (scene: CampaignMapScene) => void;
  onSaveScene?: (scene: CampaignMapScene) => Promise<void>;
  /** Monster picker list; defaults to the SRD monsters of the installed compendium. */
  monsterEntries?: CompendiumEntry[];
}

export function MapsStudioTab({
  campaignId,
  campaignName,
  userRole,
  initialScenes = [],
  onActivateScene,
  onSaveScene,
  monsterEntries,
}: MapsStudioTabProps) {
  const pickerEntries = srdMonsterEntries(monsterEntries);
  const normalizedInitialScenes = initialScenes.map((s) =>
    'walls' in s && Array.isArray((s as any).walls) ? (s as CampaignMapScene) : mapBackendSceneToFrontend(s),
  );

  let scenesSignal: { value: CampaignMapScene[] };
  let selectedSceneIdSignal: { value: string | null };
  let isSavingSignal: { value: boolean };
  let wallTypeSignal: { value: WallType };
  let wallP1XSignal: { value: number };
  let wallP1YSignal: { value: number };
  let wallP2XSignal: { value: number };
  let wallP2YSignal: { value: number };
  let wallBottomFtSignal: { value: number };
  let wallTopFtSignal: { value: number };
  let lightXSignal: { value: number };
  let lightYSignal: { value: number };
  let lightRadiusFtSignal: { value: number };
  let audioXSignal: { value: number };
  let audioYSignal: { value: number };
  let audioClipUrlSignal: { value: string };
  let doorFeedbackSignal: { value: Record<string, string> };
  let wallDragSignal: { value: WallDrag | null };
  let studioZoomSignal: { value: number };
  let monsterPickerOpenSignal: { value: boolean };
  let stagingStatusSignal: { value: string };
  /** Picker toggle, where focus returns when the picker closes. */
  let pickerToggleRef: { current: HTMLButtonElement | null };
  let studioToolSignal: { value: StudioTool };
  let terrainCursorSignal: { value: GridCell };
  let terrainPaintingSignal: { value: boolean };

  try {
    studioToolSignal = useSignal<StudioTool>('walls');
    terrainCursorSignal = useSignal<GridCell>({ col: 0, row: 0 });
    terrainPaintingSignal = useSignal<boolean>(false);
    pickerToggleRef = useRef<HTMLButtonElement | null>(null);
    monsterPickerOpenSignal = useSignal<boolean>(false);
    stagingStatusSignal = useSignal<string>('');
    wallDragSignal = useSignal<WallDrag | null>(null);
    studioZoomSignal = useSignal<number>(1);
    scenesSignal = useSignal<CampaignMapScene[]>(normalizedInitialScenes);
    selectedSceneIdSignal = useSignal<string | null>(normalizedInitialScenes[0]?.id ?? null);
    isSavingSignal = useSignal<boolean>(false);
    wallTypeSignal = useSignal<WallType>('Normal');
    wallP1XSignal = useSignal<number>(0);
    wallP1YSignal = useSignal<number>(0);
    wallP2XSignal = useSignal<number>(100);
    wallP2YSignal = useSignal<number>(0);
    wallBottomFtSignal = useSignal<number>(0);
    wallTopFtSignal = useSignal<number>(10);
    lightXSignal = useSignal<number>(100);
    lightYSignal = useSignal<number>(100);
    lightRadiusFtSignal = useSignal<number>(30);
    audioXSignal = useSignal<number>(150);
    audioYSignal = useSignal<number>(150);
    audioClipUrlSignal = useSignal<string>('ambience.ogg');
    doorFeedbackSignal = useSignal<Record<string, string>>({});
  } catch {
    studioToolSignal = { value: 'walls' };
    terrainCursorSignal = { value: { col: 0, row: 0 } };
    terrainPaintingSignal = { value: false };
    pickerToggleRef = { current: null };
    monsterPickerOpenSignal = { value: false };
    stagingStatusSignal = { value: '' };
    wallDragSignal = { value: null };
    studioZoomSignal = { value: 1 };
    scenesSignal = { value: normalizedInitialScenes };
    selectedSceneIdSignal = { value: normalizedInitialScenes[0]?.id ?? null };
    isSavingSignal = { value: false };
    wallTypeSignal = { value: 'Normal' };
    wallP1XSignal = { value: 0 };
    wallP1YSignal = { value: 0 };
    wallP2XSignal = { value: 100 };
    wallP2YSignal = { value: 0 };
    wallBottomFtSignal = { value: 0 };
    wallTopFtSignal = { value: 10 };
    lightXSignal = { value: 100 };
    lightYSignal = { value: 100 };
    lightRadiusFtSignal = { value: 30 };
    audioXSignal = { value: 150 };
    audioYSignal = { value: 150 };
    audioClipUrlSignal = { value: 'ambience.ogg' };
    doorFeedbackSignal = { value: {} };
  }

  try {
    useEffect(() => {
      if (normalizedInitialScenes.length > 0 && scenesSignal.value.length === 0) {
        scenesSignal.value = normalizedInitialScenes;
        if (!selectedSceneIdSignal.value) {
          selectedSceneIdSignal.value = normalizedInitialScenes[0]?.id ?? null;
        }
      }
    }, [initialScenes]);
  } catch {
    if (normalizedInitialScenes.length > 0 && scenesSignal.value.length === 0) {
      scenesSignal.value = normalizedInitialScenes;
      if (!selectedSceneIdSignal.value) {
        selectedSceneIdSignal.value = normalizedInitialScenes[0]?.id ?? null;
      }
    }
  }

  if (userRole !== 'GM') {
    return <SceneAtlas campaignId={campaignId} campaignName={campaignName} scenes={initialScenes} />;
  }

  const resolvedCampaignName =
    campaignName?.trim() ||
    session.campaigns.value.find((c) => c.id === campaignId)?.name?.trim() ||
    '';
  const campaignLabelText = resolvedCampaignName
    ? t('maps.campaignLabel', { name: resolvedCampaignName })
    : t('maps.campaignUnnamed');

  const selectedScene = scenesSignal.value.find((s) => s.id === selectedSceneIdSignal.value) ?? null;

  const handleDoorToggle = (wallId: string) => {
    if (!selectedScene) return;
    const wall = selectedScene.walls.find((w) => w.id === wallId);
    if (wall?.wallType === 'Door' && wall.doorState?.isLocked) {
      doorFeedbackSignal.value = {
        ...doorFeedbackSignal.value,
        [wallId]: t('maps.door.lockedFeedback'),
      };
      return;
    }
    if (doorFeedbackSignal.value[wallId]) {
      const next = { ...doorFeedbackSignal.value };
      delete next[wallId];
      doorFeedbackSignal.value = next;
    }
    const updatedWalls = selectedScene.walls.map((w) => (w.id === wallId ? toggleDoorState(w) : w));
    const updatedScene: CampaignMapScene = { ...selectedScene, walls: updatedWalls };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleToggleDoorLock = (wallId: string) => {
    if (!selectedScene) return;
    const updatedWalls = selectedScene.walls.map((w) => {
      if (w.id === wallId && w.wallType === 'Door') {
        const current = w.doorState ?? { isOpen: false, isLocked: false };
        return {
          ...w,
          doorState: {
            ...current,
            isLocked: !current.isLocked,
          },
        };
      }
      return w;
    });
    if (doorFeedbackSignal.value[wallId]) {
      const next = { ...doorFeedbackSignal.value };
      delete next[wallId];
      doorFeedbackSignal.value = next;
    }
    const updatedScene: CampaignMapScene = { ...selectedScene, walls: updatedWalls };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleStageMonster = (entry: CompendiumEntry | null) => {
    if (!selectedScene || !entry) return;
    const newToken = stageSrdMonster(selectedScene, entry);
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      stagedTokens: [...selectedScene.stagedTokens, newToken],
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
    stagingStatusSignal.value = t('maps.monsterStaged', { name: newToken.name });
  };

  const closeMonsterPicker = () => {
    monsterPickerOpenSignal.value = false;
    pickerToggleRef.current?.focus();
  };

  const handleToggleRevealed = () => {
    if (!selectedScene) return;
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      revealedToPlayers: !selectedScene.revealedToPlayers,
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleGenerateStarterDungeon = () => {
    const dungeon = createStarterDungeonScene(campaignId);
    scenesSignal.value = [...scenesSignal.value, dungeon];
    selectedSceneIdSignal.value = dungeon.id;
  };

  const handleCreateScene = () => {
    const newId = generateEntityUuid();
    const newScene: CampaignMapScene = {
      id: newId,
      campaignId,
      title: t('maps.newSceneTitle'),
      revealedToPlayers: false,
      gridCellSizePx: 70,
      feetPerCell: 5,
      widthPx: 1400,
      heightPx: 1400,
      walls: [],
      lights: [],
      audioEmitters: [],
      stagedTokens: [],
      spawnPoint: { x: 700, y: 700 },
      spawnPoints: [{ id: generateEntityUuid(), name: t('maps.primarySpawn'), x: 700, y: 700 }],
      defaultGroundElevationFt: 0,
    };
    scenesSignal.value = [...scenesSignal.value, newScene];
    selectedSceneIdSignal.value = newId;
  };

  const addWall = (a: Point2D, b: Point2D) => {
    if (!selectedScene) return;
    const newWall = wallFromDrag(generateEntityUuid(), a, b, wallTypeSignal.value, wallBottomFtSignal.value, wallTopFtSignal.value);
    if (!newWall) return;
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      walls: [...selectedScene.walls, newWall],
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleAddWall = () => {
    addWall({ x: wallP1XSignal.value, y: wallP1YSignal.value }, { x: wallP2XSignal.value, y: wallP2YSignal.value });
  };

  const handleDeleteWall = (wallId: string) => {
    if (!selectedScene) return;
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      walls: selectedScene.walls.filter((w) => w.id !== wallId),
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleFlipWall = (wallId: string) => {
    if (!selectedScene) return;
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      walls: selectedScene.walls.map((w) => (w.id === wallId ? flipOneWay(w) : w)),
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleAddLight = () => {
    if (!selectedScene) return;
    const radius = lightRadiusFtSignal.value;
    const newLight: StudioLightSource = {
      id: generateEntityUuid(),
      origin: { x: lightXSignal.value, y: lightYSignal.value },
      brightRadiusFt: radius * 0.5,
      dimRadiusFt: radius,
      // Stored scene data: must be a literal hex the table renderer can parse, not a CSS variable.
      colorHex: DARK_CANVAS_PALETTE.actionCss,
      intensity: 1.0,
      elevationFt: selectedScene.defaultGroundElevationFt ?? 0,
    };
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      lights: [...selectedScene.lights, newLight],
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleAddAudio = () => {
    if (!selectedScene) return;
    const newEmitter: AudioEmitterConfig = {
      id: generateEntityUuid(),
      url: audioClipUrlSignal.value,
      x: audioXSignal.value,
      y: audioYSignal.value,
      elevationFt: selectedScene.defaultGroundElevationFt ?? 0,
      refDistanceFt: 10,
      maxDistanceFt: 50,
      rolloff: 1.0,
      loopPlayback: true,
      volume: 1.0,
      gmOnly: false,
    };
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      audioEmitters: [...selectedScene.audioEmitters, newEmitter],
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const pointerScenePoint = (e: PointerEvent | MouseEvent): Point2D | null => {
    if (!selectedScene) return null;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    return scenePoint(rect, selectedScene.widthPx, selectedScene.heightPx, e.clientX, e.clientY);
  };

  const snapped = (e: PointerEvent, point: Point2D) => (e.altKey ? point : snapToGridCorner(point, selectedScene?.gridCellSizePx ?? 0));

  const terrainTool = studioToolSignal.value !== 'walls';
  const grid = selectedScene ? sceneGridSize(selectedScene.widthPx, selectedScene.heightPx, selectedScene.gridCellSizePx) : { cols: 1, rows: 1 };

  /** Paints or erases `cell` with the active terrain tool (`erase` forces erasing). */
  const brushCell = (cell: GridCell, erase = false) => {
    if (!selectedScene) return;
    const cells = selectedScene.difficultTerrain ?? [];
    const next = applyTerrainBrush(cells, cell, erase || studioToolSignal.value === 'erase' ? 'erase' : 'paint');
    if (next === cells) return;
    const updatedScene: CampaignMapScene = { ...selectedScene, difficultTerrain: next };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const brushAtPointer = (e: PointerEvent) => {
    const point = pointerScenePoint(e);
    const cell = point && selectedScene ? cellAtPoint(point, selectedScene.gridCellSizePx, grid.cols, grid.rows) : null;
    if (!cell) return;
    terrainCursorSignal.value = cell;
    brushCell(cell);
  };

  const handleClearTerrain = () => {
    if (!selectedScene) return;
    const updatedScene: CampaignMapScene = { ...selectedScene, difficultTerrain: [] };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  /** Captures the pointer so a drag ending outside the canvas still ends (or cancels) the wall or brush stroke. */
  const handleCanvasPointerDown = (e: PointerEvent) => {
    const point = pointerScenePoint(e);
    if (!point) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (terrainTool) {
      terrainPaintingSignal.value = true;
      brushAtPointer(e);
      return;
    }
    wallDragSignal.value = { start: snapped(e, point), end: snapped(e, point) };
  };

  const handleCanvasPointerCancel = () => {
    wallDragSignal.value = null;
    terrainPaintingSignal.value = false;
  };

  const handleCanvasPointerMove = (e: PointerEvent) => {
    if (terrainPaintingSignal.value) {
      brushAtPointer(e);
      return;
    }
    const drag = wallDragSignal.value;
    const point = drag ? pointerScenePoint(e) : null;
    if (drag && point) wallDragSignal.value = { start: drag.start, end: snapped(e, point) };
  };

  const handleCanvasPointerUp = () => {
    terrainPaintingSignal.value = false;
    const drag = wallDragSignal.value;
    wallDragSignal.value = null;
    if (drag) addWall(drag.start, drag.end);
  };

  /** Terrain tools only: arrows move the cursor cell, Space / Enter brush it, Delete / Backspace erase it. */
  const handleCanvasKeyDown = (e: KeyboardEvent) => {
    if (!terrainTool) return;
    const moved = moveTerrainCursor(terrainCursorSignal.value, e.key, grid.cols, grid.rows);
    if (moved) {
      e.preventDefault?.();
      terrainCursorSignal.value = moved;
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault?.();
      brushCell(terrainCursorSignal.value);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault?.();
      brushCell(terrainCursorSignal.value, true);
    }
  };

  const handleCanvasClick = (e: MouseEvent) => {
    if (terrainTool) return;
    const point = pointerScenePoint(e);
    if (!point) return;
    wallP1XSignal.value = point.x;
    wallP1YSignal.value = point.y;
    lightXSignal.value = point.x;
    lightYSignal.value = point.y;
    audioXSignal.value = point.x;
    audioYSignal.value = point.y;
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
          <h2 style={{ margin: 0, fontSize: 'var(--atlas-font-size-lg)' }}>{t('maps.studio.title')}</h2>
          <span data-testid="maps-campaign-label" class="atlas-tabular-nums" style={{ fontSize: 'var(--atlas-font-size-xs)', color: 'var(--atlas-text-muted)' }}>{campaignLabelText}</span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--atlas-space-sm)' }}>
          <button
            type="button"
            data-testid="toggle-revealed-btn"
            disabled={!selectedScene}
            aria-pressed={Boolean(selectedScene?.revealedToPlayers)}
            onClick={handleToggleRevealed}
            style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', background: 'var(--atlas-surface-raised)', color: 'var(--atlas-text)' }}
          >
            {t('maps.revealToPlayers')}
          </button>
          <button
            type="button"
            data-testid="activate-scene-btn"
            disabled={!selectedScene}
            onClick={() => selectedScene && onActivateScene?.(selectedScene)}
            style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', background: 'var(--atlas-action)', color: 'var(--atlas-on-action)' }}
          >
            {t('maps.activateScene')}
          </button>
          <button
            type="button"
            data-testid="save-scene-btn"
            disabled={!selectedScene || isSavingSignal.value}
            onClick={handleSave}
            style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)' }}
          >
            {isSavingSignal.value ? t('action.saving') : t('maps.saveScene')}
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 'var(--atlas-space-md)', flex: 1, minHeight: 0 }}>
        <aside style={{ width: '260px', borderRight: '1px solid var(--atlas-border)', display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{t('maps.scenes')}</h3>
            <div style={{ display: 'flex', gap: 'var(--atlas-space-xs)' }}>
              <button
                type="button"
                data-testid="starter-dungeon-btn"
                onClick={handleGenerateStarterDungeon}
                style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
              >
                {t('maps.starterDungeon')}
              </button>
              <button
                type="button"
                data-testid="create-scene-btn"
                onClick={handleCreateScene}
                style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
              >
                {t('maps.newScene')}
              </button>
            </div>
          </div>

          <ul data-testid="scenes-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {scenesSignal.value.length === 0 ? (
              <li
                data-testid="empty-scenes-prompt"
                style={{
                  color: 'var(--atlas-text-muted)',
                  fontSize: 'var(--atlas-font-size-xs)',
                  padding: 'var(--atlas-space-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--atlas-space-xs)',
                  alignItems: 'flex-start',
                }}
              >
                <span>{t('maps.noScenes')}</span>
                <button
                  type="button"
                  data-testid="empty-create-scene-btn"
                  onClick={handleCreateScene}
                  style={{
                    minHeight: '40px',
                    padding: 'var(--atlas-space-xs) var(--atlas-space-sm)',
                    fontSize: 'var(--atlas-font-size-xs)',
                    background: 'var(--atlas-action)',
                    color: 'var(--atlas-on-action)',
                    border: 'none',
                    borderRadius: 'var(--atlas-radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  {t('maps.createScene')}
                </button>
              </li>
            ) : (
              scenesSignal.value.map((scene) => (
                <li key={scene.id}>
                  <button
                    type="button"
                    data-testid={`scene-item-${scene.id}`}
                    aria-selected={scene.id === selectedSceneIdSignal.value}
                    aria-current={scene.id === selectedSceneIdSignal.value ? 'true' : undefined}
                    onClick={() => { selectedSceneIdSignal.value = scene.id; }}
                    style={{
                      width: '100%',
                      minHeight: '40px',
                      textAlign: 'left',
                      padding: 'var(--atlas-space-xs) var(--atlas-space-sm)',
                      fontWeight: scene.id === selectedSceneIdSignal.value ? 'bold' : 'normal',
                      background: scene.id === selectedSceneIdSignal.value ? 'var(--atlas-surface-raised)' : 'transparent',
                      color: 'inherit',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {scene.title}
                  </button>
                </li>
              ))
            )}
          </ul>

          <hr style={{ borderColor: 'var(--atlas-border)', margin: 'var(--atlas-space-sm) 0' }} />
          <h4 style={{ margin: 0 }}>{t('maps.templates')}</h4>
          {!selectedScene && (
            <span style={{ fontSize: 'var(--atlas-font-size-xs)', color: 'var(--atlas-text-muted)' }}>
              {t('maps.selectSceneToStage')}
            </span>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-xs)' }}>
            {QUICK_PICK_MONSTERS.map(({ key, slug }) => {
              const entry = pickerEntries.find((e) => e.id === `${SRD_MONSTER_PREFIX}${slug}`) ?? null;
              return (
                <button
                  key={key}
                  type="button"
                  data-testid={`template-${key}`}
                  disabled={!selectedScene || !entry}
                  onClick={() => handleStageMonster(entry)}
                  style={{ minHeight: '40px', textAlign: 'left', padding: 'var(--atlas-space-xs)', opacity: !selectedScene || !entry ? 0.5 : 1, cursor: !selectedScene || !entry ? 'not-allowed' : 'pointer' }}
                >
                  {t('maps.addHiddenTemplate', { template: t(`maps.template.${key}`) })}
                </button>
              );
            })}
            <button
              type="button"
              ref={pickerToggleRef}
              class="ds-btn ds-btn-secondary ds-btn-sm"
              data-testid="open-monster-picker"
              disabled={!selectedScene}
              aria-expanded={monsterPickerOpenSignal.value}
              onClick={() => { monsterPickerOpenSignal.value = !monsterPickerOpenSignal.value; }}
            >
              {t('maps.browseMonsters')}
            </button>
          </div>
          <p role="status" class="ds-meta" data-testid="maps-staging-status">{stagingStatusSignal.value}</p>
          {selectedScene ? (
            <CompendiumDrawer
              isOpen={monsterPickerOpenSignal.value}
              entries={pickerEntries}
              systemId="dnd5e"
              onClose={closeMonsterPicker}
              onStageMonster={handleStageMonster}
            />
          ) : null}
        </aside>

        <main data-testid="canvas-editor" style={{ flex: 1, border: '1px solid var(--atlas-border)', position: 'relative', overflowY: 'auto' }}>
          {selectedScene ? (
            <div style={{ padding: 'var(--atlas-space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-md)' }}>
              <div>
                <h4 style={{ margin: '0 0 var(--atlas-space-xs) 0' }}>{t('maps.activeCanvas', { title: selectedScene.title })}</h4>
                <p style={{ margin: 0, fontSize: 'var(--atlas-font-size-xs)', color: 'var(--atlas-text-muted)' }}>
                  {t('maps.canvasStats', {
                    walls: selectedScene.walls.length,
                    lights: selectedScene.lights.length,
                    emitters: selectedScene.audioEmitters.length,
                    tokens: selectedScene.stagedTokens.length,
                  })}
                </p>
              </div>

              <div role="toolbar" aria-label={t('maps.zoomToolbar')} class="ds-cluster">
                <button
                  type="button"
                  class="ds-btn ds-btn-ghost ds-btn-sm"
                  data-testid="studio-zoom-out"
                  aria-label={t('table.zoomOut')}
                  disabled={studioZoomSignal.value <= STUDIO_MIN_ZOOM}
                  onClick={() => { studioZoomSignal.value = Math.max(STUDIO_MIN_ZOOM, studioZoomSignal.value / STUDIO_ZOOM_STEP); }}
                >
                  −
                </button>
                <span class="ds-meta atlas-tabular-nums" data-testid="studio-zoom-level">
                  {t('table.zoomLevel', { percent: Math.round(studioZoomSignal.value * 100) })}
                </span>
                <button
                  type="button"
                  class="ds-btn ds-btn-ghost ds-btn-sm"
                  data-testid="studio-zoom-in"
                  aria-label={t('table.zoomIn')}
                  disabled={studioZoomSignal.value >= STUDIO_MAX_ZOOM}
                  onClick={() => { studioZoomSignal.value = Math.min(STUDIO_MAX_ZOOM, studioZoomSignal.value * STUDIO_ZOOM_STEP); }}
                >
                  +
                </button>
                <span class="ds-hint">{t('maps.drawWallHint')}</span>
                <span class="ds-hint" data-testid="studio-wall-glyph-hint">{t('maps.wallGlyphHint')}</span>
              </div>
              <fieldset class="ds-cluster" data-testid="studio-tool-picker" style={{ border: 'none', padding: 0, margin: 0 }}>
                <legend class="ds-field-label">{t('maps.tool.legend')}</legend>
                {(Object.keys(STUDIO_TOOL_LABEL_KEYS) as StudioTool[]).map((tool) => (
                  <label key={tool} class="ds-cluster" style={{ minHeight: '40px', alignItems: 'center' }}>
                    <input
                      type="radio"
                      name="studio-tool"
                      value={tool}
                      data-testid={`studio-tool-${tool}`}
                      checked={studioToolSignal.value === tool}
                      onChange={() => { studioToolSignal.value = tool; }}
                    />
                    {t(STUDIO_TOOL_LABEL_KEYS[tool])}
                  </label>
                ))}
                <button
                  type="button"
                  class="ds-btn ds-btn-ghost ds-btn-sm"
                  data-testid="studio-clear-terrain"
                  disabled={(selectedScene.difficultTerrain ?? []).length === 0}
                  onClick={handleClearTerrain}
                >
                  {t('maps.terrain.clearAll')}
                </button>
              </fieldset>
              <p class="ds-meta" role="status" data-testid="studio-terrain-status">
                {terrainTool
                  ? t(hasCell(selectedScene.difficultTerrain ?? [], terrainCursorSignal.value) ? 'maps.terrain.cursorDifficult' : 'maps.terrain.cursorClear', {
                      col: terrainCursorSignal.value.col + 1,
                      row: terrainCursorSignal.value.row + 1,
                      count: (selectedScene.difficultTerrain ?? []).length,
                    })
                  : t('maps.terrain.count', { count: (selectedScene.difficultTerrain ?? []).length })}
              </p>
              <div
                data-testid="canvas-viewport"
                style={{
                  width: '100%',
                  height: '240px',
                  background: 'var(--atlas-bg)',
                  border: '1px solid var(--atlas-border)',
                  borderRadius: 'var(--atlas-radius-md)',
                  position: 'relative',
                  overflow: 'auto',
                }}
              >
                <svg
                  role={terrainTool ? 'application' : 'img'}
                  aria-label={terrainTool ? t('maps.terrain.canvasLabel') : t('maps.canvasLabel')}
                  tabIndex={terrainTool ? 0 : undefined}
                  data-testid="studio-canvas"
                  width={`${studioZoomSignal.value * 100}%`}
                  height={`${studioZoomSignal.value * 100}%`}
                  viewBox={`0 0 ${selectedScene.widthPx} ${selectedScene.heightPx}`}
                  onClick={handleCanvasClick}
                  onKeyDown={handleCanvasKeyDown}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={handleCanvasPointerUp}
                  onPointerCancel={handleCanvasPointerCancel}
                  style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
                >
                  <defs>
                    <pattern id="studio-terrain-hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="14" stroke="var(--atlas-text-muted)" strokeWidth={3} />
                    </pattern>
                  </defs>
                  {(selectedScene.difficultTerrain ?? []).map((cell) => (
                    <rect
                      key={`${cell.col}:${cell.row}`}
                      data-testid={`canvas-terrain-${cell.col}-${cell.row}`}
                      x={cell.col * selectedScene.gridCellSizePx}
                      y={cell.row * selectedScene.gridCellSizePx}
                      width={selectedScene.gridCellSizePx}
                      height={selectedScene.gridCellSizePx}
                      fill="url(#studio-terrain-hatch)"
                      stroke="var(--atlas-text-muted)"
                      strokeWidth={1}
                    />
                  ))}
                  {terrainTool ? (
                    <rect
                      data-testid="canvas-terrain-cursor"
                      x={terrainCursorSignal.value.col * selectedScene.gridCellSizePx}
                      y={terrainCursorSignal.value.row * selectedScene.gridCellSizePx}
                      width={selectedScene.gridCellSizePx}
                      height={selectedScene.gridCellSizePx}
                      fill="none"
                      stroke="var(--atlas-focus)"
                      strokeWidth={4}
                      strokeDasharray="8 4"
                    />
                  ) : null}
                  {wallDragSignal.value ? (
                    <line
                      data-testid="canvas-wall-preview"
                      x1={wallDragSignal.value.start.x}
                      y1={wallDragSignal.value.start.y}
                      x2={wallDragSignal.value.end.x}
                      y2={wallDragSignal.value.end.y}
                      stroke="var(--atlas-focus)"
                      strokeWidth={3}
                      strokeDasharray={SHARED_WALL_KINDS[wallTypeSignal.value as CanonicalWallKind]?.dashPatternPx?.join(' ')}
                    />
                  ) : null}
                  {selectedScene.walls.map((wall) => {
                    const wallStyle = SHARED_WALL_KINDS[wall.wallType as CanonicalWallKind];
                    const strokeDasharray = wallStyle?.dashPatternPx ? wallStyle.dashPatternPx.join(' ') : undefined;
                    const strokeWidth = wallStyle?.strokeWidthPx ?? (wall.wallType === 'Door' ? 3.5 : 3);
                    const glyphs = wallGlyphs(wall.wallType as CanonicalWallKind, wall.a, wall.b, wall.oneWayNormal ?? null);
                    return (
                      <g key={wall.id}>
                        <line
                          data-testid={`canvas-wall-${wall.id}`}
                          x1={wall.a.x}
                          y1={wall.a.y}
                          x2={wall.b.x}
                          y2={wall.b.y}
                          stroke="var(--atlas-action)"
                          strokeWidth={strokeWidth}
                          strokeDasharray={strokeDasharray}
                        />
                        {glyphs.length > 0 ? (
                          <path data-testid={`canvas-wall-glyph-${wall.id}`} d={glyphPath(glyphs)} stroke="var(--atlas-action)" strokeWidth={2} fill="none" />
                        ) : null}
                      </g>
                    );
                  })}
                  {selectedScene.lights.map((light) => (
                    <circle
                      key={light.id}
                      data-testid={`canvas-light-${light.id}`}
                      cx={light.origin.x}
                      cy={light.origin.y}
                      r={light.dimRadiusFt * 2}
                      fill="var(--atlas-action)"
                      fillOpacity="0.2"
                    />
                  ))}
                  {selectedScene.stagedTokens.map((token) => {
                    const half = (Math.max(1, token.sizeCells ?? 1) * selectedScene.gridCellSizePx) / 2;
                    return (
                      <circle
                        key={token.id}
                        data-testid={`canvas-token-${token.id}`}
                        cx={token.x + half}
                        cy={token.y + half}
                        r={Math.max(15, half * 0.8)}
                        fill="var(--atlas-focus)"
                      />
                    );
                  })}
                </svg>
              </div>

              <section
                data-testid="interactive-authoring-tools"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--atlas-space-sm)',
                  padding: 'var(--atlas-space-sm)',
                  background: 'var(--atlas-surface-raised)',
                  borderRadius: 'var(--atlas-radius-sm)',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--atlas-space-xs)' }}>
                  <label htmlFor="studio-wall-type" style={{ fontSize: 'var(--atlas-font-size-xs)' }}>{t('maps.wallLabel')}</label>
                  <select
                    id="studio-wall-type"
                    data-testid="wall-type-select"
                    value={wallTypeSignal.value}
                    onChange={(e) => { wallTypeSignal.value = (e.currentTarget as HTMLSelectElement).value as WallType; }}
                    style={{ minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  >
                    {(Object.keys(WALL_TYPE_LABEL_KEYS) as WallType[]).map((wallType) => (
                      <option key={wallType} value={wallType}>{t(WALL_TYPE_LABEL_KEYS[wallType])}</option>
                    ))}
                  </select>
                  <label htmlFor="wall-p1x" style={{ fontSize: 'var(--atlas-font-size-xs)' }}>{t('maps.point', { index: 1 })}</label>
                  <input
                    id="wall-p1x"
                    aria-label={t('maps.pointX', { index: 1 })}
                    data-testid="wall-p1x-input"
                    type="number"
                    value={wallP1XSignal.value}
                    onInput={(e) => { wallP1XSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <input
                    id="wall-p1y"
                    aria-label={t('maps.pointY', { index: 1 })}
                    data-testid="wall-p1y-input"
                    type="number"
                    value={wallP1YSignal.value}
                    onInput={(e) => { wallP1YSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <label htmlFor="wall-p2x" style={{ fontSize: 'var(--atlas-font-size-xs)' }}>{t('maps.point', { index: 2 })}</label>
                  <input
                    id="wall-p2x"
                    aria-label={t('maps.pointX', { index: 2 })}
                    data-testid="wall-p2x-input"
                    type="number"
                    value={wallP2XSignal.value}
                    onInput={(e) => { wallP2XSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <input
                    id="wall-p2y"
                    aria-label={t('maps.pointY', { index: 2 })}
                    data-testid="wall-p2y-input"
                    type="number"
                    value={wallP2YSignal.value}
                    onInput={(e) => { wallP2YSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <label htmlFor="wall-bottom-elevation" style={{ fontSize: 'var(--atlas-font-size-xs)' }}>{t('maps.bottomFt')}</label>
                  <input
                    id="wall-bottom-elevation"
                    data-testid="wall-bottom-elevation"
                    type="number"
                    value={wallBottomFtSignal.value}
                    onInput={(e) => { wallBottomFtSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <label htmlFor="wall-top-elevation" style={{ fontSize: 'var(--atlas-font-size-xs)' }}>{t('maps.topFt')}</label>
                  <input
                    id="wall-top-elevation"
                    data-testid="wall-top-elevation"
                    type="number"
                    value={wallTopFtSignal.value}
                    onInput={(e) => { wallTopFtSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <button
                    type="button"
                    data-testid="add-wall-btn"
                    onClick={handleAddWall}
                    style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                  >
                    {t('maps.addWall')}
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--atlas-space-xs)' }}>
                  <label htmlFor="light-x" style={{ fontSize: 'var(--atlas-font-size-xs)' }}>{t('maps.lightPosition')}</label>
                  <input
                    id="light-x"
                    aria-label={t('maps.lightX')}
                    data-testid="light-x-input"
                    type="number"
                    value={lightXSignal.value}
                    onInput={(e) => { lightXSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <input
                    id="light-y"
                    aria-label={t('maps.lightY')}
                    data-testid="light-y-input"
                    type="number"
                    value={lightYSignal.value}
                    onInput={(e) => { lightYSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <label htmlFor="light-radius" style={{ fontSize: 'var(--atlas-font-size-xs)' }}>{t('maps.radius')}</label>
                  <input
                    id="light-radius"
                    data-testid="light-radius-input"
                    type="number"
                    value={lightRadiusFtSignal.value}
                    onInput={(e) => { lightRadiusFtSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <button
                    type="button"
                    data-testid="add-light-btn"
                    onClick={handleAddLight}
                    style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                  >
                    {t('maps.addLight')}
                  </button>

                  <label htmlFor="audio-x" style={{ fontSize: 'var(--atlas-font-size-xs)', marginLeft: 'var(--atlas-space-sm)' }}>{t('maps.audioPosition')}</label>
                  <input
                    id="audio-x"
                    aria-label={t('maps.audioX')}
                    data-testid="audio-x-input"
                    type="number"
                    value={audioXSignal.value}
                    onInput={(e) => { audioXSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <input
                    id="audio-y"
                    aria-label={t('maps.audioY')}
                    data-testid="audio-y-input"
                    type="number"
                    value={audioYSignal.value}
                    onInput={(e) => { audioYSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', minHeight: '40px', fontSize: 'var(--atlas-font-size-xs)' }}
                  />
                  <button
                    type="button"
                    data-testid="add-audio-btn"
                    onClick={handleAddAudio}
                    style={{ minHeight: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                  >
                    {t('maps.addAudio')}
                  </button>

                </div>
                <p data-testid="studio-live-brushes-hint" style={{ margin: 0, fontSize: 'var(--atlas-font-size-xs)', color: 'var(--atlas-text-muted)' }}>
                  {t('maps.liveBrushesHint')}
                </p>
              </section>

              <div>
                <h5 style={{ margin: '0 0 var(--atlas-space-xs) 0' }}>{t('maps.allWalls', { count: selectedScene.walls.length })}</h5>
                <div data-testid="all-walls-list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-xs)', maxHeight: '160px', overflowY: 'auto' }}>
                  {selectedScene.walls.length === 0 ? (
                    <span style={{ fontSize: 'var(--atlas-font-size-xs)', color: 'var(--atlas-text-muted)' }}>{t('maps.noWalls')}</span>
                  ) : (
                    selectedScene.walls.map((w, wallIdx) => {
                      const wallIndex = wallIdx + 1;
                      return (
                        <div key={w.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--atlas-font-size-xs)', padding: '2px 4px', background: 'var(--atlas-surface-raised)', borderRadius: 'var(--atlas-radius-sm)' }}>
                          <span class="atlas-tabular-nums">
                            <strong>{t(WALL_TYPE_LABEL_KEYS[w.wallType] ?? 'maps.wallType.normal')}</strong> #{wallIndex}: [{w.bottomElevationFt}ft .. {w.topElevationFt}ft] ({w.a.x},{w.a.y}) &rarr; ({w.b.x},{w.b.y})
                          </span>
                          {w.wallType === 'OneWay' ? (
                            <button
                              type="button"
                              aria-label={t('maps.flipOneWay', { index: wallIndex })}
                              data-testid={`flip-wall-${w.id}`}
                              onClick={() => handleFlipWall(w.id)}
                              style={{ minHeight: '40px', minWidth: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                            >
                              {t('maps.flip')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-label={t('maps.deleteWall', { index: wallIndex })}
                            data-testid={`delete-wall-${w.id}`}
                            onClick={() => handleDeleteWall(w.id)}
                            style={{ minHeight: '40px', minWidth: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                          >
                            {t('action.delete')}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div>
                <h5 style={{ margin: '0 0 var(--atlas-space-xs) 0' }}>{t('maps.doorsTitle')}</h5>
                <div data-testid="doors-list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-xs)' }}>
                  {selectedScene.walls
                    .filter((w) => w.wallType === 'Door' || w.wallType === 'SecretDoor')
                    .map((door, doorIdx) => {
                      const doorIndex = doorIdx + 1;
                      const isDoorLocked = door.wallType === 'Door' && Boolean(door.doorState?.isLocked);
                      const isDoorOpen = door.wallType === 'Door' ? Boolean(door.doorState?.isOpen) : Boolean(door.secretDoorState?.isOpen);
                      return (
                        <div key={door.id} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--atlas-space-sm)' }}>
                            <span>
                              {t('maps.doorStatus', {
                                kind: t(door.wallType === 'SecretDoor' ? 'maps.wallType.secretDoor' : 'maps.wallType.door'),
                                index: doorIndex,
                                state: t(isDoorOpen ? 'maps.door.open' : 'maps.door.closed'),
                              })}
                            </span>
                            {isDoorLocked && (
                              <span data-testid={`lock-badge-${door.id}`} style={{ padding: '2px 6px', background: 'var(--atlas-border)', borderRadius: 'var(--atlas-radius-sm)', fontSize: 'var(--atlas-font-size-xs)' }}>
                                {t('maps.door.locked')}
                              </span>
                            )}
                            {door.wallType === 'Door' && (
                              <button
                                type="button"
                                data-testid={`toggle-lock-${door.id}`}
                                onClick={() => handleToggleDoorLock(door.id)}
                                style={{ minHeight: '40px', minWidth: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                              >
                                {isDoorLocked ? t('maps.door.unlock') : t('maps.door.lock')}
                              </button>
                            )}
                            <button
                              type="button"
                              data-testid={`toggle-door-${door.id}`}
                              onClick={() => handleDoorToggle(door.id)}
                              style={{ minHeight: '40px', minWidth: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                            >
                              {t('maps.door.toggle')}
                            </button>
                            <button
                              type="button"
                              aria-label={t('maps.deleteDoor', { index: doorIndex })}
                              data-testid={`delete-wall-${door.id}`}
                              onClick={() => handleDeleteWall(door.id)}
                              style={{ minHeight: '40px', minWidth: '40px', padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-font-size-xs)' }}
                            >
                              {t('action.delete')}
                            </button>
                          </div>
                          {doorFeedbackSignal.value[door.id] && (
                            <span data-testid={`door-feedback-${door.id}`} role="alert" style={{ fontSize: 'var(--atlas-font-size-xs)', color: 'var(--atlas-danger)' }}>
                              {doorFeedbackSignal.value[door.id]}
                            </span>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--atlas-text-muted)' }}>
              {t('maps.noSceneSelected')}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
