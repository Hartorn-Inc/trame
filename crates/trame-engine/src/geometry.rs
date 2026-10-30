//! ============================================================================
//! 2.5D SPATIAL BVH, WALL PERMEABILITY & VISIBILITY RAYCASTER (geometry.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements the spatial geometry kernel for the tabletop: a 2.5D Bounding
//! Volume Hierarchy (`Bvh2D`), directional and multi-modal wall permeability
//! (`WallKind`), linear 3D elevation horizon culling, radial visibility polygon
//! synthesis, and multi-point token footprint line-of-sight (`can_token_see_target`).
//! Without this module, large maps with hundreds of wall segments would degrade
//! line-of-sight queries to \(O(N)\) per ray and leak occluded tokens across
//! walls or elevation ledges.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Terrain Wall Two-Hit Rule`:
//!      - `WallKind::Terrain` allows an observer to see *into* and across the
//!        first terrain boundary intersected along a ray (`terrain_hits == 1`),
//!        but blocks line-of-sight and light upon hitting a second terrain
//!        boundary (`terrain_hits >= 2`). This enables boulders, tree canopies,
//!        and elevated pillars to remain visible from outside while occluding
//!        entities hidden behind them.
//!   2. `2.5D Elevation Horizon Interpolation`:
//!      - Every ray between `origin` (at `observer_eye_ft`) and `target` (at
//!        `target_eye_ft`) linearly interpolates height \(z(t) = z_0 + t(z_1 - z_0)\)
//!        at the parametric intersection \(t \in (0, 1)\). A wall only occludes
//!        the ray when `bottom_elevation_ft <= z(t) <= top_elevation_ft`.
//!   3. `Multi-Point Token Footprint Sampling`:
//!      - Tokens larger than `1x1` are sampled across 4 quadrant centers (`2x2`
//!        Large) or a 9-point `3x3` lattice (`3x3+` Huge/Gargantuan) so large
//!        creatures partially exposed around a wall corner can see and be seen.
//!   4. `Division-by-Zero & Collinear Guards`:
//!      - `Point2D::distance_3d` clamps `px_per_ft` to `>= 1e-6` and
//!        `segment_intersection` rejects collinear/parallel segments where
//!        `|denom| < 1e-10`.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `can_token_see_target(bvh, observer, target, ...)`
//!     ├── 1. Verify visibility channel bitmask (`CHANNEL_MATERIAL`, `CHANNEL_ETHEREAL`, `CHANNEL_GM_HIDDEN`).
//!     ├── 2. Enforce invisibility gating unless `see_invisibility`, `truesight`, or `blindsight` applies.
//!     ├── 3. Generate footprint sample lattice (`token_sample_points`) for observer and target.
//!     └── 4. For each `(obs_pt, tgt_pt)` pair within 3D sense range:
//!          └── Query `bvh.has_line_of_sight(...)` with 2.5D elevation interpolation and two-hit terrain rule.
//! ============================================================================

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Bitmask channel (`0b001`) representing the standard Material Plane.
pub const CHANNEL_MATERIAL: u8 = 0b001;
/// Bitmask channel (`0b010`) representing the Border Ethereal Plane (visible via Truesight or Etherealness).
pub const CHANNEL_ETHEREAL: u8 = 0b010;
/// Bitmask channel (`0b100`) reserved exclusively for Game Master hidden entities; stripped from non-GM wire payloads.
pub const CHANNEL_GM_HIDDEN: u8 = 0b100;

/// A 2D coordinate on the tabletop canvas measured in pixels (`px`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    /// Horizontal canvas coordinate in pixels (`px`), increasing rightward.
    pub x: f64,
    /// Vertical canvas coordinate in pixels (`px`), increasing downward.
    pub y: f64,
}

