import { DualBufferFogOfWar } from "../canvas/LightingShader.ts";
import {
  type DrawingEntity,
  type Point2D,
  type WallSegmentDto,
  convertDrawingToWallSegments,
} from "../engine/wasmBridge.ts";
import {
  type ActionEconomyType,
  CombatTrackerManager,
  type CombatTokenState,
  type TableMode,
} from "../hud/combatTracker.ts";
import {
  type AmbientPreset,
  type AmbientPresetConfig,
  type DeathSaveCounters,
  GmOverrideToolbarManager,
  type TokenResourceOverrideInput,
  type UndoEntry,
} from "../hud/gmOverrideToolbar.ts";

export interface ClientTokenView {
  id: string;
  name: string;
  topLeft: Point2D;
  hp: number;
  maxHp: number;
  tempHp?: number;
  elevationFt?: number;
  speedRemainingFt?: number;
  speedMaxFt?: number;
  actionAvailable?: boolean;
  bonusActionAvailable?: boolean;
  reactionAvailable?: boolean;
  spellSlots?: number[];
  deathSaves?: DeathSaveCounters;
}

export interface ClientDiceLogEntry {
  rollId: string;
  rollerUserId: string;
  expression: string;
  reason: string;
  blindMasked: boolean;
  total: number | null;
}

export type PingType = "ALERT" | "ATTENTION" | "QUESTION" | "Alert" | "Attention" | "Question";

export interface RadarPing {
  id: string;
  x: number;
  y: number;
  pingType: "ALERT" | "ATTENTION" | "QUESTION";
  userId: string;
  color: string;
  timestamp: number;
}

export const RADIAL_PING_COLORS: Record<"ALERT" | "ATTENTION" | "QUESTION", string> = {
  ALERT: "#ff3333",
  ATTENTION: "#ffaa00",
  QUESTION: "#3388ff",
};

export function normalizePingType(type: PingType): "ALERT" | "ATTENTION" | "QUESTION" {
  const upper = String(type).toUpperCase();
  if (upper === "QUESTION") return "QUESTION";
  if (upper === "ATTENTION") return "ATTENTION";
  return "ALERT";
}

/**
 * Client-side authoritative state store combining optimistic token movement,
 * combat tracking, GM override toolbar, radar pings, vector drawing walls,
 * and 1-click Fog of War rollback.
 */
export class TableClientStore {
  private seqId = 0;
  private tokens = new Map<string, ClientTokenView>();
  private optimisticRollbackPositions = new Map<string, Point2D>();
  private diceLog: ClientDiceLogEntry[] = [];
  private lastRejectionReason: string | null = null;
  private combatTracker = new CombatTrackerManager();
  private gmOverride = new GmOverrideToolbarManager();
  private pings: RadarPing[] = [];
  private drawings = new Map<string, DrawingEntity>();
  private serverTimeOffsetMs = 0;
  private fogOfWar: DualBufferFogOfWar | null = null;

  public setFogOfWar(fog: DualBufferFogOfWar): void {
    this.fogOfWar = fog;
  }

  public getFogOfWar(): DualBufferFogOfWar | null {
    return this.fogOfWar;
  }

