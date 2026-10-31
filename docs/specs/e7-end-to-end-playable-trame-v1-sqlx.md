# End-to-End Playable TRAME V1: SqlxPostgresStore, Complete HTTP/WS Surface, and Preact + PixiJS v8 Client

## 1. Overview & Business Goals

This specification defines the architecture, database schema, network protocols, user interface components, and verification suite for the End-to-End Playable TRAME V1 milestone. The system enables a Game Master and Players to authenticate, create campaigns, import maps, manipulate Actor tokens, execute game rules with line-of-sight lighting, and track combat turns end-to-end in the browser.

### Primary Deliverables
1. **PostgreSQL 18 Persistence Engine (`SqlxPostgresStore`)**: Production-ready schema migration, connection pool lifecycle, and storage trait implementations for campaigns, write-ahead logs, actors, notes, journals, timelines, and assets, with dynamic fallback to in-memory fixtures when `DATABASE_URL` is omitted.
2. **Unified Axum HTTP & WebSocket Surface**: Complete REST endpoints for authentication, campaign management, actor updates, 1-click starter dungeon seeding, `.uvtt` battlemap ingestion, role-filtered notes, handout reveals, presigned asset downloads, and authenticated MessagePack WebSocket upgrades.
3. **Reactive Preact Client with Signals (`PreactSignalState`)**: State layer driving UI rendering without Virtual DOM diffing bottlenecks, accompanied by authentication screens, campaign lobby, and invitation workflows.
4. **Interactive PixiJS v8 Tabletop Canvas (`TableCanvas`)**: Hardware-accelerated 2.5D rendering surface with `WasmSpatialEngine` raycasting (falling back to pure TypeScript `Bvh2D`), dynamic line-of-sight fog-of-war, token drag-and-drop, interactive doors, area-of-effect previews, elevation rulers, radar pings, and a deterministic headless canvas mock for continuous integration.
5. **Tabletop HUD Drawers & Mobile Companion View**: Declarative Actor sheet rendering 12 canonical widgets, 5-step SRD 5.1 Actor creation wizard, SRD compendium search, turn tracker with reaction timers, 2D canvas dice tray, filtered wiki notes with handout popups, and a dedicated mobile viewport mode.

---

## 2. Architecture & Data Model

### 2.1 Storage Traits & Dynamic Selection

The server application abstracts all persistence behind Rust traits defined in `crates/trame-server/src/storage/`:
- `WalStorage`: Append, fetch, and compact write-ahead log entries and state snapshots.
- `SessionStore`: Manage user authentication sessions and personal access tokens.
- `CampaignStore`: Campaign CRUD, entity persistence, membership validation, and archive import/export.
- `PartyJournalStorage`: Chronological journal and session notes storage.
- `TimelineStorage`: Session timeline event stream persistence.
- `AssetStore`: Campaign binary asset metadata and content storage.

When `trame-server` starts in `main.rs`:
- IF `DATABASE_URL` environment variable is defined, THEN the server instantiates `sqlx::PgPool`, executes `sqlx::migrate!("./migrations")`, and wraps `SqlxPostgresStore` within the shared `AppState`.
- IF `DATABASE_URL` is absent, THEN the server instantiates `InMemoryWalStorage`, `InMemorySessionStore`, `InMemoryCampaignStore`, `InMemoryPartyJournalStorage`, `InMemoryTimelineStorage`, and `InMemoryAssetStore` within `AppState`.

### 2.2 PostgreSQL Schema Migration (`0001_initial_schema.sql`)

The initial schema establishes tables, constraints, and indices in PostgreSQL 18:

