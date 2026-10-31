# ADR-0008: Portable .trame Campaign Archive Format and Two-Pass Streaming Engine

## Status
Accepted

## Context
TRAME requires a self-contained campaign archive format (`.trame`) that allows Game Masters to migrate complete campaigns across local Docker engines, minimal virtual machines (`e2-micro`), and serverless container platforms (Cloud Run with Neon Postgres and Cloudflare R2).

In-memory ZIP assembly of large campaign assets risks `OutOfMemory` terminations under constrained container quotas, while `manifest.json` must reside as the first archive entry so validators can inspect metadata before unpacking binary blobs. Furthermore, restoring an archive on an instance that already contains campaign records requires optional UUID remapping (`remap_ids=true`) that rewrites internal Markdown `[[<uuid>|<label>]]` cross-references deterministically.

## Decision
1. The portable archive format is a standard ZIP container using the `.trame` file extension.
2. The archive root contains `manifest.json` (guaranteed first ZIP entry), `database.jsonl`, `notes/*.md`, and `assets/*.webp`.
3. `export_campaign_archive` executes a deterministic Two-Pass Streaming export:
   - Pass 1 computes entry byte counts and SHA-256 digests without buffering all asset blobs simultaneously in RAM.
   - Pass 2 writes `manifest.json` first, followed by `database.jsonl`, Markdown notes, and WebP assets using `async_zip`.
4. `import_campaign_archive` validates entry SHA-256 checksums against `manifest.json`, rejects path traversal (`..`), and enforces `FAIL_IF_EXISTS` by default unless `remap_ids=true` is specified, in which case all entity UUIDs and `[[<uuid>|<label>]]` wikilinks are deterministically remapped.

## Consequences
### Positive
- Bounded memory footprint during export and import regardless of total campaign size.
- Clients validate archive integrity upfront from `manifest.json`.
- Campaign cloning works out of the box via `remap_ids=true` without breaking note wikilinks.

### Negative
- Pass 1 requires reading asset metadata/digests before streaming the ZIP body.
