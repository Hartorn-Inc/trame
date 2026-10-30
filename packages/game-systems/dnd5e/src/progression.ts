import type {
  ActiveConditionState,
  Dnd5eActorData,
  SpellSlotsState,
  TurnTrigger,
} from "./types.ts";

export type CasterType = "full" | "half" | "pact" | "none";

export interface LevelUpOptions {
  hpIncreaseMode: "fixed" | "roll";
  rolledHp?: number;
  casterType?: CasterType;
}

export function calculateProficiencyBonus(level: number): number {
  return Math.floor((Math.max(1, Math.min(20, Math.trunc(level))) - 1) / 4) + 2;
}

export const FULL_CASTER_SPELL_SLOTS: Record<number, number[]> = {
  1: [2, 0, 0, 0, 0, 0, 0, 0, 0],
  2: [3, 0, 0, 0, 0, 0, 0, 0, 0],
  3: [4, 2, 0, 0, 0, 0, 0, 0, 0],
  4: [4, 3, 0, 0, 0, 0, 0, 0, 0],
  5: [4, 3, 2, 0, 0, 0, 0, 0, 0],
  6: [4, 3, 3, 0, 0, 0, 0, 0, 0],
  7: [4, 3, 3, 1, 0, 0, 0, 0, 0],
  8: [4, 3, 3, 2, 0, 0, 0, 0, 0],
  9: [4, 3, 3, 3, 1, 0, 0, 0, 0],
  10: [4, 3, 3, 3, 2, 0, 0, 0, 0],
  11: [4, 3, 3, 3, 2, 1, 0, 0, 0],
  12: [4, 3, 3, 3, 2, 1, 0, 0, 0],
  13: [4, 3, 3, 3, 2, 1, 1, 0, 0],
  14: [4, 3, 3, 3, 2, 1, 1, 0, 0],
  15: [4, 3, 3, 3, 2, 1, 1, 1, 0],
  16: [4, 3, 3, 3, 2, 1, 1, 1, 0],
  17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 3, 3, 3, 3, 2, 1, 1, 1],
  20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};

export const HALF_CASTER_SPELL_SLOTS: Record<number, number[]> = {
  1: [0, 0, 0, 0, 0],
  2: [2, 0, 0, 0, 0],
  3: [3, 0, 0, 0, 0],
  4: [3, 0, 0, 0, 0],
  5: [4, 2, 0, 0, 0],
  6: [4, 2, 0, 0, 0],
  7: [4, 3, 0, 0, 0],
  8: [4, 3, 0, 0, 0],
  9: [4, 3, 2, 0, 0],
  10: [4, 3, 2, 0, 0],
  11: [4, 3, 3, 0, 0],
  12: [4, 3, 3, 0, 0],
  13: [4, 3, 3, 1, 0],
  14: [4, 3, 3, 1, 0],
  15: [4, 3, 3, 2, 0],
  16: [4, 3, 3, 2, 0],
  17: [4, 3, 3, 3, 1],
  18: [4, 3, 3, 3, 1],
  19: [4, 3, 3, 3, 2],
  20: [4, 3, 3, 3, 2],
};

export interface PactMagicProgression {
  slots: number;
  slotLevel: number;
}

export const PACT_MAGIC_SPELL_SLOTS: Record<number, PactMagicProgression> = {
  1: { slots: 1, slotLevel: 1 },
  2: { slots: 2, slotLevel: 1 },
  3: { slots: 2, slotLevel: 2 },
  4: { slots: 2, slotLevel: 2 },
  5: { slots: 2, slotLevel: 3 },
  6: { slots: 2, slotLevel: 3 },
  7: { slots: 2, slotLevel: 4 },
  8: { slots: 2, slotLevel: 4 },
  9: { slots: 2, slotLevel: 5 },
  10: { slots: 2, slotLevel: 5 },
  11: { slots: 3, slotLevel: 5 },
  12: { slots: 3, slotLevel: 5 },
  13: { slots: 3, slotLevel: 5 },
  14: { slots: 3, slotLevel: 5 },
  15: { slots: 3, slotLevel: 5 },
  16: { slots: 3, slotLevel: 5 },
  17: { slots: 4, slotLevel: 5 },
  18: { slots: 4, slotLevel: 5 },
  19: { slots: 4, slotLevel: 5 },
  20: { slots: 4, slotLevel: 5 },
};

