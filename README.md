# TRAME

**Tabletop Rules, Actors, Maps & Encounters** — A high-performance, data-driven Virtual Tabletop (VTT) built with a single-binary **Rust** backend (`Axum` + `Tokio` + `SQLx`), a shared **Rust-to-WebAssembly** spatial & rules engine (`trame-engine`), **PixiJS v8** (WebGL2/WebGPU) rendering, and native **Model Context Protocol (MCP)** integration.

Licensed under the [Apache License 2.0](./LICENSE).

---

## Architecture & Specifications

Architectural specifications live in [`docs/specs/`](./docs/specs/), design decisions in [`docs/adr/`](./docs/adr/), and domain terms in [`GLOSSARY.md`](./GLOSSARY.md):

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Specification and ADR index, technology stack, and EPURE multi-agent governance.
- [`docs/specs/01-TABLE-SPEC.md`](./docs/specs/01-TABLE-SPEC.md) — Exploration vs. Turn-by-Turn modes, BVH raycasting, dynamic lighting, 3-layer Fog of War, 3D elevation, AoE wall-clipping, and GM Undo stack.
- [`docs/specs/02-GAME-ENGINE-AND-DND5E.md`](./docs/specs/02-GAME-ENGINE-AND-DND5E.md) — Generic `GameSystemPack` engine, `derivedDAG`, the 5-phase `ActiveEffect` pipeline, declarative character sheet widgets, and built-in D&D 5e (SRD 5.2.1 CC-BY-4.0, ADR-0038).
- [`docs/specs/03-MCP-AND-NOTES-SPEC.md`](./docs/specs/03-MCP-AND-NOTES-SPEC.md) — Native MCP server (100% parity with `TrameCommand`), `.uvtt` import, MCP staging mode, and the 3-tier Markdown wiki with `LineAnchorNoteMerge` for player edits.
- [`docs/specs/04-RUNTIME-AND-DEDICATED-HOSTING.md`](./docs/specs/04-RUNTIME-AND-DEDICATED-HOSTING.md) — In-memory `TableRoomActor`, hybrid WAL + write-behind persistence, Cloud Run scale-to-zero `Idle-Lease`, Neon Postgres pooling, Cloudflare R2 presigned assets, and `.trame` portable archives.

---

## Local Development (Docker Compose + Makefile)

All local development, compilation, testing, and linting run inside isolated Docker Compose containers orchestrated via the root `Makefile`. No local Rust or Node toolchain is required on the host.

```bash
cp .env.example .env
# Optionally edit .env, then chmod 600 .env
make help
make up          # Start isolated dev stack (PostgreSQL 18, MinIO, Rust server, Vite HMR)
make test        # Run Rust, WASM parity, game-system, and Web tests in Docker
make lint        # Run glossary/ADR and design checks, cargo fmt, cargo clippy, ESLint, and tsc in Docker
make wasm        # Compile trame-engine to WebAssembly (browser + Node targets) via wasm-pack in Docker
make down        # Stop the local development stack
```

The dev stack sets `TRAME_ENV=dev`, so the server boots with public development keys for any missing secret. MinIO is started for future S3-compatible asset storage; the server currently stores assets in PostgreSQL (or in memory without a database).

### PostgreSQL integration tests

`make test-rust` skips the PostgreSQL integration tests unless `TEST_DATABASE_URL` is set (CI always runs them against a `postgres:18-alpine` service). With the stack running:

```bash
make up
make test-rust TEST_DATABASE_URL=postgresql://trame:trame_dev_password@postgres:5432/trame
```

## Server Configuration

`trame-server` reads its configuration from the environment at startup. Outside `TRAME_ENV=dev` it refuses to start and lists every missing or invalid secret; it never generates keys.

| Variable | Required outside dev | Purpose |
| :--- | :--- | :--- |
| `TRAME_ENV` | No | `dev` substitutes public development keys and Vite origins for missing values. Never set it in production. |
| `MASTER_ENCRYPTION_KEY` | Yes | 64 hex characters (AES-256-GCM) encrypting TOTP secrets at rest. |
| `TRAME_JWT_SECRET` | Yes | At least 32 bytes; signs presigned asset URLs (legacy alias: `JWT_SECRET`). |
| `TRAME_INVITE_JWT_SECRET` | Yes, unless a fallback is set | At least 32 bytes; signs Magic Link invite JWTs. Falls back to `TRAME_SESSION_SECRET`, then `JWT_SECRET`. |
| `TRAME_SESSION_SECRET` | No | Fallback key for invite JWTs (see above). |
| `TRAME_PUBLIC_ORIGIN` | Yes | Public browser origin (for example `https://table.example.com`); used for invite URLs and the WebSocket `Origin` allow-list. |
| `TRAME_ALLOWED_ORIGINS` | No | Extra comma-separated WebSocket origins. |
| `TRAME_COOKIE_SECURE` | No | Session cookies carry `Secure` unless set to `false`/`0`/`no`/`off` (plain-HTTP LAN tables). |
| `TRAME_TRUST_FORWARDED_FOR` | No | `true` keys rate limits on the right-most `X-Forwarded-For` hop; set only behind a trusted proxy. |
| `TRAME_STATIC_DIR` | No | Directory of the built web client served with an `index.html` SPA fallback (set to `/app/static` in the production image). Bundle files under `/assets/` are served as-is (`/assets/download/*` stays the signed asset route); HTML responses carry a CSP that allows the app's own scripts, styles, fonts, images, the WASM engine and the same-origin WebSocket, while API responses keep `default-src 'none'`. |
| `DATABASE_URL` | No | PostgreSQL URL (alias: `TRAME_DATABASE_URL`). Migrations run at startup. Without it the server uses in-memory persistence. |
| `TRAME_PORT` | No | Listen port (fallback `PORT`, default `8080`). |
| `TRAME_INSTANCE_ID` | No | Instance UUID; a random one is generated when unset. |
| `RUST_LOG` | No | `tracing` log filter (for example `info,trame_server=debug`); defaults to `info`. |