impl Point2D {
    /// Constructs a new `Point2D` at `(x, y)` in canvas pixels (`px`).
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Computes the 2D Euclidean distance in pixels (`px`) between `self` and `other`.
    pub fn distance_to(self, other: Self) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2)).sqrt()
    }

    /// Computes the true 3D Euclidean distance in feet (`ft`) between `(self, z1_ft)`
    /// and `(other, z2_ft)`, converting horizontal pixel delta via `px_per_ft` (clamped to `>= 1e-6`).
    pub fn distance_3d(self, z1_ft: f64, other: Self, z2_ft: f64, px_per_ft: f64) -> f64 {
        let horiz_ft = self.distance_to(other) / px_per_ft.max(1e-6);
        let vert_ft = (z1_ft - z2_ft).abs();
        (horiz_ft.powi(2) + vert_ft.powi(2)).sqrt()
    }
}

/// Axis-Aligned Bounding Box (AABB) in 2D canvas pixel coordinates (`px`) used by `Bvh2D` nodes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoundingBox2D {
    /// Minimum X coordinate in pixels (`px`).
    pub min_x: f64,
    /// Minimum Y coordinate in pixels (`px`).
    pub min_y: f64,
    /// Maximum X coordinate in pixels (`px`).
    pub max_x: f64,
    /// Maximum Y coordinate in pixels (`px`).
    pub max_y: f64,
}

impl BoundingBox2D {
    /// Computes the tightest axis-aligned bounding box enclosing segment `a..b` in pixels (`px`).
    pub fn from_segment(a: Point2D, b: Point2D) -> Self {
        Self {
            min_x: a.x.min(b.x),
            min_y: a.y.min(b.y),
            max_x: a.x.max(b.x),
            max_y: a.y.max(b.y),
        }
    }

    /// Returns the smallest `BoundingBox2D` enclosing both `self` and `other`.
    pub fn union(self, other: Self) -> Self {
        Self {
            min_x: self.min_x.min(other.min_x),
            min_y: self.min_y.min(other.min_y),
            max_x: self.max_x.max(other.max_x),
            max_y: self.max_y.max(other.max_y),
        }
    }

    /// Fast broad-phase check testing whether the AABB of segment `p0..p1` overlaps `self`
    /// within a `1e-9` floating-point epsilon margin.
    pub fn intersects_segment(&self, p0: Point2D, p1: Point2D) -> bool {
        let seg_box = Self::from_segment(p0, p1);
        self.min_x <= seg_box.max_x + 1e-9
            && self.max_x >= seg_box.min_x - 1e-9
            && self.min_y <= seg_box.max_y + 1e-9
            && self.max_y >= seg_box.min_y - 1e-9
    }
}

/// Architectural classification of a `WallSegment`, governing how vision, light,
/// movement, and player wire masking behave.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WallKind {
    /// Standard opaque masonry/dungeon wall that immediately blocks vision, light, and movement.
    Normal,
    /// Transparent window or grate that blocks physical movement while allowing vision and light through.
    Window,
    /// Two-hit rule terrain boundary: an observer can see into/across the first `Terrain` wall hit,
    /// but any second `Terrain` wall along the same ray blocks vision and light.
    Terrain,
    /// Directional curtain or cliff ledge that blocks vision only when the ray direction has a
    /// positive dot product (`dot > 0.0`) with the unit normal `(normal_x, normal_y)`.
    OneWay {
        /// Horizontal X component of the blocking normal vector (unitless).
        normal_x: f64,
        /// Vertical Y component of the blocking normal vector (unitless).
        normal_y: f64,
    },
    /// Interactive door that blocks movement, vision, and light when closed (`is_open == false`),
    /// and rejects player toggle commands when `is_locked == true`.
    Door {
        /// Whether the door is currently swung open (`true` = permeable).
        is_open: bool,
        /// Whether the door is locked (`true` = only the GM can toggle).
        is_locked: bool,
    },
    /// Hidden passage controllable only by the GM; masked as `WallKind::Normal` on non-GM wire snapshots when closed.
    SecretDoor {
        /// Whether the secret door has been opened (`true` = permeable and revealed).
        is_open: bool,
    },
    /// Illusory wall that never blocks physical movement (`effective_blocks_movement == false`),
    /// and is visually pierced by observers with Truesight when `pierced_by_truesight == true`.
    Illusion {
        /// Whether an observer with `truesight_range_ft > 0.0` sees straight through the illusion.
        pierced_by_truesight: bool,
    },
}

