/**
 * ============================================================================
 * DYNAMIC LIGHTING SHADERS & DUAL-BUFFER FOG OF WAR (LightingShader.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Provides dual-backend GPU fragment shaders (WebGL2 GLSL 300 es and WebGPU WGSL)
 * for radial light falloff and monochrome Darkvision desaturation, a 32-byte
 * `std140`/WGSL uniform buffer packer (`packLightUniformBuffer`), and the
 * `DualBufferFogOfWar` state machine separating live line-of-sight (`VISIBLE`)
 * from previously explored terrain memory (`EXPLORED_MEMORY`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `WebGL2 / WebGPU Shader Parity`:
 *      - Both `RADIAL_LIGHT_GLSL_FRAG` and `RADIAL_LIGHT_WGSL_FRAG` discard
 *        fragments beyond `dimRadiusPx`, compute identical `smoothstep` bright/dim
 *        penumbra transitions (`0.85 * brightRadiusPx` to `brightRadiusPx`, and
 *        `brightRadiusPx` to `dimRadiusPx`), and use Rec. 601 luma coefficients
 *        `(0.299, 0.587, 0.114)` for monochrome Darkvision rendering.
 *   2. `32-Byte Aligned Uniform Packing`:
 *      - `packLightUniformBuffer` packs `LightSourceUniformInput` into an exact
 *        8-float (`32 bytes`) `Float32Array` where index `7` encodes both
 *        `intensity` magnitude and the `isDarkvisionMonochrome` sign bit (`-` for
 *        monochrome, `+` for full color).
 *   3. `Dual-Buffer Fog Privacy`:
 *      - `DualBufferFogOfWar` tracks `activeVisibleKeys` (alpha `0.0`) separately
 *        from cumulative `exploredKeys` (alpha `0.65`, hiding enemy tokens outside
 *        live LoS) and `UNEXPLORED` cells (opaque alpha `1.0`).
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. `packLightUniformBuffer(input)` -> `Float32Array(8)` (`32 bytes`) uploaded to GPU UBO.
 *   2. `RADIAL_LIGHT_GLSL_FRAG` / `RADIAL_LIGHT_WGSL_FRAG` shades each light source polygon.
 *   3. `DualBufferFogOfWar.updateVisibleCells(cells)` refreshes active LoS and promotes visited cells to explored memory.
 * ============================================================================
 */

import type { GridCell, Point2D } from "../engine/wasmBridge.ts";

/**
 * WebGL2 GLSL 300 es fragment shader source for radial light attenuation with
 * `smoothstep` penumbra falloff and Rec. 601 luma darkvision desaturation (`01-TABLE-SPEC.md`).
 */
export const RADIAL_LIGHT_GLSL_FRAG = `#version 300 es
precision highp float;

in vec2 vWorldPos;
out vec4 fragColor;

uniform vec2 uLightOrigin;
uniform float uBrightRadiusPx;
uniform float uDimRadiusPx;
uniform vec3 uLightColor;
uniform float uIntensity;
uniform float uIsDarkvisionMonochrome;

void main() {
  float dist = distance(vWorldPos, uLightOrigin);
  if (dist > uDimRadiusPx) {
    discard;
  }
  float brightFactor = 1.0 - smoothstep(uBrightRadiusPx * 0.85, uBrightRadiusPx, dist);
  float dimFactor = 1.0 - smoothstep(uBrightRadiusPx, uDimRadiusPx, dist);
  float falloff = max(brightFactor, dimFactor * 0.5) * uIntensity;
  vec3 color = mix(uLightColor, vec3(dot(uLightColor, vec3(0.299, 0.587, 0.114))), uIsDarkvisionMonochrome);
  fragColor = vec4(color * falloff, falloff);
}
`;

/**
 * WebGPU WGSL fragment shader equivalent of `RADIAL_LIGHT_GLSL_FRAG` for the
 * PixiJS v8 WebGPU rendering backend.
 */
export const RADIAL_LIGHT_WGSL_FRAG = `
struct LightUniforms {
  lightOrigin: vec2<f32>,
  brightRadiusPx: f32,
  dimRadiusPx: f32,
  lightColor: vec3<f32>,
  intensity: f32,
  isDarkvisionMonochrome: f32,
};

@group(0) @binding(0) var<uniform> u: LightUniforms;

@fragment
fn main(@location(0) vWorldPos: vec2<f32>) -> @location(0) vec4<f32> {
  let dist = distance(vWorldPos, u.lightOrigin);
  if (dist > u.dimRadiusPx) {
    discard;
  }
  let brightFactor = 1.0 - smoothstep(u.brightRadiusPx * 0.85, u.brightRadiusPx, dist);
  let dimFactor = 1.0 - smoothstep(u.brightRadiusPx, u.dimRadiusPx, dist);
  let falloff = max(brightFactor, dimFactor * 0.5) * u.intensity;
  let luma = dot(u.lightColor, vec3<f32>(0.299, 0.587, 0.114));
  let color = mix(u.lightColor, vec3<f32>(luma), u.isDarkvisionMonochrome);
  return vec4<f32>(color * falloff, falloff);
}
`;

