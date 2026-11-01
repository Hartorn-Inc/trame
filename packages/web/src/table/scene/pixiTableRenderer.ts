/**
 * ============================================================================
 * PIXIJS LIVE TABLE ADAPTER (table/scene/pixiTableRenderer.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Draws a `TableScene` (built by `tableScene.ts`) with PixiJS v8 into the
 * board's `<canvas>`. It owns no game logic: every colour, polygon and ring
 * arrives in the draw list, so this module only maps descriptors onto the
 * seven `TACTICAL_SCENE_LAYERS` containers. `TableCanvas` loads it lazily
 * with a dynamic `import()`, which keeps PixiJS out of the entry chunk.
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
 * 3. `Redraw From Scratch`:
 *    - `update` clears and redraws every layer from the scene, so the canvas
 *      never shows state the latest projection no longer contains.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `createTableRenderer(canvas, scene)`
 * ├── 1. `Application.init({ canvas, preference: "webgl" })`, reject non-WebGL.
 * └── 2. One `Container` per tactical layer, in spec order.
 * `update(scene, mapImage)`
 * ├── 1. Resize, battlemap sprite, grid + walls, AoE cells, tokens.
 * ├── 2. Ambient darkness (offscreen) with `RADIAL_LIGHT_GLSL_FRAG` meshes
 * │      erasing each light's falloff, plus a faint additive coloured glow.
 * ├── 3. Fog rectangle with an inverse vision mask, GM hide cells on top.
 * └── 4. Render; animate pings on `requestAnimationFrame` while any is live.
 * ============================================================================
 */
import "pixi.js/unsafe-eval";
import { AlphaFilter, Application, Container, Graphics, Mesh, MeshGeometry, Shader, Sprite, Text, Texture } from "pixi.js";
import { RADIAL_LIGHT_GLSL_FRAG } from "../../canvas/LightingShader.ts";
import { TACTICAL_SCENE_LAYERS, type TacticalSceneLayerId } from "../../canvas/SceneGraph.ts";
import type { Point2D } from "../../engine/wasmBridge.ts";
import { circlePoints, dashPolyline, pingRing, type SceneLight, type SceneRing, type SceneWall, type TableScene } from "./tableScene.ts";

/** Pairs with `RADIAL_LIGHT_GLSL_FRAG`: passes canvas-pixel positions through as `vWorldPos`. */
const LIGHT_VERTEX_GLSL = `in vec2 aPosition;
out vec2 vWorldPos;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vWorldPos = aPosition;
}
`;

const RING_WIDTH_PX = 3;
const MARKER_PX = 4;
/** Share of a light's intensity added as coloured glow over the lit area. */
const LIGHT_GLOW_SCALE = 0.2;

export interface TableRenderer {
  /** Redraws the canvas from `scene`; `mapImage` is the decoded battlemap, if any. */
  update(scene: TableScene, mapImage: HTMLImageElement | null): void;
  destroy(): void;
}

function strokePath(g: Graphics, points: Point2D[], closed: boolean, dash: readonly [number, number] | null, style: { width: number; color: number; alpha?: number }) {
  if (points.length < 2) return;
  if (dash) {
    for (const [a, b] of dashPolyline(points, dash, closed)) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  } else {
    g.poly(points.flatMap((p) => [p.x, p.y]), closed);
  }
  g.stroke({ ...style, alpha: style.alpha ?? 1 });
}

function drawRing(g: Graphics, center: Point2D, radius: number, ring: SceneRing) {
  const style = { width: ring.style === "double" ? 2 : RING_WIDTH_PX, color: ring.color };
  strokePath(g, circlePoints(center, radius), true, ring.style === "dashed" ? ring.dash : null, style);
  if (ring.style === "double") strokePath(g, circlePoints(center, radius - 4), true, null, style);
}

function drawWallMarker(g: Graphics, at: Point2D, wall: SceneWall) {
  const s = MARKER_PX;
  const fill = { color: wall.color, alpha: wall.alpha };
  switch (wall.marker) {
    case "square":
      g.rect(at.x - s / 2, at.y - s / 2, s, s).fill(fill);
      break;
    case "diamond":
      g.poly([at.x, at.y - s, at.x + s, at.y, at.x, at.y + s, at.x - s, at.y]).fill(fill);
      break;
    case "slash":
    case "chevron": {
      const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
      const nx = (-(wall.b.y - wall.a.y) / len) * s;
      const ny = ((wall.b.x - wall.a.x) / len) * s;
      g.moveTo(at.x - nx, at.y - ny).lineTo(at.x + nx, at.y + ny).stroke({ width: 2, color: wall.color, alpha: wall.alpha });
      break;
    }
    case "none":
      break;
  }
}