/// Authoritative 2.5D wall segment primitive with vertical elevation bounds and channel flags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WallSegment {
    /// Unique identifier for the wall or door segment.
    pub id: Uuid,
    /// First endpoint of the wall segment in canvas pixels (`px`).
    pub a: Point2D,
    /// Second endpoint of the wall segment in canvas pixels (`px`).
    pub b: Point2D,
    /// Behavioral classification (`Normal`, `Window`, `Terrain`, `OneWay`, `Door`, `SecretDoor`, `Illusion`).
    pub kind: WallKind,
    /// Base flag indicating whether physical token movement is blocked by this segment.
    pub blocks_movement: bool,
    /// Base flag indicating whether line-of-sight rays are blocked by this segment.
    pub blocks_vision: bool,
    /// Base flag indicating whether dynamic lighting and AoE propagation are blocked by this segment.
    pub blocks_light: bool,
    /// Base flag indicating whether spatial audio emitters are muffled (`blocks_sound`) across this segment.
    pub blocks_sound: bool,
    /// Lower vertical bound of the wall in feet (`ft`) relative to table zero (default `-1000.0`).
    pub bottom_elevation_ft: f64,
    /// Upper vertical bound of the wall in feet (`ft`) relative to table zero (default `1000.0`).
    pub top_elevation_ft: f64,
}

impl WallSegment {
    /// Constructs a full-height (`-1000.0..=1000.0` ft) opaque `WallKind::Normal` segment between `a` and `b`.
    pub fn normal_wall(id: Uuid, a: Point2D, b: Point2D) -> Self {
        Self {
            id,
            a,
            b,
            kind: WallKind::Normal,
            blocks_movement: true,
            blocks_vision: true,
            blocks_light: true,
            blocks_sound: true,
            bottom_elevation_ft: -1000.0,
            top_elevation_ft: 1000.0,
        }
    }

    /// Evaluates whether this wall blocks a vision ray travelling along `ray_dir` for an observer
    /// with `has_truesight`.
    ///
    /// Returns `(blocks_immediately, is_terrain_two_hit)`:
    /// - `(true, false)` if the ray is stopped at this wall.
    /// - `(false, true)` if the wall counts toward the 2-hit `WallKind::Terrain` quota.
    /// - `(false, false)` if the ray passes through unimpeded.
    pub fn effective_blocks_vision(&self, has_truesight: bool, ray_dir: Point2D) -> (bool, bool) {
        if !self.blocks_vision {
            return (false, false);
        }
        match &self.kind {
            WallKind::Normal => (true, false),
            WallKind::Window => (false, false),
            WallKind::Terrain => (false, true),
            WallKind::OneWay { normal_x, normal_y } => {
                let dot = ray_dir.x * normal_x + ray_dir.y * normal_y;
                (dot > 0.0, false)
            }
            WallKind::Door { is_open, .. } | WallKind::SecretDoor { is_open } => (!is_open, false),
            WallKind::Illusion {
                pierced_by_truesight,
            } => (!(has_truesight && *pierced_by_truesight), false),
        }
    }

    /// Evaluates whether this wall blocks physical token movement, returning `false` when the
    /// mover is on the Ethereal plane (`is_ethereal == true`), the door is open, or the wall is an `Illusion`.
    pub fn effective_blocks_movement(&self, is_ethereal: bool) -> bool {
        if is_ethereal || !self.blocks_movement {
            return false;
        }
        match &self.kind {
            WallKind::Door { is_open, .. } | WallKind::SecretDoor { is_open } => !is_open,
            WallKind::Illusion { .. } => false,
            _ => true,
        }
    }
}

/// Sensory capabilities and planar perception bitmask attached to a token (`01-TABLE-SPEC.md`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SenseProfile {
    /// Maximum bright/dim vision radius in feet (`ft`, default `120.0`).
    pub normal_range_ft: f64,
    /// Maximum darkvision radius in feet (`ft`, default `60.0`).
    pub darkvision_range_ft: f64,
    /// Maximum blindsight radius in feet (`ft`, perceives invisible targets without relying on sight).
    pub blindsight_range_ft: f64,
    /// Maximum tremorsense radius in feet (`ft`).
    pub tremorsense_range_ft: f64,
    /// Maximum truesight radius in feet (`ft`, pierces illusions, invisibility, and perceives `CHANNEL_ETHEREAL`).
    pub truesight_range_ft: f64,
    /// Whether the token possesses Devil's Sight (sees normally in magical and nonmagical darkness).
    pub devils_sight: bool,
    /// Whether the token can see invisible creatures and objects as if they were visible.
    pub see_invisibility: bool,
    /// Bitmask of visibility channels (`CHANNEL_MATERIAL`, `CHANNEL_ETHEREAL`, `CHANNEL_GM_HIDDEN`) perceived.
    pub perceives_channels: u8,
}

