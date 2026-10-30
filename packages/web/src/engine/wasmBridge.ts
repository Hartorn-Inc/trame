export interface Point2D {
  x: number;
  y: number;
}

export interface WallSegmentDto {
  id: string;
  a: Point2D;
  b: Point2D;
  blocksVision: boolean;
  blocksMovement?: boolean;
  blocksSound?: boolean;
  bottomElevationFt: number;
  topElevationFt: number;
}

export interface DrawingEntity {
  id: string;
  points: [number, number][];
  color: string;
  lineWidth: number;
  isClosed: boolean;
  hasPhysicalWalls: boolean;
}

export type DiscretizationMode =
  | "CENTER_POINT"
  | "FIFTY_PERCENT"
  | "ANY_INTERSECTION"
  | "TOKEN_EUCLIDEAN";

export interface GridCell {
  col: number;
  row: number;
}

/**
 * Converts a vector drawing with `hasPhysicalWalls = true` into physical wall segments
 * blocking movement, vision, and sound (`docs/specs/e4-interactive-table-hud-combat-trac.md`).
 */
export function convertDrawingToWallSegments(
  drawing: DrawingEntity,
  bottomElevationFt = -1000,
  topElevationFt = 1000,
): WallSegmentDto[] {
  if (!drawing.hasPhysicalWalls || drawing.points.length < 2) {
    return [];
  }
  const walls: WallSegmentDto[] = [];
  for (let i = 0; i < drawing.points.length - 1; i++) {
    walls.push({
      id: `${drawing.id}-segment-${i}`,
      a: { x: drawing.points[i][0], y: drawing.points[i][1] },
      b: { x: drawing.points[i + 1][0], y: drawing.points[i + 1][1] },
      blocksVision: true,
      blocksMovement: true,
      blocksSound: true,
      bottomElevationFt,
      topElevationFt,
    });
  }
  if (drawing.isClosed && drawing.points.length >= 3) {
    const lastIdx = drawing.points.length - 1;
    walls.push({
      id: `${drawing.id}-segment-${lastIdx}`,
      a: { x: drawing.points[lastIdx][0], y: drawing.points[lastIdx][1] },
      b: { x: drawing.points[0][0], y: drawing.points[0][1] },
      blocksVision: true,
      blocksMovement: true,
      blocksSound: true,
      bottomElevationFt,
      topElevationFt,
    });
  }
  return walls;
}

/**
 * Computes a 2D radial visibility polygon around `origin` up to `maxRangePx`,
 * clipping rays against blocking walls whose vertical span intersects `observerEyeFt`.
 */
export function computeVisibilityPolygon(
  walls: WallSegmentDto[],
  origin: Point2D,
  observerEyeFt: number,
  maxRangePx: number,
): Point2D[] {
  const blockingWalls = walls.filter(
    (w) =>
      w.blocksVision &&
      observerEyeFt >= w.bottomElevationFt &&
      observerEyeFt <= w.topElevationFt,
  );

  const angles: number[] = [];
  const baseSteps = 36;
  for (let i = 0; i < baseSteps; i++) {
    angles.push((i * Math.PI * 2) / baseSteps - Math.PI);
  }

  const eps = 1e-4;
  for (const wall of blockingWalls) {
    for (const pt of [wall.a, wall.b]) {
      const dist = Math.hypot(pt.x - origin.x, pt.y - origin.y);
      if (dist <= maxRangePx + 1) {
        const base = Math.atan2(pt.y - origin.y, pt.x - origin.x);
        angles.push(base - eps, base, base + eps);
      }
    }
  }

  angles.sort((a, b) => a - b);

  const polygon: Point2D[] = [];
  for (const angle of angles) {
    const target: Point2D = {
      x: origin.x + Math.cos(angle) * maxRangePx,
      y: origin.y + Math.sin(angle) * maxRangePx,
    };
    let bestT = 1.0;
    let bestPt = target;

    for (const wall of blockingWalls) {
      const hit = intersectSegments(origin, target, wall.a, wall.b);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        bestPt = hit.point;
      }
    }
    polygon.push(bestPt);
  }

  return polygon;
}

