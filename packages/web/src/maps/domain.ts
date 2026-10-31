import type {
  ActiveTableRoomState,
  AudioEmitterConfig,
  CampaignMapScene,
  SpawnPointConfig,
  StagedToken,
  StudioLightSource,
  StudioWallSegment,
  UserRole,
} from './types.ts';

export function filterScenesForRole(
  scenes: (CampaignMapScene | Record<string, any>)[],
  role: UserRole,
): CampaignMapScene[] {
  const normalized = scenes.map((s) =>
    'walls' in s && Array.isArray((s as any).walls) ? (s as CampaignMapScene) : mapBackendSceneToFrontend(s),
  );
  if (role === 'GM') {
    return normalized;
  }
  return normalized
    .filter((scene) => scene.revealedToPlayers)
    .map((scene) => ({
      ...scene,
      walls: scene.walls.map((wall) => {
        if (wall.wallType === 'SecretDoor' && !wall.secretDoorState?.isOpen) {
          return {
            ...wall,
            wallType: 'Normal',
            secretDoorState: undefined,
            blocksVision: true,
            blocksMovement: true,
          };
        }
        if (wall.wallType === 'Illusion') {
          return {
            ...wall,
            wallType: 'Normal',
            blocksVision: true,
            blocksMovement: true,
          };
        }
        return wall;
      }),
      audioEmitters: (scene.audioEmitters || []).filter((emitter) => !emitter.gmOnly),
      stagedTokens: scene.stagedTokens.filter(
        (token) => token.visibilityChannel !== 'GmHidden',
      ),
    }));
}

export function activateSceneTransition(
  currentTable: ActiveTableRoomState,
  targetScene: CampaignMapScene,
): ActiveTableRoomState {
  const heroTokens = currentTable.tokens.filter((t) => t.ownerUserId !== null);
  const defaultElevation = targetScene.defaultGroundElevationFt ?? targetScene.default_ground_elevation_ft ?? 0;
  const rawSpawns = targetScene.spawnPoints || targetScene.spawn_points;

  const preservedHeroes = heroTokens.map((hero, index) => {
    let x = 0;
    let y = 0;
    if (rawSpawns && rawSpawns.length > 0) {
      const sp = rawSpawns[index % rawSpawns.length];
      x = sp.x;
      y = sp.y;
    } else if (targetScene.spawnPoint) {
      x = targetScene.spawnPoint.x + index * 10;
      y = targetScene.spawnPoint.y;
    }
    return {
      ...hero,
      x,
      y,
      elevationFt: defaultElevation,
    };
  });

  const staged = targetScene.stagedTokens || targetScene.staged_tokens || [];
  const nonHeroStaged = staged.filter((t: any) => t.ownerUserId === null || t.owner_user_id === null);

  return {
    activeSceneId: targetScene.id,
    walls: [...(targetScene.walls || targetScene.wall_segments || [])],
    lights: [...(targetScene.lights || targetScene.light_sources || [])],
    tokens: [...preservedHeroes, ...nonHeroStaged],
  };
}

