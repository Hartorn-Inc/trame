import { h, type VNode } from "preact";
import { useState, useId, useRef } from "preact/hooks";
import { localizedName, t, tn, type MessageKey } from "../../i18n/index.ts";
import { useModalFocusTrap } from "../a11y/useModalFocusTrap.ts";
import {
  applyLevelUp,
  calculateProficiencyBonus,
  getCasterTypeForClass,
  getSubclassUnlockLevel,
  isAsiLevel,
  reconcileSlots,
  getSubclasses,
  getFeats,
  getSpellsByLevel,
  type AbilityId,
  type AsiOrFeatSelection,
  type CasterType,
  type Dnd5eActorData,
  type LevelUpOptions,
  type SpellSlotsState,
} from "../../../../game-systems/dnd5e/src/index.ts";

export interface DiceRollResult {
  total: number;
  rolls: number[];
  formula: string;
  signature?: string;
}

export interface DiceRollService {
  roll(formula: string, options?: { reason?: string; actorId?: string }): Promise<DiceRollResult>;
}

export interface LevelUpModalProps {
  isOpen: boolean;
  actor: Dnd5eActorData;
  onClose: () => void;
  onSave: (updatedActor: Dnd5eActorData) => void | Promise<void>;
  diceRollService?: DiceRollService;
  coreStatsLocked?: boolean;
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

const BARD_SPELLS_KNOWN: Record<number, number> = {
  1: 4, 2: 5, 3: 6, 4: 7, 5: 8, 6: 9, 7: 10, 8: 11, 9: 12, 10: 14,
  11: 15, 12: 15, 13: 16, 14: 18, 15: 19, 16: 19, 17: 20, 18: 22, 19: 22, 20: 22,
};

const SORCERER_SPELLS_KNOWN: Record<number, number> = {
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11,
  11: 12, 12: 12, 13: 13, 14: 13, 15: 14, 16: 14, 17: 15, 18: 15, 19: 15, 20: 15,
};

const WARLOCK_SPELLS_KNOWN: Record<number, number> = {
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 10,
  11: 11, 12: 11, 13: 12, 14: 12, 15: 13, 16: 13, 17: 14, 18: 14, 19: 15, 20: 15,
};

function getNewSpellsAllowance(cleanClass: string, targetLevel: number): number {
  if (targetLevel < 1 || targetLevel > 20) return 0;
  if (cleanClass === "wizard") {
    return 2;
  }
  if (cleanClass === "bard") {
    const current = BARD_SPELLS_KNOWN[targetLevel] ?? 0;
    const previous = BARD_SPELLS_KNOWN[targetLevel - 1] ?? 0;
    return Math.max(0, current - previous);
  }
  if (cleanClass === "sorcerer") {
    const current = SORCERER_SPELLS_KNOWN[targetLevel] ?? 0;
    const previous = SORCERER_SPELLS_KNOWN[targetLevel - 1] ?? 0;
    return Math.max(0, current - previous);
  }
  if (cleanClass === "warlock") {
    const current = WARLOCK_SPELLS_KNOWN[targetLevel] ?? 0;
    const previous = WARLOCK_SPELLS_KNOWN[targetLevel - 1] ?? 0;
    return Math.max(0, current - previous);
  }
  return 0;
}

function formatSlotLabel(slotKey: string): string {
  if (slotKey.toLowerCase().startsWith("level")) {
    return t("levelUp.spells.slotLevel", { level: slotKey.slice(5) });
  }
  return slotKey.toUpperCase();
}

function formatModifier(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

export function LevelUpModal(props: LevelUpModalProps): VNode<any> | null {
  return props.isOpen ? h(LevelUpDialog, props) : null;
}

function LevelUpDialog(props: LevelUpModalProps): VNode<any> {
  const { actor, onClose, onSave, diceRollService } = props;
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const trapFocus = useModalFocusTrap(dialogRef);

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

  // Step 4: Spells State
  const [selectedSpellIds, setSelectedSpellIds] = useState<string[]>([]);

  // Save error state
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const fixedHpGain = Math.max(1, Math.floor(hitDieSize / 2) + 1 + conModifier);
  const currentHpGain = hpMode === "fixed" ? fixedHpGain : rolledValue !== null ? Math.max(1, rolledValue + conModifier) : 0;

  // Compendium Options
  const availableSubclasses = needsSubclass ? getSubclasses(classId) : [];
  const availableFeats = isAsi ? getFeats() : [];
  const maxSpellCircle = casterType === "pact" ? Math.min(5, Math.ceil(targetLevel / 2)) : casterType === "half" ? Math.ceil(targetLevel / 4) : Math.ceil(targetLevel / 2);
  const availableSpellsForLevel = isSpellcaster && !isDivineCaster
    ? Array.from({ length: Math.min(9, Math.max(1, maxSpellCircle)) }, (_, i) => i + 1)
        .flatMap((lvl) => getSpellsByLevel(lvl, classId))
        .filter((sp) => !(actor.spellIds || []).includes(sp.id))
    : [];

  // Step Validations
  const isStep1Valid = !needsSubclass || Boolean(subclassId.trim());
  const isStep2Valid = hpMode === "fixed" || (hpMode === "rolled" && rolledValue !== null && rolledValue >= 1 && rolledValue <= hitDieSize);
  
  let isStep3Valid = true;
  let asiErrorMessage: string | null = null;
  if (isAsi) {
    if (asiOrFeatMode === "feat") {
      isStep3Valid = Boolean(selectedFeatId.trim());
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
    return isStep4Valid;
  };

  // Handle Server Dice Roll
  const handleRollDice = async () => {
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
    if (!canProceed() || isSubmitting) return;
    try {
      setIsSubmitting(true);
      setSaveError(null);

      let compiledAsiOrFeat: AsiOrFeatSelection | undefined = undefined;
      if (isAsi) {
        if (asiOrFeatMode === "feat") {
          compiledAsiOrFeat = {
            mode: "feat",
            featId: selectedFeatId,
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
      };

      const updatedActor = applyLevelUp(actor, options);
      await onSave(updatedActor);
      onClose();
    } catch (err: any) {
      setSaveError(err.message || t("levelUp.saveFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Keyboard handlers: Escape closes modal, Tab is trapped inside
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    trapFocus(e);
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

  return h(
    "div",
    {
      ref: dialogRef,
      "data-testid": "level-up-modal",
      class: "ds-levelup-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      "aria-describedby": descId,
      tabIndex: -1,
      onKeyDown: handleKeyDown,
    },
    h(
      "div",
      {
        class: "ds-levelup-modal w-full max-w-2xl bg-[var(--atlas-surface)] border border-[var(--atlas-border)] rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-[var(--atlas-text)]",
      },
      // Modal Header
      h(
        "header",
        { class: "px-6 py-4 border-b border-[var(--atlas-border)] flex items-center justify-between bg-[var(--atlas-surface-raised)]" },
        h(
          "div",
          null,
          h(
            "h2",
            { id: titleId, class: "text-xl font-bold tracking-tight text-[var(--atlas-action)]" },
            t("levelUp.title", { from: currentLevel, to: targetLevel })
          ),
          h(
            "p",
            { id: descId, class: "text-xs text-[var(--atlas-text-muted)] mt-0.5" },
            t("levelUp.subtitle", { className: classId || t("levelUp.unknownClass"), bonus: calculateProficiencyBonus(targetLevel) })
          )
        ),
        h(
          "button",
          {
            type: "button",
            class: "inline-flex items-center justify-center min-w-[40px] min-h-[40px] p-2 text-[var(--atlas-text-muted)] hover:text-[var(--atlas-text)] text-lg rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
            onClick: onClose,
            "aria-label": t("levelUp.close"),
          },
          "✕"
        )
      ),

      // Stepper Bar
      h(
        "nav",
        {
          "aria-label": t("levelUp.steps.label"),
          class: "grid grid-cols-4 border-b border-[var(--atlas-border)] bg-[var(--atlas-surface)] text-xs font-semibold text-center",
        },
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
              class: `py-2.5 px-1 border-b-2 transition-colors ${
                isCurrent
                  ? "border-[var(--atlas-action)] text-[var(--atlas-action)] bg-[var(--atlas-surface-raised)]"
                  : isCompleted
                  ? "border-[var(--atlas-border)] text-[var(--atlas-text)]"
                  : "border-transparent text-[var(--atlas-text-muted)]"
              }`,
            },
            isCompleted ? `✓ ${item.label}` : item.label
          );
        })
      ),

      // Modal Body
      h(
        "div",
        { class: "p-6 overflow-y-auto flex-1 space-y-6 text-sm" },
        // Step 1: Subclass / Archetype
        currentStep === 1 &&
          h(
            "div",
            { class: "space-y-4" },
            h("h3", { class: "text-base font-semibold text-[var(--atlas-text)]" }, t("levelUp.step1.heading")),
            h(
              "div",
              { class: "bg-[var(--atlas-surface-raised)] p-4 rounded-lg border border-[var(--atlas-border)] flex items-center justify-between" },
              h(
                "div",
                null,
                h("span", { class: "text-[var(--atlas-text-muted)] block text-xs uppercase" }, t("levelUp.activeClass")),
                h("strong", { class: "text-base text-[var(--atlas-text)]" }, classId || t("levelUp.unknown"))
              ),
              h(
                "div",
                { class: "text-right" },
                h("span", { class: "text-[var(--atlas-text-muted)] block text-xs uppercase" }, t("levelUp.targetLevel")),
                h("span", { class: "text-lg font-bold text-[var(--atlas-action)]" }, targetLevel)
              )
            ),
            needsSubclass
              ? h(
                  "div",
                  { class: "space-y-2" },
                  h(
                    "label",
                    { for: "subclass-select", class: "block font-medium text-[var(--atlas-text)] text-sm" },
                    t("levelUp.subclass.label")
                  ),
                  h(
                    "select",
                    {
                      id: "subclass-select",
                      class: "w-full min-h-[40px] bg-[var(--atlas-surface-raised)] border border-[var(--atlas-border)] rounded-md p-2.5 text-[var(--atlas-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                      value: subclassId,
                      onChange: (e: any) => setSubclassId(e.target.value),
                    },
                    h("option", { value: "" }, t("levelUp.subclass.placeholder")),
                    availableSubclasses.map((sc) =>
                      h("option", { key: sc.id, value: sc.id }, localizedName(sc))
                    )
                  ),
                  !subclassId &&
                    h(
                      "p",
                      { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" },
                      t("levelUp.subclass.required")
                    )
                )
              : h(
                  "div",
                  { class: "p-4 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-[var(--atlas-text-muted)] text-xs" },
                  subclassId
                    ? t("levelUp.subclass.current", { subclass: subclassId })
                    : t("levelUp.subclass.notNeeded")
                )
          ),

        // Step 2: Hit Points Gain
        currentStep === 2 &&
          h(
            "div",
            { class: "space-y-4" },
            h("h3", { class: "text-base font-semibold text-[var(--atlas-text)]" }, t("levelUp.step2.heading")),
            h(
              "p",
              { class: "text-xs text-[var(--atlas-text-muted)]" },
              t("levelUp.hp.dieInfo", { die: hitDieSize, mod: formatModifier(conModifier) })
            ),
            h(
              "div",
              { class: "grid grid-cols-2 gap-4" },
              h(
                "label",
                {
                  class: `cursor-pointer p-4 rounded-lg border flex flex-col justify-between ${
                    hpMode === "fixed"
                      ? "border-[var(--atlas-action)] bg-[var(--atlas-surface-raised)] text-[var(--atlas-text)]"
                      : "border-[var(--atlas-border)] bg-[var(--atlas-surface-raised)] text-[var(--atlas-text-muted)] hover:border-[var(--atlas-border)]"
                  }`,
                },
                h(
                  "div",
                  { class: "flex items-center space-x-2" },
                  h("input", {
                    type: "radio",
                    name: "hpMode",
                    value: "fixed",
                    checked: hpMode === "fixed",
                    onChange: () => setHpMode("fixed"),
                    class: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                  }),
                  h("span", { class: "font-semibold" }, t("levelUp.hp.fixed"))
                ),
                h(
                  "div",
                  { class: "mt-2 text-xs text-[var(--atlas-text-muted)]" },
                  `floor(${hitDieSize}/2) + 1 + (${conModifier}) = `,
                  h("strong", { class: "text-base text-[var(--atlas-action)]" }, t("hp.gain", { value: fixedHpGain }))
                )
              ),
              h(
                "label",
                {
                  class: `cursor-pointer p-4 rounded-lg border flex flex-col justify-between ${
                    hpMode === "rolled"
                      ? "border-[var(--atlas-action)] bg-[var(--atlas-surface-raised)] text-[var(--atlas-text)]"
                      : "border-[var(--atlas-border)] bg-[var(--atlas-surface-raised)] text-[var(--atlas-text-muted)] hover:border-[var(--atlas-border)]"
                  }`,
                },
                h(
                  "div",
                  { class: "flex items-center space-x-2" },
                  h("input", {
                    type: "radio",
                    name: "hpMode",
                    value: "rolled",
                    checked: hpMode === "rolled",
                    onChange: () => setHpMode("rolled"),
                    class: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                  }),
                  h("span", { class: "font-semibold" }, t("levelUp.hp.rolled"))
                ),
                h(
                  "div",
                  { class: "mt-2 text-xs text-[var(--atlas-text-muted)]" },
                  t("levelUp.hp.rolledHint", { die: hitDieSize, mod: formatModifier(conModifier) })
                )
              )
            ),
            hpMode === "rolled" &&
              h(
                "div",
                { class: "p-4 rounded-lg bg-[var(--atlas-surface-raised)] border border-[var(--atlas-border)] space-y-3" },
                h(
                  "div",
                  { class: "flex items-center justify-between" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "min-h-[40px] px-4 py-2 bg-[var(--atlas-action)] hover:opacity-90 disabled:opacity-50 text-[var(--atlas-on-action)] rounded font-medium text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                      onClick: handleRollDice,
                      disabled: rollLoading,
                    },
                    rollLoading ? t("dice.rolling") : t("levelUp.hp.rollButton", { die: hitDieSize })
                  ),
                  rolledValue !== null &&
                    h(
                      "div",
                      { class: "text-right" },
                      h("span", { class: "text-xs text-[var(--atlas-text-muted)] block" }, t("levelUp.hp.dieResult", { value: rolledValue })),
                      h(
                        "span",
                        { class: "text-lg font-bold text-[var(--atlas-action)]" },
                        t("hp.gain", { value: Math.max(1, rolledValue + conModifier) })
                      )
                    )
                ),
                rollError && h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, rollError),
                rolledValue === null &&
                  !rollError &&
                  h(
                    "p",
                    { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" },
                    t("levelUp.hp.rollRequired")
                  )
              ),
            h(
              "div",
              { class: "text-xs text-[var(--atlas-text-muted)] bg-[var(--atlas-surface-raised)] p-2.5 rounded border border-[var(--atlas-border)]" },
              t("levelUp.hp.projected", { current: actor.attributes.hp.max }),
              h("strong", { class: "text-[var(--atlas-text)]" }, actor.attributes.hp.max + currentHpGain)
            )
          ),

        // Step 3: ASI or Feat
        currentStep === 3 &&
          (isAsi
            ? h(
                "div",
                { class: "space-y-4" },
                h("h3", { class: "text-base font-semibold text-[var(--atlas-text)]" }, t("levelUp.step3.heading")),
                h(
                  "div",
                  {
                    role: "tablist",
                    "aria-label": t("levelUp.asi.modeLabel"),
                    class: "flex space-x-4 border-b border-[var(--atlas-border)] pb-2 text-sm",
                  },
                  h(
                    "button",
                    {
                      type: "button",
                      role: "tab",
                      id: "tab-asi",
                      "aria-selected": asiOrFeatMode === "asi" ? "true" : "false",
                      "aria-controls": "tabpanel-asi-or-feat",
                      class: `min-h-[40px] px-3 py-2 font-medium border-b-2 rounded-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center gap-1.5 ${
                        asiOrFeatMode === "asi" ? "border-[var(--atlas-action)] text-[var(--atlas-action)]" : "border-transparent text-[var(--atlas-text-muted)]"
                      }`,
                      onClick: () => setAsiOrFeatMode("asi"),
                    },
                    h("span", { "aria-hidden": "true" }, asiOrFeatMode === "asi" ? "●" : "○"),
                    t("levelUp.asi.tab")
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      role: "tab",
                      id: "tab-feat",
                      "aria-selected": asiOrFeatMode === "feat" ? "true" : "false",
                      "aria-controls": "tabpanel-asi-or-feat",
                      class: `min-h-[40px] px-3 py-2 font-medium border-b-2 rounded-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center gap-1.5 ${
                        asiOrFeatMode === "feat" ? "border-[var(--atlas-action)] text-[var(--atlas-action)]" : "border-transparent text-[var(--atlas-text-muted)]"
                      }`,
                      onClick: () => setAsiOrFeatMode("feat"),
                    },
                    h("span", { "aria-hidden": "true" }, asiOrFeatMode === "feat" ? "●" : "○"),
                    t("levelUp.feat.tab")
                  )
                ),
                h(
                  "div",
                  {
                    id: "tabpanel-asi-or-feat",
                    role: "tabpanel",
                    "aria-labelledby": asiOrFeatMode === "asi" ? "tab-asi" : "tab-feat",
                  },
                  asiOrFeatMode === "asi"
                    ? h(
                        "div",
                        { class: "space-y-4 pt-2" },
                        h(
                          "div",
                          { class: "flex space-x-4 text-xs" },
                          h(
                            "label",
                            { class: "flex items-center space-x-1.5 cursor-pointer min-h-[40px] px-3 py-2 rounded border border-[var(--atlas-border)] bg-[var(--atlas-surface-raised)]" },
                            h("input", {
                              type: "radio",
                              name: "asiSubMode",
                              value: "plusTwo",
                              checked: asiSubMode === "plusTwo",
                              onChange: () => setAsiSubMode("plusTwo"),
                              class: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                            }),
                            h("span", null, t("levelUp.asi.plusTwo"))
                          ),
                          h(
                            "label",
                            { class: "flex items-center space-x-1.5 cursor-pointer min-h-[40px] px-3 py-2 rounded border border-[var(--atlas-border)] bg-[var(--atlas-surface-raised)]" },
                            h("input", {
                              type: "radio",
                              name: "asiSubMode",
                              value: "plusOneOne",
                              checked: asiSubMode === "plusOneOne",
                              onChange: () => setAsiSubMode("plusOneOne"),
                              class: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                            }),
                            h("span", null, t("levelUp.asi.plusOneOne"))
                          )
                        ),
                        asiSubMode === "plusTwo"
                          ? h(
                              "div",
                              { class: "space-y-1" },
                              h("label", { for: "asi-single-ability", class: "block text-xs text-[var(--atlas-text-muted)]" }, t("levelUp.asi.singleLabel")),
                              h(
                                "select",
                                {
                                  id: "asi-single-ability",
                                  "aria-label": t("levelUp.asi.singleAria"),
                                  class: "w-full min-h-[40px] bg-[var(--atlas-surface-raised)] border border-[var(--atlas-border)] rounded p-2 text-[var(--atlas-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                                  value: asiSingleAbility,
                                  onChange: (e: any) => setAsiSingleAbility(e.target.value as AbilityId),
                                },
                                ABILITY_KEYS.map((k) =>
                                  h(
                                    "option",
                                    { key: k, value: k },
                                    t("levelUp.asi.option", { ability: t(ABILITY_LABEL_KEYS[k]), score: actor.abilities[k].score })
                                  )
                                )
                              )
                            )
                          : h(
                              "div",
                              { class: "grid grid-cols-2 gap-4" },
                              h(
                                "div",
                                { class: "space-y-1" },
                                h("label", { for: "asi-first-ability", class: "block text-xs text-[var(--atlas-text-muted)]" }, t("levelUp.asi.firstLabel")),
                                h(
                                  "select",
                                  {
                                    id: "asi-first-ability",
                                    "aria-label": t("levelUp.asi.firstAria"),
                                    class: "w-full min-h-[40px] bg-[var(--atlas-surface-raised)] border border-[var(--atlas-border)] rounded p-2 text-[var(--atlas-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                                    value: asiFirstAbility,
                                    onChange: (e: any) => setAsiFirstAbility(e.target.value as AbilityId),
                                  },
                                  ABILITY_KEYS.map((k) =>
                                    h(
                                      "option",
                                      { key: k, value: k },
                                      t("levelUp.asi.option", { ability: t(ABILITY_LABEL_KEYS[k]), score: actor.abilities[k].score })
                                    )
                                  )
                                )
                              ),
                              h(
                                "div",
                                { class: "space-y-1" },
                                h("label", { for: "asi-second-ability", class: "block text-xs text-[var(--atlas-text-muted)]" }, t("levelUp.asi.secondLabel")),
                                h(
                                  "select",
                                  {
                                    id: "asi-second-ability",
                                    "aria-label": t("levelUp.asi.secondAria"),
                                    class: "w-full min-h-[40px] bg-[var(--atlas-surface-raised)] border border-[var(--atlas-border)] rounded p-2 text-[var(--atlas-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                                    value: asiSecondAbility,
                                    onChange: (e: any) => setAsiSecondAbility(e.target.value as AbilityId),
                                  },
                                  ABILITY_KEYS.map((k) =>
                                    h(
                                      "option",
                                      { key: k, value: k },
                                      t("levelUp.asi.option", { ability: t(ABILITY_LABEL_KEYS[k]), score: actor.abilities[k].score })
                                    )
                                  )
                                )
                              )
                            ),
                        asiErrorMessage &&
                          h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, asiErrorMessage)
                      )
                    : h(
                        "div",
                        { class: "space-y-2 pt-2" },
                        h("label", { for: "asi-feat-select", class: "block text-xs text-[var(--atlas-text-muted)]" }, t("levelUp.feat.label")),
                        h(
                          "select",
                          {
                            id: "asi-feat-select",
                            "aria-label": t("levelUp.feat.aria"),
                            class: "w-full min-h-[40px] bg-[var(--atlas-surface-raised)] border border-[var(--atlas-border)] rounded p-2 text-[var(--atlas-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                            value: selectedFeatId,
                            onChange: (e: any) => setSelectedFeatId(e.target.value),
                          },
                          h("option", { value: "" }, t("levelUp.feat.placeholder")),
                          availableFeats.map((feat) =>
                            h("option", { key: feat.id, value: feat.id }, localizedName(feat))
                          )
                        ),
                        !selectedFeatId &&
                          h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, t("levelUp.feat.required"))
                      )
                )
              )
            : h(
                "div",
                { class: "p-4 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-[var(--atlas-text-muted)] text-xs space-y-2" },
                h("p", null, t("levelUp.noAsi.level", { level: targetLevel })),
                h("p", null, t("levelUp.noAsi.features"))
              )),

        // Step 4: Spells & Summary
        currentStep === 4 &&
          h(
            "div",
            { class: "space-y-4" },
            h("h3", { class: "text-base font-semibold text-[var(--atlas-text)]" }, isSpellcaster ? t("levelUp.step4.spellsHeading") : t("levelUp.step4.summaryHeading")),
            isSpellcaster &&
              h(
                "div",
                { class: "space-y-3" },
                h("h4", { class: "text-xs font-semibold text-[var(--atlas-text-muted)] uppercase tracking-wider" }, t("levelUp.spells.newSlots")),
                h(
                  "div",
                  { class: "grid grid-cols-5 gap-2 text-xs" },
                  Object.entries(projectedSlots).map(([slotKey, slotData]) =>
                    h(
                      "div",
                      { key: slotKey, class: "p-2 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-center" },
                      h("span", { class: "text-[var(--atlas-text-muted)] block" }, formatSlotLabel(slotKey)),
                      h("strong", { class: "text-[var(--atlas-action)] text-sm" }, tn("levelUp.spells.slots", (slotData as any).max))
                    )
                  )
                ),
                isDivineCaster &&
                  h(
                    "div",
                    { class: "p-4 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-[var(--atlas-text)] text-xs space-y-1.5" },
                    h("div", { class: "font-semibold text-[var(--atlas-action)]" }, t("levelUp.spells.divineTitle")),
                    h(
                      "p",
                      null,
                      t("levelUp.spells.divineBody")
                    )
                  ),
                !isDivineCaster && isKnownCaster && knownAllowance === 0 &&
                  h(
                    "div",
                    { class: "p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-[var(--atlas-text-muted)] text-xs" },
                    t("levelUp.spells.noneGranted", { level: targetLevel })
                  ),
                !isDivineCaster && availableSpellsForLevel.length > 0 && (!isKnownCaster || knownAllowance > 0) &&
                  h(
                    "div",
                    { class: "space-y-2 pt-2" },
                    h(
                      "h4",
                      { class: "text-xs font-semibold text-[var(--atlas-text-muted)] uppercase tracking-wider" },
                      isWizard
                        ? t("levelUp.spells.wizardHeading", { selected: selectedSpellIds.length, required: requiredWizardCount })
                        : isKnownCaster
                        ? t("levelUp.spells.knownHeading", { selected: selectedSpellIds.length, limit: knownAllowance })
                        : t("levelUp.spells.optionalHeading", { selected: selectedSpellIds.length })
                    ),
                    h(
                      "div",
                      { class: "max-h-48 overflow-y-auto border border-[var(--atlas-border)] rounded p-2 space-y-1 bg-[var(--atlas-surface-raised)] text-xs" },
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
                          {
                            key: spell.id,
                            class: `flex items-center justify-between min-h-[40px] px-3 py-2 rounded ${
                              isDisabled ? "opacity-50 cursor-not-allowed text-[var(--atlas-text-muted)]" : "cursor-pointer"
                            } ${
                              isChecked ? "bg-[var(--atlas-surface)] text-[var(--atlas-text)] border border-[var(--atlas-border)] font-medium" : "hover:bg-[var(--atlas-surface)] text-[var(--atlas-text)]"
                            }`,
                          },
                          h(
                            "div",
                            { class: "flex items-center space-x-2" },
                            h("input", {
                              type: "checkbox",
                              checked: isChecked,
                              disabled: isDisabled,
                              onChange: () => toggleSpellSelection(spell.id),
                              class: "rounded text-[var(--atlas-action)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
                            }),
                            h("span", null, localizedName(spell))
                          ),
                          h("span", { class: "text-[var(--atlas-text-muted)] text-[10px]" }, t("levelUp.spells.level", { level: String(spell.data.level) }))
                        );
                      })
                    ),
                    spellErrorMessage &&
                      h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, spellErrorMessage)
                  )
              ),
            h(
              "div",
              { class: "p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] space-y-1 text-xs text-[var(--atlas-text)]" },
              h("div", { class: "font-semibold text-[var(--atlas-action)] mb-1" }, t("levelUp.summary.title")),
              h("div", null, t("levelUp.summary.level", { from: currentLevel, to: targetLevel })),
              h("div", null, t("levelUp.summary.hp", { from: actor.attributes.hp.max, to: actor.attributes.hp.max + currentHpGain, gain: currentHpGain })),
              subclassId && needsSubclass && h("div", null, t("levelUp.summary.subclass", { subclass: subclassId })),
              isAsi && asiOrFeatMode === "asi" && asiSubMode === "plusTwo" && h("div", null, t("levelUp.summary.asiTwo", { ability: asiSingleAbility.toUpperCase() })),
              isAsi && asiOrFeatMode === "asi" && asiSubMode === "plusOneOne" && h("div", null, t("levelUp.summary.asiOneOne", { first: asiFirstAbility.toUpperCase(), second: asiSecondAbility.toUpperCase() })),
              isAsi && asiOrFeatMode === "feat" && h("div", null, t("levelUp.summary.feat", { feat: selectedFeatId })),
              selectedSpellIds.length > 0 && h("div", null, t("levelUp.summary.spells", { count: selectedSpellIds.length }))
            ),
            saveError && h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, saveError)
          )
      ),

      // Modal Footer
      h(
        "footer",
        { class: "px-6 py-4 border-t border-[var(--atlas-border)] flex items-center justify-between bg-[var(--atlas-surface-raised)]" },
        h(
          "button",
          {
            type: "button",
            class: "min-h-[40px] px-4 py-2 border border-[var(--atlas-border)] hover:bg-[var(--atlas-surface)] text-[var(--atlas-text)] rounded text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] disabled:opacity-30 inline-flex items-center justify-center",
            onClick: () => setCurrentStep((s) => Math.max(1, s - 1)),
            disabled: currentStep === 1 || isSubmitting,
          },
          t("action.previous")
        ),
        h(
          "div",
          { class: "space-x-3" },
          h(
            "button",
            {
              type: "button",
              class: "min-h-[40px] px-4 py-2 text-[var(--atlas-text-muted)] hover:text-[var(--atlas-text)] text-xs font-semibold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] disabled:opacity-30 inline-flex items-center justify-center",
              onClick: onClose,
              disabled: isSubmitting,
            },
            t("action.cancel")
          ),
          currentStep < 4
            ? h(
                "button",
                {
                  type: "button",
                  class: "min-h-[40px] px-4 py-2 bg-[var(--atlas-action)] hover:opacity-90 disabled:opacity-40 text-[var(--atlas-on-action)] rounded text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                  onClick: () => setCurrentStep((s) => Math.min(4, s + 1)),
                  disabled: !canProceed() || isSubmitting,
                },
                t("action.next")
              )
            : h(
                "button",
                {
                  type: "button",
                  class: "min-h-[40px] px-5 py-2 bg-[var(--atlas-action)] hover:opacity-90 disabled:opacity-40 text-[var(--atlas-on-action)] rounded text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                  onClick: handleConfirmLevelUp,
                  disabled: !canProceed() || isSubmitting,
                },
                isSubmitting ? t("action.applying") : t("levelUp.confirm")
              )
        )
      )
    )
  );
}
