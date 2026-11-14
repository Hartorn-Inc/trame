# TRAME with Docker Compose (self-hosted, 0 EUR)

This directory runs TRAME on one machine: an Oracle Cloud Always Free VM, or a home machine behind Cloudflare Tunnel. Caddy is the only service that publishes ports, and it gets HTTPS certificates automatically. PostgreSQL is backed up every night.

| Service | Role | Memory limit |
| :--- | :--- | :--- |
| `caddy` | HTTPS edge, the only published ports (80, 443, 443/udp) | 128M |
| `trame-server` | TRAME (production image) | 1G (512M reserved) |
| `postgres` | Database, internal network only | 512M |
| `silo` (profile `silo`) | S3-compatible asset store | 512M |
| `storage-init` (profile `silo`) | One-shot: creates the bucket and its CORS rule | 128M |
| `backup` | Nightly `pg_dump`, 14-day retention, optional dump + asset mirror to a bucket | 256M |
| `cloudflared` (tunnel variant) | Cloudflare Tunnel connector | 128M |

Every container has a read-only root filesystem, `no-new-privileges` and dropped capabilities, and its logs rotate at 3 x 10 MB.

## Before you start

- A Linux host with Docker Engine and the Compose plugin 2.24 or newer.
- **Runtime vs build RAM**:
  - **Running the stack** uses up to ~3 GB of RAM in the worst case (`2.6 GB` sum of container limits). On Oracle Cloud, use the Ampere A1 Always Free shape (up to 4 OCPU and 24 GB; 2 OCPU / 12 GB is plenty).
  - **Building from source** (`docker build -t trame-server:latest .`) compiles the Rust workspace, the WebAssembly engine, and the TypeScript/Vite SPA: expect **5–15 minutes** on a cold cache and **at least 4 GB of RAM plus 2–4 GB of swap**. Do **not** run `docker build` on a 1 GB VM (it will fail with an out-of-memory kill); instead, build the image in GitHub Actions CI or on your workstation (`docker buildx build --platform linux/<arch>`), push it to a registry (such as `ghcr.io/OWNER/trame-server:<tag>`) or copy it over SSH (`docker save ... | ssh ... docker load`), and set `TRAME_IMAGE` in `.env` to pull it.
