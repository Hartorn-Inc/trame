#![allow(clippy::collapsible_if)]

//! ============================================================================
//! TRAME ADMINISTRATIVE & CONTENT-PACK CLI ENTRYPOINT (main.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Provides the command-line administrative entrypoint (`trame-cli`) for
//! portable `.trame` campaign archive inspection, export, and import (`archive`),
//! offline content-pack validation, and dedicated server operational maintenance.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Offline-Safe Execution`:
//!      - Runs independently of the live WebSocket runtime so administrators
//!        can verify pack schemas and backup archives prior to server startup,
//!        while optionally connecting to a remote HTTP server via `--server`.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `main()`
//!     ├── 1. Inspect command-line arguments (`archive inspect|export|import`).
//!     └── 2. Dispatch to `archive::run_cli` or emit the bootstrap banner.
//! ============================================================================

pub mod archive;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        println!("trame-cli bootstrap");
        return;
    }

    match args[0].as_str() {
        "archive" => {
            if let Err(err) = archive::run_cli(&args[1..]).await {
                eprintln!("Error: {err}");
                std::process::exit(1);
            }
        }
        other => {
            eprintln!("Unknown command '{other}'. Supported commands: archive");
            std::process::exit(1);
        }
    }
}
