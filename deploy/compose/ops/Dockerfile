# ============================================================================
# TRAME BACKUP & STORAGE OPERATIONS IMAGE (deploy/compose/ops/Dockerfile)
# ============================================================================
#
# PURPOSE:
# --------
# One small image for the Compose `backup` service (nightly `pg_dump`, local
# retention, S3 upload, `restore.sh`) and the one-shot `storage-init` job
# (bucket creation and CORS rule). The Cloud Run backup job of
# `deploy/terraform` runs the same image (`backup.sh now`, `restore.sh`).
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Matching PostgreSQL Client`:
#      - Built from the same `postgres:18-alpine` digest as the database
#        service, so `pg_dump`/`pg_restore` are never older than the server.
#   2. `Pinned Object-Store Client`:
#      - `mc` (static binary) comes from the digest-pinned Silo client image;
#        it speaks S3 to Silo and Cloudflare R2 alike.
#   3. `Unprivileged`:
#      - Runs as `postgres` (uid 70). `/backups` is created owned by that
#        user so a fresh named volume inherits the ownership.
#   4. `System CA Bundle For TLS Verification`:
#      - `PGSSLROOTCERT` points `libpq` (`pg_dump`, `restore.sh`, `psql`) at
#        Alpine's system CA bundle (`/etc/ssl/certs/ca-certificates.crt`) so
#        `DATABASE_URL` with `sslmode=verify-full` (Neon / external Postgres)
#        verifies the server certificate chain and hostname without needing a
#        per-user `~/.postgresql/root.crt`, while remaining inert for internal
#        Compose bridge connections (`PGHOST=postgres`).
# ============================================================================

FROM pgsty/mc:RELEASE.2026-10-26T00-00-00Z@sha256:ce62c9053c69ce12a527a322345b5ad9f44b5f8a7b8189f82e516f2e3f30f1d8 AS mc

FROM postgres:18-alpine@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
COPY --chmod=0755 backup.sh restore.sh apply-bucket-cors.sh /usr/local/bin/
RUN install -d -o postgres -g postgres -m 0750 /backups
ENV BACKUP_DIR=/backups \
    MC_CONFIG_DIR=/tmp/.mc \
    PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt
# `postgres` (uid/gid 70 in the Alpine image).
USER 70:70
WORKDIR /backups
ENTRYPOINT []
CMD ["backup.sh", "schedule"]
