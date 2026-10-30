/**
 * ============================================================================
 * AUTHORITATIVE TABLE CLIENT STORE & OPTIMISTIC ROLLBACK (tableStore.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Maintains the client-side tactical table state (`seqId`, token positions/HP,
 * and blind-aware dice roll log), providing zero-latency optimistic token
 * dragging (`beginOptimisticTokenMove`) paired with deterministic rollback
 * (`rollbackRejectedCommand`) when the authoritative server rejects an illegal
 * move (e.g., wall collision or insufficient movement speed).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Original-Anchor Rollback Preservation`:
 *      - `beginOptimisticTokenMove` records a token's pre-drag `topLeft` anchor
 *        into `optimisticRollbackPositions` only on the first optimistic step
 *        (`!has(tokenId)`), ensuring multi-waypoint client drags still revert
 *        all the way back to the last server-confirmed coordinate on rejection.
 *   2. `Defensive Coordinate Cloning`:
 *      - `applySnapshot`, `beginOptimisticTokenMove`, `commitServerTokenMove`,
 *        and `rollbackRejectedCommand` clone `{ x, y }` `Point2D` objects so
 *        external caller mutations cannot corrupt internal store or rollback state.
 *   3. `Blind Roll Privacy Masking`:
 *      - `ClientDiceLogEntry` represents blind GM rolls with `blindMasked: true`
 *        and `total: null` for non-GM clients so secret roll outcomes are never
 *        exposed in the player store.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. `applySnapshot(seqId, tokens)` -> Hydrates baseline state & clears pending rollbacks.
 *   2. `beginOptimisticTokenMove(tokenId, newTopLeft)` -> Caches original position & moves token locally.
 *   3. Server response:
 *      ├── `commitServerTokenMove(seqId, tokenId, confirmedTopLeft)` -> Advances `seqId` & drops rollback anchor.
 *      └── `rollbackRejectedCommand(reason)` -> Restores cached anchor positions & records `lastRejectionReason`.
 * ============================================================================
 */

import type { Point2D } from "../engine/wasmBridge.ts";

/**
 * Client-side projection of a tactical token on the active map.
 */
export interface ClientTokenView {
  /** Unique identifier of the token instance. */
  id: string;
  /** Display name rendered on the token nameplate. */
  name: string;
  /** Top-left coordinate of the token in world canvas pixels (`px`). */
  topLeft: Point2D;
  /** Current Hit Points (`0..=maxHp`). */
  hp: number;
  /** Maximum Hit Points (`>= 1`). */
  maxHp: number;
}

/**
 * Single entry in the client-side real-time dice roll log.
 */
export interface ClientDiceLogEntry {
  /** Unique server-assigned identifier for the roll event. */
  rollId: string;
  /** User ID of the participant who initiated the roll. */
  rollerUserId: string;
  /** Canonical dice notation expression (e.g., `"2d20kh1+5"`). */
  expression: string;
  /** Context label describing the roll purpose (e.g., `"Stealth Check"`). */
  reason: string;
  /** True when the roll outcome is hidden from the local player (`total === null`). */
  blindMasked: boolean;
  /** Evaluated integer total, or `null` when masked by a blind GM roll. */
  total: number | null;
}

/**
 * Client-side authoritative state store with optimistic token movement and instant rollback
 * upon server `CommandRejected`.
 */
export class TableClientStore {
  private seqId = 0;
  private tokens = new Map<string, ClientTokenView>();
  private optimisticRollbackPositions = new Map<string, Point2D>();
  private diceLog: ClientDiceLogEntry[] = [];
  private lastRejectionReason: string | null = null;

  /**
   * Replaces the local token collection with a full authoritative server snapshot
   * at sequence number `seqId` and clears any pending optimistic rollback anchors.
   */
  public applySnapshot(seqId: number, tokens: ClientTokenView[]): void {
    this.seqId = seqId;
    this.tokens.clear();
    this.optimisticRollbackPositions.clear();
    for (const tok of tokens) {
      this.tokens.set(tok.id, { ...tok, topLeft: { ...tok.topLeft } });
    }
  }

  /**
   * Optimistically moves `tokenId` to `newTopLeft` (in world `px`) for immediate
   * visual feedback while preserving the last server-confirmed coordinate in
   * `optimisticRollbackPositions` until the server commits or rejects the command.
   */
  public beginOptimisticTokenMove(tokenId: string, newTopLeft: Point2D): void {
    const tok = this.tokens.get(tokenId);
    if (!tok) {
      return;
    }
    if (!this.optimisticRollbackPositions.has(tokenId)) {
      this.optimisticRollbackPositions.set(tokenId, { ...tok.topLeft });
    }
    tok.topLeft = { ...newTopLeft };
  }

  /**
   * Commits an authoritative server `TokenMoved` broadcast at `seqId`, updating
   * `tokenId` to `confirmedTopLeft` (in world `px`) and clearing its rollback anchor.
   */
  public commitServerTokenMove(seqId: number, tokenId: string, confirmedTopLeft: Point2D): void {
    this.seqId = seqId;
    this.optimisticRollbackPositions.delete(tokenId);
    const tok = this.tokens.get(tokenId);
    if (tok) {
      tok.topLeft = { ...confirmedTopLeft };
    }
  }

  /**
   * Reverts all in-flight optimistic token moves back to their server-confirmed
   * coordinates and stores `reason` when the server emits `CommandRejected`.
   */
  public rollbackRejectedCommand(reason: string): void {
    this.lastRejectionReason = reason;
    for (const [tokenId, originalPos] of this.optimisticRollbackPositions.entries()) {
      const tok = this.tokens.get(tokenId);
      if (tok) {
        tok.topLeft = { ...originalPos };
      }
    }
    this.optimisticRollbackPositions.clear();
  }

  /**
   * Appends a server-broadcast `ClientDiceLogEntry` to the session dice log.
   */
  public recordDiceRoll(entry: ClientDiceLogEntry): void {
    this.diceLog.push(entry);
  }

  /**
   * Looks up the current `ClientTokenView` for `tokenId`, or `undefined` if not present.
   */
  public getToken(tokenId: string): ClientTokenView | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Returns the latest authoritative sequence number (`seqId`) applied by the store.
   */
  public getSeqId(): number {
    return this.seqId;
  }

  /**
   * Returns the human-readable reason from the most recent `CommandRejected` event, or `null`.
   */
  public getLastRejectionReason(): string | null {
    return this.lastRejectionReason;
  }

  /**
   * Returns a read-only view of all recorded dice roll log entries in chronological order.
   */
  public getDiceLog(): readonly ClientDiceLogEntry[] {
    return this.diceLog;
  }
}