```sql
-- Users and Authentication
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NULL,
    is_ephemeral BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS revoked_invites (
    jti VARCHAR(64) PRIMARY KEY,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaigns and Membership
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    system_id VARCHAR(50) NOT NULL DEFAULT 'dnd5e',
    gm_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    active_scene_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_members (
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL CHECK (role IN ('GM', 'ASSISTANT_GM', 'PLAYER', 'SPECTATOR')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (campaign_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_members_user ON campaign_members(user_id);

-- Authoritative Entities
CREATE TABLE IF NOT EXISTS campaign_entities (
    id UUID NOT NULL,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL CHECK (entity_type IN ('actor', 'scene', 'item')),
    owner_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (campaign_id, id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_entities_type ON campaign_entities(campaign_id, entity_type);

-- Write-Ahead Log (WAL)
CREATE TABLE IF NOT EXISTS wal_entries (
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    sequence_num BIGINT NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (campaign_id, sequence_num)
);

CREATE TABLE IF NOT EXISTS wal_snapshots (
    campaign_id UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    last_sequence_num BIGINT NOT NULL,
    snapshot_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaign Notes with Role Filtering
CREATE TABLE IF NOT EXISTS campaign_notes (
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    slug VARCHAR(120) NOT NULL,
    title VARCHAR(200) NOT NULL,
    content_markdown TEXT NOT NULL,
    min_role VARCHAR(30) NOT NULL DEFAULT 'PLAYER',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (campaign_id, slug)
);

-- Party Journals & Session Timeline Events
CREATE TABLE IF NOT EXISTS party_journal_entries (
    id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    session_num INT NOT NULL,
    author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    body_markdown TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_party_journal_campaign_session ON party_journal_entries(campaign_id, session_num);

CREATE TABLE IF NOT EXISTS session_timeline_events (
    id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    session_num INT NOT NULL,
    event_kind VARCHAR(60) NOT NULL,
    description TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timeline_events_campaign ON session_timeline_events(campaign_id, session_num);

-- Binary Assets
CREATE TABLE IF NOT EXISTS campaign_assets (
    asset_key VARCHAR(512) PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    content_type VARCHAR(100) NOT NULL,
    byte_size BIGINT NOT NULL,
    payload BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_assets_campaign ON campaign_assets(campaign_id);
```

### 2.3 Ephemeral User Contract for Magic Link Redemption

When an unauthenticated visitor redeems a Magic Link via `POST /api/v1/auth/magic-link/redeem`:
1. The auth handler decodes and validates the invitation JWT.
2. The handler checks `revoked_invites` table for the token's `jti`. IF found, THEN the handler rejects the request with HTTP 401 Unauthorized.
3. The storage layer creates a user record with:
   - `id`: newly generated UUID v4.
   - `email`: `ephemeral_<UUID>@trame.local`.
   - `display_name`: `Guest <4-digit-hex>` (or requested nickname from payload).
   - `password_hash`: `NULL`.
   - `is_ephemeral`: `TRUE`.
4. The handler inserts a record into `campaign_members` linking the user to `campaign_id` with the token's embedded role.
5. The handler issues an authenticated session token in `auth_sessions` and sets the `Set-Cookie: trame_session=<token>; HttpOnly; SameSite=Lax; Path=/` response header.

---

## 3. Backend Axum HTTP & WebSocket Routes

### 3.1 Authentication Routes

- `POST /api/v1/auth/register`:
  - Request Body: `{ "email": "string", "display_name": "string", "password": "string" }`.
  - Validates email format, display name length (2..100), and password strength (minimum 8 characters).
  - Computes Argon2id password hash using `argon2::Argon2::default()`.
  - Inserts record into `users` (`is_ephemeral = FALSE`).
  - Generates session token, stores SHA-256 hash in `auth_sessions`, sets `trame_session` cookie.
  - Status: 201 Created. Returns `{ "user": { "id": "uuid", "email": "string", "display_name": "string" } }`.

- `POST /api/v1/auth/login`:
  - Request Body: `{ "email": "string", "password": "string" }`.
  - Queries `users` by email. IF user not found or `password_hash` is NULL, THEN returns 401 Unauthorized.
  - Verifies password against `password_hash` with Argon2id.
  - Inserts session into `auth_sessions`, sets `trame_session` cookie.
  - Status: 200 OK. Returns user profile.

- `POST /api/v1/auth/logout`:
  - Reads `trame_session` cookie, computes SHA-256 hash, deletes record from `auth_sessions`.
  - Sets expired `trame_session` cookie (`Max-Age=0`).
  - Status: 200 OK.

- `GET /api/v1/auth/me`:
  - Validates `trame_session` cookie or `Authorization: Bearer <PAT>` header.
  - Status: 200 OK. Returns authenticated user entity.

- `POST /api/v1/auth/magic-link/mint`:
  - GM only. Request Body: `{ "campaign_id": "uuid", "role": "PLAYER" | "SPECTATOR" | "ASSISTANT_GM", "duration_seconds": number }`.
  - Generates JWT containing `jti`, `campaign_id`, `role`, and expiration.
  - Status: 200 OK. Returns `{ "invite_url": "/lobby?invite=<jwt>", "token": "<jwt>" }`.

- `POST /api/v1/auth/magic-link/redeem`:
  - Request Body: `{ "token": "string", "nickname": "string?" }`.
  - Validates JWT signature, checks `revoked_invites`, provisions ephemeral user, establishes campaign membership, sets session cookie.
  - Status: 200 OK. Returns `{ "user": User, "campaign_id": "uuid" }`.

### 3.2 Campaign & Actor CRUD Routes

- `GET /api/v1/campaigns`:
  - Returns list of campaigns where authenticated user is a member.
  - Status: 200 OK.

