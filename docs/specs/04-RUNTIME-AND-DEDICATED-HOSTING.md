# TRAME — Phase 4: Real-Time Architecture (Command Handler, In-Memory Actors) & Dedicated Hosting

This document specifies the internal runtime architecture of the Rust server (`trame-server`), the **Command Handler + Reversible Event Log** pattern, zero-loss write-ahead logging (WAL), the WebSocket protocol, authentication, and the **On-Demand Dedicated Hosting** model (1 multi-campaign Micro-Instance + 1 dedicated Neon Serverless Postgres database + Cloudflare R2).

---

## 1. Core Pattern: Command Handler + Reversible Event Log

Every state mutation in TRAME — whether originating from a click on the PixiJS Canvas, a React character sheet edit, a REST request, or an MCP tool call — flows through a single unified **Command Dispatcher**.

```mermaid
sequenceDiagram
    participant Client as Client (WebSocket UI / HTTP / MCP Tool)
    participant Auth as Auth & RBAC Guard
    participant Dispatcher as CommandHandler (Rust)
    participant Actor as TableRoomActor (RAM)
    participant Engine as trame-engine (Rules & Raycasting)
    participant DB as Write-Behind + WAL (Neon Postgres)

    Client->>Auth: Sends `TrameCommand` + User Context
    Auth->>Dispatcher: `AuthenticatedCommand { user_id, role, cmd }`
    Dispatcher->>Actor: Routes to Campaign Actor
    Actor->>Engine: Validates rules + collisions + computes visibility (< 1ms)
    Engine-->>Actor: `StateTransition { new_state, events, undo_patch }`
    Actor->>Actor: Pushes `undo_patch` onto DM history stack
    Actor-->>Client: Broadcasts per-player filtered `TrameEvent` (WebSocket)
    Actor-)DB: Logs WAL & enqueues mutation in async write-behind buffer
```

### 1.1 Rust Structure of `TrameCommand` and Automatic MCP Generation

Every command is a strongly typed enum variant annotated with `serde` and `schemars::JsonSchema`. The MCP server reads these schemas directly at compile time to expose MCP `Tools` with zero code duplication:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "domain", content = "action", rename_all = "snake_case")]
pub enum TrameCommand {
    Table(TableCommand),       // MoveToken, InteractDoor, PlaceAoE, SetLightingPreset, SetMode...
    Combat(CombatCommand),     // StartCombat, RollInitiative, SpendActionEconomy, NextTurn...
    Actor(ActorCommand),       // UpdateSheet, EquipItem, TransformShape, CastSpell, TakeRest...
    Map(MapCommand),           // CreateMap, ImportUvtt, SetWalls, SetLights, EditFog, SpawnTokens...
    Note(NoteCommand),         // UpsertNote, RevealHandout, SyncBatch...
    History(HistoryCommand),   // UndoLastAction { action_id }, RedoAction
}
```

### 1.2 Native DM `Undo / Redo` Management (`ReversiblePatch`)

When a `CommandHandler` executes a command on the Table, it returns a `CommandOutcome` struct:

```rust
pub struct CommandOutcome {
    pub events: Vec<TrameEvent>,
    pub undo_entry: Option<UndoEntry>,
}