  public applySnapshot(seqId: number, tokens: ClientTokenView[]): void {
    this.seqId = seqId;
    this.tokens.clear();
    this.optimisticRollbackPositions.clear();
    for (const tok of tokens) {
      this.tokens.set(tok.id, {
        ...tok,
        topLeft: { ...tok.topLeft },
        tempHp: tok.tempHp ?? 0,
        elevationFt: tok.elevationFt ?? 0,
        speedRemainingFt: tok.speedRemainingFt ?? tok.speedMaxFt ?? 30,
        speedMaxFt: tok.speedMaxFt ?? 30,
        actionAvailable: tok.actionAvailable ?? true,
        bonusActionAvailable: tok.bonusActionAvailable ?? true,
        reactionAvailable: tok.reactionAvailable ?? true,
      });
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

  public getTokens(): ClientTokenView[] {
    return Array.from(this.tokens.values()).map((t) => ({ ...t, topLeft: { ...t.topLeft } }));
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

  public setServerTimeOffsetMs(offsetMs: number): void {
    this.serverTimeOffsetMs = offsetMs;
  }

  public getServerTimeOffsetMs(): number {
    return this.serverTimeOffsetMs;
  }

  public getCombatTracker(): CombatTrackerManager {
    return this.combatTracker;
  }

  public getGmOverride(): GmOverrideToolbarManager {
    return this.gmOverride;
  }

  public setTableMode(mode: TableMode): void {
    this.combatTracker.setTableMode(mode);
  }

  public getTableMode(): TableMode {
    return this.combatTracker.getState().mode;
  }

  public toggleTablePause(isPaused?: boolean): boolean {
    return this.combatTracker.togglePause(isPaused);
  }

  public isTablePaused(): boolean {
    return this.combatTracker.getState().isPaused;
  }

  public setAmbientPreset(preset: AmbientPreset): AmbientPresetConfig {
    return this.gmOverride.setAmbientPreset(preset);
  }

  public getAmbientPreset(): AmbientPresetConfig {
    return this.gmOverride.getAmbientPreset();
  }

  public gmOverrideHp(tokenId: string, input: TokenResourceOverrideInput): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    const target = {
      hp: token.hp,
      maxHp: token.maxHp,
      tempHp: token.tempHp ?? 0,
      spellSlots: token.spellSlots,
      deathSaves: token.deathSaves,
    };
    this.gmOverride.overrideHpAndResources(target, input);
    token.hp = target.hp;
    token.maxHp = target.maxHp;
    token.tempHp = target.tempHp;
    token.spellSlots = target.spellSlots;
    token.deathSaves = target.deathSaves;
    return true;
  }

  public gmRefundAction(tokenId: string, economyType: ActionEconomyType, amountFt?: number): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    const adapter = {
      actionAvailable: token.actionAvailable ?? true,
      bonusActionAvailable: token.bonusActionAvailable ?? true,
      reactionAvailable: token.reactionAvailable ?? true,
      speedRemainingFt: token.speedRemainingFt ?? token.speedMaxFt ?? 30,
      speedMaxFt: token.speedMaxFt ?? 30,
    };
    this.gmOverride.refundAction(adapter, economyType, amountFt);
    token.actionAvailable = adapter.actionAvailable;
    token.bonusActionAvailable = adapter.bonusActionAvailable;
    token.reactionAvailable = adapter.reactionAvailable;
    token.speedRemainingFt = adapter.speedRemainingFt;
    this.combatTracker.refundAction(tokenId, economyType, amountFt);
    return true;
  }

  public gmTeleportToken(tokenId: string, targetX: number, targetY: number, targetElevationFt?: number): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    this.gmOverride.teleportToken(token, targetX, targetY, targetElevationFt);
    if (targetElevationFt !== undefined) {
      this.combatTracker.syncToken({ id: tokenId, elevationFt: targetElevationFt });
    }
    return true;
  }

  public addRadarPing(params: {
    id?: string;
    x: number;
    y: number;
    pingType: PingType;
    userId?: string;
    color?: string;
    timestamp?: number;
  }): RadarPing {
    const normType = normalizePingType(params.pingType);
    const ping: RadarPing = {
      id: params.id ?? `ping-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      x: params.x,
      y: params.y,
      pingType: normType,
      userId: params.userId ?? "local-user",
      color: params.color ?? RADIAL_PING_COLORS[normType],
      timestamp: params.timestamp ?? Date.now(),
    };
    this.pings.push(ping);
    return ping;
  }

  public getActiveRadarPings(currentTimeMs = Date.now()): RadarPing[] {
    this.pings = this.pings.filter((p) => currentTimeMs - p.timestamp < 1500);
    return this.pings;
  }

  public getRadarPingOpacity(ping: RadarPing, currentTimeMs = Date.now()): number {
    const elapsed = currentTimeMs - ping.timestamp;
    if (elapsed < 0 || elapsed >= 1500) {
      return 0.0;
    }
    return Math.max(0.0, Math.exp((-3.0 * elapsed) / 1500));
  }

  public addDrawing(drawing: DrawingEntity): void {
    this.drawings.set(drawing.id, { ...drawing, points: [...drawing.points] });
  }

  public deleteDrawing(drawingId: string): void {
    this.drawings.delete(drawingId);
  }

  public getDrawings(): DrawingEntity[] {
    return Array.from(this.drawings.values());
  }

  public getPhysicalWallSegments(): WallSegmentDto[] {
    const walls: WallSegmentDto[] = [];
    for (const drawing of this.drawings.values()) {
      walls.push(...convertDrawingToWallSegments(drawing));
    }
    return walls;
  }

  public pushUndo(entry: UndoEntry): void {
    this.gmOverride.pushUndoEntry(entry);
  }

  public triggerUndo(): UndoEntry | null {
    const entry = this.gmOverride.triggerUndo();
    if (entry && this.fogOfWar) {
      this.fogOfWar.rollbackSnapshot(entry.snapshotId);
    }
    return entry;
  }

  public applyActionUndone(snapshotId: number | string, restoredTokens?: ClientTokenView[]): void {
    if (this.fogOfWar) {
      this.fogOfWar.rollbackSnapshot(snapshotId);
    }
    if (restoredTokens) {
      for (const tok of restoredTokens) {
        this.tokens.set(tok.id, { ...tok, topLeft: { ...tok.topLeft } });
        this.combatTracker.syncToken(tok);
      }
    }
  }
}
