# ADR-0034: Zero-Trust 3-Scope Notes RBAC and Transactional Handout Lifecycle

- **Status**: Accepted
- **Date**: 2026-10-31
- **Context**: Issue #80, ADR-0004, ADR-0009

## Context

Campaign participants require three distinct note scopes: personal player notes (`PRIVATE`) hidden from all other users (including the GM), collaborative party wiki notes (`PARTY`), and secret GM prep notes (`DM_ONLY`). Additionally, when a player edits a `PARTY` note that originally contained GM-only inline directives (`:::dm` or unrevealed `:::handout`), saving the player's edit must never overwrite or erase the hidden GM blocks.

## Decision

1. **Three-Scope Visibility Model (`NoteVisibility`)**:
   - `PRIVATE`: Bound strictly to `owner_user_id`. Unauthorized access returns `HTTP 404 Not Found` to prevent enumeration.
   - `PARTY`: Readable and editable by `UserRole::GameMaster` and `UserRole::Player`; read-only for `UserRole::Spectator`.
   - `DM_ONLY`: Accessible exclusively to `UserRole::GameMaster`; non-GM requests return `HTTP 403 Forbidden`.
2. **Structural Preservation of Masked Directives on Player Edits**:
   - When a player submits `PUT /api/v1/campaigns/{id}/notes/{note_id}` on a `PARTY` note, `trame-server` preserves existing `:::dm` and unrevealed `:::handout` blocks from the stored document AST.
3. **Transactional Handout Lifecycle**:
   - Revealing a handout atomically marks `revealed="true"` on the source directive, upserts an immutable entry in `party_journal_entries`, appends a `handout_revealed` record to `session_events`, and broadcasts `ServerEnvelope::HandoutRevealed`.

## Consequences

- Zero-trust confidentiality is enforced server-side for both `PRIVATE` player notes and `DM_ONLY` / inline GM secrets.
- Revealed handouts remain permanently accessible in the Party Journal even if the source note is later modified.
