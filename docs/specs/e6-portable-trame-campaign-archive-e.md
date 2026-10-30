# Specification: Portable .trame Campaign Archive, Hybrid Auth & Cloud Run Deployment

## 1. Executive Summary & Problem Statement

TRAME requires a self-contained, portable campaign archive format (`.trame`) enabling zero-loss migration across self-hosted Docker instances, resource-constrained virtual machines (`e2-micro`), and serverless container platforms (Cloud Run with Neon Postgres and Cloudflare R2). Furthermore, player adoption requires frictionless onboarding via single-action Magic Link URLs (`?invite=<jwt>`), complemented by enterprise credentials (Argon2id passwords, TOTP MFA RFC 6238, Discord and Google OAuth2) and Personal Access Tokens for Model Context Protocol (MCP) clients.

This specification defines the format, two-pass streaming engine, identity system, graceful shutdown lifecycle, and cloud deployment manifests.

---

## 2. Portable `.trame` Archive Format & Two-Pass Streaming Engine

### 2.1 Archive Structure
A `.trame` file is a ZIP archive adhering to the standard PKWARE specification. The archive structure contains the following filesystem layout:

```text
<archive-root>/
├── manifest.json
├── database.jsonl
├── notes/
│   ├── campaign-overview.md
│   └── factions/
│       └── harpers.md
└── assets/
    ├── 3fa85f64-5717-4562-b3fc-2c963f66afa6.webp
    └── 7c9e6679-7425-40de-944b-e07fc1f90ae7.webp
```

### 2.2 Manifest Specification (`manifest.json`)
`manifest.json` MUST be the first entry in the ZIP archive. It contains campaign metadata, engine compatibility numbers, and cryptographic digests for all entries:

```json
{
  "manifest_version": 1,
  "generator": "trame-server 0.1.0",
  "exported_at": "2025-05-18T14:32:00Z",
  "campaign": {
    "id": "b3a2a197-0f8a-4d76-9d62-1db7d995ff7a",
    "name": "Curse of the Obsidian Spire",
    "system": "dnd5e",
    "description": "Campaign export with full scene and actor state.",
    "created_at": "2025-01-10T18:00:00Z"
  },
  "stats": {
    "actor_count": 12,
    "scene_count": 4,
    "note_count": 18,
    "asset_count": 25,
    "total_uncompressed_bytes": 14829104
  },
  "entries": [
    {
      "path": "database.jsonl",
      "byte_size": 421045,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "path": "notes/campaign-overview.md",
      "byte_size": 1240,
      "sha256": "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969"
    },
    {
      "path": "assets/3fa85f64-5717-4562-b3fc-2c963f66afa6.webp",
      "byte_size": 845210,
      "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
    }
  ]
}
```

### 2.3 Database Stream (`database.jsonl`)
`database.jsonl` contains line-delimited JSON objects. Each row contains an `entity_type` tag and an entity payload representing one persistent database record:

```json
{"entity_type":"campaign","data":{"id":"b3a2a197-0f8a-4d76-9d62-1db7d995ff7a","name":"Curse of the Obsidian Spire","system":"dnd5e","created_at":"2025-01-10T18:00:00Z"}}
{"entity_type":"scene","data":{"id":"9c1d0e82-2c63-4f9e-b87b-84a14138e6bc","campaign_id":"b3a2a197-0f8a-4d76-9d62-1db7d995ff7a","name":"Cathedral Entrance","grid_size":70,"width":2800,"height":2100}}
{"entity_type":"wall","data":{"id":"f47ac10b-58cc-4372-a567-0e02b2c3d479","scene_id":"9c1d0e82-2c63-4f9e-b87b-84a14138e6bc","p1":[100.0,200.0],"p2":[500.0,200.0],"blocks_movement":true,"blocks_light":true}}
{"entity_type":"actor","data":{"id":"550e8400-e29b-41d4-a716-446655440000","campaign_id":"b3a2a197-0f8a-4d76-9d62-1db7d995ff7a","name":"Gideon Ironheart","kind":"character","sheet":{"hp":28,"ac":16,"stats":{"str":16,"dex":12,"con":14,"int":10,"wis":13,"cha":8}}}}
{"entity_type":"token","data":{"id":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","scene_id":"9c1d0e82-2c63-4f9e-b87b-84a14138e6bc","actor_id":"550e8400-e29b-41d4-a716-446655440000","x":350.0,"y":420.0,"elevation":0.0}}
```

