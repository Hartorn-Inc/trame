//! ============================================================================
//! TRAME ENGINE CORE & WEBASSEMBLY ENTRYPOINTS (lib.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Exposes the deterministic spatial 2.5D Bounding Volume Hierarchy (BVH)
//! raycaster, Area of Effect (AoE) wall-clipping discretizer, `derivedDAG`
//! formula evaluator, 5-phase `ActiveEffect` modifier pipeline, and
//! authoritative `TrameCommand` state reducer to both the native server runtime
//! (`trame-server`) and the browser WebAssembly runtime (`packages/web`).
//! Sharing this exact crate across client and server eliminates client-server
//! divergence during token drag previews, dynamic lighting polygon generation,
//! and spell template aiming.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Client-Server Mathematical Parity`:
//!      - Both native server validation and browser WASM previews invoke the
//!        identical `Bvh2D::compute_visibility_polygon` and
//!        `AoeTemplate::evaluate_targets` algorithms, guaranteeing zero drift
//!        between local aiming overlays and authoritative server resolution.
//!   2. `Fail-Closed JSON Boundary`:
//!      - WebAssembly entrypoints (`wasm_compute_visibility_polygon` and
//!        `wasm_preview_aoe_cells`) deserialize untrusted JSON inputs via
//!        `serde_json` and return explicit `Result<String, JsValue>` errors
//!        rather than panicking across the WASM FFI boundary.
//!   3. `Pure Deterministic Execution`:
//!      - All functions in `trame-engine` are free of I/O, network calls, and
//!        ambient system clocks so that state transitions and WAL replays
//!        remain 100% reproducible.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `wasm_compute_visibility_polygon(walls_json, origin_x, origin_y, ...)`
//!     ├── 1. Deserialize `Vec<WallSegment>` from `walls_json`.
//!     ├── 2. Construct balanced 2.5D `Bvh2D` acceleration tree.
//!     ├── 3. Cast radial rays across wall endpoints (`±1e-4` rad offsets).
//!     └── 4. Serialize resulting `Vec<Point2D>` polygon back to JSON string.
//!
//!   `wasm_preview_aoe_cells(walls_json, aoe_json, cell_size_px, feet_per_cell)`
//!     ├── 1. Deserialize `Vec<WallSegment>` and `AoeTemplate` payloads.
//!     ├── 2. Build `Bvh2D` spatial index for wall-occlusion clipping.
//!     ├── 3. Discretize affected `GridCell` coordinates under the chosen mode.
//!     └── 4. Serialize affected `Vec<GridCell>` list back to JSON string.
//! ============================================================================

pub mod aoe;
pub mod commands;
pub mod geometry;
pub mod rules;

use crate::aoe::AoeTemplate;
pub use crate::commands::{
    AmbientLightingPreset, CampaignRole, CommandActor, CommandError, FogOverrideCell,
    FogOverrideMode, LightSource, McpStagingProposal, ReactionDecision, ReactionPrompt, TableMode,
    TableSnapshotData, TableState, TokenState, TrameCommand, TrameEvent, UndoEntry,
};
pub use crate::geometry::{Bvh2D, Point2D, SenseProfile, WallKind, WallSegment};
pub use crate::rules::{
    ActiveEffect, AttributeModifier, DamageAffinity, DamageResolution, ModifierPhase,
    RulesEngineError, evaluate_actor_attributes, evaluate_derived_dag, resolve_damage_application,
};
use wasm_bindgen::prelude::*;

/// WebAssembly entrypoint that computes a JSON-serialized 2D radial visibility
/// polygon around `(origin_x, origin_y)` (in canvas pixels) at eye elevation
/// `observer_eye_ft` (in feet) up to `max_range_px` (in pixels) against a JSON
/// array of `WallSegment` primitives.
///
/// When `has_truesight` is `true`, illusionary walls marked with
/// `pierced_by_truesight: true` do not block the visibility rays. Returns a
/// `JsValue` error string if `walls_json` fails schema deserialization.
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