impl Default for SenseProfile {
    fn default() -> Self {
        Self {
            normal_range_ft: 120.0,
            darkvision_range_ft: 60.0,
            blindsight_range_ft: 0.0,
            tremorsense_range_ft: 0.0,
            truesight_range_ft: 0.0,
            devils_sight: false,
            see_invisibility: false,
            perceives_channels: CHANNEL_MATERIAL,
        }
    }
}

#[derive(Debug, Clone)]
enum BvhNode {
    Leaf {
        bbox: BoundingBox2D,
        wall_index: usize,
    },
    Internal {
        bbox: BoundingBox2D,
        left: Box<BvhNode>,
        right: Box<BvhNode>,
    },
}

impl BvhNode {
    fn bbox(&self) -> BoundingBox2D {
        match self {
            Self::Leaf { bbox, .. } | Self::Internal { bbox, .. } => *bbox,
        }
    }
}

/// 2.5D Bounding Volume Hierarchy (`Bvh2D`) for \(O(\log N)\) raycasting, visibility polygon synthesis,
/// and movement collision checks.
#[derive(Debug, Clone, Default)]
pub struct Bvh2D {
    walls: Vec<WallSegment>,
    root: Option<BvhNode>,
}

#[derive(Debug, Clone, Copy)]
struct RayHit {
    t: f64,
    point: Point2D,
    is_terrain: bool,
    blocks_immediately: bool,
}

impl Bvh2D {
    /// Builds a balanced top-down median-split `Bvh2D` tree alternating X and Y centroid axes
    /// over the provided `walls` slice.
    pub fn build(walls: Vec<WallSegment>) -> Self {
        let indices: Vec<usize> = (0..walls.len()).collect();
        let root = Self::build_node(&walls, &indices, 0);
        Self { walls, root }
    }

    /// Returns a read-only slice of all `WallSegment` primitives indexed by this `Bvh2D`.
    pub fn walls(&self) -> &[WallSegment] {
        &self.walls
    }