### 2.4 Markdown Notes (`notes/*.md`)
Markdown notes adhere to the CommonMark specification. Each file includes frontmatter metadata delimited by `---`:

```markdown
---
id: 7b354366-0ec1-456e-8260-2ff0d4e9c71f
title: Harpers Infiltration Plan
folder: factions
author_id: 11111111-2222-3333-4444-555555555555
created_at: 2025-02-01T10:00:00Z
updated_at: 2025-02-05T14:20:00Z
---

# Harpers Infiltration Plan

Contact agent [[550e8400-e29b-41d4-a716-446655440000|Gideon Ironheart]] at the front gate.
Check scene [[9c1d0e82-2c63-4f9e-b87b-84a14138e6bc]] for sentinel placements.
```

### 2.5 Asset Storage (`assets/*.webp`)
All campaign images, maps, handout illustrations, and avatar pictures are stored under `assets/<asset-uuid>.webp`. Every binary asset must be encoded in the WebP image format.

### 2.6 Two-Pass Streaming Export Engine
To satisfy the 16 MiB heap ceiling under Cloud Run and CLI executions, `ArchiveExporter` must not load full archive payloads or complete asset sets into RAM. `ArchiveExporter` executes a strict two-pass process:

1. **Pass 1 (Digest & Size Pre-scan)**:
   - `ArchiveExporter` queries database records for the campaign.
   - `ArchiveExporter` computes the serialized byte size and SHA-256 digest of `database.jsonl` using a streaming `Sha256` hasher.
   - `ArchiveExporter` reads note records, serializes the Markdown files with frontmatter, and calculates individual file lengths and SHA-256 digests.
   - `ArchiveExporter` queries the `BlobStore` descriptors for campaign asset entries. When the `BlobStore` contains precomputed asset digests and sizes, `ArchiveExporter` reads the descriptors directly. When hashes are absent, `ArchiveExporter` streams asset bytes through a SHA-256 hasher in 64 KiB chunks.
   - `ArchiveExporter` compiles `manifest.json` containing the precomputed sizes and digests.

2. **Pass 2 (Streaming ZIP Construction)**:
   - `ArchiveExporter` writes `manifest.json` as the initial entry of the ZIP container via `async_zip::tokio::write::ZipFileWriter`.
   - `ArchiveExporter` streams `database.jsonl` row by row into the ZIP entry sink.
   - `ArchiveExporter` streams each Markdown file into `notes/<path>.md`.
   - `ArchiveExporter` streams each asset from `BlobStore::open_read_stream(asset_id)` directly into `assets/<asset-id>.webp` in 64 KiB chunks.
   - `ArchiveExporter` closes the ZIP central directory and terminates the response stream.

During both passes, the exporter maintains memory allocation below 16 MiB.

### 2.7 Import Validation Engine
`ArchiveImporter` processes incoming archive streams under the following invariants:
1. The importer reads the initial ZIP entry. If the first entry name does not equal `manifest.json`, the importer terminates with HTTP 400 (`ERR_ARCHIVE_INVALID_MANIFEST`).
2. The importer parses `manifest.json` and builds an in-memory verification map containing byte lengths and expected SHA-256 digests.
3. The importer streams subsequent ZIP entries. For each entry, the importer passes chunks to a streaming SHA-256 hasher. If the computed digest does not match the manifest record, the importer aborts extraction and triggers a database rollback.
4. If an entry appears in the archive without a corresponding descriptor in `manifest.json`, the importer rejects the archive (`ERR_ARCHIVE_UNLISTED_ENTRY`).

### 2.8 Collision Resolution Policy & Remapping Mode
1. **Default Mode (`FAIL_IF_EXISTS`)**:
   - The importer checks whether the target `campaign.id` exists in the database.
   - IF the campaign identifier exists, THEN `ArchiveImporter` halts execution and returns HTTP 409 Conflict (`ERR_CAMPAIGN_ALREADY_EXISTS`).

