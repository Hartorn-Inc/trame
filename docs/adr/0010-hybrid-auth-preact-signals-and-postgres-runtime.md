# 10. Hybrid Authentication, Preact Signals State Layer, and PostgreSQL Runtime

## Status
Accepted

## Context
TRAME foundational crates deliver 2.5D spatial raycasting, a five-phase ActiveEffect derivedDAG, SRD 5.1 rules engines, and binary envelope protocols. However, the application server currently initializes ephemeral in-memory storage fixtures (`InMemoryWalStorage`, `InMemoryCampaignStore`, `InMemorySessionStore`), preventing state preservation across container restarts. Axum router instances lack complete HTTP routes for user registration, login, campaign CRUD, starter dungeon generation, `.uvtt` map imports, note filtering, and asset streaming.

On the browser client, full Virtual DOM reconciliation creates frame rate drops when synchronizing high-frequency WebSocket state deltas (token motion, dynamic line-of-sight). The web package requires a lightweight, reactive state architecture capable of binding binary MessagePack updates directly to discrete user interface widgets and the PixiJS v8 render tree without global component re-renders. Furthermore, the headless continuous integration pipeline operates without an external PostgreSQL daemon or graphical GPU acceleration.

## Decision
1. **Storage Runtime**: Implement `SqlxPostgresStore` backed by PostgreSQL 18 and SQLx migrations in `crates/trame-server/migrations/0001_initial_schema.sql`. Make storage implementations selectable dynamically at startup in `main.rs`: IF `DATABASE_URL` is set, THEN initialize `sqlx::PgPool` and run `sqlx::migrate!()`; IF `DATABASE_URL` is absent, THEN fallback to `InMemory*` storage adapters to permit deterministic offline unit and integration testing.
2. **Write-Ahead Log Invariant**: Enforce synchronous database writes to `wal_entries` for every mutative `TrameCommand` processed by `TableRoomActor` before broadcasting the resulting `TrameEvent` to WebSocket clients. Compact active room state into `wal_snapshots` asynchronously every 5 minutes and upon session idle lease expiration (15 minutes of inactivity).
3. **Hybrid Authentication**: Support both Argon2id session cookies (`trame_session`, `HttpOnly`, `SameSite=Lax`) and cryptographic Magic Link invitation tokens (`?invite=<jwt>`). When an unauthenticated player redeems a Magic Link, generate an ephemeral user row with `is_ephemeral = TRUE` and `password_hash = NULL`, returning an authenticated session cookie scoped to the designated campaign role.
4. **Reactive State Binding**: Structure browser client state using `@preact/signals` (`PreactSignalState`). Network decoders mutate atomic signals (`tableStateSignal`, `actorsSignal`, `notesSignal`, `timelineSignal`, `diceLogSignal`). HUD drawer widgets bind directly to discrete signals. The `TableCanvas` component subscribes via a Preact `effect()` hook to mutate the PixiJS v8 `SceneGraph` imperatively, eliminating Virtual DOM diffing during 60 FPS table operations.
5. **Spatial Engine Fallback**: Load `WasmSpatialEngine` asynchronously. IF WebAssembly instantiation fails, THEN set engine mode to `TYPESCRIPT_FALLBACK` and route spatial queries to pure TypeScript `Bvh2D` and `evaluateAoeTargets`.
6. **Headless Test Compatibility**: Provide `HeadlessCanvasMock` within `TableCanvas` when WebGL initialization fails, dispatching `'mock-canvas-active'` for headless test assertions. Execute frontend test suites using the native Node 24 test runner (`node --test`), `tsc --noEmit`, and `vite build` without Vitest or Playwright dependencies.

## Consequences
### Positive
- Campaigns, actors, notes, assets, and write-ahead logs persist reliably across server restarts.
- Tabletop token movement and dynamic lighting operate at 60 FPS without Virtual DOM bottlenecking.
- Magic Link invites enable friction-free guest onboarding without mandatory upfront password creation.
- CI test pipelines run deterministically in completely isolated, offline sandbox environments.

### Negative / Trade-offs
- Dual storage abstraction requires maintaining both SQL migrations and in-memory test fixtures.
- Ephemeral user records require scheduled database pruning for expired, inactive sessions.
- Preact signal state subscriptions require explicit cleanup in canvas lifecycle hooks to prevent memory leaks.
