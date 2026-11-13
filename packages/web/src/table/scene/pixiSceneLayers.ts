/**
 * ============================================================================
 * RETAINED PIXIJS TABLE LAYERS (table/scene/pixiSceneLayers.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Keeps one long-lived PixiJS display list for the live table and brings it
 * in line with each new `TableScene`, touching only what changed. The old
 * adapter destroyed and recreated every Graphics, Text, Mesh and Shader on
 * every Preact render, leaked mesh geometries and shaders (PixiJS never
 * destroys them with their mesh), and destroyed the battlemap texture while
 * its sprite still referenced it, which PixiJS reports as
 * "[BindGroup] a 'TextureSource' was destroyed while still bound to a shader".
 *
 * The module depends only on PixiJS scene objects (no `Application`, no GPU),
 * so `tests/table/pixiSceneLayers.test.ts` drives it in Node with real PixiJS
 * objects and checks that no live object references a destroyed resource.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Long-Lived Display Objects`:
 *    - Board-wide layers (grid, terrain hatch, walls, AoEs, darkness, fog,
 *      pings) are single `Graphics` objects created once and `clear()`ed and
 *      redrawn only when `changedLayers` reports their signature changed.
 * 2. `Keyed Items Update In Place`:
 *    - Each token keeps its container, body `Graphics` and initials `Text`
 *      across moves and HP changes; only `diffKeyed` additions create objects
 *      and only removals destroy them.
 *    - A changed light rebuilds its two meshes (falloff erase + glow); an
 *      unchanged light keeps them.
 * 3. `Release After Unbind`:
 *    - Nothing destroys a resource that a live object still uses: the map
 *      sprite is pointed at `Texture.EMPTY` before the caller may destroy the
 *      previous battlemap texture, and a light mesh is destroyed before its
 *      shader and geometry (`Mesh.destroy` releases neither).
 *    - `destroy()` tears the display list down; textures it does not own
 *      (the battlemap) stay with the caller, who destroys them afterwards.
 * 4. `Masks Only With Holes`:
 *    - The fog shroud uses its holes `Graphics` as an inverse stencil mask
 *      only while there are holes; with none the mask is removed so PixiJS
 *      never clips the shroud against empty bounds.
 * 5. `Darkvision Is Per Viewer`:
 *    - `scene.darkvision` (null unless the viewing token has darkvision in
 *      pitch darkness) masks a desaturated copy of the battlemap to the
 *      darkvision area and a full-colour copy to the lit parts of it, and
 *      erases `thinDarkness` of the darkness overlay there so the area reads
 *      as dim light in shades of grey (SRD 5.2.1).
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `createSceneLayers(stage, fontFamily)` -> one `Container` per tactical layer.
 * `sync(scene, mapTexture)`
 * ├── 1. Map sprite: texture swap (or `Texture.EMPTY`) and board size.
 * ├── 2. `changedLayers(previous, next)` -> redraw those `Graphics`.
 * ├── 3. `diffKeyed` tokens -> add / update in place / destroy.
 * └── 4. `diffKeyed` lights -> rebuild changed meshes, release removed ones.
 * `drawPings(scene, nowMs)` -> redraw the ping `Graphics` (animation frames).
 * ============================================================================
 */
import { AlphaFilter, ColorMatrixFilter, Container, Graphics, Mesh, MeshGeometry, Shader, Sprite, Text, Texture } from "pixi.js";
import { RADIAL_LIGHT_GLSL_FRAG } from "../../canvas/LightingShader.ts";
import { TACTICAL_SCENE_LAYERS, type TacticalSceneLayerId } from "../../canvas/SceneGraph.ts";
import type { Point2D } from "../../engine/wasmBridge.ts";
import { changedLayers, diffKeyed, layerSignatures, lightSignatures, tokenSignatures, type KeyedDiff, type LayerSignatures, type SceneLayerKey } from "./sceneDiff.ts";
import { circlePoints, dashPolyline, pingRing, type SceneLight, type SceneRing, type SceneToken, type SceneWall, type TableScene } from "./tableScene.ts";

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

/** What one `sync` changed; the tests read it to prove updates stay incremental. */
export interface SyncReport {
  /** Board-wide layers redrawn, in `SCENE_LAYER_KEYS` order. */
  layers: SceneLayerKey[];
  tokens: KeyedDiff;
  lights: KeyedDiff;
  /** The map sprite switched texture (or lost it). */
  mapChanged: boolean;
}