    fn build_node(walls: &[WallSegment], indices: &[usize], depth: usize) -> Option<BvhNode> {
        if indices.is_empty() {
            return None;
        }
        if indices.len() == 1 {
            let idx = indices[0];
            let w = &walls[idx];
            return Some(BvhNode::Leaf {
                bbox: BoundingBox2D::from_segment(w.a, w.b),
                wall_index: idx,
            });
        }

        let mut sorted = indices.to_vec();
        if depth.is_multiple_of(2) {
            sorted.sort_by(|&i, &j| {
                let cx_i = (walls[i].a.x + walls[i].b.x) * 0.5;
                let cx_j = (walls[j].a.x + walls[j].b.x) * 0.5;
                cx_i.partial_cmp(&cx_j).unwrap_or(std::cmp::Ordering::Equal)
            });
        } else {
            sorted.sort_by(|&i, &j| {
                let cy_i = (walls[i].a.y + walls[i].b.y) * 0.5;
                let cy_j = (walls[j].a.y + walls[j].b.y) * 0.5;
                cy_i.partial_cmp(&cy_j).unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        let mid = sorted.len() / 2;
        let left = Self::build_node(walls, &sorted[..mid], depth + 1)?;
        let right = Self::build_node(walls, &sorted[mid..], depth + 1)?;
        let bbox = left.bbox().union(right.bbox());

        Some(BvhNode::Internal {
            bbox,
            left: Box::new(left),
            right: Box::new(right),
        })
    }

    /// Checks whether a 2.5D line-of-sight segment from `origin` (at `observer_eye_ft` in feet)
    /// to `target` (at `target_eye_ft` in feet) is unobstructed by walls.
    ///
    /// Sorts all intersecting walls by parametric distance `t` and enforces both 3D linear
    /// elevation horizon culling and the two-hit `WallKind::Terrain` rule.
    pub fn has_line_of_sight(
        &self,
        origin: Point2D,
        observer_eye_ft: f64,
        target: Point2D,
        target_eye_ft: f64,
        has_truesight: bool,
    ) -> bool {
        let Some(root) = &self.root else {
            return true;
        };
        let ray_dir = Point2D::new(target.x - origin.x, target.y - origin.y);
        let mut hits = Vec::new();
        Self::collect_segment_hits(
            root,
            &self.walls,
            origin,
            observer_eye_ft,
            target,
            target_eye_ft,
            ray_dir,
            has_truesight,
            &mut hits,
        );

        if hits.is_empty() {
            return true;
        }
        hits.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));

        let mut terrain_hits = 0usize;
        for hit in hits {
            if hit.blocks_immediately {
                return false;
            }
            if hit.is_terrain {
                terrain_hits += 1;
                if terrain_hits >= 2 {
                    return false;
                }
            }
        }
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn collect_segment_hits(
        node: &BvhNode,
        walls: &[WallSegment],
        origin: Point2D,
        observer_eye_ft: f64,
        target: Point2D,
        target_eye_ft: f64,
        ray_dir: Point2D,
        has_truesight: bool,
        out: &mut Vec<RayHit>,
    ) {
        if !node.bbox().intersects_segment(origin, target) {
            return;
        }
        match node {
            BvhNode::Leaf { wall_index, .. } => {
                let wall = &walls[*wall_index];
                let (blocks_imm, is_terrain) = wall.effective_blocks_vision(has_truesight, ray_dir);
                if !blocks_imm && !is_terrain {
                    return;
                }
                if let Some((t, pt)) = segment_intersection(origin, target, wall.a, wall.b)
                    && t > 1e-6
                    && t < 1.0 - 1e-6
                {
                    // Interpolate ray elevation at intersection point t
                    let ray_z_ft = observer_eye_ft + t * (target_eye_ft - observer_eye_ft);
                    if ray_z_ft >= wall.bottom_elevation_ft && ray_z_ft <= wall.top_elevation_ft {
                        out.push(RayHit {
                            t,
                            point: pt,
                            is_terrain,
                            blocks_immediately: blocks_imm,
                        });
                    }
                }
            }
            BvhNode::Internal { left, right, .. } => {
                Self::collect_segment_hits(
                    left,
                    walls,
                    origin,
                    observer_eye_ft,
                    target,
                    target_eye_ft,
                    ray_dir,
                    has_truesight,
                    out,
                );
                Self::collect_segment_hits(
                    right,
                    walls,
                    origin,
                    observer_eye_ft,
                    target,
                    target_eye_ft,
                    ray_dir,
                    has_truesight,
                    out,
                );
            }
        }
    }

    /// Checks whether a token movement segment from `from` to `to` (in pixels) at vertical height
    /// `elevation_ft` (in feet) collides with any movement-blocking wall.
    ///
    /// Returns the closest collision `Point2D` along `from..to` if blocked, or `None` if clear.
    pub fn check_movement_collision(
        &self,
        from: Point2D,
        to: Point2D,
        elevation_ft: f64,
        is_ethereal: bool,
    ) -> Option<Point2D> {
        let mut closest: Option<(f64, Point2D)> = None;
        for wall in &self.walls {
            if !wall.effective_blocks_movement(is_ethereal) {
                continue;
            }
            if elevation_ft < wall.bottom_elevation_ft || elevation_ft > wall.top_elevation_ft {
                continue;
            }
            if let Some((t, pt)) = segment_intersection(from, to, wall.a, wall.b)
                && (0.0..=1.0).contains(&t)
                && closest.is_none_or(|(best_t, _)| t < best_t)
            {
                closest = Some((t, pt));
            }
        }
        closest.map(|(_, pt)| pt)
    }

    /// Casts a horizontal vision ray from `origin` (at `observer_eye_ft` in feet) in direction
    /// `angle_rad` (in radians) up to `max_range_px` (in pixels) and returns the termination `Point2D`,
    /// respecting the two-hit rule on `WallKind::Terrain` walls.
    pub fn cast_vision_ray(
        &self,
        origin: Point2D,
        observer_eye_ft: f64,
        angle_rad: f64,
        max_range_px: f64,
        has_truesight: bool,
    ) -> Point2D {
        let target = Point2D::new(
            origin.x + angle_rad.cos() * max_range_px,
            origin.y + angle_rad.sin() * max_range_px,
        );
        let Some(root) = &self.root else {
            return target;
        };
        let ray_dir = Point2D::new(target.x - origin.x, target.y - origin.y);
        let mut hits = Vec::new();
        Self::collect_segment_hits(
            root,
            &self.walls,
            origin,
            observer_eye_ft,
            target,
            observer_eye_ft,
            ray_dir,
            has_truesight,
            &mut hits,
        );
        if hits.is_empty() {
            return target;
        }
        hits.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));

        let mut terrain_hits = 0usize;
        for hit in hits {
            if hit.blocks_immediately {
                return hit.point;
            }
            if hit.is_terrain {
                terrain_hits += 1;
                if terrain_hits >= 2 {
                    return hit.point;
                }
            }
        }
        target
    }

