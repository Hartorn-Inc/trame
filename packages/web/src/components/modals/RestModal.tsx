import { h, type VNode } from "preact";
import { useState, useId, useRef, useEffect } from "preact/hooks";
import {
  applyShortRest,
  applyLongRest,
  calculateHitDieRecovery,
  type Dnd5eActorData,
  type ResourcePool,
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

export interface RestModalProps {
  actor: Dnd5eActorData;
  restType: "short" | "long";
  isOpen: boolean;
  onClose: () => void;
  onSave: (updatedActor: Dnd5eActorData) => void | Promise<void>;
  diceRollService?: DiceRollService;
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const focusables: HTMLElement[] = [];
  const tags = ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"];
  const walk = (node: any) => {
    if (!node) return;
    if (node.nodeType === 1) {
      const tag = (node.nodeName || "").toUpperCase();
      const hasTabIndex = typeof node.hasAttribute === "function" && node.hasAttribute("tabindex");
      const tabIndexVal = hasTabIndex ? node.getAttribute("tabindex") : null;
      const isInteractive = tags.includes(tag) || (hasTabIndex && tabIndexVal !== "-1");
      const isDisabled = Boolean(node.disabled || (typeof node.getAttribute === "function" && node.getAttribute("disabled") === "true"));
      if (isInteractive && !isDisabled) {
        focusables.push(node);
      }
    }
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
      }
    }
  };
  walk(container);
  return focusables;
}

