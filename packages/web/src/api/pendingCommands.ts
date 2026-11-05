/**
 * ============================================================================
 * PENDING COMMAND CORRELATION (api/pendingCommands.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Remembers which table action each in-flight `SubmitCommand` / `RollDice`
 * frame carried, keyed by the client-generated `correlation_id`, so a
 * `CommandRejected` can be shown as "Move token failed: ..." instead of a
 * reason detached from what the player did (audit RT10 / UA16).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Exact Match First`:
 *    - A rejection carrying a known `correlation_id` resolves that entry.
 *    - A rejection without one (an older server, or an undecodable frame)
 *      falls back to the most recent pending entry; an unknown id resolves
 *      to nothing rather than guessing.
 * 2. `Bounded Memory`:
 *    - `CommandAccepted` is broadcast without a correlation id, so accepted
 *      entries are never removed explicitly; entries older than
 *      `PENDING_COMMAND_TTL_MS` are pruned and at most
 *      `PENDING_COMMAND_LIMIT` are kept.
 * 3. `Socket-Scoped`:
 *    - The client clears the tracker when a new socket opens: rejections
 *      for frames sent on a dead socket can never arrive.
 * ============================================================================
 */

/** Maximum in-flight entries remembered. */
export const PENDING_COMMAND_LIMIT = 32;
/** Age after which an entry can no longer be matched, in milliseconds (`ms`). */
export const PENDING_COMMAND_TTL_MS = 30_000;

interface PendingCommand {
  correlationId: string;
  /** `TrameCommand` tag or `"ROLL_DICE"`. */
  action: string;
  /** Epoch milliseconds when the frame was sent. */
  sentAtMs: number;
}

/**
 * Generates a UUID v4 correlation id. `crypto.randomUUID` exists only in
 * secure contexts, so a plain-HTTP LAN deployment falls back to
 * `crypto.getRandomValues`, which is available everywhere.
 */
export function newCorrelationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** In-flight actions keyed by correlation id (see module invariants). */
export class PendingCommands {
  private entries: PendingCommand[] = [];

  /** Records a sent frame. */
  add(correlationId: string, action: string, nowMs: number = Date.now()): void {
    this.prune(nowMs);
    this.entries = [...this.entries, { correlationId, action, sentAtMs: nowMs }].slice(-PENDING_COMMAND_LIMIT);
  }

  /** Removes and returns the action a rejection refers to (invariant 1), or `null`. */
  take(correlationId: string | null, nowMs: number = Date.now()): string | null {
    this.prune(nowMs);
    const index =
      correlationId === null
        ? this.entries.length - 1
        : this.entries.findIndex((e) => e.correlationId === correlationId);
    if (index < 0) return null;
    const [entry] = this.entries.splice(index, 1);
    return entry.action;
  }

  /** Forgets every entry (new socket, invariant 3). */
  clear(): void {
    this.entries = [];
  }

  private prune(nowMs: number): void {
    this.entries = this.entries.filter((e) => nowMs - e.sentAtMs <= PENDING_COMMAND_TTL_MS);
  }
}
