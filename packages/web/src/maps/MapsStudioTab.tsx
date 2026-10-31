import { useSignal } from '@preact/signals';
import type { CampaignMapScene, StudioWallSegment, StagedToken, StudioLightSource, AudioEmitterConfig, UserRole, WallType } from './types.ts';
import { mapBackendSceneToFrontend, toggleDoorState } from './domain.ts';
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

  try {
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

  if (userRole !== 'GM') {
    return <SceneAtlas campaignId={campaignId} scenes={initialScenes} />;
  }

  const selectedScene = scenesSignal.value.find((s) => s.id === selectedSceneIdSignal.value) ?? null;

  const handleDoorToggle = (wallId: string) => {
    if (!selectedScene) return;
    const wall = selectedScene.walls.find((w) => w.id === wallId);
    if (wall?.wallType === 'Door' && wall.doorState?.isLocked) {
      doorFeedbackSignal.value = {
        ...doorFeedbackSignal.value,
        [wallId]: 'Cannot open: door is locked. Unlock door first.',
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

  const handleAddStagedMonster = (templateKey: StagedToken['templateKey']) => {
    if (!selectedScene) return;
    const spawn = selectedScene.spawnPoints?.[0] || selectedScene.spawnPoint || { x: 100, y: 100 };
    const newToken: StagedToken = {
      id: `token-${Date.now()}`,
      name: String(templateKey),
      templateKey,
      x: spawn.x + 20,
      y: spawn.y + 20,
      elevationFt: selectedScene.defaultGroundElevationFt ?? 0,
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

  const handleCreateScene = () => {
    const newId = `scene-${Date.now()}`;
    const newScene: CampaignMapScene = {
      id: newId,
      campaignId,
      title: 'New Map Scene',
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
      spawnPoints: [{ id: `sp-${Date.now()}`, name: 'Primary Spawn', x: 700, y: 700 }],
      defaultGroundElevationFt: 0,
    };
    scenesSignal.value = [...scenesSignal.value, newScene];
    selectedSceneIdSignal.value = newId;
  };

  const handleAddWall = () => {
    if (!selectedScene) return;
    const type = wallTypeSignal.value;
    const blocksVision = type === 'Normal' || type === 'Terrain' || type === 'Illusion' || type === 'Door' || type === 'SecretDoor' || type === 'OneWay';
    const blocksMovement = type === 'Normal' || type === 'Window' || type === 'Terrain' || type === 'Door' || type === 'SecretDoor' || type === 'OneWay';
    const blocksLight = type === 'Normal' || type === 'Illusion' || type === 'Terrain' || type === 'Door' || type === 'SecretDoor' || type === 'OneWay';
    const blocksSound = type === 'Normal' || type === 'Window' || type === 'Door' || type === 'SecretDoor' || type === 'OneWay';

    const newWall: StudioWallSegment = {
      id: `wall-${Date.now()}`,
      a: { x: wallP1XSignal.value, y: wallP1YSignal.value },
      b: { x: wallP2XSignal.value, y: wallP2YSignal.value },
      wallType: type,
      blocksMovement,
      blocksVision,
      blocksLight,
      blocksSound,
      bottomElevationFt: wallBottomFtSignal.value,
      topElevationFt: wallTopFtSignal.value,
      doorState: type === 'Door' ? { isOpen: false, isLocked: false } : undefined,
      secretDoorState: type === 'SecretDoor' ? { isOpen: false } : undefined,
    };
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      walls: [...selectedScene.walls, newWall],
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleDeleteWall = (wallId: string) => {
    if (!selectedScene) return;
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      walls: selectedScene.walls.filter((w) => w.id !== wallId),
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleAddLight = () => {
    if (!selectedScene) return;
    const radius = lightRadiusFtSignal.value;
    const newLight: StudioLightSource = {
      id: `light-${Date.now()}`,
      origin: { x: lightXSignal.value, y: lightYSignal.value },
      brightRadiusFt: radius * 0.5,
      dimRadiusFt: radius,
      colorHex: 'var(--atlas-action)',
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
      id: `audio-${Date.now()}`,
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

  const handlePaintFog = () => {
    if (!selectedScene) return;
    const currentFog = selectedScene.exploredFogTexture ?? [];
    const updatedFog = currentFog.length > 0 ? [...currentFog, 255] : [255, 255, 255, 255];
    const updatedScene: CampaignMapScene = {
      ...selectedScene,
      exploredFogTexture: updatedFog,
    };
    scenesSignal.value = scenesSignal.value.map((s) => (s.id === updatedScene.id ? updatedScene : s));
  };

  const handleCanvasClick = (e: MouseEvent) => {
    if (!selectedScene) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const x = Math.round(((e.clientX - rect.left) / rect.width) * selectedScene.widthPx);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * selectedScene.heightPx);
      wallP1XSignal.value = x;
      wallP1YSignal.value = y;
      lightXSignal.value = x;
      lightYSignal.value = y;
      audioXSignal.value = x;
      audioYSignal.value = y;
    }
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
            disabled={!selectedScene}
            aria-pressed={Boolean(selectedScene?.revealedToPlayers)}
            onClick={handleToggleRevealed}
            style={{ padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', background: 'var(--atlas-surface-raised)', color: 'var(--atlas-text)' }}
          >
            {selectedScene?.revealedToPlayers ? 'Revealed in Atlas' : 'Hidden from Atlas'}
          </button>
          <button
            type="button"
            data-testid="activate-scene-btn"
            disabled={!selectedScene}
            onClick={() => selectedScene && onActivateScene?.(selectedScene)}
            style={{ padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', background: 'var(--atlas-action)', color: 'var(--atlas-on-action)' }}
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
        <aside style={{ width: '260px', borderRight: '1px solid var(--atlas-border)', display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Scenes</h3>
            <button
              type="button"
              data-testid="create-scene-btn"
              onClick={handleCreateScene}
              style={{ padding: 'var(--atlas-space-xs) var(--atlas-space-sm)', fontSize: 'var(--atlas-text-xs)' }}
            >
              + New Scene
            </button>
          </div>

          <ul data-testid="scenes-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {scenesSignal.value.length === 0 ? (
              <li
                data-testid="empty-scenes-prompt"
                style={{
                  color: 'var(--atlas-text-muted)',
                  fontSize: 'var(--atlas-text-xs)',
                  padding: 'var(--atlas-space-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--atlas-space-xs)',
                  alignItems: 'flex-start',
                }}
              >
                <span>No scenes available.</span>
                <button
                  type="button"
                  data-testid="empty-create-scene-btn"
                  onClick={handleCreateScene}
                  style={{
                    padding: 'var(--atlas-space-xs) var(--atlas-space-sm)',
                    fontSize: 'var(--atlas-text-xs)',
                    background: 'var(--atlas-action)',
                    color: 'var(--atlas-on-action)',
                    border: 'none',
                    borderRadius: 'var(--atlas-radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  Create Scene
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
          <h4 style={{ margin: 0 }}>1-Click Templates</h4>
          {!selectedScene && (
            <span style={{ fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>
              Select a scene to stage tokens.
            </span>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-xs)' }}>
            {(['Goblin', 'Bandit', 'Guard', 'Skeleton', 'Wolf', 'Ogre', 'Boss'] as const).map((tmpl) => (
              <button
                key={tmpl}
                type="button"
                data-testid={`template-${tmpl}`}
                disabled={!selectedScene}
                onClick={() => handleAddStagedMonster(tmpl)}
                style={{ textAlign: 'left', padding: 'var(--atlas-space-xs)', opacity: !selectedScene ? 0.5 : 1, cursor: !selectedScene ? 'not-allowed' : 'pointer' }}
              >
                + {tmpl} (Hidden)
              </button>
            ))}
          </div>
        </aside>

        <main data-testid="canvas-editor" style={{ flex: 1, border: '1px solid var(--atlas-border)', position: 'relative', overflowY: 'auto' }}>
          {selectedScene ? (
            <div style={{ padding: 'var(--atlas-space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-md)' }}>
              <div>
                <h4 style={{ margin: '0 0 var(--atlas-space-xs) 0' }}>Active Canvas: {selectedScene.title}</h4>
                <p style={{ margin: 0, fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>
                  Walls: {selectedScene.walls.length} | Lights: {selectedScene.lights.length} | Emitters: {selectedScene.audioEmitters.length} | Staged Tokens: {selectedScene.stagedTokens.length}
                </p>
              </div>

              <div
                data-testid="canvas-viewport"
                style={{
                  width: '100%',
                  height: '240px',
                  background: 'var(--atlas-bg)',
                  border: '1px solid var(--atlas-border)',
                  borderRadius: 'var(--atlas-radius-md)',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <svg
                  width="100%"
                  height="100%"
                  viewBox={`0 0 ${selectedScene.widthPx} ${selectedScene.heightPx}`}
                  onClick={handleCanvasClick}
                  style={{ display: 'block', cursor: 'crosshair' }}
                >
                  {selectedScene.walls.map((wall) => (
                    <line
                      key={wall.id}
                      data-testid={`canvas-wall-${wall.id}`}
                      x1={wall.a.x}
                      y1={wall.a.y}
                      x2={wall.b.x}
                      y2={wall.b.y}
                      stroke="var(--atlas-action)"
                      strokeWidth="3"
                    />
                  ))}
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
                  {selectedScene.stagedTokens.map((token) => (
                    <circle
                      key={token.id}
                      data-testid={`canvas-token-${token.id}`}
                      cx={token.x}
                      cy={token.y}
                      r="15"
                      fill="var(--atlas-focus)"
                    />
                  ))}
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
                  <label htmlFor="studio-wall-type" style={{ fontSize: 'var(--atlas-text-xs)' }}>Wall:</label>
                  <select
                    id="studio-wall-type"
                    data-testid="wall-type-select"
                    value={wallTypeSignal.value}
                    onChange={(e) => { wallTypeSignal.value = (e.currentTarget as HTMLSelectElement).value as WallType; }}
                    style={{ fontSize: 'var(--atlas-text-xs)' }}
                  >
                    <option value="Normal">Normal</option>
                    <option value="Window">Window</option>
                    <option value="Terrain">Terrain</option>
                    <option value="OneWay">OneWay</option>
                    <option value="Door">Door</option>
                    <option value="SecretDoor">SecretDoor</option>
                    <option value="Illusion">Illusion</option>
                  </select>
                  <label htmlFor="wall-p1x" style={{ fontSize: 'var(--atlas-text-xs)' }}>P1:</label>
                  <input
                    id="wall-p1x"
                    data-testid="wall-p1x-input"
                    type="number"
                    value={wallP1XSignal.value}
                    onInput={(e) => { wallP1XSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <input
                    id="wall-p1y"
                    data-testid="wall-p1y-input"
                    type="number"
                    value={wallP1YSignal.value}
                    onInput={(e) => { wallP1YSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <label htmlFor="wall-p2x" style={{ fontSize: 'var(--atlas-text-xs)' }}>P2:</label>
                  <input
                    id="wall-p2x"
                    data-testid="wall-p2x-input"
                    type="number"
                    value={wallP2XSignal.value}
                    onInput={(e) => { wallP2XSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <input
                    id="wall-p2y"
                    data-testid="wall-p2y-input"
                    type="number"
                    value={wallP2YSignal.value}
                    onInput={(e) => { wallP2YSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <label htmlFor="wall-bottom-elevation" style={{ fontSize: 'var(--atlas-text-xs)' }}>Bottom(ft):</label>
                  <input
                    id="wall-bottom-elevation"
                    data-testid="wall-bottom-elevation"
                    type="number"
                    value={wallBottomFtSignal.value}
                    onInput={(e) => { wallBottomFtSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <label htmlFor="wall-top-elevation" style={{ fontSize: 'var(--atlas-text-xs)' }}>Top(ft):</label>
                  <input
                    id="wall-top-elevation"
                    data-testid="wall-top-elevation"
                    type="number"
                    value={wallTopFtSignal.value}
                    onInput={(e) => { wallTopFtSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <button
                    type="button"
                    data-testid="add-wall-btn"
                    onClick={handleAddWall}
                    style={{ padding: '2px 8px', fontSize: 'var(--atlas-text-xs)' }}
                  >
                    Add Wall Segment
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--atlas-space-xs)' }}>
                  <label htmlFor="light-x" style={{ fontSize: 'var(--atlas-text-xs)' }}>Light X,Y:</label>
                  <input
                    id="light-x"
                    data-testid="light-x-input"
                    type="number"
                    value={lightXSignal.value}
                    onInput={(e) => { lightXSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <input
                    id="light-y"
                    data-testid="light-y-input"
                    type="number"
                    value={lightYSignal.value}
                    onInput={(e) => { lightYSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <label htmlFor="light-radius" style={{ fontSize: 'var(--atlas-text-xs)' }}>Radius:</label>
                  <input
                    id="light-radius"
                    data-testid="light-radius-input"
                    type="number"
                    value={lightRadiusFtSignal.value}
                    onInput={(e) => { lightRadiusFtSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <button
                    type="button"
                    data-testid="add-light-btn"
                    onClick={handleAddLight}
                    style={{ padding: '2px 8px', fontSize: 'var(--atlas-text-xs)' }}
                  >
                    Add Light
                  </button>

                  <label htmlFor="audio-x" style={{ fontSize: 'var(--atlas-text-xs)', marginLeft: 'var(--atlas-space-sm)' }}>Audio X,Y:</label>
                  <input
                    id="audio-x"
                    data-testid="audio-x-input"
                    type="number"
                    value={audioXSignal.value}
                    onInput={(e) => { audioXSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <input
                    id="audio-y"
                    data-testid="audio-y-input"
                    type="number"
                    value={audioYSignal.value}
                    onInput={(e) => { audioYSignal.value = Number((e.currentTarget as HTMLInputElement).value); }}
                    style={{ width: '45px', fontSize: 'var(--atlas-text-xs)' }}
                  />
                  <button
                    type="button"
                    data-testid="add-audio-btn"
                    onClick={handleAddAudio}
                    style={{ padding: '2px 8px', fontSize: 'var(--atlas-text-xs)' }}
                  >
                    Add Audio Emitter
                  </button>

                  <button
                    type="button"
                    data-testid="paint-fog-btn"
                    onClick={handlePaintFog}
                    style={{ padding: '2px 8px', fontSize: 'var(--atlas-text-xs)', marginLeft: 'var(--atlas-space-sm)' }}
                  >
                    Paint Fog
                  </button>
                </div>
              </section>

              <div>
                <h5 style={{ margin: '0 0 var(--atlas-space-xs) 0' }}>All Wall Segments ({selectedScene.walls.length})</h5>
                <div data-testid="all-walls-list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-xs)', maxHeight: '160px', overflowY: 'auto' }}>
                  {selectedScene.walls.length === 0 ? (
                    <span style={{ fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-text-muted)' }}>No wall segments yet.</span>
                  ) : (
                    selectedScene.walls.map((w) => (
                      <div key={w.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--atlas-text-xs)', padding: '2px 4px', background: 'var(--atlas-surface-raised)', borderRadius: 'var(--atlas-radius-sm)' }}>
                        <span>
                          <strong>{w.wallType}</strong> ({w.id}): [{w.bottomElevationFt}ft .. {w.topElevationFt}ft] ({w.a.x},{w.a.y}) &rarr; ({w.b.x},{w.b.y})
                        </span>
                        <button
                          type="button"
                          data-testid={`delete-wall-${w.id}`}
                          onClick={() => handleDeleteWall(w.id)}
                          style={{ padding: '1px 6px', fontSize: 'var(--atlas-text-xs)' }}
                        >
                          Delete
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h5 style={{ margin: '0 0 var(--atlas-space-xs) 0' }}>Doors &amp; Secret Passages</h5>
                <div data-testid="doors-list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atlas-space-xs)' }}>
                  {selectedScene.walls
                    .filter((w) => w.wallType === 'Door' || w.wallType === 'SecretDoor')
                    .map((door) => {
                      const isDoorLocked = door.wallType === 'Door' && Boolean(door.doorState?.isLocked);
                      const isDoorOpen = door.wallType === 'Door' ? Boolean(door.doorState?.isOpen) : Boolean(door.secretDoorState?.isOpen);
                      return (
                        <div key={door.id} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--atlas-space-sm)' }}>
                            <span>
                              {door.wallType === 'SecretDoor' ? 'Secret Door' : 'Door'} ({door.id}): {isDoorOpen ? 'Open' : 'Closed'}
                            </span>
                            {isDoorLocked && (
                              <span data-testid={`lock-badge-${door.id}`} style={{ padding: '2px 6px', background: 'var(--atlas-border)', borderRadius: 'var(--atlas-radius-sm)', fontSize: 'var(--atlas-text-xs)' }}>
                                Locked
                              </span>
                            )}
                            {door.wallType === 'Door' && (
                              <button
                                type="button"
                                data-testid={`toggle-lock-${door.id}`}
                                onClick={() => handleToggleDoorLock(door.id)}
                                style={{ padding: '2px 6px', fontSize: 'var(--atlas-text-xs)' }}
                              >
                                {isDoorLocked ? 'Unlock' : 'Lock'}
                              </button>
                            )}
                            <button
                              type="button"
                              data-testid={`toggle-door-${door.id}`}
                              onClick={() => handleDoorToggle(door.id)}
                              style={{ padding: '2px 6px', fontSize: 'var(--atlas-text-xs)' }}
                            >
                              Toggle Door
                            </button>
                            <button
                              type="button"
                              data-testid={`delete-wall-${door.id}`}
                              onClick={() => handleDeleteWall(door.id)}
                              style={{ padding: '2px 6px', fontSize: 'var(--atlas-text-xs)' }}
                            >
                              Delete
                            </button>
                          </div>
                          {doorFeedbackSignal.value[door.id] && (
                            <span data-testid={`door-feedback-${door.id}`} role="alert" style={{ fontSize: 'var(--atlas-text-xs)', color: 'var(--atlas-danger)' }}>
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
              No scene selected. Create or choose a scene from the left sidebar.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
