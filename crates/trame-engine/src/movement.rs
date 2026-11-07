//! ============================================================================
//! GRID MOVEMENT COST: CHEBYSHEV SQUARES & DIFFICULT TERRAIN (movement.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Prices a straight token move on the square grid under SRD 5.2.1: every
//! square entered costs one cell of feet (`5 ft`), diagonals included
//! (Chebyshev distance), and a square of difficult terrain costs double.
//! `TableState::movement_cost_ft` (server `MoveToken` validation and budget
//! deduction) and the `previewMove` WASM export (client drag preview) both call
//! `MovementGrid::movement_cost_ft`, so the number a player sees while dragging
//! is the number the server charges. Without one shared function, a Euclidean
//! client preview would accept diagonal moves that the server rejects.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Chebyshev Horizontal Cost`:
//!      - Horizontal cost is `max(|dx|, |dy|)` in cells times `feet_per_cell`.
//!        Off-grid moves are priced continuously by the same formula.
//!   2. `Vertical Axis`:
//!      - Elevation change is a third Chebyshev axis: the move costs
//!        `max(horizontal_ft, |dz_ft|)`, so climbing 10 ft while stepping one
//!        square costs 10 ft, not 15.
//!   3. `Difficult Terrain Surcharge`:
//!      - The path is split into `ceil(chebyshev_cells)` steps. A step whose
//!        destination footprint (squeeze-reduced `TokenSpatialRef`, top-left
//!        rounded to the nearest cell) overlaps any difficult cell is paid
//!        twice. Difficult terrain never stacks with itself.
//!   4. `Squeezing`:
//!      - A squeezing token pays the whole move twice (after the surcharge).
//!   5. `Bounded Work`:
//!      - At most `MAX_TERRAIN_STEPS` (1,024 squares) are walked; longer paths
//!        skip the surcharge. No creature's turn budget reaches 5,120 ft, so
//!        this never changes a validation outcome, while a hostile far-away
//!        destination cannot stall the room actor.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `MovementGrid::movement_cost_ft(mover, to_top_left, to_elevation_ft, is_squeezing)`
//!     ├── 1. Chebyshev distance in cells between the two top-left corners.
//!     ├── 2. Walk the steps and count those entering difficult terrain.
//!     ├── 3. horizontal = cells * feet_per_cell * (1 + difficult_steps / steps).
//!     └── 4. cost = max(horizontal, |dz|), doubled while squeezing.
//! ============================================================================

use crate::aoe::{GridCell, TokenSpatialRef};
use crate::geometry::Point2D;
use std::collections::BTreeSet;

/// Longest path, in grid squares, on which the difficult-terrain surcharge is evaluated.
pub const MAX_TERRAIN_STEPS: usize = 1024;

/// Square-grid geometry and the difficult cells of the active map.
#[derive(Debug, Clone, Copy)]
pub struct MovementGrid<'a> {
    /// Grid cell edge in pixels (`px`, `> 0`; values `<= 0` are clamped to a tiny positive size).
    pub cell_size_px: f64,
    /// Feet per grid cell (`ft`, typically `5.0`).
    pub feet_per_cell: f64,
    /// Cells of difficult terrain; entering one costs double.
    pub difficult_terrain: &'a BTreeSet<GridCell>,
}

impl MovementGrid<'_> {
    /// Movement cost in feet (`ft`) of moving `mover` (footprint at its current `top_left` and
    /// `elevation_ft`) in a straight line to `to_top_left` at `to_elevation_ft`.
    ///
    /// Formula: `max(cells * feet_per_cell * (1 + difficult_steps / steps), |dz|)`, doubled when
    /// `is_squeezing`. `cells` is the Chebyshev distance in cells and `steps = ceil(cells)`.
    pub fn movement_cost_ft(
        &self,
        mover: &TokenSpatialRef,
        to_top_left: Point2D,
        to_elevation_ft: f64,
        is_squeezing: bool,
    ) -> f64 {
        let cell_px = self.cell_size_px.max(1e-9);
        let dx_cells = (to_top_left.x - mover.top_left.x) / cell_px;
        let dy_cells = (to_top_left.y - mover.top_left.y) / cell_px;
        let cells = dx_cells.abs().max(dy_cells.abs());
        let horizontal_ft = cells * self.feet_per_cell;

        let steps = (cells - 1e-9).ceil().max(0.0) as usize;
        let difficult_steps = if steps == 0 || steps > MAX_TERRAIN_STEPS {
            0
        } else {
            (1..=steps)
                .filter(|&i| {
                    let t = i as f64 / steps as f64;
                    let at = Point2D::new(
                        mover.top_left.x + (to_top_left.x - mover.top_left.x) * t,
                        mover.top_left.y + (to_top_left.y - mover.top_left.y) * t,
                    );
                    self.footprint_is_difficult(at, mover.grid_w, mover.grid_h)
                })
                .count()
        };
        let surcharge_ft = if steps == 0 {
            0.0
        } else {
            horizontal_ft * difficult_steps as f64 / steps as f64
        };

        let vertical_ft = (to_elevation_ft - mover.elevation_ft).abs();
        let cost_ft = (horizontal_ft + surcharge_ft).max(vertical_ft);
        if is_squeezing { cost_ft * 2.0 } else { cost_ft }
    }

    /// `true` when a `grid_w x grid_h` footprint whose top-left is at `top_left` (rounded to the
    /// nearest cell corner) overlaps a difficult cell.
    fn footprint_is_difficult(&self, top_left: Point2D, grid_w: u8, grid_h: u8) -> bool {
        if self.difficult_terrain.is_empty() {
            return false;
        }
        let cell_px = self.cell_size_px.max(1e-9);
        let col0 = (top_left.x / cell_px).round() as i32;
        let row0 = (top_left.y / cell_px).round() as i32;
        (0..i32::from(grid_w.max(1))).any(|dc| {
            (0..i32::from(grid_h.max(1))).any(|dr| {
                self.difficult_terrain.contains(&GridCell {
                    col: col0 + dc,
                    row: row0 + dr,
                })
            })
        })
    }
}
