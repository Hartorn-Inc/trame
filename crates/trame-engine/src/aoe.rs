//! ============================================================================
//! AREA OF EFFECT (AOE) PROJECTION & GRID DISCRETIZER (aoe.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Evaluates 2.5D spell and ability Area of Effect templates (`Sphere`,
//! `Cylinder`, `Cone`, `Cube`, `Line`), clips their propagation against
//! vision/effect-blocking `WallSegment` primitives via `Bvh2D`, and discretizes
//! the resulting area into affected grid squares (`GridCell`) and auto-targeted
//! tokens (`TokenSpatialRef`) across four configurable tabletop ruleset modes.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `BVH Wall-Occlusion Clipping`:
//!      - When `stops_at_walls == true`, every candidate point inside the raw
//!        analytic shape must also have an unobstructed 2.5D line-of-sight ray
//!        from `(origin, origin_elevation_ft + 2.5)` to `(pt, point_elevation_ft + 2.5)`
//!        so explosions and breath weapons do not pass through solid walls.
//!   2. `Four-Mode Grid Discretization`:
//!      - Supports `CenterPoint` (1 sample), `FiftyPercent` (5x5 = 25 sub-grid
//!        samples requiring `>= 13` hits), `AnyIntersection` (center + 4 inset
//!        corners), and `TokenEuclidean` (gridless direct footprint evaluation).
//!   3. `Bounded Candidate Cell Window`:
//!      - `evaluate_targets` bounds grid iteration strictly to the AABB enclosing
//!        `max_extent_px` around `origin` (`min_col..=max_col`, `min_row..=max_row`),
//!        preventing unbounded loops on large maps.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `AoeTemplate::evaluate_targets(tokens, cell_size_px, feet_per_cell, bvh)`
//!     ├── 1. Compute bounding grid window `[min_col..=max_col, min_row..=max_row]` from shape extent.
//!     ├── 2. Test each candidate `GridCell` via `affects_grid_cell(...)`:
//!     │    └── Sample cell points according to `GridDiscretizationMode` & call `contains_point(...)`.
//!     └── 3. Match `TokenSpatialRef` footprints against affected cells (or direct sample points in `TokenEuclidean`).
//! ============================================================================

use crate::geometry::{Bvh2D, Point2D, token_sample_points};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Geometric primitive describing the unclipped 2.5D volume of an Area of Effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AoeShape {
    /// 3D spherical volume centered at `(origin, origin_elevation_ft)`.
    Sphere {
        /// Sphere radius in feet (`ft`, `>= 0.0`).
        radius_ft: f64,
    },
    /// Upright cylindrical volume extending from `origin_elevation_ft` to `origin_elevation_ft + height_ft`.
    Cylinder {
        /// Horizontal cylinder radius in feet (`ft`, `>= 0.0`).
        radius_ft: f64,
        /// Vertical height of the cylinder in feet (`ft`, `>= 0.0`).
        height_ft: f64,
    },
    /// Angular sector emanating from `origin` along `direction_deg`.
    Cone {
        /// Maximum reach of the cone in feet (`ft`, `>= 0.0`).
        length_ft: f64,
        /// Full aperture angle of the cone in degrees (`deg`, e.g. `53.13` or `60.0`).
        angle_deg: f64,
        /// Aiming direction angle in degrees (`deg`, `0.0` = +X axis, increasing clockwise/downward).
        direction_deg: f64,
    },
    /// Axis-aligned or rotated cubic volume centered on `origin`.
    Cube {
        /// Edge length of the cube in feet (`ft`, `>= 0.0`).
        side_ft: f64,
        /// Planar rotation angle in degrees (`deg`).
        rotation_deg: f64,
    },
    /// Oriented rectangular beam starting at `origin` and extending `length_ft` along `direction_deg`.
    Line {
        /// Total length of the line in feet (`ft`, `>= 0.0`).
        length_ft: f64,
        /// Full width of the line perpendicular to `direction_deg` in feet (`ft`, `>= 0.0`).
        width_ft: f64,
        /// Aiming direction angle in degrees (`deg`).
        direction_deg: f64,
    },
}

/// Ruleset selector determining how continuous geometric shapes map onto discrete grid squares (`01-TABLE-SPEC.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GridDiscretizationMode {
    /// Standard 5e DMG: cell is affected if its center point `(cx, cy)` is inside the clipped shape.
    CenterPoint,
    /// XGE / Tactical: cell is affected if >= 50% of its area (5x5 sub-grid = 25 samples, `>= 13` hits) is inside.
    FiftyPercent,
    /// Generous: cell is affected if its center or any of its 4 corners is inside.
    AnyIntersection,
    /// Gridless / Euclidean: bypasses grid squares and checks token footprints directly.
    TokenEuclidean,
}

