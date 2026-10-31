# ADR-0010: Hybrid Authentication, Preact + @preact/signals UI, and SqlxPostgresStore Runtime Wiring

## Status
Accepted

## Context
To make TRAME playable end-to-end across local Docker, single-VPS (`e2-micro`), and Cloud Run + Neon + R2 deployments, five architectural seams must be unified:
1. **Frictionless Onboarding & Hybrid Authentication**: Players invited to a tabletop session need 1-click entry via Magic Link URLs (`?invite=<jwt>`), while Game Masters need email + Argon2id password accounts, optional TOTP Multi-Factor Authentication (RFC 6238), and scoped Personal Access Tokens (`trame_pat_`) for MCP tools.
2. **Authoritative PostgreSQL 18 Persistence (`SqlxPostgresStore`) & Dynamic Fallback**: Production runtime (`trame-server`) persists all state in PostgreSQL 18 via `sqlx::PgPool` with automatic startup migrations when `DATABASE_URL` is set. When `DATABASE_URL` is omitted, the runtime must fallback dynamically to in-memory fixtures (`InMemory*`) to permit deterministic integration tests in zero-daemon CI environments.
3. **Write-Ahead Log Invariant & State Durability**: Ephemeral in-memory stores lose campaigns, actors, sessions, notes, and state snapshots on restart. State-mutating `TrameCommand` executions must synchronously write to `wal_entries` before broadcasting events, with snapshot compaction occurring periodically and on `Idle-Lease` expiration.
4. **Zero-VDOM Surgical UI Reactivity (`Preact` + `@preact/signals` + `PixiJS v8` + `WASM`)**: High-frequency binary MessagePack `ServerEnvelope` frames over `/ws/campaigns/{id}` must update HUD counters and the PixiJS v8 canvas at 60 FPS without full-tree Virtual DOM diffing. WebAssembly spatial acceleration must load asynchronously with pure TypeScript fallback.
5. **Headless Continuous Integration Compatibility**: Frontend and backend integration suites must execute deterministically without an external PostgreSQL daemon or graphical GPU acceleration.

## Decision
1. **Hybrid Identity & Session Model**:
   - Support four authentication flows: 1-click Magic Link JWT invites (`POST /api/v1/auth/magic-link`), Email + Argon2id password registration/login (`POST /api/v1/auth/register`, `POST /api/v1/auth/login`), Guest Identity Binding (`POST /api/v1/auth/bind`), TOTP 2FA with AES-256-GCM encrypted secrets, and `trame_pat_` Personal Access Tokens.
   - When an unauthenticated player redeems a Magic Link, generate an ephemeral user row with `is_ephemeral = TRUE` and `password_hash = NULL`, returning an authenticated session cookie scoped to the designated campaign role.
   - Authenticate HTTP and WebSocket upgrades (`GET /ws/campaigns/{id}`) via SHA-256 hashed session tokens in the `trame_session` `HttpOnly; SameSite=Lax` cookie or `Authorization: Bearer` header.
2. **PostgreSQL 18 (`SqlxPostgresStore`) & Dynamic Storage Runtime**:
   - Wire `trame-server/src/main.rs` to dynamic persistence: IF `DATABASE_URL` is set, THEN initialize `sqlx::PgPool` and run `sqlx::migrate!("./migrations")`; IF `DATABASE_URL` is absent, THEN fallback to `InMemory*` storage adapters to permit deterministic offline unit and integration testing.
   - Back `WalStorage`, `SessionStore`, `CampaignStore`, `PartyJournalStorage`, and `TimelineStorage` with PostgreSQL 18 tables, and back `AssetStore` with HTTP `S3Store` (MinIO/R2) plus `/assets/download/{*key}` fallback.
3. **Write-Ahead Log Invariant**:
   - Enforce synchronous database writes to `wal_entries` for every mutative `TrameCommand` processed by `TableRoomActor` before broadcasting the resulting `TrameEvent` to WebSocket clients.
   - Compact active room state into `wal_snapshots` asynchronously every 5 minutes and upon session `Idle-Lease` expiration (15 minutes of inactivity).
4. **Preact + `@preact/signals` + `PixiJS v8` Browser Client**:
   - Bundle `packages/web` with Vite and TypeScript using `preact`, `@preact/signals` (`PreactSignalState`), `pixi.js` v8, and `@msgpack/msgpack`.
   - Mutate atomic signals (`tableStateSignal`, `actorsSignal`, `notesSignal`, `timelineSignal`, `diceLogSignal`) upon envelope receipt, binding HUD drawer widgets directly to signals and updating the PixiJS v8 `SceneGraph` imperatively via Preact `effect()`, eliminating Virtual DOM diffing during 60 FPS table operations.
5. **Spatial Engine Fallback**:
   - Load `trame-engine` WebAssembly (`WasmSpatialEngine`) asynchronously.
   - IF WebAssembly instantiation fails, THEN set engine mode to `TYPESCRIPT_FALLBACK` and route spatial queries to pure TypeScript `Bvh2D` and `evaluateAoeTargets`.
6. **Headless Canvas & Deterministic Test Execution**:
   - Provide `HeadlessCanvasMock` within `TableCanvas` when WebGL initialization fails, dispatching `'mock-canvas-active'` for headless test assertions.
   - Execute frontend test suites using native Node 24 test runner (`node --test`), `tsc --noEmit`, and `vite build` without Vitest or Playwright dependencies.

## Consequences
### Positive
- Campaigns, actors, notes, assets, and write-ahead logs persist reliably across server restarts, container redeployments, and `Idle-Lease` hibernations.
- Tabletop token movement and dynamic lighting operate at 60 FPS without Virtual DOM bottlenecking.
- Magic Link invites enable friction-free guest onboarding without mandatory upfront password creation.
- CI test pipelines run deterministically in completely isolated, offline sandbox environments without external daemons or GPU hardware.
- Total UI framework payload stays under 5 KB (`preact` + `@preact/signals`) with surgical signal updates directly driving DOM text nodes and PixiJS v8 sprites.

### Negative
- Dual storage abstraction requires maintaining both SQL migrations and in-memory test fixtures.
- Ephemeral user records require scheduled database pruning for expired, inactive sessions.
- Preact signal state subscriptions require explicit cleanup in canvas lifecycle hooks to prevent memory leaks.
