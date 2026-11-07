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
 * reason detached from what the player did (audit RT10 / UA16), and so the
 * actions still unanswered when the socket dies can be reported as possibly
 * lost instead of silently vanishing.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Exact Match Or Nothing`:
 *    - A rejection carrying a known `correlation_id` resolves that entry.
 *    - A rejection without one (an undecodable frame, an older server) or
 *      with an unknown id resolves to `null` (generic label): blaming the
 *      newest action would name the wrong one whenever several are in flight.
 * 2. `Per-Socket FIFO Resolution`:
 *    - The server handles one session's frames strictly in order and sends
 *      every answer (`CommandAccepted` broadcast, `CommandRejected` and
 *      `Pong` unicasts) through the same ordered outbound channel. So when
 *      the answer to frame `X` arrives, every frame sent before `X` has been
 *      answered too: a rejection of `X` drops all older entries, and a `Pong`
 *      echoing `client_time_ms = T` drops every entry sent strictly before
 *      `T` (an entry sent in the same millisecond is kept, conservatively).
 *    - `CommandAccepted` carries no correlation id and is broadcast to every
 *      session, so it cannot resolve an entry by itself.
 * 3. `Bounded Memory`:
 *    - Entries older than `PENDING_COMMAND_TTL_MS` are pruned and at most
 *      `PENDING_COMMAND_LIMIT` are kept.
 * 4. `Socket-Scoped`:
 *    - The client drains the tracker when a socket dies (`drain`, one
 *      "may not have been applied" notice per entry) and clears it on an
 *      intentional disconnect: answers for frames sent on a dead socket can
 *      never arrive.
 * ============================================================================
 */

/** Maximum in-flight entries remembered. */
export const PENDING_COMMAND_LIMIT = 32;
/**
 * Age after which an entry can no longer be matched, in milliseconds (`ms`).
 * Longer than a heartbeat interval plus the pong timeout (20 s + 10 s), so a
 * command sent just after a heartbeat is still reported when a silent socket
 * is only detected by the missing `Pong`.
 */
export const PENDING_COMMAND_TTL_MS = 60_000;

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

  /**
   * Resolves the entry a rejection refers to and every older one (invariants 1-2);
   * returns its action, or `null` when the id is missing or unknown.
   */
  take(correlationId: string | null, nowMs: number = Date.now()): string | null {
    this.prune(nowMs);
    if (correlationId === null) return null;
    const index = this.entries.findIndex((e) => e.correlationId === correlationId);
    if (index < 0) return null;
    const { action } = this.entries[index];
    this.entries = this.entries.slice(index + 1);
    return action;
  }

  /** Resolves every entry sent strictly before `clientTimeMs`, the timestamp a `Pong` echoes (invariant 2). */
  resolveSentBefore(clientTimeMs: number): void {
    this.entries = this.entries.filter((e) => e.sentAtMs >= clientTimeMs);
  }

  /** Returns the unanswered recent actions, oldest first, and forgets every entry (invariant 4). */
  drain(nowMs: number = Date.now()): string[] {
    this.prune(nowMs);
    const actions = this.entries.map((e) => e.action);
    this.entries = [];
    return actions;
  }

  /** Forgets every entry (intentional disconnect, invariant 4). */
  clear(): void {
    this.entries = [];
  }

  private prune(nowMs: number): void {
    this.entries = this.entries.filter((e) => nowMs - e.sentAtMs <= PENDING_COMMAND_TTL_MS);
  }
}
