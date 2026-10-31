# ADR-0010: Hybrid Authentication, Preact + @preact/signals UI, and SqlxPostgresStore Runtime Wiring

## Status
Accepted

## Context
To make TRAME playable end-to-end across local Docker, single-VPS (`e2-micro`), and Cloud Run + Neon + R2 deployments, the application server and web client must unify core architectural seams:
1. **Frictionless Onboarding & Hybrid Authentication**: Players invited to a tabletop session need 1-click entry via Magic Link URLs (`?invite=<jwt>`), while Game Masters need email + Argon2id password accounts, optional TOTP Multi-Factor Authentication (RFC 6238), and scoped Personal Access Tokens (`trame_pat_`) for MCP tools.
2. **Authoritative PostgreSQL 18 Persistence (`SqlxPostgresStore`)**: Ephemeral in-memory stores lose campaigns, actors, sessions, notes, and WAL snapshots across container restarts. Production runtime (`trame-server`) must persist all state in PostgreSQL 18 via `sqlx::PgPool` with automatic startup migrations. The headless continuous integration pipeline must run without an external PostgreSQL daemon or graphical GPU acceleration.
3. **Zero-VDOM Surgical UI Reactivity (`Preact` + `@preact/signals` + `PixiJS v8` + `WASM`)**: High-frequency binary MessagePack `ServerEnvelope` frames over `/ws/campaigns/{id}` (token motion, dynamic line-of-sight) must update HUD widgets and the canvas at 60 FPS without full-tree Virtual DOM diffing overhead.

## Decision
1. **Dynamic Storage Runtime (`SqlxPostgresStore`)**:
   - Implement `SqlxPostgresStore` backed by PostgreSQL 18 and SQLx migrations in `crates/trame-server/migrations/0001_initial_schema.sql`.
   - Configure storage adapters dynamically at startup in `main.rs`: IF `DATABASE_URL` is set, THEN initialize `sqlx::PgPool` and run `sqlx::migrate!()`; IF `DATABASE_URL` is absent, THEN fallback to `InMemory*` storage adapters (`InMemoryWalStorage`, `InMemorySessionStore`, `InMemoryCampaignStore`, `InMemoryPartyJournalStorage`, `InMemoryTimelineStorage`, `InMemoryAssetStore`) to enable deterministic offline unit and integration testing.
   - Back `WalStorage`, `SessionStore`, `CampaignStore`, `PartyJournalStorage`, and `TimelineStorage` with PostgreSQL 18 tables, and back `AssetStore` with HTTP `S3Store` (MinIO/R2) plus `/assets/download/{*key}` fallback.
2. **Write-Ahead Log Invariant**:
   - Enforce synchronous database writes to `wal_entries` for every mutative `TrameCommand` processed by `TableRoomActor` before broadcasting the resulting `TrameEvent` to WebSocket clients.
   - Compact active room state into `wal_snapshots` asynchronously every 5 minutes and upon session idle lease expiration (15 minutes of inactivity).
3. **Hybrid Identity & Session Model**:
   - Support four authentication flows: 1-click Magic Link JWT invites (`POST /api/v1/auth/magic-link`), Email + Argon2id password registration/login (`POST /api/v1/auth/register`, `POST /api/v1/auth/login`), Guest Identity Binding (`POST /api/v1/auth/bind`), TOTP 2FA with AES-256-GCM encrypted secrets, and `trame_pat_` Personal Access Tokens.
   - When an unauthenticated player redeems a Magic Link, generate an ephemeral user row with `is_ephemeral = TRUE` and `password_hash = NULL`, returning an authenticated session cookie scoped to the designated campaign role.
   - Authenticate HTTP and WebSocket upgrades (`GET /ws/campaigns/{id}`) via SHA-256 hashed session tokens in the `trame_session` `HttpOnly; SameSite=Lax` cookie or `Authorization: Bearer` header.
4. **Reactive State Binding (`Preact` + `@preact/signals`)**:
   - Structure browser client state using `@preact/signals` (`PreactSignalState`) in `packages/web/src/state/appSignals.ts`.
   - Network decoders mutate atomic signals (`tableStateSignal`, `actorsSignal`, `notesSignal`, `timelineSignal`, `diceLogSignal`).
   - HUD drawer widgets bind directly to discrete signals.
   - The `TableCanvas` component subscribes via a Preact `effect()` hook to mutate the PixiJS v8 `SceneGraph` imperatively, eliminating Virtual DOM diffing during 60 FPS table operations.
5. **Spatial Engine Fallback**:
   - Load `trame-engine` WebAssembly (`WasmSpatialEngine`) asynchronously.
   - IF WebAssembly instantiation fails, THEN set engine mode to `TYPESCRIPT_FALLBACK` and route spatial queries to pure TypeScript `Bvh2D` and `evaluateAoeTargets`.
6. **Headless Test Compatibility**:
   - Provide `HeadlessCanvasMock` within `TableCanvas` when WebGL initialization fails, dispatching `'mock-canvas-active'` for headless test assertions.
   - Execute frontend test suites using the native Node 24 test runner (`node --test`), `tsc --noEmit`, and `vite build` without Vitest or Playwright dependencies.

## Consequences
### Positive
- Campaigns, actors, notes, assets, and write-ahead logs persist reliably across server restarts and `Idle-Lease` hibernations.
- Total UI framework payload stays under 5 KB (`preact` + `@preact/signals`) with surgical signal updates directly driving DOM text nodes and PixiJS v8 sprites at 60 FPS.
- Magic Link invites enable friction-free guest onboarding without mandatory upfront password creation.
- Single-origin production deployment: `trame-server` serves both the compiled `packages/web/dist` SPA and the `/api/v1/*` + `/ws/*` endpoints.
- CI test pipelines and unit tests run deterministically in completely isolated, offline sandbox environments.

### Negative
- Dual storage abstraction requires maintaining both SQL migrations and in-memory test fixtures.
- Ephemeral user records require scheduled database pruning for expired, inactive sessions.
- Preact signal state subscriptions require explicit cleanup in canvas lifecycle hooks to prevent memory leaks.
- Production `trame-server` binary deployments require a reachable PostgreSQL instance (provided automatically by `docker-compose.yml` and `docker-compose.dev.yml`).