export function RestModal(props: RestModalProps): VNode<any> | null {
  if (!props.isOpen) return null;

  const { actor, restType, onClose, onSave, diceRollService } = props;
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const currentHp = actor.attributes.hp.current;
  const maxHp = actor.attributes.hp.max;
  const tempHp = actor.attributes.hp.temp ?? 0;
  const currentHitDice = actor.attributes.hitDiceCurrent;
  const maxHitDice = actor.attributes.hitDiceMax;
  const hitDieSize = actor.attributes.hitDieSize || 8;
  const conScore =
    typeof actor.abilities?.con === "object"
      ? actor.abilities.con.score
      : typeof actor.abilities?.con === "number"
        ? actor.abilities.con
        : 10;
  const conMod = Math.floor((conScore - 10) / 2);
  const currentExhaustion = actor.attributes.exhaustion ?? 0;

  // Short Rest state
  const [spentDice, setSpentDice] = useState<number>(0);
  const [diceRolls, setDiceRolls] = useState<number[]>([]);
  const [isRolling, setIsRolling] = useState<boolean>(false);
  const [rollError, setRollError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.isOpen) return;
    const focusables = getFocusableElements(dialogRef.current);
    if (focusables.length > 0) {
      focusables[0].focus();
    } else if (dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [props.isOpen]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (typeof e.stopPropagation === "function") {
        e.stopPropagation();
      }
      if (!isSubmitting) {
        onClose();
      }
      return;
    }
    if (e.key === "Tab") {
      const focusables = getFocusableElements(dialogRef.current);
      if (focusables.length === 0) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const doc = typeof document !== "undefined" ? document : null;
      const active = (doc && (doc as any).activeElement ? (doc as any).activeElement : e.target) as HTMLElement | null;

      if (e.shiftKey) {
        if (!active || active === first || (dialogRef.current && !dialogRef.current.contains(active))) {
          if (typeof e.preventDefault === "function") e.preventDefault();
          last.focus();
        }
      } else {
        if (!active || active === last || (dialogRef.current && !dialogRef.current.contains(active))) {
          if (typeof e.preventDefault === "function") e.preventDefault();
          first.focus();
        }
      }
    }
  };

  const handleSpentDiceChange = (newCount: number) => {
    const clamped = Math.max(0, Math.min(currentHitDice, newCount));
    setSpentDice(clamped);
    if (clamped !== diceRolls.length) {
      setDiceRolls([]);
      setRollError(null);
    }
  };

  const handleRollDice = async () => {
    if (spentDice <= 0) return;
    if (!diceRollService) {
      setRollError("Service de dés serveur indisponible");
      return;
    }
    try {
      setIsRolling(true);
      setRollError(null);
      const rolls: number[] = [];
      for (let i = 0; i < spentDice; i++) {
        const result = await diceRollService.roll(`1d${hitDieSize}`, {
          reason: "short_rest_hit_dice",
          actorId: actor.id,
        });
        const val = result.rolls && result.rolls.length > 0 ? result.rolls[0] : result.total;
        rolls.push(val);
      }
      setDiceRolls(rolls);
    } catch (err: any) {
      setRollError(err.message || "Erreur lors du tirage de dés");
      setDiceRolls([]);
    } finally {
      setIsRolling(false);
    }
  };

  const handleConfirmShortRest = async () => {
    if (spentDice > 0 && diceRolls.length !== spentDice) {
      setRollError("Veuillez lancer les dés avant de confirmer le repos court");
      return;
    }
    try {
      setIsSubmitting(true);
      setSaveError(null);
      const updated = applyShortRest(actor, {
        hitDieSpend: {
          count: spentDice,
          rollResults: diceRolls,
        },
        hitDiceSpent: spentDice,
        diceRolls,
      });
      await onSave(updated);
      onClose();
    } catch (err: any) {
      setSaveError(err.message || "Erreur lors de l'application du repos court");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmLongRest = async () => {
    try {
      setIsSubmitting(true);
      setSaveError(null);
      const updated = applyLongRest(actor);
      await onSave(updated);
      onClose();
    } catch (err: any) {
      setSaveError(err.message || "Erreur lors de l'application du repos long");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Short Rest Computed Previews
  const shortRestHpGains = diceRolls.map((roll) => Math.max(1, roll + conMod));
  const totalShortRestHpGained = shortRestHpGains.reduce((sum, val) => sum + val, 0);
  const projectedShortRestHp = Math.min(maxHp, currentHp + totalShortRestHpGained);
  const actualShortRestGain = projectedShortRestHp - currentHp;

  const shortRestResourceList = Object.entries(actor.resources ?? {}).filter(
    ([_, res]) =>
      res &&
      (res.resetOn === "SHORT_REST" || (res as unknown as { recovery?: string }).recovery === "short_rest")
  );

  const pactSlots = actor.spellSlots?.pact;

  // Long Rest Computed Previews
  const longRestRecoveredDice = calculateHitDieRecovery(maxHitDice);
  const projectedLongRestHitDice = Math.min(maxHitDice, currentHitDice + longRestRecoveredDice);
  const projectedLongRestExhaustion = Math.max(0, currentExhaustion - 1);

  const longRestResourceList = Object.entries(actor.resources ?? {}).filter(
    ([_, res]) =>
      res &&
      (res.resetOn === "SHORT_REST" ||
        res.resetOn === "LONG_REST" ||
        (res as unknown as { recovery?: string }).recovery === "short_rest" ||
        (res as unknown as { recovery?: string }).recovery === "long_rest")
  );

  const standardSpellSlotTiers: (keyof SpellSlotsState)[] = [
    "level1",
    "level2",
    "level3",
    "level4",
    "level5",
    "level6",
    "level7",
    "level8",
    "level9",
    "pact",
  ];
  const activeSpellSlots = standardSpellSlotTiers
    .map((tier) => ({
      tier,
      slot: actor.spellSlots ? actor.spellSlots[tier] : undefined,
    }))
    .filter((entry): entry is { tier: keyof SpellSlotsState; slot: NonNullable<SpellSlotsState[keyof SpellSlotsState]> } =>
      Boolean(entry.slot && entry.slot.max > 0)
    );

  const isShort = restType === "short";

  return h(
    "div",
    {
      ref: dialogRef,
      class: "ds-rest-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4",
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
        class: "ds-rest-modal w-full max-w-xl bg-[var(--atlas-surface)] border border-[var(--atlas-border)] rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-[var(--atlas-text)]",
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
            isShort ? "Repos court (Short Rest)" : "Repos long (Long Rest)"
          ),
          h(
            "p",
            { id: descId, class: "text-xs text-[var(--atlas-text-muted)] mt-0.5" },
            isShort
              ? "Dépensez vos dés de vie pour regagner des PV et réinitialiser vos aptitudes de repos court."
              : "Récupération complète des points de vie, emplacements de sorts et réinitialisation des capacités."
          )
        ),
        h(
          "button",
          {
            type: "button",
            class: "inline-flex items-center justify-center min-w-[40px] min-h-[40px] p-2 text-[var(--atlas-text-muted)] hover:text-[var(--atlas-text)] text-lg rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
            onClick: onClose,
            "aria-label": isShort ? "Fermer la fenêtre de repos court" : "Fermer la fenêtre de repos long",
            disabled: isSubmitting,
          },
          "✕"
        )
      ),

      // Modal Body
      h(
        "div",
        { class: "p-6 overflow-y-auto flex-1 space-y-5 text-sm" },
        isShort
          ? [
              // Current Actor Vitality Overview
              h(
                "div",
                { class: "grid grid-cols-3 gap-3 p-3 bg-[var(--atlas-surface-raised)] rounded-lg border border-[var(--atlas-border)] text-xs" },
                h(
                  "div",
                  null,
                  h("span", { class: "text-[var(--atlas-text-muted)] block uppercase" }, "Points de vie"),
                  h("strong", { class: "text-sm text-[var(--atlas-text)]" }, `${currentHp} / ${maxHp}`),
                  tempHp > 0 && h("span", { class: "text-[var(--atlas-text-muted)] block" }, `(+${tempHp} temp)`)
                ),
                h(
                  "div",
                  null,
                  h("span", { class: "text-[var(--atlas-text-muted)] block uppercase" }, "Dés de vie dispos"),
                  h("strong", { class: "text-sm text-[var(--atlas-action)]" }, `${currentHitDice} / ${maxHitDice} (d${hitDieSize})`)
                ),
                h(
                  "div",
                  null,
                  h("span", { class: "text-[var(--atlas-text-muted)] block uppercase" }, "Modif. Constitution"),
                  h("strong", { class: "text-sm text-[var(--atlas-text)]" }, conMod >= 0 ? `+${conMod}` : `${conMod}`)
                )
              ),

              // Guardrails
              currentHitDice === 0 &&
                h(
                  "div",
                  { role: "status", class: "p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs text-[var(--atlas-text-muted)]" },
                  "Aucun dé de vie disponible pour la récupération de points de vie. Vous pouvez toutefois terminer le repos court pour réinitialiser vos ressources et emplacements de pacte."
                ),
              currentHp >= maxHp && currentHitDice > 0 &&
                h(
                  "div",
                  { role: "status", class: "p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs text-[var(--atlas-text-muted)]" },
                  "Vos points de vie sont déjà à leur maximum. Dépenser des dés de vie n'augmentera pas vos PV au-delà de votre maximum."
                ),

              // Hit Dice Spending Selector
              h(
                "div",
                { class: "space-y-3 p-4 bg-[var(--atlas-surface-raised)] rounded-lg border border-[var(--atlas-border)]" },
                h(
                  "div",
                  { class: "flex items-center justify-between" },
                  h(
                    "label",
                    { id: "spent-dice-label", class: "font-semibold text-xs text-[var(--atlas-text)] uppercase tracking-wider" },
                    "Dés de vie à dépenser :"
                  ),
                  h(
                    "div",
                    { class: "flex items-center space-x-2" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "min-w-[40px] min-h-[40px] px-3 py-1 bg-[var(--atlas-surface)] border border-[var(--atlas-border)] rounded text-sm font-bold text-[var(--atlas-text)] hover:opacity-80 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                        onClick: () => handleSpentDiceChange(spentDice - 1),
                        disabled: spentDice <= 0 || isRolling || isSubmitting,
                        "aria-label": "Diminuer les dés de vie dépensés",
                      },
                      "-"
                    ),
                    h(
                      "span",
                      {
                        class: "w-10 text-center font-bold text-base text-[var(--atlas-action)]",
                        "aria-labelledby": "spent-dice-label",
                        "aria-live": "polite",
                        "data-testid": "spent-dice-count",
                      },
                      spentDice
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "min-w-[40px] min-h-[40px] px-3 py-1 bg-[var(--atlas-surface)] border border-[var(--atlas-border)] rounded text-sm font-bold text-[var(--atlas-text)] hover:opacity-80 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                        onClick: () => handleSpentDiceChange(spentDice + 1),
                        disabled: spentDice >= currentHitDice || isRolling || isSubmitting,
                        "aria-label": "Augmenter les dés de vie dépensés",
                      },
                      "+"
                    )
                  )
                ),
                h(
                  "p",
                  { class: "text-[11px] text-[var(--atlas-text-muted)]" },
                  `Dés disponibles : ${currentHitDice} / ${maxHitDice}. Chaque dé dépense 1d${hitDieSize} et ajoute votre modificateur de Constitution (+${conMod} PV, min. 1).`
                ),
                spentDice > 0 &&
                  h(
                    "div",
                    { class: "pt-2 flex items-center justify-between border-t border-[var(--atlas-border)]" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "min-h-[40px] px-4 py-2 bg-[var(--atlas-action)] hover:opacity-90 disabled:opacity-40 text-[var(--atlas-on-action)] rounded font-semibold text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                        onClick: handleRollDice,
                        disabled: isRolling || isSubmitting,
                      },
                      isRolling
                        ? "Tirage en cours..."
                        : diceRolls.length === spentDice
                        ? `Relancer les ${spentDice}d${hitDieSize}`
                        : `Lancer les ${spentDice}d${hitDieSize} de récupération`
                    ),
                    diceRolls.length === spentDice &&
                      h(
                        "span",
                        { class: "text-xs font-semibold text-[var(--atlas-action)]" },
                        `+${totalShortRestHpGained} PV générés`
                      )
                  )
              ),

              // Roll Results & Preview Breakdown
              diceRolls.length > 0 &&
                h(
                  "div",
                  { class: "space-y-2 p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs" },
                  h("div", { class: "font-semibold text-[var(--atlas-action)]" }, "Détail des tirages de dés (min. 1 PV par dé) :"),
                  h(
                    "ul",
                    { class: "space-y-1" },
                    diceRolls.map((roll, idx) => {
                      const gain = Math.max(1, roll + conMod);
                      const isFloored = roll + conMod < 1;
                      return h(
                        "li",
                        { key: idx, class: "flex items-center justify-between text-[var(--atlas-text)]" },
                        h("span", null, `Dé #${idx + 1} (d${hitDieSize}) : Résultat ${roll} + CON (${conMod >= 0 ? "+" + conMod : conMod})`),
                        h(
                          "strong",
                          { class: "text-[var(--atlas-action)]" },
                          `+${gain} PV ${isFloored ? "(plancher min. 1)" : ""}`
                        )
                      );
                    })
                  ),
                  h(
                    "div",
                    { class: "pt-2 border-t border-[var(--atlas-border)] flex items-center justify-between font-semibold" },
                    h("span", null, "Aperçu des PV après repos :"),
                    h(
                      "span",
                      { class: "text-[var(--atlas-action)]" },
                      `${currentHp} → ${projectedShortRestHp} / ${maxHp} (+${actualShortRestGain} PV)`
                    )
                  ),
                  h(
                    "div",
                    { class: "flex items-center justify-between text-[var(--atlas-text-muted)]" },
                    h("span", null, "Dés de vie restants :"),
                    h("span", null, `${currentHitDice - spentDice} / ${maxHitDice}`)
                  )
                ),

              // Error Displays
              rollError &&
                h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, rollError),
              saveError &&
                h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, saveError),

              // SHORT_REST Resources Preview
              h(
                "div",
                { class: "space-y-2 p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs" },
                h("div", { class: "font-semibold text-[var(--atlas-action)]" }, "Réinitialisation des ressources (Repos court) :"),
                shortRestResourceList.length === 0 && !pactSlots &&
                  h("p", { class: "text-[var(--atlas-text-muted)]" }, "Aucune ressource de repos court ou emplacement de pacte à réinitialiser."),
                shortRestResourceList.map(([key, res]) =>
                  h(
                    "div",
                    { key, class: "flex items-center justify-between text-[var(--atlas-text)]" },
                    h("span", { class: "capitalize" }, key.replace(/_/g, " ")),
                    h("strong", null, `${res.current} / ${res.max} → ${res.max} / ${res.max}`)
                  )
                ),
                pactSlots &&
                  h(
                    "div",
                    { class: "flex items-center justify-between text-[var(--atlas-text)]" },
                    h("span", null, "Magie de Pacte (Warlock)"),
                    h("strong", null, `${pactSlots.current} / ${pactSlots.max} → ${pactSlots.max} / ${pactSlots.max}`)
                  )
              ),
            ]
          : [
              // Long Rest Recovery Read-Only Summary
              h(
                "div",
                { class: "space-y-3 p-4 bg-[var(--atlas-surface-raised)] rounded-lg border border-[var(--atlas-border)] text-xs" },
                h("h3", { class: "text-sm font-semibold text-[var(--atlas-action)] uppercase tracking-wider" }, "Effets du Repos Long :"),
                h(
                  "ul",
                  { class: "space-y-2 text-[var(--atlas-text)]" },
                  // 1. Full HP restoration
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, "Restauration intégrale des Points de Vie :"),
                    h("strong", { class: "text-[var(--atlas-action)]" }, `${currentHp} → ${maxHp} / ${maxHp} (+${maxHp - currentHp} PV)`)
                  ),
                  // 2. Temp HP wipe
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, "Remise à zéro des PV temporaires :"),
                    h("strong", null, `${tempHp} → 0`)
                  ),
                  // 3. Hit Dice recovery
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, `Récupération de dés de vie (max(1, ⌊${maxHitDice}/2⌋)) :`),
                    h(
                      "strong",
                      { class: "text-[var(--atlas-action)]" },
                      `+${longRestRecoveredDice} dé(s) (${currentHitDice} → ${projectedLongRestHitDice} / ${maxHitDice})`
                    )
                  ),
                  // 4. Exhaustion reduction
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, "Réduction du niveau d'épuisement :"),
                    h(
                      "strong",
                      null,
                      currentExhaustion > 0
                        ? `${currentExhaustion} → ${projectedLongRestExhaustion} (-1 niveau)`
                        : "0 (aucun épuisement)"
                    )
                  ),
                  // 5. Death saves reset
                  (actor.attributes.deathSaves?.successes > 0 || actor.attributes.deathSaves?.failures > 0) &&
                    h(
                      "li",
                      { class: "flex items-center justify-between" },
                      h("span", null, "Jets contre la mort :"),
                      h("strong", null, "Réinitialisés (0 succès, 0 échec)")
                    )
                )
              ),

              // Long Rest Spell Slots Breakdown
              h(
                "div",
                { class: "space-y-2 p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs" },
                h("div", { class: "font-semibold text-[var(--atlas-action)]" }, "Restauration des emplacements de sorts :"),
                activeSpellSlots.length === 0
                  ? h("p", { class: "text-[var(--atlas-text-muted)]" }, "Aucun emplacement de sort à réinitialiser.")
                  : h(
                      "div",
                      { class: "grid grid-cols-2 gap-2" },
                      activeSpellSlots.map(({ tier, slot }) => {
                        const tierLabel =
                          tier === "pact"
                            ? "Pacte"
                            : tier.replace("level", "Niveau ");
                        return h(
                          "div",
                          { key: tier, class: "p-2 bg-[var(--atlas-surface)] rounded border border-[var(--atlas-border)] flex items-center justify-between" },
                          h("span", { class: "text-[var(--atlas-text-muted)]" }, tierLabel),
                          h("strong", null, `${slot.current} / ${slot.max} → ${slot.max} / ${slot.max}`)
                        );
                      })
                    )
              ),

              // Long Rest Resources Breakdown
              h(
                "div",
                { class: "space-y-2 p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs" },
                h("div", { class: "font-semibold text-[var(--atlas-action)]" }, "Réinitialisation des réserves (Repos court & long) :"),
                longRestResourceList.length === 0
                  ? h("p", { class: "text-[var(--atlas-text-muted)]" }, "Aucune réserve de ressource à réinitialiser.")
                  : longRestResourceList.map(([key, res]) =>
                      h(
                        "div",
                        { key, class: "flex items-center justify-between text-[var(--atlas-text)]" },
                        h("span", { class: "capitalize" }, key.replace(/_/g, " ")),
                        h("strong", null, `${res.current} / ${res.max} → ${res.max} / ${res.max}`)
                      )
                    )
              ),

              // Error Displays
              saveError &&
                h("p", { role: "alert", "aria-live": "polite", class: "text-xs text-[var(--atlas-danger)] font-medium" }, saveError),
            ]
      ),

      // Modal Footer
      h(
        "footer",
        { class: "px-6 py-4 border-t border-[var(--atlas-border)] flex items-center justify-between bg-[var(--atlas-surface-raised)]" },
        h(
          "button",
          {
            type: "button",
            class: "min-h-[40px] px-4 py-2 text-[var(--atlas-text-muted)] hover:text-[var(--atlas-text)] text-xs font-semibold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] disabled:opacity-40 inline-flex items-center justify-center",
            onClick: onClose,
            disabled: isSubmitting,
          },
          "Annuler"
        ),
        isShort
          ? h(
              "button",
              {
                type: "button",
                class: "min-h-[40px] px-5 py-2 bg-[var(--atlas-action)] hover:opacity-90 disabled:opacity-40 text-[var(--atlas-on-action)] rounded text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                onClick: handleConfirmShortRest,
                disabled: isSubmitting || isRolling || (spentDice > 0 && diceRolls.length !== spentDice),
              },
              isSubmitting ? "Application..." : "Confirmer le Repos Court"
            )
          : h(
              "button",
              {
                type: "button",
                class: "min-h-[40px] px-5 py-2 bg-[var(--atlas-action)] hover:opacity-90 disabled:opacity-40 text-[var(--atlas-on-action)] rounded text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                onClick: handleConfirmLongRest,
                disabled: isSubmitting,
              },
              isSubmitting ? "Application..." : "Confirmer le Repos Long"
            )
      )
    )
  );
}
