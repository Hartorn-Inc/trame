# TRAME — Phase 4: Real-Time Architecture (Command Handler, In-Memory Actors) & Dedicated Hosting

This document specifies the internal execution architecture of the Rust server (`trame-server`), the **command handler + undo ring** pattern, zero-loss resilience (WAL), the WebSocket protocol, authentication, and the **on-demand dedicated hosting** model (1 multi-campaign micro-instance + 1 dedicated Neon Serverless Postgres database + Cloudflare R2).

---

## 1. Core Pattern: Command Handler + Undo Ring

Every tactical state mutation in TRAME — whether it comes from a click on the PixiJS canvas, a REST request or an MCP tool call — goes through a single **command dispatcher** (`TableState::apply_command`). Persistent `Actor` sheet edits are the exception: they go through REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}` with `expected_version` and never push an `UndoEntry` (ADR-0037).

```mermaid
sequenceDiagram
    participant Client as Client (WebSocket UI / HTTP / MCP tool)
    participant Auth as Auth & RBAC guard
    participant Actor as TableRoomActor (RAM)
    participant Engine as trame-engine (rules & raycasting)
    participant DB as Write-behind + WAL (Postgres)

    Client->>Auth: Sends `TrameCommand` + user context
    Auth->>Actor: `CommandActor { user_id, role }` + command, routed to the campaign room
    Actor->>Engine: `TableState::apply_command` validates rules + collisions + visibility (< 1 ms)
    Engine->>Engine: Pushes the pre-mutation `UndoEntry` onto the 50-entry ring
    Engine-->>Actor: `Vec<TrameEvent>`
    Actor-->>Client: Broadcasts `TrameEvent` filtered per recipient (WebSocket)
    Actor-)DB: Writes the WAL & queues the mutation in the async buffer
```

### 1.1 `TrameCommand` Rust Structure & MCP Generation

Every command is a variant of a strongly typed, internally tagged enum in `crates/trame-engine/src/commands.rs`. The MCP server generates its tool input schemas from this enum, so the MCP tools never duplicate the command definitions:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrameCommand {
    MoveToken { token_id: Uuid, to_top_left: Point2D, to_elevation_ft: Option<f64>, gm_teleport: bool },
    ToggleDoor { wall_id: Uuid, is_open: bool },
    SetTableMode { mode: TableMode, exploration_paused: bool, initiative_order: Vec<Uuid> },
    StartTurnByTurn { initiative_order: Vec<Uuid> },
    AdvanceTurn,
    ApplyDamage { token_id: Uuid, raw_damage: i32, affinity: DamageAffinity },
    ProjectAoe { template: AoeTemplate, persist_zone: bool },
    SetAmbientLighting { preset: AmbientLightingPreset },
    DecideReaction { prompt_id: Uuid, actor_id: Uuid, decision: ReactionDecision },
    CommitMcpStaging { proposal_id: Uuid },
    UndoLastAction,
    // ... see commands.rs for the full list
}
```

### 1.2 Native GM Undo (`UndoEntry`)

Before a tactical command mutates the table, and only after its RBAC, collision and movement-budget checks pass, the engine captures an `UndoEntry`:

```rust
pub struct UndoEntry {
    /// Human-readable label, e.g. "Move Thorin (6 cells) + fog reveal".
    pub description: String,
    /// Full tabletop state captured before the mutation.
    pub snapshot: TableSnapshotData,
}
```

* The table keeps a ring buffer of the **last 50 entries** (`MAX_UNDO_HISTORY = 50`) per map, in memory.
* When the GM clicks **"Undo"** (`UndoLastAction`, or the MCP tool `table.undo_last_action`), the actor restores the snapshot in $< 1\text{ ms}$ (including the fog mask from before the mistaken move) and broadcasts the corrected state to every player.
* A committed MCP batch (`mcp.execute_batch` or `CommitMcpStaging`) produces one composite `UndoEntry`, so one undo reverts the whole batch.

---

## 2. The `TableRoomActor`: In-Memory Real-Time State & Zero-Loss Guarantee (Q9)

### 2.1 In-Memory Execution, `Write-Behind` Persistence & Critical `Immediate Commit`