export function applyLevelUp(
  actor: Dnd5eActorData,
  options: LevelUpOptions
): Dnd5eActorData {
  if (actor.attributes.level >= 20) {
    throw new Error("Cannot level up past level 20");
  }

  const clone: Dnd5eActorData = JSON.parse(JSON.stringify(actor));
  clone.attributes.level += 1;
  clone.attributes.hitDiceMax += 1;
  clone.attributes.hitDiceCurrent += 1;

  const conMod = Math.floor((clone.abilities.con.score - 10) / 2);
  let hpGain: number;
  if (options.hpIncreaseMode === "fixed") {
    hpGain = Math.max(1, Math.floor(clone.attributes.hitDieSize / 2) + 1 + conMod);
  } else {
    hpGain = Math.max(1, (options.rolledHp || 1) + conMod);
  }
  clone.attributes.hp.max += hpGain;
  clone.attributes.hp.current += hpGain;

  if (options.casterType && options.casterType !== "none") {
    if (!clone.spellSlots) {
      clone.spellSlots = {};
    }
    const newLevel = clone.attributes.level;
    if (options.casterType === "full") {
      const slots = FULL_CASTER_SPELL_SLOTS[newLevel];
      if (slots) {
        const slotKeys: (keyof SpellSlotsState)[] = [
          "level1",
          "level2",
          "level3",
          "level4",
          "level5",
          "level6",
          "level7",
          "level8",
          "level9",
        ];
        for (let i = 0; i < slotKeys.length; i++) {
          const key = slotKeys[i];
          const newMax = slots[i];
          if (newMax > 0) {
            const existing = clone.spellSlots[key];
            const current = existing
              ? existing.current + Math.max(0, newMax - existing.max)
              : newMax;
            clone.spellSlots[key] = { current, max: newMax };
          }
        }
      }
    } else if (options.casterType === "half") {
      const slots = HALF_CASTER_SPELL_SLOTS[newLevel];
      if (slots) {
        const slotKeys: (keyof SpellSlotsState)[] = [
          "level1",
          "level2",
          "level3",
          "level4",
          "level5",
        ];
        for (let i = 0; i < slotKeys.length; i++) {
          const key = slotKeys[i];
          const newMax = slots[i];
          if (newMax > 0) {
            const existing = clone.spellSlots[key];
            const current = existing
              ? existing.current + Math.max(0, newMax - existing.max)
              : newMax;
            clone.spellSlots[key] = { current, max: newMax };
          }
        }
      }
    } else if (options.casterType === "pact") {
      const pactInfo = PACT_MAGIC_SPELL_SLOTS[newLevel];
      if (pactInfo) {
        const existing = clone.spellSlots.pact;
        const current = existing
          ? existing.current + Math.max(0, pactInfo.slots - existing.max)
          : pactInfo.slots;
        clone.spellSlots.pact = { current, max: pactInfo.slots };
      }
    }
  }

  return clone;
}

export function decrementConditionDurations(
  conditions: ActiveConditionState[],
  trigger: TurnTrigger,
  currentTurnActorId?: string
): ActiveConditionState[] {
  const survivingConditions: ActiveConditionState[] = [];
  for (const cond of conditions) {
    let remaining = cond.durationRounds;
    if (trigger === "TURNS_START" || trigger === "TURNS_END") {
      if (
        cond.appliedTurnActorId !== undefined &&
        cond.appliedTurnActorId === currentTurnActorId &&
        cond.trigger === trigger
      ) {
        remaining = cond.durationRounds - 1;
      }
    } else if (trigger === "ROUNDS") {
      if (cond.trigger === "ROUNDS") {
        remaining = cond.durationRounds - 1;
      }
    }
    if (remaining > 0) {
      survivingConditions.push({ ...cond, durationRounds: remaining });
    }
  }
  return survivingConditions;
}
