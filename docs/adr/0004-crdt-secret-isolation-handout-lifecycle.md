# ADR-0004: Zero-Trust Note Directive Stripping and Handout Reveal Lifecycle

## Status
Accepted

## Context
TRAME provides collaborative campaign Markdown notes supporting `[[Entity]]` wikilink cross-references and Game Master `DirectiveBlock` segments (`:::dm` and `:::handout{id="..." title="..." revealed="false"}`).
If player or spectator clients receive raw unstripped Markdown containing `:::dm` secret blocks or unrevealed `:::handout` blocks, secret campaign lore leaks over the network and into browser memory.

## Decision
1. **Zero-Trust Server-Side Role Filtering (`FilteredNoteDocument`)**:
   - Before any campaign note is returned over HTTP or broadcast over WebSocket to a recipient with `UserRole::Player` or `UserRole::Spectator`, `trame-server` parses all fenced `DirectiveBlock` ranges (`:::dm` and `:::handout`) using quote-aware attribute parsing (`parse_handout_revealed_attr`).
   - All `:::dm` blocks and all `:::handout` blocks where `revealed != "true"` are completely stripped on the server prior to serialization.
   - Recipients with `UserRole::GameMaster` receive the complete, unstripped Markdown source.
2. **Canonical Handout Directive Grammar**:
   - Handout blocks follow the normalized key-value syntax: `:::handout{id="<id>" title="<string>" revealed="<true|false>"}`.
3. **Handout Reveal Lifecycle (`reveal_handout`)**:
   - When the Game Master triggers `[ Reveal to Party ]`, the client dispatches `RevealHandoutCommand`.
   - `trame-server` verifies Game Master role, updates the note block attribute to `revealed="true"`, persists the entry in `PartyJournalStorage` (`party_journal_entries`), appends a `HandoutRevealed` event to `TimelineStorage` (`session_timeline_events`), and broadcasts `handout.revealed` so connected player clients immediately display the handout modal.

## Consequences
### Positive
- Zero-trust information security: unrevealed secrets never cross the wire to non-GM clients.
- Quote-aware attribute parsing prevents injection traps inside handout titles.
- Revealed handouts are durably archived in both the Party Journal and Session Timeline.

### Negative
- Server must filter note documents per recipient role before transmission.
