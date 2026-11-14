//! ============================================================================
//! S3 CONFIGURATION SUITE (s3_config_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Pins how `ServerConfig::from_lookup` resolves the `S3_*` variables that
//!   select `S3Store` over PostgreSQL asset storage (ADR-0041).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - No `S3_*` variable keeps assets in PostgreSQL.
//!   - Outside dev, a partial or malformed set is a `ConfigError`, so a typo
//!     never silently keeps assets in PostgreSQL (fail closed).
//!   - In dev, a partial set is ignored with a warning.
//!   - A complete set adds the public endpoint's origin to the SPA CSP `img-src`.
//! ============================================================================

use trame_server::config::{
    ConfigError, DATABASE_URL_VAR, INVITE_JWT_SECRET_VAR, JWT_SECRET_VAR,
    MASTER_ENCRYPTION_KEY_VAR, PUBLIC_ORIGIN_VAR, S3_ACCESS_KEY_ID_VAR, S3_BUCKET_VAR,
    S3_ENDPOINT_VAR, S3_PUBLIC_ENDPOINT_VAR, S3_REGION_VAR, S3_SECRET_ACCESS_KEY_VAR, ServerConfig,
    TRAME_ENV_VAR,
};
use trame_server::security::spa_csp;
use trame_server::storage::s3::{DEFAULT_S3_REGION, S3Endpoint};

