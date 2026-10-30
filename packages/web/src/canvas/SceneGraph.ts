import type { Point2D } from "../engine/wasmBridge.ts";

/**
 * Canonical 7-layer PixiJS v8 tactical scene graph order specified in `01-TABLE-SPEC.md`.
 */
export const TACTICAL_SCENE_LAYERS = [
  "backgroundMap",
  "gridOverlay",
  "aoeTemplates",
  "tokens",
  "lightingAndVisionMask",
  "fogOfWar",
  "uiControlHud",
] as const;

export type TacticalSceneLayerId = (typeof TACTICAL_SCENE_LAYERS)[number];

export interface CameraTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export class ViewportCamera {
  private offsetX = 0;
  private offsetY = 0;
  private scale = 1;
  private readonly minScale = 0.15;
  private readonly maxScale = 4.0;

  public getTransform(): CameraTransform {
    return { offsetX: this.offsetX, offsetY: this.offsetY, scale: this.scale };
  }

  public pan(deltaScreenX: number, deltaScreenY: number): void {
    this.offsetX += deltaScreenX;
    this.offsetY += deltaScreenY;
  }

  public zoomAtCursor(zoomFactor: number, screenX: number, screenY: number): void {
    const worldBefore = this.screenToWorld({ x: screenX, y: screenY });
    const nextScale = Math.max(
      this.minScale,
      Math.min(this.maxScale, this.scale * zoomFactor),
    );
    this.scale = nextScale;
    this.offsetX = screenX - worldBefore.x * this.scale;
    this.offsetY = screenY - worldBefore.y * this.scale;
  }

  public screenToWorld(screen: Point2D): Point2D {
    return {
      x: (screen.x - this.offsetX) / this.scale,
      y: (screen.y - this.offsetY) / this.scale,
    };
  }

  public worldToScreen(world: Point2D): Point2D {
    return {
      x: world.x * this.scale + this.offsetX,
      y: world.y * this.scale + this.offsetY,
    };
  }
}

export type RulerMetric =
  | "FIVE_FIVE_FIVE"
  | "FIVE_TEN_FIVE"
  | "EUCLIDEAN"
  | "FiveFiveFive"
  | "FiveTenFive"
  | "Euclidean"
  | "5-5-5"
  | "5-10-5";

export interface Waypoint3D {
  x: number;
  y: number;
  z?: number;
  elevationFt?: number;
}

/**
 * Computes multi-segment waypoint distance in feet across the tactical canvas,
 * supporting 5-5-5 (Chebyshev 3D), 5-10-5 (D&D 5e alternation + 3D hypotenuse),
 * and Euclidean 3D metrics (`docs/specs/e4-interactive-table-hud-combat-trac.md`).
 */
export function measureRulerWaypointsFt(
  waypoints: Waypoint3D[],
  cellSizePx: number | RulerMetric = 1,
  feetPerCell = 1,
  metricOrSqueezing: RulerMetric | boolean = "EUCLIDEAN",
  isSqueezing = false,
): number {
  if (waypoints.length < 2) {
    return 0;
  }

  let effectiveCellSizePx = 1;
  let effectiveFeetPerCell = 1;
  let metric: RulerMetric = "EUCLIDEAN";
  let squeezing = isSqueezing;

  if (typeof cellSizePx === "string") {
    metric = cellSizePx;
    effectiveCellSizePx = 1;
    effectiveFeetPerCell = 1;
    if (typeof feetPerCell === "boolean") {
      squeezing = feetPerCell;
    }
  } else {
    effectiveCellSizePx = cellSizePx;
    effectiveFeetPerCell = feetPerCell;
    if (typeof metricOrSqueezing === "boolean") {
      squeezing = metricOrSqueezing;
      metric = "EUCLIDEAN";
    } else if (typeof metricOrSqueezing === "string") {
      metric = metricOrSqueezing;
    }
  }

  const pxPerFt = effectiveCellSizePx / Math.max(1, effectiveFeetPerCell);
  const normMetric = String(metric).toUpperCase().replace(/[-_]/g, "");

  let totalFt = 0;
  let cumulativeDiagSteps = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    const dxFt = Math.abs(curr.x - prev.x) / pxPerFt;
    const dyFt = Math.abs(curr.y - prev.y) / pxPerFt;
    const prevZ = prev.elevationFt ?? prev.z ?? 0;
    const currZ = curr.elevationFt ?? curr.z ?? 0;
    const dzFt = Math.abs(currZ - prevZ);

    let segDistFt = 0;
    if (normMetric === "FIVEFIVEFIVE" || normMetric === "555") {
      segDistFt = Math.max(dxFt, dyFt, dzFt);
    } else if (normMetric === "FIVETENFIVE" || normMetric === "5105") {
      const dDiag = Math.min(dxFt, dyFt);
      const dStr = Math.max(dxFt, dyFt) - dDiag;
      const nDiag = Math.floor(dDiag / 5.0);
      const diagRemainderFt = dDiag - nDiag * 5.0;
      let diagCostFt = 0;
      for (let step = 0; step < nDiag; step++) {
        diagCostFt += (cumulativeDiagSteps + step) % 2 === 1 ? 10.0 : 5.0;
      }
      cumulativeDiagSteps += nDiag;
      const d2D = dStr + diagCostFt + diagRemainderFt;
      segDistFt = Math.sqrt(d2D * d2D + dzFt * dzFt);
    } else {
      segDistFt = Math.sqrt(dxFt * dxFt + dyFt * dyFt + dzFt * dzFt);
    }
    totalFt += segDistFt;
  }

  return squeezing ? totalFt * 2 : totalFt;
}
