# TRAME Agent Notes (`AGENTS.md`)

## Repository Overview

**TRAME** (*Tabletop Rules, Actors, Maps & Encounters*) is a Rust + WebAssembly + PixiJS v8 Virtual Tabletop with native MCP integration, governed by EPURE (`Giskard-AI/epure`).

- **Architecture & Specs**: `ARCHITECTURE.md` and `docs/specs/01-TABLE-SPEC.md` through `04-RUNTIME-AND-DEDICATED-HOSTING.md`.
- **Domain Vocabulary**: `GLOSSARY.md`.

## Local Development Workflow (Docker Compose + Makefile First)

Always use the root `Makefile` (which wraps `docker-compose.dev.yml`) for local development, building, linting, and testing:

- `make up` / `make down` / `make logs` — Manage the isolated local development stack (`postgres:18-alpine`, `minio`, `rust-dev`, `web-dev`).
- `make test` (`make test-rust`, `make test-web`) — Run Cargo workspace tests, WASM parity tests, and frontend tests inside Docker.
- `make lint` (`make lint-rust`, `make lint-web`) — Run `cargo fmt --check`, `cargo clippy -- -D warnings`, ESLint, and `tsc --noEmit` inside Docker.
- `make wasm` — Build `crates/trame-engine` to WebAssembly via `wasm-pack` inside Docker.

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