2. **Remapping Mode (`--remap-ids` / `remap_ids: true`)**:
   - `ArchiveImporter` creates an in-memory mapping table: `HashMap<Uuid, Uuid>`.
   - The importer generates a fresh UUID for the campaign and for every imported scene, wall, light, actor, token, note, and asset.
   - When parsing `database.jsonl`, the importer replaces all primary keys and foreign keys using the mapping table.
   - When extracting `notes/*.md`, the importer parses YAML frontmatter and replaces `id` and `author_id`. The importer then applies a regular expression to rewrite wikilinks with or without labels:
     ```regex
     \[\[([0-9a-f\-]{36})(\|[^\]]+)?\]\]
     ```
     IF captured UUID $1 exists in the remapping table, THEN the importer substitutes the new UUID while preserving the optional label pipe `|label`.
   - The importer renames each asset file `assets/<old-uuid>.webp` to `assets/<new-uuid>.webp` before calling `BlobStore::put_stream()`.

---

## 3. Hybrid Authentication Architecture

### 3.1 Authentication Overview
TRAME implements four orthogonal authentication mechanisms:
1. Frictionless Magic Link URLs for player onboarding.
2. Email and Argon2id password authentication.
3. OAuth2 authentication (Discord and Google).
4. Personal Access Tokens for programmatic and MCP client access.

All authenticated web sessions establish a cryptographically random session token delivered via an `HttpOnly`, `SameSite=Lax`, `Secure` HTTP cookie.

### 3.2 Magic Link URLs (`?invite=<jwt>`)

#### 3.2.1 Token Construction
A Game Master or Campaign Administrator generates a Magic Link URL via `POST /api/v1/campaigns/:id/invites`. The token is a signed JSON Web Token (JWT) using HMAC-SHA256 (`HS256`) signed with the server `JWT_SECRET`. The claims payload contains:

```json
{
  "sub": "invite",
  "iss": "trame-server",
  "campaign_id": "b3a2a197-0f8a-4d76-9d62-1db7d995ff7a",
  "character_id": "550e8400-e29b-41d4-a716-446655440000",
  "role": "PLAYER",
  "exp": 1747584000,
  "jti": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"
}
```
`character_id` is an optional UUID targeting a pre-assigned Actor.

#### 3.2.2 Onboarding Workflow
1. The player navigates to `https://<domain>/join?invite=<jwt>`.
2. The client transmits the JWT to `POST /api/v1/auth/magic-link`.
3. The server validates the cryptographic signature and expiration time.
4. The server checks whether the claim `jti` exists in the `revoked_invites` table. IF revoked, the server returns HTTP 401 Unauthorized.
5. The server creates a guest user record in the `users` table with `role = 'player'` and `is_guest = true`.
6. IF `character_id` is specified in the claims, THEN the server associates the user record with the designated Actor in the `campaign_members` table.
7. The server generates a cryptographically random 256-bit session token.
8. The server computes `SHA256(session_token)` and persists the digest into the `sessions` table along with the `user_id` and an expiration timestamp (default: 7 days).
9. The server returns HTTP 200 and sets the session cookie `trame_session=<session_token>`.
10. The client web application opens the workspace and displays the assigned Actor Sheet immediately.

### 3.3 Email, Password & Identity Binding

#### 3.3.1 Argon2id Parameters
Passwords are hashed using Argon2id with parameters complying with OWASP guidelines:
- Memory Cost: 19,456 KiB (19 MiB).
- Iterations: 2.
- Parallelism: 1.
- Salt Length: 16 random bytes.
- Hash Length: 32 bytes.

#### 3.3.2 Identity Binding Workflow
A player authenticated via a Magic Link guest session can claim permanent account credentials without losing campaign history:
1. The client invokes `POST /api/v1/auth/bind-account` carrying an email and a password.
2. The server verifies that the existing session is valid and marked `is_guest = true`.
3. The server validates password entropy (minimum 10 characters, including digits and symbols).
4. The server checks that the target email does not exist in `users`.
5. The server generates salt and computes the Argon2id hash.
6. The server updates the user record: sets `email`, sets `password_hash`, and sets `is_guest = false`.
7. The server leaves existing campaign memberships, actor links, and session tokens unchanged.

### 3.4 Multi-Factor Authentication (TOTP MFA)

