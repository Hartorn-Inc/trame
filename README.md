# TRAME

**Tabletop Rules, Actors, Maps & Encounters** is a self-hosted Virtual Tabletop (VTT) for one group of friends playing D&D 5e over the internet. It is a single Rust server binary (`Axum` + `Tokio` + `SQLx`) with PostgreSQL, a shared Rust-to-WebAssembly rules and spatial engine (`trame-engine`), a Preact + **PixiJS v8** web client, and a native **Model Context Protocol (MCP)** endpoint.

Licensed under the [Apache License 2.0](./LICENSE).

---

## What TRAME does

**One instance, invite-only.** Each deployment is one instance with one `Owner` ([ADR-0039](./docs/adr/0039-invite-only-registration-and-instance-role.md)):

- On first start the server logs a one-time setup URL, valid for 1 hour. Opening it creates the `Owner` account (optionally locked to one email with `TRAME_BOOTSTRAP_OWNER_EMAIL`).
- The `Owner` promotes trusted accounts to `Host`. Only a `Host` or the `Owner` can create a campaign, and becomes its Game Master.
- The Game Master shares one `CampaignInvite` per campaign: at most 8 uses by default, valid at most 7 days, revocable, with a list of who redeemed it. Players redeem it into a real `Member` account. Nobody else can register outside `TRAME_ENV=dev`.

**D&D 5e on SRD 5.2.1** (CC-BY-4.0, [ADR-0038](./docs/adr/0038-srd-521-rules-baseline.md)), delivered in waves 1 to 3 of [`spec-internet-ready-playable-trame.md`](./docs/specs/spec-internet-ready-playable-trame.md):

- Full SRD content (spells, monsters, magic items, 12 classes and subclasses), generated from a pinned, checksummed Open5e snapshot.
- A character builder with class skills, equipment and spell steps; sheets with derived attacks, spell slots and class feature pools; level-up and rests.
- Semi-automated combat: the server rolls to hit against AC and rolls damage, then the attacker or GM confirms with an explicit Apply (damage type, critical). Area spells list the affected tokens with save and save-half controls. Concentration and death saving throws are rolled on the server.
- Conditions and class features adjust rolls automatically; the GM can force or remove any condition (`ConditionOverride`).
- The table: doors, walls drawn in the maps studio (including one-way and terrain walls), fog brush and per-player explored memory, per-token darkvision, grid movement with difficult terrain and reach, cover suggestions, monsters spawned from the compendium with full stat blocks, zoom and pan.
- Crash safety: write-ahead log (WAL) recovery with quarantine of entries that fail to replay ([ADR-0040](./docs/adr/0040-wal-recovery-with-quarantine.md)), automatic client reconnect, and nightly database backups with a tested restore.
- Low traffic: HTTP and WebSocket compression, and map images served straight from an S3-compatible bucket through short-lived signed URLs ([ADR-0041](./docs/adr/0041-s3-asset-storage-signed-downloads-and-free-hosting.md)).

---

## Architecture & Specifications

Specifications live in [`docs/specs/`](./docs/specs/), design decisions in [`docs/adr/`](./docs/adr/), and domain terms in [`GLOSSARY.md`](./GLOSSARY.md):

- [`ARCHITECTURE.md`](./ARCHITECTURE.md): specification and ADR index, technology stack, and EPURE multi-agent governance.
- [`docs/specs/spec-internet-ready-playable-trame.md`](./docs/specs/spec-internet-ready-playable-trame.md): the current whole-application spec (invite-only access, crash-safe WAL recovery, full SRD 5.2.1 play, free hosting).
- [`docs/specs/01-TABLE-SPEC.md`](./docs/specs/01-TABLE-SPEC.md): Exploration vs. Turn-by-Turn modes, BVH raycasting, dynamic lighting, 3-layer fog of war, 3D elevation, AoE wall-clipping, and the GM undo stack.
- [`docs/specs/02-GAME-ENGINE-AND-DND5E.md`](./docs/specs/02-GAME-ENGINE-AND-DND5E.md): the generic `GameSystemPack` engine, `derivedDAG`, the 5-phase `ActiveEffect` pipeline, declarative character sheet widgets, and built-in D&D 5e.
- [`docs/specs/03-MCP-AND-NOTES-SPEC.md`](./docs/specs/03-MCP-AND-NOTES-SPEC.md): the native MCP server (parity with `TrameCommand`), `.uvtt` import, MCP staging mode, and the 3-tier Markdown wiki.
- [`docs/specs/04-RUNTIME-AND-DEDICATED-HOSTING.md`](./docs/specs/04-RUNTIME-AND-DEDICATED-HOSTING.md): the in-memory `TableRoomActor`, WAL + write-behind persistence, Cloud Run scale-to-zero `Idle-Lease`, signed asset downloads, and `.trame` portable archives.

