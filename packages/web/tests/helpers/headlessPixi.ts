/**
 * ============================================================================
 * HEADLESS PIXIJS HARNESS (tests/helpers/headlessPixi.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lets Node tests build real PixiJS scene objects (Container, Graphics, Text,
 * Mesh, Shader, filters) without a browser or GPU, and inspect the resulting
 * display list for the resource-lifetime bugs PixiJS reports at render time
 * ("[BindGroup] a 'TextureSource' was destroyed while still bound to a
 * shader", "[MaskFilter] The mask texture was destroyed while the mask is
 * still in use").
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `No GPU`:
 *    - PixiJS probes shader precision through a throwaway WebGL context when
 *      a program is created. The adapter's canvas returns no context, so the
 *      probe falls back to `mediump` instead of touching `document`.
 * 2. `Strings And Booleans Only`:
 *    - PixiJS objects are large cyclic graphs. Like `domAssert.ts`, these
 *      helpers return paths, counts and booleans, never the objects, so a
 *      failing `node:assert` never runs `util.inspect` on a scene graph.
 * ============================================================================
 */
import { Container, DOMAdapter, Mesh, Sprite } from "pixi.js";

/** Installs a canvas factory with no WebGL context (invariant 1). Call before creating filters or shaders. */
export function installHeadlessPixi(): void {
  DOMAdapter.set({
    ...DOMAdapter.get(),
    createCanvas: (width = 0, height = 0) => ({ width, height, style: {}, getContext: () => null }) as unknown as HTMLCanvasElement,
  });
}

/** A shader or filter after `destroy()` has dropped its programs. */
function isDestroyedShader(shader: unknown): boolean {
  const s = shader as { glProgram?: unknown; gpuProgram?: unknown } | null;
  return !s || (s.glProgram == null && s.gpuProgram == null);
}

/**
 * Paths of live display objects that still reference a destroyed resource:
 * a sprite's texture, a mesh's shader or geometry, a mask, a filter. Each one
 * would make PixiJS warn (or throw) on the next frame. Empty means clean.
 */
export function danglingResources(root: Container): string[] {
  const found: string[] = [];
  const visit = (node: Container, path: string) => {
    if (node.destroyed) {
      found.push(`${path}: destroyed object still in the display list`);
      return;
    }
    if (node instanceof Sprite && node.texture.destroyed) found.push(`${path}: sprite texture destroyed`);
    if (node instanceof Mesh) {
      if (isDestroyedShader(node.shader)) found.push(`${path}: mesh shader destroyed`);
      // `Geometry.destroy()` has no flag; it nulls its buffers.
      if ((node.geometry as { buffers?: unknown } | null)?.buffers == null) found.push(`${path}: mesh geometry destroyed`);
    }
    const mask = node.mask as Container | null;
    if (mask && mask.destroyed) found.push(`${path}: mask destroyed`);
    for (const filter of node.filters ?? []) if (isDestroyedShader(filter)) found.push(`${path}: filter destroyed`);
    node.children.forEach((child, i) => visit(child, `${path}/${child.label || i}`));
  };
  visit(root, root.label || "stage");
  return found;
}

/** Every display object under `root`, depth first. */
export function displayObjects(root: Container): Container[] {
  const out: Container[] = [];
  const visit = (node: Container) => {
    out.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return out;
}

/** True when `before` and `after` hold the same display objects in the same order (nothing recreated). */
export function sameObjects(before: Container[], after: Container[]): boolean {
  return before.length === after.length && before.every((node, i) => node === after[i]);
}

/** Records `console.warn` messages until `stop()`; PixiJS logs its resource warnings there. */
export function captureWarnings(): { stop(): string[] } {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return {
    stop() {
      console.warn = original;
      return messages;
    },
  };
}
