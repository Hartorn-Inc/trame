# ADR-0034: Zero-Trust 3-Scope Notes RBAC and Transactional Handout Lifecycle

- **Status**: Accepted
- **Date**: 2025-05-18
- **Authors**: TRAME Architecture Team
- **Context**: Issue #80, ADR-0004, ADR-0009

## Context

Players previously could not author or edit campaign notes because Markdown editing was gated behind GameMaster role checks. Furthermore, note storage lacked isolation between private player logs, shared team wikis, and GameMaster secret lore.

Players must document personal history without surveillance from other players or the Game Master. Players also collaborate on a shared wiki. The Game Master must keep secret notes and embed confidential directive blocks (`:::dm` and `:::handout`) without network leakage to player clients.

## Decision

1. **3-Scope Note Visibility Model (`NoteVisibility`)**:
   - `PRIVATE`: Bound strictly to `owner_user_id`. Unauthorized queries return `HTTP 404 Not Found` to prevent enumeration.
   - `PARTY`: Read and write access for `UserRole::GameMaster` and `UserRole::Player`. `UserRole::Spectator` has strict read-only access.
   - `DM_ONLY`: Accessible exclusively to `UserRole::GameMaster`. Non-GM queries return `HTTP 403 Forbidden`.

2. **Directive Preservation on Player Note Updates**:
   - When non-GM users update a `PARTY` note, `trame-server` preserves existing confidential blocks (`:::dm` and unrevealed `:::handout`) at their original AST positions.

3. **Decoupled Handout Persistence**:
   - Revealed handouts persist in `party_journal_entries` independently of future edits or deletions of the source note.
   - Broadcast frames (`ServerEnvelope::HandoutRevealed`) notify connected clients.

## Consequences

### Positive
- Strict zero-trust privacy for player personal notes.
- Safe collaborative editing on shared party notes without secret block deletion.
- Durable persistence of revealed handouts in party journal storage.

### Negative
- Server must execute structural AST merging for player updates on shared notes containing confidential blocks.