export function parseUvttImport(uvttJson: {
  format: number;
  resolution: { pixels_per_grid: number };
  line_of_sight?: Array<Array<{ x: number; y: number }>>;
  portals?: Array<{
    position: { x: number; y: number };
    bounds: Array<{ x: number; y: number }>;
    closed: boolean;
  }>;
  lights?: Array<{
    position: { x: number; y: number };
    range: number;
    color: string;
    intensity: number;
  }>;
}): { walls: StudioWallSegment[]; lights: StudioLightSource[] } {
  const ppg = uvttJson.resolution?.pixels_per_grid ?? 1;
  const walls: StudioWallSegment[] = [];
  let wallCounter = 1;

  if (uvttJson.line_of_sight) {
    for (const poly of uvttJson.line_of_sight) {
      for (let i = 0; i < poly.length - 1; i++) {
        walls.push({
          id: `uvtt-wall-${wallCounter++}`,
          a: { x: poly[i].x * ppg, y: poly[i].y * ppg },
          b: { x: poly[i + 1].x * ppg, y: poly[i + 1].y * ppg },
          wallType: 'Normal',
          blocksMovement: true,
          blocksVision: true,
          blocksLight: true,
          blocksSound: true,
          bottomElevationFt: -1000,
          topElevationFt: 1000,
        });
      }
    }
  }

  if (uvttJson.portals) {
    for (const portal of uvttJson.portals) {
      if (portal.bounds && portal.bounds.length >= 2) {
        walls.push({
          id: `uvtt-door-${wallCounter++}`,
          a: { x: portal.bounds[0].x * ppg, y: portal.bounds[0].y * ppg },
          b: { x: portal.bounds[1].x * ppg, y: portal.bounds[1].y * ppg },
          wallType: 'Door',
          blocksMovement: portal.closed,
          blocksVision: portal.closed,
          blocksLight: portal.closed,
          blocksSound: portal.closed,
          bottomElevationFt: -1000,
          topElevationFt: 1000,
          doorState: {
            isOpen: !portal.closed,
            isLocked: false,
          },
        });
      }
    }
  }

  const lights: StudioLightSource[] = (uvttJson.lights || []).map((l, idx) => ({
    id: `uvtt-light-${idx + 1}`,
    origin: { x: l.position.x * ppg, y: l.position.y * ppg },
    brightRadiusFt: l.range * 0.5 * ppg,
    dimRadiusFt: l.range * ppg,
    colorHex: l.color,
    intensity: l.intensity,
  }));

  return { walls, lights };
}

export function toggleDoorState(wall: StudioWallSegment): StudioWallSegment {
  if (wall.wallType !== 'Door' && wall.wallType !== 'SecretDoor') {
    return wall;
  }

  if (wall.wallType === 'Door') {
    const currentState = wall.doorState ?? { isOpen: false, isLocked: false };
    if (currentState.isLocked) {
      return wall;
    }
    const nextOpen = !currentState.isOpen;
    return {
      ...wall,
      doorState: {
        ...currentState,
        isOpen: nextOpen,
      },
      blocksMovement: !nextOpen,
      blocksVision: !nextOpen,
      blocksLight: !nextOpen,
      blocksSound: !nextOpen,
    };
  }

  const secretState = wall.secretDoorState ?? { isOpen: false };
  const nextOpen = !secretState.isOpen;
  return {
    ...wall,
    secretDoorState: {
      isOpen: nextOpen,
    },
    blocksMovement: !nextOpen,
    blocksVision: !nextOpen,
    blocksLight: !nextOpen,
    blocksSound: !nextOpen,
  };
}