type Vars = Vec<(&'static str, String)>;

const SECRET_KEY: &str = "s3-secret-access-key-value";

fn production(extra: &[(&'static str, &str)]) -> Vars {
    let mut vars = vec![
        (MASTER_ENCRYPTION_KEY_VAR, "ab".repeat(32)),
        (JWT_SECRET_VAR, "x".repeat(32)),
        (INVITE_JWT_SECRET_VAR, "y".repeat(32)),
        (PUBLIC_ORIGIN_VAR, "https://trame.example".to_string()),
        (DATABASE_URL_VAR, "postgresql://trame@db/trame".to_string()),
    ];
    vars.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    vars
}

fn complete_s3() -> Vec<(&'static str, &'static str)> {
    vec![
        (S3_ENDPOINT_VAR, "https://acct.r2.cloudflarestorage.com"),
        (S3_BUCKET_VAR, "trame-assets"),
        (S3_ACCESS_KEY_ID_VAR, "AKIDEXAMPLE"),
        (S3_SECRET_ACCESS_KEY_VAR, SECRET_KEY),
    ]
}

fn resolve(vars: &Vars) -> Result<ServerConfig, ConfigError> {
    ServerConfig::from_lookup(|key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone()))
}

#[test]
fn partial_or_malformed_s3_config_fails_closed_outside_dev() {
    let with_complete = |overrides: &[(&'static str, &'static str)]| {
        let mut s3 = complete_s3();
        s3.retain(|(k, _)| !overrides.iter().any(|(o, _)| o == k));
        s3.extend(overrides);
        s3
    };
    // (case_id, S3 variables, expected missing, expected invalid count)
    let cases: Vec<(&str, Vec<(&'static str, &'static str)>, Vec<&str>, usize)> = vec![
        (
            "endpoint_only_lists_the_other_required_vars",
            vec![(S3_ENDPOINT_VAR, "https://acct.r2.cloudflarestorage.com")],
            vec![
                S3_BUCKET_VAR,
                S3_ACCESS_KEY_ID_VAR,
                S3_SECRET_ACCESS_KEY_VAR,
            ],
            0,
        ),
        (
            "optional_region_alone_still_counts_as_partial",
            vec![(S3_REGION_VAR, "auto")],
            vec![
                S3_ENDPOINT_VAR,
                S3_BUCKET_VAR,
                S3_ACCESS_KEY_ID_VAR,
                S3_SECRET_ACCESS_KEY_VAR,
            ],
            0,
        ),
        (
            "missing_secret_key",
            complete_s3()
                .into_iter()
                .filter(|(k, _)| *k != S3_SECRET_ACCESS_KEY_VAR)
                .collect(),
            vec![S3_SECRET_ACCESS_KEY_VAR],
            0,
        ),
        (
            "endpoint_without_http_scheme",
            with_complete(&[(S3_ENDPOINT_VAR, "acct.r2.cloudflarestorage.com")]),
            vec![],
            1,
        ),
        (
            "endpoint_with_path",
            with_complete(&[(S3_ENDPOINT_VAR, "https://s3.example/bucket")]),
            vec![],
            1,
        ),
        (
            "public_endpoint_with_query",
            with_complete(&[(S3_PUBLIC_ENDPOINT_VAR, "https://cdn.example/?x=1")]),
            vec![],
            1,
        ),
        (
            "bucket_with_slash",
            with_complete(&[(S3_BUCKET_VAR, "trame/assets")]),
            vec![],
            1,
        ),
    ];
    for (case, s3, missing, invalid) in cases {
        let Err(err) = resolve(&production(&s3)) else {
            panic!("case {case}: expected ConfigError");
        };
        assert_eq!(err.missing, missing, "case {case}");
        assert_eq!(err.invalid.len(), invalid, "case {case}: {:?}", err.invalid);
    }
}

#[test]
fn s3_config_selects_the_store_and_extends_the_csp() {
    let full_with = |extra: &[(&'static str, &'static str)]| {
        let mut s3 = complete_s3();
        s3.extend(extra);
        production(&s3)
    };
    let mut dev_partial = vec![(TRAME_ENV_VAR, "dev".to_string())];
    dev_partial.push((S3_ENDPOINT_VAR, "http://minio:9000".to_string()));
    // (case_id, vars, expected (public origin, region) when S3Store is selected)
    let cases: Vec<(&str, Vars, Option<(&str, &str)>)> = vec![
        ("no_s3_vars_keeps_postgres", production(&[]), None),
        ("dev_partial_config_is_ignored", dev_partial, None),
        (
            "complete_config_defaults_region_and_public_endpoint",
            full_with(&[]),
            Some(("https://acct.r2.cloudflarestorage.com", DEFAULT_S3_REGION)),
        ),
        (
            "public_endpoint_and_region_override_defaults",
            full_with(&[
                (S3_PUBLIC_ENDPOINT_VAR, "https://assets.example:8443/"),
                (S3_REGION_VAR, "eu-west-3"),
            ]),
            Some(("https://assets.example:8443", "eu-west-3")),
        ),
        (
            "whitespace_only_values_count_as_unset",
            production(&[(S3_ENDPOINT_VAR, "  "), (S3_BUCKET_VAR, "")]),
            None,
        ),
    ];
    for (case, vars, expected) in cases {
        let config = resolve(&vars).unwrap_or_else(|e| panic!("case {case}: {e}"));
        let got = config
            .s3
            .as_ref()
            .map(|s3| (s3.public_endpoint.origin(), s3.region.clone()));
        assert_eq!(
            got,
            expected.map(|(origin, region)| (origin.to_string(), region.to_string())),
            "case {case}"
        );
        let asset_origin = config.security.asset_origin.as_deref();
        assert_eq!(
            asset_origin,
            expected.map(|(origin, _)| origin),
            "case {case}"
        );
        if let Some(s3) = &config.s3 {
            assert_eq!(
                s3.endpoint,
                S3Endpoint::parse("https://acct.r2.cloudflarestorage.com").unwrap(),
                "case {case}"
            );
            assert_eq!(s3.bucket, "trame-assets", "case {case}");
            assert!(
                !format!("{s3:?}").contains(SECRET_KEY),
                "case {case}: Debug must redact the secret key"
            );
        }
        let csp = spa_csp(Some("trame.example"), asset_origin);
        let img_src = csp.split(';').find(|d| d.contains("img-src")).unwrap();
        assert_eq!(
            img_src.trim(),
            match expected {
                Some((origin, _)) => format!("img-src 'self' {origin}"),
                None => "img-src 'self'".to_string(),
            },
            "case {case}"
        );
    }
}
