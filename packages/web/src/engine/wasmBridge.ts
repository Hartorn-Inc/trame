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

export interface BoundingBox2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundingBoxFromSegment(a: Point2D, b: Point2D): BoundingBox2D {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function unionBoundingBoxes(b1: BoundingBox2D, b2: BoundingBox2D): BoundingBox2D {
  return {
    minX: Math.min(b1.minX, b2.minX),
    minY: Math.min(b1.minY, b2.minY),
    maxX: Math.max(b1.maxX, b2.maxX),
    maxY: Math.max(b1.maxY, b2.maxY),
  };
}

export function boxIntersectsSegment(box: BoundingBox2D, p0: Point2D, p1: Point2D): boolean {
  const segBox = boundingBoxFromSegment(p0, p1);
  return (
    box.minX <= segBox.maxX + 1e-9 &&
    box.maxX >= segBox.minX - 1e-9 &&
    box.minY <= segBox.maxY + 1e-9 &&
    box.maxY >= segBox.minY - 1e-9
  );
}

export interface RaycastHit {
  hit: boolean;
  t: number;
  point: Point2D;
  wallId: string;
}

export type BvhNode =
  | { kind: "leaf"; bbox: BoundingBox2D; wallIndex: number }
  | { kind: "internal"; bbox: BoundingBox2D; left: BvhNode; right: BvhNode };

function buildBvhNode(walls: WallSegmentDto[], indices: number[], depth: number): BvhNode | null {
  if (indices.length === 0) return null;
  if (indices.length === 1) {
    const idx = indices[0];
    const w = walls[idx];
    return {
      kind: "leaf",
      bbox: boundingBoxFromSegment(w.a, w.b),
      wallIndex: idx,
    };
  }

  const sorted = [...indices];
  if (depth % 2 === 0) {
    sorted.sort((i, j) => {
      const cxI = (walls[i].a.x + walls[i].b.x) * 0.5;
      const cxJ = (walls[j].a.x + walls[j].b.x) * 0.5;
      return cxI - cxJ;
    });
  } else {
    sorted.sort((i, j) => {
      const cyI = (walls[i].a.y + walls[i].b.y) * 0.5;
      const cyJ = (walls[j].a.y + walls[j].b.y) * 0.5;
      return cyI - cyJ;
    });
  }

  const mid = Math.floor(sorted.length / 2);
  const left = buildBvhNode(walls, sorted.slice(0, mid), depth + 1);
  const right = buildBvhNode(walls, sorted.slice(mid), depth + 1);
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;

  return {
    kind: "internal",
    bbox: unionBoundingBoxes(left.bbox, right.bbox),
    left,
    right,
  };
}

/**
 * 2.5D Bounding Volume Hierarchy for spatial raycasting and movement collision.
 */
export class Bvh2D {
  public walls: WallSegmentDto[] = [];
  public root: BvhNode | null = null;

  constructor(walls: WallSegmentDto[] = []) {
    this.build(walls);
  }

  public build(walls: WallSegmentDto[]): void {
    this.walls = [...walls];
    const indices = Array.from({ length: this.walls.length }, (_, i) => i);
    this.root = buildBvhNode(this.walls, indices, 0);
  }

  public raycast(
    origin: Point2D,
    target: Point2D,
    observerEyeFt = 0,
    targetEyeFt = 0,
  ): RaycastHit | null {
    if (!this.root) return null;

    let closestHit: RaycastHit | null = null;
    let closestT = 1.0 + 1e-9;

    const stack: BvhNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!boxIntersectsSegment(node.bbox, origin, target)) {
        continue;
      }

