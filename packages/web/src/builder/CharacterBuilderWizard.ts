import { TrameCommand } from "../sheet/types.ts";
import { BuilderDraftStore } from "./builderDraftStore.ts";
import {
  BUILDER_STEPS,
  DND5E_ABILITIES,
  MAX_POINT_BUY_BUDGET,
  calculatePointBuyCost,
  createDefaultAbilityScores,
  validateStandardArray,
  type AbilityGenerationMethod,
  type AbilityId,
  type AbilityScores,
  type BuilderStep,
  type CharacterBuilderWizardOptions,
  type CharacterDraft,
  type CommandDispatcher,
  type FinalizedActorConfig,
  type StepValidationResult,
} from "./types.ts";

/**
 * Character builder wizard state machine.
 * Enforces the 5-step sequential transition:
 *   ancestry -> class -> abilityScores -> equipment -> review
 * Operates in memory on BuilderDraftStore without dispatching network commands
 * during intermediate steps.
 */
export class CharacterBuilderWizard {
  public readonly draftStore: BuilderDraftStore;
  private currentStepIndex = 0;
  private readonly dispatchCommand?: CommandDispatcher;
  private readonly systemId: string;

  public constructor(
    optionsOrDispatcher?: CharacterBuilderWizardOptions | CommandDispatcher,
    draftStore?: BuilderDraftStore,
  ) {
    if (typeof optionsOrDispatcher === "function") {
      this.dispatchCommand = optionsOrDispatcher;
      this.draftStore = draftStore ?? BuilderDraftStore.getDefaultInstance();
      this.systemId = "dnd5e";
    } else {
      this.dispatchCommand = optionsOrDispatcher?.dispatchCommand;
      this.draftStore =
        optionsOrDispatcher?.draftStore ??
        draftStore ??
        BuilderDraftStore.getDefaultInstance();
      this.systemId = optionsOrDispatcher?.systemId ?? "dnd5e";
    }

    this.currentStepIndex = 0;
    const initial =
      typeof optionsOrDispatcher === "object" && optionsOrDispatcher !== null
        ? optionsOrDispatcher.initialDraft
        : undefined;
    this.draftStore.initDraft(initial);
  }

  public get currentStep(): BuilderStep {
    return BUILDER_STEPS[this.currentStepIndex];
  }

  public get step(): BuilderStep {
    return this.currentStep;
  }

  public getStep(): BuilderStep {
    return this.currentStep;
  }

  public getStepIndex(step?: BuilderStep): number {
    return step ? BUILDER_STEPS.indexOf(step) : this.currentStepIndex;
  }

  public getDraft(): CharacterDraft | null {
    return this.draftStore.getDraft();
  }

  public get draft(): CharacterDraft | null {
    return this.getDraft();
  }

  public getDraftStore(): BuilderDraftStore {
    return this.draftStore;
  }

  public getSystemId(): string {
    return this.systemId;
  }

  public setAncestry(ancestryId: string | null): void {
    this.updateDraft({ ancestryId });
  }

  public setClass(classId: string | null, subclassId?: string | null): void {
    this.updateDraft({
      classId,
      subclassId: subclassId !== undefined ? subclassId : null,
    });
  }

  public setAbilityScores(
    scores: Partial<AbilityScores>,
    method?: AbilityGenerationMethod,
  ): void {
    const currentScores =
      this.draftStore.getDraft()?.abilityScores ?? createDefaultAbilityScores();
    const updatedScores = { ...currentScores, ...scores };
    const patch: Partial<CharacterDraft> = { abilityScores: updatedScores };
    if (method) {
      patch.abilityGenerationMethod = method;
    }
    this.updateDraft(patch);
  }

  public setAbilityGenerationMethod(method: AbilityGenerationMethod): void {
    this.updateDraft({ abilityGenerationMethod: method });
  }

  public setEquipment(equipmentIds: string[]): void {
    this.updateDraft({ equipmentIds: [...equipmentIds] });
  }

  public addEquipment(itemId: string): void {
    const current = this.draftStore.getDraft()?.equipmentIds ?? [];
    if (!current.includes(itemId)) {
      this.updateDraft({ equipmentIds: [...current, itemId] });
    }
  }

