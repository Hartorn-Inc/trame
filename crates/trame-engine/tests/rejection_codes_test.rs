//! Rejection codes: every `CommandError` carries a stable code and structured detail
//! (`RejectionDetail`) that clients localize, so refusals reach players in their language
//! with feet instead of an English message with pixel coordinates. Table-driven; every case
//! carries a descriptive ID printed on failure.

use trame_engine::commands::{CommandError as E, COMMAND_ERROR_CODES};

/// One error per variant. The exhaustive `match` (no wildcard) stops compiling when a
/// variant is added, so the new variant must get a code and a case here.
fn one_error_per_variant() -> Vec<E> {
    let all = vec![
        E::PermissionDenied("x".into()),
        E::NotFound("x".into()),
        E::ExplorationPaused,
        E::NotActiveTurn,
        E::InsufficientMovement {
            needed_ft: 15.0,
            remaining_ft: 10.0,
        },
        E::SpeedZero,
        E::WallCollision { x: 1.0, y: 2.0 },
        E::DoorLocked,
        E::DoorOutOfReach,
        E::RateLimited,
        E::ConditionImmune("paralyzed".into()),
        E::InvalidConfiguration("x".into()),
        E::NothingToUndo,
        E::ReactionPending,
        E::ReactionUnavailable,
        E::BatchCommandFailed {
            index: 0,
            source: Box::new(E::DoorLocked),
        },
    ];
    for e in &all {
        match e {
            E::PermissionDenied(_)
            | E::NotFound(_)
            | E::ExplorationPaused
            | E::NotActiveTurn
            | E::InsufficientMovement { .. }
            | E::SpeedZero
            | E::WallCollision { .. }
            | E::DoorLocked
            | E::DoorOutOfReach
            | E::RateLimited
            | E::ConditionImmune(_)
            | E::InvalidConfiguration(_)
            | E::NothingToUndo
            | E::ReactionPending
            | E::ReactionUnavailable
            | E::BatchCommandFailed { .. } => {}
        }
    }
    all
}

#[test]
fn every_command_error_has_a_listed_code_and_codes_are_unique() {
    let codes: Vec<&str> = one_error_per_variant().iter().map(E::code).collect();
    let unknown: Vec<&&str> = codes
        .iter()
        .filter(|c| !COMMAND_ERROR_CODES.contains(c))
        .collect();
    assert!(
        unknown.is_empty(),
        "codes missing from COMMAND_ERROR_CODES: {unknown:?}"
    );
    let mut listed = COMMAND_ERROR_CODES.to_vec();
    listed.sort_unstable();
    listed.dedup();
    assert_eq!(listed.len(), COMMAND_ERROR_CODES.len(), "duplicate codes");
    let mut used = codes;
    used.sort_unstable();
    used.dedup();
    assert_eq!(used, listed, "every listed code belongs to a variant");
}

#[test]
fn rejection_details_carry_feet_and_conditions_not_pixels() {
    // (code, needed_ft, remaining_ft, condition)
    type Expected = (&'static str, Option<f64>, Option<f64>, Option<&'static str>);
    let cases: Vec<(&str, E, Expected)> = vec![
        (
            "insufficient_movement_reports_both_budgets_in_feet",
            E::InsufficientMovement {
                needed_ft: 15.0,
                remaining_ft: 10.0,
            },
            ("INSUFFICIENT_MOVEMENT", Some(15.0), Some(10.0), None),
        ),
        (
            "condition_immunity_names_the_condition",
            E::ConditionImmune("paralyzed".into()),
            ("CONDITION_IMMUNE", None, None, Some("paralyzed")),
        ),
        (
            "wall_collision_has_no_pixel_coordinates",
            E::WallCollision { x: 140.0, y: 70.0 },
            ("WALL_COLLISION", None, None, None),
        ),
        (
            "batch_failure_reports_the_failing_sub_command",
            E::BatchCommandFailed {
                index: 2,
                source: Box::new(E::InsufficientMovement {
                    needed_ft: 20.0,
                    remaining_ft: 5.0,
                }),
            },
            ("INSUFFICIENT_MOVEMENT", Some(20.0), Some(5.0), None),
        ),
    ];
    for (case, err, (code, needed, remaining, condition)) in cases {
        let d = err.rejection_detail();
        assert_eq!(d.code, code, "case {case}");
        assert_eq!(d.needed_ft, needed, "case {case}");
        assert_eq!(d.remaining_ft, remaining, "case {case}");
        assert_eq!(d.condition.as_deref(), condition, "case {case}");
        assert!(
            !err.to_string().contains("140"),
            "case {case}: no pixels in the message"
        );
    }
}