- `POST /api/v1/campaigns`:
  - Request Body: `{ "name": "string", "system_id": "dnd5e" }`.
  - Creates campaign record, assigns caller as `GM` in `campaign_members`.
  - Status: 201 Created.

- `GET /api/v1/campaigns/{campaign_id}`:
  - Validates caller membership in campaign.
  - Status: 200 OK. Returns campaign details, active scene ID, member list, and role of caller.

- `PUT /api/v1/campaigns/{campaign_id}/actors/{actor_id}`:
  - Validates caller is `GM` or owner of actor.
  - Request Body Schema:
    ```json
    {
      "name": "string (1..100 chars)",
      "system_id": "dnd5e",
      "actor_type": "player | monster | npc",
      "sheet_layout_id": "string",
      "attributes": {
        "strength": { "base": 16, "current": 16 },
        "dexterity": { "base": 12, "current": 12 },
        "constitution": { "base": 14, "current": 14 },
        "intelligence": { "base": 10, "current": 10 },
        "wisdom": { "base": 12, "current": 12 },
        "charisma": { "base": 10, "current": 10 }
      },
      "properties": {
        "hp": { "current": 12, "max": 12, "temp": 0 },
        "armor_class": 16,
        "speed_feet": 30
      }
    }
    ```
  - Serializes Actor entity and upserts into `campaign_entities`.
  - IF actor exists in active `TableRoomActor`, THEN dispatches internal `TrameCommand::UpdateActor` to update room state.
  - Status: 200 OK. Returns updated Actor JSON.

### 3.3 Starter Dungeon & UVTT Map Import Routes

- `POST /api/v1/campaigns/{campaign_id}/maps/starter`:
  - Validates caller is `GM`.
  - Generates a procedural 1200x800 battlemap texture encoded as WebP image.
  - Stores texture in `AssetStore` with key `campaigns/{campaign_id}/assets/starter-map.webp`.
  - Creates starter scene with walls (perimeter and internal partition), 1 standard door (`x: 600, y: 400`), 1 secret door (`x: 800, y: 200`), and 2 ambient light torches (300 lumens warm orange, 40-foot radius).
  - Injects canonical Actor entities into `campaign_entities` and active room:
    1. **Starter Hero 1 (Valeros - Fighter)**:
       - UUID: `11111111-1111-4111-8111-111111111111`
       - Actor Type: `player`, Sheet Layout: `dnd5e-actor-v1`
       - AbilityScore: STR 16, DEX 12, CON 14, INT 10, WIS 12, CHA 10
       - HP: 12/12, AC: 16, Position: `x: 250, y: 350, elevation: 0`
    2. **Starter Hero 2 (Merisiel - Rogue)**:
       - UUID: `22222222-2222-4222-8222-222222222222`
       - Actor Type: `player`, Sheet Layout: `dnd5e-actor-v1`
       - AbilityScore: STR 10, DEX 16, CON 12, INT 12, WIS 14, CHA 13
       - HP: 9/9, AC: 15, Position: `x: 300, y: 350, elevation: 0`
    3. **Goblin Sneak (Monster)**:
       - UUID: `33333333-3333-4333-8333-333333333333`
       - Actor Type: `monster`, Sheet Layout: `dnd5e-actor-v1`
       - AbilityScore: STR 8, DEX 14, CON 10, INT 10, WIS 8, CHA 8
       - HP: 7/7, AC: 13, Position: `x: 850, y: 250, elevation: 0`
    4. **Goblin Archer (Monster)**:
       - UUID: `44444444-4444-4444-8444-444444444444`
       - Actor Type: `monster`, Sheet Layout: `dnd5e-actor-v1`
       - AbilityScore: STR 8, DEX 14, CON 10, INT 10, WIS 8, CHA 8
       - HP: 7/7, AC: 13, Position: `x: 900, y: 300, elevation: 0`
  - Injects a starter campaign note `starter-dungeon-guide` containing GM annotations and a player handout block.
  - Synchronously records `TrameEvent::SceneLoaded` and `TrameEvent::TokenAdded` into `wal_entries`.
  - Broadcasts room update to all connected WebSocket clients.
  - Status: 201 Created. Returns scene summary JSON.

- `POST /api/v1/campaigns/{campaign_id}/maps/import-uvtt`:
  - Validates caller is `GM`.
  - Consumes multipart upload containing a `.uvtt` JSON payload and raster image.
  - Parses line-of-sight wall segments, portals (doors/windows), and ambient lights.
  - Stores parsed map texture in `AssetStore` and creates scene entity.
  - Updates `TableRoomActor` spatial BVH and broadcasts scene state.
  - Status: 201 Created. Returns scene ID and vector counts.

### 3.4 Notes & Handout Reveal Routes