  public removeEquipment(itemId: string): void {
    const current = this.draftStore.getDraft()?.equipmentIds ?? [];
    this.updateDraft({ equipmentIds: current.filter((id) => id !== itemId) });
  }

  public setName(name: string): void {
    this.updateDraft({ name });
  }

  public setDraft(draft: CharacterDraft | null): void {
    this.draftStore.setDraft(draft);
  }

  public updateDraft(patch: Partial<CharacterDraft>): void {
    this.draftStore.updateDraft(patch);
  }

  public validateStep(step: BuilderStep): StepValidationResult {
    const draft = this.draftStore.getDraft();
    if (!draft) {
      return { valid: false, errors: ["No active draft"] };
    }

    const errors: string[] = [];

    switch (step) {
      case "ancestry": {
        if (!draft.ancestryId || draft.ancestryId.trim() === "") {
          errors.push("Ancestry selection is required before advancing.");
        }
        break;
      }
      case "class": {
        if (!draft.classId || draft.classId.trim() === "") {
          errors.push("Class selection is required before advancing.");
        }
        break;
      }
      case "abilityScores": {
        const method = draft.abilityGenerationMethod;
        if (method === "standardArray") {
          if (!validateStandardArray(draft.abilityScores)) {
            errors.push(
              "Standard array requires assigning [15, 14, 13, 12, 10, 8] without duplicates.",
            );
          }
        } else if (method === "pointBuy") {
          const cost = calculatePointBuyCost(draft.abilityScores);
          if (cost > MAX_POINT_BUY_BUDGET) {
            errors.push(
              `Point buy cost (${cost}) exceeds the maximum budget of ${MAX_POINT_BUY_BUDGET} points.`,
            );
          }
        } else if (method === "manual") {
          for (const ab of DND5E_ABILITIES) {
            const score = draft.abilityScores[ab];
            if (typeof score !== "number" || Number.isNaN(score) || score <= 0) {
              errors.push(`Invalid ability score for ${ab}.`);
            }
          }
        } else {
          const isStd = validateStandardArray(draft.abilityScores);
          const cost = calculatePointBuyCost(draft.abilityScores);
          if (!isStd && cost > MAX_POINT_BUY_BUDGET) {
            errors.push(
              `Ability scores exceed point buy budget (${cost} > ${MAX_POINT_BUY_BUDGET}) and do not match standard array.`,
            );
          }
        }
        break;
      }
      case "equipment": {
        if (!Array.isArray(draft.equipmentIds)) {
          errors.push("Equipment list must be an array.");
        }
        break;
      }
      case "review": {
        const preceding: BuilderStep[] = [
          "ancestry",
          "class",
          "abilityScores",
          "equipment",
        ];
        for (const s of preceding) {
          const result = this.validateStep(s);
          if (!result.valid) {
            errors.push(...result.errors);
          }
        }
        break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  public canTransitionTo(targetStep: BuilderStep): boolean {
    const targetIdx = BUILDER_STEPS.indexOf(targetStep);
    if (targetIdx === -1) {
      return false;
    }
    if (targetIdx <= this.currentStepIndex) {
      return true;
    }
    for (let i = 0; i < targetIdx; i++) {
      if (!this.validateStep(BUILDER_STEPS[i]).valid) {
        return false;
      }
    }
    return true;
  }

  public goToStep(targetStep: BuilderStep): boolean {
    const targetIdx = BUILDER_STEPS.indexOf(targetStep);
    if (targetIdx === -1) {
      return false;
    }
    if (targetIdx < this.currentStepIndex) {
      this.currentStepIndex = targetIdx;
      return true;
    }
    if (targetIdx === this.currentStepIndex) {
      return true;
    }
    for (let i = 0; i < targetIdx; i++) {
      if (!this.validateStep(BUILDER_STEPS[i]).valid) {
        return false;
      }
    }
    this.currentStepIndex = targetIdx;
    return true;
  }

  public nextStep(): boolean {
    if (this.currentStepIndex >= BUILDER_STEPS.length - 1) {
      return false;
    }
    const currentStepName = BUILDER_STEPS[this.currentStepIndex];
    if (!this.validateStep(currentStepName).valid) {
      return false;
    }
    this.currentStepIndex++;
    return true;
  }

  public advance(): boolean {
    return this.nextStep();
  }

  public previousStep(): boolean {
    if (this.currentStepIndex <= 0) {
      return false;
    }
    this.currentStepIndex--;
    return true;
  }

  public prevStep(): boolean {
    return this.previousStep();
  }

  public canAdvance(): boolean {
    if (this.currentStepIndex >= BUILDER_STEPS.length - 1) {
      return false;
    }
    return this.validateStep(BUILDER_STEPS[this.currentStepIndex]).valid;
  }

  public isFirstStep(): boolean {
    return this.currentStepIndex === 0;
  }

  public isLastStep(): boolean {
    return this.currentStepIndex === BUILDER_STEPS.length - 1;
  }

  public getPointBuyCost(): number {
    const draft = this.draftStore.getDraft();
    if (!draft) return 0;
    return calculatePointBuyCost(draft.abilityScores);
  }

  public getRemainingPointBuyBudget(): number {
    return MAX_POINT_BUY_BUDGET - this.getPointBuyCost();
  }

  public isPointBuyValid(): boolean {
    return this.getPointBuyCost() <= MAX_POINT_BUY_BUDGET;
  }

  public isStandardArrayValid(): boolean {
    const draft = this.draftStore.getDraft();
    if (!draft) return false;
    return validateStandardArray(draft.abilityScores);
  }

  public cancel(): void {
    this.draftStore.cancel();
    this.currentStepIndex = 0;
  }

  public cancelCreation(): void {
    this.cancel();
  }

  public reset(): void {
    this.cancel();
  }

  public confirm(): boolean {
    if (this.currentStep !== "review") {
      return false;
    }
    const draft = this.draftStore.getDraft();
    if (!draft) {
      return false;
    }
    if (!this.validateStep("review").valid) {
      return false;
    }

    const finalized = this.buildFinalizedActor(draft);

    const command = TrameCommand.CreateActor({
      actorId: finalized.id,
      systemId: finalized.systemId,
      actor: finalized,
      character: finalized,
      data: finalized,
      name: finalized.name,
      ancestryId: finalized.ancestryId,
      classId: finalized.classId,
      subclassId: finalized.subclassId,
      abilityScores: finalized.abilityScores,
      abilities: finalized.abilities,
      equipmentIds: finalized.equipmentIds,
      items: finalized.items,
      spellIds: finalized.spellIds,
      featIds: finalized.featIds,
      skills: finalized.skills,
      backgroundId: finalized.backgroundId,
      bio: finalized.bio,
      notes: finalized.notes,
    });

    if (this.dispatchCommand) {
      this.dispatchCommand(command);
    }

    this.draftStore.clear();
    return true;
  }

  public confirmCreation(): boolean {
    return this.confirm();
  }

  private buildFinalizedActor(draft: CharacterDraft): FinalizedActorConfig {
    const abilities = {} as Record<
      AbilityId,
      { score: number; mod: number; saveProficiency: boolean }
    >;
    for (const ab of DND5E_ABILITIES) {
      const score = draft.abilityScores[ab] ?? 10;
      const mod = Math.floor((score - 10) / 2);
      abilities[ab] = {
        score,
        mod,
        saveProficiency: false,
      };
    }

    return {
      id: draft.id ?? `actor-pc-${Date.now()}`,
      name: draft.name?.trim() ? draft.name.trim() : "Unnamed Character",
      type: "character",
      systemId: draft.systemId ?? this.systemId,
      ancestryId: draft.ancestryId!,
      classId: draft.classId!,
      subclassId: draft.subclassId ?? null,
      abilityScores: { ...draft.abilityScores },
      abilities,
      equipmentIds: [...draft.equipmentIds],
      items: draft.equipmentIds.map((id) => ({ id, quantity: 1 })),
      spellIds: [...(draft.spellIds ?? [])],
      featIds: [...(draft.featIds ?? [])],
      skills: [...(draft.skills ?? [])],
      backgroundId: draft.backgroundId ?? null,
      bio: draft.bio ?? "",
      notes: draft.notes ?? "",
      customData: { ...(draft.customData ?? {}) },
    };
  }
}
