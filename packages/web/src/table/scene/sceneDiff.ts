/**
 * ============================================================================
 * TABLE SCENE CHANGE DETECTION (table/scene/sceneDiff.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * `TableCanvas` rebuilds the `TableScene` draw list on every Preact render
 * (any signal change: a ping, a selection, a toast). Redrawing every PixiJS
 * layer each time recreated thousands of display objects per second and left
 * GPU resources to the garbage collector. This module tells the retained
 * renderer (`pixiSceneLayers.ts`) which layers and which keyed items (tokens,
 * lights) actually changed between two scenes, so it only touches those.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Value Signatures, Not References`:
 *    - Every scene is a fresh object graph, so identity says nothing. Each
 *      layer is summarised by a JSON signature of exactly the scene fields it
 *      draws; equal signatures mean the layer would draw the same pixels.
 * 2. `Complete Dependencies`:
 *    - A layer's signature includes the board size whenever the layer draws
 *      board-sized shapes (darkness, fog shroud), so a resize always redraws.
 * 3. `Stable Keys`:
 *    - Tokens and lights are diffed by id; an id present in both scenes with a
 *      different signature is `changed`, never `removed` + `added`, so the
 *      renderer can update its display object in place.
 * ============================================================================
 */
import type { SceneLight, SceneToken, TableScene } from "./tableScene.ts";

/** Board-wide layers the retained renderer redraws as a whole when their signature changes. */
export const SCENE_LAYER_KEYS = ["grid", "terrain", "walls", "aoes", "darkness", "fog"] as const;

export type SceneLayerKey = (typeof SCENE_LAYER_KEYS)[number];

/** Per-layer signatures of a scene (invariant 1). */
export type LayerSignatures = Record<SceneLayerKey, string>;

/** Ids that appeared, changed or disappeared between two keyed signature maps. */
export interface KeyedDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** Signature of every board-wide layer of `scene` (invariants 1 and 2). */
export function layerSignatures(scene: TableScene): LayerSignatures {
  const size = [scene.widthPx, scene.heightPx];
  return {
    grid: JSON.stringify([size, scene.cellPx, scene.grid]),
    terrain: JSON.stringify(scene.terrain),
    walls: JSON.stringify(scene.walls),
    aoes: JSON.stringify([scene.cellPx, scene.aoes]),
    darkness: JSON.stringify([size, scene.ambient, scene.lights.length > 0]),
    fog: JSON.stringify([size, scene.fog]),
  };
}

/** Layers whose signature differs; every layer when there is no previous scene. */
export function changedLayers(previous: LayerSignatures | null, next: LayerSignatures): SceneLayerKey[] {
  return SCENE_LAYER_KEYS.filter((key) => previous?.[key] !== next[key]);
}

/** Signature per token id. */
export function tokenSignatures(tokens: readonly SceneToken[]): Map<string, string> {
  return new Map(tokens.map((token) => [token.id, JSON.stringify(token)]));
}

/** Signature per light id. */
export function lightSignatures(lights: readonly SceneLight[]): Map<string, string> {
  return new Map(lights.map((light) => [light.id, JSON.stringify(light)]));
}

/** Keyed diff of two signature maps (invariant 3); ids keep the order of their map. */
export function diffKeyed(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): KeyedDiff {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, signature] of next) {
    if (!previous.has(id)) added.push(id);
    else if (previous.get(id) !== signature) changed.push(id);
  }
  const removed = [...previous.keys()].filter((id) => !next.has(id));
  return { added, changed, removed };
}
