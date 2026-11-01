# ADR-0013: 3-Scope Wiki Notes Zero-Trust RBAC and Live Handout Lifecycle

## Status
Accepted

## Context
TRAME collaborative campaign notes support markdown formatting, `[[Entity]]` compendium wikilinks, and Game Master directives (`:::dm` secret blocks and `:::handout` reveal blocks). Without strict server-side access control:
1. Non-GM players could inspect raw markdown containing confidential plot information or unrevealed puzzles in browser memory or network payloads.
2. In a shared wiki note (`PARTY`), player edits could inadvertently overwrite or delete GM secret directives embedded in the document.
3. The Game Master needs a reliable mechanism to reveal handouts to all connected players during live play with persistent archival.

## Decision
1. **3-Tier Note Visibility Scope (`NoteVisibility`)**:
   - `PRIVATE`: Author-only notes. Third-party users and the Game Master receive `404 Not Found` upon access attempts.
   - `PARTY`: Shared collaborative wiki notes readable and writable by both players and Game Masters.
   - `DM_ONLY`: Confidential notes accessible and visible exclusively to the Game Master; non-GM requests receive `403 Forbidden`.
2. **Server-Side Sanitization (`FilteredNoteDocument`)**:
   - For non-GM recipients (`UserRole::Player`, `UserRole::Spectator`), `trame-server` filters markdown by completely stripping all `:::dm` blocks and any `:::handout` block with `revealed="false"` prior to network transmission.
   - Game Masters receive unstripped markdown.
3. **AST Preservation on Note Mutations (`merge_party_note_ast`)**:
   - When players submit updates to `PARTY` notes, `trame-server` parses the document AST and reinserts any confidential `:::dm` and unrevealed `:::handout` blocks present in storage, preventing accidental deletion.
4. **Handout Reveal Lifecycle (`reveal_handout`)**:
   - The Game Master triggers `RevealHandoutCommand` to publish a handout.
   - The server verifies GM authorization, updates `revealed="true"` in the source note, persists the handout in `party_journal_entries`, records the event in `session_events`, and broadcasts `HandoutRevealed` to all connected clients.

## Consequences
### Positive
- Secrets and unrevealed clues cannot leak across the network to unauthorized players.
- Player edits to party notes cannot erase GM-authored hidden blocks.
- Handouts are permanently archived in the party journal independently of note lifecycles.

### Negative
- Requires server AST parsing and re-filtering on document access and mutation.