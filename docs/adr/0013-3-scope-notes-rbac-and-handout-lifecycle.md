# ADR-0034: Zero-Trust Notes RBAC Model (3 Scopes) and Transactional Handout Lifecycle

## Status
Accepted

## Context
In TRAME, campaign participants require collaborative documentation capabilities while strictly enforcing secrecy boundaries.
Players draft private notes that must remain confidential from both peer players and the Game Master (zero-trust).
Campaign participants collaborate on shared party wiki documents (`PARTY`).
Game Masters author private campaign lore (`DM_ONLY`) and embed inline confidential directives (`:::dm`) or revealable documents (`:::handout`).
When a player edits a shared `PARTY` note whose stored version contains confidential directives stripped on the client by `FilteredNoteDocument`, submitting a mutation must not overwrite or delete those hidden directives.

## Decision
1. **Three-Tier Note Visibility Model (`NoteVisibility`)**:
   - `PRIVATE`: Bound strictly to `owner_user_id`. Unauthorized requests return HTTP 404 Not Found to prevent entity enumeration.
   - `PARTY`: Accessible in read and write mode for `GameMaster` and `Player` roles. `Spectator` role retains read-only access.
   - `DM_ONLY`: Accessible exclusively to `GameMaster` role. Unauthorized requests return HTTP 403 Forbidden.
2. **Server-Side Structural AST Preservation for Player Mutations**:
   - When a non-GM user mutates a `PARTY` note via `PUT /api/v1/campaigns/{id}/notes/{note_id}`, `trame-server` extracts confidential directive blocks (`:::dm` and unrevealed `:::handout`) from the stored document.
   - `trame-server` executes `merge_party_note_ast` to preserve confidential blocks at their original positions before persistence.
3. **Transactional Handout Lifecycle and Decoupling**:
   - Handout reveals execute via `TrameCommand::RevealHandout` or `POST /api/v1/campaigns/{id}/notes/{note_id}/reveal-handout`.
   - Within a single transaction, `trame-server` sets `revealed="true"`, upserts into `party_journal_entries`, appends a `handout_revealed` event to `session_events`, and broadcasts `HandoutRevealed` to connected clients.
   - Handouts archived in `party_journal_entries` remain persistent even if the parent note is subsequently edited or deleted.

## Consequences
### Positive
- Information security is guaranteed with zero confidential directives leaking across the network to non-GM clients.
- Collaborative party note editing does not cause accidental loss of GM secrets.
- Revealed handouts remain durable and accessible in the party journal.

### Negative
- Server must execute AST structural merge during player mutations on notes containing confidential directives.
- Strict enforcement of HTTP 404 versus HTTP 403 status codes is required.