- `GET /api/v1/campaigns/{campaign_id}/notes`:
  - Queries `campaign_notes` for the campaign.
  - Determines caller role in campaign.
  - Applies `FilteredNoteDocument::filter_for_role(content_markdown, caller_role)` to strip `:::gm` blocks from non-GM callers.
  - Status: 200 OK. Returns filtered note list.

- `PUT /api/v1/campaigns/{campaign_id}/notes/{slug}`:
  - GM only.
  - Request Body: `{ "title": "string", "content_markdown": "string", "min_role": "PLAYER" }`.
  - Upserts note record in `campaign_notes`.
  - Status: 200 OK.

- `POST /api/v1/campaigns/{campaign_id}/handouts/reveal`:
  - GM only.
  - Request Body: `{ "note_slug": "string", "handout_id": "string", "target_user_ids": ["uuid"] | null }`.
  - Extracts `:::handout` block from note document.
  - Emits `TrameEvent::HandoutRevealed` to target users (or all connected clients if null).
  - Records event in `session_timeline_events`.
  - Status: 200 OK.

- `GET /api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline`:
  - Validates campaign membership.
  - Returns array of `SessionTimelineEvent` records sorted by timestamp ascending.
  - Status: 200 OK.

### 3.5 Asset Streaming & Presigned Authorization

- `GET /assets/download/{*key}`:
  - Authorization Validation Policy:
    1. The route parses the asset key to identify the associated `campaign_id` (prefixed as `campaigns/{campaign_id}/...`).
    2. IF query parameter `sig` and `exp` are present, THEN the server verifies the HMAC-SHA256 signature using the server secret key and verifies `exp >= unix_now()`. IF valid, THEN allow download.
    3. IF query parameters are absent, THEN the server inspects the `trame_session` cookie or `Authorization: Bearer` header, verifies the caller is an active member of `campaign_id` via `CampaignMembershipValidator`. IF caller is not a campaign member, THEN return HTTP 403 Forbidden.
  - IF authorized, THEN stream asset byte stream from `AssetStore` with matching `Content-Type` header (e.g., `image/webp`, `image/png`).
  - Status: 200 OK.

### 3.6 WebSocket Lifecycle & Envelope Protocol

- `GET /ws/campaigns/{campaign_id}`:
  - Authentication: Evaluates `trame_session` cookie or `Authorization: Bearer <PAT>` header. (Test fallback query parameter `?token=` is permitted only during test profile execution).
  - Validates caller membership in `campaign_id`.
  - Upgrades HTTP connection to WebSocket.
  - Registers client connection in `TableRoomActor`.
  - Transmits full initial state snapshot: `ServerEnvelope::StateSync(CampaignRoomState)`.
  - Inbound frames consume binary MessagePack `ClientEnvelope`:
    - `ClientEnvelope::Command(TrameCommand)`: Executes mutation (e.g., `MoveToken`, `ToggleDoor`, `ApplyActiveEffect`, `RollDice`). Synchronously writes `TrameEvent` to `wal_entries` in PostgreSQL, then broadcasts `ServerEnvelope::Delta(TrameEvent)` to connected room clients.
    - `ClientEnvelope::Ping(u64)`: Server immediately replies with `ServerEnvelope::Pong(u64)`.
  - Outbound frames transmit binary MessagePack `ServerEnvelope`.

---

## 4. Frontend Architecture & Components

### 4.1 Preact Signals State Architecture (`PreactSignalState`)

Browser application state resides in `packages/web/src/state/appSignals.ts`, exporting atomic Preact signals with concrete TypeScript domain types:

```typescript
import { signal, Signal } from '@preact/signals';
import type {
  CampaignRoomState,
  Actor,
  FilteredNoteDocument,
  SessionTimelineEvent,
  DiceRollResult,
  HandoutBlock,
  AuthUser,
  CampaignSummary,
  CampaignDetails
} from '../types';

export interface PreactSignalState {
  authUserSignal: Signal<AuthUser | null>;
  campaignsSignal: Signal<CampaignSummary[]>;
  activeCampaignSignal: Signal<CampaignDetails | null>;
  tableStateSignal: Signal<CampaignRoomState | null>;
  actorsSignal: Signal<Map<string, Actor>>;
  notesSignal: Signal<FilteredNoteDocument[]>;
  timelineSignal: Signal<SessionTimelineEvent[]>;
  diceLogSignal: Signal<DiceRollResult[]>;
  revealedHandoutSignal: Signal<HandoutBlock | null>;
  activeDrawerSignal: Signal<'sheet' | 'compendium' | 'notes' | 'dice' | 'undo' | null>;
  companionModeSignal: Signal<boolean>;
  activeActorIdSignal: Signal<string | null>;
}

export const appSignals: PreactSignalState = {
  authUserSignal: signal<AuthUser | null>(null),
  campaignsSignal: signal<CampaignSummary[]>([]),
  activeCampaignSignal: signal<CampaignDetails | null>(null),
  tableStateSignal: signal<CampaignRoomState | null>(null),
  actorsSignal: signal<Map<string, Actor>>(new Map()),
  notesSignal: signal<FilteredNoteDocument[]>([]),
  timelineSignal: signal<SessionTimelineEvent[]>([]),
  diceLogSignal: signal<DiceRollResult[]>([]),
  revealedHandoutSignal: signal<HandoutBlock | null>(null),
  activeDrawerSignal: signal<'sheet' | 'compendium' | 'notes' | 'dice' | 'undo' | null>(null),
  companionModeSignal: signal<boolean>(false),
  activeActorIdSignal: signal<string | null>(null)
};
```

