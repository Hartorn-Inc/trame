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

/**
 * Computes multi-segment waypoint distance in feet across the tactical canvas.
 */
export function measureRulerWaypointsFt(
  waypoints: Point2D[],
  cellSizePx: number,
  feetPerCell: number,
  isSqueezing = false,
): number {
  if (waypoints.length < 2) {
    return 0;
  }
  const pxPerFt = cellSizePx / Math.max(1, feetPerCell);
  let totalFt = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    const distPx = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    totalFt += distPx / pxPerFt;
  }
  return isSqueezing ? totalFt * 2 : totalFt;
}
