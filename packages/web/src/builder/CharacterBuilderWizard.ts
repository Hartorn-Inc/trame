/**
 * ============================================================================
 * SRD 5.2.1 CHARACTER BUILDER STATE MACHINE (builder/CharacterBuilderWizard.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Drives level-1 character creation with the 2024 origin rules: species
 * (traits, speed, size, no ability bonus), class (hit die, saving throws),
 * background (`+2/+1` or `+1/+1/+1` and an Origin feat), base ability scores,
 * and equipment. `confirm()` produces a complete `Dnd5eActorData`; the caller
 * persists it with `POST .../actors`. Without a single state machine, the UI
 * could create sheets with 2014-style species bonuses or a level-1 subclass.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Sequential Gating`:
 *    - A step can only be entered when every earlier step validates, so
 *      `confirm()` never sees a partial draft.
 * 2. `Ability Increases From The Background Only`:
 *    - Species never change scores; `applyBackground` (SRD pack) applies the
 *      background split, the 20 cap, the retroactive CON HP delta, the two
 *      skills, and the Origin feat.
 * 3. `No Level-1 Subclass`:
 *    - Characters start at level 1 without a subclass; subclasses unlock at
 *      `SUBCLASS_UNLOCK_LEVEL` (3) through level-up.
 * 4. `No Network Before Confirm`:
 *    - Intermediate steps only touch `BuilderDraftStore` in memory.
 * 5. `Starting Equipment`:
 *    - `equipmentIds` holds either the background's equipment option A or
 *      `["50 GP"]` (option B); `confirm()` writes them to the sheet `items`.
 *      The class equipment option is a class pick (invariant 6); its armor
 *      and weapons are equipped, so they feed Armor Class and attacks.
 * 6. `Class Picks From The System Pack`:
 *    - Skills, tools, the class equipment option, cantrips and level-1
 *      spells are the `getClassChoices` descriptors (SRD 5.2.1 counts and
 *      lists); a step validates only when each of its choices has exactly
 *      `count` distinct allowed picks, and `applyClassChoices` applies them.
 *      Skills the background already grants are not offered.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `confirm()`
 * ├── 1. Validate every step (review).
 * ├── 2. Default actor + class hit die, saves, HP = die + CON mod (+ species bonus).
 * ├── 3. Species speed; `applyBackground(actor, background, choice)`.
 * ├── 4. `applyClassChoices` (skills, tools, gear, cantrips, spells, slots).
 * └── 5. Return the finalized `Dnd5eActorData` (draft kept until persisted).
 * ============================================================================
 */
import {
  applyBackground,
  applyClassChoices,
  backgroundAbilityIncreases,
  createDefaultActorData,
  getBackgroundRules,
  getClassChoices,
  getClassProgression,
  getSpeciesRules,
  type BuilderChoice,
  type Dnd5eActorData,
} from "../../../game-systems/dnd5e/src/index.ts";
import { BuilderDraftStore } from "./builderDraftStore.ts";
import {
  BUILDER_STEPS,
  DND5E_ABILITIES,
  MAX_POINT_BUY_BUDGET,
  calculatePointBuyCost,
  createDefaultAbilityScores,
  validateStandardArray,
  type AbilityGenerationMethod,
  type AbilityScores,
  type BuilderStep,
  type CharacterBuilderWizardOptions,
  type CharacterDraft,
  type StepValidationResult,
} from "./types.ts";

/** Entry of the sheet's `items` list rendered by `InventoryContainerTree`. */
interface SheetInventoryItem {
  id: string;
  name: string;
  quantity: number;
  isContainer: boolean;
  containerId: string | null;
}

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** `getClassChoices` ids picked on each class step (invariant 6). */
const STEP_CHOICES: Partial<Record<BuilderStep, readonly string[]>> = {
  skills: ["skills", "tools"],
  equipment: ["equipment"],
  spells: ["cantrips", "spells"],
};

/** Validation error of each class step. */
const STEP_CHOICE_ERROR: Partial<Record<BuilderStep, string>> = {
  skills: "builder.error.skills",
  equipment: "builder.error.classEquipment",
  spells: "builder.error.spells",
};

function isChoiceComplete(choice: BuilderChoice, picked: readonly string[]): boolean {
  const allowed = new Set(choice.options.map((option) => option.id));
  return picked.length === choice.count && new Set(picked).size === picked.length && picked.every((id) => allowed.has(id));
}

function newActorId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `actor-${Date.now()}`;
}

export class CharacterBuilderWizard {
  public readonly draftStore: BuilderDraftStore;
  private currentStepIndex = 0;

  public constructor(options: CharacterBuilderWizardOptions = {}) {
    this.draftStore = options.draftStore ?? BuilderDraftStore.getDefaultInstance();
    this.draftStore.initDraft(options.initialDraft);
  }

  public get currentStep(): BuilderStep {
    return BUILDER_STEPS[this.currentStepIndex];
  }