1. **Hot loading (`Hydration`)**:
   * As soon as the first member (or MCP agent) opens a campaign, `trame-server` starts a `TableRoomActor` and loads the active map, its walls (building the spatial BVH in $< 2\text{ ms}$), its tokens and the actor sheets from Postgres (`SqlxPostgresStore`).
2. **Two persistence levels (high frequency vs critical)**:
   * **High-frequency mutations (`Write-Behind Batching — 1 s`)**: token drags, LZ4 fog mask updates and continuous adjustments are grouped and written to Postgres **every second**.
   * **Critical mutations (`Immediate Commit` + `command_wal` event log)**: final dice rolls, HP losses, spell slot spending, inventory transfers, turn changes and note edits are **written immediately** to a lightweight append-only table (`command_wal`) and acknowledged to the client. Save errors are propagated, never ignored.
3. **Graceful shutdown & client resync (`last_acked_seq`)**:
   * Every event sent by the server carries a monotonic sequence number `seq: u64`.
   * On `SIGTERM` (for example Cloud Run stopping an instance), the server stops accepting new input and **flushes every in-memory actor to Postgres in $< 150\text{ ms}$** before exiting (ADR-0005).
   * Even if the container crashes, the reconnected client resends any unacknowledged commands (`seq > server_seq`), guaranteeing **zero lost actions**.

### 2.2 Cryptographic Dice Security (`Server-Side CSPRNG` — Q14)

* **No die is ever rolled by the client browser.**
* The client-side WASM formula evaluator only **validates syntax** (`2d20kh1 + 5`) and shows a preview of the modifiers before the roll.
* The actual random draw runs **only on the Rust server** with a cryptographically secure generator (`ChaCha20Rng` seeded from OS entropy), timestamped in the session log. Dice expressions have a bounded length and term count and use checked arithmetic.
* Table rolls use the WebSocket `RollDice` command. Sheet-driven rolls use REST `POST /api/v1/campaigns/{id}/dice/roll`, which works while the room is hibernated and is appended to the table log when the room is awake.

### 2.3 Exploration Fog Reset & Management (Q15)

* When a GM reuses a map (or guards patrol after the players leave), they have **3 tools to reset explored memory (`Explored Memory`)**:
  1. **Explored memory eraser (brush / polygon)**: erases the greyed memory of a specific room (players must enter it again to see what changed).
  2. **Per-player or per-party reset (1 click)**: resets the explored memory of the whole map.
  3. **"No explored memory" mode (*Hardcore / shifting labyrinth*)**: a per-map option where only the active field of view is visible; everything that leaves line of sight turns black again.

---

## 3. Authentication, Media Security & Full Portability

### 3.1 Frictionless Authentication & Onboarding

1. **Invite-only accounts ([ADR-0039](../adr/0039-invite-only-registration-and-instance-role.md)) + Argon2id passwords**. The first `Owner` claims the instance through a one-time setup URL logged at startup. Players join through a bounded `CampaignInvite` link (`?invite=<token>`) minted only by the campaign's GM (`POST /api/v1/campaigns/{id}/invites`); `InviteRedemption` creates a `Member` account. Campaign permissions come from campaign membership (`UserRole`); the `InstanceRole` only decides who may create campaigns and administer accounts.
2. **Optional OAuth2 / OIDC (Discord & Google)**.
3. **Administrator / GM security (TOTP MFA) & Personal Access Tokens (`trame_pat_...`)** scoped by role and campaign for the MCP server.

### 3.2 Map Access Security on Cloudflare R2 / S3 (GM Anti-Leak — Q10)

To stop a curious player from guessing a map URL or downloading the high-resolution image of a dungeon with secret rooms before entering it:

1. **Opaque, unguessable object keys**: every file on R2/S3 is stored under a random `UUIDv4` identifier (`instances/{instance_id}/maps/{random_uuid}.webp`) with no readable file name.
2. **Short presigned URLs (`SignedDirectDownload`, TTL 5 min) generated after the RBAC check**:
   * The R2/S3 bucket is **100% private** (no direct public access).
   * `trame-server` generates a signed URL for a map or handout only if the player is a member of the campaign and is currently on that map (or the handout has `revealed = true`).