- **DNS `A` record only (IPv4 — do not add an `AAAA` record)** pointing at the host for direct Caddy deployments. Docker's default IPv4 bridge routes inbound IPv6 connections through `docker-proxy` using the bridge gateway's IPv4 address, which collapses every IPv6 player into a single rate-limit bucket. If you want IPv6 support (or have no public IPv4 address), use the **Cloudflare Tunnel** variant below, which terminates IPv6 at Cloudflare's edge and forwards each visitor's real address.
- Inbound TCP 80 and 443, and UDP 443 (HTTP/3), open in the cloud firewall (Oracle: the subnet security list) and on the host (Oracle's Ubuntu images ship `iptables` rules that drop them).
- Oracle risks: Always Free instances that stay nearly idle for 7 days can be reclaimed, and A1 capacity is sometimes unavailable in a region. Keep the backup copy off the VM.

## First start

1. Build the production image from the repository root (needs **>= 4 GB RAM + swap** and ~5–15 minutes on a cold cache; on smaller VMs, build in CI or on another machine and set `TRAME_IMAGE` in `.env` instead):
   ```sh
   docker build -t trame-server:latest .
   ```
2. Create `deploy/compose/.env` and fill in the **Required** settings in Section 1 (`.env` holds secrets and is git-ignored):
   ```sh
   cd deploy/compose
   cp .env.example .env
   openssl rand -hex 32   # run once per secret below
   ```
   - **Required (Section 1 of `.env.example`)**:
     - `COMPOSE_FILE`: pre-set to `docker-compose.prod.yml` so `docker compose` commands run from `deploy/compose` target the production stack without `-f`.
     - `TRAME_DOMAIN`: your DNS `A`-record hostname (for example `table.example.com`, or `localhost` for local evaluation where Caddy automatically provisions a local TLS certificate from its internal CA).
     - `TRAME_PUBLIC_ORIGIN`: browser origin (`https://${TRAME_DOMAIN}` on default port `443`). Whenever `CADDY_HTTPS_PORT` is changed from `443`, `TRAME_PUBLIC_ORIGIN` **must** include `:<port>` (for example `TRAME_PUBLIC_ORIGIN=https://localhost:8443` or `https://${TRAME_DOMAIN}:${CADDY_HTTPS_PORT}`), and `S3_PUBLIC_ENDPOINT` (default `${TRAME_PUBLIC_ORIGIN}` for bundled Silo) must carry that same port (see **Variants** below).
     - `MASTER_ENCRYPTION_KEY`: 64-hex-character key (`openssl rand -hex 32`) encrypting TOTP secrets.
     - `TRAME_JWT_SECRET`: signing key (`>= 32` characters) for presigned asset download URLs.
     - `TRAME_INVITE_JWT_SECRET`: separate signing key (`>= 32` characters) still required by `trame-server` startup validation.
     - `POSTGRES_PASSWORD`: password for the bundled PostgreSQL database.
     - `S3_ACCESS_KEY_ID` (`>= 3` characters, for example `trame-s3`) and `S3_SECRET_ACCESS_KEY` (`>= 8` characters, for example `openssl rand -hex 32`) when keeping the default bundled `silo` profile.
   - **Optional (Section 2 of `.env.example` — safe to leave empty on first start)**:
     - `TRAME_BOOTSTRAP_OWNER_EMAIL` (restricts who may claim the initial setup URL), `BACKUP_S3_*` (off-machine backup bucket), `CLOUDFLARE_TUNNEL_TOKEN` (tunnel variant only), `DATABASE_URL` (external PostgreSQL), and schedule/image overrides (`CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` default to `80` and `443` in Section 1).
3. Start the stack and wait until it is healthy:
   ```sh
   docker compose up -d --wait
   ```
4. Claim the instance. While no Owner exists, every start logs a single-use setup URL valid for 1 hour:
   ```sh
   docker compose logs trame-server | grep owner_bootstrap_url
   ```
   Open the `setup_url` value in a browser and create the Owner account. If it expired, run `docker compose restart trame-server` to get a new one. Set `TRAME_BOOTSTRAP_OWNER_EMAIL` to restrict who can claim it.

## Account recovery

- **A player forgot their password.** The Owner opens **Accounts** in the lobby and selects **Create reset link** on that account, then sends the link privately. It works once, for 24 hours, and signs the account out on every device. Creating a new link cancels the previous one. Guest accounts have no password and offer no link.
- **Changing a password.** Any signed-in user can change their password under **Account**: the current password is required, plus a two-factor code when two-factor authentication is on. Their other devices are signed out.
- **The Owner is locked out.** Mint a reset link for the Owner from the server itself. The command uses the running server's configuration and database, prints one log line, and exits without touching the running server:
  ```sh
  docker compose exec trame-server /app/trame-server owner-reset-link | grep owner_password_reset_url
  ```
  Open the `reset_url` value and choose a new password. The same rules apply: one use, 24 hours, every session signed out. Two-factor authentication stays on, so keep access to the authenticator app.

## Variants

- **Bundled Silo (default)**: keep `COMPOSE_PROFILES=silo`. Map images are downloaded by the browser through Caddy on your own domain (`https://<domain>/<S3_BUCKET>/...`, presigned for 5 minutes). `storage-init` creates the bucket and its CORS rule at every start.
- **Cloudflare R2**: remove `silo` from `COMPOSE_PROFILES` and set the `S3_*` values shown in `.env.example`. Then set the bucket CORS rule (see below).
- **Assets in PostgreSQL**: leave every `S3_*` value empty and remove the `silo` profile. Fine for small tables; assets then live in the database and are part of the backups.
- **Cloudflare Tunnel** (no open ports): create a tunnel in Cloudflare Zero Trust, add the public hostname `TRAME_DOMAIN` with service `http://caddy:80`, set `CLOUDFLARE_TUNNEL_TOKEN`, and replace `COMPOSE_FILE` in `.env` with `COMPOSE_FILE=docker-compose.prod.yml:docker-compose.tunnel.yml`. Caddy then serves plain HTTP inside the stack, and Cloudflare handles TLS.
- **Custom HTTPS port or local evaluation (`CADDY_HTTPS_PORT`)**: when changing `CADDY_HTTPS_PORT` from `443` (for example `8443` for local evaluation or custom port forwarding), `TRAME_PUBLIC_ORIGIN` **must** include `:<port>` (for example `TRAME_PUBLIC_ORIGIN=https://localhost:8443` or `https://${TRAME_DOMAIN}:${CADDY_HTTPS_PORT}`), and `S3_PUBLIC_ENDPOINT` (which defaults to `${TRAME_PUBLIC_ORIGIN}` for bundled Silo) must likewise carry that port so WebSocket `Origin` validation, Silo CORS (`Access-Control-Allow-Origin`), and presigned asset redirects match the browser's origin. For `TRAME_DOMAIN=localhost`, Caddy automatically provisions a local TLS certificate from its internal CA.

## Bucket CORS

The battlemap is drawn on a WebGL canvas, so the browser loads it with `crossOrigin="anonymous"`. The bucket must answer `GET` from `TRAME_PUBLIC_ORIGIN` with `Access-Control-Allow-Origin`, or the map stays blank.

- Silo: automatic (`storage-init`, script `ops/apply-bucket-cors.sh`).
- R2: either run the same script once with an R2 token that can edit bucket settings (`S3_*` temporarily set to that token):
  ```sh
  docker compose run --rm --no-deps storage-init
  ```
  or paste `r2-cors.example.json` (with your origin) into the R2 dashboard under the bucket's CORS policy.

## Proxy, compression and WebSockets

- `TRAME_TRUSTED_PROXY_HOPS` is set by the Compose files, not by `.env`. It is `1` behind Caddy, and `2` with the tunnel (Cloudflare, then Caddy). Rate limits are keyed on the real browser address. Keep DNS **IPv4-only (`A` record, no `AAAA`)** when publishing Caddy directly on the host: without an IPv6 Docker network, `docker-proxy` rewrites inbound IPv6 peers to the bridge gateway address so all IPv6 visitors would share one rate-limit bucket. Cloudflare Tunnel terminates IPv6 at Cloudflare's edge and forwards each visitor's real IPv6 address in `X-Forwarded-For`.
- Caddy does not compress responses. `trame-server` already uses gzip, br or zstd and skips images, and WebSocket frames are compressed by the `trame.v1+deflate` subprotocol, which Caddy passes through.
- WebSockets have no proxy timeout. The server pings every 20 seconds, which keeps Cloudflare's 100-second idle limit from closing them. A `caddy reload` keeps open sockets for up to 5 minutes.

## Updates

```sh
git pull
docker build -t trame-server:latest .        # from the repository root
docker compose exec backup backup.sh now     # fresh backup first
docker compose up -d --wait --build
```

Database migrations run automatically when the server starts. To roll back, check out the previous version, rebuild, and restore the backup taken before the update.

## Backups and restore

The full procedure, including restore drills and asset bucket protection, is in the [backup and restore runbook](../backup-and-restore.md). In short:

- `backup` writes `trame-<db>-<UTC time>.dump` (`pg_dump` custom format) to the `backups` volume every day at `BACKUP_TIME` (UTC) and keeps `BACKUP_RETENTION_DAYS` (14) days. With `BACKUP_S3_*` set to a pre-created bucket separate from `S3_BUCKET` (such as Cloudflare R2 with a bucket-scoped *Object Read & Write* token), each run also uploads the dump to `<BACKUP_S3_PREFIX>` (default `trame/postgres`) and mirrors `<S3_BUCKET>` to `<BACKUP_S3_ASSETS_PREFIX>` (default `trame/assets`, without `--remove`). Keep the backup bucket off the VM: a copy on the same machine does not survive losing the VM.
- A failed dump upload or asset mirror marks the `backup` container unhealthy (`docker compose ps`). Run one now with `docker compose exec backup backup.sh now`.
- Restore: `docker compose stop trame-server`, `docker compose exec backup restore.sh <dump file>`, `docker compose up -d --wait trame-server`. When distinct `S3_*` and `BACKUP_S3_*` buckets are configured, `restore.sh` also mirrors backed-up asset objects back into `<S3_BUCKET>`.
- **Without `BACKUP_S3_*`**, Silo assets live only on the local `silo_data` volume (they are not inside `.dump` archives unless `S3_*` is unset so assets stay in PostgreSQL).

## Smoke test

`make deploy-compose-smoke` (from the repository root, after `make e2e-image`) starts a throwaway copy of this stack on `https://localhost:18743` with Caddy's internal CA. It checks `/healthz` through Caddy, single-pass compression, owner bootstrap, a WebSocket with `trame.v1+deflate`, a map upload served from Silo through a presigned redirect with the CORS header, and a backup to a separate `trame-backups` bucket (verifying zero leaked credentials in `/proc/*/cmdline`). Then it deletes the database volume, the local dump, and every object in `trame-assets`, restores both the database and mirrored assets from `trame-backups`, and checks that the campaign, session, and presigned WebP map download all work again. Finally it removes every container, volume and network it created.