/** Triangle fan over a star-shaped polygon around `origin`. */
function fanGeometry(origin: Point2D, polygon: Point2D[]): MeshGeometry {
  const positions = new Float32Array([origin.x, origin.y, ...polygon.flatMap((p) => [p.x, p.y])]);
  const indices = new Uint32Array(polygon.length * 3);
  for (let i = 0; i < polygon.length; i++) {
    indices.set([0, i + 1, ((i + 1) % polygon.length) + 1], i * 3);
  }
  return new MeshGeometry({ positions, indices });
}

/**
 * Light falloff mesh. `"erase"` meshes cut the falloff out of the darkness
 * overlay (full intensity); `"add"` meshes lay a faint coloured glow on top.
 */
function lightMesh(light: SceneLight, blendMode: "erase" | "add"): Mesh<MeshGeometry, Shader> {
  const intensity = blendMode === "add" ? light.intensity * LIGHT_GLOW_SCALE : light.intensity;
  const shader = Shader.from({
    gl: { vertex: LIGHT_VERTEX_GLSL, fragment: RADIAL_LIGHT_GLSL_FRAG },
    resources: {
      lightUniforms: {
        uLightOrigin: { value: new Float32Array([light.origin.x, light.origin.y]), type: "vec2<f32>" },
        uBrightRadiusPx: { value: light.brightPx, type: "f32" },
        uDimRadiusPx: { value: light.dimPx, type: "f32" },
        uLightColor: { value: new Float32Array(light.rgb), type: "vec3<f32>" },
        uSignedIntensity: { value: intensity, type: "f32" },
      },
    },
  });
  const mesh = new Mesh({ geometry: fanGeometry(light.origin, light.polygon ?? circlePoints(light.origin, light.dimPx)), shader });
  mesh.blendMode = blendMode;
  return mesh;
}

