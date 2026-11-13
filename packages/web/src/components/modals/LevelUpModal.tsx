/**
 * ============================================================================
 * D&D 5E LEVEL-UP 4-STEP WIZARD MODAL (components/modals/LevelUpModal.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Accessible four-step progression dialog (archetype/subclass, hit points,
 * ASI or feat, spell slots & summary) wrapping `applyLevelUp` and
 * `applyFeatChoices` so characters advance cleanly under SRD 5.2.1 rules.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Slot-Scoped Feat Filtering`:
 *      - Feat slots filter `getFeats()` against `getLevelUpFeatOptions(actor, targetLevel)`
 *        so level prerequisites (L4 General vs L19 Epic Boons), ability/spellcasting/
 *        Fighting Style prerequisites, non-repeatable feats, and the `"asi"` pseudo-feat
 *        are enforced before selection while preserving custom homebrew entries.
 *   2. `Feat +1 Ability Increase Ceiling`:
 *      - Feats with `SRD_FEATS[key].abilityIncrease` (`Grappler` capped at `20`,
 *        all 7 level-19 Epic Boons capped at `30`) expose `#feat-ability-increase`
 *        offering only abilities below `max` and pass `abilityIncrease` to `applyLevelUp`.
 *   3. `Feat Sub-Choices Complete Before Commit`:
 *      - Feats exposing `getFeatChoices` (`Magic Initiate`, `Skilled`) auto-seed
 *        single-option `spell_list` picks, gate progression until every choice
 *        has `count` distinct valid picks, and run `applyFeatChoices` after `applyLevelUp`.
 *   4. `Accessible Focus, Tablist & Alert Escalation`:
 *      - Traps focus inside `role="dialog"`, focuses each step heading on step
 *        transitions, keeps roving tabindex on the ASI/Feat tablist, and escalates
 *        validation hints to `role="alert"` only after an invalid Next/Confirm attempt.
 *   5. `Prepared-Caster Spell Allowance & Described Choice Reminders`:
 *      - `getNewSpellsAllowance` derives Bard, Sorcerer, and Warlock spell gains from
 *        `getPreparedSpellCount(class, targetLevel) - getPreparedSpellCount(class, targetLevel - 1)`
 *        (SRD 5.2.1 tables) while keeping Wizard at `2` spellbook spells per level.
 *      - Step 4 Summary displays a localized reminder when `targetLevel` grants
 *        `Scholar`, `Deft Explorer`, or `Metamagic` so players record manual picks.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `handleConfirmLevelUp()`
 *     ├── 1. Verify steps 1–4 (`canProceed()`); escalate hint on refusal.
 *     ├── 2. Compile `LevelUpOptions` (`asiOrFeat` with `abilityIncrease`, spells, HP).
 *     ├── 3. Run `applyLevelUp(actor, options)`.
 *     ├── 4. When the chosen feat has sub-choices, run `applyFeatChoices(...)`.
 *     └── 5. Persist via `onSave(updatedActor)` and close the dialog.
 * ============================================================================
 */
import { h, type ComponentChildren, type VNode } from "preact";
import { useState, useId, useLayoutEffect, useRef } from "preact/hooks";
import { localizedName, t, tn, type MessageKey } from "../../i18n/index.ts";
import { useModalFocusTrap } from "../a11y/useModalFocusTrap.ts";
import {
  CompendiumResolver,
  SRD_FEATS,
  TOOL_OPTION_PREFIX,
  applyFeatChoices,
  applyLevelUp,
  calculateProficiencyBonus,
  getCasterTypeForClass,
  getClassProgression,
  getFeatChoices,
  getFightingStyleFeatOptions,
  getLevelUpFeatOptions,
  getPreparedSpellCount,
  getSubclassUnlockLevel,
  grantsFightingStyleFeat,
  isAsiLevel,
  reconcileSlots,
  getSubclasses,
  getFeats,
  getSpellsByLevel,
  srdFeatKey,
  type AbilityId,
  type AsiOrFeatSelection,
  type BuilderChoice,
  type BuilderChoiceOption,
  type BuilderSelections,
  type CasterType,
  type Dnd5eActorData,
  type LevelUpOptions,
  type SpellSlotsState,
} from "../../../../game-systems/dnd5e/src/index.ts";

/** Certified dice roll payload returned by `DiceRollService`. */
export interface DiceRollResult {
  /** Final rolled total (`>= 1`). */
  total: number;
  /** Individual die face outcomes in roll order. */
  rolls: number[];
  /** Canonical dice notation evaluated by the server (e.g. `"1d10"`). */
  formula: string;
  /** Optional server-authoritative cryptographic roll signature. */
  signature?: string;
}

/** Server-backed dice roller used for certified Hit Die advancement rolls. */
export interface DiceRollService {
  roll(formula: string, options?: { reason?: string; actorId?: string }): Promise<DiceRollResult>;
}

/** Props controlling `LevelUpModal`. */
export interface LevelUpModalProps {
  /** Whether the modal dialog is mounted and open. */
  isOpen: boolean;
  /** Authoritative D&D 5e actor sheet advancing by one level. */
  actor: Dnd5eActorData;
  /** Callback invoked when the user cancels or completes level-up. */
  onClose: () => void;
  /** Callback persisting the newly leveled-up actor data. */
  onSave: (updatedActor: Dnd5eActorData) => void | Promise<void>;
  /** Optional dice service enabling authoritative Hit Die rolling on Step 2. */
  diceRollService?: DiceRollService;
  /** Optional lock flag passed through from the parent sheet header. */
  coreStatsLocked?: boolean;
  /** Optional lock toggle callback passed through from the parent sheet header. */
  onToggleCoreStatsLocked?: (locked: boolean) => void;
}

const ABILITY_LABEL_KEYS: Record<AbilityId, MessageKey> = {
  str: "ability.str.label",
  dex: "ability.dex.label",
  con: "ability.con.label",
  int: "ability.int.label",
  wis: "ability.wis.label",
  cha: "ability.cha.label",
};

const ABILITY_KEYS: AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

const MANUAL_CHOICE_FEATURES = ["Scholar", "Deft Explorer", "Metamagic"] as const;

