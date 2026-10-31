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
  blocksLight?: boolean;
  blocksSound?: boolean;
  bottomElevationFt: number;
  topElevationFt: number;
  kind?: unknown;
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

export interface BoundingBox2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RaycastHit {
  point: Point2D;
  t: number;
  wallId: string;
  wall: WallSegmentDto;
}

export function computeBoundingBox(points: Point2D[]): BoundingBox2D {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

export function rayIntersectsAabb(
  origin: Point2D,
  target: Point2D,
  box: BoundingBox2D,
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;

  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) > 1e-9) {
    const tx1 = (box.minX - origin.x) / dx;
    const tx2 = (box.maxX - origin.x) / dx;
    tmin = Math.max(tmin, Math.min(tx1, tx2));
    tmax = Math.min(tmax, Math.max(tx1, tx2));
  } else if (origin.x < box.minX || origin.x > box.maxX) {
    return false;
  }

  if (Math.abs(dy) > 1e-9) {
    const ty1 = (box.minY - origin.y) / dy;
    const ty2 = (box.maxY - origin.y) / dy;
    tmin = Math.max(tmin, Math.min(ty1, ty2));
    tmax = Math.min(tmax, Math.max(ty1, ty2));
  } else if (origin.y < box.minY || origin.y > box.maxY) {
    return false;
  }

  return tmax >= tmin && tmax >= 0 && tmin <= 1;
}

export class Bvh2DNode {
  public bbox: BoundingBox2D;
  public left: Bvh2DNode | null = null;
  public right: Bvh2DNode | null = null;
  public walls: WallSegmentDto[] = [];

  constructor(walls: WallSegmentDto[], maxLeafSize = 4) {
    const pts: Point2D[] = [];
    for (const w of walls) {
      pts.push(w.a, w.b);
    }
    this.bbox = pts.length > 0 ? computeBoundingBox(pts) : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    if (walls.length <= maxLeafSize) {
      this.walls = walls;
      return;
    }

    const dx = this.bbox.maxX - this.bbox.minX;
    const dy = this.bbox.maxY - this.bbox.minY;
    const sortKey = dx >= dy ? (w: WallSegmentDto) => (w.a.x + w.b.x) * 0.5 : (w: WallSegmentDto) => (w.a.y + w.b.y) * 0.5;

    const sorted = [...walls].sort((w1, w2) => sortKey(w1) - sortKey(w2));
    const mid = Math.floor(sorted.length / 2);
    this.left = new Bvh2DNode(sorted.slice(0, mid), maxLeafSize);
    this.right = new Bvh2DNode(sorted.slice(mid), maxLeafSize);
  }
}

export class Bvh2D {
  public root: Bvh2DNode | null = null;
  private allWalls: WallSegmentDto[] = [];

  constructor(walls: WallSegmentDto[] = []) {
    this.build(walls);
  }

  public build(walls: WallSegmentDto[]): void {
    this.allWalls = [...walls];
    if (walls.length === 0) {
      this.root = null;
    } else {
      this.root = new Bvh2DNode(this.allWalls);
    }
  }

  public getWalls(): WallSegmentDto[] {
    return this.allWalls;
  }

  public raycast(
    origin: Point2D,
    target: Point2D,
    observerEyeFt = 5,
    targetEyeFt = 5,
  ): RaycastHit | null {
    if (!this.root) return null;

    let closestHit: RaycastHit | null = null;
    let minT = 1.0;

    const traverse = (node: Bvh2DNode) => {
      if (!rayIntersectsAabb(origin, target, node.bbox)) {
        return;
      }
      if (node.walls.length > 0) {
        for (const wall of node.walls) {
          if (!wall.blocksVision) continue;
          const hit = intersectSegments(origin, target, wall.a, wall.b);
          if (hit && hit.t < minT) {
            const zAtT = observerEyeFt + hit.t * (targetEyeFt - observerEyeFt);
            if (zAtT >= wall.bottomElevationFt && zAtT <= wall.topElevationFt) {
              minT = hit.t;
              closestHit = {
                point: hit.point,
                t: hit.t,
                wallId: wall.id,
                wall,
              };
            }
          }
        }
      }
      if (node.left) traverse(node.left);
      if (node.right) traverse(node.right);
    };

    traverse(this.root);
    return closestHit;
  }

