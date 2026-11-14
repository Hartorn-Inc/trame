/**
 * ============================================================================
 * DIRECTIONAL WALL GLYPHS (canvas/wallGlyphs.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * One-way and terrain walls change line of sight in ways a plain stroke
 * cannot show: a one-way wall blocks from one side only, a terrain wall only
 * blocks past a second terrain wall. Colour and dash already tell the kinds
 * apart; these glyphs add a shape (non-colour redundancy, DESIGN.md) that
 * also carries the meaning, drawn identically by the maps studio SVG and the
 * GM's live table.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Same Direction As The Engine`:
 *    - `oneWayNormal` mirrors `WallSegment::one_way_normal` in
 *      `crates/trame-engine/src/geometry.rs`: the stored normal when it is
 *      non-zero, else the left-hand perpendicular of `a -> b`. Sight going
 *      along the normal is blocked, so the arrow points against it: the way
 *      sight passes. The visibility itself always comes from the engine.
 * 2. `Terrain Two-Hit Mark`:
 *    - Two parallel ticks across the middle of a terrain wall stand for
 *      "the second one blocks".
 * 3. `Degenerate Walls Draw Nothing`:
 *    - A zero-length wall has no direction, so it gets no glyph.
 * ============================================================================
 */
import type { Point2D } from "../engine/wasmBridge.ts";
import type { CanonicalWallKind } from "./CanvasThemePalette.ts";

/** One straight stroke of a glyph, in canvas pixels. */
export type GlyphSegment = [Point2D, Point2D];

/** Glyph arm length relative to the wall stroke (`px`). */
const GLYPH_PX = 7;
/** Spacing between the two terrain ticks (`px`). */
const TICK_GAP_PX = 4;

/** Blocking normal of a one-way wall (invariant 1); `(0, 0)` for a zero-length wall. */
export function oneWayNormal(a: Point2D, b: Point2D, stored: Point2D | null): Point2D {
  if (stored && (stored.x !== 0 || stored.y !== 0)) return stored;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-10) return { x: 0, y: 0 };
  return { x: -(b.y - a.y) / len || 0, y: (b.x - a.x) / len || 0 };
}

/**
 * Glyph strokes for a wall: an arrowhead at the midpoint pointing the way
 * sight passes a one-way wall, two ticks across a terrain wall, nothing for
 * the other kinds. `normal` is the stored one-way normal, if any.
 */
export function wallGlyphs(kind: CanonicalWallKind, a: Point2D, b: Point2D, normal: Point2D | null = null): GlyphSegment[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-10) return [];
  const t = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const at = (base: Point2D, dir: Point2D, k: number) => ({ x: base.x + dir.x * k, y: base.y + dir.y * k });
  if (kind === "OneWay") {
    const n = oneWayNormal(a, b, normal);
    const nl = Math.hypot(n.x, n.y) || 1;
    const pass = { x: -n.x / nl, y: -n.y / nl };
    const tip = at(mid, pass, GLYPH_PX);
    return [
      [at(mid, t, -GLYPH_PX), tip],
      [at(mid, t, GLYPH_PX), tip],
    ];
  }
  if (kind === "Terrain") {
    const p = { x: -t.y, y: t.x };
    return [-TICK_GAP_PX / 2, TICK_GAP_PX / 2].map((offset): GlyphSegment => {
      const c = at(mid, t, offset);
      return [at(c, p, -GLYPH_PX), at(c, p, GLYPH_PX)];
    });
  }
  return [];
}

/** SVG path data (`M x y L x y ...`) for glyph strokes. */
export function glyphPath(segments: GlyphSegment[]): string {
  return segments.map(([p, q]) => `M ${round(p.x)} ${round(p.y)} L ${round(q.x)} ${round(q.y)}`).join(" ");
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