3. **Player layer vs GM layer separation (no secrets in the background image)**:
   * On `.uvtt` import or map creation, the GM's secret annotations (room numbers, traps, secret passages) are placed on the `DM_ONLY` vector layer (never sent to players), while the WebP image sent to the browser contains only the bare artwork.

### 3.3 Portability & Backup: the Open `.trame` Format (Q11)

To guarantee full reversibility between **dedicated cloud (Cloud Run + Neon + R2)** and **local self-hosting (Docker / `e2-micro` VM / NAS)**:

* The administration interface (and the CLI command `trame-cli archive export`) can export **one campaign** or **the whole instance** at any time as a standard **`.trame` archive (ZIP, optionally AES-256-GCM encrypted)** containing:
  1. `manifest.json` (format version, metadata, SHA-256 checksums),
  2. `systems/` (every `GameSystemPack` YAML/JSON in use),
  3. `data/` (every actor, map, wall, light, token and session log as clean JSONL independent of the SQL engine),
  4. `notes/` (the full tree of wiki Markdown files with their YAML frontmatter, directly openable in **Obsidian**),
  5. `assets/` (every WebP image and audio track).
* An export contains only the exported campaign's data. Importing a `.trame` file on any other TRAME instance always creates a **new campaign owned by the importer**, with every ID rewritten and with total and per-entry uncompressed size caps (zip-bomb protection); it never overwrites an existing campaign.

---

## 4. On-Demand Dedicated Hosting: Cloud Run vs `e2-micro` VM

The delivered hosting targets are documented in the operator guides: [Cloud Run + Neon + R2 with Terraform](../../deploy/terraform/README.md) and [Docker Compose on one machine](../../deploy/compose/README.md) (an Oracle Cloud Always Free VM replaces the `e2-micro` VM), with a shared [backup and restore runbook](../../deploy/backup-and-restore.md) ([ADR-0041](../adr/0041-s3-asset-storage-signed-downloads-and-free-hosting.md)).

### 4.1 Target Model: 1 Dedicated Micro-Instance = 1 Multi-Campaign Group Server

* **1 `trame-server` container / binary** (~20–35 MB RAM) serving the SPA, the API and the WebSocket on port `8080`.
* **1 dedicated Neon Serverless Postgres database** through its direct endpoint. The PgBouncer pooled endpoint does not work: the server sets `statement_timeout` at connect time.
* **1 private S3-compatible bucket** (Cloudflare R2 or Silo), or asset bytes kept in PostgreSQL.

### 4.2 `Scale-to-Zero` Lifecycle & `Idle-Lease` (€0 at rest on Cloud Run + Neon)

* Network *pings* do not reset the inactivity counter (`Idle-Lease`).
* After **15 minutes without human action** (or 5 minutes if every tab is in the background), a background sweeper makes `trame-server` flush its in-memory state to Postgres, send `HIBERNATING` to the clients and close the WebSockets → Cloud Run and Neon drop back to **0 CPU / €0**.
* On the next player click or MCP call, the instance wakes up in **~25 ms** (Rust) + **~300 ms** (Neon) and resumes the session seamlessly.

---

## 5. Responsive Tablet / Mobile UX & Accessibility (Q21, Q22)

1. **Player companion mode on tablet & mobile (`MobileCompanionView`)**:
   * On iPad / tablets: full touch navigation on the PixiJS map (*pinch-to-zoom*, *two-finger pan*, long press to ping/measure).
   * On smartphones (or around a physical table with a central TV screen): automatic or manual switch to a fast **mobile companion view** showing the **D&D 5e character sheet**, the **dice roller**, the **inventory**, the **initiative tracker** and the **notes**, synchronized in real time with the main table.
2. **Themes, WCAG AA contrast & visual comfort**:
   * A semantic CSS token system supporting dark/light/parchment themes, a color-blind mode on tactical rings and AoE templates (hatched patterns in addition to green/yellow/red), and support for `prefers-reduced-motion` (no screen shake and no weather/light animations).