---

## Local Development (Docker Compose + Makefile)

All development, compilation, testing and linting run in Docker containers driven by the root `Makefile`. No Rust or Node toolchain is needed on the host.

```bash
cp .env.example .env    # optional overrides; then chmod 600 .env
make help               # list every target
make up                 # build the WASM engine, start PostgreSQL 18, Silo, the Rust server and Vite
make logs               # follow the logs; the owner setup URL is logged while no Owner exists
make down               # stop the stack (data volumes are kept; `make clean` removes them)
```

The web client is served by Vite at <http://localhost:5173> and proxies `/api`, `/ws` and `/assets` to the server on port 8080. The dev stack sets `TRAME_ENV=dev`: missing secrets fall back to public development keys and public registration is open, so you can create accounts without invites.

| Command | What it runs |
| :--- | :--- |
| `make test` | Every test suite: Rust workspace, WASM build, game systems, web (including WASM parity), budget cap function |
| `make test-rust` | Cargo workspace tests. PostgreSQL integration tests run only with `TEST_DATABASE_URL` (see below) |
| `make test-game-systems` / `make test-web` | D&D 5e pack tests / web client tests |
| `make test-budget-cap` | Tests of the Cloud Run spending-cap function in `deploy/terraform/budget-cap` (no network) |
| `make lint` | Glossary/ADR check, design audit, `cargo fmt` + `clippy`, ESLint + `tsc`, Terraform checks |
| `make lint-rust` / `make lint-web` / `make lint-design` | One linter family each |
| `make lint-terraform` | `terraform fmt`, `terraform validate` and `tflint` on `deploy/terraform`, in pinned containers |
| `make check` | `make lint` then `make test` |
| `make e2e-image` | Builds the production image `trame-server:e2e` from the root `Dockerfile` |
| `make e2e` | Playwright journey (GM + three players, with videos) on the production Compose stack with Silo, including a mid-session `SIGKILL`, a restart, and a backup + restore. Needs `make e2e-image` first |
| `make e2e-video` | Combines the GM and player videos from `e2e/artifacts` into one side-by-side MP4 |
| `make deploy-compose-smoke` | Starts the production Compose stack behind Caddy on `https://localhost:18743` and checks HTTPS, WebSocket compression, Silo downloads with CORS, and backup + restore. Needs `make e2e-image` first |
| `make wasm` | Builds `trame-engine` to WebAssembly (browser and Node targets) with `wasm-pack` |
| `make srd-content` | Regenerates the SRD 5.2.1 packs from the pinned Open5e snapshot (`ARGS="--check"` verifies them) |
| `make db-psql` / `make shell-rust` / `make shell-web` | A `psql` session / a shell in the Rust or Node container |

### PostgreSQL and S3 integration tests

`make test-rust` skips the PostgreSQL integration tests unless `TEST_DATABASE_URL` is set; CI always runs them against a `postgres:18-alpine` service. Adding `TEST_S3_ENDPOINT` also runs the S3 tests against the dev Silo service. With the stack running:

```bash
make up
make test-rust TEST_DATABASE_URL=postgresql://trame:trame_dev_password@postgres:5432/trame TEST_S3_ENDPOINT=http://minio:9000
```

The dev server itself does not set `S3_*`, so in development assets are stored in PostgreSQL.

---

## Deployment

Two operator guides deploy the same production image. Both put assets in an S3-compatible bucket (or PostgreSQL), run a nightly database backup, and share one [backup and restore runbook](./deploy/backup-and-restore.md).