export function mapBackendSceneToFrontend(raw: Record<string, any>): CampaignMapScene {
  const rawWalls = raw.wall_segments || raw.walls || [];
  const walls: StudioWallSegment[] = rawWalls.map((w: any) => {
    const a = w.p1 || w.a || { x: 0, y: 0 };
    const b = w.p2 || w.b || { x: 0, y: 0 };
    const isOpen = w.door_state === 'Open' || w.doorState?.isOpen || false;
    const isLocked = w.door_state === 'Locked' || w.doorState?.isLocked || false;
    return {
      id: String(w.id),
      a: { x: Number(a.x), y: Number(a.y) },
      b: { x: Number(b.x), y: Number(b.y) },
      wallType: w.wall_type || w.wallType || 'Normal',
      blocksMovement: Boolean(w.blocks_movement ?? w.blocksMovement ?? true),
      blocksVision: Boolean(w.blocks_vision ?? w.blocksVision ?? true),
      blocksLight: Boolean(w.blocks_light ?? w.blocksLight ?? true),
      blocksSound: Boolean(w.blocks_sound ?? w.blocksSound ?? true),
      bottomElevationFt: Number(w.bottom_elevation_ft ?? w.bottomElevationFt ?? 0),
      topElevationFt: Number(w.top_elevation_ft ?? w.topElevationFt ?? 10),
      doorState: (w.wall_type === 'Door' || w.wallType === 'Door') ? { isOpen, isLocked } : undefined,
      secretDoorState: (w.wall_type === 'SecretDoor' || w.wallType === 'SecretDoor') ? { isOpen } : undefined,
    };
  });

  const rawLights = raw.light_sources || raw.lights || [];
  const lights: StudioLightSource[] = rawLights.map((l: any) => {
    const origin = l.origin || { x: l.x ?? 0, y: l.y ?? 0 };
    const radius = Number(l.radius_ft ?? l.dimRadiusFt ?? 30);
    return {
      id: String(l.id),
      origin: { x: Number(origin.x), y: Number(origin.y) },
      brightRadiusFt: Number(l.brightRadiusFt ?? radius * 0.5),
      dimRadiusFt: radius,
      colorHex: String(l.color_hex || l.colorHex || 'var(--atlas-action)'),
      intensity: Number(l.intensity ?? 1.0),
      elevationFt: Number(l.elevation_ft ?? l.elevationFt ?? 0),
    };
  });

  const rawAudio = raw.spatial_audio_emitters || raw.audioEmitters || [];
  const audioEmitters: AudioEmitterConfig[] = rawAudio.map((a: any) => ({
    id: String(a.id),
    url: String(a.audio_clip_url || a.url || ''),
    x: Number(a.x ?? 0),
    y: Number(a.y ?? 0),
    elevationFt: Number(a.elevation_ft ?? a.elevationFt ?? 0),
    refDistanceFt: Number(a.refDistanceFt ?? 10),
    maxDistanceFt: Number(a.radius_ft ?? a.maxDistanceFt ?? 60),
    rolloff: Number(a.rolloff ?? 1.0),
    loopPlayback: Boolean(a.looping ?? a.loopPlayback ?? true),
    volume: Number(a.volume ?? 1.0),
    gmOnly: Boolean(a.gm_only ?? a.gmOnly ?? false),
  }));

  const rawTokens = raw.staged_tokens || raw.stagedTokens || [];
  const stagedTokens: StagedToken[] = rawTokens.map((t: any) => ({
    id: String(t.id),
    name: String(t.name || 'Token'),
    templateKey: t.monster_template_id || t.templateKey || 'Goblin',
    monsterTemplateId: t.monster_template_id || t.templateKey,
    x: Number(t.x ?? 0),
    y: Number(t.y ?? 0),
    elevationFt: Number(t.elevation_ft ?? t.elevationFt ?? 0),
    visibilityChannel: t.visibility || t.visibilityChannel || 'Public',
    ownerUserId: t.ownerUserId ?? null,
    hpCurrent: Number(t.hpCurrent ?? 10),
    hpMax: Number(t.hpMax ?? 10),
    sizeCells: Number(t.size_cells ?? t.sizeCells ?? 1),
    tokenAvatarUrl: t.token_avatar_url || t.tokenAvatarUrl,
  }));

  const rawSpawns = raw.spawn_points || raw.spawnPoints || [];
  const spawnPoints: SpawnPointConfig[] = rawSpawns.map((sp: any, idx: number) => ({
    id: String(sp.id || `sp-${idx}`),
    name: String(sp.name || `Spawn ${idx + 1}`),
    x: Number(sp.x ?? 0),
    y: Number(sp.y ?? 0),
  }));

  const firstSpawn = spawnPoints[0] || raw.spawnPoint || { x: 0, y: 0 };

  return {
    id: String(raw.id),
    campaignId: String(raw.campaign_id || raw.campaignId || ''),
    title: String(raw.name || raw.title || 'Untitled Scene'),
    revealedToPlayers: Boolean(raw.revealed_to_players ?? raw.revealedToPlayers ?? false),
    gridType: String(raw.grid_type || raw.gridType || 'square'),
    gridCellSizePx: Number(raw.grid_size_px ?? raw.gridCellSizePx ?? 70),
    feetPerCell: Number(raw.grid_cell_distance_ft ?? raw.feetPerCell ?? 5),
    widthPx: Number(raw.width_px ?? raw.widthPx ?? 1400),
    heightPx: Number(raw.height_px ?? raw.heightPx ?? 1400),
    backgroundImageUrl: raw.background_image_url || raw.backgroundImageUrl,
    defaultGroundElevationFt: Number(raw.default_ground_elevation_ft ?? raw.defaultGroundElevationFt ?? 0),
    spawnPoint: { x: Number(firstSpawn.x), y: Number(firstSpawn.y) },
    spawnPoints,
    walls,
    lights,
    audioEmitters,
    stagedTokens,
    exploredFogTexture: raw.explored_fog_texture || raw.exploredFogTexture,
    name: String(raw.name || raw.title || 'Untitled Scene'),
    campaign_id: String(raw.campaign_id || raw.campaignId || ''),
    revealed_to_players: Boolean(raw.revealed_to_players ?? raw.revealedToPlayers ?? false),
    grid_type: String(raw.grid_type || raw.gridType || 'square'),
    grid_size_px: Number(raw.grid_size_px ?? raw.gridCellSizePx ?? 70),
    grid_cell_distance_ft: Number(raw.grid_cell_distance_ft ?? raw.feetPerCell ?? 5),
    width_px: Number(raw.width_px ?? raw.widthPx ?? 1400),
    height_px: Number(raw.height_px ?? raw.heightPx ?? 1400),
    default_ground_elevation_ft: Number(raw.default_ground_elevation_ft ?? raw.defaultGroundElevationFt ?? 0),
    spawn_points: spawnPoints,
    wall_segments: walls,
    light_sources: lights,
    spatial_audio_emitters: audioEmitters,
    staged_tokens: stagedTokens,
  };
}

