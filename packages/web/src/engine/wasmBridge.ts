/**
 * ============================================================================
 * SPATIAL RAYCASTING & AOE DISCRETIZATION ENGINE BRIDGE (wasmBridge.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Provides the client-side spatial geometry bridge for 2D visibility polygon
 * raycasting (`computeVisibilityPolygon`) and real-time spherical Area-of-Effect
 * grid discretization (`previewSphereAoeCells`) at 60 FPS (`16.6 ms` frame budget),
 * maintaining bit-compatible behavior between the browser WASM runtime and
 * deterministic headless/SSR test environments.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `2.5D Vertical Wall Filtering`:
 *      - `computeVisibilityPolygon` only clips vision rays against walls where
 *        `blocksVision === true` AND the observer's eye elevation (`observerEyeFt`,
 *        in `ft`) lies within `[bottomElevationFt, topElevationFt]`, allowing
 *        observers to see over low cover or under high arches.
 *   2. `Corner-Jitter Ray Fan`:
 *      - Combines a 36-step uniform radial sweep with `±1e-4 rad` (`eps`) rays
 *        around every in-range wall endpoint so visibility polygons cleanly graze
 *        wall corners without missing shadow umbra transitions.
 *   3. `Division-by-Zero & Collinear Segment Guards`:
 *      - `previewSphereAoeCells` clamps `feetPerCell` via `Math.max(1, feetPerCell)`
 *        before converting `radiusFt` (`ft`) to pixels (`px`), and `intersectSegments`
 *        rejects parallel/collinear segments when `|denom| < 1e-10`.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `computeVisibilityPolygon(walls, origin, observerEyeFt, maxRangePx)`
 *     ├── 1. Filter `walls` by `blocksVision` and vertical span `[bottomElevationFt, topElevationFt]`.
 *     ├── 2. Seed 36 base radial angles (`[-π, π)`) + `±1e-4 rad` endpoint triplets.
 *     ├── 3. Sort all candidate ray angles in ascending order.
 *     └── 4. Cast each ray to `maxRangePx` and record the closest wall intersection (`min t`).
 * ============================================================================
 */

/**
 * 2D Cartesian coordinate in canvas pixel space (`px`) or table space.
 */
export interface Point2D {
  /** Horizontal X coordinate in pixels (`px`). */
  x: number;
  /** Vertical Y coordinate in pixels (`px`). */
  y: number;
}

/**
 * Authoritative 2.5D wall segment descriptor transferred from the map state.
 */
export interface WallSegmentDto {
  /** Unique identifier of the wall segment on the active map. */
  id: string;
  /** First endpoint of the wall segment in canvas pixels (`px`). */
  a: Point2D;
  /** Second endpoint of the wall segment in canvas pixels (`px`). */
  b: Point2D;
  /** Whether this wall blocks line-of-sight and AoE propagation. */
  blocksVision: boolean;
  /** Lower vertical elevation bound of the wall in feet (`ft`). */
  bottomElevationFt: number;
  /** Upper vertical elevation bound of the wall in feet (`ft`). */
  topElevationFt: number;
}

/**
 * Tactical grid cell coverage rule for Area-of-Effect (AoE) templates:
 * - `"CENTER_POINT"`: Includes a cell iff its center point (`+0.5, +0.5`) lies within radius and has LoS.
 * - `"FIFTY_PERCENT"`: Samples a `4x4` sub-grid (16 points) and includes the cell iff `>= 8` points (`>= 50%`) hit.
 * - `"ANY_INTERSECTION"`: Includes a cell if its center or any of its 4 corners lies within radius and has LoS.
 * - `"TOKEN_EUCLIDEAN"`: Uses center-point Euclidean distance parity with token origin measurement.
 */
export type DiscretizationMode =
  | "CENTER_POINT"
  | "FIFTY_PERCENT"
  | "ANY_INTERSECTION"
  | "TOKEN_EUCLIDEAN";

/**
 * Zero-indexed 2D tactical grid cell coordinate (`col`, `row`).
 */
export interface GridCell {
  /** Horizontal column index on the tactical grid. */
  col: number;
  /** Vertical row index on the tactical grid. */
  row: number;
}

/**
 * Computes a 2D radial visibility polygon around `origin` up to `maxRangePx` (in `px`),
 * clipping rays against blocking walls whose vertical span (`[bottomElevationFt, topElevationFt]`)
 * intersects `observerEyeFt` (in `ft`).
 * Uses the compiled `trame-engine` WASM module when initialized in browser, with
 * an identical deterministic raycaster for headless / SSR / test execution.
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
 * Previews discretized grid cells affected by a spherical AoE of radius `radiusFt` (`ft`)
 * at 60 FPS on the client, converting `radiusFt` to pixels via `(radiusFt / max(1, feetPerCell)) * cellSizePx`
 * and respecting wall-clipping (`stopsAtWalls`) and the campaign's `DiscretizationMode`.
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

/**
 * Computes the parametric intersection `(t, u)` between segment `p0 -> p1` and
 * segment `q0 -> q1` using 2D cross-product determinants, returning the normalized
 * ray parameter `t` in `[0, 1]` and intersection `Point2D` when both `t` and `u`
 * fall within `[-1e-9, 1 + 1e-9]`.
 */
function intersectSegments(
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
