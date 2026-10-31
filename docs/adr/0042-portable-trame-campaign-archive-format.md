# ADR-0042: Portable .trame Campaign Archive Format and Two-Pass Streaming Engine

## Status
Accepted

## Context
TRAME requires a fully portable, self-contained campaign archive format (`.trame`) that allows Game Masters to migrate complete campaigns across local Docker engines, minimal virtual machines (`e2-micro`), and serverless container platforms (Cloud Run with Neon Postgres and Cloudflare R2).

Previous systems relied on database-specific SQL dumps or uncompressed directory trees. These approaches created three structural limitations:
1. Cloud Run containers run with constrained memory envelopes (typically 256 MiB container quota, targeting 32 MiB baseline heap usage). In-memory ZIP assembly or full-archive RAM buffering causes `OutOfMemory` process terminations.
2. In-memory streaming compression typically requires writing file headers sequentially. Standard ZIP archives require entry byte lengths and CRC-32/SHA-256 checksums prior to writing local file entries, or require a central directory at the end. However, `manifest.json` must reside as the first archive entry to allow streaming validators to inspect metadata before unpacking large binary blobs.
3. Restoring an archive on an instance that already contains campaign records risks UUID collisions. Forcing UUID replacement breaks internal Markdown cross-references (such as Obsidian `[[<uuid>|<label>]]` links) unless the engine rewrites all references deterministically.

## Decision
1. The portable archive format is a standard ZIP container using the `.trame` file extension.
2. The archive root contains `manifest.json`, `database.jsonl`, an optional `notes/` directory containing CommonMark files with YAML frontmatter, and an optional `assets/` directory containing WebP media files.
3. `ArchiveExporter` executes a deterministic Two-Pass Streaming export:
   - Pass 1: The exporter scans campaign database records and `BlobStore` metadata. The exporter computes entry byte counts and SHA-256 cryptographic digests in a streaming pipeline without loading entire binary blobs into RAM.
   - Pass 2: The exporter writes `manifest.json` containing the precomputed digests as the initial ZIP entry. The exporter then streams `database.jsonl`, Markdown notes, and WebP assets directly into the HTTP response sink or CLI output file using `async_zip`.
4. `ArchiveImporter` validates entry SHA-256 checksums during extraction. If a computed checksum does not match the manifest entry, the importer aborts the transaction.
5. `ArchiveImporter` applies a `FAIL_IF_EXISTS` collision policy by default. When the `--remap-ids` flag is present, `ArchiveImporter` allocates new UUIDs for all entities and rewrites internal foreign keys and Markdown links using the regex `\[\[([0-9a-f\-]{36})(\|[^\]]+)?\]\]`.

## Consequences
### Positive
- Memory consumption during export and import stays below 16 MiB heap usage regardless of total campaign size.
- Clients validate archive integrity upfront from `manifest.json` before unpacking assets.
- Campaign cloning is supported via the `--remap-ids` pipeline without breaking note wikilinks.

### Negative
- Pass 1 requires an extra read cycle across database records and asset stores prior to payload transmission.
- Identity remapping requires parsing and serializing all note bodies during import.