#### 3.4.1 Secret Generation & RFC 6238 Compliance
Campaign Administrators and Game Masters can activate TOTP MFA:
- Algorithm: HMAC-SHA1.
- Time Step: 30 seconds.
- Code Digits: 6 digits.
- Secret Length: 20 bytes (160 bits), Base32-encoded.

#### 3.4.2 Encryption at Rest
TOTP secrets MUST NOT be stored in plaintext. The server encrypts the secret using AES-256-GCM prior to database insertion:
- Key: Sourced from `MASTER_ENCRYPTION_KEY` environment variable (32-byte hex string).
- Nonce: 12 bytes randomly generated per encryption.
- Persisted Value: `<nonce_hex>:<ciphertext_and_tag_hex>` stored in `users.totp_encrypted_secret`.

During login, when `users.totp_enabled = true`, the server requires a second step verifying `POST /api/v1/auth/totp/verify` with the current TOTP code before issuing the session cookie.

### 3.5 OAuth2 Authentication (Discord & Google)

#### 3.5.1 OAuth2 Flow
TRAME supports external authorization via Discord and Google using authorization code grant with PKCE (Proof Key for Code Exchange, RFC 7636):
- Code Verifier: 32 bytes high-entropy cryptographic string.
- Code Challenge: `BASE64URL(SHA256(code_verifier))`.
- Redirection URL: `/api/v1/auth/oauth/:provider/callback`.

#### 3.5.2 Account Matching & Identity Binding
When the identity provider returns user identity:
1. The server extracts the provider unique account identifier (`provider_user_id`) and verified email address.
2. IF an active guest session exists on the incoming request, THEN the server links the OAuth identity to the guest user record via Identity Binding.
3. IF no session exists, the server checks `oauth_identities` for `(provider, provider_user_id)`:
   - IF found, the server logs in the user and creates a session cookie.
   - IF not found, the server creates a new user record and links the OAuth provider record.

### 3.6 Personal Access Tokens (PAT) for MCP Clients

#### 3.6.1 Token Format
Tokens used by programmatic automation and MCP clients follow the pattern:
```text
trame_pat_<40_character_base62_random_string>
```

#### 3.6.2 Storage & Validation
1. When the client creates a token via `POST /api/v1/auth/pat`, the server displays the plaintext token once.
2. The server computes `SHA256(token)` and persists the digest into `personal_access_tokens` table.
3. The table record stores `user_id`, `campaign_id` (optional scope), `scopes` array, `expires_at`, and `last_used_at`.
4. Incoming HTTP requests pass `Authorization: Bearer trame_pat_...`.
5. The server computes the SHA-256 digest of the incoming token and performs a constant-time comparison against persisted tokens.

---

## 4. Storage Architecture & `BlobStore` Abstraction

### 4.1 Trait Definition
All binary asset operations are decoupled from local filesystem storage through the `BlobStore` Rust trait:

```rust
use async_trait::async_trait;
use bytes::Bytes;
use futures_core::Stream;
use std::pin::Pin;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum BlobStoreError {
    #[error("Asset {0} not found")]
    NotFound(Uuid),
    #[error("Storage I/O failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("Object storage provider error: {0}")]
    Provider(String),
}

pub struct AssetDescriptor {
    pub id: Uuid,
    pub byte_size: u64,
    pub sha256_hex: String,
    pub mime_type: String,
}

#[async_trait]
pub trait BlobStore: Send + Sync + 'static {
    async fn get_descriptor(&self, id: Uuid) -> Result<AssetDescriptor, BlobStoreError>;
    
    async fn open_read_stream(
        &self,
        id: Uuid,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Bytes, BlobStoreError>> + Send>>, BlobStoreError>;
    
    async fn put_stream(
        &self,
        id: Uuid,
        byte_size: u64,
        mime_type: String,
        stream: Pin<Box<dyn Stream<Item = Result<Bytes, BlobStoreError>> + Send>>,
    ) -> Result<AssetDescriptor, BlobStoreError>;
    
    async fn delete(&self, id: Uuid) -> Result<(), BlobStoreError>;
    
    async fn list_descriptors(&self) -> Result<Vec<AssetDescriptor>, BlobStoreError>;
}
```

