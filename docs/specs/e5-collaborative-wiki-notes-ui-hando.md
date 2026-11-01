# Technical & Functional Specification: Collaborative Wiki, Handout Reveal, Session Timeline and Mobile Companion Mode

## 1. Goal and Scope

This document specifies the implementation of four integrated components of the TRAME platform (`packages/web` and `crates/trame-server`):
1. **Collaborative Markdown wiki editor**: compendium links `[[Entity]]` with autocompletion, real-time multi-cursor editing through Yjs/`yrs`, and secure handling of the `:::dm` and `:::handout` directive blocks (`DirectiveBlock`).
2. **Handout reveal modal and party journal**: the Game Master triggers the `[ Reveal to Party ]` action, every connected player immediately sees the handout full-screen (`HandoutRevealModal`), and the handout is archived persistently in the party journal (`PartyJournalEntry`).
3. **Append-only session timeline (`SessionTimelineEvent`)**: a persistent log of session events, exposed over WebSocket, a REST endpoint and an MCP server tool (`get_session_timeline`).
4. **Decoupled mobile companion mode (< 768 px, `MobileCompanionView`)**: a lightweight touch layout with five tabs that never creates the PixiJS application or WebGL Framebuffer Objects (FBO) on screens narrower than 768 pixels.

> **Implementation status:** the web client reveals handouts through `POST /api/v1/campaigns/{id}/handouts/{handout_id}/reveal`, which applies `TrameCommand::RevealHandout` and broadcasts `ServerEnvelope::HandoutRevealed` (see `spec-3-scope-wiki-notes-private-part.md`, section 4). The notes REST contract is described there as well.

---

## 2. Data Model and Protocol Architecture

### 2.1 Canonical Markdown Directive Grammar

Note documents are UTF-8 Markdown text.
Interactive directives strictly follow this key-value syntax:

```text
:::handout{id="<uuid>" title="<title>" revealed="<boolean>"}
Content of the document to reveal (text, Markdown or image)
:::

:::dm
Notes and secrets reserved exclusively for the Game Master
:::
```

- Directive attributes require double quotes.
- The title can contain spaces and punctuation without breaking the parser.
- `:::dm` blocks have no attributes and hide their entire text content from non-GM clients.

### 2.2 CRDT Synchronization Architecture and Zero-Trust Isolation

To prevent secret leaks without breaking CRDT state vectors:
1. Clients connected with the `GameMaster` role join the authoritative Yjs/`yrs` room through the WebSocket channel `notes:{note_id}:dm`.
2. Clients connected with the `Player` or `Spectator` role NEVER connect to the raw Yjs/`yrs` CRDT room.
3. Non-GM clients subscribe to the WebSocket broadcast channel `notes:{note_id}:public`.
4. When the Game Master updates the Yjs document, `trame-server` runs the pure transformation function `FilteredNoteDocument::filter_for_role(raw_content, role)`:
   - If `role == UserRole::GameMaster`, the full raw content is kept.
   - If `role != UserRole::GameMaster`, the AST compiler removes every block delimited by `:::dm` and every `:::handout` block whose `revealed` attribute equals `"false"`.
5. `trame-server` broadcasts the resulting sanitized Markdown snapshot as a `notes.snapshot` JSON message on the `notes:{note_id}:public` channel.
6. When a `Player` saves a `PARTY` note, `trame-server` reinserts the hidden blocks at their original line-anchored positions (`LineAnchorNoteMerge`) before persisting, so a player edit never deletes or exposes GM secrets.

### 2.3 Party Journal SQL Persistence Schema

Revealed handouts are persisted in the PostgreSQL table `party_journal_entries`:

```sql
CREATE TABLE IF NOT EXISTS party_journal_entries (
    handout_id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    revealed_at BIGINT NOT NULL,
    revealed_by VARCHAR(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_party_journal_campaign ON party_journal_entries(campaign_id, revealed_at DESC);
```

### 2.4 Session Timeline SQL Persistence Schema

The session timeline relies on a strict append-only event log:

```sql
CREATE TABLE IF NOT EXISTS session_events (
    id BIGSERIAL PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    session_num INT NOT NULL,
    session_id VARCHAR(64) GENERATED ALWAYS AS (campaign_id || ':' || session_num) STORED,
    seq_id BIGINT NOT NULL,
    timestamp BIGINT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    actor_id VARCHAR(64),
    payload_json JSONB NOT NULL,
    CONSTRAINT uq_session_seq UNIQUE (campaign_id, session_num, seq_id)
);

CREATE INDEX IF NOT EXISTS idx_session_events_lookup ON session_events(campaign_id, session_num, seq_id ASC);
```