    /// Computes a closed 2D radial visibility polygon around `origin` (in pixels) at height
    /// `observer_eye_ft` (in feet) up to radius `max_range_px` (in pixels).
    ///
    /// Combines a 36-spoke baseline circle (`10°` angular steps) with `±1e-4` radian grazing
    /// rays aimed at every wall endpoint within range, deduplicating angles within `1e-6` rad.
    pub fn compute_visibility_polygon(
        &self,
        origin: Point2D,
        observer_eye_ft: f64,
        max_range_px: f64,
        has_truesight: bool,
    ) -> Vec<Point2D> {
        let mut angles = Vec::with_capacity(self.walls.len() * 6 + 36);
        let step = std::f64::consts::TAU / 36.0;
        for i in 0..36 {
            angles.push(i as f64 * step - std::f64::consts::PI);
        }
        let eps = 1e-4;
        for wall in &self.walls {
            for pt in [wall.a, wall.b] {
                if origin.distance_to(pt) <= max_range_px + 1.0 {
                    let base = (pt.y - origin.y).atan2(pt.x - origin.x);
                    angles.push(base - eps);
                    angles.push(base);
                    angles.push(base + eps);
                }
            }
        }
        angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        angles.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

        angles
            .into_iter()
            .map(|angle| {
                self.cast_vision_ray(origin, observer_eye_ft, angle, max_range_px, has_truesight)
            })
            .collect()
    }
}

/// Returns the footprint sample points in canvas pixels (`px`) for a token according to `01-TABLE-SPEC.md`:
/// - `1x1` (Medium/Small): 1 center point `(0.5, 0.5)`.
/// - `2x2` (Large): 4 quadrant centers `(0.25, 0.25)`, `(0.75, 0.25)`, `(0.25, 0.75)`, `(0.75, 0.75)`.
/// - `3x3+` (Huge/Gargantuan): 9 perimeter + center points (`{0.2, 0.5, 0.8} x {0.2, 0.5, 0.8}` lattice).
pub fn token_sample_points(
    top_left: Point2D,
    grid_w: u8,
    grid_h: u8,
    cell_size_px: f64,
) -> Vec<Point2D> {
    let w_px = f64::from(grid_w.max(1)) * cell_size_px;
    let h_px = f64::from(grid_h.max(1)) * cell_size_px;

    if grid_w <= 1 && grid_h <= 1 {
        vec![Point2D::new(
            top_left.x + w_px * 0.5,
            top_left.y + h_px * 0.5,
        )]
    } else if grid_w == 2 && grid_h == 2 {
        vec![
            Point2D::new(top_left.x + w_px * 0.25, top_left.y + h_px * 0.25),
            Point2D::new(top_left.x + w_px * 0.75, top_left.y + h_px * 0.25),
            Point2D::new(top_left.x + w_px * 0.25, top_left.y + h_px * 0.75),
            Point2D::new(top_left.x + w_px * 0.75, top_left.y + h_px * 0.75),
        ]
    } else {
        let mut pts = Vec::with_capacity(9);
        for rx in [0.2, 0.5, 0.8] {
            for ry in [0.2, 0.5, 0.8] {
                pts.push(Point2D::new(top_left.x + w_px * rx, top_left.y + h_px * ry));
            }
        }
        pts
    }
}

