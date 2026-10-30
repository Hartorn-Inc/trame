import type { Point2D } from "../engine/wasmBridge.ts";

export interface ClientTokenView {
  id: string;
  name: string;
  topLeft: Point2D;
  hp: number;
  maxHp: number;
}

export interface ClientDiceLogEntry {
  rollId: string;
  rollerUserId: string;
  expression: string;
  reason: string;
  blindMasked: boolean;
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

  public applySnapshot(seqId: number, tokens: ClientTokenView[]): void {
    this.seqId = seqId;
    this.tokens.clear();
    this.optimisticRollbackPositions.clear();
    for (const tok of tokens) {
      this.tokens.set(tok.id, { ...tok, topLeft: { ...tok.topLeft } });
    }
  }

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

  public commitServerTokenMove(seqId: number, tokenId: string, confirmedTopLeft: Point2D): void {
    this.seqId = seqId;
    this.optimisticRollbackPositions.delete(tokenId);
    const tok = this.tokens.get(tokenId);
    if (tok) {
      tok.topLeft = { ...confirmedTopLeft };
    }
  }

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

  public recordDiceRoll(entry: ClientDiceLogEntry): void {
    this.diceLog.push(entry);
  }

  public getToken(tokenId: string): ClientTokenView | undefined {
    return this.tokens.get(tokenId);
  }

  public getSeqId(): number {
    return this.seqId;
  }

  public getLastRejectionReason(): string | null {
    return this.lastRejectionReason;
  }

  public getDiceLog(): readonly ClientDiceLogEntry[] {
    return this.diceLog;
  }
}