Supported event types (`event_type`):
- `DiceRolled`: a dice roll with its numeric result.
- `CombatRoundStarted`: a new combat round has started.
- `RoomTransitioned`: the party moved to a new room or scene.
- `HandoutRevealed`: a clue or document was revealed to the table.

---

## 3. Application Interfaces and API Contracts

### 3.1 Real-Time WebSocket Commands and Messages

#### Reveal Request Sent by the Game Master (Client -> Server)
`POST /api/v1/campaigns/{campaign_id}/handouts/{handout_id}/reveal` (GM only). The body is optional; the server reads the handout title and content from the campaign notes and applies the `RevealHandout` command to the live room.
```json
{
  "session_num": 4
}
```

#### Reveal WebSocket Broadcast (Server -> All Connected Clients)
```json
{
  "event": "handout.revealed",
  "handout_id": "h-456",
  "title": "Intercepted letter",
  "content": "Meet at midnight at the old mill.",
  "revealed_by": "user-gm-1",
  "timestamp": 1717171200000
}
```

### 3.2 Timeline REST Endpoint

- **Route**: `GET /api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline`
- **Access**: requires campaign membership; events are filtered by role.
- **Query parameters**: `after` (optional integer, default `0`), `limit` (optional integer, default `50`, maximum `200`).
- **HTTP 200 response**:
```json
{
  "campaign_id": "camp-123",
  "session_num": 4,
  "session_id": "camp-123:4",
  "events": [
    {
      "seq_id": 1,
      "timestamp": 1717171000000,
      "event_type": "DiceRolled",
      "actor_id": "char-789",
      "payload": { "expression": "1d20+5", "total": 19 }
    },
    {
      "seq_id": 2,
      "timestamp": 1717171200000,
      "event_type": "HandoutRevealed",
      "actor_id": "user-gm-1",
      "payload": { "handout_id": "h-456", "title": "Intercepted letter" }
    }
  ],
  "has_more": false
}
```

### 3.3 MCP Tool Contract (`get_session_timeline`)

- **Tool name**: `get_session_timeline`
- **Input schema**:
```json
{
  "type": "object",
  "properties": {
    "campaign_id": { "type": "string" },
    "session_num": { "type": "integer" }
  },
  "required": ["campaign_id", "session_num"]
}
```
- **Returned MCP resource URI**: `campaign://{campaign_id}/sessions/{session_num}/timeline` (the session number and cursor are read from the URI).
- **Text payload**: a chronological transcript ordered by `seq_id`, formatted as Markdown for ingestion by the generative AI model.

---

## 4. Business Rules and Deterministic Invariants (ASD-STE100)

### 4.1 Note Editing and Confidentiality Invariants
1. `trame-server` MUST forbid any client without the `GameMaster` role from subscribing to the Yjs channel `notes:{note_id}:dm`.
2. WHEN a client without the `GameMaster` role tries to subscribe to `notes:{note_id}:dm`, THEN `trame-server` MUST reject the subscription with the `FORBIDDEN` error code.
3. WHEN `trame-server` serializes a note document for a client without the `GameMaster` role, `trame-server` MUST remove every `:::dm` block from the document body.
4. WHEN `trame-server` serializes a note document for a client without the `GameMaster` role, `trame-server` MUST remove every `:::handout` block whose `revealed` attribute equals `"false"`.
5. IF a `:::handout` block has the attribute `revealed="true"`, THEN `trame-server` MUST keep the block in the public snapshot.

### 4.2 Handout Reveal Invariants
1. Only a user with the `GameMaster` role can send the `RevealHandout` command (`POST .../handouts/{handout_id}/reveal`).
2. WHEN `trame-server` accepts the `RevealHandout` command, THEN `trame-server` MUST record the matching entry in the `party_journal_entries` table.
3. WHEN `trame-server` accepts the `RevealHandout` command, THEN `trame-server` MUST insert a `HandoutRevealed` event in the `session_events` table.
4. WHEN `trame-server` persists a handout reveal, THEN `trame-server` MUST broadcast the `handout.revealed` event to every client connected to the campaign.
5. WHEN the `packages/web` client receives the `handout.revealed` event, THEN `packages/web` MUST show the `HandoutRevealModal` component with the handout's title and text.

