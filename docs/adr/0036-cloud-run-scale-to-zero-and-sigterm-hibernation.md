# ADR-0036: Cloud Run Scale-to-Zero and SIGTERM Graceful Shutdown

## Status
Accepted

## Context
TRAME supports cost-optimized cloud hosting on Google Cloud Run configured with `min-instances = 0` and `max-instances = 1`. Under this configuration, the platform terminates idle container instances after 15 minutes of zero HTTP/WebSocket traffic. When Cloud Run scales down or evicts an instance, it transmits a `SIGTERM` POSIX signal to the container process. The platform allows a grace period before sending `SIGKILL`.

If the server terminates without serializing in-memory Table Room actor states, players lose unstaged token positions, wall modifications, and combat tracker turns.

## Decision
1. Deploy `trame-server` with `min-instances = 0` and `max-instances = 1` using Terraform and Cloud Run service definitions.
2. Register a POSIX signal listener targeting `SIGINT` and `SIGTERM` within `crates/trame-server/src/main.rs`.
3. Implement a Graceful Shutdown Sequence:
   - When `SIGTERM` is received, `trame-server` disables ingress HTTP acceptance for new real-time rooms.
   - The server invokes `RoomLeaseManager::hibernate_all()`, which commands every active `TableRoomHandle` to execute its snapshot routine.
   - `TableRoomHandle::hibernate()` commits actor state snapshots to Neon Postgres within a bounded duration enforced by `tokio::time::timeout` set to 10 seconds.
   - The server flushes pending metrics, closes database pool connections, and terminates with exit code 0.
4. Implement an unauthenticated `/healthz` probe endpoint that returns HTTP 200 within a benchmark CPU budget of under 5 milliseconds without hydrating campaign state or acquiring room locks.

## Consequences
### Positive
- Cloud hosting costs drop to zero during inactive campaign periods.
- State durability is guaranteed on container preemption and scale-down events.
- Cold start probes do not trigger unnecessary database hydration overhead.

### Negative
- Cloud Run imposes a cold-start latency (~300-500 ms) when an inactive instance receives an initial connection.
- Single-instance restriction (`max-instances = 1`) limits horizontal throughput to one concurrent container per deployment.