/**
 * Parameters for a single radial point light source or darkvision emitter on the canvas.
 */
export interface LightSourceUniformInput {
  /** World-space origin of the light source in pixels (`px`). */
  origin: Point2D;
  /** Inner bright-light radius in pixels (`px`). */
  brightRadiusPx: number;
  /** Outer dim-light cutoff radius in pixels (`px`, `>= brightRadiusPx`). */
  dimRadiusPx: number;
  /** Normalized linear RGB color tuple `[r, g, b]` with components in `0.0..=1.0`. */
  rgb: [number, number, number];
  /** Scalar light intensity multiplier (`0.0..=1.0`). */
  intensity: number;
  /** When true, renders the vision cone in desaturated monochrome grayscale (Darkvision). */
  isDarkvisionMonochrome: boolean;
}

/**
 * Packs a `LightSourceUniformInput` into a 16-byte-aligned `Float32Array` (8 floats = `32 bytes`)
 * suitable for WebGL2 UBOs and WebGPU uniform buffers.
 *
 * Buffer layout (`32 bytes` total):
 * - `[0..1]`: `origin.x`, `origin.y` (`px`)
 * - `[2..3]`: `brightRadiusPx`, `dimRadiusPx` (`px`)
 * - `[4..6]`: `rgb[0]`, `rgb[1]`, `rgb[2]` (`0.0..=1.0`)
 * - `[7]`: signed `intensity` (negative when `isDarkvisionMonochrome === true`)
 */
export function packLightUniformBuffer(input: LightSourceUniformInput): Float32Array {
  const buf = new Float32Array(8);
  buf[0] = input.origin.x;
  buf[1] = input.origin.y;
  buf[2] = input.brightRadiusPx;
  buf[3] = input.dimRadiusPx;
  buf[4] = input.rgb[0];
  buf[5] = input.rgb[1];
  buf[6] = input.rgb[2];
  buf[7] = input.isDarkvisionMonochrome ? -Math.abs(input.intensity) : Math.abs(input.intensity);
  return buf;
}

/**
 * Visibility classification for a tactical grid cell in the Fog of War layer:
 * - `"UNEXPLORED"`: Never seen by the player (`alpha = 1.0`, completely black).
 * - `"EXPLORED_MEMORY"`: Previously visited terrain memory (`alpha = 0.65`, dynamic tokens hidden).
 * - `"VISIBLE"`: Currently within live line-of-sight (`alpha = 0.0`, fully revealed).
 */
export type FogVisibilityState = "UNEXPLORED" | "EXPLORED_MEMORY" | "VISIBLE";

/**
 * Dual-buffer Fog of War cell tracker:
 * - `UNEXPLORED`: opaque alpha `1.0`
 * - `EXPLORED_MEMORY`: dimmed terrain memory alpha `0.65` (tokens hidden)
 * - `VISIBLE`: live line-of-sight alpha `0.0`
 */
export class DualBufferFogOfWar {
  private readonly exploredKeys = new Set<string>();
  private readonly activeVisibleKeys = new Set<string>();

  /**
   * Replaces the current frame's `VISIBLE` cell set with `visibleCells` and
   * permanently records every visible cell into the cumulative `EXPLORED_MEMORY` set.
   */
  public updateVisibleCells(visibleCells: GridCell[]): void {
    this.activeVisibleKeys.clear();
    for (const cell of visibleCells) {
      const key = `${cell.col}:${cell.row}`;
      this.activeVisibleKeys.add(key);
      this.exploredKeys.add(key);
    }
  }

  /**
   * Clears both the active visibility buffer and explored memory buffer back to `"UNEXPLORED"`.
   */
  public resetFog(): void {
    this.exploredKeys.clear();
    this.activeVisibleKeys.clear();
  }

  /**
   * Returns the tri-state `FogVisibilityState` (`"VISIBLE"`, `"EXPLORED_MEMORY"`,
   * or `"UNEXPLORED"`) for grid coordinate `(col, row)`.
   */
  public getCellState(col: number, row: number): FogVisibilityState {
    const key = `${col}:${row}`;
    if (this.activeVisibleKeys.has(key)) {
      return "VISIBLE";
    }
    if (this.exploredKeys.has(key)) {
      return "EXPLORED_MEMORY";
    }
    return "UNEXPLORED";
  }

  /**
   * Returns the Fog of War overlay opacity (`0.0` for `"VISIBLE"`, `0.65` for
   * `"EXPLORED_MEMORY"`, or `1.0` for `"UNEXPLORED"`) for grid cell `(col, row)`.
   */
  public getCellOverlayAlpha(col: number, row: number): number {
    switch (this.getCellState(col, row)) {
      case "VISIBLE":
        return 0.0;
      case "EXPLORED_MEMORY":
        return 0.65;
      case "UNEXPLORED":
        return 1.0;
    }
  }
}
