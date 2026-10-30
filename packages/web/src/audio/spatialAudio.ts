import { type Point2D, type WallSegmentDto, intersectSegments } from "../engine/wasmBridge.ts";

export interface AudioEmitterConfig {
  id: string;
  url: string;
  x: number;
  y: number;
  elevationFt: number;
  maxDistanceFt: number;
  refDistanceFt: number;
  rolloff: number;
  loopPlayback: boolean;
  volume: number;
}

export interface AudioListenerPosition {
  x: number;
  y: number;
  elevationFt: number;
}

export interface EmitterRuntimeState {
  emitter: AudioEmitterConfig;
  distance: number;
  gain: number;
  cutoffFrequency: number;
}

/**
 * Computes 3D Euclidean distance between emitter and listener taking into account elevation $\Delta Z$.
 */
export function compute3DDistance(
  emitter: { x: number; y: number; elevationFt: number },
  listener: AudioListenerPosition,
): number {
  const dx = emitter.x - listener.x;
  const dy = emitter.y - listener.y;
  const dz = emitter.elevationFt - listener.elevationFt;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Computes free-field acoustic attenuation gain according to the inverse distance model.
 */
export function computeDistanceAttenuation(
  distance: number,
  refDistanceFt: number,
  rolloff: number,
): number {
  if (distance <= refDistanceFt) {
    return 1.0;
  }
  const gain = refDistanceFt / (refDistanceFt + rolloff * (distance - refDistanceFt));
  return Math.max(0.0, Math.min(1.0, gain));
}

/**
 * Computes low-pass filter cutoff frequency in Hertz given the count of crossed sound-blocking walls ($N_{walls}$).
 * Follows $f_{cutoff} = \frac{20000.0}{1.0 + 3.5 \times N_{walls}}$ rounded to two decimal places.
 */
export function computeOcclusionLowPassCutoff(nWalls: number): number {
  const count = Math.max(0, nWalls);
  const raw = 20000.0 / (1.0 + 3.5 * count);
  return Math.round(raw * 100) / 100;
}

/**
 * Raycasts between emitter and listener, counting all walls with `blocksSound !== false`
 * whose vertical span intersects the ray elevation.
 */
export function countSoundOccludingWalls(
  emitter: { x: number; y: number; elevationFt: number },
  listener: AudioListenerPosition,
  walls: WallSegmentDto[],
): number {
  const p0: Point2D = { x: emitter.x, y: emitter.y };
  const p1: Point2D = { x: listener.x, y: listener.y };
  let count = 0;

  for (const wall of walls) {
    if (wall.blocksSound === false) {
      continue;
    }
    const hit = intersectSegments(p0, p1, wall.a, wall.b);
    if (hit && hit.t > 1e-6 && hit.t < 1.0 - 1e-6) {
      const rayZ = emitter.elevationFt + hit.t * (listener.elevationFt - emitter.elevationFt);
      if (rayZ >= wall.bottomElevationFt && rayZ <= wall.topElevationFt) {
        count++;
      }
    }
  }
  return count;
}

export const MAX_CONCURRENT_RAYCASTS = 16;

/**
 * WebAudio Spatial Audio Manager enforcing 3D geometric attenuation,
 * low-pass acoustic wall occlusion, and bounded concurrency of 16 raycasts per update cycle.
 */
export class SpatialAudioManager {
  private emitters = new Map<string, EmitterRuntimeState>();
  private listener: AudioListenerPosition = { x: 0, y: 0, elevationFt: 0 };
  private lastCycleRaycastCount = 0;

  public upsertEmitter(emitter: AudioEmitterConfig): void {
    const existing = this.emitters.get(emitter.id);
    const initialCutoff = existing ? existing.cutoffFrequency : 20000;
    const dist = compute3DDistance(emitter, this.listener);
    const gain = computeDistanceAttenuation(dist, emitter.refDistanceFt, emitter.rolloff);
    this.emitters.set(emitter.id, {
      emitter: { ...emitter },
      distance: dist,
      gain,
      cutoffFrequency: initialCutoff,
    });
  }

  public removeEmitter(emitterId: string): void {
    this.emitters.delete(emitterId);
  }

  public updateListener(pos: AudioListenerPosition): void {
    this.listener = { ...pos };
  }

  public getListener(): AudioListenerPosition {
    return { ...this.listener };
  }

  public updateOcclusionAndAttenuation(walls: WallSegmentDto[]): void {
    const emitterList = Array.from(this.emitters.entries()).map(([id, state]) => {
      const dist = compute3DDistance(state.emitter, this.listener);
      const gain = computeDistanceAttenuation(dist, state.emitter.refDistanceFt, state.emitter.rolloff);
      return { id, state, dist, gain };
    });

    emitterList.sort((a, b) => a.dist - b.dist);

    let raycastCount = 0;
    for (let i = 0; i < emitterList.length; i++) {
      const item = emitterList[i];
      let cutoff = item.state.cutoffFrequency;

      if (i < MAX_CONCURRENT_RAYCASTS) {
        const nWalls = countSoundOccludingWalls(item.state.emitter, this.listener, walls);
        cutoff = computeOcclusionLowPassCutoff(nWalls);
        raycastCount++;
      }

      this.emitters.set(item.id, {
        ...item.state,
        distance: item.dist,
        gain: item.gain,
        cutoffFrequency: cutoff,
      });
    }

    this.lastCycleRaycastCount = raycastCount;
  }

  public getLastCycleRaycastCount(): number {
    return this.lastCycleRaycastCount;
  }

  public getEmitterState(emitterId: string): EmitterRuntimeState | undefined {
    return this.emitters.get(emitterId);
  }

  public getEmitters(): AudioEmitterConfig[] {
    return Array.from(this.emitters.values()).map((s) => ({ ...s.emitter }));
  }

  public dispose(): void {
    this.emitters.clear();
  }
}