/// Complete specification of a projected or persistent Area of Effect on the tabletop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AoeTemplate {
    /// Unique identifier for this AoE instance.
    pub id: Uuid,
    /// Origin anchor coordinate on the canvas in pixels (`px`).
    pub origin: Point2D,
    /// Vertical elevation of the AoE origin in feet (`ft`) relative to table zero.
    pub origin_elevation_ft: f64,
    /// Geometric shape and dimensions of the AoE.
    pub shape: AoeShape,
    /// When `true`, clips propagation rays against vision-blocking walls in the `Bvh2D`.
    pub stops_at_walls: bool,
    /// Grid discretization rule used to classify affected cells and tokens.
    pub discretization: GridDiscretizationMode,
    /// Optional token ID of the spellcaster concentrating on this persistent zone.
    pub concentration_caster_id: Option<Uuid>,
}

/// Discrete 2D grid coordinate `(col, row)` indexing a single tabletop square.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GridCell {
    /// Zero-based horizontal column index (can be negative off-canvas).
    pub col: i32,
    /// Zero-based vertical row index (can be negative off-canvas).
    pub row: i32,
}

/// Lightweight spatial projection of a token used during AoE target evaluation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenSpatialRef {
    /// Unique identifier of the token.
    pub id: Uuid,
    /// Top-left canvas coordinate of the token's bounding footprint in pixels (`px`).
    pub top_left: Point2D,
    /// Horizontal footprint width in grid cells (`>= 1`, accounting for squeezing).
    pub grid_w: u8,
    /// Vertical footprint height in grid cells (`>= 1`, accounting for squeezing).
    pub grid_h: u8,
    /// Base elevation of the token's feet in feet (`ft`).
    pub elevation_ft: f64,
    /// Vertical stature of the token in feet (`ft`).
    pub height_ft: f64,
}

impl AoeTemplate {
    /// Checks whether a single 2D point `pt` (in pixels, at `point_elevation_ft` in feet) lies
    /// inside the unclipped geometric shape AND (if `stops_at_walls == true`) has an unobstructed
    /// 2.5D BVH line-of-sight path from `self.origin`.
    pub fn contains_point(
        &self,
        pt: Point2D,
        point_elevation_ft: f64,
        px_per_ft: f64,
        bvh: &Bvh2D,
    ) -> bool {
        let px_per_ft = px_per_ft.max(1e-6);
        let dx_ft = (pt.x - self.origin.x) / px_per_ft;
        let dy_ft = (pt.y - self.origin.y) / px_per_ft;
        let dist_2d_ft = (dx_ft * dx_ft + dy_ft * dy_ft).sqrt();
        let dz_ft = (point_elevation_ft - self.origin_elevation_ft).abs();

        let in_raw_shape = match &self.shape {
            AoeShape::Sphere { radius_ft } => {
                let dist_3d = (dist_2d_ft.powi(2) + dz_ft.powi(2)).sqrt();
                dist_3d <= *radius_ft + 1e-6
            }
            AoeShape::Cylinder {
                radius_ft,
                height_ft,
            } => {
                dist_2d_ft <= *radius_ft + 1e-6
                    && point_elevation_ft >= self.origin_elevation_ft - 1e-6
                    && point_elevation_ft <= self.origin_elevation_ft + *height_ft + 1e-6
            }
            AoeShape::Cone {
                length_ft,
                angle_deg,
                direction_deg,
            } => {
                if dist_2d_ft > *length_ft + 1e-6 {
                    false
                } else if dist_2d_ft < 1e-6 {
                    true
                } else {
                    let pt_deg = dy_ft.atan2(dx_ft).to_degrees();
                    let diff = normalize_angle_deg(pt_deg - *direction_deg).abs();
                    diff <= (*angle_deg * 0.5) + 1e-6
                }
            }
            AoeShape::Cube {
                side_ft,
                rotation_deg,
            } => {
                // Origin is treated as the center of the cube on `(x, y)`
                let rad = -rotation_deg.to_radians();
                let rx = dx_ft * rad.cos() - dy_ft * rad.sin();
                let ry = dx_ft * rad.sin() + dy_ft * rad.cos();
                let half = *side_ft * 0.5 + 1e-6;
                rx.abs() <= half && ry.abs() <= half && dz_ft <= *side_ft + 1e-6
            }
            AoeShape::Line {
                length_ft,
                width_ft,
                direction_deg,
            } => {
                let rad = -direction_deg.to_radians();
                let along = dx_ft * rad.cos() - dy_ft * rad.sin();
                let perp = dx_ft * rad.sin() + dy_ft * rad.cos();
                along >= -1e-6
                    && along <= *length_ft + 1e-6
                    && perp.abs() <= (*width_ft * 0.5) + 1e-6
            }
        };

        if !in_raw_shape {
            return false;
        }

        if self.stops_at_walls {
            bvh.has_line_of_sight(
                self.origin,
                self.origin_elevation_ft + 2.5,
                pt,
                point_elevation_ft + 2.5,
                false,
            )
        } else {
            true
        }
    }