/// WebAssembly entrypoint that computes the JSON-serialized list of `GridCell`
/// coordinates affected by an `AoeTemplate` (`aoe_json`) clipped against
/// `WallSegment`s (`walls_json`), given `cell_size_px` (in pixels, `> 0.0`) and
/// `feet_per_cell` (in feet, typically `5.0`).
///
/// Used by the browser canvas for 60 FPS zero-latency spell aiming previews.
/// Fails closed with a `JsValue` error if either JSON payload is malformed.
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

    #[test]
    fn test_move_token_wall_blocking_and_gm_override() {
        let wall = WallSegment {
            id: Uuid::new_v4(),
            a: Point2D::new(150.0, 0.0),
            b: Point2D::new(150.0, 500.0),
            bottom_elevation_ft: 0.0,
            top_elevation_ft: 10.0,
            kind: WallKind::Door {
                is_open: false,
                is_locked: false,
            },
            blocks_vision: true,
            blocks_light: true,
            blocks_movement: true,
            blocks_sound: true,
        };
        let mut state = TableState::new(100.0, 5.0, vec![wall.clone()]);
        let player_id = Uuid::new_v4();
        let token_id = Uuid::new_v4();
        let mut tok = TokenState::new_default(token_id, "Valeros", Point2D::new(0.0, 100.0));
        tok.owner_user_id = Some(player_id);
        state.data.tokens.insert(token_id, tok);

        let player = CommandActor {
            user_id: player_id,
            role: CampaignRole::Player,
        };
        let gm = CommandActor {
            user_id: Uuid::new_v4(),
            role: CampaignRole::Gm,
        };

        // Closed door blocks non-GM movement across x=150
        let err = state
            .apply_command(
                &player,
                TrameCommand::MoveToken {
                    token_id,
                    to_top_left: Point2D::new(200.0, 100.0),
                    to_elevation_ft: Some(0.0),
                    gm_teleport: false,
                },
            )
            .unwrap_err();
        assert!(matches!(err, CommandError::WallCollision { .. }));

        // GM teleport bypasses wall blocking
        state
            .apply_command(
                &gm,
                TrameCommand::MoveToken {
                    token_id,
                    to_top_left: Point2D::new(200.0, 100.0),
                    to_elevation_ft: Some(0.0),
                    gm_teleport: true,
                },
            )
            .unwrap();
        assert_eq!(state.data.tokens[&token_id].top_left.x, 200.0);

        // Open the door -> player can move back across
        state
            .apply_command(
                &player,
                TrameCommand::ToggleDoor {
                    wall_id: wall.id,
                    is_open: true,
                },
            )
            .unwrap();
        state
            .apply_command(
                &player,
                TrameCommand::MoveToken {
                    token_id,
                    to_top_left: Point2D::new(0.0, 100.0),
                    to_elevation_ft: Some(0.0),
                    gm_teleport: false,
                },
            )
            .unwrap();
        assert_eq!(state.data.tokens[&token_id].top_left.x, 0.0);
    }

    #[test]
    fn test_tabletop_setup_reactions_and_mcp_staging_commands() {
        let mut state = TableState::new(100.0, 5.0, vec![]);
        let gm = CommandActor {
            user_id: Uuid::new_v4(),
            role: CampaignRole::Gm,
        };
        let player_id = Uuid::new_v4();
        let player = CommandActor {
            user_id: player_id,
            role: CampaignRole::Player,
        };

        // 1. SpawnToken & RemoveToken + Undo
        let token_id = Uuid::new_v4();
        let mut token = TokenState::new_default(token_id, "Kyra", Point2D::new(100.0, 100.0));
        token.owner_user_id = Some(player_id);
        state
            .apply_command(&gm, TrameCommand::SpawnToken { token })
            .unwrap();
        assert!(state.data.tokens.contains_key(&token_id));

        // 2. AddWall, AddLight, SetFogOverride, SetMapConfig
        let wall_id = Uuid::new_v4();
        state
            .apply_command(
                &gm,
                TrameCommand::AddWall {
                    wall: WallSegment::normal_wall(
                        wall_id,
                        Point2D::new(0.0, 0.0),
                        Point2D::new(200.0, 0.0),
                    ),
                },
            )
            .unwrap();
        assert_eq!(state.data.walls.len(), 1);

        let light_id = Uuid::new_v4();
        state
            .apply_command(
                &gm,
                TrameCommand::AddLight {
                    light: LightSource {
                        id: light_id,
                        position: Point2D::new(150.0, 150.0),
                        elevation_ft: 5.0,
                        bright_radius_ft: 20.0,
                        dim_radius_ft: 40.0,
                        color_hex: "#FFAA44".to_string(),
                        intensity: 1.0,
                    },
                },
            )
            .unwrap();
        assert_eq!(state.data.lights.len(), 1);

        state
            .apply_command(
                &gm,
                TrameCommand::SetFogOverride {
                    mode: FogOverrideMode::Reveal,
                    cell_x: 3,
                    cell_y: 4,
                },
            )
            .unwrap();
        assert_eq!(state.data.fog_overrides.len(), 1);

        state
            .apply_command(
                &gm,
                TrameCommand::SetMapConfig {
                    background_url: Some("/api/v1/assets/hash123".to_string()),
                    width_ft: 100,
                    height_ft: 80,
                },
            )
            .unwrap();
        assert_eq!(state.data.map_width_px, 2000);
        assert_eq!(state.data.map_height_px, 1600);

        // 3. DecideReaction
        let prompt_id = Uuid::new_v4();
        state.data.active_reaction_prompts.insert(
            prompt_id,
            ReactionPrompt {
                prompt_id,
                reactor_actor_id: token_id,
                trigger_token_id: Uuid::new_v4(),
                pending_destination: Some(Point2D::new(300.0, 100.0)),
                pending_elevation_ft: Some(0.0),
            },
        );
        state
            .apply_command(
                &player,
                TrameCommand::DecideReaction {
                    prompt_id,
                    actor_id: token_id,
                    decision: ReactionDecision::Trigger {
                        ability_id: Some("opportunity_attack".to_string()),
                    },
                },
            )
            .unwrap();
        assert!(state.data.active_reaction_prompts.is_empty());
        assert!(!state.data.tokens[&token_id].has_reaction);

        // 4. CommitMcpStaging & RejectMcpStaging
        let proposal_id = Uuid::new_v4();
        let spawned_by_mcp = Uuid::new_v4();
        state.data.mcp_staging_proposals.insert(
            proposal_id,
            McpStagingProposal {
                proposal_id,
                summary: "Spawn Goblin".to_string(),
                commands: vec![TrameCommand::SpawnToken {
                    token: TokenState::new_default(
                        spawned_by_mcp,
                        "Goblin",
                        Point2D::new(250.0, 250.0),
                    ),
                }],
            },
        );
        state
            .apply_command(&gm, TrameCommand::CommitMcpStaging { proposal_id })
            .unwrap();
        assert!(state.data.tokens.contains_key(&spawned_by_mcp));
        assert!(state.data.mcp_staging_proposals.is_empty());
    }
}
