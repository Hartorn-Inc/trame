# TRAME Agent Notes (`AGENTS.md`)

## Repository Overview

**TRAME** (*Tabletop Rules, Actors, Maps & Encounters*) is a Rust + WebAssembly + PixiJS v8 Virtual Tabletop with native MCP integration, governed by EPURE (`Giskard-AI/epure`).

- **Architecture & Specs**: root `ARCHITECTURE.md` (spec and ADR index) and `docs/specs/01-TABLE-SPEC.md` through `04-RUNTIME-AND-DEDICATED-HOSTING.md`; the current whole-application spec is `docs/specs/spec-internet-ready-playable-trame.md`, built on the delivered baseline `docs/specs/spec-playable-dnd5e-campaign-convergence.md`.
- **Domain Vocabulary**: `GLOSSARY.md`.

## Local Development Workflow (Docker Compose + Makefile First)

Always use the root `Makefile` (which wraps `docker-compose.dev.yml`) for local development, building, linting, and testing:

- `make up` / `make down` / `make logs` — Manage the isolated local development stack (`postgres:18-alpine`, `minio` running Silo `pgsty/silo` (an S3-compatible MinIO fork), `rust-dev`, `web-dev`). The dev server does not set `S3_*`, so assets are stored in PostgreSQL; add `TEST_S3_ENDPOINT=http://minio:9000` to `make test-rust` (with `TEST_DATABASE_URL`) to run the S3 integration tests.
- `make test` (`make test-rust`, `make test-game-systems`, `make test-web`) — Run Cargo workspace tests, WASM parity tests, game-system tests, and frontend tests inside Docker. `make test-rust` skips the PostgreSQL integration tests unless `TEST_DATABASE_URL` is set (after `make up`: `make test-rust TEST_DATABASE_URL=postgresql://trame:trame_dev_password@postgres:5432/trame`); CI always runs them.
- Server configuration (secrets, `TRAME_ENV=dev`, `TRAME_PUBLIC_ORIGIN`, `TRAME_STATIC_DIR`, `RUST_LOG`, ...) is listed in `README.md` under "Server Configuration". The dev stack sets `TRAME_ENV=dev`; outside dev the server fails closed on missing secrets.
- `make lint` (`make lint-rust`, `make lint-web`, `make lint-design`) — Run `scripts/check-glossary-and-adrs.py`, the impeccable design check, `cargo fmt --check`, `cargo clippy -- -D warnings`, ESLint, and `tsc --noEmit` inside Docker.
- `make wasm` — Build `crates/trame-engine` to WebAssembly via `wasm-pack` inside Docker.
- `make srd-content` — Regenerate `packages/game-systems/dnd5e/packs/*.json` from the pinned Open5e SRD 5.2.1 snapshot (sha256-checked). Never hand-edit the packs; fix `scripts/open5eCorrections.ts` and regenerate. `ARGS="--check"` proves the committed packs match the source.

## Agent Skills

### Issue tracker

GitHub Issues on `Hartorn-Inc/trame` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, plus `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md`, `ARCHITECTURE.md`, `docs/specs/`, and `docs/adr/`. See `docs/agents/domain.md`.

## Language & Code Documentation Policy (English Only)

- **Code & Technical Artifacts**: All source code, comments, docstrings, identifiers, test descriptions, commit messages, PRs, `GLOSSARY.md`, ADRs, and technical specs MUST be written strictly in **English**. Never mix French and English.
- **Architectural-Grade Code Documentation**: Core modules must include a structured header banner (`PURPOSE`, `INVARIANTS & SAFETY BOUNDARIES`, and `EXECUTION LIFECYCLE` where applicable), field-level docstrings on public types/configs (with units and bounds), and clear explanations of *why* invariants and edge-case guards exist (see `.cursor/rules/language-policy.mdc`).
- **Future Documentation**: French is reserved strictly for dedicated end-user documentation later.