- **[Self-hosted with Docker Compose](./deploy/compose/README.md), 0 EUR.** Caddy (automatic HTTPS), TRAME, PostgreSQL, optional Silo and a backup container on one machine: an Oracle Cloud Always Free VM, or a home machine behind Cloudflare Tunnel. No card needed for the home machine.
- **[Cloud Run + Neon + R2 with Terraform](./deploy/terraform/README.md), a few cents a month.** Cloud Run in Paris (`europe-west9`), PostgreSQL on Neon's free plan, assets and dumps on Cloudflare R2, deployed by GitHub Actions on every green push to `main`. No server to maintain, but a card on the Google Cloud billing account.

| | Compose on Oracle Always Free (or a home machine) | Cloud Run + Neon + R2 |
| :--- | :--- | :--- |
| Free-tier limits | Ampere A1 up to 2 OCPU and 12 GB RAM, 10 TB outbound traffic a month | Cloud Run: about 50 hours a month of the 1-vCPU instance free, then about 0.09 USD per hour; Europe egress billed from the first byte (about 0.105 USD/GiB). Neon: 100 CU-hours, 1 GB storage, 5 GB transfer. R2: 10 GB storage, free egress |
| Main risks | Oracle can reclaim an Always Free VM that stays nearly idle for 7 days (CPU, network and memory all under 20 %), which describes a VM used one evening a week; upgrading the account to Pay As You Go avoids it and stays free within the limits. A1 capacity is sometimes unavailable, so creating or restarting the VM can fail. A home machine depends on its uptime. You patch the host | Cold start of a few seconds after about 15 idle minutes (image pull, Neon wake-up). WebSockets end at the 60-minute request timeout and on every restart or deploy; clients reconnect, and a restart also loses the GM undo history. `max-instances = 1` is required for correctness, so capacity is one 1-vCPU instance. Neon suspends after 5 idle minutes and stops the project for the rest of the month if a quota runs out |
| Spending control | Nothing to bill | Monthly budget: email warnings at 1 EUR and 5 EUR, and a hard cap at 10 EUR where a Cloud Run function unlinks the project from billing (which stops it). Budget data lags usage by hours, so a month can end slightly above 10 EUR |
| Typical monthly cost (5 players, one 4-hour session a week) | 0 EUR. A domain name is extra unless you use a free dynamic DNS name; a home machine costs its electricity | About 0.05 to 0.20 EUR: about 18 instance-hours stay inside the Cloud Run free tier, Neon uses about 5 to 10 CU-hours, R2 stays free, and what remains is a few hundred MB of egress plus image storage above the free 0.5 GB |

Free-tier figures were checked on 2026-11-07 and 2026-11-08; recheck them before relying on them. The Terraform guide's [costs](./deploy/terraform/README.md#costs-and-free-tier-limits) and [spending cap](./deploy/terraform/README.md#spending-cap) sections have the details.

Every green push to `main` deploys to Cloud Run. Add required reviewers to the GitHub `production` environment so a merge during a game night does not restart the server.

---

## Server Configuration

`trame-server` reads its configuration from the environment once, at startup. Outside `TRAME_ENV=dev` it refuses to start and lists every missing or invalid variable; it never generates keys. Empty values count as unset.

The server is same-origin: the web client, the API and the WebSocket share `TRAME_PUBLIC_ORIGIN`, and the server sends no CORS headers. Only the S3 bucket needs a CORS rule: it must allow `GET` and `HEAD` from `TRAME_PUBLIC_ORIGIN`, because the browser loads battlemap images with `crossOrigin="anonymous"` to draw them on a WebGL canvas. Both deployment guides set that rule.