### 4.2 Storage Implementations
- `LocalFsStore`: Used in local Docker and development environments. Persists blobs under `DATA_DIR/assets/<uuid>.webp`. Atomic writes write to a temporary file before renaming.
- `S3Store`: Used for Cloudflare R2 and AWS S3 object storage. Implements chunked streaming uploads and downloads via AWS SDK for Rust with custom endpoint URLs.

---

## 5. Cloud Run Scale-to-Zero & Graceful Shutdown Sequence

### 5.1 Scale-to-Zero Configuration
Google Cloud Run hosts `trame-server` with `min-instances = 0` and `max-instances = 1`. When no active WebSocket connections or HTTP requests occur for 15 minutes, Cloud Run initiates instance teardown.

### 5.2 Graceful Shutdown Sequence
Upon preemption or idle teardown, Cloud Run delivers a `SIGTERM` signal to PID 1. `trame-server` manages shutdown using the following sequence:

```text
Cloud Run / Host OS
     │
     │  1. Sends SIGTERM
     ▼
crates/trame-server/src/main.rs (tokio::signal::unix)
     │
     │  2. Disables HTTP ingress for new WebSocket connections
     ▼
RoomLeaseManager::hibernate_all()
     │
     │  3. Iterates active TableRoomHandle instances
     ▼
TableRoomHandle::hibernate()
     │
     │  4. Broadcasts WS Close Code 1001 (Going Away)
     │  5. Flushes memory actor state to Neon Postgres via bounded timeout
     ▼
Database Connection Pool (sqlx::PgPool)
     │
     │  6. Closes connections cleanly
     ▼
Process exit(0)
```

1. The runtime receives `SIGINT` or `SIGTERM` via `tokio::signal::unix`.
2. The server sets an atomic shutdown flag `IS_SHUTTING_DOWN = true` to reject new room connection attempts.
3. The server calls `RoomLeaseManager::hibernate_all()`.
4. `RoomLeaseManager` commands all active `TableRoomHandle` actors to invoke `hibernate()`.
5. Each `TableRoomHandle` sends WebSocket Close frames (code 1001: Going Away) to all connected clients.
6. Each room serializes pending actor changes and writes snapshot rows to Neon Postgres within a timeout bound of 10 seconds enforced by `tokio::time::timeout`.
7. The server closes the `sqlx::PgPool` connection pool.
8. The process terminates with exit code 0.

### 5.3 Liveness and Readiness Probes (`/healthz`)
The server registers an unauthenticated endpoint at `GET /healthz`. The handler verifies database pool availability and immediately returns HTTP 200 with payload `{"status":"ok"}`. The probe executes within a benchmark CPU budget of under 5 milliseconds and does not acquire room locks or hydrate campaign records.

---

## 6. CLI Command-Line Interface (`crates/trame-cli`)

`trame-cli` provides administrative controls for campaign archives:

```text
trame-cli archive export --campaign <UUID> --output <PATH> [--server <URL>] [--token <TOKEN>]
trame-cli archive import --input <PATH> [--server <URL>] [--token <TOKEN>] [--remap-ids]
trame-cli archive inspect --input <PATH>
```

- `inspect`: Reads `manifest.json` from the ZIP file without unpacking database or assets, printing table stats and entry counts.
- `export`: Downloads the streamed `.trame` file from `GET /api/v1/campaigns/:id/export` or exports directly against a local database.
- `import`: Streams the file to `POST /api/v1/campaigns/import` or applies the transactions to a local database.

---

## 7. REST API Route Contracts

### 7.1 Archive Export
- **Endpoint**: `GET /api/v1/campaigns/:id/export`
- **Headers**: `Authorization: Bearer <token>` or valid session cookie.
- **Response 200**: Stream `application/zip` with `Content-Disposition: attachment; filename="campaign-<id>.trame"`.
- **Response 404**: `{"code":"CAMPAIGN_NOT_FOUND","message":"Campaign does not exist"}`.

