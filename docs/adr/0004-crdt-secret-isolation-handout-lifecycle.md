# ADR-0004: Zero-Trust Note Directive Stripping, 3-Scope RBAC, and Handout Reveal Lifecycle

## Status
Accepted

## Context
TRAME provides collaborative campaign Markdown notes supporting `[[Entity]]` wikilink cross-references and Game Master `DirectiveBlock` segments (`:::dm` and `:::handout{id="..." title="..." revealed="false"}`).
Previously, players could not create or edit campaign notes because the Markdown editor was restricted to Game Masters (`{isGm && ...}`). Furthermore, campaign notes lacked strict authorization boundaries separating private player notes, shared party documentation, and Game Master secrets.

To support player agency without compromising secret lore:
1. Players must keep private campaign notes (`PRIVATE`) invisible to other players and the Game Master (zero-trust security).
2. The party requires a shared collaboration space (`PARTY`) editable by players and the Game Master.
3. The Game Master requires confidential notes (`DM_ONLY`) and inline secret directives (`:::dm` and unrevealed `:::handout`) embedded within shared notes.
4. When a player edits a shared note containing server-filtered GM directives, saving the note (`PUT /api/v1/campaigns/{id}/notes/{note_id}`) must never overwrite or delete the hidden directives.
5. Handout documents revealed to the party must persist durably in `PartyJournalStorage` (`party_journal_entries`) independently of future edits or deletions of the source note.

## Decision
1. **3-Scope Note Visibility Model (`NoteVisibility`)**:
   - `PRIVATE`: Bound strictly to `owner_user_id`. The server enforces zero-trust access: unauthorized queries return `HTTP 404 Not Found` to prevent entity enumeration.
   - `PARTY`: Read and write access for `UserRole::GameMaster` and `UserRole::Player`. `UserRole::Spectator` has strict read-only access.
   - `DM_ONLY`: Accessible exclusively by `UserRole::GameMaster`. Non-GM access returns `HTTP 403 Forbidden`.
2. **Zero-Trust Server-Side Role Filtering (`FilteredNoteDocument`)**:
   - Before returning any note over HTTP or broadcasting over WebSocket to `UserRole::Player` or `UserRole::Spectator`, `trame-server` parses all fenced `DirectiveBlock` ranges (`:::dm` and `:::handout`) using quote-aware attribute parsing (`parse_handout_revealed_attr`).
   - All `:::dm` blocks and all `:::handout` blocks where `revealed != "true"` are completely stripped on the server prior to serialization.
   - Recipients with `UserRole::GameMaster` receive the complete, unstripped Markdown source.
3. **Canonical Handout Directive Grammar**:
   - Handout blocks follow the normalized syntax: `:::handout{id="<id>" title="<string>" revealed="<true|false>"}`.
4. **Structural Preservation of Hidden Directives on Player Mutations (AST Merge)**:
   - When a non-GM user submits `PUT /api/v1/campaigns/{id}/notes/{note_id}` for a `PARTY` note, `trame-server` loads the stored database document.
   - If the stored document contains hidden `:::dm` or unrevealed `:::handout` directives absent from the submitted text, `trame-server` executes a structural AST merge, restoring the confidential blocks to their original positions before persisting changes.
5. **Transactional Handout Reveal Lifecycle (`TrameCommand::RevealHandout`)**:
   - Handout reveal triggers via `TrameCommand::RevealHandout { campaign_id, note_id, handout_id }` over WebSocket or `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
   - In a single atomic SQL transaction, `trame-server`:
     1. Updates `revealed="true"` in the note Markdown source.
     2. Inserts or updates the entry in `party_journal_entries` (`ON CONFLICT (handout_id) DO UPDATE`).
     3. Appends a `handout_revealed` event to `session_events` with the current monotonic `seq_id`.
   - `trame-server` broadcasts `ServerEnvelope::HandoutRevealed` to all connected clients, causing `HandoutRevealModal` (`[data-testid="handout-reveal-modal"]`) to mount.
   - The `party_journal_entries` record is autonomous: subsequent edits or deletions of the source note do not affect the revealed handout.

## Consequences
### Positive
- Zero-trust security: private notes and unrevealed GM secrets never cross the wire to unauthorized clients.
- Structural AST merge prevents accidental loss of GM secrets during collaborative party note editing.
- Revealed handouts persist durably and independently in the Party Journal and Session Timeline.

### Negative
- Server must parse and filter note documents per recipient role before transmission.
- Server must perform AST reconciliation when non-GM users update `PARTY` notes containing hidden blocks.
