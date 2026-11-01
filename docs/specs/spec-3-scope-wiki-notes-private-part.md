# Technical & Functional Specification: 3-Scope Wiki Notes, Live Handout Modal, MobileCompanionView & i18n

- **Identifier**: `spec-3-scope-wiki-notes-private-part`
- **Date**: 2025-05-18
- **Status**: Ready for implementation
- **References**: Issue #80, ADR-0004, ADR-0009, ADR-0034, ADR-0035, GLOSSARY.md; ASD-STE100 controlled technical writing (EPURE governance ADR-0031, upstream; not an ADR of this repository)

---

## 1. Goals & Scope

This specification defines the complete implementation of the following TRAME features:
1. **Wiki notes with 3 visibility levels (`NoteVisibility`)**:
   - `PRIVATE` (personal notes sealed from other players and from the GM),
   - `PARTY` (collaborative wiki shared between players and the GM),
   - `DM_ONLY` (secrets reserved for the Game Master),
   organized in hierarchical folders in the `DocumentsWorkspaceTab` tab and in the table side drawer.
2. **Server-side zero-trust filtering (`FilteredNoteDocument`)**:
   - Removal of the secret `:::dm` and `:::handout{revealed="false"}` blocks for non-GM users.
   - AST preservation and merge algorithm (`LineAnchorNoteMerge`) that keeps the GM's confidential blocks when players edit `PARTY` notes with `PUT`.