  public getDraft(): CharacterDraft | null {
    return this.draftStore.getDraft();
  }

  public setName(name: string): void {
    this.draftStore.updateDraft({ name });
  }

  public setSpecies(speciesId: string | null): void {
    this.draftStore.updateDraft({ speciesId });
  }

  /** Selecting another class clears its picks (they come from the class lists). */
  public setClass(classId: string | null): void {
    const draft = this.draftStore.getDraft();
    this.draftStore.updateDraft({ classId, ...(draft?.classId === classId ? {} : { classSelections: {} }) });
  }

  /**
   * Selecting another background resets the ability split to `+1/+1/+1` and
   * the class skill picks (the background's skills are no longer offered).
   */
  public setBackground(backgroundId: string | null): void {
    const { skills: _skills, ...rest } = this.draftStore.getDraft()?.classSelections ?? {};
    this.draftStore.updateDraft({ backgroundId, backgroundChoice: backgroundId ? { mode: "plus1_each" } : null, classSelections: rest });
  }

  /** Class choices of the drafted class, without the skills its background grants (`[]` before a class). */
  public getClassChoices(): BuilderChoice[] {
    const draft = this.draftStore.getDraft();
    if (!draft || !getClassProgression(draft.classId ?? undefined)) return [];
    return getClassChoices(draft.classId!, { actor: this.originActor(draft) ?? undefined });
  }

  /** Class choices picked on `step` (`skills`, `equipment`, `spells`; `[]` elsewhere). */
  public choicesForStep(step: BuilderStep): BuilderChoice[] {
    const ids = STEP_CHOICES[step] ?? [];
    return this.getClassChoices().filter((choice) => ids.includes(choice.id));
  }

  /** Current picks of class choice `choiceId`. */
  public getClassSelection(choiceId: string): string[] {
    return this.draftStore.getDraft()?.classSelections?.[choiceId] ?? [];
  }

  /**
   * Toggles one option of class choice `choiceId`: a single-pick choice
   * replaces its pick; otherwise a pick is added only while fewer than
   * `count` are chosen, and removed when picked again.
   */
  public toggleClassOption(choiceId: string, optionId: string): void {
    const choice = this.getClassChoices().find((c) => c.id === choiceId);
    if (!choice) return;
    const picked = this.getClassSelection(choiceId);
    const next = picked.includes(optionId)
      ? picked.filter((id) => id !== optionId)
      : choice.count === 1
        ? [optionId]
        : picked.length < choice.count
          ? [...picked, optionId]
          : picked;
    const selections = this.draftStore.getDraft()?.classSelections ?? {};
    this.draftStore.updateDraft({ classSelections: { ...selections, [choiceId]: next } });
  }

  public setBackgroundChoice(choice: CharacterDraft["backgroundChoice"]): void {
    this.draftStore.updateDraft({ backgroundChoice: choice });
  }

  public setAbilityScores(scores: Partial<AbilityScores>, method?: AbilityGenerationMethod): void {
    const current = this.draftStore.getDraft()?.abilityScores ?? createDefaultAbilityScores();
    this.draftStore.updateDraft({
      abilityScores: { ...current, ...scores },
      ...(method ? { abilityGenerationMethod: method } : {}),
    });
  }

  public setEquipment(equipmentIds: string[]): void {
    this.draftStore.updateDraft({ equipmentIds: [...equipmentIds] });
  }

  /** Final scores = base scores + the background increases (when valid). */
  public getFinalAbilityScores(): AbilityScores {
    const draft = this.draftStore.getDraft();
    const base = { ...(draft?.abilityScores ?? createDefaultAbilityScores()) };
    const background = getBackgroundRules(draft?.backgroundId ?? undefined);
    if (!background || !draft?.backgroundChoice) return base;
    try {
      for (const [ab, bonus] of Object.entries(backgroundAbilityIncreases(background, draft.backgroundChoice))) {
        base[ab as keyof AbilityScores] += bonus ?? 0;
      }
    } catch {
      return base;
    }
    return base;
  }

  public getRemainingPointBuyBudget(): number {
    const draft = this.draftStore.getDraft();
    return MAX_POINT_BUY_BUDGET - (draft ? calculatePointBuyCost(draft.abilityScores) : 0);
  }

