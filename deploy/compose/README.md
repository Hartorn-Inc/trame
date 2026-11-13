# TRAME with Docker Compose (self-hosted, 0 EUR)

This directory runs TRAME on one machine: an Oracle Cloud Always Free VM, or a home machine behind Cloudflare Tunnel. Caddy is the only service that publishes ports, and it gets HTTPS certificates automatically. PostgreSQL is backed up every night.

| Service | Role | Memory limit |
| :--- | :--- | :--- |
| `caddy` | HTTPS edge, the only published ports (80, 443, 443/udp) | 128M |
| `trame-server` | TRAME (production image) | 1G (512M reserved) |
| `postgres` | Database, internal network only | 512M |
| `silo` (profile `silo`) | S3-compatible asset store | 512M |
| `storage-init` (profile `silo`) | One-shot: creates the bucket and its CORS rule | 128M |
| `backup` | Nightly `pg_dump`, 14-day retention, optional copy to a bucket | 256M |
| `cloudflared` (tunnel variant) | Cloudflare Tunnel connector | 128M |

Every container has a read-only root filesystem, `no-new-privileges` and dropped capabilities, and its logs rotate at 3 x 10 MB.

## Before you start

- A Linux host with Docker Engine and the Compose plugin 2.24 or newer.
- About 3 GB of RAM in the worst case. On Oracle Cloud, use the Ampere A1 Always Free shape (up to 2 OCPU and 12 GB).
- A DNS `A`/`AAAA` record for your domain pointing at the host.
- Inbound TCP 80 and 443, and UDP 443 (HTTP/3), open in the cloud firewall (Oracle: the subnet security list) and on the host (Oracle's Ubuntu images ship `iptables` rules that drop them).
- Oracle risks: Always Free instances that stay nearly idle for 7 days can be reclaimed, and A1 capacity is sometimes unavailable in a region. Keep the backup copy off the VM.

## First start

1. Build the production image from the repository root (there is no published image yet):
   ```sh
   docker build -t trame-server:latest .
   ```
2. Create the settings file and fill in every empty value. `.env` holds secrets and is git-ignored.
   ```sh
   cd deploy/compose
   cp .env.example .env
   openssl rand -hex 32   # one value per secret
   ```
3. Start the stack and wait until it is healthy:
   ```sh
   docker compose up -d --wait
   ```
4. Claim the instance. While no Owner exists, every start logs a single-use setup URL valid for 1 hour:
   ```sh
   docker compose logs trame-server | grep owner_bootstrap_url
   ```
   Open the `setup_url` value in a browser and create the Owner account. If it expired, run `docker compose restart trame-server` to get a new one. Set `TRAME_BOOTSTRAP_OWNER_EMAIL` to restrict who can claim it.

## Variants

- **Bundled Silo (default)**: keep `COMPOSE_PROFILES=silo`. Map images are downloaded by the browser through Caddy on your own domain (`https://<domain>/<S3_BUCKET>/...`, presigned for 5 minutes). `storage-init` creates the bucket and its CORS rule at every start.
- **Cloudflare R2**: remove `silo` from `COMPOSE_PROFILES` and set the `S3_*` values shown in `.env.example`. Then set the bucket CORS rule (see below).
- **Assets in PostgreSQL**: leave every `S3_*` value empty and remove the `silo` profile. Fine for small tables; assets then live in the database and are part of the backups.
- **Cloudflare Tunnel** (no open ports): create a tunnel in Cloudflare Zero Trust, add the public hostname `TRAME_DOMAIN` with service `http://caddy:80`, set `CLOUDFLARE_TUNNEL_TOKEN`, and uncomment `COMPOSE_FILE=docker-compose.prod.yml:docker-compose.tunnel.yml` in `.env`. Caddy then serves plain HTTP inside the stack, and Cloudflare handles TLS.

## Bucket CORS

The battlemap is drawn on a WebGL canvas, so the browser loads it with `crossOrigin="anonymous"`. The bucket must answer `GET` from `TRAME_PUBLIC_ORIGIN` with `Access-Control-Allow-Origin`, or the map stays blank.

- Silo: automatic (`storage-init`, script `ops/apply-bucket-cors.sh`).
- R2: either run the same script once with an R2 token that can edit bucket settings (`S3_*` temporarily set to that token):
  ```sh
  docker compose run --rm --no-deps storage-init
  ```
  or paste `r2-cors.example.json` (with your origin) into the R2 dashboard under the bucket's CORS policy.

## Proxy, compression and WebSockets

- `TRAME_TRUSTED_PROXY_HOPS` is set by the Compose files, not by `.env`. It is `1` behind Caddy, and `2` with the tunnel (Cloudflare, then Caddy). Rate limits are keyed on the real browser address.
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

- `backup` writes `trame-<db>-<UTC time>.dump` (`pg_dump` custom format) to the `backups` volume every day at `BACKUP_TIME` (UTC) and keeps `BACKUP_RETENTION_DAYS` (14) days. With `BACKUP_S3_*` set, each dump is also copied to that bucket. Use an R2 bucket separate from the assets: a copy on the same VM does not survive losing the VM.
- A failed run marks the `backup` container unhealthy (`docker compose ps`). Run one now with `docker compose exec backup backup.sh now`.
- Restore: `docker compose stop trame-server`, `docker compose exec backup restore.sh <dump file>`, `docker compose up -d --wait trame-server`.
- **Assets are not in the dumps** when they live in Silo or R2. Protect the asset bucket separately.

## Smoke test

`make deploy-compose-smoke` (from the repository root, after `make e2e-image`) starts a throwaway copy of this stack on `https://localhost:18743` with Caddy's internal CA. It checks `/healthz` through Caddy, single-pass compression, owner bootstrap, a WebSocket with `trame.v1+deflate`, a map upload served from Silo through a presigned redirect with the CORS header, and a backup. Then it deletes the database volume and the local dump, restores from the bucket copy, and checks that the campaign and session are back. Finally it removes every container, volume and network it created.