### 4.2 Network Client (`client.ts`)

`packages/web/src/api/client.ts` wraps REST endpoints and the binary WebSocket connection:
- Encodes outgoing messages with `@msgpack/msgpack` `encode(ClientEnvelope)`.
- Decodes incoming binary WebSocket arrays with `@msgpack/msgpack` `decode(ServerEnvelope)`.
- Upon receiving `ServerEnvelope::StateSync(state)`, assigns `appSignals.tableStateSignal.value = state` and populates `appSignals.actorsSignal`.
- Upon receiving `ServerEnvelope::Delta(event)`, updates relevant atomic signals. HUD components listening to these signals re-render locally.

### 4.3 AuthScreen & CampaignLobby Components

- `AuthScreen.tsx`:
  - Renders email/password registration and login forms.
  - On submit, calls `POST /api/v1/auth/register` or `POST /api/v1/auth/login`.
  - Updates `appSignals.authUserSignal` and navigates to `/lobby`.

- `CampaignLobby.tsx`:
  - Checks URL for query parameter `?invite=<jwt>` on mount. IF detected, THEN automatically calls `POST /api/v1/auth/magic-link/redeem`, sets auth session, and enters the invited campaign.
  - Lists campaigns from `GET /api/v1/campaigns` in `appSignals.campaignsSignal`.
  - Provides "Create Campaign" modal dispatching `POST /api/v1/campaigns`.
  - Provides "Mint Magic Link" button for GMs, generating 1-click shareable URLs.
  - Provides `.trame` Archive export button (`GET /api/v1/campaigns/{id}/export`) and import file upload form (`POST /api/v1/campaigns/import?remap_ids=true`).

### 4.4 Interactive Tabletop Canvas (`TableCanvas.tsx`)

`packages/web/src/components/TableCanvas.tsx` mounts the PixiJS v8 rendering application:

```typescript
// Imperative SceneGraph binding
effect(() => {
  const roomState = appSignals.tableStateSignal.value;
  if (roomState && sceneGraphRef.current) {
    sceneGraphRef.current.syncFromRoomState(roomState);
  }
});
```

#### Canvas Features & Rules
1. **Hardware / Headless Lifecycle**:
   - IF WebGL context initialization fails on the HTML canvas element, THEN `TableCanvas` instantiates `HeadlessCanvasMock`, attaches event listeners to a mock viewport object, and emits custom event `'mock-canvas-active'` on `window` for test assertion.
2. **Spatial Engine & Fallback**:
   - `WasmSpatialEngine` attempts asynchronous compilation of `trame-engine` WASM.
   - IF `WebAssembly.instantiateStreaming` fails or rejects, THEN `WasmSpatialEngine` sets `engineMode = 'TYPESCRIPT_FALLBACK'` and delegates raycasts and AoE evaluations to `Bvh2D` and `evaluateAoeTargets`. Unit tests assert `engine.getEngineMode() === 'TYPESCRIPT_FALLBACK'`.
3. **Token Drag-and-Drop**:
   - Pointer down on Actor token initiates drag state.
   - Pointer move calculates 2.5D collision raycast against walls in `SceneGraph`.
   - Pointer up dispatches `TrameCommand::MoveToken { token_id, to_x, to_y, to_elevation }` over WebSocket client.
4. **Interactive Portals (Doors & Secret Doors)**:
   - Clicking a door segment dispatches `TrameCommand::ToggleDoor { door_id }`.
   - Door transitions between `OPEN`, `CLOSED`, and `LOCKED`. Wall BVH updates line-of-sight rays immediately.
5. **DrawingOverlay, Area-of-Effect & Elevation Ruler**:
   - Pressing ruler hotkey triggers 3D distance measurement (`sqrt(dx^2 + dy^2 + dz^2)`).
   - Targeting spell area triggers AoE template overlay (Cone, Sphere, Line) evaluating intersected Actor tokens via spatial engine.
   - Quick pointer ping emits animated radar pulse visible to all room participants.