  public hasLineOfSight(
    origin: Point2D,
    target: Point2D,
    observerEyeFt = 5,
    targetEyeFt = 5,
  ): boolean {
    return this.raycast(origin, target, observerEyeFt, targetEyeFt) === null;
  }

  public checkCollision(
    from: Point2D,
    to: Point2D,
    elevationFt = 0,
  ): boolean {
    if (!this.root) return false;

    let collided = false;
    const traverse = (node: Bvh2DNode) => {
      if (collided) return;
      if (!rayIntersectsAabb(from, to, node.bbox)) return;
      if (node.walls.length > 0) {
        for (const wall of node.walls) {
          const blocksMove = wall.blocksMovement !== false;
          if (!blocksMove) continue;
          const hit = intersectSegments(from, to, wall.a, wall.b);
          if (hit) {
            if (elevationFt >= wall.bottomElevationFt && elevationFt <= wall.topElevationFt) {
              collided = true;
              return;
            }
          }
        }
      }
      if (node.left) traverse(node.left);
      if (node.right) traverse(node.right);
    };

    traverse(this.root);
    return collided;
  }
}

export type SpatialEngineMode = "WASM" | "TYPESCRIPT_FALLBACK";

export class WasmSpatialEngine {
  public engineMode: SpatialEngineMode = "TYPESCRIPT_FALLBACK";
  public bvh: Bvh2D = new Bvh2D();
  public wasmInstance: unknown = null;

  public async init(wasmSource?: string | Response | Promise<Response>): Promise<void> {
    try {
      if (
        typeof WebAssembly !== "undefined" &&
        typeof WebAssembly.instantiateStreaming === "function" &&
        wasmSource
      ) {
        const res = typeof wasmSource === "string" ? fetch(wasmSource) : wasmSource;
        const result = await WebAssembly.instantiateStreaming(res);
        this.wasmInstance = result.instance;
        this.engineMode = "WASM";
        return;
      }
    } catch {
      // Fall back to TypeScript
    }
    this.engineMode = "TYPESCRIPT_FALLBACK";
  }

  public setWalls(walls: WallSegmentDto[]): void {
    this.bvh.build(walls);
  }

  public raycast(
    origin: Point2D,
    target: Point2D,
    observerEyeFt = 5,
    targetEyeFt = 5,
  ): RaycastHit | null {
    return this.bvh.raycast(origin, target, observerEyeFt, targetEyeFt);
  }

  public hasLineOfSight(
    origin: Point2D,
    target: Point2D,
    observerEyeFt = 5,
    targetEyeFt = 5,
  ): boolean {
    return this.bvh.hasLineOfSight(origin, target, observerEyeFt, targetEyeFt);
  }

  public checkCollision(from: Point2D, to: Point2D, elevationFt = 0): boolean {
    return this.bvh.checkCollision(from, to, elevationFt);
  }
}

export const wasmSpatialEngine = new WasmSpatialEngine();

export function evaluateAoeTargets(
  origin: Point2D,
  radiusFt: number,
  tokens: Array<{ id: string; topLeft: Point2D; [key: string]: unknown }>,
  cellSizePx = 100,
  feetPerCell = 5,
): string[] {
  const pxPerFt = cellSizePx / Math.max(1, feetPerCell);
  const radiusPx = radiusFt * pxPerFt;
  const affectedTokenIds: string[] = [];
  for (const token of tokens) {
    const dist = Math.hypot(token.topLeft.x - origin.x, token.topLeft.y - origin.y);
    if (dist <= radiusPx) {
      affectedTokenIds.push(token.id);
    }
  }
  return affectedTokenIds;
}

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
