/**
 * D&D 5e (SRD 5.1 CC-BY-4.0) Core Types for TRAME.
 *
 * Open Game Content Attribution:
 * This work includes material taken from the System Reference Document 5.1 ("SRD 5.1")
 * by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document.
 * The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License
 * available at https://creativecommons.org/licenses/by/4.0/legalcode.
 */

export type AbilityId = "str" | "dex" | "con" | "int" | "wis" | "cha";

export type SkillId =
  | "acrobatics"
  | "animal_handling"
  | "arcana"
  | "athletics"
  | "deception"
  | "history"
  | "insight"
  | "intimidation"
  | "investigation"
  | "medicine"
  | "nature"
  | "perception"
  | "performance"
  | "persuasion"
  | "religion"
  | "sleight_of_hand"
  | "stealth"
  | "survival";

export type ProficiencyRank = 0 | 1 | 2;

export type DamageType =
  | "acid"
  | "bludgeoning"
  | "cold"
  | "fire"
  | "force"
  | "lightning"
  | "necrotic"
  | "piercing"
  | "poison"
  | "psychic"
  | "radiant"
  | "slashing"
  | "thunder";

export type MitigationLevel = "IMMUNE" | "RESISTANT" | "VULNERABLE" | "NONE";

export type RestType = "SHORT_REST" | "LONG_REST";

export type TurnTrigger = "ROUNDS" | "TURNS_START" | "TURNS_END";

export interface ResourcePool {
  current: number;
  max: number;
  resetOn: RestType;
}

export interface DeathSavesState {
  successes: number;
  failures: number;
}

export interface ActiveConditionState {
  id: string;
  name: string;
  durationRounds: number;
  appliedTurnActorId?: string;
  trigger: TurnTrigger;
}

export interface SpellSlotTier {
  current: number;
  max: number;
}

export interface SpellSlotsState {
  level1?: SpellSlotTier;
  level2?: SpellSlotTier;
  level3?: SpellSlotTier;
  level4?: SpellSlotTier;
  level5?: SpellSlotTier;
  level6?: SpellSlotTier;
  level7?: SpellSlotTier;
  level8?: SpellSlotTier;
  level9?: SpellSlotTier;
  pact?: SpellSlotTier;
}

export interface Dnd5eActorData {
  id: string;
  name: string;
  type: "character" | "npc" | "monster";
  abilities: Record<AbilityId, { score: number; saveProficiency: boolean }>;
  skills: Record<SkillId, { ability: AbilityId; proficiencyRank: ProficiencyRank }>;
  attributes: {
    level: number;
    hp: {
      current: number;
      max: number;
      temp: number;
    };
    hitDiceMax: number;
    hitDiceCurrent: number;
    hitDieSize: number;
    exhaustion: number;
    deathSaves: DeathSavesState;
    spellcastingAbility?: AbilityId;
    baseArmorAC?: number;
    shieldBonus?: number;
    armorType?: "none" | "light" | "medium" | "heavy";
  };
  damageMitigations: Record<DamageType, MitigationLevel>;
  conditions: ActiveConditionState[];
  resources?: Record<string, ResourcePool>;
  spellSlots?: SpellSlotsState;
  concentratingOnSpellId?: string;
  isDead?: boolean;
}