### 4.5 GM Override Toolbar (`GmOverrideToolbar.tsx`)

The GM toolbar displays exclusively for users holding the `GM` role:
- **Mode Toggle**: Switches campaign between `Exploration` and `Turn-by-Turn` modes via `TrameCommand::SetTableMode`.
- **Ambient Preset Selector**: Modifies room ambient lighting (Daylight, Dungeon Dim, Moonlight, Pitch Black).
- **Starter Dungeon Button**: Calls `POST /api/v1/campaigns/{id}/maps/starter`, re-centering canvas view upon completion.
- **UVTT Battlemap Upload**: File input triggering `POST /api/v1/campaigns/{id}/maps/import-uvtt`.
- **Apply ActiveEffect Form**: Selects target Actor and applies an `ActiveEffect` targeting `AbilityScore` or Hit Points through the canonical derivedDAG pipeline, eliminating ad-hoc unverified stat mutations.
- **Undo Action Button**: Dispatches `TrameCommand::UndoLastAction`, rolling back the most recent WAL entry.

### 4.6 Tabletop HUD Drawers & Mobile Companion View

- `ActorSheetDrawer.tsx`:
  - Renders all 12 canonical sheet widgets from `DeclarativeSheetRenderer` based on `dnd5e-actor-v1` layout: HeaderWidget, AbilityScoresWidget, HealthPointsWidget, ArmorClassWidget, SavingThrowsWidget, SkillsListWidget, SpellSlotsWidget, ActionsListWidget, InventoryWidget, FeaturesWidget, PassivePerceptionWidget, and ConditionsWidget.
  - Clicking rollable attributes or actions dispatches `TrameCommand::RollDice` to the server.
  - Supports `ShortRest` and `LongRest` commands restoring HP and spell slots.

- `ActorBuilderModal.tsx`:
  - 5-step SRD 5.1 creation wizard backed by `CharacterBuilderWizard`:
    1. Race selection (Human, Elf, Dwarf, Halfling).
    2. Class selection (Fighter, Wizard, Rogue, Cleric).
    3. AbilityScore assignment (Standard Array: 15, 14, 13, 12, 10, 8).
    4. Background & Proficiencies.
    5. Starting Equipment & Final Review.
  - On completion, dispatches `PUT /api/v1/campaigns/{campaign_id}/actors/{actor_id}` and spawns token on the active map.

- `CompendiumDrawer.tsx`:
  - Searchable list of SRD 5.1 spells, monsters, and items.
  - Supports drag-and-drop onto `ActorSheetDrawer` to equip items or memorize spells.

- `CombatTrackerBar.tsx` & `ReactionBanner.tsx`:
  - Displays initiative-ordered Actor queue with current active turn highlighted.
  - GM triggers "Next Turn", advancing round counter.
  - When an Actor triggers a reaction (e.g. Shield spell, Opportunity Attack), `ReactionBanner` renders a 5-second countdown timer allowing the target player to accept or decline the reaction action.

- `DiceTrayDrawer.tsx`:
  - Lightweight, deterministic 2D Canvas and DOM-based dice rolling tray.
  - Renders visual roll animations, modifier formula calculator, and history list using server-verified rolls from `appSignals.diceLogSignal` without requiring 3D physics engines.

- `WikiNotesDrawer.tsx` & `HandoutPopupModal.tsx`:
  - Displays role-filtered campaign Markdown notes.
  - Allows GM to edit notes and click "Reveal Handout" on `:::handout` blocks.
  - When `appSignals.revealedHandoutSignal` receives an event, `HandoutPopupModal` displays the image and text to players modal-style.

- `MobileCompanionView.tsx`:
  - Automatically activates when viewport width is `< 768px` (or toggled via `companionModeSignal`).
  - Collapses canvas into a compact mini-radar view and presents full-screen tabbed interface optimized for touch: `Actor Sheet`, `Combat Actions`, `Party Chat / Dice`, and `Notes`.

---

## 5. Non-Functional Invariants & Security Boundaries

### 5.1 CQRS & Persistence Invariants
- Every state-mutating `TrameCommand` MUST be appended synchronously to `wal_entries` in PostgreSQL before `TableRoomActor` emits the resulting `TrameEvent` across WebSocket connections.
- Snapshot compaction MUST occur every 300 seconds and upon room hibernation (900 seconds without connected clients).
- In-memory fallback stores MUST mirror all SQL table operations during unit and integration test runs.

