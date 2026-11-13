# ADR-0041: S3-compatible Asset Storage, Signed Direct Downloads, Traffic Compression and Free Hosting Targets

## Status
Accepted (2026-11-05). Amends Decision 2 of [ADR-0010](./0010-hybrid-auth-preact-signals-and-postgres-runtime.md) and its 2026-11-01 amendment (`S3Store` not wired), and makes the `S3Store` path of [ADR-0002](./0002-asset-store-and-uvtt-import-pipeline.md) the configured production path. Records decisions D5, D18, D19, D20, D21 and D24 of [`spec-internet-ready-playable-trame.md`](../specs/spec-internet-ready-playable-trame.md). The WebSocket compression spike outcome is recorded below. Amended 2026-11-08: Decision 4 now states the delivered spending cap (warnings at 1 and 5 EUR, hard cap at 10 EUR) instead of a single 1 EUR alert, and the bucket CORS rule is limited to the public origin.

## Context
ADR-0010 targets local Docker, a single VPS and Cloud Run + Neon + R2, and names `S3Store` as the asset backend. In practice:
- `S3Store` is not wired. Every map image and portrait is stored in PostgreSQL and proxied through `trame-server`.
- The shipped Cloud Run template expects Cloud SQL, which is not free (SEC19). There is no documented strictly-free path.
- Cloud Run bills Europe egress from the first byte (about 0.105 USD/GiB, checked 2026-11-05). Proxied assets and uncompressed HTTP and WebSocket traffic all count (SEC20).
- There is no TLS edge in the Compose stack (SEC17) and no backup or tested restore (SEC18).

An `Owner` running TRAME for friends needs a hosting path that costs nothing, or a few cents a month, without losing data.

## Considered Options
1. **Keep assets in PostgreSQL behind the server.** Rejected: every asset load costs server egress and database storage, which the free tiers cannot absorb.
2. **Cloud SQL and Google Cloud Storage.** Rejected: Cloud SQL has no free tier.
3. **S3-compatible storage with signed direct downloads, Neon, and two documented hosting targets (Recommended).** Assets bypass the server when an object store is configured, and PostgreSQL stays the zero-dependency fallback.
4. **A third-party WebSocket crate for compression.** Rejected (D24): compression stays on `tokio-tungstenite`, which the `axum` WebSocket stack already uses, instead of adding a new dependency.

## Decision
1. **`S3Store`.** `S3Store` implements the asset store contract for any S3-compatible backend (Cloudflare R2, Silo). It is active when the S3 settings (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, credentials) are configured; otherwise assets stay in PostgreSQL as today. A one-shot migration copies existing blobs into the object store.
2. **Signed direct downloads.** With `S3Store` active, the server checks campaign membership and returns a short-lived signed GET URL pointing straight at the object store. Browsers download map images and portraits from the object store, not through the server.
3. **Neon instead of Cloud SQL.** The managed PostgreSQL target is Neon (free tier, Frankfurt). The Neon connection string lives in Secret Manager.
4. **Two hosting targets.**
   - *Near-free:* Cloud Run `europe-west9` (Paris, Tier 1 free compute) with request timeout 3600 s, `max-instances = 1` and session affinity, plus Neon and Cloudflare R2, provisioned by Terraform. A monthly budget sends email warnings at 1 EUR and 5 EUR; at 10 EUR a Cloud Run function subscribed to the budget's Pub/Sub topic unlinks the project from billing, which stops it. Google reports costs to budgets hours after the usage, so the cap acts late and a month can end slightly above 10 EUR. A card is required. Every green push to `main` deploys, so required reviewers on the GitHub `production` environment are recommended.
   - *Strictly free:* the production Compose stack with Caddy (automatic HTTPS, the only service publishing ports) on an Oracle Always Free VM, or on a home machine behind Cloudflare Tunnel. Oracle idle reclamation and capacity risks are documented.
5. **HTTP compression.** A `tower-http` compression layer negotiates gzip, br or zstd from each request's `Accept-Encoding` and skips already-compressed content types (images, fonts).
6. **WebSocket compression.** A spike first tries standard `permessage-deflate` through a hand-rolled upgrade on `tokio-tungstenite` with its `deflate` feature, because the `axum` 0.8.9 extractor cannot negotiate it. If the spike fails, the fallback is application-level deflate negotiated through `Sec-WebSocket-Protocol` as `trame.v1+deflate`, decoded in the browser with `DecompressionStream`. The security reviewer checks BREACH-style exposure. State frames are skipped when a recipient's projection has not changed.
7. **Backups.** A nightly `pg_dump` is kept for 14 days and pushed to R2: a Cloud Run job triggered by Cloud Scheduler on the near-free target, and a `backup` container with an optional off-machine copy on the strictly-free target. A restore script ships with it and is exercised in E2E. The operator procedure is the [backup and restore runbook](../../deploy/backup-and-restore.md).

