import type { CreateActorCommand, TrameCommandPayload } from "../sheet/types.ts";
export type { CreateActorCommand, TrameCommandPayload };

export type BuilderStep =
  | "ancestry"
  | "class"
  | "abilityScores"
  | "equipment"
  | "review";

export const BUILDER_STEPS: readonly BuilderStep[] = [
  "ancestry",
  "class",
  "abilityScores",
  "equipment",
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

export type AbilityGenerationMethod = "standardArray" | "pointBuy" | "manual";

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

export interface CharacterDraft {
  id?: string;
  name: string;
  ancestryId: string | null;
  classId: string | null;
  subclassId?: string | null;
  abilityScores: AbilityScores;
  abilityGenerationMethod?: AbilityGenerationMethod;
  equipmentIds: string[];
  spellIds?: string[];
  featIds?: string[];
  skills?: string[];
  backgroundId?: string | null;
  bio?: string;
  notes?: string;
  systemId?: string;
  customData?: Record<string, unknown>;
}

export interface StepValidationResult {
  valid: boolean;
  errors: string[];
}

export type CommandDispatcher = (
  command: CreateActorCommand | TrameCommandPayload,
) => void;

export interface CharacterBuilderWizardOptions {
  draftStore?: import("./builderDraftStore.ts").BuilderDraftStore;
  dispatchCommand?: CommandDispatcher;
  systemId?: string;
  initialDraft?: Partial<CharacterDraft>;
}

export interface FinalizedActorConfig {
  id: string;
  name: string;
  systemId: string;
  type: "character";
  ancestryId: string;
  classId: string;
  subclassId: string | null;
  abilityScores: AbilityScores;
  abilities: Record<
    AbilityId,
    { score: number; mod: number; saveProficiency: boolean }
  >;
  equipmentIds: string[];
  items: Array<{ id: string; quantity: number }>;
  spellIds: string[];
  featIds: string[];
  skills: string[];
  backgroundId: string | null;
  bio: string;
  notes: string;
  customData: Record<string, unknown>;
}

export function createDefaultAbilityScores(): AbilityScores {
  return {
    str: 8,
    dex: 8,
    con: 8,
    int: 8,
    wis: 8,
    cha: 8,
  };
}

export function createDefaultDraft(
  overrides?: Partial<CharacterDraft>,
): CharacterDraft {
  return {
    name: "",
    ancestryId: null,
    classId: null,
    subclassId: null,
    abilityScores: createDefaultAbilityScores(),
    abilityGenerationMethod: "pointBuy",
    equipmentIds: [],
    spellIds: [],
    featIds: [],
    skills: [],
    backgroundId: null,
    bio: "",
    notes: "",
    customData: {},
    ...overrides,
  };
}

export function calculatePointBuyCost(
  scores: Record<string, number>,
  abilities: readonly AbilityId[] = DND5E_ABILITIES,
): number {
  let totalCost = 0;
  for (const ability of abilities) {
    const score = scores[ability];
    if (typeof score !== "number" || Number.isNaN(score)) {
      return Number.POSITIVE_INFINITY;
    }
    if (score < 8 || score > 15) {
      return Number.POSITIVE_INFINITY;
    }
    const cost = POINT_BUY_COST_TABLE[score];
    if (cost === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    totalCost += cost;
  }
  return totalCost;
}

export function validateStandardArray(
  scores: Record<string, number>,
  abilities: readonly AbilityId[] = DND5E_ABILITIES,
): boolean {
  const values: number[] = [];
  for (const ability of abilities) {
    const val = scores[ability];
    if (typeof val !== "number" || Number.isNaN(val)) {
      return false;
    }
    values.push(val);
  }
  if (values.length !== STANDARD_ARRAY.length) {
    return false;
  }
  values.sort((a, b) => b - a);
  return values.every((val, idx) => val === STANDARD_ARRAY[idx]);
}
