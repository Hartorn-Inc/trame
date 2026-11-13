/**
 * ============================================================================
 * PIXIJS LIVE TABLE ADAPTER (table/scene/pixiTableRenderer.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Owns the PixiJS `Application` on the board's `<canvas>` and feeds each
 * `TableScene` (built by `tableScene.ts`) to the retained layers of
 * `pixiSceneLayers.ts`. It owns no game logic and draws nothing itself: it
 * manages the WebGL context, the battlemap texture, rendering and the ping
 * animation. `TableCanvas` loads it lazily with a dynamic `import()`, which
 * keeps PixiJS out of the entry chunk.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Strict CSP Without unsafe-eval`:
 *    - `pixi.js/unsafe-eval` swaps PixiJS's generated (`new Function`)
 *      uniform/UBO/shader sync code for interpreted polyfills and disables its
 *      eval probes, so the renderer runs under `script-src 'self'
 *      'wasm-unsafe-eval'`.
 *    - The battlemap reaches PixiJS as an already-decoded `HTMLImageElement`
 *      (`Texture.from`). The `Assets` loader is never used: its texture path
 *      spawns `ImageBitmap` workers from blob URLs, which the CSP forbids.
 * 2. `WebGL Only`:
 *    - Fog holes use an inverse stencil mask, and `RADIAL_LIGHT_GLSL_FRAG` is
 *      GLSL. PixiJS's Canvas2D renderer ignores inverse masks (the fog would
 *      invert), so any renderer other than WebGL is destroyed and `create`
 *      rejects; the caller keeps its DOM board.
 * 3. `Battlemap Texture Ownership`:
 *    - The adapter creates the texture from the decoded image and destroys
 *      the previous one only after `sync` pointed the sprite elsewhere; on
 *      `destroy` the layers go first, then the texture, then the app, so no
 *      live object ever references a destroyed texture source.
 * 4. `Incremental Updates`:
 *    - `update` hands the scene to the retained layers, which redraw only
 *      what changed (`sceneDiff.ts`), then renders one frame.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `createTableRenderer(canvas, scene)`
 * ├── 1. `Application.init({ canvas, preference: "webgl" })`, reject non-WebGL.
 * └── 2. `createSceneLayers(app.stage)`.
 * `update(scene, mapImage)`
 * ├── 1. Resize; new battlemap image -> new texture.
 * ├── 2. `layers.sync(scene, texture)`; then destroy the replaced texture.
 * └── 3. Render; animate pings on `requestAnimationFrame` while any is live.
 * ============================================================================
 */
import "pixi.js/unsafe-eval";
import { Application, Texture } from "pixi.js";
import { createSceneLayers } from "./pixiSceneLayers.ts";
import type { TableScene } from "./tableScene.ts";

export interface TableRenderer {
  /** Brings the canvas in line with `scene`; `mapImage` is the decoded battlemap, if any. */
  update(scene: TableScene, mapImage: HTMLImageElement | null): void;
  destroy(): void;
}

/**
 * Initialises PixiJS on `canvas` and returns the table renderer. Rejects when
 * WebGL is unavailable so the caller can keep its DOM board.
 */
export async function createTableRenderer(canvas: HTMLCanvasElement, initial: TableScene): Promise<TableRenderer> {
  const app = new Application();
  await app.init({
    canvas,
    width: initial.widthPx,
    height: initial.heightPx,
    preference: "webgl",
    background: initial.voidColor,
    antialias: true,
    autoDensity: true,
    resolution: globalThis.devicePixelRatio || 1,
    autoStart: false,
    sharedTicker: false,
  });
  if (app.renderer.name !== "webgl") {
    app.destroy({ removeView: false });
    throw new Error(`table renderer needs WebGL, got ${app.renderer.name}`);
  }

  const layers = createSceneLayers(app.stage, getComputedStyle(canvas).fontFamily);
  let mapTexture: Texture | null = null;
  let mapSource: HTMLImageElement | null = null;
  let current = initial;
  let frame = 0;

  const animatePings = () => {
    cancelAnimationFrame(frame);
    const tick = () => {
      const live = layers.drawPings(current, Date.now());
      app.render();
      frame = live ? requestAnimationFrame(tick) : 0;
    };
    frame = requestAnimationFrame(tick);
  };

  return {
    update(scene, mapImage) {
      current = scene;
      if (app.renderer.width !== scene.widthPx || app.renderer.height !== scene.heightPx) {
        app.renderer.resize(scene.widthPx, scene.heightPx);
      }
      app.renderer.background.color = scene.voidColor;
      const replaced = mapImage !== mapSource ? mapTexture : null;
      if (mapImage !== mapSource) {
        mapTexture = mapImage ? Texture.from(mapImage) : null;
        mapSource = mapImage;
      }
      layers.sync(scene, mapTexture);
      replaced?.destroy(true);
      const live = layers.drawPings(scene, Date.now());
      app.render();
      if (live) animatePings();
    },
    destroy() {
      cancelAnimationFrame(frame);
      layers.destroy();
      mapTexture?.destroy(true);
      app.destroy({ removeView: false }, { children: true });
    },
  };
}