### 4.3 Mobile Companion Mode Invariants (< 768 px)
1. IF the browser window width (`window.innerWidth`) is strictly less than 768 pixels, THEN `packages/web` MUST enable mobile companion mode.
2. WHEN mobile companion mode is active, `packages/web` MUST mount the root `MobileCompanionView` component.
3. WHEN mobile companion mode is active, `packages/web` MUST NOT create the PixiJS `Application` class.
4. WHEN mobile companion mode is active, `packages/web` MUST NOT allocate a WebGL Framebuffer Object (FBO).
5. WHEN mobile companion mode is active, `MobileCompanionView` MUST show five navigation buttons with the selectors `tab-button-sheet`, `tab-button-dice`, `tab-button-inventory`, `tab-button-tracker` and `tab-button-journal`, each with a touch target of at least 44x44 px.
6. WHEN the user clicks a navigation button, `MobileCompanionView` MUST mount the matching view identified by its `data-testid` attribute (`tab-sheet`, `tab-dice`, `tab-inventory`, `tab-tracker` or `tab-journal`).
7. IF the browser window width is greater than or equal to 768 pixels, THEN `packages/web` MUST mount the `TableCanvas` component.

### 4.4 Session Timeline Invariants
1. `trame-server` MUST assign every event in `session_events` a strictly increasing `seq_id` that is unique for the `(campaign_id, session_num)` pair.
2. WHEN two commands concurrently create events for the same session, `trame-server` MUST serialize `seq_id` assignment through the database transaction.
3. The `GET /api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline` API MUST return events sorted by `seq_id ASC`.

---

## 5. Test Strategy and Automated Validation

Per the CI alignment guidelines, the frontend test suite uses only the native Node 24 runtime (`node:test` and `node:assert/strict`).

### 5.1 Backend Test Matrix (`crates/trame-server`)

1. `test_filter_for_role_purges_dm_and_unrevealed_handouts`:
   - Input: a Markdown string with one `:::dm` block and two `:::handout` blocks (one with `revealed="false"`, one with `revealed="true"`).
   - Execution: `FilteredNoteDocument::filter_for_role(input, UserRole::Player)`.
   - Assertion: the output contains no fragment of the `:::dm` block or of the unrevealed handout, and keeps the revealed handout in full.
2. `test_filter_for_role_preserves_everything_for_gamemaster`:
   - Input: the same Markdown document.
   - Execution: `FilteredNoteDocument::filter_for_role(input, UserRole::GameMaster)`.
   - Assertion: the output is strictly identical to the source document.
3. `test_reveal_handout_inserts_journal_and_session_event`:
   - Execution: send the `RevealHandout` command with a session and handout identifier.
   - Assertion: `party_journal_entries` contains the new row; `session_events` contains a `HandoutRevealed` event with `seq_id == 1`.
4. `test_session_timeline_sequential_ordering_under_concurrency`:
   - Execution: insert 50 session events concurrently from parallel threads.
   - Assertion: every `seq_id` is contiguous, without duplicates, and strictly ordered from 1 to 50.

### 5.2 Frontend Test Matrix (`packages/web`)

1. `test_mobile_companion_mode_bypasses_pixijs_canvas`:
   - Environment: simulated viewport 500 pixels wide.
   - Render: mount the application root component.
   - Assertion: `document.querySelector('[data-testid="table-canvas"]')` is strictly `null`; the PixiJS constructor was never called.
2. `test_desktop_mode_mounts_table_canvas`:
   - Environment: simulated viewport 1024 pixels wide.
   - Render: mount the application root component.
   - Assertion: `document.querySelector('[data-testid="table-canvas"]')` is present in the DOM.
3. `test_mobile_companion_tab_navigation`:
   - Environment: 500-pixel viewport.
   - Actions: successive clicks on `tab-button-sheet`, `tab-button-dice`, `tab-button-inventory`, `tab-button-tracker` and `tab-button-journal`.
   - Assertions: deterministic display of the `tab-sheet`, `tab-dice`, `tab-inventory`, `tab-tracker` and `tab-journal` containers.
4. `test_handout_reveal_modal_rendering_on_event`:
   - Action: dispatch the `handout.revealed` WebSocket event.
   - Assertion: the `[data-testid="handout-reveal-modal"]` container appears and shows the broadcast document's title and content.