3. **Transactional lifecycle and live handout reveal**:
   - The `TrameCommand::RevealHandout` command over WebSocket and the REST endpoint `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
   - Decoupled persistence in the SQL table `party_journal_entries` and the `session_events` timeline.
   - WebSocket broadcast `ServerEnvelope::HandoutRevealed` that automatically opens the Preact component `[data-testid="handout-reveal-modal"]`.
4. **Preact mobile companion view (`MobileCompanionView`)**:
   - Reactive conditional mounting for viewports `< 768px` or explicit activation through `mobileCompanionOverrideSignal`.
   - Clean destruction of the WebGL/PixiJS instance (`app.destroy(true, { children: true, texture: false })`).
   - Touch interface with 5 tabs (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).
5. **Reactive bilingual presentation layer and metric units (`i18n`)**:
   - Global reactive signals `localeSignal` (`'en' | 'fr'`, `LocaleSignal`) and `unitSystemSignal` (`'imperial_ft' | 'metric_m'`, `UnitSystemSignal`).
   - A unified formatting function `formatDistanceFt(feet)` that handles the singular/plural of grid squares through `t()`.
   - A bidirectional bilingual dictionary for compendium search that never changes the canonical English slugs.

---

## 2. Data Model & SQL Schema

### 2.1 `campaign_notes` Table

Every campaign note is stored in the existing `campaign_notes` table with the extended authorization schema:

```sql
ALTER TABLE campaign_notes ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'PARTY';
ALTER TABLE campaign_notes ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE campaign_notes ADD COLUMN IF NOT EXISTS folder VARCHAR(255) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_campaign_notes_visibility ON campaign_notes(campaign_id, visibility, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_notes_folder ON campaign_notes(campaign_id, folder);
```

- `visibility` takes one of three values: `'PRIVATE'`, `'PARTY'`, `'DM_ONLY'`.
- `owner_user_id` references the note creator's identifier (required for `PRIVATE`).
- `folder` is the logical folder path (for example `""`, `"Quests"`, `"NPCs/Allies"`).

### 2.2 `party_journal_entries` Table

A standalone, decoupled table that stores the handouts revealed to the party:

```sql
CREATE TABLE IF NOT EXISTS party_journal_entries (
    handout_id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    revealed_at BIGINT NOT NULL,
    revealed_by VARCHAR(64) NOT NULL,
    CONSTRAINT fk_party_journal_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_party_journal_campaign ON party_journal_entries(campaign_id, revealed_at DESC);
```

### 2.3 `session_events` Table

An append-only table for the session event timeline:

```sql
CREATE TABLE IF NOT EXISTS session_events (
    id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    session_num INT NOT NULL DEFAULT 0,
    seq_id BIGINT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_session_events_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_events_campaign_seq ON session_events(campaign_id, seq_id ASC);
```

---

## 3. Backend Specification (`trame-server`)

### 3.1 RBAC Authorization Rules per Scope

The role is always the caller's campaign role (`UserRole`), taken from campaign membership.

| Scope | Client role | Read (`GET`) | Create (`POST`) | Update (`PUT`) | Delete (`DELETE`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `PRIVATE` | Owner (`owner_user_id == user.id`) | Allowed | Allowed | Allowed | Allowed |
| `PRIVATE` | Other player or GM (`owner_user_id != user.id`) | **HTTP 404** | Denied | Denied | Denied |
| `PARTY` | `GameMaster` or `Player` | Allowed | Allowed | Allowed (with AST merge) | Allowed |
| `PARTY` | `Spectator` | Allowed | **HTTP 403** | **HTTP 403** | **HTTP 403** |
| `DM_ONLY` | `GameMaster` | Allowed | Allowed | Allowed | Allowed |
| `DM_ONLY` | `Player` or `Spectator` | **HTTP 403** | **HTTP 403** | **HTTP 403** | **HTTP 403** |

### 3.2 Zero-Trust Filtering (`FilteredNoteDocument`)

1. `FilteredNoteDocument::filter_for_user(markdown: &str, role: UserRole) -> String`:
   - IF `role == UserRole::GameMaster`, THEN `FilteredNoteDocument` returns the full text unchanged.
   - IF `role != UserRole::GameMaster`:
     1. The parser removes every `:::dm ... :::` block entirely.
     2. The parser inspects every `:::handout{...} ... :::` block:
        - IF `revealed="true"`, THEN the block is kept.
        - IF `revealed="false"` or the `revealed` attribute is missing, THEN the block is removed entirely.

### 3.3 Preserving Confidential Directives on a Player `PUT` (`LineAnchorNoteMerge`)

WHEN a user with `user.role != UserRole::GameMaster` sends `PUT /api/v1/campaigns/{id}/notes/{note_id}` on a `PARTY` note:
1. `trame-server` loads the document currently stored in the database.
2. `trame-server` extracts the ordered list of confidential directives hidden from the player (`:::dm` and `:::handout{revealed="false"}`) with their relative positions in the original Markdown AST.
3. If confidential blocks exist in the stored note but are missing from the submitted content, `trame-server` merges the submitted text with the original confidential directives by reinserting the hidden blocks intact at their matching positions before the SQL update.

### 3.4 Notes REST API Contracts

#### `GET /api/v1/campaigns/{id}/notes`
- Returns the notes visible to the caller:
  - Includes every `PARTY` note.
  - Includes the `PRIVATE` notes where `owner_user_id == current_user.id`.
  - If `current_user.role == GameMaster`, includes every `DM_ONLY` note.
- Every returned note contains its content filtered by `FilteredNoteDocument`.
- Status code: `200 OK`.

#### `GET /api/v1/campaigns/{id}/notes/{note_id}`
- IF the note does not exist, returns `404 Not Found`.
- IF the note is `PRIVATE` and `owner_user_id != current_user.id`, returns `404 Not Found` (zero-trust: no leak of metadata or existence).
- IF the note is `DM_ONLY` and `current_user.role != GameMaster`, returns `403 Forbidden`.
- IF access is allowed, returns the filtered document with `200 OK`.

#### `POST /api/v1/campaigns/{id}/notes`
- JSON payload:
  ```json
  {
    "title": "string",
    "content": "string",
    "visibility": "PRIVATE | PARTY | DM_ONLY",
    "folder": "string"
  }
  ```
- IF `visibility == 'DM_ONLY'` and `current_user.role != GameMaster`, returns `403 Forbidden`.
- IF `visibility == 'PRIVATE'`, `owner_user_id` is set automatically to `current_user.id`.
- Status code: `201 Created` with the created note's JSON.

#### `PUT /api/v1/campaigns/{id}/notes/{note_id}`
- JSON payload:
  ```json
  {
    "title": "string",
    "content": "string",
    "folder": "string"
  }
  ```
- IF the note is `PRIVATE` and `owner_user_id != current_user.id`, returns `404 Not Found`.
- IF the note is `DM_ONLY` and `current_user.role != GameMaster`, returns `403 Forbidden`.
- IF the note is `PARTY` and `current_user.role == Spectator`, returns `403 Forbidden`.
- IF the note is `PARTY` and `current_user.role == Player`, runs the structural merge specified in section 3.3.
- Status code: `200 OK`.

#### `DELETE /api/v1/campaigns/{id}/notes/{note_id}`
- IF the note is `PRIVATE` and `owner_user_id != current_user.id`, returns `404 Not Found`.
- IF the note is `DM_ONLY` and `current_user.role != GameMaster`, returns `403 Forbidden`.
- IF the note is `PARTY` and `current_user.role == Spectator`, returns `403 Forbidden`.
- IF the note is `PARTY` and `current_user.role` is `GameMaster` or `Player`, deletes the note and returns `204 No Content`.

---

## 4. Handout Lifecycle Specification

### 4.1 Reveal Command

A handout reveal is triggered either by the WebSocket action `TrameCommand::RevealHandout` or by the dedicated REST endpoint:

- **REST route**: `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`
- **JSON payload**:
  ```json
  {
    "handout_id": "string"
  }
  ```
- **Access control**: only the `GameMaster` role is allowed. Any other role receives `403 Forbidden`.

### 4.2 Atomic Transactional Processing

When running the reveal, `trame-server` performs the following steps in a single SQL transaction:
1. Finds the `:::handout{id="<handout_id>"...}` block in the Markdown document of note `note_id`.
   - IF the block does not exist, returns `404 Not Found`.
2. Replaces the `revealed="false"` attribute with `revealed="true"` in the note's Markdown source.
3. Inserts into `party_journal_entries`:
   ```sql
   INSERT INTO party_journal_entries (handout_id, campaign_id, title, content, revealed_at, revealed_by)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (handout_id) DO UPDATE SET
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       revealed_at = EXCLUDED.revealed_at;
   ```
4. Resolves `session_num`:
   - `trame-server` queries the active state of the `TableRoomActor` for campaign `campaign_id`.
   - IF a session is active, THEN `session_num` is the current session's number.
   - ELSE `session_num` is `0`.
5. Atomically increments the campaign's `seq_id` and inserts the event into `session_events`:
   ```sql
   INSERT INTO session_events (id, campaign_id, session_num, seq_id, event_type, payload, created_at)
   VALUES ($1, $2, $3, $4, 'handout_revealed', $5, $6);
   ```
6. Broadcasts the WebSocket message `ServerEnvelope::HandoutRevealed` to every client connected to the table room:
   ```json
   {
     "type": "HandoutRevealed",
     "payload": {
       "handout_id": "string",
       "title": "string",
       "content": "string",
       "revealed_at": 1716000000000,
       "revealed_by": "user_id"
     }
   }
   ```

### 4.3 Party Journal Endpoint

- **REST route**: `GET /api/v1/campaigns/{id}/journal`
- **Authorization**: any authenticated campaign member (`GameMaster`, `Player`, `Spectator`).
- **Returns**: the array of `PartyJournalEntry` entries ordered by `revealed_at DESC`.
- Status code: `200 OK`.

### 4.4 Event Timeline Endpoint

- **REST route**: `GET /api/v1/campaigns/{id}/timeline` (the session-scoped route is `GET /api/campaigns/{campaign_id}/sessions/{session_num}/timeline`, see the E5 spec)
- **Optional query parameters**: `since_seq_id=0`, `limit=50` (capped at `200`).
- **Authorization**: any authenticated campaign member; events are filtered by role.
- **Returns**: the array of `SessionTimelineEvent` entries sorted by `seq_id ASC`.
- Status code: `200 OK`.

---

## 5. Preact Frontend & Mobile Companion Specification

### 5.1 Signal Architecture and Handout Modal

- File: `packages/web/src/state/handoutSignals.ts`
- Exports the reactive Preact signals:
  - `activeRevealedHandoutSignal = signal<PartyJournalEntry | null>(null)`: the handout currently shown in the full-screen modal.
  - `revealedHandoutsSignal = signal<PartyJournalEntry[]>([])`: the full list of handouts archived in the campaign.
- WebSocket integration (`packages/web/src/network/wsClient.ts`):
  - On receiving a `HandoutRevealed` frame:
    1. The handout object is prepended to `revealedHandoutsSignal.value`.
    2. `activeRevealedHandoutSignal.value` is set to this handout.
- `HandoutRevealModal` component (`packages/web/src/components/handouts/HandoutRevealModal.tsx`):
  - Test selector: `[data-testid="handout-reveal-modal"]`.
  - IF `activeRevealedHandoutSignal.value !== null`, shows the modal over the interface with the title, the Markdown-formatted body and a close button `[data-testid="close-handout-modal"]`.
  - Clicking close sets `activeRevealedHandoutSignal.value = null`.

### 5.2 DocumentsWorkspaceTab (`Tab 3`)

- Component mounted in `CampaignWorkspace` for the selector `[data-testid="tab-documents"]`.
- Split into 3 sub-sections:
  1. **Notes explorer & folder tree**:
     - Visibility filter selectors: `[data-testid="filter-private"]`, `[data-testid="filter-party"]`, `[data-testid="filter-dm-only"]` (visible to the GM only).
     - Tree grouped by logical folder (`folder`).
     - Note creation button `[data-testid="create-note-btn"]` with a `PRIVATE` or `PARTY` scope choice (or `DM_ONLY` for the GM).
     - Bidirectional Markdown editor supporting the `:::handout` and `:::dm` directives.
     - For every `:::handout` directive in the GM's editor: an action button `[data-testid="btn-reveal-handout"]` that calls `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
  2. **Revealed handouts gallery** (`[data-testid="past-handouts-gallery"]`):
     - Grid of archived handout cards from `GET /api/v1/campaigns/{id}/journal`.
     - Clicking a card opens its content in `HandoutRevealModal`.
  3. **Event timeline (`SessionTimelineViewer`)** (`[data-testid="session-timeline-viewer"]`):
     - Scrolling chronological feed of events (`combat_started`, `attack_rolled`, `creature_defeated`, `door_opened`, `handout_revealed`).

### 5.3 MobileCompanionView (`< 768px`)

- File: `packages/web/src/mobile/MobileCompanionView.tsx`.
- Test selector: `[data-testid="mobile-companion-view"]`.
- Switching rule in `App.tsx`:
  ```typescript
  const shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768);
  ```
- PixiJS destruction lifecycle:
  - WHEN `shouldMountCanvas.value === false`, THEN the cleanup hook calls `pixiApp.destroy(true, { children: true, texture: false })` and removes the WebGL canvas element from the DOM.
  - The `MobileCompanionView` component is then rendered full-screen.
- Bottom touch navigation bar tabs (`[data-testid="mobile-bottom-nav"]`), each with a touch target of at least 44x44 px:
  1. `[data-testid="nav-sheet"]`: condensed, touch-friendly character sheet.
  2. `[data-testid="nav-dice"]`: quick 3D / standard dice roller.
  3. `[data-testid="nav-inventory"]`: equipment and consumables management.
  4. `[data-testid="nav-tracker"]`: initiative and turn state tracking.
  5. `[data-testid="nav-journal"]`: `PRIVATE`/`PARTY` notes and the handouts gallery.

---

## 6. i18n & Metric Units Specification

### 6.1 Architecture of the `packages/web/src/i18n/` Module

- Global signals:
  - `localeSignal = signal<'en' | 'fr'>('en')`.
  - `unitSystemSignal = signal<'imperial_ft' | 'metric_m'>('imperial_ft')`.
- Translation function `t(key: string, vars?: Record<string, string | number>): string`:
  - Resolves the key in the dictionary for `localeSignal.value`.
  - Replaces `{{var}}` interpolations.
  - If the key is missing, returns the English fallback.
- Every UI string goes through `t()`. English is the canonical dictionary and the French dictionary is complete; a test checks that both dictionaries have the same keys.

### 6.2 Tactical Measurement Formatting

- Unified function: `formatDistanceFt(feet: number): string`.
- Computation rules and ASD-STE100 grammar:
  - IF `unitSystemSignal.value === 'imperial_ft'`:
    - Returns `${feet} ft`.
  - IF `unitSystemSignal.value === 'metric_m'`:
    - Computes `meters = feet * 0.3`.
    - Computes `squares = Math.round(feet / 5)`.
    - Gets the singular/plural grid-square label from `t()` (`squares <= 1` uses the singular key, otherwise the plural key). The English dictionary values are `square` / `squares`; the French dictionary holds the French equivalents.
    - Returns `${meters} m (${squares} ${unit_label})`.
- Normative examples (English locale):
  - `formatDistanceFt(5)` in metric → `"1.5 m (1 square)"`.
  - `formatDistanceFt(30)` in metric → `"9 m (6 squares)"`.

### 6.3 Bilingual Compendium Search

- The bidirectional bilingual dictionary (`compendiumLexicon.ts`) maps French terms to the canonical English slugs, for example the French words for *stealth* → `stealth`, *strength* → `strength`, *fireball* → `fireball` and *short rest* → `short_rest`.
- When the user types in the compendium search bar, the query is normalized: if a lexicon match is found for `localeSignal.value === 'fr'`, the matching canonical slug is also included in the index query, without duplicating the SRD data packs.

---

## 7. Target Files

- Backend (`crates/trame-server`):
  - `crates/trame-server/src/storage/postgres.rs` (SQLx migrations and queries)
  - `crates/trame-server/src/notes.rs` (notes routes, `FilteredNoteDocument`, `LineAnchorNoteMerge`)
  - `crates/trame-server/src/timeline.rs` (journal and timeline)
  - `crates/trame-server/src/room.rs` (`TableRoomActor`, `HandoutRevealed` broadcast)
- Frontend (`packages/web`):
  - `packages/web/src/state/handoutSignals.ts`
  - `packages/web/src/i18n/index.ts`
  - `packages/web/src/i18n/locales/en.ts`
  - `packages/web/src/i18n/locales/fr.ts`
  - `packages/web/src/i18n/compendiumLexicon.ts`
  - `packages/web/src/components/handouts/HandoutRevealModal.tsx`
  - `packages/web/src/components/workspace/DocumentsWorkspaceTab.tsx`
  - `packages/web/src/components/workspace/SessionTimelineViewer.tsx`
  - `packages/web/src/mobile/MobileCompanionView.tsx`
  - `packages/web/src/network/wsClient.ts`
  - `packages/web/src/App.tsx`

---

## 8. Acceptance Criteria & Test Plan

### 8.1 Backend Integration Tests (Rust)

1. `test_notes_rbac_isolation`:
   - Create a `PRIVATE` note for player A.
   - `GET /api/v1/campaigns/{id}/notes/{note_id}` by player B → receives `HTTP 404 Not Found`.
   - `GET /api/v1/campaigns/{id}/notes/{note_id}` by the GameMaster → receives `HTTP 404 Not Found`.
   - Create a `DM_ONLY` note as the GameMaster.
   - `GET /api/v1/campaigns/{id}/notes/{note_id}` by player A → receives `HTTP 403 Forbidden`.
2. `test_party_note_ast_merge_preserves_gm_secrets`:
   - The GameMaster creates a `PARTY` note with a secret: `"Public text\n\n:::dm\nGM secret\n:::\n\nPublic end"`.
   - Player A reads the note and receives `"Public text\n\nPublic end"`.
   - Player A sends a `PUT` with `"Edited public text\n\nPublic end"`.
   - The GameMaster reads the note: the `:::dm\nGM secret\n:::` block is still present in the stored note.
3. `test_reveal_handout_atomicity`:
   - The GameMaster calls `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout` with `handout_id = "clue-1"`.
   - Check that `party_journal_entries` contains a row for `clue-1`.
   - Check that `session_events` contains a `handout_revealed` row.
   - Check that player A can now read the handout through `GET /api/v1/campaigns/{id}/journal`.

### 8.2 Frontend Functional Tests (`node:test` component tests)

1. `test_handout_modal_opens_on_websocket_envelope`:
   - Simulate receiving `ServerEnvelope::HandoutRevealed` on `wsClient`.
   - Check that the `[data-testid="handout-reveal-modal"]` element becomes visible.
   - Click `[data-testid="close-handout-modal"]` and check that the modal disappears.
2. `test_mobile_companion_view_lifecycle`:
   - Resize the viewport to `390px` wide.
   - Check that `[data-testid="mobile-companion-view"]` is rendered in the DOM.
   - Check that the PixiJS `TableCanvas` instance is destroyed and absent from the DOM.
   - Switch to the `[data-testid="nav-journal"]` tab and check that the notes are shown.
3. `test_i18n_formatting_and_units`:
   - Set `localeSignal.value = 'en'` and `unitSystemSignal.value = 'metric_m'`.
   - Check that `formatDistanceFt(5)` returns exactly `"1.5 m (1 square)"`.
   - Check that `formatDistanceFt(30)` returns exactly `"9 m (6 squares)"`.
   - Check that switching to `localeSignal.value = 'fr'` returns the French dictionary's square label.
   - Check that switching to `unitSystemSignal.value = 'imperial_ft'` returns `"30 ft"`.
