//! `trame-engine`: Pure Rust spatial BVH raycasting, AoE wall-clipping,
//! derivedDAG evaluator, 5-phase active modifier resolver, and `TrameCommand`
//! state reducer compiled to both native Rust (`trame-server`) and WebAssembly (`packages/web`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f64,
    pub y: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_roundtrip_serialization() {
        let pt = Point2D { x: 12.5, y: -4.0 };
        let json = serde_json::to_string(&pt).expect("serialize Point2D");
        let decoded: Point2D = serde_json::from_str(&json).expect("deserialize Point2D");
        assert_eq!(pt, decoded);
    }
}
