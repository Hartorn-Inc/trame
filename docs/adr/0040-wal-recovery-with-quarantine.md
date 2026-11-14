# ADR-0040: WAL Recovery with `QuarantinedWalEntry` Quarantine

## Status
Accepted (2026-11-05). Records decision D4 of [`spec-internet-ready-playable-trame.md`](../specs/spec-internet-ready-playable-trame.md). Refines the dual persistence model (snapshot + immediate WAL commit) of `04-RUNTIME-AND-DEDICATED-HOSTING.md` and the hibernation flow of [ADR-0005](./0005-cloud-run-scale-to-zero-and-sigterm-hibernation.md).

## Context
`TableRoomActor` persists a campaign as the latest `TableStateSnapshot` plus the WAL entries appended after it. On wake, `recover_table_state` loads the snapshot and replays every later entry in order; the first entry that fails aborts recovery with `WalError::ReplayFailed`, and the room refuses to open.

The 2026-11-05 realtime audit found that this model loses or locks campaigns:
- **Undo then crash (RT3, verified).** The 50-entry `UndoEntry` ring lives only in memory. After a restart, replaying an `UndoLastAction` entry finds an empty ring and fails, so the campaign becomes unloadable until someone edits the database by hand.
- **MCP staging (RT3).** `McpStagingProposal`s are not written to the WAL, so pending proposals made after the last snapshot vanish on restart.
- **Append failure (RT5).** The command is applied in memory before the WAL append; if the append fails, memory runs ahead of disk and players see a state that was never saved.
- **Snapshot failure (RT5).** A failed snapshot write aborts a command that had already been applied and appended.
- **Dead actor (RT9).** When a room actor task ends, its handle stays in the registry, so the campaign stays unreachable until the process restarts.
- **Silent rejections (RT10).** Some error paths reply `CommandRejected` without the client's correlation id, so the client cannot tell which action failed.

## Considered Options
1. **Persist the undo ring in the snapshot.** Rejected: it multiplies snapshot size by up to 50 table states and still leaves any other replay failure fatal.
2. **Skip only the failing entry and keep replaying.** Rejected: later entries were validated against a state that included the skipped one, so replaying them on a different state can silently corrupt the table.
3. **Snapshot after undo, and quarantine the failing entry with every later entry (Recommended).** The room always opens at a state that was valid when it was saved, and nothing is discarded without a trace.

## Decision
1. **Snapshot after undo.** After `UndoLastAction`, the room writes a snapshot, as composite batches already do. An undo never has to be replayed from the WAL.
2. **MCP staging in the WAL.** MCP staging proposals are written to the WAL so they replay after a restart.
3. **Quarantine on replay failure.** Replay applies entries in order on top of the latest snapshot. When an entry fails, it and every later entry are moved to a `QuarantinedWalEntry` table (campaign, sequence, payload, error, timestamp). The room opens at the last good state, writes a fresh snapshot, and emits a Game Master-only event that the frontend shows as a banner describing what was set aside. Quarantined entries are kept for inspection and are never replayed automatically.
4. **Append rollback.** Command execution clones the state and sequence before applying. If the WAL append fails, the room restores the clone and rejects the command, so memory never runs ahead of disk.
5. **Non-fatal snapshot.** A snapshot failure is logged; the command, already durable in the WAL, still commits and broadcasts.
6. **Correlation ids.** `CommandRejected` carries the client's correlation id on every error path.
7. **Actor supervision.** When a room actor task ends for any reason, its handle is removed from the registry, so the next connection starts a fresh actor that recovers from storage.
8. **Undo ring stays in memory.** The ring is not persisted. Undo history is lost on restart; this is an accepted trade-off, documented to Game Masters.

## Consequences
### Positive
- No single bad WAL entry can lock a campaign; the worst case is losing the actions after it, which the Game Master can see and redo by hand.
- What players see always matches what was persisted, and every failed command reaches the right client action.
- A crashed room recovers on the next connection without a server restart.

### Negative
- Quarantine can drop valid actions that came after the failing one; the banner makes the loss visible but does not undo it.
- Every undo costs a snapshot write.
- Undo history does not survive a restart or a hibernation.
- Cloning state before each command adds memory and CPU cost proportional to the table size.