  /** Validates one step; `errors` are i18n keys under `builder.error.*`. */
  public validateStep(step: BuilderStep): StepValidationResult {
    const draft = this.draftStore.getDraft();
    if (!draft) return { valid: false, errors: ["builder.error.noDraft"] };
    const errors: string[] = [];
    switch (step) {
      case "species":
        if (!getSpeciesRules(draft.speciesId ?? undefined)) errors.push("builder.error.species");
        break;
      case "class":
        if (!getClassProgression(draft.classId ?? undefined)) errors.push("builder.error.class");
        break;
      case "background": {
        const background = getBackgroundRules(draft.backgroundId ?? undefined);
        if (!background || !draft.backgroundChoice) {
          errors.push("builder.error.background");
          break;
        }
        try {
          backgroundAbilityIncreases(background, draft.backgroundChoice);
        } catch {
          errors.push("builder.error.backgroundChoice");
        }
        break;
      }
      case "abilityScores":
        if (draft.abilityGenerationMethod === "standardArray") {
          if (!validateStandardArray(draft.abilityScores)) errors.push("builder.error.standardArray");
        } else if (calculatePointBuyCost(draft.abilityScores) > MAX_POINT_BUY_BUDGET) {
          errors.push("builder.error.pointBuy");
        }
        break;
      case "equipment":
        if (draft.equipmentIds.length === 0) errors.push("builder.error.equipment");
        errors.push(...this.classChoiceErrors(step));
        break;
      case "skills":
      case "spells":
        errors.push(...this.classChoiceErrors(step));
        break;
      case "review":
        if (!draft.name.trim()) errors.push("builder.error.name");
        for (const s of BUILDER_STEPS.slice(0, -1)) errors.push(...this.validateStep(s).errors);
        break;
    }
    return { valid: errors.length === 0, errors };
  }

  private classChoiceErrors(step: BuilderStep): string[] {
    const complete = this.choicesForStep(step).every((choice) => isChoiceComplete(choice, this.getClassSelection(choice.id)));
    return complete ? [] : [STEP_CHOICE_ERROR[step]!];
  }

  public canAdvance(): boolean {
    return !this.isLastStep() && this.validateStep(this.currentStep).valid;
  }

  public nextStep(): boolean {
    if (!this.canAdvance()) return false;
    this.currentStepIndex++;
    return true;
  }

  public previousStep(): boolean {
    if (this.currentStepIndex === 0) return false;
    this.currentStepIndex--;
    return true;
  }

  /** Jumps to `target`; forward jumps require every earlier step to validate. */
  public goToStep(target: BuilderStep): boolean {
    const idx = BUILDER_STEPS.indexOf(target);
    if (idx < 0) return false;
    if (idx > this.currentStepIndex && BUILDER_STEPS.slice(0, idx).some((s) => !this.validateStep(s).valid)) {
      return false;
    }
    this.currentStepIndex = idx;
    return true;
  }

  public isFirstStep(): boolean {
    return this.currentStepIndex === 0;
  }

  public isLastStep(): boolean {
    return this.currentStepIndex === BUILDER_STEPS.length - 1;
  }

  public cancel(): void {
    this.draftStore.cancel();
    this.currentStepIndex = 0;
  }

  /**
   * Finalizes the draft into a level-1 `Dnd5eActorData`. The draft is kept so
   * a failed `POST .../actors` can be retried; the caller clears it on success.
   * Returns `null` outside the review step or when any step is invalid.
   */
  public confirm(): Dnd5eActorData | null {
    const draft = this.draftStore.getDraft();
    if (this.currentStep !== "review" || !draft || !this.validateStep("review").valid) return null;
    return this.buildActor(draft);
  }

  private buildActor(draft: CharacterDraft): Dnd5eActorData {
    return applyClassChoices(this.originActor(draft)!, draft.classId!, draft.classSelections ?? {});
  }

  /**
   * The draft as an actor before its class picks (species, class basics,
   * background, background equipment); `null` until species, class and
   * background are valid.
   */
  private originActor(draft: CharacterDraft): Dnd5eActorData | null {
    if (!["species", "class", "background"].every((s) => this.validateStep(s as BuilderStep).valid)) return null;
    const progression = getClassProgression(draft.classId!)!;
    const species = getSpeciesRules(draft.speciesId!)!;
    const actor = createDefaultActorData(draft.id ?? newActorId(), draft.name.trim());
    actor.classId = draft.classId!;
    actor.speciesId = `srd:species:${draft.speciesId}`;
    for (const ab of DND5E_ABILITIES) {
      actor.abilities[ab].score = draft.abilityScores[ab];
      actor.abilities[ab].saveProficiency = progression.savingThrows.includes(ab);
    }
    const hp = progression.hitDie + abilityMod(draft.abilityScores.con) + species.hpBonusPerLevel;
    actor.attributes.hitDieSize = progression.hitDie;
    actor.attributes.hp = { current: hp, max: hp, temp: 0 };
    actor.attributes.speedFt = species.speedFt;
    actor.attributes.casterType = progression.casterType;
    if (progression.spellcastingAbility) actor.attributes.spellcastingAbility = progression.spellcastingAbility;
    actor.features = [...species.traits];
    const finalized: Dnd5eActorData = applyBackground(
      actor,
      draft.backgroundId!,
      draft.backgroundChoice!,
    );
    finalized.items = draft.equipmentIds.map((name, i): SheetInventoryItem => ({
      id: `item-${i + 1}`,
      name,
      quantity: 1,
      isContainer: false,
      containerId: null,
    }));
    return finalized;
  }
}
