# ADR-0010: Hybrid Authentication, Preact + @preact/signals UI, and SqlxPostgresStore Runtime Wiring

## Status
Accepted

## Context
To make TRAME playable end-to-end across local Docker, single-VPS (`e2-micro`), and Cloud Run + Neon + R2 deployments, three architectural seams must be unified:
1. **Frictionless Onboarding & Hybrid Authentication**: Players invited to a tabletop session need 1-click entry via Magic Link URLs (`?invite=<jwt>`), while Game Masters need email + Argon2id password accounts, optional TOTP Multi-Factor Authentication (RFC 6238), and scoped Personal Access Tokens (`trame_pat_`) for MCP tools.
2. **Authoritative PostgreSQL 18 Persistence (`SqlxPostgresStore`)**: Ephemeral in-memory stores lose campaigns, actors, sessions, notes, and `WAL` snapshots on restart. Production runtime (`trame-server`) must persist all state in PostgreSQL 18 via `sqlx::PgPool` with automatic startup migrations, reserving `InMemory*` stores strictly for unit tests (`#[cfg(test)]`).
3. **Zero-VDOM Surgical UI Reactivity (`Preact` + `@preact/signals` + `PixiJS v8` + `WASM`)**: High-frequency binary MessagePack `ServerEnvelope` frames over `/ws/campaigns/{id}` must update HUD counters and the `PixiJS v8` canvas at 60 FPS without full-tree React Virtual DOM diffing or heavy bundle overhead.

## Decision
1. **Hybrid Identity & Session Model**:
   - Support four authentication flows: 1-click Magic Link JWT invites (`POST /api/v1/auth/magic-link`), Email + Argon2id password registration/login (`POST /api/v1/auth/register`, `POST /api/v1/auth/login`), Guest Identity Binding (`POST /api/v1/auth/bind`), TOTP 2FA with AES-256-GCM encrypted secrets, and `trame_pat_` Personal Access Tokens.
   - Authenticate HTTP and WebSocket upgrades (`GET /ws/campaigns/{id}`) via SHA-256 hashed session tokens in the `trame_session` `HttpOnly; SameSite=Lax` cookie or `Authorization: Bearer` header.
2. **PostgreSQL 18 (`SqlxPostgresStore`) & S3/R2 Persistence**:
   - Wire `trame-server/src/main.rs` to `sqlx::PgPool` (`DATABASE_URL`) and execute `sqlx::migrate!("./migrations")` on startup.
   - Back `WalStorage`, `SessionStore`, `CampaignStore`, `PartyJournalStorage`, and `TimelineStorage` with PostgreSQL 18 tables, and back `AssetStore` with HTTP `S3Store` (MinIO/R2) plus `/assets/download/{*key}` fallback.
3. **Preact + `@preact/signals` + `PixiJS v8` + `WASM` Browser Client**:
   - Bundle `packages/web` with Vite and TypeScript using `preact`, `@preact/signals` (`PreactSignalState`), `pixi.js` v8, and `@msgpack/msgpack`.
   - Load `trame-engine` WebAssembly (`WasmSpatialEngine`) asynchronously with automatic fallback to the TypeScript BVH implementation so client-side 2.5D line-of-sight and AoE previews run identically in all environments.

## Consequences
### Positive
- Total UI framework payload stays under 5 KB (`preact` + `@preact/signals`) with surgical signal updates directly driving DOM text nodes and PixiJS v8 sprites.
- Zero data loss across process restarts, container redeployments, or `Idle-Lease` hibernations.
- Single-origin production deployment: `trame-server` serves both the compiled `packages/web/dist` SPA and the `/api/v1/*` + `/ws/*` endpoints.

### Negative
- Requires a reachable PostgreSQL instance (provided automatically by `docker-compose.yml` and `docker-compose.dev.yml`) when booting the production `trame-server` binary.