pub struct UndoEntry {
    pub action_id: Uuid,
    pub actor_user_id: Uuid,
    pub summary: String,               // e.g., "Moved Thorin (6 cells) + Revealed fog"
    pub inverse_ops: Vec<StatePatch>,  // Restores x/y, refunds 30ft movement, restores exploration mask
}
```

* The `TableRoomActor` maintains a circular in-memory stack of the **last 100 actions** of the session.
* When the DM clicks **"Undo"** (or calls `table.undo_last_action` via MCP), the actor applies `inverse_ops` in $< 1\text{ ms}$, restores the fog mask from before the erroneous move, and broadcasts the corrected state to all players.

---

## 2. The `TableRoomActor`: In-Memory Real-Time State & Zero-Loss Guarantee (Q9)

### 2.1 In-Memory Execution, `Write-Behind` Persistence & Critical `Immediate Commit`

1. **Hot Loading (`Hydration`)**:
   * As soon as the first member (or MCP agent) opens a campaign, `trame-server` instantiates a `TableRoomActor`, loads the active map, its walls (building the spatial BVH in $< 2\text{ ms}$), its tokens, and the actor sheets from Neon Postgres.
2. **Two Persistence Tiers (High-Frequency vs. Critical)**:
   * **High-Frequency Mutations (`Write-Behind Batching — 1s`)**: Token drags, LZ4 fog mask updates, and continuous adjustments are batched and written to Neon every **1 second**.
   * **Critical Mutations (`Immediate Commit` + `command_wal` Event Log)**: Final dice rolls, HP losses, spell slot expenditures, inventory transfers, turn changes, and note edits are **written immediately** to a lightweight append-only table (`command_wal`) on Neon and acknowledged to the client.
3. **Graceful Shutdown & Client Resynchronization (`last_acked_seq`)**:
   * Every event sent by the server carries a monotonic sequence number `seq: u64`.
   * Upon receiving a `SIGTERM` signal (e.g., Cloud Run scaling down an instance), the server blocks new incoming commands and **flushes all in-memory actors to Neon in $< 150\text{ ms}$** before exiting.
   * Even in the event of an abrupt container crash, a reconnecting client resends any unacknowledged commands (`seq > server_seq`), guaranteeing **zero lost actions**.

### 2.2 Cryptographic Dice Roll Security (`Server-Side CSPRNG` — Q14)

* **No dice roll is ever generated by the client browser.**
* The client-side WASM formula evaluator is used strictly to **validate syntax** (`2d20kh1 + 5`) and preview modifiers before rolling.
* Actual random number generation executes **exclusively on the Rust server** via a cryptographically secure pseudorandom number generator (`ChaCha20Rng` seeded by OS entropy), signed and timestamped in the session log.

### 2.3 Resetting & Managing Exploration Fog (Q15)

* When a DM reuses a map (or guards patrol after the players leave), the DM has **3 tools for resetting Exploration Memory (`Explored Memory`)**:
  1. **Exploration Memory Eraser (Brush / Polygon)**: Clears the grayed-out memory of a specific room (players must re-enter to see what changed).
  2. **Per-Player or Party Reset (1 Click)**: Resets exploration memory across the entire map.
  3. **"No Exploration Memory" Mode (*Hardcore / Shifting Labyrinth*)**: Per-map setting where only the active field of view is visible; everything outside the current line of sight immediately returns to pitch black.

---

## 3. Authentication, Media Security & Full Portability

### 3.1 Frictionless Authentication & Onboarding

1. **Direct Campaign Invite Link + Magic Link / Argon2id**.
2. **Optional OAuth2 / OIDC (Discord & Google)**.
3. **Administrator / DM Security (TOTP MFA) & Personal Access Tokens (`trame_pat_...`)** scoped by role and campaign for the MCP server.

### 3.2 Map Access Security on Cloudflare R2 / S3 (DM Anti-Leak — Q10)

To prevent a curious player from guessing a map URL or downloading the high-resolution image of a dungeon containing secret rooms before entering it:

1. **Unguessable Opaque Object Keys**: Every file on R2/S3 is stored under a random `UUIDv4` identifier (`instances/{instance_id}/maps/{random_uuid}.webp`) with no human-readable filename.
2. **Short-Lived Presigned URLs (`Presigned URLs — 15 min TTL`) Generated After RBAC Verification**:
   * The R2/S3 bucket is **100% private** (zero direct public access).
   * `trame-server` generates a signed URL for a map or handout only if the player is currently on that map (or the handout has `revealed = true`).
3. **Player Layer vs. DM Layer Separation (Zero Secrets Baked into Background Image)**:
   * During `.uvtt` import or map creation, secret DM annotations (room numbers, traps, secret passages) are placed on the `DM_ONLY` vector layer (never sent to players), while the WebP image delivered to the browser contains only the bare graphical scenery.

### 3.3 Portability & Backup: Open `.trame` Archive Format (Q11)

To guarantee complete reversibility between **Dedicated Cloud (Cloud Run + Neon + R2)** and **Local Self-Hosting (Docker / `e2-micro` VM / NAS)**:

* The administration UI (and the `trame-cli archive export` CLI command) allows exporting **a Campaign** or **the entire Instance** at any time as a standard **`.trame` archive (AES-256-GCM encryptable ZIP)** containing:
  1. `manifest.json` (format version, metadata, SHA-256 checksums),
  2. `systems/` (all declarative YAML/JSON `GameSystemPack` files used),
  3. `data/` (all actors, maps, walls, lights, tokens, and session logs in clean, SQL-agnostic JSONL),
  4. `notes/` (the complete directory tree of Wiki Markdown files with YAML frontmatter, directly openable in any standard Markdown knowledge base),
  5. `assets/` (all WebP images and audio tracks).
* Importing a `.trame` file into any other TRAME instance restores 100% of the campaign in seconds.

---

## 4. On-Demand Dedicated Hosting: Cloud Run vs. `e2-micro` VM

### 4.1 Target Model: 1 Dedicated Micro-Instance = 1 Multi-Campaign Group Server

* **1 `trame-server` container / binary** (~20–35 MB RAM).
* **1 dedicated Neon Serverless Postgres database** (via PgBouncer pooler `:6543`).
* **1 private prefix on Cloudflare R2 / S3** or local volume.

### 4.2 `Scale-to-Zero` & `Idle-Lease` Lifecycle ($0 at Rest on Cloud Run + Neon)

* Network heartbeats/pings do not reset the inactivity timer.
* After **15 minutes without human action** (or 5 minutes if all browser tabs are in the background), `trame-server` flushes its in-memory state to Neon, sends `HIBERNATING` to clients, and closes WebSockets $\rightarrow$ Cloud Run and Neon scale down to **0 CPU / $0**.
* Upon the slightest player click or MCP call, the instance wakes up in **~25 ms** (Rust) + **~300 ms** (Neon) and resumes the session seamlessly.

---

## 5. Responsive Tablet / Mobile UX & Accessibility (Q21, Q22)

1. **Player Companion Mode on Tablet & Mobile (`Companion Mode`)**:
   * On iPad / tablet: full touch navigation on the PixiJS map (*pinch-to-zoom*, *two-finger pan*, long press to ping/measure).
   * On smartphone (or around a physical table with a central TV screen): automatic or manual switch to an ultra-fast **Mobile Companion View** displaying the **D&D 5e Character Sheet**, **Dice Roller**, **Inventory**, **Initiative Tracker**, and **Notes**, synchronized in real time with the main Table.
2. **Themes, WCAG AA Contrast & Visual Comfort**:
   * Semantic CSS token system supporting dark/light/parchment themes, colorblind mode on tactical rings and AoE templates (hatched patterns in addition to green/yellow/red colors), and compliance with `prefers-reduced-motion` (disabling screen shake and weather/light animations).
