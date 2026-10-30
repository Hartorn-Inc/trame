//! `trame-engine`: Pure Rust spatial BVH raycasting, AoE wall-clipping,
//! `derivedDAG` formula evaluator, 5-phase `ActiveEffect` modifier resolver,
//! and `TrameCommand` state reducer compiled to both native Rust (`trame-server`)
//! and WebAssembly (`packages/web`).

pub mod aoe;
pub mod commands;
pub mod geometry;
pub mod rules;

use crate::aoe::AoeTemplate;
use crate::geometry::{Bvh2D, Point2D, WallSegment};
use wasm_bindgen::prelude::*;

/// WebAssembly entrypoint: computes a JSON-serialized radial visibility polygon
/// around `(origin_x, origin_y)` at `observer_eye_ft` given a JSON array of `WallSegment`s.
#[wasm_bindgen]
pub fn wasm_compute_visibility_polygon(
    walls_json: &str,
    origin_x: f64,
    origin_y: f64,
    observer_eye_ft: f64,
    max_range_px: f64,
    has_truesight: bool,
) -> Result<String, JsValue> {
    let walls: Vec<WallSegment> = serde_json::from_str(walls_json)
        .map_err(|e| JsValue::from_str(&format!("invalid walls_json: {e}")))?;
    let bvh = Bvh2D::build(walls);
    let poly = bvh.compute_visibility_polygon(
        Point2D::new(origin_x, origin_y),
        observer_eye_ft,
        max_range_px,
        has_truesight,
    );
    serde_json::to_string(&poly).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// WebAssembly entrypoint: computes the affected grid cells for an `AoeTemplate`
/// clipped against `WallSegment`s for zero-latency client-side spell aiming.
#[wasm_bindgen]
pub fn wasm_preview_aoe_cells(
    walls_json: &str,
    aoe_json: &str,
    cell_size_px: f64,
    feet_per_cell: f64,
) -> Result<String, JsValue> {
    let walls: Vec<WallSegment> = serde_json::from_str(walls_json)
        .map_err(|e| JsValue::from_str(&format!("invalid walls_json: {e}")))?;
    let template: AoeTemplate = serde_json::from_str(aoe_json)
        .map_err(|e| JsValue::from_str(&format!("invalid aoe_json: {e}")))?;
    let bvh = Bvh2D::build(walls);
    let (cells, _) = template.evaluate_targets(&[], cell_size_px, feet_per_cell, &bvh);
    serde_json::to_string(&cells).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::aoe::*;
    use super::commands::*;
    use super::geometry::*;
    use super::rules::*;
    use std::collections::BTreeMap;
    use uuid::Uuid;

    #[test]
    fn bvh_blocks_normal_wall_and_obeys_terrain_two_hit_rule() {
        let normal_wall = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(50.0, 0.0),
            Point2D::new(50.0, 100.0),
        );
        let bvh_normal = Bvh2D::build(vec![normal_wall]);
        assert!(!bvh_normal.has_line_of_sight(
            Point2D::new(10.0, 50.0),
            5.0,
            Point2D::new(90.0, 50.0),
            5.0,
            false
        ));

        // Terrain two-hit rule: 1 terrain wall allows LoS into the boulder, 2 terrain walls block LoS behind it
        let mut t1 = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(40.0, 0.0),
            Point2D::new(40.0, 100.0),
        );
        t1.kind = WallKind::Terrain;
        let mut t2 = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(60.0, 0.0),
            Point2D::new(60.0, 100.0),
        );
        t2.kind = WallKind::Terrain;

        let bvh_terrain = Bvh2D::build(vec![t1, t2]);
        // Observer at x=10 can see inside the boulder at x=50 (only 1 terrain wall crossed)
        assert!(bvh_terrain.has_line_of_sight(
            Point2D::new(10.0, 50.0),
            5.0,
            Point2D::new(50.0, 50.0),
            5.0,
            false
        ));
        // Observer at x=10 CANNOT see past the second edge at x=80 (2 terrain walls crossed)
        assert!(!bvh_terrain.has_line_of_sight(
            Point2D::new(10.0, 50.0),
            5.0,
            Point2D::new(80.0, 50.0),
            5.0,
            false
        ));
    }

    #[test]
    fn bvh_elevation_horizon_allows_seeing_over_low_wall() {
        let mut low_wall = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(50.0, 0.0),
            Point2D::new(50.0, 100.0),
        );
        low_wall.bottom_elevation_ft = 0.0;
        low_wall.top_elevation_ft = 10.0;
        let bvh = Bvh2D::build(vec![low_wall]);

        // Ground-level observer (5ft eye) cannot see ground-level target (5ft eye)
        assert!(!bvh.has_line_of_sight(
            Point2D::new(10.0, 50.0),
            5.0,
            Point2D::new(90.0, 50.0),
            5.0,
            false
        ));
        // Flying observer at 25ft eye height sees over the 10ft wall to a flying target at 25ft
        assert!(bvh.has_line_of_sight(
            Point2D::new(10.0, 50.0),
            25.0,
            Point2D::new(90.0, 50.0),
            25.0,
            false
        ));
    }

    #[test]
    fn large_token_multi_point_footprint_peeks_around_corner() {
        // Wall blocks y < 100 at x = 100, leaving y > 100 open
        let wall = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(100.0, 0.0),
            Point2D::new(100.0, 100.0),
        );
        let bvh = Bvh2D::build(vec![wall]);
        let senses = SenseProfile::default();

        // Large dragon (2x2 cells, 100px per cell -> 200x200px at top-left (120, 0))
        // Its top quadrants (y=50) are behind the wall, but its bottom quadrants (y=150) are exposed!
        let visible = can_token_see_target(
            &bvh,
            Point2D::new(0.0, 120.0), // Observer at (50, 170)
            1,
            1,
            5.0,
            &senses,
            Point2D::new(120.0, 0.0), // Large 2x2 target spanning y=0..200
            2,
            2,
            10.0,
            CHANNEL_MATERIAL,
            false,
            100.0,
            5.0,
        );
        assert!(visible);
    }

    #[test]
    fn aoe_sphere_clips_against_walls_and_discretizes_modes() {
        // Wall at x = 150 blocks the right side of the fireball
        let wall = WallSegment::normal_wall(
            Uuid::new_v4(),
            Point2D::new(150.0, -500.0),
            Point2D::new(150.0, 500.0),
        );
        let bvh = Bvh2D::build(vec![wall]);

        let fireball = AoeTemplate {
            id: Uuid::new_v4(),
            origin: Point2D::new(50.0, 50.0), // Center of cell (0, 0)
            origin_elevation_ft: 0.0,
            shape: AoeShape::Sphere { radius_ft: 20.0 }, // 4 cells radius (400px)
            stops_at_walls: true,
            discretization: GridDiscretizationMode::CenterPoint,
            concentration_caster_id: None,
        };

        let token_in_front = TokenSpatialRef {
            id: Uuid::new_v4(),
            top_left: Point2D::new(0.0, 0.0), // Cell (0, 0) -> x=50
            grid_w: 1,
            grid_h: 1,
            elevation_ft: 0.0,
            height_ft: 5.0,
        };
        let token_behind_wall = TokenSpatialRef {
            id: Uuid::new_v4(),
            top_left: Point2D::new(200.0, 0.0), // Cell (2, 0) -> x=250 (behind wall at x=150)
            grid_w: 1,
            grid_h: 1,
            elevation_ft: 0.0,
            height_ft: 5.0,
        };

        let (_, hit_ids) = fireball.evaluate_targets(
            &[token_in_front.clone(), token_behind_wall.clone()],
            100.0,
            5.0,
            &bvh,
        );
        assert_eq!(hit_ids, vec![token_in_front.id]);
    }

    #[test]
    fn derived_dag_and_5_phase_active_effects_with_non_stacking() {
        let mut base = BTreeMap::new();
        base.insert("abilities.dex.score".to_string(), 16.0);
        base.insert("proficiency_bonus".to_string(), 3.0);

        let mut formulas = BTreeMap::new();
        formulas.insert(
            "abilities.dex.mod".to_string(),
            "floor((abilities.dex.score - 10) / 2)".to_string(),
        );
        formulas.insert("ac.base".to_string(), "10 + abilities.dex.mod".to_string());

        // Mage Armor (BASE 13 + DEX -> we model as Base 13 on ac.unarmored or Add +3) + two Bless effects (same source name shouldn't stack)
        let eff1 = ActiveEffect {
            id: Uuid::new_v4(),
            source_name: "Spell:ShieldOfFaith".to_string(),
            enabled: true,
            duration_rounds_remaining: Some(10),
            concentration_caster_id: None,
            modifiers: vec![AttributeModifier {
                target: "ac.base".to_string(),
                phase: ModifierPhase::Add,
                value: 2.0,
            }],
        };
        let eff2_duplicate = ActiveEffect {
            id: Uuid::new_v4(),
            source_name: "Spell:ShieldOfFaith".to_string(),
            enabled: true,
            duration_rounds_remaining: Some(10),
            concentration_caster_id: None,
            modifiers: vec![AttributeModifier {
                target: "ac.base".to_string(),
                phase: ModifierPhase::Add,
                value: 2.0,
            }],
        };

        let resolved =
            evaluate_actor_attributes(&base, &formulas, &[eff1, eff2_duplicate]).unwrap();
        assert_eq!(resolved["abilities.dex.mod"], 3.0);
        // 10 + 3 (DEX) + 2 (single Shield of Faith, duplicate ignored) = 15
        assert_eq!(resolved["ac.base"], 15.0);
    }

    #[test]
    fn command_reducer_enforces_rbac_damage_concentration_and_undo() {
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        let player_id = Uuid::new_v4();
        let token_id = Uuid::new_v4();
        let mut tok = TokenState::new_default(token_id, "Ezren", Point2D::new(0.0, 0.0));
        tok.owner_user_id = Some(player_id);
        tok.hp = 30;
        tok.max_hp = 30;
        tok.temp_hp = 5;
        state.data.tokens.insert(token_id, tok);

        let gm = CommandActor {
            user_id: Uuid::new_v4(),
            role: CampaignRole::Gm,
        };
        let player = CommandActor {
            user_id: player_id,
            role: CampaignRole::Player,
        };

        // Player casts a persistent concentration AoE
        let aoe_id = Uuid::new_v4();
        state
            .apply_command(
                &player,
                TrameCommand::ProjectAoe {
                    template: AoeTemplate {
                        id: aoe_id,
                        origin: Point2D::new(200.0, 200.0),
                        origin_elevation_ft: 0.0,
                        shape: AoeShape::Sphere { radius_ft: 15.0 },
                        stops_at_walls: true,
                        discretization: GridDiscretizationMode::CenterPoint,
                        concentration_caster_id: Some(token_id),
                    },
                    persist_zone: true,
                },
            )
            .unwrap();
        assert_eq!(
            state.data.tokens[&token_id].concentrating_on_aoe_id,
            Some(aoe_id)
        );

        // GM applies 28 fire damage to Resistant target -> 14 final damage (5 absorbed by temp_hp, 9 HP lost)
        // Concentration DC = max(10, floor(14 / 2)) = 10
        let events = state
            .apply_command(
                &gm,
                TrameCommand::ApplyDamage {
                    token_id,
                    raw_damage: 28,
                    affinity: DamageAffinity::Resistant,
                },
            )
            .unwrap();

        match &events[0] {
            TrameEvent::DamageApplied { resolution, .. } => {
                assert_eq!(resolution.final_damage, 14);
                assert_eq!(resolution.temp_hp_absorbed, 5);
                assert_eq!(resolution.new_hp, 21);
                assert_eq!(resolution.concentration_check_dc, Some(10));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        // GM clicks Undo -> HP and Temp HP return to 30 and 5!
        state
            .apply_command(&gm, TrameCommand::UndoLastAction)
            .unwrap();
        assert_eq!(state.data.tokens[&token_id].hp, 30);
        assert_eq!(state.data.tokens[&token_id].temp_hp, 5);
    }
}
