/**
 * ============================================================================
 * TACTICAL SCENE GRAPH, VIEWPORT CAMERA & WAYPOINT RULER (SceneGraph.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Defines the canonical 7-layer PixiJS v8 rendering stack order
 * (`TACTICAL_SCENE_LAYERS`), the cursor-anchored `ViewportCamera` affine
 * transformation matrix (`pan`, `zoomAtCursor`, `screenToWorld`, `worldToScreen`),
 * and the multi-segment tactical movement ruler (`measureRulerWaypointsFt`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Strict Z-Index Layer Ordering`:
 *      - `TACTICAL_SCENE_LAYERS` fixes the 7 rendering layers from bottom
 *        (`backgroundMap`) to top (`uiControlHud`) so Fog of War (`fogOfWar`)
 *        and lighting masks (`lightingAndVisionMask`) always occlude `tokens`
 *        and `aoeTemplates` while keeping HUD controls (`uiControlHud`) legible.
 *   2. `Zoom Scale Clamping & Cursor Invariance`:
 *      - `ViewportCamera.zoomAtCursor` clamps `scale` to `[0.15, 4.0]` (`15%` to
 *        `400%`) and solves for `(offsetX, offsetY)` so the world point under
 *        the cursor (`screenX, screenY`) remains stationary before and after zooming.
 *   3. `Squeezing Movement Cost Multiplier`:
 *      - `measureRulerWaypointsFt` converts pixel Euclidean segment lengths to
 *        table feet (`ft`) and doubles the total distance (`* 2`) when
 *        `isSqueezing === true` per D&D 5e tactical movement rules.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `ViewportCamera.zoomAtCursor(zoomFactor, screenX, screenY)`
 *     ├── 1. Project `(screenX, screenY)` into world coordinates (`worldBefore`) at current `scale`.
 *     ├── 2. Clamp `scale * zoomFactor` to `[0.15, 4.0]`.
 *     └── 3. Re-anchor `offsetX = screenX - worldBefore.x * scale` (and `offsetY`).
 * ============================================================================
 */

import type { Point2D } from "../engine/wasmBridge.ts";

/**
 * Canonical 7-layer PixiJS v8 tactical scene graph order specified in `01-TABLE-SPEC.md`,
 * ordered from backmost (`index 0`) to frontmost (`index 6`).
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

/**
 * Union of the 7 valid tactical scene graph layer identifiers.
 */
export type TacticalSceneLayerId = (typeof TACTICAL_SCENE_LAYERS)[number];

/**
 * 2D affine translation and uniform scale parameters for the tactical canvas viewport.
 */
export interface CameraTransform {
  /** Horizontal translation offset in screen pixels (`px`). */
  offsetX: number;
  /** Vertical translation offset in screen pixels (`px`). */
  offsetY: number;
  /** Uniform zoom scale factor clamped to `[0.15, 4.0]`. */
  scale: number;
}

/**
 * Manages pan and cursor-centered zoom transformations between screen pixel space
 * and world map pixel space on the tactical canvas.
 */
export class ViewportCamera {
  private offsetX = 0;
  private offsetY = 0;
  private scale = 1;
  private readonly minScale = 0.15;
  private readonly maxScale = 4.0;

  /**
   * Returns a snapshot of the current camera translation (`offsetX`, `offsetY` in `px`)
   * and zoom `scale` (`0.15..=4.0`).
   */
  public getTransform(): CameraTransform {
    return { offsetX: this.offsetX, offsetY: this.offsetY, scale: this.scale };
  }

  /**
   * Translates the camera viewport by `(deltaScreenX, deltaScreenY)` in screen pixels (`px`).
   */
  public pan(deltaScreenX: number, deltaScreenY: number): void {
    this.offsetX += deltaScreenX;
    this.offsetY += deltaScreenY;
  }

  /**
   * Multiplies the camera zoom by `zoomFactor` (clamped to `[0.15, 4.0]`) while
   * adjusting `offsetX` and `offsetY` so the world coordinate beneath `(screenX, screenY)`
   * remains fixed on screen.
   */
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

  /**
   * Converts a 2D point from screen pixel coordinates (`px`) into world map coordinates (`px`).
   */
  public screenToWorld(screen: Point2D): Point2D {
    return {
      x: (screen.x - this.offsetX) / this.scale,
      y: (screen.y - this.offsetY) / this.scale,
    };
  }

  /**
   * Converts a 2D point from world map coordinates (`px`) into screen pixel coordinates (`px`).
   */
  public worldToScreen(world: Point2D): Point2D {
    return {
      x: world.x * this.scale + this.offsetX,
      y: world.y * this.scale + this.offsetY,
    };
  }
}

/**
 * Computes multi-segment waypoint distance in feet (`ft`) across the tactical canvas,
 * scaling pixel distance by `cellSizePx / max(1, feetPerCell)` and doubling movement
 * cost when `isSqueezing === true`.
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
