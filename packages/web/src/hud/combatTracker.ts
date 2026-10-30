export type TableMode =
  | "EXPLORATION"
  | "TURN_BY_TURN"
  | "Exploration"
  | "TurnByTurn";

export type ActionEconomyType =
  | "ACTION"
  | "BONUS_ACTION"
  | "REACTION"
  | "MOVEMENT"
  | "Action"
  | "BonusAction"
  | "Reaction"
  | "Movement";

export interface CombatTokenState {
  id: string;
  name: string;
  initiative: number;
  elevationFt: number;
  actionAvailable: boolean;
  bonusActionAvailable: boolean;
  reactionAvailable: boolean;
  speedRemainingFt: number;
  speedMaxFt: number;
}

export interface CombatTrackerState {
  mode: TableMode;
  isPaused: boolean;
  round: number;
  turnIndex: number;
  tokens: CombatTokenState[];
  activeTokenId: string | null;
}

export interface ReactionWindowState {
  triggerId: number;
  actorId: string;
  reactionType: string;
  expiresAtMs: number;
  reachDistanceFt: number;
  isPaused: boolean;
  pausedRemainingMs?: number;
  targetTokenId?: string;
  closed?: boolean;
  wasInterrupted?: boolean;
}

export function computeServerTimeOffset(
  clientSendMs: number,
  serverRecvMs: number,
  serverSendMs: number,
  clientRecvMs: number,
): number {
  const roundTripMs = clientRecvMs - clientSendMs - (serverSendMs - serverRecvMs);
  return serverSendMs + roundTripMs / 2 - clientRecvMs;
}

export function normalizeTableMode(mode: TableMode): "EXPLORATION" | "TURN_BY_TURN" {
  return mode === "TURN_BY_TURN" || mode === "TurnByTurn"
    ? "TURN_BY_TURN"
    : "EXPLORATION";
}

export function normalizeActionEconomyType(
  type: ActionEconomyType,
): "ACTION" | "BONUS_ACTION" | "REACTION" | "MOVEMENT" {
  const upper = String(type).toUpperCase().replace(/[-_]/g, "");
  if (upper === "BONUSACTION") return "BONUS_ACTION";
  if (upper === "REACTION") return "REACTION";
  if (upper === "MOVEMENT") return "MOVEMENT";
  return "ACTION";
}

/**
 * Manages Exploration / Turn-by-Turn state, initiative turn advancement,
 * action economy tracking, and 5-second server-authoritative Reaction Window.
 */
export class CombatTrackerManager {
  private state: CombatTrackerState = {
    mode: "EXPLORATION",
    isPaused: false,
    round: 1,
    turnIndex: 0,
    tokens: [],
    activeTokenId: null,
  };

  private activeReaction: ReactionWindowState | null = null;

  public getState(): CombatTrackerState {
    return {
      ...this.state,
      tokens: this.state.tokens.map((t) => ({ ...t })),
    };
  }

  public setTableMode(mode: TableMode): void {
    this.state.mode = normalizeTableMode(mode);
  }

  public togglePause(isPaused?: boolean): boolean {
    this.state.isPaused = isPaused !== undefined ? isPaused : !this.state.isPaused;
    return this.state.isPaused;
  }

  public setInitiativeOrder(tokens: CombatTokenState[]): void {
    const sorted = [...tokens].sort((a, b) => b.initiative - a.initiative);
    this.state.tokens = sorted;
    this.state.turnIndex = 0;
    this.state.round = 1;
    this.state.activeTokenId = sorted[0]?.id ?? null;
    if (sorted[0]) {
      this.refreshActiveTokenEconomy(sorted[0]);
    }
  }

  public nextTurn(): { activeTokenId: string | null; round: number } {
    if (this.state.tokens.length === 0) {
      return { activeTokenId: null, round: this.state.round };
    }
    this.state.turnIndex++;
    if (this.state.turnIndex >= this.state.tokens.length) {
      this.state.turnIndex = 0;
      this.state.round++;
    }
    const active = this.state.tokens[this.state.turnIndex];
    this.state.activeTokenId = active?.id ?? null;
    if (active) {
      this.refreshActiveTokenEconomy(active);
    }
    return { activeTokenId: this.state.activeTokenId, round: this.state.round };
  }

  public previousTurn(): { activeTokenId: string | null; round: number } {
    if (this.state.tokens.length === 0) {
      return { activeTokenId: null, round: this.state.round };
    }
    this.state.turnIndex--;
    if (this.state.turnIndex < 0) {
      this.state.turnIndex = this.state.tokens.length - 1;
      this.state.round = Math.max(1, this.state.round - 1);
    }
    const active = this.state.tokens[this.state.turnIndex];
    this.state.activeTokenId = active?.id ?? null;
    return { activeTokenId: this.state.activeTokenId, round: this.state.round };
  }

