/**
 * ============================================================================
 * MAPS STUDIO WALL DRAWING GEOMETRY (maps/wallDrawing.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Turns a pointer drag on the studio's SVG canvas into a `StudioWallSegment`
 * of the selected `WallType`: maps screen coordinates into scene pixels
 * (undoing the SVG `viewBox` fit), snaps both ends to grid corners, and sets
 * the permeability flags of the kind. Pure so the drawing rules are tested
 * without a DOM.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Letterbox-Aware Mapping`:
 *    - The SVG uses the default `preserveAspectRatio="xMidYMid meet"`, so the
 *      scene is scaled by `min(rectW / sceneW, rectH / sceneH)` and centred;
 *      `scenePoint` removes that offset before dividing, then clamps to the
 *      scene so a release outside the map never stores an off-map wall.
 * 2. `No Degenerate Walls`:
 *    - A drag whose snapped ends coincide returns `null` (it was a click).
 * 3. `Kind Decides Flags`:
 *    - `wallFlagsFor` is the single source of the default movement / vision
 *      / light / sound flags per kind (Window lets sight and light through,
 *      Illusion lets bodies and sound through, Terrain lets sound through).
 * 4. `One-Way Walls Carry Their Normal`:
 *    - A drawn one-way wall stores the engine's default normal for its drag
 *      direction (sight going "down" a left-to-right drag is blocked), and
 *      `flipOneWay` negates it, so what the studio arrow shows is what the
 *      engine enforces after save.
 * ============================================================================
 */
import { oneWayNormal } from '../canvas/wallGlyphs.ts';
import type { Point2D } from '../engine/wasmBridge.ts';
import type { StudioWallSegment, WallType } from './types.ts';

/** Screen rectangle of the SVG element (`getBoundingClientRect`). */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Default permeability of a wall kind (invariant 3). */
export function wallFlagsFor(type: WallType): Pick<StudioWallSegment, 'blocksMovement' | 'blocksVision' | 'blocksLight' | 'blocksSound'> {
  return {
    blocksMovement: type !== 'Illusion',
    blocksVision: type !== 'Window',
    blocksLight: type !== 'Window',
    blocksSound: type !== 'Illusion' && type !== 'Terrain',
  };
}

/** Scene pixel under a screen point of the fitted SVG, clamped to the scene (invariant 1). */
export function scenePoint(rect: ScreenRect, sceneW: number, sceneH: number, clientX: number, clientY: number): Point2D | null {
  if (rect.width <= 0 || rect.height <= 0 || sceneW <= 0 || sceneH <= 0) return null;
  const scale = Math.min(rect.width / sceneW, rect.height / sceneH);
  const offsetX = (rect.width - sceneW * scale) / 2;
  const offsetY = (rect.height - sceneH * scale) / 2;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return {
    x: Math.round(clamp((clientX - rect.left - offsetX) / scale, sceneW)),
    y: Math.round(clamp((clientY - rect.top - offsetY) / scale, sceneH)),
  };
}

/** Nearest grid corner of `point` (`cellPx <= 0` leaves it unchanged). */
export function snapToGridCorner(point: Point2D, cellPx: number): Point2D {
  if (cellPx <= 0) return point;
  return { x: Math.round(point.x / cellPx) * cellPx, y: Math.round(point.y / cellPx) * cellPx };
}

/** Wall of `type` from a drag, or `null` when both ends coincide (invariant 2). */
export function wallFromDrag(
  id: string,
  start: Point2D,
  end: Point2D,
  type: WallType,
  bottomElevationFt: number,
  topElevationFt: number,
): StudioWallSegment | null {
  if (start.x === end.x && start.y === end.y) return null;
  return {
    id,
    a: start,
    b: end,
    wallType: type,
    ...wallFlagsFor(type),
    bottomElevationFt,
    topElevationFt,
    oneWayNormal: type === 'OneWay' ? oneWayNormal(start, end, null) : undefined,
    doorState: type === 'Door' ? { isOpen: false, isLocked: false } : undefined,
    secretDoorState: type === 'SecretDoor' ? { isOpen: false } : undefined,
  };
}

/** The one-way wall with its blocking side swapped (invariant 4); other walls unchanged. */
export function flipOneWay(wall: StudioWallSegment): StudioWallSegment {
  if (wall.wallType !== 'OneWay') return wall;
  const n = oneWayNormal(wall.a, wall.b, wall.oneWayNormal ?? null);
  return { ...wall, oneWayNormal: { x: -n.x || 0, y: -n.y || 0 } };
}