### 7.2 Archive Import
- **Endpoint**: `POST /api/v1/campaigns/import?remap_ids=<bool>`
- **Headers**: `Content-Type: multipart/form-data` or raw `application/zip` stream.
- **Response 201 Created**:
```json
{
  "campaign_id": "b3a2a197-0f8a-4d76-9d62-1db7d995ff7a",
  "name": "Curse of the Obsidian Spire",
  "actors_restored": 12,
  "scenes_restored": 4,
  "notes_restored": 18,
  "assets_restored": 25
}
```
- **Response 409 Conflict** (if default mode and ID exists):
```json
{
  "code":"CAMPAIGN_ALREADY_EXISTS",
  "message":"Campaign ID b3a2a197-0f8a-4d76-9d62-1db7d995ff7a already exists. Pass remap_ids=true to clone."
}
```

### 7.3 Generate Invite Magic Link URL
- **Endpoint**: `POST /api/v1/campaigns/:id/invites`
- **Headers**: `Authorization: Bearer <token>` or session cookie (Admin/GM).
- **Request Body**:
```json
{
  "character_id": "550e8400-e29b-41d4-a716-446655440000",
  "role": "PLAYER",
  "ttl_seconds": 604800
}
```
- **Response 201 Created**:
```json
{
  "invite_url": "https://table.example.com/join?invite=eyJhbGciOi...",
  "token": "eyJhbGciOi...",
  "expires_at": "2025-05-25T14:32:00Z"
}
```

### 7.4 Consume Magic Link URL
- **Endpoint**: `POST /api/v1/auth/magic-link`
- **Request Body**:
```json
{
  "token": "eyJhbGciOi..."
}
```
- **Response 200 OK**:
- **Sets Cookie**: `trame_session=<session_token>; HttpOnly; Secure; SameSite=Lax; Path=/`
- **Body**:
```json
{
  "user_id": "8d9c1e74-3b2a-4c5d-9e8f-0a1b2c3d4e5f",
  "campaign_id": "b3a2a197-0f8a-4d76-9d62-1db7d995ff7a",
  "character_id": "550e8400-e29b-41d4-a716-446655440000",
  "role": "PLAYER"
}
```

### 7.5 Identity Binding (Guest Account Conversion)
- **Endpoint**: `POST /api/v1/auth/bind-account`
- **Headers**: Cookie `trame_session=<session_token>`
- **Request Body**:
```json
{
  "email": "gideon.player@example.com",
  "password": "CorrectHorseBatteryStaple123!"
}
```
- **Response 200 OK**:
```json
{
  "user_id": "8d9c1e74-3b2a-4c5d-9e8f-0a1b2c3d4e5f",
  "email": "gideon.player@example.com",
  "is_guest": false
}
```
- **Response 409 Conflict**: `{"code":"EMAIL_ALREADY_EXISTS","message":"Email is registered to another user"}`.

### 7.6 Personal Access Token Management
- **Endpoint**: `POST /api/v1/auth/pat`
- **Headers**: Cookie `trame_session=<session_token>`
- **Request Body**:
```json
{
  "name": "Cursor MCP Assistant",
  "campaign_id": "b3a2a197-0f8a-4d76-9d62-1db7d995ff7a",
  "scopes": ["campaign:read", "actor:write"],
  "expires_in_days": 30
}
```
- **Response 201 Created**:
```json
{
  "id": "12345678-90ab-cdef-1234-567890abcdef",
  "name": "Cursor MCP Assistant",
  "token": "trame_pat_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
  "expires_at": "2025-06-17T14:32:00Z"
}
```

### 7.7 TOTP MFA Setup & Verification
- **Setup Endpoint**: `POST /api/v1/auth/totp/setup`
- **Headers**: Cookie `trame_session=<session_token>`
- **Response 200 OK**:
```json
{
  "secret_base32": "JBSWY3DPEHPK3PXP",
  "otpauth_url": "otpauth://totp/TRAME:admin@example.com?secret=JBSWY3DPEHPK3PXP&issuer=TRAME"
}
```
- **Enable Endpoint**: `POST /api/v1/auth/totp/enable`
- **Request Body**:
```json
{
  "code": "123456"
}
```
- **Response 200 OK**: `{"status":"enabled"}`.

---

## 8. Deployment Manifests & Infrastructure as Code

### 8.1 Environment Variables Matrix