  public spendAction(tokenId: string, economyType: ActionEconomyType, amountFt?: number): boolean {
    const token = this.state.tokens.find((t) => t.id === tokenId);
    if (!token) {
      return false;
    }
    const kind = normalizeActionEconomyType(economyType);
    switch (kind) {
      case "ACTION":
        if (!token.actionAvailable) return false;
        token.actionAvailable = false;
        return true;
      case "BONUS_ACTION":
        if (!token.bonusActionAvailable) return false;
        token.bonusActionAvailable = false;
        return true;
      case "REACTION":
        if (!token.reactionAvailable) return false;
        token.reactionAvailable = false;
        return true;
      case "MOVEMENT": {
        const cost = amountFt ?? 5;
        if (token.speedRemainingFt < cost - 1e-6) return false;
        token.speedRemainingFt = Math.max(0, token.speedRemainingFt - cost);
        return true;
      }
    }
  }

  public refundAction(tokenId: string, economyType: ActionEconomyType, amountFt?: number): void {
    const token = this.state.tokens.find((t) => t.id === tokenId);
    if (!token) {
      return;
    }
    const kind = normalizeActionEconomyType(economyType);
    switch (kind) {
      case "ACTION":
        token.actionAvailable = true;
        break;
      case "BONUS_ACTION":
        token.bonusActionAvailable = true;
        break;
      case "REACTION":
        token.reactionAvailable = true;
        break;
      case "MOVEMENT":
        token.speedRemainingFt = Math.min(
          token.speedMaxFt,
          token.speedRemainingFt + (amountFt ?? token.speedMaxFt),
        );
        break;
    }
  }

  public openReaction(params: {
    triggerId: number;
    actorId: string;
    reactionType: string;
    expiresAtMs: number;
    reachDistanceFt?: number;
    targetTokenId?: string;
  }): ReactionWindowState {
    this.activeReaction = {
      triggerId: params.triggerId,
      actorId: params.actorId,
      reactionType: params.reactionType,
      expiresAtMs: params.expiresAtMs,
      reachDistanceFt: params.reachDistanceFt ?? 5.0,
      isPaused: false,
      targetTokenId: params.targetTokenId,
      closed: false,
    };
    return { ...this.activeReaction };
  }

  public getActiveReaction(): ReactionWindowState | null {
    if (!this.activeReaction || this.activeReaction.closed) {
      return null;
    }
    return { ...this.activeReaction };
  }

  public getRemainingReactionMs(currentTimeMs: number, serverTimeOffsetMs = 0): number {
    if (!this.activeReaction || this.activeReaction.closed) {
      return 0;
    }
    if (this.activeReaction.isPaused) {
      return this.activeReaction.pausedRemainingMs ?? 0;
    }
    const remaining = Math.max(
      0,
      this.activeReaction.expiresAtMs - (currentTimeMs + serverTimeOffsetMs),
    );
    if (remaining === 0) {
      this.activeReaction.closed = true;
      this.activeReaction.wasInterrupted = false;
    }
    return remaining;
  }

  public declareReaction(triggerId: number, accepted: boolean): { triggerId: number; wasInterrupted: boolean } {
    if (!this.activeReaction || this.activeReaction.triggerId !== triggerId) {
      return { triggerId, wasInterrupted: false };
    }
    this.activeReaction.closed = true;
    this.activeReaction.wasInterrupted = accepted;
    return { triggerId, wasInterrupted: accepted };
  }

  public forceReaction(triggerId: number): { triggerId: number; wasInterrupted: boolean } {
    return this.declareReaction(triggerId, true);
  }

  public dismissReaction(triggerId: number): { triggerId: number; wasInterrupted: boolean } {
    return this.declareReaction(triggerId, false);
  }

  public toggleReactionPause(triggerId: number, currentTimeMs: number, serverTimeOffsetMs = 0): boolean {
    if (!this.activeReaction || this.activeReaction.triggerId !== triggerId) {
      return false;
    }
    if (!this.activeReaction.isPaused) {
      this.activeReaction.pausedRemainingMs = this.getRemainingReactionMs(currentTimeMs, serverTimeOffsetMs);
      this.activeReaction.isPaused = true;
    } else {
      const resumeRemaining = this.activeReaction.pausedRemainingMs ?? 0;
      this.activeReaction.expiresAtMs = currentTimeMs + serverTimeOffsetMs + resumeRemaining;
      this.activeReaction.isPaused = false;
      this.activeReaction.pausedRemainingMs = undefined;
    }
    return this.activeReaction.isPaused;
  }

  public handleServerInterruptResolved(triggerId: number, wasInterrupted: boolean): void {
    if (this.activeReaction && this.activeReaction.triggerId === triggerId) {
      this.activeReaction.closed = true;
      this.activeReaction.wasInterrupted = wasInterrupted;
    }
  }

  private refreshActiveTokenEconomy(token: CombatTokenState): void {
    token.actionAvailable = true;
    token.bonusActionAvailable = true;
    token.reactionAvailable = true;
    token.speedRemainingFt = token.speedMaxFt;
  }
}