/**
 * Computes the maximum number of new class spells an actor may add at `targetLevel`:
 * - Wizard adds `2` spells to its spellbook at each level-up.
 * - Bard, Sorcerer, and Warlock add the SRD 5.2.1 prepared-spells delta
 *   `max(0, getPreparedSpellCount(class, targetLevel) - getPreparedSpellCount(class, targetLevel - 1))`.
 * - Other classes return `0`.
 */
export function getNewSpellsAllowance(cleanClass: string, targetLevel: number): number {
  const normalized = cleanClass.replace(/^srd:class:/, "").toLowerCase();
  if (targetLevel < 2 || targetLevel > 20) {
    if (targetLevel === 1) {
      return normalized === "wizard" ? 2 : getPreparedSpellCount(normalized, 1);
    }
    return 0;
  }
  if (normalized === "wizard") {
    return 2;
  }
  if (normalized === "bard" || normalized === "sorcerer" || normalized === "warlock") {
    return Math.max(
      0,
      getPreparedSpellCount(normalized, targetLevel) - getPreparedSpellCount(normalized, targetLevel - 1)
    );
  }
  return 0;
}

function formatSlotLabel(slotKey: string): string {
  if (slotKey.toLowerCase().startsWith("level")) {
    return t("levelUp.spells.slotLevel", { level: slotKey.slice(5) });
  }
  return slotKey.toUpperCase();
}

/** Localized name of a Fighting Style feat id (`"srd:feat:archery"`). */
function fightingStyleLabel(featId: string): string {
  return t(`builder.feat.${featId.replace(/^srd:feat:/, "")}` as MessageKey);
}

