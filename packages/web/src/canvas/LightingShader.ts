import type { GridCell, Point2D } from "../engine/wasmBridge.ts";

/**
 * WebGL2 GLSL 300 es fragment shader for radial light attenuation with smoothstep penumbra
 * and darkvision desaturation (`01-TABLE-SPEC.md`).
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
 * WebGPU WGSL fragment shader equivalent for PixiJS v8 WebGPU renderer.
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

export interface LightSourceUniformInput {
  origin: Point2D;
  brightRadiusPx: number;
  dimRadiusPx: number;
  rgb: [number, number, number];
  intensity: number;
  isDarkvisionMonochrome: boolean;
}

/**
 * Packs a `LightSourceUniformInput` into a 16-byte-aligned `Float32Array` (8 floats = 32 bytes)
 * suitable for WebGL2 UBOs and WebGPU uniform buffers.
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

export type FogVisibilityState = "UNEXPLORED" | "EXPLORED_MEMORY" | "VISIBLE";

/**
 * Dual-buffer Fog of War cell tracker with snapshot rollback support:
 * - `UNEXPLORED`: opaque alpha `1.0`
 * - `EXPLORED_MEMORY`: dimmed terrain memory alpha `0.65` (tokens hidden)
 * - `VISIBLE`: live line-of-sight alpha `0.0`
 */
export class DualBufferFogOfWar {
  private readonly exploredKeys = new Set<string>();
  private readonly activeVisibleKeys = new Set<string>();
  private readonly snapshots = new Map<number | string, { explored: Set<string>; visible: Set<string> }>();

  public updateVisibleCells(visibleCells: GridCell[]): void {
    this.activeVisibleKeys.clear();
    for (const cell of visibleCells) {
      const key = `${cell.col}:${cell.row}`;
      this.activeVisibleKeys.add(key);
      this.exploredKeys.add(key);
    }
  }

  public resetFog(): void {
    this.exploredKeys.clear();
    this.activeVisibleKeys.clear();
    this.snapshots.clear();
  }

  public captureSnapshot(snapshotId: number | string): void {
    this.snapshots.set(snapshotId, {
      explored: new Set(this.exploredKeys),
      visible: new Set(this.activeVisibleKeys),
    });
  }

  public rollbackSnapshot(snapshotId: number | string): boolean {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) {
      return false;
    }
    this.exploredKeys.clear();
    for (const key of snap.explored) {
      this.exploredKeys.add(key);
    }
    this.activeVisibleKeys.clear();
    for (const key of snap.visible) {
      this.activeVisibleKeys.add(key);
    }
    return true;
  }

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