/// Evaluates multi-point footprint visibility between an observer token and a target token.
///
/// Enforces planar visibility channel bitmasks (`target_channel`), invisibility gating,
/// 3D sensory range limits (`observer_senses`), and 2.5D BVH wall occlusion across all pairs
/// of footprint sample points.
#[allow(clippy::too_many_arguments)]
pub fn can_token_see_target(
    bvh: &Bvh2D,
    observer_top_left: Point2D,
    observer_grid_w: u8,
    observer_grid_h: u8,
    observer_eye_ft: f64,
    observer_senses: &SenseProfile,
    target_top_left: Point2D,
    target_grid_w: u8,
    target_grid_h: u8,
    target_eye_ft: f64,
    target_channel: u8,
    target_invisible: bool,
    cell_size_px: f64,
    feet_per_cell: f64,
) -> bool {
    let effective_channels = if observer_senses.truesight_range_ft > 0.0 {
        observer_senses.perceives_channels | CHANNEL_ETHEREAL
    } else {
        observer_senses.perceives_channels
    };
    if (effective_channels & target_channel) == 0 {
        return false;
    }
    if target_invisible
        && !observer_senses.see_invisibility
        && observer_senses.truesight_range_ft <= 0.0
        && observer_senses.blindsight_range_ft <= 0.0
    {
        return false;
    }

    let max_range_ft = observer_senses
        .normal_range_ft
        .max(observer_senses.darkvision_range_ft)
        .max(observer_senses.blindsight_range_ft)
        .max(observer_senses.truesight_range_ft);
    let px_per_ft = cell_size_px / feet_per_cell.max(1.0);
    let has_truesight = observer_senses.truesight_range_ft > 0.0;

    let obs_pts = token_sample_points(
        observer_top_left,
        observer_grid_w,
        observer_grid_h,
        cell_size_px,
    );
    let tgt_pts = token_sample_points(target_top_left, target_grid_w, target_grid_h, cell_size_px);

    for o in &obs_pts {
        for t in &tgt_pts {
            let dist_ft = o.distance_3d(observer_eye_ft, *t, target_eye_ft, px_per_ft);
            if dist_ft <= max_range_ft
                && bvh.has_line_of_sight(*o, observer_eye_ft, *t, target_eye_ft, has_truesight)
            {
                return true;
            }
        }
    }
    false
}

/// Computes the 2D parametric segment-segment intersection between `p0..p1` and `q0..q1`.
///
/// Returns `Some((t, intersection_point))` where `t` in `[0.0, 1.0]` is the normalized distance
/// along `p0..p1`, or `None` if the segments are parallel/collinear (`|denom| < 1e-10`) or disjoint.
pub fn segment_intersection(
    p0: Point2D,
    p1: Point2D,
    q0: Point2D,
    q1: Point2D,
) -> Option<(f64, Point2D)> {
    let r_x = p1.x - p0.x;
    let r_y = p1.y - p0.y;
    let s_x = q1.x - q0.x;
    let s_y = q1.y - q0.y;

    let denom = r_x * s_y - r_y * s_x;
    if denom.abs() < 1e-10 {
        return None;
    }

    let qp_x = q0.x - p0.x;
    let qp_y = q0.y - p0.y;

    let t = (qp_x * s_y - qp_y * s_x) / denom;
    let u = (qp_x * r_y - qp_y * r_x) / denom;

    if (-1e-9..=1.0 + 1e-9).contains(&t) && (-1e-9..=1.0 + 1e-9).contains(&u) {
        let clamped_t = t.clamp(0.0, 1.0);
        Some((
            clamped_t,
            Point2D::new(p0.x + clamped_t * r_x, p0.y + clamped_t * r_y),
        ))
    } else {
        None
    }
}
