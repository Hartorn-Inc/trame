import { CANVAS_AMBIENT_TINTS } from "../canvas/CanvasThemePalette.ts";
import type { Point2D } from "../engine/wasmBridge.ts";
import { type ActionEconomyType, normalizeActionEconomyType } from "./combatTracker.ts";

export type AmbientPreset =
  | "DAYLIGHT"
  | "DUSK"
  | "NIGHT_MOONLIGHT"
  | "PITCH_DARKNESS"
  | "Daylight"
  | "Dusk"
  | "NightMoonlight"
  | "PitchDarkness";

export interface AmbientPresetConfig {
  preset: "DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS";
  ambientLight: number;
  darknessRadius: number;
  tint: string;
}

export const AMBIENT_PRESETS: Record<"DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS", AmbientPresetConfig> = {
  DAYLIGHT: { preset: "DAYLIGHT", ambientLight: 1.0, darknessRadius: 0, tint: CANVAS_AMBIENT_TINTS.DAYLIGHT },
  DUSK: { preset: "DUSK", ambientLight: 0.45, darknessRadius: 0, tint: CANVAS_AMBIENT_TINTS.DUSK },
  NIGHT_MOONLIGHT: { preset: "NIGHT_MOONLIGHT", ambientLight: 0.15, darknessRadius: 30, tint: CANVAS_AMBIENT_TINTS.NIGHT_MOONLIGHT },
  PITCH_DARKNESS: { preset: "PITCH_DARKNESS", ambientLight: 0.0, darknessRadius: 60, tint: CANVAS_AMBIENT_TINTS.PITCH_DARKNESS },
};

export function normalizeAmbientPreset(preset: AmbientPreset): "DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS" {
  const upper = String(preset).toUpperCase().replace(/[-_]/g, "");
  if (upper === "DUSK") return "DUSK";
  if (upper === "NIGHTMOONLIGHT") return "NIGHT_MOONLIGHT";
  if (upper === "PITCHDARKNESS") return "PITCH_DARKNESS";
  return "DAYLIGHT";
}

export interface DeathSaveCounters {
  successes: number;
  failures: number;
}

export interface TokenResourceOverrideInput {
  hp?: number;
  tempHp?: number;
  spellSlotsDelta?: number[];
  deathSaves?: DeathSaveCounters;
}

export interface UndoEntry {
  snapshotId: number | string;
  description: string;
  author: string;
  timestamp: number;
  targetTokenIds?: string[];
  snapshotData?: unknown;
}

export const MAX_UNDO_HISTORY = 50;

/**
 * GM Omnipotent Override Toolbar Manager providing 1-click resource editing,
 * economy refunds, forced teleportation, Day/Night lighting presets, and
 * ring-buffered Undo drawer tracking.
 */
export class GmOverrideToolbarManager {
  private currentPreset: "DAYLIGHT" | "DUSK" | "NIGHT_MOONLIGHT" | "PITCH_DARKNESS" = "DAYLIGHT";
  private undoStack: UndoEntry[] = [];

  public overrideHpAndResources(
    token: {
      hp: number;
      maxHp: number;
      tempHp: number;
      spellSlots?: number[];
      deathSaves?: DeathSaveCounters;
    },
    input: TokenResourceOverrideInput,
  ):
    void {
    if (input.hp !== undefined) {
      token.hp = Math.max(0, Math.min(token.maxHp, Math.trunc(input.hp)));
    }
    if (input.tempHp !== undefined) {
      token.tempHp = Math.max(0, Math.trunc(input.tempHp));
    }
    if (input.spellSlotsDelta && token.spellSlots) {
      for (let i = 0; i < input.spellSlotsDelta.length; i++) {
        if (i < token.spellSlots.length) {
          token.spellSlots[i] = Math.max(0, token.spellSlots[i] + input.spellSlotsDelta[i]);
        }
      }
    }
    if (input.deathSaves) {
      token.deathSaves = {
        successes: Math.max(0, Math.min(3, Math.trunc(input.deathSaves.successes))),
        failures: Math.max(0, Math.min(3, Math.trunc(input.deathSaves.failures))),
      };
    }
  }

  public refundAction(
    token: {
      actionAvailable: boolean;
      bonusActionAvailable: boolean;
      reactionAvailable: boolean;
      speedRemainingFt: number;
      speedMaxFt: number;
    },
    economyType: ActionEconomyType,
    amountFt?: number,
  ):
    void {
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

  public teleportToken(
    token: { topLeft: Point2D; elevationFt?: number },
    targetX: number,
    targetY: number,
    targetElevationFt?: number,
  ): { prevPos: Point2D; newPos: Point2D } {
    const prevPos = { ...token.topLeft };
    token.topLeft = { x: targetX, y: targetY };
    if (targetElevationFt !== undefined) {
      token.elevationFt = targetElevationFt;
    }
    return { prevPos, newPos: { ...token.topLeft } };
  }

  public setAmbientPreset(preset: AmbientPreset): AmbientPresetConfig {
    this.currentPreset = normalizeAmbientPreset(preset);
    return AMBIENT_PRESETS[this.currentPreset];
  }

  public getAmbientPreset(): AmbientPresetConfig {
    return AMBIENT_PRESETS[this.currentPreset];
  }

  public pushUndoEntry(entry: UndoEntry): void {
    if (this.undoStack.length >= MAX_UNDO_HISTORY) {
      this.undoStack.shift();
    }
    this.undoStack.push({ ...entry });
  }

  public triggerUndo(): UndoEntry | null {
    return this.undoStack.pop() ?? null;
  }

  public getUndoHistory(): readonly UndoEntry[] {
    return this.undoStack;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }
}