export interface SceneLayers {
  /** Brings the display list in line with `scene`; `mapTexture` is the battlemap, owned by the caller. */
  sync(scene: TableScene, mapTexture: Texture | null): SyncReport;
  /** Rasterises token labels at `resolution` texels per board pixel (canvas resolution times zoom) so they stay sharp when zoomed. */
  setTextResolution(resolution: number): void;
  /** Redraws live pings at `nowMs`; returns whether any ping is still running. */
  drawPings(scene: TableScene, nowMs: number): boolean;
  /** Destroys every display object this module created (invariant 3). */
  destroy(): void;
}

interface TokenView {
  root: Container;
  body: Graphics;
  label: Text;
}

interface LightMesh {
  mesh: Mesh<MeshGeometry, Shader>;
  shader: Shader;
  geometry: MeshGeometry;
}

interface LightView {
  erase: LightMesh;
  glow: LightMesh;
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
function lightMesh(light: SceneLight, blendMode: "erase" | "add"): LightMesh {
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
  const geometry = fanGeometry(light.origin, light.polygon ?? circlePoints(light.origin, light.dimPx));
  const mesh = new Mesh({ geometry, shader });
  mesh.blendMode = blendMode;
  return { mesh, shader, geometry };
}

/** Mesh first, then what it used (invariant 3). */
function releaseLightMesh(view: LightMesh) {
  view.mesh.destroy();
  view.shader.destroy();
  view.geometry.destroy(true);
}

function drawToken(view: TokenView, token: SceneToken, fontFamily: string) {
  view.body.clear();
  view.body.circle(token.center.x, token.center.y, token.radiusPx).fill(token.fill);
  drawRing(view.body, token.center, token.radiusPx, token.ring);
  if (token.highlight) drawRing(view.body, token.center, token.radiusPx + 5, token.highlight);
  view.label.text = token.initials;
  view.label.style.fontFamily = fontFamily;
  view.label.style.fontSize = Math.max(10, token.radiusPx * 0.7);
  view.label.style.fill = token.labelColor;
  view.label.position.set(token.center.x, token.center.y);
}

/** Creates the retained layer containers under `stage`, in `TACTICAL_SCENE_LAYERS` order. */
export function createSceneLayers(stage: Container, fontFamily: string): SceneLayers {
  const layers = Object.fromEntries(
    TACTICAL_SCENE_LAYERS.map((id) => {
      const layer = new Container({ label: id });
      stage.addChild(layer);
      return [id, layer];
    }),
  ) as Record<TacticalSceneLayerId, Container>;

  const mapSprite = new Sprite({ texture: Texture.EMPTY, label: "battlemap" });
  mapSprite.visible = false;
  /** Darkvision: the battlemap again in greyscale inside the darkvision area, then in colour where lights fall. */
  const greyscale = new ColorMatrixFilter();
  greyscale.desaturate();
  const dvMask = new Graphics();
  const litMask = new Graphics();
  const greyMap = new Sprite({ texture: Texture.EMPTY, label: "darkvisionGrey" });
  greyMap.filters = [greyscale];
  greyMap.mask = dvMask;
  const litMap = new Sprite({ texture: Texture.EMPTY, label: "darkvisionLit" });
  litMap.mask = litMask;
  layers.backgroundMap.addChild(mapSprite, greyMap, litMap, dvMask, litMask);
  const mapSprites = [mapSprite, greyMap, litMap];
  let darkvisionShown = false;
  let darkvisionLit = false;
  const showDarkvisionMaps = () => {
    greyMap.visible = darkvisionShown && mapTexture !== null;
    litMap.visible = greyMap.visible && darkvisionLit;
  };

  const grid = new Graphics();
  const terrain = new Graphics();
  const walls = new Graphics();
  layers.gridOverlay.addChild(grid, terrain, walls);

  const aoes = new Graphics();
  layers.aoeTemplates.addChild(aoes);

  const tokens = new Map<string, TokenView>();

  /** Renders the darkness into its own texture so `"erase"` lights cannot erase the map below. */
  const offscreen = new AlphaFilter();
  const shade = new Container({ label: "darkness" });
  shade.filters = [offscreen];
  const darkness = new Graphics();
  /** Erases part of the darkness inside the darkvision area (darkness seen as dim light). */
  const dvThin = new Graphics();
  dvThin.blendMode = "erase";
  shade.addChild(darkness, dvThin);
  const glow = new Container({ label: "lightGlow" });
  layers.lightingAndVisionMask.addChild(shade, glow);
  const lights = new Map<string, LightView>();

  const holes = new Graphics();
  const shroud = new Graphics();
  /** Remembered cells: cut out of the opaque shroud above, dimmed here. */
  const memory = new Graphics();
  const hide = new Graphics();
  layers.fogOfWar.addChild(holes, shroud, memory, hide);

  const pings = new Graphics();
  layers.uiControlHud.addChild(pings);

  let signatures: LayerSignatures | null = null;
  let tokenSigs = new Map<string, string>();
  let lightSigs = new Map<string, string>();
  let mapTexture: Texture | null = null;
  let mapSize = "";
  let textResolution = 1;

  const drawLayer: Record<SceneLayerKey, (scene: TableScene) => void> = {
    grid(scene) {
      grid.clear();
      for (let x = 0; x <= scene.widthPx; x += scene.cellPx) grid.moveTo(x, 0).lineTo(x, scene.heightPx);
      for (let y = 0; y <= scene.heightPx; y += scene.cellPx) grid.moveTo(0, y).lineTo(scene.widthPx, y);
      grid.stroke({ width: 1, color: scene.grid.color, alpha: scene.grid.alpha });
    },
    terrain(scene) {
      terrain.clear();
      const cells = scene.terrain.cells;
      if (cells.length === 0) return;
      for (const cell of cells) terrain.rect(cell.x, cell.y, cell.w, cell.h);
      terrain.fill({ color: scene.terrain.color, alpha: scene.terrain.fillAlpha });
      for (const { x, y, w } of cells) {
        terrain.moveTo(x, y + w).lineTo(x + w, y);
        for (const d of [w / 2, w / 4]) {
          terrain.moveTo(x, y + d).lineTo(x + d, y);
          terrain.moveTo(x + w - d, y + w).lineTo(x + w, y + w - d);
        }
      }
      terrain.stroke({ width: 1, color: scene.terrain.color, alpha: scene.terrain.hatchAlpha });
    },
    walls(scene) {
      walls.clear();
      for (const wall of scene.walls) {
        strokePath(walls, [wall.a, wall.b], false, wall.dash, { width: wall.widthPx, color: wall.color, alpha: wall.alpha });
        drawWallMarker(walls, wall.a, wall);
        drawWallMarker(walls, wall.b, wall);
        if (wall.glyphs.length === 0) continue;
        for (const [p, q] of wall.glyphs) walls.moveTo(p.x, p.y).lineTo(q.x, q.y);
        walls.stroke({ width: 2, color: wall.color, alpha: wall.alpha });
      }
    },
    aoes(scene) {
      aoes.clear();
      for (const aoe of scene.aoes) {
        for (const cell of aoe.cells) aoes.rect(cell.x, cell.y, cell.w, cell.h);
        if (aoe.cells.length > 0) aoes.fill({ color: aoe.fill, alpha: aoe.fillAlpha });
        const s = scene.cellPx / 4;
        aoes.moveTo(aoe.origin.x - s, aoe.origin.y).lineTo(aoe.origin.x + s, aoe.origin.y);
        aoes.moveTo(aoe.origin.x, aoe.origin.y - s).lineTo(aoe.origin.x, aoe.origin.y + s);
        aoes.stroke({ width: 2, color: aoe.stroke });
      }
    },
    darkness(scene) {
      darkness.clear();
      const dark = scene.ambient.alpha > 0;
      shade.visible = dark;
      glow.visible = dark;
      if (dark) darkness.rect(0, 0, scene.widthPx, scene.heightPx).fill({ color: scene.ambient.tint, alpha: scene.ambient.alpha });
    },
    darkvision(scene) {
      dvMask.clear();
      litMask.clear();
      dvThin.clear();
      const dv = scene.darkvision;
      darkvisionShown = dv !== null;
      darkvisionLit = false;
      if (dv) {
        const flat = dv.polygon.flatMap((p) => [p.x, p.y]);
        dvMask.poly(flat).fill();
        dvThin.poly(flat).fill();
        dvThin.alpha = dv.thinDarkness;
        for (const area of dv.lit) {
          if (area.length < 3) continue;
          litMask.poly(area.flatMap((p) => [p.x, p.y]));
          darkvisionLit = true;
        }
        if (darkvisionLit) litMask.fill();
      }
      showDarkvisionMaps();
    },
    fog(scene) {
      holes.clear();
      shroud.clear();
      memory.clear();
      hide.clear();
      const fog = scene.fog;
      layers.fogOfWar.visible = fog !== null;
      if (!fog) return;
      shroud.rect(0, 0, scene.widthPx, scene.heightPx).fill({ color: fog.color, alpha: fog.alpha });
      let hasHoles = false;
      for (const polygon of fog.vision) {
        if (polygon.length < 3) continue;
        holes.poly(polygon.flatMap((p) => [p.x, p.y]));
        hasHoles = true;
      }
      for (const cell of [...fog.reveal, ...fog.memory]) {
        holes.rect(cell.x, cell.y, cell.w, cell.h);
        hasHoles = true;
      }
      if (hasHoles) holes.fill(fog.color);
      holes.visible = hasHoles;
      if (hasHoles && shroud.mask !== holes) shroud.setMask({ mask: holes, inverse: true });
      if (!hasHoles && shroud.mask) shroud.mask = null;
      for (const cell of fog.memory) memory.rect(cell.x, cell.y, cell.w, cell.h);
      if (fog.memory.length > 0) memory.fill({ color: fog.color, alpha: fog.memoryAlpha });
      for (const cell of fog.hide) hide.rect(cell.x, cell.y, cell.w, cell.h);
      if (fog.hide.length > 0) hide.fill({ color: fog.color, alpha: fog.alpha });
    },
  };

  const syncMap = (scene: TableScene, texture: Texture | null): boolean => {
    const size = `${scene.widthPx}x${scene.heightPx}`;
    if (texture === mapTexture && size === mapSize) return false;
    const swapped = texture !== mapTexture;
    mapTexture = texture;
    mapSize = size;
    for (const sprite of mapSprites) {
      sprite.texture = texture ?? Texture.EMPTY;
      sprite.width = scene.widthPx;
      sprite.height = scene.heightPx;
    }
    mapSprite.visible = texture !== null;
    showDarkvisionMaps();
    return swapped;
  };

  const syncTokens = (scene: TableScene): KeyedDiff => {
    const next = tokenSignatures(scene.tokens);
    const diff = diffKeyed(tokenSigs, next);
    for (const id of diff.removed) {
      tokens.get(id)?.root.destroy({ children: true });
      tokens.delete(id);
    }
    const byId = new Map(scene.tokens.map((token) => [token.id, token]));
    for (const id of diff.added) {
      const label = new Text({ text: "", style: { fontWeight: "600" }, resolution: textResolution });
      label.anchor.set(0.5);
      const view = { root: new Container({ label: `token:${id}` }), body: new Graphics(), label };
      view.root.addChild(view.body, view.label);
      layers.tokens.addChild(view.root);
      tokens.set(id, view);
    }
    for (const id of [...diff.added, ...diff.changed]) drawToken(tokens.get(id)!, byId.get(id)!, fontFamily);
    tokenSigs = next;
    return diff;
  };

  const syncLights = (scene: TableScene): KeyedDiff => {
    const next = lightSignatures(scene.lights);
    const diff = diffKeyed(lightSigs, next);
    const byId = new Map(scene.lights.map((light) => [light.id, light]));
    for (const id of [...diff.removed, ...diff.changed]) {
      const view = lights.get(id);
      if (!view) continue;
      releaseLightMesh(view.erase);
      releaseLightMesh(view.glow);
      lights.delete(id);
    }
    for (const id of [...diff.added, ...diff.changed]) {
      const light = byId.get(id)!;
      const view = { erase: lightMesh(light, "erase"), glow: lightMesh(light, "add") };
      shade.addChild(view.erase.mesh);
      glow.addChild(view.glow.mesh);
      lights.set(id, view);
    }
    lightSigs = next;
    return diff;
  };

  return {
    sync(scene, texture) {
      const mapChanged = syncMap(scene, texture);
      const next = layerSignatures(scene);
      const redraw = changedLayers(signatures, next);
      for (const key of redraw) drawLayer[key](scene);
      signatures = next;
      return { layers: redraw, tokens: syncTokens(scene), lights: syncLights(scene), mapChanged };
    },
    setTextResolution(resolution) {
      if (resolution === textResolution) return;
      textResolution = resolution;
      for (const view of tokens.values()) view.label.resolution = resolution;
    },
    drawPings(scene, nowMs) {
      pings.clear();
      let live = false;
      for (const ping of scene.pings) {
        const { radiusPx, alpha } = pingRing(ping, nowMs, scene.cellPx, scene.reducedMotion);
        if (alpha <= 0) continue;
        live = true;
        pings.circle(ping.pos.x, ping.pos.y, radiusPx).stroke({ width: RING_WIDTH_PX, color: ping.color, alpha });
      }
      return live;
    },
    destroy() {
      for (const view of lights.values()) {
        releaseLightMesh(view.erase);
        releaseLightMesh(view.glow);
      }
      lights.clear();
      tokens.clear();
      for (const sprite of mapSprites) sprite.texture = Texture.EMPTY;
      shroud.mask = null;
      greyMap.mask = null;
      litMap.mask = null;
      greyMap.filters = [];
      shade.filters = [];
      for (const layer of Object.values(layers)) layer.destroy({ children: true });
      offscreen.destroy();
      greyscale.destroy();
    },
  };
}
