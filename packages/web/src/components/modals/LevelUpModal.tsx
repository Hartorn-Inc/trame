import { h, type VNode } from "preact";
import { useState, useId } from "preact/hooks";
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

const ABILITY_LABELS: Record<AbilityId, string> = {
  str: "Force (STR)",
  dex: "Dextérité (DEX)",
  con: "Constitution (CON)",
  int: "Intelligence (INT)",
  wis: "Sagesse (WIS)",
  cha: "Charisme (CHA)",
};

const ABILITY_KEYS: AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

export function LevelUpModal(props: LevelUpModalProps): VNode<any> | null {
  if (!props.isOpen) return null;

  const { actor, onClose, onSave, diceRollService } = props;
  const titleId = useId();
  const descId = useId();

  const currentLevel = actor.attributes.level;
  const targetLevel = currentLevel + 1;
  const classId = (actor.classId ?? actor.class ?? actor.attributes.classId ?? actor.attributes.class ?? "").toString();
  const hitDieSize = actor.attributes.hitDieSize || 8;
  const conModifier = Math.floor((actor.abilities.con.score - 10) / 2);
  const subclassUnlockTier = getSubclassUnlockLevel(classId);
  const needsSubclass = targetLevel >= subclassUnlockTier && !(actor.subclassId || actor.attributes.subclassId);
  const isAsi = isAsiLevel(targetLevel, classId);
  const casterType: CasterType = actor.attributes.casterType || getCasterTypeForClass(classId);
  const isSpellcaster = casterType !== "none";

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
  const availableSpellsForLevel = isSpellcaster
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
          asiErrorMessage = `La caractéristique ${asiSingleAbility.toUpperCase()} dépasse le maximum de 20 (+2 donne ${currentScore + 2}).`;
        }
      } else {
        if (asiFirstAbility === asiSecondAbility) {
          isStep3Valid = false;
          asiErrorMessage = "Veuillez choisir deux caractéristiques distinctes pour le bonus +1/+1.";
        } else {
          const firstScore = actor.abilities[asiFirstAbility]?.score ?? 10;
          const secondScore = actor.abilities[asiSecondAbility]?.score ?? 10;
          if (firstScore + 1 > 20) {
            isStep3Valid = false;
            asiErrorMessage = `La caractéristique ${asiFirstAbility.toUpperCase()} dépasse le maximum de 20 (+1 donne ${firstScore + 1}).`;
          } else if (secondScore + 1 > 20) {
            isStep3Valid = false;
            asiErrorMessage = `La caractéristique ${asiSecondAbility.toUpperCase()} dépasse le maximum de 20 (+1 donne ${secondScore + 1}).`;
          }
        }
      }
    }
  }

  const isStep4Valid = true; // Spell selection is optional or bounded

  const canProceed = () => {
    if (currentStep === 1) return isStep1Valid;
    if (currentStep === 2) return isStep2Valid;
    if (currentStep === 3) return isStep3Valid;
    return isStep4Valid;
  };

  // Handle Server Dice Roll
  const handleRollDice = async () => {
    if (!diceRollService) {
      setRollError("Service de dés serveur indisponible");
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
      setRollError(err.message || "Erreur lors du tirage de dés");
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
      setSaveError(err.message || "Erreur lors de l'application de la montée de niveau");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Escape key closes modal
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  const toggleSpellSelection = (spellId: string) => {
    setSelectedSpellIds((prev) =>
      prev.includes(spellId) ? prev.filter((id) => id !== spellId) : [...prev, spellId]
    );
  };

  const projectedSlots: SpellSlotsState = isSpellcaster
    ? reconcileSlots(actor.spellSlots, casterType, targetLevel)
    : {};

  return h(
    "div",
    {
      class: "ds-levelup-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      "aria-describedby": descId,
      onKeyDown: handleKeyDown,
    },
    h(
      "div",
      {
        class: "ds-levelup-modal w-full max-w-2xl bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-zinc-100",
      },
      // Modal Header
      h(
        "header",
        { class: "px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/40" },
        h(
          "div",
          null,
          h(
            "h2",
            { id: titleId, class: "text-xl font-bold tracking-tight text-amber-400" },
            `Montée de niveau : Niveau ${currentLevel} → ${targetLevel}`
          ),
          h(
            "p",
            { id: descId, class: "text-xs text-zinc-400 mt-0.5" },
            `Classe : ${classId || "Aventurier"} | Bonus de Maîtrise projeté : +${calculateProficiencyBonus(targetLevel)}`
          )
        ),
        h(
          "button",
          {
            type: "button",
            class: "text-zinc-400 hover:text-zinc-100 text-lg px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-amber-500",
            onClick: onClose,
            "aria-label": "Fermer la fenêtre de montée de niveau",
          },
          "✕"
        )
      ),

      // Stepper Bar
      h(
        "nav",
        {
          "aria-label": "Étapes de progression",
          class: "grid grid-cols-4 border-b border-zinc-800 bg-zinc-900/90 text-xs font-semibold text-center",
        },
        [
          { step: 1, label: "1. Archétype" },
          { step: 2, label: "2. Points de Vie" },
          { step: 3, label: isAsi ? "3. Carac. / Don" : "3. Aptitudes" },
          { step: 4, label: isSpellcaster ? "4. Sorts" : "4. Récapitulatif" },
        ].map((item) =>
          h(
            "div",
            {
              key: item.step,
              class: `py-2.5 px-1 border-b-2 transition-colors ${
                currentStep === item.step
                  ? "border-amber-500 text-amber-400 bg-amber-500/10"
                  : currentStep > item.step
                  ? "border-zinc-500 text-zinc-300"
                  : "border-transparent text-zinc-500"
              }`,
            },
            item.label
          )
        )
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
            h("h3", { class: "text-base font-semibold text-zinc-200" }, "Étape 1 : Confirmation de classe & Choix d'archétype"),
            h(
              "div",
              { class: "bg-zinc-800/60 p-4 rounded-lg border border-zinc-700/60 flex items-center justify-between" },
              h(
                "div",
                null,
                h("span", { class: "text-zinc-400 block text-xs uppercase" }, "Classe active"),
                h("strong", { class: "text-base text-zinc-100" }, classId || "Inconnue")
              ),
              h(
                "div",
                { class: "text-right" },
                h("span", { class: "text-zinc-400 block text-xs uppercase" }, "Niveau cible"),
                h("span", { class: "text-lg font-bold text-amber-400" }, targetLevel)
              )
            ),
            needsSubclass
              ? h(
                  "div",
                  { class: "space-y-2" },
                  h(
                    "label",
                    { for: "subclass-select", class: "block font-medium text-amber-300 text-sm" },
                    "Sélectionnez votre archétype / sous-classe (Requis) :"
                  ),
                  h(
                    "select",
                    {
                      id: "subclass-select",
                      class: "w-full bg-zinc-800 border border-zinc-700 rounded-md p-2.5 text-zinc-100 focus:ring-2 focus:ring-amber-500",
                      value: subclassId,
                      onChange: (e: any) => setSubclassId(e.target.value),
                    },
                    h("option", { value: "" }, "-- Choisir un archétype --"),
                    availableSubclasses.map((sc) =>
                      h("option", { key: sc.id, value: sc.id }, sc.i18n?.fr?.name || sc.name)
                    )
                  ),
                  !subclassId &&
                    h(
                      "p",
                      { class: "text-xs text-rose-400 font-medium" },
                      "Le choix d'un archétype est obligatoire pour ce niveau."
                    )
                )
              : h(
                  "div",
                  { class: "p-4 bg-zinc-800/30 rounded border border-zinc-800 text-zinc-400 text-xs" },
                  subclassId
                    ? `Archétype actuel déjà enregistré : ${subclassId}`
                    : "Aucune sélection d'archétype requise pour ce niveau de classe."
                )
          ),

        // Step 2: Hit Points Gain
        currentStep === 2 &&
          h(
            "div",
            { class: "space-y-4" },
            h("h3", { class: "text-base font-semibold text-zinc-200" }, "Étape 2 : Augmentation des Points de Vie"),
            h(
              "p",
              { class: "text-xs text-zinc-400" },
              `Dé de vie de classe : 1d${hitDieSize} | Modificateur de Constitution : ${conModifier >= 0 ? `+${conModifier}` : conModifier}`
            ),
            h(
              "div",
              { class: "grid grid-cols-2 gap-4" },
              h(
                "label",
                {
                  class: `cursor-pointer p-4 rounded-lg border flex flex-col justify-between ${
                    hpMode === "fixed"
                      ? "border-amber-500 bg-amber-500/10 text-amber-200"
                      : "border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:border-zinc-600"
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
                    class: "text-amber-500 focus:ring-amber-500",
                  }),
                  h("span", { class: "font-semibold" }, "Moyenne fixe")
                ),
                h(
                  "div",
                  { class: "mt-2 text-xs text-zinc-400" },
                  `floor(${hitDieSize}/2) + 1 + (${conModifier}) = `,
                  h("strong", { class: "text-base text-amber-400" }, `+${fixedHpGain} PV`)
                )
              ),
              h(
                "label",
                {
                  class: `cursor-pointer p-4 rounded-lg border flex flex-col justify-between ${
                    hpMode === "rolled"
                      ? "border-amber-500 bg-amber-500/10 text-amber-200"
                      : "border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:border-zinc-600"
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
                    class: "text-amber-500 focus:ring-amber-500",
                  }),
                  h("span", { class: "font-semibold" }, "Tirer le dé de vie")
                ),
                h(
                  "div",
                  { class: "mt-2 text-xs text-zinc-400" },
                  `Lancé serveur faisant foi (1d${hitDieSize} + ${conModifier})`
                )
              )
            ),
            hpMode === "rolled" &&
              h(
                "div",
                { class: "p-4 rounded-lg bg-zinc-800/70 border border-zinc-700 space-y-3" },
                h(
                  "div",
                  { class: "flex items-center justify-between" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium text-xs focus:ring-2 focus:ring-amber-400",
                      onClick: handleRollDice,
                      disabled: rollLoading,
                    },
                    rollLoading ? "Tirage en cours..." : `Lancer 1d${hitDieSize} sur le serveur`
                  ),
                  rolledValue !== null &&
                    h(
                      "div",
                      { class: "text-right" },
                      h("span", { class: "text-xs text-zinc-400 block" }, `Résultat du dé : ${rolledValue}`),
                      h(
                        "span",
                        { class: "text-lg font-bold text-amber-400" },
                        `+${Math.max(1, rolledValue + conModifier)} PV`
                      )
                    )
                ),
                rollError && h("p", { class: "text-xs text-rose-400" }, rollError),
                rolledValue === null &&
                  !rollError &&
                  h(
                    "p",
                    { class: "text-xs text-amber-300/80 font-medium" },
                    "Un tirage validé par le serveur est obligatoire pour continuer en mode dé de vie."
                  )
              ),
            h(
              "div",
              { class: "text-xs text-zinc-400 bg-zinc-800/20 p-2.5 rounded border border-zinc-800/60" },
              `PV Max actuels : ${actor.attributes.hp.max} → Projetés : `,
              h("strong", { class: "text-zinc-100" }, actor.attributes.hp.max + currentHpGain)
            )
          ),

        // Step 3: ASI or Feat
        currentStep === 3 &&
          (isAsi
            ? h(
                "div",
                { class: "space-y-4" },
                h("h3", { class: "text-base font-semibold text-zinc-200" }, "Étape 3 : Amélioration de Caractéristiques ou Don"),
                h(
                  "div",
                  { class: "flex space-x-4 border-b border-zinc-800 pb-2 text-sm" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: `pb-1 font-medium border-b-2 ${
                        asiOrFeatMode === "asi" ? "border-amber-500 text-amber-400" : "border-transparent text-zinc-400"
                      }`,
                      onClick: () => setAsiOrFeatMode("asi"),
                    },
                    "Amélioration de Caractéristiques (ASI)"
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      class: `pb-1 font-medium border-b-2 ${
                        asiOrFeatMode === "feat" ? "border-amber-500 text-amber-400" : "border-transparent text-zinc-400"
                      }`,
                      onClick: () => setAsiOrFeatMode("feat"),
                    },
                    "Choisir un Don"
                  )
                ),
                asiOrFeatMode === "asi"
                  ? h(
                      "div",
                      { class: "space-y-4 pt-2" },
                      h(
                        "div",
                        { class: "flex space-x-4 text-xs" },
                        h(
                          "label",
                          { class: "flex items-center space-x-1.5 cursor-pointer" },
                          h("input", {
                            type: "radio",
                            name: "asiSubMode",
                            value: "plusTwo",
                            checked: asiSubMode === "plusTwo",
                            onChange: () => setAsiSubMode("plusTwo"),
                          }),
                          h("span", null, "+2 à une caractéristique")
                        ),
                        h(
                          "label",
                          { class: "flex items-center space-x-1.5 cursor-pointer" },
                          h("input", {
                            type: "radio",
                            name: "asiSubMode",
                            value: "plusOneOne",
                            checked: asiSubMode === "plusOneOne",
                            onChange: () => setAsiSubMode("plusOneOne"),
                          }),
                          h("span", null, "+1 à deux caractéristiques")
                        )
                      ),
                      asiSubMode === "plusTwo"
                        ? h(
                            "div",
                            { class: "space-y-1" },
                            h("label", { class: "block text-xs text-zinc-400" }, "Caractéristique (+2, max 20) :"),
                            h(
                              "select",
                              {
                                class: "w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-zinc-100",
                                value: asiSingleAbility,
                                onChange: (e: any) => setAsiSingleAbility(e.target.value as AbilityId),
                              },
                              ABILITY_KEYS.map((k) =>
                                h(
                                  "option",
                                  { key: k, value: k },
                                  `${ABILITY_LABELS[k]} (Actuel : ${actor.abilities[k].score})`
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
                              h("label", { class: "block text-xs text-zinc-400" }, "Première caractéristique (+1) :"),
                              h(
                                "select",
                                {
                                  class: "w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-zinc-100",
                                  value: asiFirstAbility,
                                  onChange: (e: any) => setAsiFirstAbility(e.target.value as AbilityId),
                                },
                                ABILITY_KEYS.map((k) =>
                                  h(
                                    "option",
                                    { key: k, value: k },
                                    `${ABILITY_LABELS[k]} (Actuel : ${actor.abilities[k].score})`
                                  )
                                )
                              )
                            ),
                            h(
                              "div",
                              { class: "space-y-1" },
                              h("label", { class: "block text-xs text-zinc-400" }, "Deuxième caractéristique (+1) :"),
                              h(
                                "select",
                                {
                                  class: "w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-zinc-100",
                                  value: asiSecondAbility,
                                  onChange: (e: any) => setAsiSecondAbility(e.target.value as AbilityId),
                                },
                                ABILITY_KEYS.map((k) =>
                                  h(
                                    "option",
                                    { key: k, value: k },
                                    `${ABILITY_LABELS[k]} (Actuel : ${actor.abilities[k].score})`
                                  )
                                )
                              )
                            )
                          ),
                      asiErrorMessage &&
                        h("p", { class: "text-xs text-rose-400 font-medium" }, asiErrorMessage)
                    )
                  : h(
                      "div",
                      { class: "space-y-2 pt-2" },
                      h("label", { class: "block text-xs text-zinc-400" }, "Sélectionner un Don du compendium :"),
                      h(
                        "select",
                        {
                          class: "w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-zinc-100",
                          value: selectedFeatId,
                          onChange: (e: any) => setSelectedFeatId(e.target.value),
                        },
                        h("option", { value: "" }, "-- Choisir un Don --"),
                        availableFeats.map((feat) =>
                          h("option", { key: feat.id, value: feat.id }, feat.i18n?.fr?.name || feat.name)
                        )
                      ),
                      !selectedFeatId &&
                        h("p", { class: "text-xs text-amber-300/80" }, "Veuillez sélectionner un Don pour valider l'étape.")
                    )
              )
            : h(
                "div",
                { class: "p-4 bg-zinc-800/30 rounded border border-zinc-800 text-zinc-400 text-xs space-y-2" },
                h("p", null, `Le niveau ${targetLevel} n'est pas un palier d'ASI pour votre classe.`),
                h("p", null, "Vos aptitudes de classe par défaut seront enregistrées automatiquement.")
              )),

        // Step 4: Spells & Summary
        currentStep === 4 &&
          h(
            "div",
            { class: "space-y-4" },
            h("h3", { class: "text-base font-semibold text-zinc-200" }, isSpellcaster ? "Étape 4 : Emplacements & Sorts appris" : "Étape 4 : Récapitulatif"),
            isSpellcaster &&
              h(
                "div",
                { class: "space-y-3" },
                h("h4", { class: "text-xs font-semibold text-zinc-300 uppercase tracking-wider" }, "Nouveaux emplacements de sorts"),
                h(
                  "div",
                  { class: "grid grid-cols-5 gap-2 text-xs" },
                  Object.entries(projectedSlots).map(([slotKey, slotData]) =>
                    h(
                      "div",
                      { key: slotKey, class: "p-2 bg-zinc-800/80 rounded border border-zinc-700 text-center" },
                      h("span", { class: "text-zinc-400 block" }, slotKey.toUpperCase()),
                      h("strong", { class: "text-amber-400 text-sm" }, `${(slotData as any).max} slots`)
                    )
                  )
                ),
                availableSpellsForLevel.length > 0 &&
                  h(
                    "div",
                    { class: "space-y-2 pt-2" },
                    h("h4", { class: "text-xs font-semibold text-zinc-300 uppercase tracking-wider" }, "Ajouter de nouveaux sorts (Optionnel)"),
                    h(
                      "div",
                      { class: "max-h-48 overflow-y-auto border border-zinc-800 rounded p-2 space-y-1 bg-zinc-950/30 text-xs" },
                      availableSpellsForLevel.map((spell) => {
                        const isChecked = selectedSpellIds.includes(spell.id);
                        return h(
                          "label",
                          {
                            key: spell.id,
                            class: `flex items-center justify-between p-1.5 rounded cursor-pointer ${
                              isChecked ? "bg-amber-500/15 text-amber-200" : "hover:bg-zinc-800/50 text-zinc-300"
                            }`,
                          },
                          h(
                            "div",
                            { class: "flex items-center space-x-2" },
                            h("input", {
                              type: "checkbox",
                              checked: isChecked,
                              onChange: () => toggleSpellSelection(spell.id),
                              class: "text-amber-500 focus:ring-amber-500 rounded",
                            }),
                            h("span", null, spell.i18n?.fr?.name || spell.name)
                          ),
                          h("span", { class: "text-zinc-500 text-[10px]" }, `Niv. ${spell.data.level}`)
                        );
                      })
                    )
                  )
              ),
            h(
              "div",
              { class: "p-3 bg-zinc-800/40 rounded border border-zinc-700/60 space-y-1 text-xs text-zinc-300" },
              h("div", { class: "font-semibold text-amber-400 mb-1" }, "Résumé de l'avancement :"),
              h("div", null, `• Niveau : ${currentLevel} → ${targetLevel}`),
              h("div", null, `• PV Max : ${actor.attributes.hp.max} → ${actor.attributes.hp.max + currentHpGain} (+${currentHpGain})`),
              subclassId && needsSubclass && h("div", null, `• Sous-classe : ${subclassId}`),
              isAsi && asiOrFeatMode === "asi" && asiSubMode === "plusTwo" && h("div", null, `• ASI : +2 en ${asiSingleAbility.toUpperCase()}`),
              isAsi && asiOrFeatMode === "asi" && asiSubMode === "plusOneOne" && h("div", null, `• ASI : +1 en ${asiFirstAbility.toUpperCase()} & +1 en ${asiSecondAbility.toUpperCase()}`),
              isAsi && asiOrFeatMode === "feat" && h("div", null, `• Don : ${selectedFeatId}`),
              selectedSpellIds.length > 0 && h("div", null, `• Nouveaux sorts sélectionnés : ${selectedSpellIds.length}`)
            ),
            saveError && h("p", { class: "text-xs text-rose-400 font-medium" }, saveError)
          )
      ),

      // Modal Footer
      h(
        "footer",
        { class: "px-6 py-4 border-t border-zinc-800 flex items-center justify-between bg-zinc-950/40" },
        h(
          "button",
          {
            type: "button",
            class: "px-4 py-2 border border-zinc-700 hover:bg-zinc-800 text-zinc-300 rounded text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-zinc-600 disabled:opacity-30",
            onClick: () => setCurrentStep((s) => Math.max(1, s - 1)),
            disabled: currentStep === 1 || isSubmitting,
          },
          "Précédent"
        ),
        h(
          "div",
          { class: "space-x-3" },
          h(
            "button",
            {
              type: "button",
              class: "px-4 py-2 text-zinc-400 hover:text-zinc-200 text-xs font-semibold focus:outline-none",
              onClick: onClose,
              disabled: isSubmitting,
            },
            "Annuler"
          ),
          currentStep < 4
            ? h(
                "button",
                {
                  type: "button",
                  class: "px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-amber-400",
                  onClick: () => setCurrentStep((s) => Math.min(4, s + 1)),
                  disabled: !canProceed() || isSubmitting,
                },
                "Suivant"
              )
            : h(
                "button",
                {
                  type: "button",
                  class: "px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-400",
                  onClick: handleConfirmLevelUp,
                  disabled: !canProceed() || isSubmitting,
                },
                isSubmitting ? "Application..." : "Confirmer et Appliquer"
              )
        )
      )
    )
  );
}