      if (node.kind === "leaf") {
        const wall = this.walls[node.wallIndex];
        const isVisionBlocking = wall.blocksVision !== false;
        if (!isVisionBlocking) continue;

        const hit = intersectSegments(origin, target, wall.a, wall.b);
        if (hit && hit.t < closestT) {
          const zAtT = observerEyeFt + hit.t * (targetEyeFt - observerEyeFt);
          if (zAtT >= wall.bottomElevationFt && zAtT <= wall.topElevationFt) {
            closestT = hit.t;
            closestHit = {
              hit: true,
              t: hit.t,
              point: hit.point,
              wallId: wall.id,
            };
          }
        }
      } else {
        stack.push(node.left, node.right);
      }
    }

    return closestHit;
  }

  public hasLineOfSight(
    origin: Point2D,
    observerEyeFt: number,
    target: Point2D,
    targetEyeFt: number,
    _hasTruesight = false,
  ): boolean {
    return this.raycast(origin, target, observerEyeFt, targetEyeFt) === null;
  }

  public checkMovementCollision(from: Point2D, to: Point2D): boolean {
    if (!this.root) return false;
    const stack: BvhNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!boxIntersectsSegment(node.bbox, from, to)) {
        continue;
      }
      if (node.kind === "leaf") {
        const wall = this.walls[node.wallIndex];
        const blocksMovement = wall.blocksMovement !== false;
        if (blocksMovement) {
          const hit = intersectSegments(from, to, wall.a, wall.b);
          if (hit) return true;
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    return false;
  }

  public computeVisibilityPolygon(
    origin: Point2D,
    observerEyeFt: number,
    maxRangePx: number,
  ): Point2D[] {
    return computeVisibilityPolygon(this.walls, origin, observerEyeFt, maxRangePx);
  }
}

export type SpatialEngineMode = "WASM" | "TYPESCRIPT_FALLBACK";

/**
 * Spatial raycasting and visibility engine with transparent TypeScript BVH fallback.
 */
export class WasmSpatialEngine {
  public engineMode: SpatialEngineMode = "TYPESCRIPT_FALLBACK";
  public bvh: Bvh2D;
  private wasmInstance: WebAssembly.Instance | null = null;

  constructor(walls: WallSegmentDto[] = []) {
    this.bvh = new Bvh2D(walls);
  }

  public setWalls(walls: WallSegmentDto[]): void {
    this.bvh.build(walls);
  }

  public async load(wasmSource?: string | Response | Promise<Response>): Promise<void> {
    try {
      if (
        typeof WebAssembly !== "undefined" &&
        typeof WebAssembly.instantiateStreaming === "function" &&
        wasmSource
      ) {
        const responsePromise = typeof wasmSource === "string" ? fetch(wasmSource) : wasmSource;
        const result = await WebAssembly.instantiateStreaming(responsePromise);
        this.wasmInstance = result.instance;
        this.engineMode = "WASM";
        return;
      }
      this.engineMode = "TYPESCRIPT_FALLBACK";
    } catch (_err) {
      this.engineMode = "TYPESCRIPT_FALLBACK";
    }
  }

  public raycast(
    origin: Point2D,
    target: Point2D,
    observerEyeFt = 0,
    targetEyeFt = 0,
  ): RaycastHit | null {
    if (this.engineMode === "WASM" && this.wasmInstance) {
      // WASM routing
    }
    return this.bvh.raycast(origin, target, observerEyeFt, targetEyeFt);
  }

  public hasLineOfSight(
    origin: Point2D,
    observerEyeFt: number,
    target: Point2D,
    targetEyeFt: number,
    hasTruesight = false,
  ): boolean {
    if (this.engineMode === "WASM" && this.wasmInstance) {
      // WASM routing
    }
    return this.bvh.hasLineOfSight(origin, observerEyeFt, target, targetEyeFt, hasTruesight);
  }

  public checkMovementCollision(from: Point2D, to: Point2D): boolean {
    return this.bvh.checkMovementCollision(from, to);
  }

  public computeVisibilityPolygon(
    origin: Point2D,
    observerEyeFt: number,
    maxRangePx: number,
  ): Point2D[] {
    return this.bvh.computeVisibilityPolygon(origin, observerEyeFt, maxRangePx);
  }
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