    /// Evaluates whether a single grid cell `(col, row)` is affected under `self.discretization`,
    /// given `cell_size_px` (in pixels) and `feet_per_cell` (in feet).
    pub fn affects_grid_cell(
        &self,
        cell: &GridCell,
        cell_size_px: f64,
        feet_per_cell: f64,
        bvh: &Bvh2D,
    ) -> bool {
        let px_per_ft = cell_size_px / feet_per_cell.max(1.0);
        let x0 = f64::from(cell.col) * cell_size_px;
        let y0 = f64::from(cell.row) * cell_size_px;
        let center = Point2D::new(x0 + cell_size_px * 0.5, y0 + cell_size_px * 0.5);

        match self.discretization {
            GridDiscretizationMode::CenterPoint | GridDiscretizationMode::TokenEuclidean => {
                self.contains_point(center, self.origin_elevation_ft, px_per_ft, bvh)
            }
            GridDiscretizationMode::AnyIntersection => {
                let samples = [
                    center,
                    Point2D::new(x0 + 1e-3, y0 + 1e-3),
                    Point2D::new(x0 + cell_size_px - 1e-3, y0 + 1e-3),
                    Point2D::new(x0 + 1e-3, y0 + cell_size_px - 1e-3),
                    Point2D::new(x0 + cell_size_px - 1e-3, y0 + cell_size_px - 1e-3),
                ];
                samples
                    .iter()
                    .any(|&pt| self.contains_point(pt, self.origin_elevation_ft, px_per_ft, bvh))
            }
            GridDiscretizationMode::FiftyPercent => {
                // 5x5 sub-grid (25 sample points); >= 13 points = >= 52% coverage
                let mut inside_count = 0usize;
                for ix in 0..5 {
                    for iy in 0..5 {
                        let sx = x0 + (f64::from(ix) + 0.5) * (cell_size_px / 5.0);
                        let sy = y0 + (f64::from(iy) + 0.5) * (cell_size_px / 5.0);
                        if self.contains_point(
                            Point2D::new(sx, sy),
                            self.origin_elevation_ft,
                            px_per_ft,
                            bvh,
                        ) {
                            inside_count += 1;
                        }
                    }
                }
                inside_count >= 13
            }
        }
    }

    /// Computes all affected `GridCell` coordinates and auto-detected target token IDs (`Vec<Uuid>`)
    /// within the clipped AoE template.
    pub fn evaluate_targets(
        &self,
        tokens: &[TokenSpatialRef],
        cell_size_px: f64,
        feet_per_cell: f64,
        bvh: &Bvh2D,
    ) -> (Vec<GridCell>, Vec<Uuid>) {
        let px_per_ft = cell_size_px / feet_per_cell.max(1.0);
        let max_extent_ft = match &self.shape {
            AoeShape::Sphere { radius_ft } | AoeShape::Cylinder { radius_ft, .. } => *radius_ft,
            AoeShape::Cone { length_ft, .. } | AoeShape::Line { length_ft, .. } => *length_ft,
            AoeShape::Cube { side_ft, .. } => *side_ft,
        };
        let max_extent_px = max_extent_ft * px_per_ft;
        let min_col = ((self.origin.x - max_extent_px) / cell_size_px).floor() as i32 - 1;
        let max_col = ((self.origin.x + max_extent_px) / cell_size_px).ceil() as i32 + 1;
        let min_row = ((self.origin.y - max_extent_px) / cell_size_px).floor() as i32 - 1;
        let max_row = ((self.origin.y + max_extent_px) / cell_size_px).ceil() as i32 + 1;

        let mut affected_cells = Vec::new();
        for col in min_col..=max_col {
            for row in min_row..=max_row {
                let cell = GridCell { col, row };
                if self.affects_grid_cell(&cell, cell_size_px, feet_per_cell, bvh) {
                    affected_cells.push(cell);
                }
            }
        }

        let mut hit_tokens = Vec::new();
        for token in tokens {
            let hit = match self.discretization {
                GridDiscretizationMode::TokenEuclidean => {
                    let pts = token_sample_points(
                        token.top_left,
                        token.grid_w,
                        token.grid_h,
                        cell_size_px,
                    );
                    pts.into_iter()
                        .any(|pt| self.contains_point(pt, token.elevation_ft, px_per_ft, bvh))
                }
                _ => {
                    let start_col = (token.top_left.x / cell_size_px).round() as i32;
                    let start_row = (token.top_left.y / cell_size_px).round() as i32;
                    let mut overlaps = false;
                    for dc in 0..i32::from(token.grid_w.max(1)) {
                        for dr in 0..i32::from(token.grid_h.max(1)) {
                            let c = GridCell {
                                col: start_col + dc,
                                row: start_row + dr,
                            };
                            if affected_cells.contains(&c) {
                                overlaps = true;
                                break;
                            }
                        }
                    }
                    overlaps
                }
            };
            if hit {
                hit_tokens.push(token.id);
            }
        }

        (affected_cells, hit_tokens)
    }
}

fn normalize_angle_deg(mut deg: f64) -> f64 {
    while deg > 180.0 {
        deg -= 360.0;
    }
    while deg < -180.0 {
        deg += 360.0;
    }
    deg
}