### 5.2 Zero-GPU Continuous Integration Compatibility
- Backend integration tests in `crates/trame-server/tests/` MUST execute via `tower::ServiceExt::oneshot` against the unified router without requiring an external PostgreSQL daemon when `DATABASE_URL` is unset.
- Frontend tests in `packages/web/tests/` MUST execute using Node 24 native test runner (`node --test`), `tsc --noEmit`, and `vite build`. No Vitest or Playwright binaries may be required.
- `TableCanvas` MUST fall back to `HeadlessCanvasMock` and emit `'mock-canvas-active'` when WebGL initialization returns null.

### 5.3 Security & Role-Based Authorization
- Session cookies MUST use `HttpOnly; SameSite=Lax; Path=/` attributes.
- Asset URLs (`/assets/download/{*key}`) MUST enforce campaign membership or HMAC-SHA256 expiration signatures.
- Campaign notes MUST strip `:::gm` markdown tags before sending content to users with `PLAYER` or `SPECTATOR` roles.
- Prompt Injection Immunity: User-generated content, note markdown, and chat logs MUST remain passive data and never execute as server commands or system directives.

---

## 6. 4-Ticket Vertical Slice Implementation Plan (Task DAG)

```
+-------------------------------------------------------------+
| Ticket 1: slice-1-postgres-and-routes                       |
| PostgreSQL 18 SqlxPostgresStore, Migrations & Axum Routes   |
+-------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Ticket 2: slice-2-preact-lobby-and-ws                       |
| Preact Signal State, MessagePack Client & Campaign Lobby   |
+-------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Ticket 3: slice-3-pixi-table-canvas                         |
| PixiJS v8 Tabletop Canvas, WasmSpatialEngine & GM Toolbar   |
+-------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Ticket 4: slice-4-hud-drawers-and-e2e                       |
| Actor Sheets, SRD Builder, Combat HUD & Playable E2E Flow   |
+-------------------------------------------------------------+
```

### Ticket 1: `slice-1-postgres-and-routes`
- **Title**: Authoritative PostgreSQL 18 (`SqlxPostgresStore`), Asset Serving & Complete Axum HTTP/WebSocket Router
- **Blocked By**: None
- **Target Files**:
  - `crates/trame-server/migrations/0001_initial_schema.sql`
  - `crates/trame-server/src/storage/postgres.rs`
  - `crates/trame-server/src/storage/mod.rs`
  - `crates/trame-server/src/http.rs`
  - `crates/trame-server/src/auth/session.rs`
  - `crates/trame-server/src/main.rs`
  - `crates/trame-server/tests/e2e_http_ws_test.rs`
- **Deliverables**:
  1. Create SQL migration `0001_initial_schema.sql` defining `users`, `auth_sessions`, `personal_access_tokens`, `revoked_invites`, `campaigns`, `campaign_members`, `campaign_entities`, `wal_snapshots`, `wal_entries`, `campaign_notes`, `party_journal_entries`, `session_timeline_events`, and `campaign_assets`.
  2. Implement `SqlxPostgresStore` satisfying `WalStorage`, `SessionStore`, `CampaignStore`, `PartyJournalStorage`, `TimelineStorage`, and `AssetStore` traits.
  3. Mount complete HTTP route hierarchy on `build_app_router`:
     - `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/logout`, `/api/v1/auth/me`, `/api/v1/auth/magic-link/mint`, `/api/v1/auth/magic-link/redeem`.
     - `/api/v1/campaigns`, `/api/v1/campaigns/{id}`, `/api/v1/campaigns/{id}/actors/{actor_id}`.
     - `/api/v1/campaigns/{id}/maps/starter` (procedural WebP map, 2 heroes, 2 goblins, starter note).
     - `/api/v1/campaigns/{id}/maps/import-uvtt` (UVTT map ingest into active `TableRoomActor`).
     - `/api/v1/campaigns/{id}/notes`, `/api/v1/campaigns/{id}/notes/{slug}`, `/api/v1/campaigns/{id}/handouts/reveal`.
     - `/api/v1/campaigns/{id}/sessions/{num}/timeline`.
     - `/assets/download/{*key}` (protected asset streaming).
     - `/ws/campaigns/{id}` (WebSocket session upgrade).
     - Static file serving from `TRAME_STATIC_DIR` with SPA `index.html` fallback.
  4. Update `main.rs` with dynamic pool initialization and migration execution.
  5. Add deterministic integration tests in `e2e_http_ws_test.rs` validating full lifecycle via `tower::ServiceExt::oneshot`.
- **Verification Command**: `cargo test -p trame-server`

### Ticket 2: `slice-2-preact-lobby-and-ws`
- **Title**: Preact Signals State Layer (`PreactSignalState`), Binary MessagePack Client & Campaign Lobby
- **Blocked By**: `slice-1-postgres-and-routes`
- **Target Files**:
  - `packages/web/src/api/client.ts`
  - `packages/web/src/state/appSignals.ts`
  - `packages/web/src/types/index.ts`
  - `packages/web/src/components/AuthScreen.tsx`
  - `packages/web/src/components/CampaignLobby.tsx`
  - `packages/web/tests/client.test.ts`
  - `packages/web/tests/appSignals.test.ts`
