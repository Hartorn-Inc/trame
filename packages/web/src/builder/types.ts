import type { BackgroundAbilityChoice } from "../../../game-systems/dnd5e/src/index.ts";

/**
 * Wizard steps in SRD 5.2.1 (2024) creation order: species, class, background
 * (ability increases + origin feat), base ability scores, class skills (and
 * tools), equipment (background and class options), spells (cantrips and
 * level-1 spells; empty for non-casters), review.
 */
export type BuilderStep =
  | "species"
  | "class"
  | "background"
  | "abilityScores"
  | "skills"
  | "equipment"
  | "spells"
  | "review";

export const BUILDER_STEPS: readonly BuilderStep[] = [
  "species",
  "class",
  "background",
  "abilityScores",
  "skills",
  "equipment",
  "spells",
  "review",
] as const;

export type AbilityId = "str" | "dex" | "con" | "int" | "wis" | "cha";

export const DND5E_ABILITIES: readonly AbilityId[] = [
  "str",
  "dex",
  "con",
  "int",
  "wis",
  "cha",
] as const;

export type AbilityScores = Record<AbilityId, number>;

export type AbilityGenerationMethod = "standardArray" | "pointBuy";

/** Point-buy cost per base score (`8..=15`). */
export const POINT_BUY_COST_TABLE: Readonly<Record<number, number>> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

export const MAX_POINT_BUY_BUDGET = 27;

export const STANDARD_ARRAY: readonly number[] = [15, 14, 13, 12, 10, 8] as const;

/** In-memory character draft; nothing is sent to the server before `confirm()`. */
export interface CharacterDraft {
  /** Actor UUID reused as the server actor id on creation. */
  id?: string;
  name: string;
  /** SRD 5.2.1 species key (`"dwarf"`); species grant no ability bonus. */
  speciesId: string | null;
  /** SRD 5.2.1 class key (`"fighter"`). */
  classId: string | null;
  /** Background key (`"sage"`); grants ability increases and an origin feat. */
  backgroundId: string | null;
  /** `+2/+1` or `+1/+1/+1` split over the background's three abilities. */
  backgroundChoice: BackgroundAbilityChoice | null;
  /** Base scores before background increases. */
  abilityScores: AbilityScores;
  abilityGenerationMethod: AbilityGenerationMethod;
  /** Background equipment: option A item names, or `["50 GP"]` (option B). */
  equipmentIds: string[];
  /**
   * Class picks keyed by `getClassChoices` id (`skills`, `tools`,
   * `equipment` option id, `cantrips`, `spells`); reset when the class changes.
   */
  classSelections: Record<string, string[]>;
}

export interface StepValidationResult {
  valid: boolean;
  /** i18n message keys describing each failed rule. */
  errors: string[];
}

export interface CharacterBuilderWizardOptions {
  draftStore?: import("./builderDraftStore.ts").BuilderDraftStore;
  initialDraft?: Partial<CharacterDraft>;
}

export function createDefaultAbilityScores(): AbilityScores {
  return { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
}

export function createDefaultDraft(overrides?: Partial<CharacterDraft>): CharacterDraft {
  return {
    name: "",
    speciesId: null,
    classId: null,
    backgroundId: null,
    backgroundChoice: null,
    abilityScores: createDefaultAbilityScores(),
    abilityGenerationMethod: "pointBuy",
    equipmentIds: [],
    classSelections: {},
    ...overrides,
  };
}

/** Total point-buy cost; `Infinity` when any score is outside `8..=15`. */
export function calculatePointBuyCost(
  scores: Record<string, number>,
  abilities: readonly AbilityId[] = DND5E_ABILITIES,
): number {
  let totalCost = 0;
  for (const ability of abilities) {
    const cost = POINT_BUY_COST_TABLE[scores[ability]];
    if (cost === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    totalCost += cost;
  }
  return totalCost;
}

/** `true` when the six scores are exactly a permutation of `STANDARD_ARRAY`. */
export function validateStandardArray(
  scores: Record<string, number>,
  abilities: readonly AbilityId[] = DND5E_ABILITIES,
): boolean {
  const values = abilities.map((ability) => scores[ability]);
  if (values.some((val) => typeof val !== "number" || Number.isNaN(val))) {
    return false;
  }
  values.sort((a, b) => b - a);
  return values.every((val, idx) => val === STANDARD_ARRAY[idx]);
}
