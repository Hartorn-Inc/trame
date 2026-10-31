import type { ActiveTableRoomState, CampaignMapScene, StudioLightSource, StudioWallSegment, UserRole } from './types.ts';

export function filterScenesForRole(
  scenes: CampaignMapScene[],
  role: UserRole,
): CampaignMapScene[] {
  if (role === 'GM') {
    return scenes;
  }
  return scenes
    .filter((scene) => scene.revealedToPlayers)
    .map((scene) => ({
      ...scene,
      walls: scene.walls.map((wall) => {
        if (wall.wallType === 'SecretDoor' && !wall.secretDoorState?.isOpen) {
          return {
            ...wall,
            wallType: 'Normal',
            secretDoorState: undefined,
          };
        }
        if (wall.wallType === 'Illusion') {
          return {
            ...wall,
            wallType: 'Normal',
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
  const preservedHeroes = heroTokens.map((hero, index) => ({
    ...hero,
    x: targetScene.spawnPoint.x + index * 10,
    y: targetScene.spawnPoint.y,
  }));

  const nonHeroStaged = targetScene.stagedTokens.filter((t) => t.ownerUserId === null);

  return {
    activeSceneId: targetScene.id,
    walls: [...targetScene.walls],
    lights: [...targetScene.lights],
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
  const walls: StudioWallSegment[] = [];
  let wallCounter = 1;

  if (uvttJson.line_of_sight) {
    for (const poly of uvttJson.line_of_sight) {
      for (let i = 0; i < poly.length - 1; i++) {
        walls.push({
          id: `uvtt-wall-${wallCounter++}`,
          a: { x: poly[i].x, y: poly[i].y },
          b: { x: poly[i + 1].x, y: poly[i + 1].y },
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
          a: { x: portal.bounds[0].x, y: portal.bounds[0].y },
          b: { x: portal.bounds[1].x, y: portal.bounds[1].y },
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
    origin: { x: l.position.x, y: l.position.y },
    brightRadiusFt: l.range * 0.5,
    dimRadiusFt: l.range,
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