/** Destroys every child of `layer` (graphics, text, meshes and their GPU data). */
function clearLayer(layer: Container) {
  for (const child of layer.removeChildren()) child.destroy({ children: true });
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

  const layers = Object.fromEntries(
    TACTICAL_SCENE_LAYERS.map((id) => {
      const layer = new Container({ label: id });
      app.stage.addChild(layer);
      return [id, layer];
    }),
  ) as Record<TacticalSceneLayerId, Container>;

  const fontFamily = getComputedStyle(canvas).fontFamily;
  /** Renders the darkness into its own texture so `"erase"` lights cannot erase the map below. */
  const offscreen = new AlphaFilter();
  let mapTexture: Texture | null = null;
  let mapSource: HTMLImageElement | null = null;
  let current = initial;
  let frame = 0;

  const drawMap = (scene: TableScene, image: HTMLImageElement | null) => {
    if (image !== mapSource) {
      mapTexture?.destroy(true);
      mapTexture = image ? Texture.from(image) : null;
      mapSource = image;
    }
    clearLayer(layers.backgroundMap);
    if (!mapTexture) return;
    const sprite = new Sprite(mapTexture);
    sprite.width = scene.widthPx;
    sprite.height = scene.heightPx;
    layers.backgroundMap.addChild(sprite);
  };

  const drawGridAndWalls = (scene: TableScene) => {
    clearLayer(layers.gridOverlay);
    const grid = new Graphics();
    for (let x = 0; x <= scene.widthPx; x += scene.cellPx) grid.moveTo(x, 0).lineTo(x, scene.heightPx);
    for (let y = 0; y <= scene.heightPx; y += scene.cellPx) grid.moveTo(0, y).lineTo(scene.widthPx, y);
    grid.stroke({ width: 1, color: scene.grid.color, alpha: scene.grid.alpha });
    const walls = new Graphics();
    for (const wall of scene.walls) {
      strokePath(walls, [wall.a, wall.b], false, wall.dash, { width: wall.widthPx, color: wall.color, alpha: wall.alpha });
      drawWallMarker(walls, wall.a, wall);
      drawWallMarker(walls, wall.b, wall);
    }
    layers.gridOverlay.addChild(grid, walls);
  };

  const drawAoes = (scene: TableScene) => {
    clearLayer(layers.aoeTemplates);
    const g = new Graphics();
    for (const aoe of scene.aoes) {
      for (const cell of aoe.cells) g.rect(cell.x, cell.y, cell.w, cell.h);
      if (aoe.cells.length > 0) g.fill({ color: aoe.fill, alpha: aoe.fillAlpha });
      const s = scene.cellPx / 4;
      g.moveTo(aoe.origin.x - s, aoe.origin.y).lineTo(aoe.origin.x + s, aoe.origin.y);
      g.moveTo(aoe.origin.x, aoe.origin.y - s).lineTo(aoe.origin.x, aoe.origin.y + s);
      g.stroke({ width: 2, color: aoe.stroke });
    }
    layers.aoeTemplates.addChild(g);
  };

  const drawTokens = (scene: TableScene) => {
    clearLayer(layers.tokens);
    for (const token of scene.tokens) {
      const g = new Graphics();
      g.circle(token.center.x, token.center.y, token.radiusPx).fill(token.fill);
      drawRing(g, token.center, token.radiusPx, token.ring);
      if (token.highlight) drawRing(g, token.center, token.radiusPx + 5, token.highlight);
      const label = new Text({
        text: token.initials,
        style: { fontFamily, fontSize: Math.max(10, token.radiusPx * 0.7), fontWeight: "600", fill: token.labelColor },
      });
      label.anchor.set(0.5);
      label.position.set(token.center.x, token.center.y);
      layers.tokens.addChild(g, label);
    }
  };

  const drawLighting = (scene: TableScene) => {
    clearLayer(layers.lightingAndVisionMask);
    if (scene.ambient.alpha <= 0) return;
    const shade = new Container();
    shade.filters = [offscreen];
    shade.addChild(
      new Graphics().rect(0, 0, scene.widthPx, scene.heightPx).fill({ color: scene.ambient.tint, alpha: scene.ambient.alpha }),
      ...scene.lights.map((light) => lightMesh(light, "erase")),
    );
    layers.lightingAndVisionMask.addChild(shade, ...scene.lights.map((light) => lightMesh(light, "add")));
  };

  const drawFog = (scene: TableScene) => {
    clearLayer(layers.fogOfWar);
    const fog = scene.fog;
    if (!fog) return;
    const shroud = new Graphics().rect(0, 0, scene.widthPx, scene.heightPx).fill({ color: fog.color, alpha: fog.alpha });
    const holes = new Graphics();
    for (const polygon of fog.vision) if (polygon.length >= 3) holes.poly(polygon.flatMap((p) => [p.x, p.y]));
    for (const cell of fog.reveal) holes.rect(cell.x, cell.y, cell.w, cell.h);
    const hide = new Graphics();
    for (const cell of fog.hide) hide.rect(cell.x, cell.y, cell.w, cell.h);
    if (fog.hide.length > 0) hide.fill({ color: fog.color, alpha: fog.alpha });
    const hasHoles = fog.vision.some((polygon) => polygon.length >= 3) || fog.reveal.length > 0;
    if (hasHoles) {
      holes.fill(fog.color);
      layers.fogOfWar.addChild(holes);
      shroud.setMask({ mask: holes, inverse: true });
    }
    layers.fogOfWar.addChild(shroud, hide);
  };

  /** Draws live pings; returns whether any ping is still running. */
  const drawPings = (scene: TableScene, nowMs: number): boolean => {
    clearLayer(layers.uiControlHud);
    const g = new Graphics();
    let live = false;
    for (const ping of scene.pings) {
      const { radiusPx, alpha } = pingRing(ping, nowMs, scene.cellPx, scene.reducedMotion);
      if (alpha <= 0) continue;
      live = true;
      g.circle(ping.pos.x, ping.pos.y, radiusPx).stroke({ width: RING_WIDTH_PX, color: ping.color, alpha });
    }
    layers.uiControlHud.addChild(g);
    return live;
  };

  const animatePings = () => {
    cancelAnimationFrame(frame);
    const tick = () => {
      const live = drawPings(current, Date.now());
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
      drawMap(scene, mapImage);
      drawGridAndWalls(scene);
      drawAoes(scene);
      drawTokens(scene);
      drawLighting(scene);
      drawFog(scene);
      const live = drawPings(scene, Date.now());
      app.render();
      if (live) animatePings();
    },
    destroy() {
      cancelAnimationFrame(frame);
      mapTexture?.destroy(true);
      offscreen.destroy();
      app.destroy({ removeView: false }, { children: true });
    },
  };
}