export function mapFrontendSceneToBackend(scene: CampaignMapScene): Record<string, any> {
  const wall_segments = scene.walls.map((w) => {
    let door_state: 'Open' | 'Closed' | 'Locked' | null = null;
    if (w.wallType === 'Door') {
      if (w.doorState?.isLocked) {
        door_state = 'Locked';
      } else if (w.doorState?.isOpen) {
        door_state = 'Open';
      } else {
        door_state = 'Closed';
      }
    } else if (w.wallType === 'SecretDoor') {
      door_state = w.secretDoorState?.isOpen ? 'Open' : 'Closed';
    }

    return {
      id: w.id,
      p1: { x: w.a.x, y: w.a.y },
      p2: { x: w.b.x, y: w.b.y },
      wall_type: w.wallType,
      door_state,
      bottom_elevation_ft: w.bottomElevationFt,
      top_elevation_ft: w.topElevationFt,
      blocks_light: w.blocksLight,
      blocks_movement: w.blocksMovement,
      blocks_sound: w.blocksSound,
      blocks_vision: w.blocksVision,
    };
  });

  const light_sources = scene.lights.map((l) => ({
    id: l.id,
    x: l.origin.x,
    y: l.origin.y,
    elevation_ft: l.elevationFt ?? 0,
    radius_ft: l.dimRadiusFt,
    color_hex: l.colorHex,
    intensity: l.intensity,
  }));

  const spatial_audio_emitters = scene.audioEmitters.map((a) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    elevation_ft: a.elevationFt,
    radius_ft: a.maxDistanceFt,
    volume: a.volume,
    looping: a.loopPlayback ?? true,
    gm_only: Boolean(a.gmOnly),
    audio_clip_url: a.url,
  }));

  const staged_tokens = scene.stagedTokens.map((t) => ({
    id: t.id,
    name: t.name,
    monster_template_id: t.monsterTemplateId ?? t.templateKey ?? null,
    x: t.x,
    y: t.y,
    elevation_ft: t.elevationFt,
    size_cells: t.sizeCells ?? 1,
    token_avatar_url: t.tokenAvatarUrl ?? null,
    visibility: t.visibilityChannel,
  }));

  const spawn_points = scene.spawnPoints && scene.spawnPoints.length > 0
    ? scene.spawnPoints.map((sp) => ({
        id: sp.id,
        name: sp.name,
        x: sp.x,
        y: sp.y,
      }))
    : scene.spawnPoint
    ? [{ id: 'sp-default', name: 'Default Spawn', x: scene.spawnPoint.x, y: scene.spawnPoint.y }]
    : [];

  return {
    id: scene.id,
    campaign_id: scene.campaignId,
    name: scene.title,
    grid_type: scene.gridType ?? 'square',
    grid_size_px: scene.gridCellSizePx,
    grid_cell_distance_ft: scene.feetPerCell,
    width_px: scene.widthPx,
    height_px: scene.heightPx,
    background_image_url: scene.backgroundImageUrl ?? null,
    default_ground_elevation_ft: scene.defaultGroundElevationFt ?? 0,
    revealed_to_players: scene.revealedToPlayers,
    spawn_points,
    wall_segments,
    light_sources,
    spatial_audio_emitters,
    staged_tokens,
    explored_fog_texture: scene.exploredFogTexture ?? null,
  };
}
