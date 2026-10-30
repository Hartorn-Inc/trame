/**
 * D&D 5e (2024 / SRD 5.2) Declarative GameSystem Manifest for TRAME.
 *
 * Open Game Content Attribution:
 * This work includes material from the System Reference Document 5.2 ("SRD 5.2")
 * by Wizards of the Coast LLC, available under the Creative Commons Attribution 4.0
 * International License (CC-BY-4.0).
 */

export type AbilityId = "str" | "dex" | "con" | "int" | "wis" | "cha";

export type ProficiencyRank = "none" | "half" | "proficient" | "expertise";

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

export interface SkillMetadata {
  id: SkillId;
  label: string;
  ability: AbilityId;
}

export interface DerivedFormulaNodeSpec {
  targetAttr: string;
  deps: string[];
  expr: string;
}

export interface GameSystemManifest {
  id: string;
  name: string;
  version: string;
  srdLicense: string;
  abilities: AbilityId[];
  skills: SkillMetadata[];
  derivedDAG: DerivedFormulaNodeSpec[];
}

export const DND5E_SKILLS: SkillMetadata[] = [
  { id: "acrobatics", label: "Acrobatics", ability: "dex" },
  { id: "animal_handling", label: "Animal Handling", ability: "wis" },
  { id: "arcana", label: "Arcana", ability: "int" },
  { id: "athletics", label: "Athletics", ability: "str" },
  { id: "deception", label: "Deception", ability: "cha" },
  { id: "history", label: "History", ability: "int" },
  { id: "insight", label: "Insight", ability: "wis" },
  { id: "intimidation", label: "Intimidation", ability: "cha" },
  { id: "investigation", label: "Investigation", ability: "int" },
  { id: "medicine", label: "Medicine", ability: "wis" },
  { id: "nature", label: "Nature", ability: "int" },
  { id: "perception", label: "Perception", ability: "wis" },
  { id: "performance", label: "Performance", ability: "cha" },
  { id: "persuasion", label: "Persuasion", ability: "cha" },
  { id: "religion", label: "Religion", ability: "int" },
  { id: "sleight_of_hand", label: "Sleight of Hand", ability: "dex" },
  { id: "stealth", label: "Stealth", ability: "dex" },
  { id: "survival", label: "Survival", ability: "wis" },
];

export const DND5E_2024_MANIFEST: GameSystemManifest = {
  id: "dnd5e-2024",
  name: "Dungeons & Dragons 5th Edition (SRD 5.2)",
  version: "5.2.0",
  srdLicense: "CC-BY-4.0 (Wizards of the Coast SRD 5.2)",
  abilities: ["str", "dex", "con", "int", "wis", "cha"],
  skills: DND5E_SKILLS,
  derivedDAG: [
    { targetAttr: "str_mod", deps: ["str"], expr: "floor((str - 10) / 2)" },
    { targetAttr: "dex_mod", deps: ["dex"], expr: "floor((dex - 10) / 2)" },
    { targetAttr: "con_mod", deps: ["con"], expr: "floor((con - 10) / 2)" },
    { targetAttr: "int_mod", deps: ["int"], expr: "floor((int - 10) / 2)" },
    { targetAttr: "wis_mod", deps: ["wis"], expr: "floor((wis - 10) / 2)" },
    { targetAttr: "cha_mod", deps: ["cha"], expr: "floor((cha - 10) / 2)" },
    {
      targetAttr: "proficiency_bonus",
      deps: ["level"],
      expr: "floor((level - 1) / 4) + 2",
    },
    {
      targetAttr: "initiative_bonus",
      deps: ["dex_mod"],
      expr: "dex_mod",
    },
    {
      targetAttr: "spell_save_dc_int",
      deps: ["proficiency_bonus", "int_mod"],
      expr: "8 + proficiency_bonus + int_mod",
    },
    {
      targetAttr: "spell_save_dc_wis",
      deps: ["proficiency_bonus", "wis_mod"],
      expr: "8 + proficiency_bonus + wis_mod",
    },
    {
      targetAttr: "spell_save_dc_cha",
      deps: ["proficiency_bonus", "cha_mod"],
      expr: "8 + proficiency_bonus + cha_mod",
    },
  ],
};