| Variable Name | Required | Description | Example Value |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Yes | Postgres connection string | `postgres://user:pass@ep-cool-db.us-east-2.aws.neon.tech/neondb?sslmode=require` |
| `JWT_SECRET` | Yes | Secret for signing auth tokens | `64_character_hex_string` |
| `MASTER_ENCRYPTION_KEY` | Yes | 32-byte hex key for AES-256-GCM TOTP secrets | `32_byte_hex_string` |
| `STORAGE_BACKEND` | Yes | Storage engine selector | `s3` or `local` |
| `S3_ENDPOINT` | For `s3` | S3 / R2 API URL | `https://<account_id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | For `s3` | Destination bucket | `trame-campaign-assets` |
| `S3_ACCESS_KEY_ID` | For `s3` | Access credentials | `r2_access_key` |
| `S3_SECRET_ACCESS_KEY` | For `s3` | Secret credentials | `r2_secret_key` |
| `OAUTH_DISCORD_CLIENT_ID` | Optional | Discord OAuth Client ID | `123456789012345678` |
| `OAUTH_DISCORD_CLIENT_SECRET` | Optional | Discord OAuth Secret | `discord_secret_token` |
| `OAUTH_GOOGLE_CLIENT_ID` | Optional | Google OAuth Client ID | `client-id.apps.googleusercontent.com` |
| `OAUTH_GOOGLE_CLIENT_SECRET` | Optional | Google OAuth Secret | `GOCSPX-secret` |

### 8.2 Google Cloud Run Terraform (`deploy/terraform/cloud_run.tf`)

```hcl
resource "google_cloud_run_v2_service" "trame_server" {
  name     = "trame-server"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.container_image
      
      resources {
        limits = {
          cpu    = "1000m"
          memory = "256Mi"
        }
      }

      env {
        name  = "STORAGE_BACKEND"
        value = "s3"
      }
      env {
        name  = "S3_ENDPOINT"
        value = var.s3_endpoint
      }
      env {
        name  = "S3_BUCKET"
        value = var.s3_bucket
      }
      
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MASTER_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.master_key.secret_id
            version = "latest"
          }
        }
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        initial_delay_seconds = 2
        period_seconds        = 15
        timeout_seconds       = 3
        failure_threshold     = 3
      }
    }
  }
}
```

### 8.3 Google Cloud Run Service Specification (`deploy/cloudrun/service.yaml`)

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: trame-server
  annotations:
    run.googleapis.com/ingress: all
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "0"
        autoscaling.knative.dev/maxScale: "1"
        run.googleapis.com/cpu-throttling: "true"
    spec:
      containerConcurrency: 80
      timeoutSeconds: 900
      containers:
      - image: gcr.io/trame-vtt/trame-server:latest
        ports:
        - name: http1
          containerPort: 8080
        resources:
          limits:
            cpu: "1000m"
            memory: "256Mi"
        env:
        - name: STORAGE_BACKEND
          value: "s3"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: DATABASE_URL
              key: latest
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: JWT_SECRET
              key: latest
        - name: MASTER_ENCRYPTION_KEY
          valueFrom:
            secretKeyRef:
              name: MASTER_ENCRYPTION_KEY
              key: latest
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 2
          periodSeconds: 15
```

### 8.4 Production Docker Compose for `e2-micro` (`deploy/compose/docker-compose.prod.yml`)

```yaml
services:
  trame-server:
    image: ghcr.io/hartorn-inc/trame-server:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://trame:${POSTGRES_PASSWORD}@postgres:5432/trame?sslmode=disable
      - JWT_SECRET=${JWT_SECRET}
      - MASTER_ENCRYPTION_KEY=${MASTER_ENCRYPTION_KEY}
      - STORAGE_BACKEND=local
      - DATA_DIR=/var/lib/trame/data
    volumes:
      - trame_data:/var/lib/trame/data
    depends_on:
      postgres:
        condition: service_healthy
    stop_grace_period: 15s
    deploy:
      resources:
        limits:
          memory: 256M

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=trame
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=trame
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U trame -d trame"]
      interval: 5s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 256M

volumes:
  trame_data:
  pg_data:
```

---

## 9. Architectural Invariants & Non-Functional Requirements

### 9.1 Memory Bounds
- `ArchiveExporter` and `ArchiveImporter` must not allocate more than 16 MiB of heap memory during export or import execution regardless of archive size.
- Chunked stream buffers for assets and JSONL lines are capped at 64 KiB per buffer.

