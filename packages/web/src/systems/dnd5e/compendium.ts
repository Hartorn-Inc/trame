import type { ActionDefinition, Dnd5eActorSheet } from "./pipeline.ts";

export const SRD_STARTER_ACTIONS: Record<string, ActionDefinition> = {
  fireball: {
    id: "fireball",
    name: "Fireball",
    resourceCostId: "spell_slot_3",
    resolutionKind: "saving_throw",
    saveAbility: "dex",
    halfDamageOnSave: true,
    baseDamage: 28,
    upcastRule: {
      baseSlotLevel: 3,
      extraDamagePerSlot: 3.5,
    },
  },
  hold_person: {
    id: "hold_person",
    name: "Hold Person",
    resourceCostId: "spell_slot_2",
    resolutionKind: "saving_throw",
    saveAbility: "wis",
    halfDamageOnSave: false,
    baseDamage: 0,
    applyConditionOnFail: "Paralyzed",
  },
  fire_breath: {
    id: "fire_breath",
    name: "Fire Breath (Recharge 5-6)",
    resourceCostId: "fire_breath",
    resolutionKind: "saving_throw",
    saveAbility: "dex",
    halfDamageOnSave: true,
    baseDamage: 63,
  },
};

export function createAdultRedDragonSheet(id = "npc-adult-red-dragon"): Dnd5eActorSheet {
  return {
    id,
    name: "Adult Red Dragon",
    level: 17,
    spellcastingAbility: "cha",
    abilities: { str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 21 },
    saveProficiencies: { dex: true, con: true, wis: true, cha: true },
    skillProficiencies: { perception: "expertise", stealth: "proficient" },
    armorKind: "heavy",
    armorBaseAc: 19,
    hasShield: false,
    hpCurrent: 256,
    hpMax: 256,
    tempHp: 0,
    hitDiceCurrent: 19,
    hitDiceMax: 19,
    hitDieSides: 12,
    exhaustionLevel: 0,
    conditions: [],
    resources: {
      legendary_resistance: {
        id: "legendary_resistance",
        label: "Legendary Resistance (3/Day)",
        current: 3,
        max: 3,
        recovery: "long_rest",
      },
      fire_breath: {
        id: "fire_breath",
        label: "Fire Breath (Recharge 5-6)",
        current: 1,
        max: 1,
        recovery: "recharge",
        rechargeMinD6: 5,
      },
    },
    deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
  };
}
