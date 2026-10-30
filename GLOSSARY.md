<!-- EPURE GLOSSARY -->
# GLOSSARY

## Terms

### Actor
* Definition: An entity in the game world that possesses attributes, inventory, notes, and visual representations. The server persists actors in the database and streams actor state changes to connected clients.
* Avoid: character, entity, mob, NPC.

### Archive
* Definition: A compressed ZIP container file with the `.trame` extension. The file packages `manifest.json`, `database.jsonl`, notes in Markdown format, and assets in WebP format for campaign portability.
* Avoid: package, bundle, zip file, export file.

### Asset
* Definition: A binary media file stored in WebP format within the BlobStore or within the `assets/` directory of an Archive.
* Avoid: image, picture, texture, media file.

### BlobStore
* Definition: The storage abstraction trait that manages binary asset persistence across local filesystem storage (`LocalFsStore`) and cloud object storage (`S3Store`).
* Avoid: object storage, bucket, file store.

### Campaign
* Definition: The top-level administrative and organizational unit in TRAME that groups tables, scenes, actors, assets, notes, and user permissions.
* Avoid: game, world, adventure, module.

### Graceful Shutdown Sequence
* Definition: The deterministic termination procedure executed by `trame-server` upon receipt of a `SIGTERM` signal. The sequence terminates WebSocket loops, commits memory snapshots to persistent storage via `TableRoomHandle::hibernate()`, and closes database pools.
* Avoid: graceful hibernation sequence, server stop, quick shutdown.

### Identity Binding
* Definition: The cryptographic process that associates an existing guest player session record with a persistent credential record (Argon2id password hash or OAuth2 identity provider identifier) without altering the user identifier or character assignments.
* Avoid: account link, account linking, account merge, bind.

### Magic Link URL
* Definition: A single-use or scoped Uniform Resource Locator containing a signed JSON Web Token in the query parameter `?invite=<jwt>` that authenticates a player directly into an assigned Actor Sheet without preliminary credential registration.
* Avoid: invite link, magic URL, invite token, login link.

### Manifest
* Definition: The JSON file named `manifest.json` located at the root of an Archive. The file specifies format version, export timestamp, campaign metadata, and cryptographic SHA-256 digests for all archive entries.
* Avoid: header, descriptor, index.

### Personal Access Token
* Definition: A cryptographically random authentication token prefixed with `trame_pat_` that grants programmatic API and Model Context Protocol access scoped to specific campaign boundaries.
* Avoid: API key, bearer token, PAT.

### Room Lease
* Definition: A time-bounded memory lease managed by `RoomLeaseManager` that keeps active campaign table rooms hydrated in memory during client activity and triggers room hibernation after 15 minutes of inactivity.
* Avoid: session lease, table lease, idle timer.

### Table Room
* Definition: The in-memory actor synchronization unit managed by `TableRoomHandle` that coordinates real-time WebSocket state distribution for a single active campaign table.
* Avoid: game room, channel, table session.

### TOTP Secret
* Definition: A 160-bit shared secret key used for Time-based One-Time Password multi-factor authentication (RFC 6238). The server encrypts the secret at rest using AES-256-GCM before database insertion.
* Avoid: MFA key, 2FA secret, auth code.
