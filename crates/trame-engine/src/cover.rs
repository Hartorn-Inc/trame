//! ============================================================================
//! COVER SUGGESTION FROM WALLS: CORNER-TO-CORNER GRID LINES (cover.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Suggests the cover a target has against an attacker (`None`, `Half`,
//! `ThreeQuarters`, `Total`) from the wall segments between them, so the
//! Game Master does not eyeball every attack behind a pillar or doorway. The
//! result is a suggestion only: no command applies it. The attacker or the GM
//! confirms or overrides it in the resolution flow, which then adds the bonus
//! to AC or to the Dexterity saving throw (SRD 5.2.1: Half `+2`, Three-Quarters
//! `+5`, Total cannot be targeted directly).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Corner-to-Corner Sampling Rule` (the grid variant of the cover rules):
//!      - For one corner of the attacker's space and one square of the target,
//!        trace the 4 lines from that corner to the 4 corners of that square
//!        and count the lines blocked by a wall.
//!      - Every corner of every square the attacker occupies is tried against
//!        every square the target occupies; the attacker picks the most
//!        favorable pair, so the suggestion is the minimum blocked count.
//!      - Minimum blocked lines: `0` -> `None`, `1..=2` -> `Half`,
//!        `3` -> `ThreeQuarters`, `4` -> `Total` (no line reaches the target).
//!   2. `Physical Walls Only`:
//!      - A wall counts when it blocks movement for a material creature
//!        (`WallSegment::effective_blocks_movement(false)`): closed doors and
//!        secret doors, windows, terrain and one-way walls count; open doors
//!        and illusions do not. Creatures never provide cover here.
//!   3. `Strict Interior Crossings`:
//!      - A crossing at a line's own endpoint (`t <= 1e-6` or `t >= 1 - 1e-6`)
//!        is ignored, so a wall drawn along the grid line a token stands on
//!        never covers that token; collinear walls never block.
//!   4. `2.5D Height Check`:
//!      - Each line runs from the attacker's mid-height to the target's
//!        mid-height (`elevation_ft + height_ft / 2`); a wall only blocks when
//!        the interpolated height at the crossing lies within its vertical span.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `suggest_cover(walls, attacker, target, cell_size_px)`
//!     ├── 1. Keep the walls that physically block a material creature.
//!     ├── 2. For each attacker corner x target square, count blocked lines.
//!     ├── 3. Stop early when a pair has no blocked line (`None`).
//!     └── 4. Map the minimum blocked count to a `CoverLevel`.
//! ============================================================================

use crate::aoe::TokenSpatialRef;
use crate::geometry::{Point2D, WallSegment, segment_intersection};
use serde::{Deserialize, Serialize};

/// Cover a target has against one attacker, suggested from the walls between them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoverLevel {
    /// No line from the best attacker corner is blocked: no bonus.
    None,
    /// One or two of the four lines are blocked: `+2` to AC and Dexterity saves.
    Half,
    /// Three of the four lines are blocked: `+5` to AC and Dexterity saves.
    ThreeQuarters,
    /// All four lines are blocked from every corner: the target cannot be targeted directly.
    Total,
}

impl CoverLevel {
    /// Bonus to AC and Dexterity saving throws (`0`, `2` or `5`); `None` for `Total` cover,
    /// which forbids direct targeting instead of granting a bonus.
    pub fn bonus(self) -> Option<i32> {
        match self {
            Self::None => Some(0),
            Self::Half => Some(2),
            Self::ThreeQuarters => Some(5),
            Self::Total => None,
        }
    }

    fn from_blocked_lines(blocked: usize) -> Self {
        match blocked {
            0 => Self::None,
            1 | 2 => Self::Half,
            3 => Self::ThreeQuarters,
            _ => Self::Total,
        }
    }
}

/// Suggests the cover `target` has against `attacker` from `walls` (corner-to-corner rule in
/// the module banner). Footprints use `cell_size_px` squares (`> 0`) from each token's
/// `top_left`; pass the squeeze-reduced `TokenSpatialRef`.
pub fn suggest_cover(
    walls: &[WallSegment],
    attacker: &TokenSpatialRef,
    target: &TokenSpatialRef,
    cell_size_px: f64,
) -> CoverLevel {
    let blockers: Vec<&WallSegment> = walls
        .iter()
        .filter(|w| w.effective_blocks_movement(false))
        .collect();
    let attacker_z = attacker.elevation_ft + attacker.height_ft / 2.0;
    let target_z = target.elevation_ft + target.height_ft / 2.0;
    let line_blocked = |from: Point2D, to: Point2D| {
        blockers.iter().any(|wall| {
            segment_intersection(from, to, wall.a, wall.b).is_some_and(|(t, _)| {
                let z = attacker_z + t * (target_z - attacker_z);
                t > 1e-6
                    && t < 1.0 - 1e-6
                    && z >= wall.bottom_elevation_ft
                    && z <= wall.top_elevation_ft
            })
        })
    };

    let corners = attacker_corners(attacker, cell_size_px);
    let squares = target_squares(target, cell_size_px);
    let mut best = 4usize;
    for corner in &corners {
        for square in &squares {
            let blocked = square.iter().filter(|&&c| line_blocked(*corner, c)).count();
            best = best.min(blocked);
            if best == 0 {
                return CoverLevel::None;
            }
        }
    }
    CoverLevel::from_blocked_lines(best)
}

/// Every grid corner of the attacker's space: a `(w + 1) x (h + 1)` lattice.
fn attacker_corners(token: &TokenSpatialRef, cell_px: f64) -> Vec<Point2D> {
    let (w, h) = (token.grid_w.max(1), token.grid_h.max(1));
    (0..=w)
        .flat_map(|dx| {
            (0..=h).map(move |dy| {
                Point2D::new(
                    token.top_left.x + f64::from(dx) * cell_px,
                    token.top_left.y + f64::from(dy) * cell_px,
                )
            })
        })
        .collect()
}

/// The four corners of every square the target occupies.
fn target_squares(token: &TokenSpatialRef, cell_px: f64) -> Vec<[Point2D; 4]> {
    let (w, h) = (token.grid_w.max(1), token.grid_h.max(1));
    (0..w)
        .flat_map(|dx| {
            (0..h).map(move |dy| {
                let x0 = token.top_left.x + f64::from(dx) * cell_px;
                let y0 = token.top_left.y + f64::from(dy) * cell_px;
                [
                    Point2D::new(x0, y0),
                    Point2D::new(x0 + cell_px, y0),
                    Point2D::new(x0, y0 + cell_px),
                    Point2D::new(x0 + cell_px, y0 + cell_px),
                ]
            })
        })
        .collect()
}