### WebSocket compression spike outcome
Spike run 2026-11-07. **`trame.v1+deflate` shipped; standard `permessage-deflate` did not.**
- **Library support.** The `deflate` feature the spike relied on does not exist. No released `tungstenite` (0.28, 0.29, 0.30) or `tokio-tungstenite` (0.29, 0.30) exposes it: frames with the RSV1 bit are refused and no extension can be negotiated. `axum` 0.8.9 pins `tokio-tungstenite` 0.29. Standard `permessage-deflate` would need a different WebSocket crate, which Option 4 rejects.
- **Fallback.** The browser offers `Sec-WebSocket-Protocol: trame.v1+deflate` when it has `DecompressionStream` (Chrome 80, Firefox 113, Safari 16.4). The server selects it through the `axum` extractor, and the socket writer task compresses each outbound binary frame as one self-contained zlib stream at level 1. Client frames stay uncompressed, so the server never inflates untrusted input. A client that does not offer the protocol gets plain frames.
- **Cost.** Measured on GM snapshot frames (debug build, so an upper bound): a 40-wall, 8-token scene goes from 14.8 KB to 2.4 KB (16 %), and a 600-wall, 40-token scene from 154 KB to 19.7 KB (13 %) in about 4 ms. Each frame allocates the compressor state (about 300 KB) and frees it right after. No state persists between frames, so idle sockets cost nothing.
- **BREACH.** Frames carry no credential; the session cookie travels only in the upgrade request. The residual risk is a player who also watches the GM's encrypted traffic and compares frame sizes while changing text that appears next to GM-only text. That attack exposes table secrets, not credentials. It is accepted and listed for the security reviewer.

### `S3Store` implementation outcome
Implemented 2026-11-07.
- **Configuration.** `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` select `S3Store`; `S3_REGION` (default `auto`) and `S3_PUBLIC_ENDPOINT` (default `S3_ENDPOINT`) are optional. Outside dev, setting only some of them refuses to start, so a typo cannot silently keep assets in PostgreSQL.
- **Layout.** Object keys are the existing content addresses. `campaign_assets` keeps one row per asset with `payload` NULL (migration `0007`), so the storage quota, archive export and membership checks still read PostgreSQL.
- **Signing.** Requests use AWS SigV4 query presigning (`UNSIGNED-PAYLOAD`, path-style) over `hyper` and `rustls`, about 200 lines checked against the AWS test vector, instead of the AWS SDK and its dependency tree.
- **Downloads.** `/assets/download/{key}` verifies the HMAC signature first, then answers `307` to a presigned `GET` valid 5 minutes. The public endpoint's origin is added to the SPA CSP `img-src`. The battlemap image is loaded with `crossOrigin = "anonymous"` so the WebGL texture is not tainted, which requires a bucket CORS rule allowing `GET` and `HEAD` from `TRAME_PUBLIC_ORIGIN` (the server itself is same-origin and sends no CORS headers).
- **Migration.** At each boot, a background task copies inline blobs to the bucket, reads them back, compares SHA-256 digests, and clears the inline payload only if it still matches. It is idempotent; failed rows stay inline, keep being served by the server, and are retried on the next boot.

## Consequences
### Positive
- Hosting costs 0 EUR on the strictly-free target and a few cents a month on Cloud Run, with egress kept low by compression and direct object-store downloads.
- The server no longer streams asset bytes when an object store is configured, so it stays light under a full table.
- A dead disk or a bad deploy costs at most a day of data, and the restore path is tested.
- PostgreSQL-only deployments keep working with no object store.

### Negative
- Two asset backends and two hosting targets must be documented, tested and kept in sync.
- Signed URLs expose the object-store hostname to browsers, and the Content Security Policy must allow it.
- The near-free target requires a card on file and depends on three providers (Google Cloud, Neon, Cloudflare).
- The strictly-free target depends on Oracle capacity and idle-reclamation rules, or on a home machine's uptime.
- A hand-rolled WebSocket upgrade, or a custom subprotocol, is code TRAME must maintain.
