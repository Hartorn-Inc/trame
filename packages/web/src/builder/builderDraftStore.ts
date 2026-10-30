import {
  createDefaultDraft,
  type CharacterDraft,
} from "./types.ts";

export type DraftSubscriber = (draft: CharacterDraft | null) => void;

/**
 * In-memory local draft store for character builder workflows.
 * Manages character draft state locally without dispatching network commands
 * or mutating shared CRDT states during intermediate creation steps.
 */
export class BuilderDraftStore {
  private static readonly defaultStore = new BuilderDraftStore();
  private activeDraft: CharacterDraft | null = null;
  private readonly subscribers = new Set<DraftSubscriber>();

  public constructor(initialDraft?: CharacterDraft | null) {
    this.activeDraft = initialDraft !== undefined ? initialDraft : null;
  }

  public getDraft(): CharacterDraft | null {
    return this.activeDraft ? { ...this.activeDraft } : null;
  }

  public get draft(): CharacterDraft | null {
    return this.getDraft();
  }

  public setDraft(draft: CharacterDraft | null): void {
    this.activeDraft = draft ? { ...draft } : null;
    this.notify();
  }

  public updateDraft(patch: Partial<CharacterDraft>): void {
    if (this.activeDraft === null) {
      this.activeDraft = createDefaultDraft(patch);
    } else {
      this.activeDraft = {
        ...this.activeDraft,
        ...patch,
        abilityScores: patch.abilityScores
          ? { ...this.activeDraft.abilityScores, ...patch.abilityScores }
          : this.activeDraft.abilityScores,
        equipmentIds: patch.equipmentIds
          ? [...patch.equipmentIds]
          : this.activeDraft.equipmentIds,
        spellIds: patch.spellIds
          ? [...patch.spellIds]
          : this.activeDraft.spellIds,
        featIds: patch.featIds
          ? [...patch.featIds]
          : this.activeDraft.featIds,
        skills: patch.skills
          ? [...patch.skills]
          : this.activeDraft.skills,
        customData: patch.customData
          ? { ...this.activeDraft.customData, ...patch.customData }
          : this.activeDraft.customData,
      };
    }
    this.notify();
  }

  public initDraft(initial?: Partial<CharacterDraft>): CharacterDraft {
    this.activeDraft = createDefaultDraft(initial);
    this.notify();
    return { ...this.activeDraft };
  }

  public reset(): void {
    this.activeDraft = null;
    this.notify();
  }

  public clear(): void {
    this.activeDraft = null;
    this.notify();
  }

  public cancel(): void {
    this.activeDraft = null;
    this.notify();
  }

  public hasDraft(): boolean {
    return this.activeDraft !== null;
  }

  public subscribe(subscriber: DraftSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private notify(): void {
    const draftCopy = this.getDraft();
    for (const sub of this.subscribers) {
      sub(draftCopy);
    }
  }

  public static getDraft(): CharacterDraft | null {
    return BuilderDraftStore.defaultStore.getDraft();
  }

  public static get draft(): CharacterDraft | null {
    return BuilderDraftStore.defaultStore.getDraft();
  }

  public static setDraft(draft: CharacterDraft | null): void {
    BuilderDraftStore.defaultStore.setDraft(draft);
  }

  public static updateDraft(patch: Partial<CharacterDraft>): void {
    BuilderDraftStore.defaultStore.updateDraft(patch);
  }

  public static reset(): void {
    BuilderDraftStore.defaultStore.reset();
  }

  public static clear(): void {
    BuilderDraftStore.defaultStore.clear();
  }

  public static cancel(): void {
    BuilderDraftStore.defaultStore.cancel();
  }

  public static initDraft(initial?: Partial<CharacterDraft>): CharacterDraft {
    return BuilderDraftStore.defaultStore.initDraft(initial);
  }

  public static hasDraft(): boolean {
    return BuilderDraftStore.defaultStore.hasDraft();
  }

  public static subscribe(subscriber: DraftSubscriber): () => void {
    return BuilderDraftStore.defaultStore.subscribe(subscriber);
  }

  public static getDefaultInstance(): BuilderDraftStore {
    return BuilderDraftStore.defaultStore;
  }
}
