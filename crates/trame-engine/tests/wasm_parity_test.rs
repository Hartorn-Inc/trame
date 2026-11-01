//! Native half of the Rust/WASM parity check: every case in `fixtures/wasm_parity.json` is run
//! through `wasm_api::call_export` and must equal its recorded `expected` outcome
//! (`{ "ok": <response> }` or `{ "error": <message> }`). The WASM half
//! (`packages/web/tests/engine/wasmParity.test.ts`) runs the same file through the Node build,
//! so both runtimes are pinned to identical outputs.
//!
//! Regenerate the expectations after an intentional engine change with
//! `TRAME_BLESS_PARITY_FIXTURES=1 cargo test -p trame-engine --test wasm_parity_test`.

use serde_json::{Value, json};
use std::path::PathBuf;
use trame_engine::wasm_api::call_export;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wasm_parity.json")
}

fn outcome(export: &str, request: &Value) -> Value {
    match call_export(export, &request.to_string()) {
        Ok(response) => json!({ "ok": serde_json::from_str::<Value>(&response).unwrap() }),
        Err(message) => json!({ "error": message }),
    }
}

#[test]
fn native_outputs_match_the_shared_parity_fixtures() {
    let path = fixture_path();
    let mut cases: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let bless = std::env::var_os("TRAME_BLESS_PARITY_FIXTURES").is_some();

    for case in &mut cases {
        let id = case["id"].as_str().unwrap().to_string();
        let actual = outcome(case["export"].as_str().unwrap(), &case["request"]);
        if bless {
            case["expected"] = actual;
        } else {
            assert_eq!(actual, case["expected"], "case {id}");
        }
    }

    if bless {
        let mut text = serde_json::to_string_pretty(&cases).unwrap();
        text.push('\n');
        std::fs::write(&path, text).unwrap();
    }
}
