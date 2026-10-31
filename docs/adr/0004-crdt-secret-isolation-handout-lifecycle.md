# ADR-0004: Zero-Trust Note Directive Stripping, 3-Scope RBAC, and Handout Reveal Lifecycle

## Status
Accepted

## Context
TRAME provides collaborative campaign Markdown notes supporting `[[Entity]]` wikilink cross-references and Game Master `DirectiveBlock` segments (`:::dm` and `:::handout{id="..." title="..." revealed="false"}`).
If player or spectator clients receive raw unstripped Markdown containing `:::dm` secret blocks or unrevealed `:::handout` blocks, secret campaign lore leaks over the network and into browser memory.

Furthermore, campaign collaboration requires strict role isolation:
1. Players must draft private notes hermetic from other players and the Game Master (zero-trust).
2. Players and Game Masters must collaborate on shared team notes (`PARTY`).
3. Game Masters must maintain private lore notes (`DM_ONLY`) and embed inline secret directives (`:::dm`) or revealable documents (`:::handout`).
4. When a player edits a shared `PARTY` note containing Game Master confidential blocks stripped on the client by `FilteredNoteDocument`, submitting `PUT` mutations must not delete or overwrite the hidden directives.

## Decision
1. **Zero-Trust Server-Side Role Filtering (`FilteredNoteDocument`)**:
   - Before any campaign note is returned over HTTP or broadcast over WebSocket to a recipient with `UserRole::Player` or `UserRole::Spectator`, `trame-server` parses all fenced `DirectiveBlock` ranges (`:::dm` and `:::handout`) using quote-aware attribute parsing (`parse_handout_revealed_attr`).
   - All `:::dm` blocks and all `:::handout` blocks where `revealed != "true"` are completely stripped on the server prior to serialization.
   - Recipients with `UserRole::GameMaster` receive the complete, unstripped Markdown source.
2. **Canonical Handout Directive Grammar**:
   - Handout blocks follow the normalized key-value syntax: `:::handout{id="<id>" title="<string>" revealed="<true|false>"}`.
3. **3-Tier Note Visibility Model (`NoteVisibility`)**:
   - `PRIVATE`: Bound strictly to `owner_user_id`. The server verifies user identity: requests by non-owners return `HTTP 404 Not Found` (zero-trust policy preventing entity enumeration).
   - `PARTY`: Accessible in read and write mode for `UserRole::GameMaster` and `UserRole::Player`. Users with `UserRole::Spectator` retain strict read-only access (`HTTP 403 Forbidden` on mutation).
   - `DM_ONLY`: Accessible exclusively to `UserRole::GameMaster`. Any non-GM access returns `HTTP 403 Forbidden`.
4. **Structural AST Preservation during Player Mutations**:
   - When a user with `role != UserRole::GameMaster` submits `PUT /api/v1/campaigns/{id}/notes/{note_id}` on a `PARTY` note, `trame-server` loads the stored database record.
   - If the stored document contains confidential directives (`:::dm` or `:::handout` with `revealed="false"`) stripped from the client payload, `trame-server` executes an AST structural merge preserving the hidden blocks at their original positions before database persistence.
5. **Transactional Handout Reveal Lifecycle (`TrameCommand::RevealHandout`)**:
   - Handout reveals execute via WebSocket `TrameCommand::RevealHandout { campaign_id, note_id, handout_id }` or REST endpoint `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
   - Within an atomic SQL transaction, `trame-server`:
     1. Updates the directive attribute to `revealed="true"` in the note Markdown source.
     2. Inserts or updates the autonomous entry in `party_journal_entries` (`ON CONFLICT (handout_id) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, revealed_at = EXCLUDED.revealed_at`).
     3. Appends a `handout_revealed` event to `session_events` with the current monotonic `seq_id`.
   - `trame-server` broadcasts `ServerEnvelope::HandoutRevealed` to all connected campaign clients so the client mounts `HandoutRevealModal`.
   - The entry in `party_journal_entries` is autonomous: subsequent edits or deletion of the parent note do not delete the revealed document from the Party Journal.

## Consequences
### Positive
- Zero-trust information security: unrevealed secrets never cross the wire to non-GM clients.
- Player personal notes remain hermetic even from the Game Master.
- AST structural merge prevents accidental secret deletion during collaborative player edits.
- Quote-aware attribute parsing prevents injection traps inside handout titles.
- Revealed handouts are durably archived in both `party_journal_entries` and `session_events`.

### Negative
- Server must execute AST parsing and merge during player `PUT` requests on `PARTY` notes containing secret blocks.
- Strict HTTP status code enforcement (`404 Not Found` for foreign `PRIVATE` notes, `403 Forbidden` for `DM_ONLY`).