/**
 * Previews discretized grid cells affected by a spherical AoE at 60 FPS on the client,
 * respecting wall-clipping (`stopsAtWalls`) and the campaign's `DiscretizationMode`.
 */
export function previewSphereAoeCells(
  origin: Point2D,
  radiusFt: number,
  cellSizePx: number,
  feetPerCell: number,
  mode: DiscretizationMode,
  stopsAtWalls: boolean,
  walls: WallSegmentDto[],
): GridCell[] {
  const radiusPx = (radiusFt / Math.max(1, feetPerCell)) * cellSizePx;
  const minCol = Math.floor((origin.x - radiusPx) / cellSizePx);
  const maxCol = Math.floor((origin.x + radiusPx) / cellSizePx);
  const minRow = Math.floor((origin.y - radiusPx) / cellSizePx);
  const maxRow = Math.floor((origin.y + radiusPx) / cellSizePx);

  const blockingWalls = stopsAtWalls ? walls.filter((w) => w.blocksVision) : [];
  const hasLos = (pt: Point2D): boolean => {
    for (const w of blockingWalls) {
      if (intersectSegments(origin, pt, w.a, w.b)) {
        return false;
      }
    }
    return true;
  };

  const cells: GridCell[] = [];
  for (let col = minCol; col <= maxCol; col++) {
    for (let row = minRow; row <= maxRow; row++) {
      const x0 = col * cellSizePx;
      const y0 = row * cellSizePx;
      const center = { x: x0 + cellSizePx * 0.5, y: y0 + cellSizePx * 0.5 };

      let included = false;
      if (mode === "CENTER_POINT" || mode === "TOKEN_EUCLIDEAN") {
        included =
          Math.hypot(center.x - origin.x, center.y - origin.y) <= radiusPx + 1e-6 &&
          hasLos(center);
      } else if (mode === "FIFTY_PERCENT") {
        let hits = 0;
        for (let ix = 0; ix < 4; ix++) {
          for (let iy = 0; iy < 4; iy++) {
            const sub = {
              x: x0 + ((ix + 0.5) / 4) * cellSizePx,
              y: y0 + ((iy + 0.5) / 4) * cellSizePx,
            };
            if (
              Math.hypot(sub.x - origin.x, sub.y - origin.y) <= radiusPx + 1e-6 &&
              hasLos(sub)
            ) {
              hits++;
            }
          }
        }
        included = hits >= 8;
      } else if (mode === "ANY_INTERSECTION") {
        const samples = [
          center,
          { x: x0, y: y0 },
          { x: x0 + cellSizePx, y: y0 },
          { x: x0, y: y0 + cellSizePx },
          { x: x0 + cellSizePx, y: y0 + cellSizePx },
        ];
        included = samples.some(
          (s) =>
            Math.hypot(s.x - origin.x, s.y - origin.y) <= radiusPx + 1e-6 && hasLos(s),
        );
      }

      if (included) {
        cells.push({ col, row });
      }
    }
  }
  return cells;
}

export function intersectSegments(
  p0: Point2D,
  p1: Point2D,
  q0: Point2D,
  q1: Point2D,
): { t: number; point: Point2D } | null {
  const rx = p1.x - p0.x;
  const ry = p1.y - p0.y;
  const sx = q1.x - q0.x;
  const sy = q1.y - q0.y;

  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-10) {
    return null;
  }

  const qpx = q0.x - p0.x;
  const qpy = q0.y - p0.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;

  if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
    const clampedT = Math.max(0, Math.min(1, t));
    return {
      t: clampedT,
      point: { x: p0.x + clampedT * rx, y: p0.y + clampedT * ry },
    };
  }
  return null;
}