- **Deliverables**:
  1. Define concrete TypeScript interfaces in `types/index.ts` for all entities, room state, signals, and binary envelopes.
  2. Implement `appSignals.ts` exporting `PreactSignalState` without any `any` types.
  3. Implement `client.ts` handling typed REST calls and MessagePack WebSocket frame encoding/decoding.
  4. Build `AuthScreen.tsx` (email/password login and registration).
  5. Build `CampaignLobby.tsx` (campaign list, create campaign modal, Magic Link redemption, and `.trame` export/import).
  6. Write automated unit and integration tests using native Node 24 test runner (`node --test`).
- **Verification Command**: `node --test packages/web/tests/client.test.ts packages/web/tests/appSignals.test.ts`

### Ticket 3: `slice-3-pixi-table-canvas`
- **Title**: Interactive PixiJS v8 Tabletop Canvas (`TableCanvas`), `WasmSpatialEngine` & `GmOverrideToolbar`
- **Blocked By**: `slice-2-preact-lobby-and-ws`
- **Target Files**:
  - `packages/web/src/engine/wasmBridge.ts`
  - `packages/web/src/components/TableCanvas.tsx`
  - `packages/web/src/components/GmOverrideToolbar.tsx`
  - `packages/web/tests/canvas.test.ts`
- **Deliverables**:
  1. Implement `wasmBridge.ts` with `WasmSpatialEngine` loader and deterministic `TYPESCRIPT_FALLBACK` routing.
  2. Build `TableCanvas.tsx` hosting PixiJS v8 `Application` with `HeadlessCanvasMock` fallback emitting `'mock-canvas-active'` in headless environments.
  3. Connect canvas event handlers: camera pan/zoom, token drag-and-drop (`MoveToken`), interactive door clicks (`ToggleDoor`), area-of-effect preview overlays, 3D elevation ruler, and radar pings.
  4. Build `GmOverrideToolbar.tsx` supporting mode toggles, ambient lighting presets, starter dungeon button, UVTT map upload, canonical `ApplyActiveEffect` commands targeting `AbilityScore`, and action undo.
  5. Write unit tests verifying engine fallback and canvas interaction lifecycle.
- **Verification Command**: `node --test packages/web/tests/canvas.test.ts`

### Ticket 4: `slice-4-hud-drawers-and-e2e`
- **Title**: Declarative Actor Sheet Drawer, 5-Step SRD Wizard, Combat HUD, Wiki Notes & Mobile View
- **Blocked By**: `slice-3-pixi-table-canvas`
- **Target Files**:
  - `packages/web/src/components/ActorSheetDrawer.tsx`
  - `packages/web/src/components/ActorBuilderModal.tsx`
  - `packages/web/src/components/CompendiumDrawer.tsx`
  - `packages/web/src/components/CombatTrackerBar.tsx`
  - `packages/web/src/components/ReactionBanner.tsx`
  - `packages/web/src/components/DiceTrayDrawer.tsx`
  - `packages/web/src/components/WikiNotesDrawer.tsx`
  - `packages/web/src/components/HandoutPopupModal.tsx`
  - `packages/web/src/components/MobileCompanionView.tsx`
  - `packages/web/src/App.tsx`
  - `packages/web/tests/e2ePlayableFlow.test.ts`
- **Deliverables**:
  1. Build `ActorSheetDrawer.tsx` rendering 12 canonical widgets backed by `DeclarativeSheetRenderer` and `dnd5e-actor-v1`.
  2. Build `ActorBuilderModal.tsx` implementing the 5-step SRD 5.1 creation wizard.
  3. Build `CompendiumDrawer.tsx` for searching and dragging SRD items/spells onto actor sheets.
  4. Build `CombatTrackerBar.tsx` and `ReactionBanner.tsx` with 5-second reaction countdown timers.
  5. Build `DiceTrayDrawer.tsx` rendering rolls and formula calculator via 2D Canvas and DOM elements.
  6. Build `WikiNotesDrawer.tsx` and `HandoutPopupModal.tsx` with role-based note editing and handout reveals.
  7. Build `MobileCompanionView.tsx` activating automatically on `< 768px` viewports.
  8. Integrate all views into `App.tsx` and implement end-to-end integration tests verifying complete playable flow from GM registration through starter dungeon combat.
- **Verification Command**: `npm --prefix packages/web run build && node --test packages/web/tests/e2ePlayableFlow.test.ts`
