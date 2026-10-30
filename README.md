# TRAME

**Tabletop Rules, Actors, Maps & Encounters** — A high-performance, data-driven Virtual Tabletop (VTT) built with a single-binary **Rust** backend (`Axum` + `Tokio` + `SQLx`), a shared **Rust-to-WebAssembly** spatial & rules engine (`trame-engine`), **PixiJS v8** (WebGL2/WebGPU) rendering, and native **Model Context Protocol (MCP)** integration.

Licensed under the [Apache License 2.0](./LICENSE).

---

## Architecture & Specifications

All architectural specifications and design decisions are documented in [`docs/specs/`](./docs/specs/):

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Stack rationale, monorepo layout, CQRS `TrameCommand` architecture, and EPURE multi-agent governance.
- [`docs/specs/01-TABLE-SPEC.md`](./docs/specs/01-TABLE-SPEC.md) — Exploration vs. Turn-by-Turn modes, BVH raycasting, dynamic lighting, 3-layer Fog of War, 3D elevation, AoE wall-clipping, and GM Undo stack.
- [`docs/specs/02-GAME-ENGINE-AND-DND5E.md`](./docs/specs/02-GAME-ENGINE-AND-DND5E.md) — Generic `GameSystemPack` engine, `derivedDAG`, 5-phase active modifiers, declarative character sheet widgets, and built-in D&D 5e (SRD 5.1 CC-BY-4.0).
- [`docs/specs/03-MCP-AND-NOTES-SPEC.md`](./docs/specs/03-MCP-AND-NOTES-SPEC.md) — Native MCP server (100% parity with `TrameCommand`), `.uvtt` import, MCP staging mode, and 3-tier collaborative Markdown wiki (`yrs` CRDT + Obsidian 3-way merge).
- [`docs/specs/04-RUNTIME-AND-DEDICATED-HOSTING.md`](./docs/specs/04-RUNTIME-AND-DEDICATED-HOSTING.md) — In-memory `TableRoomActor`, hybrid WAL + write-behind persistence, Cloud Run scale-to-zero `Idle-Lease`, Neon Postgres pooling, Cloudflare R2 presigned assets, and `.trame` portable archives.

---

## Local Development (Docker Compose + Makefile)

All local development, compilation, testing, and linting run inside isolated Docker Compose containers orchestrated via the root `Makefile`. No local Rust or Node toolchain is required on the host.

```bash
cp .env.example .env
# Edit .env to set a 32+ char TRAME_SESSION_SECRET and chmod 600 .env
make help
make up          # Start isolated dev stack (PostgreSQL 18, MinIO S3, Rust watch, Vite HMR)
make test        # Run Rust unit/integration tests + WASM parity tests + Web tests in Docker
make lint        # Run cargo fmt, cargo clippy, and ESLint/tsc in Docker
make wasm        # Compile trame-engine to WebAssembly via wasm-pack in Docker
make down        # Stop the local development stack
```
