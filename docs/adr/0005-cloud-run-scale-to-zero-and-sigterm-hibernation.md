# ADR-0005: Cloud Run Scale-to-Zero and SIGTERM Graceful Shutdown

## Status
Accepted

## Context
TRAME supports cost-optimized cloud hosting on Google Cloud Run configured with `min-instances = 0` and `max-instances = 1`. Under this configuration, the platform terminates idle container instances after 15 minutes of zero active mutations (`Idle-Lease`). When Cloud Run scales down or evicts an instance, it transmits a `SIGTERM` POSIX signal to the container process before sending `SIGKILL`.

If the server terminates without serializing in-memory `TableRoomActor` states, players lose unstaged token positions, wall modifications, and combat tracker turns.

## Decision
1. Deploy `trame-server` with `min-instances = 0` and `max-instances = 1` using Terraform and Cloud Run service definitions.
2. Register a POSIX signal listener targeting `SIGINT` and `SIGTERM` within `crates/trame-server/src/main.rs`.
3. Implement a Graceful Shutdown Sequence:
   - When `SIGTERM` is received, `trame-server` stops accepting new real-time room mutations.
   - The server invokes `RoomLeaseManager::hibernate_all()`, which commands every active `TableRoomActor` to flush its latest `TableStateSnapshot` to `SqlxPostgresStore` within a bounded 10-second timeout.
   - The server closes database pool connections and terminates with exit code 0.
4. Implement an unauthenticated `/healthz` probe endpoint that executes a lightweight readiness check within a 5-millisecond budget without hydrating campaign state or acquiring room locks.

## Consequences
### Positive
- Cloud hosting costs drop to zero during inactive campaign periods.
- State durability is guaranteed on container preemption and scale-down events.

### Negative
- Cloud Run imposes a cold-start latency (~300-500 ms) when an inactive instance wakes.