### 9.2 Cryptographic Rigor
- All passwords utilize Argon2id (19 MiB memory cost, 2 iterations, 1 parallelism thread).
- TOTP secrets are encrypted at rest with AES-256-GCM using `MASTER_ENCRYPTION_KEY`.
- Personal Access Tokens are stored only as SHA-256 digests.
- Session tokens are stored only as SHA-256 digests.

### 9.3 Zero-Loss Roundtrip Invariant
Exporting a campaign to a `.trame` archive and restoring it into a clean instance restores:
1. Bit-for-bit exactness for all WebP assets.
2. Referential equality for all actor IDs, scene IDs, wall coordinates, and note identifiers.
3. Exact content parity across CommonMark files and frontmatter dictionaries.

### 9.4 Remapping Invariant
When importing with `--remap-ids`:
1. No UUID collision occurs with pre-existing records.
2. All scene references in tokens are updated to the mapped scene UUID.
3. All actor references in tokens and notes are updated to the mapped actor UUID.
4. Both raw wikilinks `[[<old_uuid>]]` and aliased wikilinks `[[<old_uuid>|<label>]]` are updated to `[[<new_uuid>]]` and `[[<new_uuid>|<label>]]` respectively.

### 9.5 Shutdown Invariant
- Upon receiving `SIGTERM`, `TableRoomHandle::hibernate()` flushes snapshots to storage within a bounded timeout channel of 10 seconds.
- The shutdown sequence completes with exit code 0 before the host platform sends `SIGKILL`.

---

## 10. Verification Plan & Test Strategy

### 10.1 Unit Tests
- `test_argon2id_hash_and_verify`: Verifies correct password verification and rejection of malformed hashes.
- `test_totp_rfc6238_encryption`: Tests AES-256-GCM encryption/decryption of TOTP secrets with `MASTER_ENCRYPTION_KEY`.
- `test_pat_sha256_generation_and_lookup`: Validates token formatting (`trame_pat_...`) and constant-time digest comparison.
- `test_markdown_link_remapping_regex`: Validates regex rewriting of `[[<uuid>]]` and `[[<uuid>|Label]]` across edge cases.

### 10.2 Integration Tests (Roundtrip Parity)
- `test_campaign_export_import_roundtrip`:
  1. Seeds database with 1 Campaign, 4 Scenes, 20 Walls, 5 Actors, 8 Notes with wikilinks, and 3 WebP assets in `LocalFsStore`.
  2. Calls `ArchiveExporter::export_stream()` to generate `.trame` byte stream.
  3. Purges the database and local asset store.
  4. Calls `ArchiveImporter::import_stream()` with `remap_ids = false`.
  5. Asserts identical entity attributes, coordinates, notes, and asset bit parity.

- `test_campaign_import_remap_ids_cloning`:
  1. Exports an existing campaign.
  2. Imports the `.trame` file on the same instance with `remap_ids = true`.
  3. Asserts both campaigns exist simultaneously.
  4. Verifies all tokens point to valid new scenes and actors.
  5. Verifies all wikilinks in notes resolve to new valid actors and scenes.

- `test_archive_importer_rejects_corrupted_sha256`:
  1. Modifies 1 byte of an asset in the ZIP archive.
  2. Asserts `ArchiveImporter` aborts with `ERR_ARCHIVE_CHECKSUM_MISMATCH` and commits no database changes.

### 10.3 Authentication Tests
- `test_magic_link_guest_to_registered_binding`:
  1. Generates invite JWT.
  2. Consumes JWT via `/api/v1/auth/magic-link`, obtaining guest cookie.
  3. Invokes `/api/v1/auth/bind-account` with email and password.
  4. Verifies user transitions to permanent account while retaining actor association.
- `test_totp_mfa_flow`:
  1. Generates TOTP secret.
  2. Encrypts and persists secret.
  3. Generates valid and expired RFC 6238 codes and asserts verification pass/fail.

### 10.4 Graceful Shutdown Tests
- `test_graceful_shutdown_room_hibernation`:
  1. Initializes a `TableRoomHandle` with uncommitted actor modifications.
  2. Simulates `SIGTERM` trigger.
  3. Verifies `RoomLeaseManager::hibernate_all()` writes snapshots to the database mock within the timeout.
  4. Verifies WebSocket clients receive Close code 1001.