function formatModifier(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function isChoiceComplete(choice: BuilderChoice, picked: readonly string[]): boolean {
  const allowed = new Set(choice.options.map((option) => option.id));
  return picked.length === choice.count && new Set(picked).size === picked.length && picked.every((id) => allowed.has(id));
}

/** SRD rules text of a spell option (English, verbatim), `null` when the compendium has none. */
function spellDescription(spellId: string): string | null {
  const description = CompendiumResolver.getDefault().get(spellId)?.data.description;
  return typeof description === "string" && description.trim() ? description : null;
}

/**
 * Resolves required sub-choices for `featId` (`Magic Initiate`, `Skilled`),
 * auto-seeding single-option `spell_list` picks so dependent spell choices
 * resolve immediately on first render.
 */
function resolveFeatSubChoices(
  featId: string,
  rawSelections: BuilderSelections,
  actor: Dnd5eActorData
): { choices: BuilderChoice[]; selections: Record<string, readonly string[]> } {
  if (!featId.trim()) return { choices: [], selections: {} };
  const initial = getFeatChoices(featId, { selections: rawSelections, actor });
  if (initial.length === 0) return { choices: [], selections: {} };
  const seeded: Record<string, readonly string[]> = { ...rawSelections };
  let didSeed = false;
  for (const choice of initial) {
    if (
      choice.kind === "spell_list" &&
      seeded[choice.id] === undefined &&
      choice.options.length === choice.count &&
      choice.count > 0
    ) {
      seeded[choice.id] = choice.options.map((option) => option.id);
      didSeed = true;
    }
  }
  const choices = didSeed ? getFeatChoices(featId, { selections: seeded, actor }) : initial;
  return { choices, selections: seeded };
}

export function LevelUpModal(props: LevelUpModalProps): VNode<any> | null {
  return props.isOpen ? h(LevelUpDialog, props) : null;
}

function LevelUpDialog(props: LevelUpModalProps): VNode<any> {
  const { actor, onClose, onSave, diceRollService } = props;
  const titleId = useId();
  const descId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const asiTabRef = useRef<HTMLButtonElement | null>(null);
  const featTabRef = useRef<HTMLButtonElement | null>(null);
  const renderedStep = useRef<number>(1);
  useModalFocusTrap(dialogRef, { onEscape: onClose });

  const currentLevel = actor.attributes.level;
  const targetLevel = currentLevel + 1;
  const classId = (actor.classId ?? actor.class ?? actor.attributes.classId ?? actor.attributes.class ?? "").toString();
  const cleanClassId = classId.replace(/^srd:class:/, "").toLowerCase();
  const hitDieSize = actor.attributes.hitDieSize || 8;
  const conModifier = Math.floor((actor.abilities.con.score - 10) / 2);
  const subclassUnlockTier = getSubclassUnlockLevel(classId);
  const needsSubclass = targetLevel >= subclassUnlockTier && !(actor.subclassId || actor.attributes.subclassId);
  const isAsi = isAsiLevel(targetLevel, classId);
  const casterType: CasterType = actor.attributes.casterType || getCasterTypeForClass(classId);
  const isSpellcaster = casterType !== "none";
  const isDivineCaster = cleanClassId === "cleric" || cleanClassId === "druid" || cleanClassId === "paladin";
  const isWizard = cleanClassId === "wizard";
  const isKnownCaster = cleanClassId === "sorcerer" || cleanClassId === "bard" || cleanClassId === "warlock";

  // Modal Wizard Step State
  const [currentStep, setCurrentStep] = useState<number>(1);
  // Step whose Next/Confirm was pressed while invalid; its hints escalate to alerts.
  const [attemptedStep, setAttemptedStep] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (renderedStep.current !== currentStep) {
      renderedStep.current = currentStep;
      headingRef.current?.focus();
    }
  }, [currentStep]);
  const [subclassId, setSubclassId] = useState<string>(actor.subclassId || actor.attributes.subclassId || "");

  // Step 2: Hit Points State
  const [hpMode, setHpMode] = useState<"fixed" | "rolled">("fixed");
  const [rolledValue, setRolledValue] = useState<number | null>(null);
  const [rollLoading, setRollLoading] = useState<boolean>(false);
  const [rollError, setRollError] = useState<string | null>(null);

  // Step 3: ASI / Feat State
  const [asiOrFeatMode, setAsiOrFeatMode] = useState<"asi" | "feat">("asi");
  const [asiSubMode, setAsiSubMode] = useState<"plusTwo" | "plusOneOne">("plusTwo");
  const [asiSingleAbility, setAsiSingleAbility] = useState<AbilityId>("str");
  const [asiFirstAbility, setAsiFirstAbility] = useState<AbilityId>("str");
  const [asiSecondAbility, setAsiSecondAbility] = useState<AbilityId>("dex");
  const [selectedFeatId, setSelectedFeatId] = useState<string>("");
  const [featAbilityIncrease, setFeatAbilityIncrease] = useState<AbilityId | "">("");
  const [featSelections, setFeatSelections] = useState<BuilderSelections>({});
  const [fightingStyleFeatId, setFightingStyleFeatId] = useState<string>("");

  // Step 4: Spells State
  const [selectedSpellIds, setSelectedSpellIds] = useState<string[]>([]);

  // Save error state
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const fixedHpGain = Math.max(1, Math.floor(hitDieSize / 2) + 1 + conModifier);
  const currentHpGain = hpMode === "fixed" ? fixedHpGain : rolledValue !== null ? Math.max(1, rolledValue + conModifier) : 0;

  // Compendium Options
  const availableSubclasses = needsSubclass ? getSubclasses(classId) : [];
  const allowedSrdFeatKeys = isAsi ? new Set(getLevelUpFeatOptions(actor, targetLevel)) : null;
  const availableFeats = allowedSrdFeatKeys
    ? getFeats().filter((feat) => {
        const key = srdFeatKey(feat.id);
        return key === undefined || allowedSrdFeatKeys.has(key);
      })
    : [];
  const selectedSrdFeatKey = isAsi && asiOrFeatMode === "feat" && selectedFeatId ? srdFeatKey(selectedFeatId) : undefined;
  const featIncreaseSpec = selectedSrdFeatKey ? SRD_FEATS[selectedSrdFeatKey].abilityIncrease : undefined;
  const eligibleIncreaseAbilities: AbilityId[] = featIncreaseSpec
    ? featIncreaseSpec.abilities.filter((ab) => (actor.abilities[ab]?.score ?? 10) < featIncreaseSpec.max)
    : [];
  const { choices: featSubChoices, selections: effectiveFeatSelections } =
    isAsi && asiOrFeatMode === "feat"
      ? resolveFeatSubChoices(selectedFeatId, featSelections, actor)
      : { choices: [] as BuilderChoice[], selections: {} as BuilderSelections };
  const maxSpellCircle = casterType === "pact" ? Math.min(5, Math.ceil(targetLevel / 2)) : casterType === "half" ? Math.ceil(targetLevel / 4) : Math.ceil(targetLevel / 2);
  const availableSpellsForLevel = isSpellcaster && !isDivineCaster
    ? Array.from({ length: Math.min(9, Math.max(1, maxSpellCircle)) }, (_, i) => i + 1)
        .flatMap((lvl) => getSpellsByLevel(lvl, classId))
        .filter((sp) => !(actor.spellIds || []).includes(sp.id))
    : [];

  // Fighting Style feat gained at this level (Paladin/Ranger 2, Champion 7)
  const fightingStyleOptions = grantsFightingStyleFeat(classId, subclassId || undefined, targetLevel)
    ? getFightingStyleFeatOptions(actor.features ?? [])
    : [];
  const needsFightingStyle = fightingStyleOptions.length > 0;
  const targetLevelFeatures = getClassProgression(classId)?.features[targetLevel] ?? [];
  const manualChoiceFeatures = targetLevelFeatures.filter((name) =>
    (MANUAL_CHOICE_FEATURES as readonly string[]).includes(name)
  );

  // Step Validations
  const isStep1Valid = !needsSubclass || Boolean(subclassId.trim());
  const isStep2Valid = hpMode === "fixed" || (hpMode === "rolled" && rolledValue !== null && rolledValue >= 1 && rolledValue <= hitDieSize);
  
  let isStep3Valid = !needsFightingStyle || Boolean(fightingStyleFeatId);
  let asiErrorMessage: string | null = null;
  let featErrorMessage: string | null = null;
  let featErrorTarget: "feat" | "ability" | "choices" | null = null;
  if (isAsi) {
    if (asiOrFeatMode === "feat") {
      if (!selectedFeatId.trim()) {
        isStep3Valid = false;
        featErrorMessage = t("levelUp.feat.required");
        featErrorTarget = "feat";
      } else if (featIncreaseSpec && (!featAbilityIncrease || !eligibleIncreaseAbilities.includes(featAbilityIncrease))) {
        isStep3Valid = false;
        featErrorMessage = t("levelUp.feat.abilityRequired");
        featErrorTarget = "ability";
      } else if (featSubChoices.some((choice) => !isChoiceComplete(choice, effectiveFeatSelections[choice.id] ?? []))) {
        isStep3Valid = false;
        featErrorMessage = t("levelUp.feat.choicesRequired");
        featErrorTarget = "choices";
      }
    } else {
      if (asiSubMode === "plusTwo") {
        const currentScore = actor.abilities[asiSingleAbility]?.score ?? 10;
        if (currentScore + 2 > 20) {
          isStep3Valid = false;
          asiErrorMessage = t("levelUp.asi.exceedsTwo", { ability: asiSingleAbility.toUpperCase(), score: currentScore + 2 });
        }
      } else {
        if (asiFirstAbility === asiSecondAbility) {
          isStep3Valid = false;
          asiErrorMessage = t("levelUp.asi.distinct");
        } else {
          const firstScore = actor.abilities[asiFirstAbility]?.score ?? 10;
          const secondScore = actor.abilities[asiSecondAbility]?.score ?? 10;
          if (firstScore + 1 > 20) {
            isStep3Valid = false;
            asiErrorMessage = t("levelUp.asi.exceedsOne", { ability: asiFirstAbility.toUpperCase(), score: firstScore + 1 });
          } else if (secondScore + 1 > 20) {
            isStep3Valid = false;
            asiErrorMessage = t("levelUp.asi.exceedsOne", { ability: asiSecondAbility.toUpperCase(), score: secondScore + 1 });
          }
        }
      }
    }
  }

  let isStep4Valid = true;
  let spellErrorMessage: string | null = null;
  const knownAllowance = isKnownCaster ? getNewSpellsAllowance(cleanClassId, targetLevel) : 0;
  const requiredWizardCount = isWizard ? Math.min(2, availableSpellsForLevel.length) : 0;

  if (isSpellcaster) {
    if (isDivineCaster) {
      isStep4Valid = true;
    } else if (isWizard) {
      if (selectedSpellIds.length !== requiredWizardCount) {
        isStep4Valid = false;
        spellErrorMessage = t("levelUp.spells.wizardError", { required: requiredWizardCount, selected: selectedSpellIds.length });
      }
    } else if (isKnownCaster) {
      if (selectedSpellIds.length > knownAllowance) {
        isStep4Valid = false;
        spellErrorMessage = t("levelUp.spells.knownError", { limit: knownAllowance, level: targetLevel, selected: selectedSpellIds.length });
      }
    }
  }

  const canProceed = () => {
    if (currentStep === 1) return isStep1Valid;
    if (currentStep === 2) return isStep2Valid;
    if (currentStep === 3) return isStep3Valid;
    return isStep1Valid && isStep2Valid && isStep3Valid && isStep4Valid;
  };

  // Handle Server Dice Roll
  const handleRollDice = async () => {
    if (rollLoading) return;
    if (!diceRollService) {
      setRollError(t("dice.serviceUnavailable"));
      return;
    }
    try {
      setRollLoading(true);
      setRollError(null);
      const result = await diceRollService.roll(`1d${hitDieSize}`, {
        reason: `Level up HP (Lvl ${currentLevel} -> ${targetLevel})`,
        actorId: actor.id,
      });
      const rolled = result.rolls && result.rolls.length > 0 ? result.rolls[0] : result.total;
      setRolledValue(rolled);
    } catch (err: any) {
      setRollError(err.message || t("dice.rollFailed"));
      setRolledValue(null);
    } finally {
      setRollLoading(false);
    }
  };

  // Compile and Save
  const handleConfirmLevelUp = async () => {
    if (isSubmitting) return;
    if (!canProceed()) {
      setAttemptedStep(currentStep);
      return;
    }
    try {
      setIsSubmitting(true);
      setSaveError(null);

      let compiledAsiOrFeat: AsiOrFeatSelection | undefined = undefined;
      if (isAsi) {
        if (asiOrFeatMode === "feat") {
          compiledAsiOrFeat = {
            mode: "feat",
            featId: selectedFeatId,
            ...(featIncreaseSpec && featAbilityIncrease ? { abilityIncrease: featAbilityIncrease } : {}),
          };
        } else {
          if (asiSubMode === "plusTwo") {
            compiledAsiOrFeat = {
              mode: "asi",
              bonuses: { [asiSingleAbility]: 2 },
            };
          } else {
            compiledAsiOrFeat = {
              mode: "asi",
              bonuses: {
                [asiFirstAbility]: 1,
                [asiSecondAbility]: 1,
              },
            };
          }
        }
      }

      const options: LevelUpOptions = {
        targetLevel,
        hitPointsMode: hpMode,
        rolledHp: hpMode === "rolled" ? rolledValue ?? undefined : undefined,
        subclassId: needsSubclass ? subclassId : undefined,
        asiOrFeat: compiledAsiOrFeat,
        newSpellIds: selectedSpellIds,
        casterType,
        classId,
        fightingStyleFeatId: needsFightingStyle ? fightingStyleFeatId : undefined,
      };

      let updatedActor = applyLevelUp(actor, options);
      if (isAsi && asiOrFeatMode === "feat" && featSubChoices.length > 0) {
        updatedActor = applyFeatChoices(updatedActor, selectedFeatId, effectiveFeatSelections);
      }
      await onSave(updatedActor);
      onClose();
    } catch (err: any) {
      setSaveError(err.message || t("levelUp.saveFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNext = () => {
    if (isSubmitting) return;
    if (!canProceed()) {
      setAttemptedStep(currentStep);
      return;
    }
    setCurrentStep((s) => Math.min(4, s + 1));
  };

  const handlePrevious = () => {
    if (currentStep === 1 || isSubmitting) return;
    setCurrentStep((s) => Math.max(1, s - 1));
  };

  const handleCancel = () => {
    if (!isSubmitting) onClose();
  };

  const selectAsiOrFeatMode = (mode: "asi" | "feat", moveFocus: boolean) => {
    setAsiOrFeatMode(mode);
    if (moveFocus) (mode === "asi" ? asiTabRef : featTabRef).current?.focus();
  };

  // Two-tab roving tabindex: arrows, Home and End all move to (and select) the other tab.
  const handleTabKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      selectAsiOrFeatMode(asiOrFeatMode === "asi" ? "feat" : "asi", true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      selectAsiOrFeatMode(e.key === "Home" ? "asi" : "feat", true);
    }
  };

  const toggleSpellSelection = (spellId: string) => {
    setSelectedSpellIds((prev) => {
      if (prev.includes(spellId)) {
        return prev.filter((id) => id !== spellId);
      }
      if (isWizard && prev.length >= requiredWizardCount) {
        return prev;
      }
      if (isKnownCaster && prev.length >= knownAllowance) {
        return prev;
      }
      return [...prev, spellId];
    });
  };

  const projectedSlots: SpellSlotsState = isSpellcaster
    ? reconcileSlots(actor.spellSlots, casterType, targetLevel)
    : {};

  // Validation hint shared by every step: a quiet description until the user
  // presses Next/Confirm on an invalid step, then an alert.
  const attempted = attemptedStep === currentStep;
  const validationProps = (hasHint: boolean) =>
    hasHint ? { "aria-describedby": hintId, "aria-invalid": attempted ? ("true" as const) : undefined } : {};
  const validationHint = (message: string | null) =>
    message &&
    h(
      "p",
      { id: hintId, class: attempted ? "ds-field-error" : "ds-hint", role: attempted ? "alert" : undefined },
      message
    );

  const stepHeading = (text: string) =>
    h("h3", { ref: headingRef, tabIndex: -1, class: "ds-section-title" }, text);

  const asiTab = (mode: "asi" | "feat", label: string) => {
    const selected = asiOrFeatMode === mode;
    return h(
      "button",
      {
        ref: mode === "asi" ? asiTabRef : featTabRef,
        type: "button",
        role: "tab",
        id: `tab-${mode}`,
        "aria-selected": selected ? "true" : "false",
        "aria-controls": "tabpanel-asi-or-feat",
        tabIndex: selected ? 0 : -1,
        class: "ds-btn-reset ds-tab",
        onClick: () => selectAsiOrFeatMode(mode, false),
        onKeyDown: handleTabKeyDown,
      },
      h("span", { "aria-hidden": "true" }, selected ? "●" : "○"),
      label
    );
  };

  const abilitySelect = (id: string, labelText: string, value: AbilityId, onChange: (v: AbilityId) => void, describe: boolean) =>
    h(
      "div",
      { class: "ds-field" },
      h("label", { for: id, class: "ds-field-label" }, labelText),
      h(
        "select",
        {
          id,
          class: "ds-input atlas-tabular-nums",
          value,
          onChange: (e: any) => onChange(e.target.value as AbilityId),
          ...validationProps(describe),
        },
        ABILITY_KEYS.map((k) =>
          h("option", { key: k, value: k }, t("levelUp.asi.option", { ability: t(ABILITY_LABEL_KEYS[k]), score: actor.abilities[k].score }))
        )
      )
    );

  const handleSelectFeat = (nextFeatId: string) => {
    setSelectedFeatId(nextFeatId);
    setFeatAbilityIncrease("");
    setFeatSelections({});
  };

  const toggleFeatChoiceOption = (choiceId: string, optionId: string) => {
    const choice = featSubChoices.find((c) => c.id === choiceId);
    if (!choice) return;
    const picked = effectiveFeatSelections[choiceId] ?? [];
    const next =
      choice.count === 1
        ? [optionId]
        : picked.includes(optionId)
          ? picked.filter((id) => id !== optionId)
          : picked.length < choice.count
            ? [...picked, optionId]
            : picked;
    const nextSelections: Record<string, readonly string[]> = { ...effectiveFeatSelections, [choiceId]: next };
    for (const dep of featSubChoices) {
      if (dep.dependsOn === choiceId && next[0] !== picked[0]) {
        nextSelections[dep.id] = [];
      }
    }
    setFeatSelections(nextSelections);
  };

  const featChoiceOptionLabel = (choice: BuilderChoice, option: BuilderChoiceOption): string => {
    switch (choice.kind) {
      case "ability":
        return t(ABILITY_LABEL_KEYS[option.id as AbilityId]);
      case "skill":
        return t(`skill.${option.id}` as MessageKey);
      case "skill_or_tool":
        return option.id.startsWith(TOOL_OPTION_PREFIX)
          ? option.label
          : t(`skill.${option.id}` as MessageKey);
      case "spell_list":
        return t(`builder.class.${option.id}` as MessageKey);
      case "feat":
        return fightingStyleLabel(option.id);
      case "spell": {
        const entry = CompendiumResolver.getDefault().get(option.id);
        return entry ? localizedName(entry) : option.label;
      }
      default:
        return option.label;
    }
  };

  const renderSpellDetails = (testPrefix: string, option: BuilderChoiceOption, description: string | null, descriptionId: string) =>
    description
      ? h(
          "details",
          { class: "ds-meta", "data-testid": `${testPrefix}-details` },
          h("summary", null, t("builder.spells.details", { name: option.label })),
          h("p", { id: descriptionId, lang: "en", "data-testid": descriptionId }, description)
        )
      : null;

  const fieldset = (key: string, legend: string, children: ComponentChildren) =>
    h("fieldset", { key, class: "ds-stack-sm" }, h("legend", { class: "ds-section-title" }, legend), children);

  const renderFeatSubChoice = (choice: BuilderChoice) => {
    const picked = effectiveFeatSelections[choice.id] ?? [];
    const full = picked.length >= choice.count;
    const legend = t(`builder.choice.${choice.id}` as MessageKey, { count: choice.count });
    const radioGroup = `feat-${choice.id}`;
    if (choice.count === 1) {
      return fieldset(
        choice.id,
        legend,
        choice.options.length > 0
          ? choice.options.map((option) => {
              const checked = picked.includes(option.id);
              const description = choice.kind === "spell" ? spellDescription(option.id) : null;
              const testPrefix = `levelup-feat-${choice.id}-${option.id}`;
              const descriptionId = `${testPrefix}-description`;
              const choiceRadio = h(
                "label",
                { key: option.id, class: cx("ds-choice ds-choice-stacked", checked && "is-selected") },
                h(
                  "span",
                  { class: "ds-cluster" },
                  h("input", {
                    type: "radio",
                    name: radioGroup,
                    value: option.id,
                    checked,
                    "data-testid": testPrefix,
                    "aria-describedby": description ? descriptionId : undefined,
                    onChange: () => toggleFeatChoiceOption(choice.id, option.id),
                  }),
                  h("span", { class: "ds-value" }, featChoiceOptionLabel(choice, option))
                )
              );
              return description
                ? h("div", { key: option.id, class: "ds-stack-sm" }, choiceRadio, renderSpellDetails(testPrefix, option, description, descriptionId))
                : choiceRadio;
            })
          : h("p", { class: "ds-hint" }, t("levelUp.feat.chooseSpellListFirst"))
      );
    }
    return fieldset(choice.id, legend, [
      h(
        "p",
        {
          key: "count",
          class: "ds-meta atlas-tabular-nums",
          "aria-live": "polite",
          "data-testid": `levelup-feat-${choice.id}-count`,
        },
        t("builder.choice.picked", { picked: picked.length, count: choice.count })
      ),
      choice.options.length > 0
        ? h(
            "div",
            { key: "options", class: "ds-scroll-list ds-stack-sm" },
            choice.options.map((option) => {
              const checked = picked.includes(option.id);
              const disabled = !checked && full;
              const description = choice.kind === "spell" ? spellDescription(option.id) : null;
              const testPrefix = `levelup-feat-${choice.id}-${option.id}`;
              const descriptionId = `${testPrefix}-description`;
              return h(
                "div",
                { key: option.id, class: "ds-stack-sm" },
                h(
                  "label",
                  { class: cx("ds-choice", checked && "is-selected", disabled && "is-disabled") },
                  h("input", {
                    type: "checkbox",
                    checked,
                    disabled,
                    "data-testid": testPrefix,
                    "aria-describedby": description ? descriptionId : undefined,
                    onChange: () => toggleFeatChoiceOption(choice.id, option.id),
                  }),
                  h("span", { class: "ds-value" }, featChoiceOptionLabel(choice, option))
                ),
                renderSpellDetails(testPrefix, option, description, descriptionId)
              );
            })
          )
        : h("p", { key: "empty", class: "ds-hint" }, t("levelUp.feat.chooseSpellListFirst")),
    ]);
  };

  const hpChoice = (mode: "fixed" | "rolled", label: string, detail: VNode<any> | string) =>
    h(
      "label",
      { class: cx("ds-choice ds-choice-stacked", hpMode === mode && "is-selected") },
      h(
        "span",
        { class: "ds-cluster" },
        h("input", { type: "radio", name: "hpMode", value: mode, checked: hpMode === mode, onChange: () => setHpMode(mode) }),
        h("span", { class: "ds-value" }, label)
      ),
      h("span", { class: "ds-meta" }, detail)
    );

  const asiSubModeChoice = (mode: "plusTwo" | "plusOneOne", label: string) =>
    h(
      "label",
      { class: cx("ds-choice", asiSubMode === mode && "is-selected") },
      h("input", { type: "radio", name: "asiSubMode", value: mode, checked: asiSubMode === mode, onChange: () => setAsiSubMode(mode) }),
      h("span", null, label)
    );

  const step3AsiError = asiOrFeatMode === "asi" ? asiErrorMessage : null;
  const step3FeatError = asiOrFeatMode === "feat" ? featErrorMessage : null;
  const selectedFeatEntry = selectedFeatId ? availableFeats.find((f) => f.id === selectedFeatId) : undefined;
  const selectedFeatLabel = selectedFeatEntry ? localizedName(selectedFeatEntry) : selectedFeatId;
  const stepRefusing = !canProceed() || isSubmitting;

  return h(
    "div",
    {
      ref: dialogRef,
      "data-testid": "level-up-modal",
      class: "ds-modal-backdrop",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      "aria-describedby": descId,
      tabIndex: -1,
    },
    h(
      "div",
      { class: "ds-modal", "data-testid": "level-up-panel" },
      // Modal Header
      h(
        "header",
        { class: "ds-modal-header" },
        h(
          "div",
          null,
          h("h2", { id: titleId, class: "ds-modal-title" }, t("levelUp.title", { from: currentLevel, to: targetLevel })),
          h(
            "p",
            { id: descId, class: "ds-modal-subtitle" },
            t("levelUp.subtitle", { className: classId || t("levelUp.unknownClass"), bonus: calculateProficiencyBonus(targetLevel) })
          )
        ),
        h(
          "button",
          { type: "button", class: "ds-btn-reset ds-icon-btn", onClick: onClose, "aria-label": t("levelUp.close") },
          "✕"
        )
      ),

      // Stepper Bar
      h(
        "nav",
        { "aria-label": t("levelUp.steps.label"), class: "ds-stepper" },
        [
          { step: 1, label: t("levelUp.step.archetype") },
          { step: 2, label: t("levelUp.step.hitPoints") },
          { step: 3, label: isAsi ? t("levelUp.step.asiOrFeat") : t("levelUp.step.features") },
          { step: 4, label: isSpellcaster ? t("levelUp.step.spells") : t("levelUp.step.summary") },
        ].map((item) => {
          const isCurrent = currentStep === item.step;
          const isCompleted = currentStep > item.step;
          return h(
            "div",
            {
              key: item.step,
              "aria-current": isCurrent ? "step" : undefined,
              class: cx("ds-stepper-item", isCompleted && "is-complete"),
            },
            isCompleted ? `✓ ${item.label}` : item.label
          );
        })
      ),

      // Modal Body
      h(
        "div",
        { class: "ds-modal-body" },
        // Step 1: Subclass / Archetype
        currentStep === 1 &&
          h(
            "div",
            { class: "ds-stack" },
            stepHeading(t("levelUp.step1.heading")),
            h(
              "div",
              { class: "ds-inset" },
              h(
                "div",
                { class: "ds-row" },
                h("div", null, h("span", { class: "ds-meta" }, t("levelUp.activeClass")), h("strong", { class: "ds-value" }, classId || t("levelUp.unknown"))),
                h("div", null, h("span", { class: "ds-meta" }, t("levelUp.targetLevel")), h("span", { class: "ds-value-lg atlas-tabular-nums" }, targetLevel))
              )
            ),
            needsSubclass
              ? h(
                  "div",
                  { class: "ds-field" },
                  h("label", { for: "subclass-select", class: "ds-field-label" }, t("levelUp.subclass.label")),
                  h(
                    "select",
                    {
                      id: "subclass-select",
                      class: "ds-input",
                      value: subclassId,
                      onChange: (e: any) => setSubclassId(e.target.value),
                      ...validationProps(!subclassId),
                    },
                    h("option", { value: "" }, t("levelUp.subclass.placeholder")),
                    availableSubclasses.map((sc) => h("option", { key: sc.id, value: sc.id }, localizedName(sc)))
                  ),
                  validationHint(subclassId ? null : t("levelUp.subclass.required"))
                )
              : h(
                  "p",
                  { class: "ds-inset ds-hint" },
                  subclassId ? t("levelUp.subclass.current", { subclass: subclassId }) : t("levelUp.subclass.notNeeded")
                )
          ),

        // Step 2: Hit Points Gain
        currentStep === 2 &&
          h(
            "div",
            { class: "ds-stack" },
            stepHeading(t("levelUp.step2.heading")),
            h("p", { class: "ds-hint" }, t("levelUp.hp.dieInfo", { die: hitDieSize, mod: formatModifier(conModifier) })),
            h(
              "div",
              { class: "ds-grid-2" },
              hpChoice(
                "fixed",
                t("levelUp.hp.fixed"),
                h(
                  "span",
                  null,
                  `floor(${hitDieSize}/2) + 1 + (${conModifier}) = `,
                  h("strong", { class: "atlas-tabular-nums" }, t("hp.gain", { value: fixedHpGain }))
                )
              ),
              hpChoice("rolled", t("levelUp.hp.rolled"), t("levelUp.hp.rolledHint", { die: hitDieSize, mod: formatModifier(conModifier) }))
            ),
            hpMode === "rolled" &&
              h(
                "div",
                { class: "ds-inset" },
                h(
                  "div",
                  { class: "ds-row" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "ds-btn ds-btn-secondary",
                      onClick: handleRollDice,
                      "aria-disabled": rollLoading ? "true" : undefined,
                      "aria-busy": rollLoading ? "true" : undefined,
                      "aria-describedby": rolledValue === null && !rollError ? hintId : undefined,
                    },
                    rollLoading ? t("dice.rolling") : t("levelUp.hp.rollButton", { die: hitDieSize })
                  ),
                  rolledValue !== null &&
                    h(
                      "div",
                      null,
                      h("span", { class: "ds-meta" }, t("levelUp.hp.dieResult", { value: rolledValue })),
                      h("span", { class: "ds-value-lg atlas-tabular-nums" }, t("hp.gain", { value: Math.max(1, rolledValue + conModifier) }))
                    )
                ),
                rollError && h("p", { role: "alert", class: "ds-field-error" }, rollError),
                validationHint(rolledValue === null && !rollError ? t("levelUp.hp.rollRequired") : null)
              ),
            h(
              "p",
              { class: "ds-inset ds-hint" },
              t("levelUp.hp.projected", { current: actor.attributes.hp.max }),
              h("strong", { class: "atlas-tabular-nums" }, actor.attributes.hp.max + currentHpGain)
            )
          ),

        // Step 3: ASI or Feat
        currentStep === 3 &&
          (isAsi
            ? h(
                "div",
                { class: "ds-stack" },
                stepHeading(t("levelUp.step3.heading")),
                h(
                  "div",
                  { role: "tablist", "aria-label": t("levelUp.asi.modeLabel"), class: "ds-tablist" },
                  asiTab("asi", t("levelUp.asi.tab")),
                  asiTab("feat", t("levelUp.feat.tab"))
                ),
                h(
                  "div",
                  {
                    id: "tabpanel-asi-or-feat",
                    role: "tabpanel",
                    "aria-labelledby": asiOrFeatMode === "asi" ? "tab-asi" : "tab-feat",
                    class: "ds-stack",
                  },
                  asiOrFeatMode === "asi"
                    ? [
                        h(
                          "div",
                          { key: "submodes", class: "ds-cluster" },
                          asiSubModeChoice("plusTwo", t("levelUp.asi.plusTwo")),
                          asiSubModeChoice("plusOneOne", t("levelUp.asi.plusOneOne"))
                        ),
                        asiSubMode === "plusTwo"
                          ? h(
                              "div",
                              { key: "single" },
                              abilitySelect("asi-single-ability", t("levelUp.asi.singleLabel"), asiSingleAbility, setAsiSingleAbility, Boolean(step3AsiError))
                            )
                          : h(
                              "div",
                              { key: "pair", class: "ds-grid-2" },
                              abilitySelect("asi-first-ability", t("levelUp.asi.firstLabel"), asiFirstAbility, setAsiFirstAbility, Boolean(step3AsiError)),
                              abilitySelect("asi-second-ability", t("levelUp.asi.secondLabel"), asiSecondAbility, setAsiSecondAbility, Boolean(step3AsiError))
                            ),
                        h("div", { key: "hint" }, validationHint(step3AsiError)),
                      ]
                    : h(
                        "div",
                        { class: "ds-stack" },
                        h(
                          "div",
                          { class: "ds-field" },
                          h("label", { for: "asi-feat-select", class: "ds-field-label" }, t("levelUp.feat.label")),
                          h(
                            "select",
                            {
                              id: "asi-feat-select",
                              class: "ds-input",
                              value: selectedFeatId,
                              onChange: (e: Event) => handleSelectFeat((e.target as HTMLSelectElement).value),
                              ...validationProps(featErrorTarget === "feat"),
                            },
                            h("option", { value: "" }, t("levelUp.feat.placeholder")),
                            availableFeats.map((feat) => h("option", { key: feat.id, value: feat.id }, localizedName(feat)))
                          )
                        ),
                        featIncreaseSpec &&
                          h(
                            "div",
                            { class: "ds-field" },
                            h(
                              "label",
                              { for: "feat-ability-increase", class: "ds-field-label" },
                              t("levelUp.feat.abilityLabel", { max: featIncreaseSpec.max })
                            ),
                            h(
                              "select",
                              {
                                id: "feat-ability-increase",
                                class: "ds-input atlas-tabular-nums",
                                value: featAbilityIncrease,
                                onChange: (e: Event) => setFeatAbilityIncrease((e.target as HTMLSelectElement).value as AbilityId | ""),
                                ...validationProps(featErrorTarget === "ability"),
                              },
                              h("option", { value: "" }, t("levelUp.feat.abilityPlaceholder")),
                              eligibleIncreaseAbilities.map((ab) =>
                                h(
                                  "option",
                                  { key: ab, value: ab },
                                  t("levelUp.asi.option", { ability: t(ABILITY_LABEL_KEYS[ab]), score: actor.abilities[ab].score })
                                )
                              )
                            )
                          ),
                        ...featSubChoices.map((choice) => renderFeatSubChoice(choice)),
                        validationHint(step3FeatError)
                      )
                )
              )
            : h(
                "div",
                { class: "ds-stack" },
                stepHeading(t("levelUp.step3.featuresHeading")),
                needsFightingStyle &&
                  h(
                    "div",
                    { class: "ds-field" },
                    h("label", { for: "fighting-style-select", class: "ds-field-label" }, t("levelUp.fightingStyle.label")),
                    h(
                      "select",
                      {
                        id: "fighting-style-select",
                        class: "ds-input",
                        value: fightingStyleFeatId,
                        onChange: (e: any) => setFightingStyleFeatId(e.target.value),
                        ...validationProps(!fightingStyleFeatId),
                      },
                      h("option", { value: "" }, t("levelUp.fightingStyle.placeholder")),
                      fightingStyleOptions.map((id) => h("option", { key: id, value: id }, fightingStyleLabel(id)))
                    ),
                    validationHint(fightingStyleFeatId ? null : t("levelUp.fightingStyle.required"))
                  ),
                h(
                  "div",
                  { class: "ds-inset ds-hint" },
                  h("p", { class: "ds-hint" }, t("levelUp.noAsi.level", { level: targetLevel })),
                  h("p", { class: "ds-hint" }, t("levelUp.noAsi.features"))
                )
              )),

        // Step 4: Spells & Summary
        currentStep === 4 &&
          h(
            "div",
            { class: "ds-stack" },
            stepHeading(isSpellcaster ? t("levelUp.step4.spellsHeading") : t("levelUp.step4.summaryHeading")),
            isSpellcaster &&
              h(
                "div",
                { class: "ds-stack-sm" },
                h("h4", { class: "ds-subheading" }, t("levelUp.spells.newSlots")),
                h(
                  "div",
                  { class: "ds-grid-5" },
                  Object.entries(projectedSlots).map(([slotKey, slotData]) =>
                    h(
                      "div",
                      { key: slotKey, class: "ds-inset" },
                      h("span", { class: "ds-meta" }, formatSlotLabel(slotKey)),
                      h("strong", { class: "atlas-tabular-nums" }, tn("levelUp.spells.slots", (slotData as any).max))
                    )
                  )
                ),
                isDivineCaster &&
                  h(
                    "div",
                    { class: "ds-inset" },
                    h("strong", null, t("levelUp.spells.divineTitle")),
                    h("p", { class: "ds-hint" }, t("levelUp.spells.divineBody"))
                  ),
                !isDivineCaster && isKnownCaster && knownAllowance === 0 &&
                  h("p", { class: "ds-inset ds-hint" }, t("levelUp.spells.noneGranted", { level: targetLevel })),
                !isDivineCaster && availableSpellsForLevel.length > 0 && (!isKnownCaster || knownAllowance > 0) &&
                  h(
                    "div",
                    { class: "ds-stack-sm" },
                    h(
                      "h4",
                      { id: `${hintId}-spells`, class: "ds-subheading" },
                      isWizard
                        ? t("levelUp.spells.wizardHeading", { selected: selectedSpellIds.length, required: requiredWizardCount })
                        : isKnownCaster
                        ? t("levelUp.spells.knownHeading", { selected: selectedSpellIds.length, limit: knownAllowance })
                        : t("levelUp.spells.optionalHeading", { selected: selectedSpellIds.length })
                    ),
                    h(
                      "div",
                      {
                        role: "group",
                        "aria-labelledby": `${hintId}-spells`,
                        class: "ds-scroll-list ds-stack-sm",
                        ...(spellErrorMessage ? { "aria-describedby": hintId } : {}),
                      },
                      availableSpellsForLevel.map((spell) => {
                        const isChecked = selectedSpellIds.includes(spell.id);
                        const isMaxReached = isWizard
                          ? selectedSpellIds.length >= requiredWizardCount
                          : isKnownCaster
                          ? selectedSpellIds.length >= knownAllowance
                          : false;
                        const isDisabled = !isChecked && isMaxReached;
                        return h(
                          "label",
                          { key: spell.id, class: cx("ds-choice", isChecked && "is-selected", isDisabled && "is-disabled") },
                          h(
                            "span",
                            { class: "ds-cluster" },
                            h("input", {
                              type: "checkbox",
                              checked: isChecked,
                              disabled: isDisabled,
                              onChange: () => toggleSpellSelection(spell.id),
                            }),
                            h("span", null, localizedName(spell))
                          ),
                          h("span", { class: "ds-meta" }, t("levelUp.spells.level", { level: String(spell.data.level) }))
                        );
                      })
                    ),
                    validationHint(spellErrorMessage)
                  )
              ),
            h(
              "div",
              { class: "ds-inset" },
              h("strong", null, t("levelUp.summary.title")),
              h("div", { class: "atlas-tabular-nums" }, t("levelUp.summary.level", { from: currentLevel, to: targetLevel })),
              h("div", { class: "atlas-tabular-nums" }, t("levelUp.summary.hp", { from: actor.attributes.hp.max, to: actor.attributes.hp.max + currentHpGain, gain: currentHpGain })),
              subclassId && needsSubclass && h("div", null, t("levelUp.summary.subclass", { subclass: subclassId })),
              isAsi && asiOrFeatMode === "asi" && asiSubMode === "plusTwo" && h("div", { class: "atlas-tabular-nums" }, t("levelUp.summary.asiTwo", { ability: asiSingleAbility.toUpperCase() })),
              isAsi && asiOrFeatMode === "asi" && asiSubMode === "plusOneOne" && h("div", { class: "atlas-tabular-nums" }, t("levelUp.summary.asiOneOne", { first: asiFirstAbility.toUpperCase(), second: asiSecondAbility.toUpperCase() })),
              isAsi &&
                asiOrFeatMode === "feat" &&
                h(
                  "div",
                  { class: featAbilityIncrease ? "atlas-tabular-nums" : undefined },
                  featAbilityIncrease
                    ? t("levelUp.summary.featWithAbility", { feat: selectedFeatLabel, ability: featAbilityIncrease.toUpperCase() })
                    : t("levelUp.summary.feat", { feat: selectedFeatLabel })
                ),
              needsFightingStyle && fightingStyleFeatId && h("div", null, t("levelUp.summary.fightingStyle", { feat: fightingStyleLabel(fightingStyleFeatId) })),
              selectedSpellIds.length > 0 && h("div", { class: "atlas-tabular-nums" }, t("levelUp.summary.spells", { count: selectedSpellIds.length })),
              manualChoiceFeatures.length > 0 &&
                h(
                  "p",
                  { class: "ds-hint", "data-testid": "levelup-manual-feature-reminder" },
                  t("levelUp.summary.manualFeatureReminder", { features: manualChoiceFeatures.join(", ") })
                )
            ),
            saveError && h("p", { role: "alert", class: "ds-field-error" }, saveError)
          )
      ),

      // Modal Footer
      h(
        "footer",
        { class: "ds-modal-footer" },
        h(
          "button",
          {
            type: "button",
            class: "ds-btn ds-btn-secondary",
            onClick: handlePrevious,
            "aria-disabled": currentStep === 1 || isSubmitting ? "true" : undefined,
          },
          t("action.previous")
        ),
        h(
          "div",
          { class: "ds-cluster" },
          h(
            "button",
            { type: "button", class: "ds-btn ds-btn-ghost", onClick: handleCancel, "aria-disabled": isSubmitting ? "true" : undefined },
            t("action.cancel")
          ),
          currentStep < 4
            ? h(
                "button",
                {
                  key: "next",
                  type: "button",
                  class: "ds-btn ds-btn-primary",
                  onClick: handleNext,
                  "aria-disabled": stepRefusing ? "true" : undefined,
                },
                t("action.next")
              )
            : h(
                "button",
                {
                  key: "confirm",
                  type: "button",
                  class: "ds-btn ds-btn-primary",
                  onClick: handleConfirmLevelUp,
                  "aria-disabled": stepRefusing ? "true" : undefined,
                  "aria-busy": isSubmitting ? "true" : undefined,
                },
                isSubmitting ? t("action.applying") : t("levelUp.confirm")
              )
        )
      )
    )
  );
}

/** Joins truthy class names. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