| Variable | Default | Required outside dev | Description |
| :--- | :--- | :--- | :--- |
| `TRAME_ENV` | unset (production behaviour) | No | `dev` substitutes public development keys and Vite origins for missing values, allows running without a database, opens public registration, ignores an incomplete `S3_*` set, and logs coloured lines. Any other value logs one JSON object per line and refuses the publicly known development secrets. Never set it to `dev` in production. |
| `DATABASE_URL` | none (dev: in-memory store) | Yes | PostgreSQL URL (alias `TRAME_DATABASE_URL`). Migrations run at startup. For Neon, use the direct (non-pooled) connection string. |
| `MASTER_ENCRYPTION_KEY` | none (dev: public key) | Yes | 64 hex characters (AES-256-GCM key) encrypting TOTP secrets at rest. Losing or changing it disables every TOTP enrolment. |
| `TRAME_JWT_SECRET` | none (dev: public key) | Yes | At least 32 bytes. Signs the asset download URLs (`/assets/download/...`). Legacy alias: `JWT_SECRET`. |
| `TRAME_INVITE_JWT_SECRET` | `TRAME_SESSION_SECRET`, then `JWT_SECRET` (dev: public key) | Yes, unless a fallback is set | At least 32 bytes. Reserved key: no route signs with it since campaign invites became random tokens stored as SHA-256 digests, but startup still validates it. |
| `TRAME_SESSION_SECRET` | none | No | Fallback for `TRAME_INVITE_JWT_SECRET`. |
| `TRAME_PUBLIC_ORIGIN` | none (dev: `localhost` and `127.0.0.1` on ports 5173 and 8080 are allowed, links are relative) | Yes | Public browser origin, for example `https://table.example.com`. Builds the owner setup URL and invite URLs, and is the WebSocket `Origin` allow-list. |
| `TRAME_ALLOWED_ORIGINS` | empty | No | Extra comma-separated WebSocket origins. |
| `TRAME_TRUSTED_PROXY_HOPS` | `0` | No | Number of trusted reverse proxies in front of the server (`0` to `8`). `0` keys rate limits on the socket peer address; `N` uses the `N`-th `X-Forwarded-For` entry from the right. Set it to the real proxy count (`1` behind Caddy or Cloud Run, `2` behind Cloudflare Tunnel + Caddy). The server refuses to start while the removed `TRAME_TRUST_FORWARDED_FOR` is set. |
| `TRAME_COOKIE_SECURE` | `true` | No | Session cookies carry `Secure` unless set to `false`, `0`, `no` or `off` (plain-HTTP LAN tables only). |
| `TRAME_INSTANCE_ID` | the persisted id | No | Instance UUID override. Without it, the server generates an id on first boot and persists it in the `instance_settings` table, so asset URLs survive restarts. An override that differs from the persisted id is used and logged as a warning. |
| `TRAME_BOOTSTRAP_OWNER_EMAIL` | unset (any email) | No | Locks the owner setup to this email. While no `Owner` exists, every start logs a single-use setup URL valid for 1 hour, as one line with `event="owner_bootstrap_url"` and the URL in `setup_url`. |
| `S3_ENDPOINT` | unset (assets in PostgreSQL) | Only with S3 | S3-compatible endpoint the server uses, as `http(s)://host[:port]` (for example `https://<account>.r2.cloudflarestorage.com`). Setting any `S3_*` variable stores assets in the bucket instead of PostgreSQL; `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are then all required, and outside dev a partial set refuses to start. At startup, assets still in PostgreSQL are copied to the bucket in the background, verified by SHA-256, then cleared from PostgreSQL; the copy resumes on the next boot if interrupted. |
| `S3_BUCKET` | none | Only with S3 | Bucket name (path-style addressing). The bucket must exist and carry the CORS rule described above. |
| `S3_ACCESS_KEY_ID` | none | Only with S3 | Access key id; it appears in signed download URLs. |
| `S3_SECRET_ACCESS_KEY` | none | Only with S3 | Secret access key; it never leaves the server. |
| `S3_REGION` | `auto` | No | SigV4 signing region: `auto` for Cloudflare R2, `us-east-1` for Silo or MinIO. |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | No | Endpoint signed into browser download redirects, when browsers reach the bucket through another host than the server does (the Compose stack routes Silo through Caddy). Its origin is added to the page's Content Security Policy `img-src`. Downloads stay behind the server's membership check, then redirect (`307`) to a presigned `GET` valid 5 minutes. |
| `TRAME_STATIC_DIR` | unset (no web client served); `/app/static` in the production image | No | Directory of the built web client, served with an `index.html` fallback for client-side routes. HTML responses carry a Content Security Policy for the app's own scripts, styles, fonts, images, WASM engine and same-origin WebSocket; API responses keep `default-src 'none'`. |
| `TRAME_PORT` | `PORT`, then `8080` | No | Listen port. Cloud Run sets `PORT`. |
| `RUST_LOG` | `info` | No | `tracing` log filter, for example `info,trame_server=debug`. |
