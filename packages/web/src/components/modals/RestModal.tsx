import { h, type VNode } from "preact";
import { useState, useId, useRef } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { useModalFocusTrap } from "../a11y/useModalFocusTrap.ts";
import {
  applyShortRest,
  applyLongRest,
  calculateHitDieRecovery,
  type Dnd5eActorData,
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

function formatModifier(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function formatRefill(current: number, max: number): string {
  return t("rest.refill", { current, max });
}

export function RestModal(props: RestModalProps): VNode<any> | null {
  return props.isOpen ? h(RestDialog, props) : null;
}

function RestDialog(props: RestModalProps): VNode<any> {
  const { actor, restType, onClose, onSave, diceRollService } = props;
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const trapFocus = useModalFocusTrap(dialogRef);

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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!isSubmitting) {
        onClose();
      }
      return;
    }
    trapFocus(e);
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
      setRollError(t("dice.serviceUnavailable"));
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
      setRollError(err.message || t("dice.rollFailed"));
      setDiceRolls([]);
    } finally {
      setIsRolling(false);
    }
  };

  const handleConfirmShortRest = async () => {
    if (spentDice > 0 && diceRolls.length !== spentDice) {
      setRollError(t("rest.rollFirst"));
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
      setSaveError(err.message || t("rest.short.saveFailed"));
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
      setSaveError(err.message || t("rest.long.saveFailed"));
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
      "data-testid": "rest-modal",
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
            isShort ? t("rest.short.title") : t("rest.long.title")
          ),
          h(
            "p",
            { id: descId, class: "text-xs text-[var(--atlas-text-muted)] mt-0.5" },
            isShort
              ? t("rest.short.description")
              : t("rest.long.description")
          )
        ),
        h(
          "button",
          {
            type: "button",
            class: "inline-flex items-center justify-center min-w-[40px] min-h-[40px] p-2 text-[var(--atlas-text-muted)] hover:text-[var(--atlas-text)] text-lg rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)]",
            onClick: onClose,
            "aria-label": isShort ? t("rest.short.close") : t("rest.long.close"),
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
                  h("span", { class: "text-[var(--atlas-text-muted)] block uppercase" }, t("rest.hitPoints")),
                  h("strong", { class: "text-sm text-[var(--atlas-text)]" }, `${currentHp} / ${maxHp}`),
                  tempHp > 0 && h("span", { class: "text-[var(--atlas-text-muted)] block" }, t("rest.tempHp", { value: tempHp }))
                ),
                h(
                  "div",
                  null,
                  h("span", { class: "text-[var(--atlas-text-muted)] block uppercase" }, t("rest.hitDiceAvailable")),
                  h("strong", { class: "text-sm text-[var(--atlas-action)]" }, `${currentHitDice} / ${maxHitDice} (d${hitDieSize})`)
                ),
                h(
                  "div",
                  null,
                  h("span", { class: "text-[var(--atlas-text-muted)] block uppercase" }, t("rest.conModifier")),
                  h("strong", { class: "text-sm text-[var(--atlas-text)]" }, formatModifier(conMod))
                )
              ),

              // Guardrails
              currentHitDice === 0 &&
                h(
                  "div",
                  { role: "status", class: "p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs text-[var(--atlas-text-muted)]" },
                  t("rest.noHitDice")
                ),
              currentHp >= maxHp && currentHitDice > 0 &&
                h(
                  "div",
                  { role: "status", class: "p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs text-[var(--atlas-text-muted)]" },
                  t("rest.hpAlreadyMax")
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
                    t("rest.spendLabel")
                  ),
                  h(
                    "div",
                    {
                      class: "flex items-center space-x-2",
                      role: "group",
                      "aria-labelledby": "spent-dice-label",
                    },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "min-w-[40px] min-h-[40px] px-3 py-1 bg-[var(--atlas-surface)] border border-[var(--atlas-border)] rounded text-sm font-bold text-[var(--atlas-text)] hover:opacity-80 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                        onClick: () => handleSpentDiceChange(spentDice - 1),
                        disabled: spentDice <= 0 || isRolling || isSubmitting,
                        "aria-label": t("rest.decrease"),
                      },
                      "-"
                    ),
                    h(
                      "span",
                      {
                        class: "w-10 text-center font-bold text-base text-[var(--atlas-action)]",
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
                        "aria-label": t("rest.increase"),
                      },
                      "+"
                    )
                  )
                ),
                h(
                  "p",
                  { class: "text-[11px] text-[var(--atlas-text-muted)]" },
                  t("rest.diceHint", { current: currentHitDice, max: maxHitDice, die: hitDieSize, mod: formatModifier(conMod) })
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
                        ? t("dice.rolling")
                        : diceRolls.length === spentDice
                        ? t("rest.reroll", { count: spentDice, die: hitDieSize })
                        : t("rest.roll", { count: spentDice, die: hitDieSize })
                    ),
                    diceRolls.length === spentDice &&
                      h(
                        "span",
                        { class: "text-xs font-semibold text-[var(--atlas-action)]" },
                        t("rest.hpGenerated", { value: totalShortRestHpGained })
                      )
                  )
              ),

              // Roll Results & Preview Breakdown
              diceRolls.length > 0 &&
                h(
                  "div",
                  { class: "space-y-2 p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs" },
                  h("div", { class: "font-semibold text-[var(--atlas-action)]" }, t("rest.rollBreakdown")),
                  h(
                    "ul",
                    { class: "space-y-1" },
                    diceRolls.map((roll, idx) => {
                      const gain = Math.max(1, roll + conMod);
                      const isFloored = roll + conMod < 1;
                      return h(
                        "li",
                        { key: idx, class: "flex items-center justify-between text-[var(--atlas-text)]" },
                        h("span", null, t("rest.rollLine", { index: idx + 1, die: hitDieSize, roll, mod: formatModifier(conMod) })),
                        h(
                          "strong",
                          { class: "text-[var(--atlas-action)]" },
                          isFloored ? t("rest.rollGainFloored", { value: gain }) : t("hp.gain", { value: gain })
                        )
                      );
                    })
                  ),
                  h(
                    "div",
                    { class: "pt-2 border-t border-[var(--atlas-border)] flex items-center justify-between font-semibold" },
                    h("span", null, t("rest.hpPreview")),
                    h(
                      "span",
                      { class: "text-[var(--atlas-action)]" },
                      t("rest.hpTransition", { from: currentHp, to: projectedShortRestHp, max: maxHp, gain: actualShortRestGain })
                    )
                  ),
                  h(
                    "div",
                    { class: "flex items-center justify-between text-[var(--atlas-text-muted)]" },
                    h("span", null, t("rest.hitDiceRemaining")),
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
                h("div", { class: "font-semibold text-[var(--atlas-action)]" }, t("rest.short.resourcesTitle")),
                shortRestResourceList.length === 0 && !pactSlots &&
                  h("p", { class: "text-[var(--atlas-text-muted)]" }, t("rest.short.noResources")),
                shortRestResourceList.map(([key, res]) =>
                  h(
                    "div",
                    { key, class: "flex items-center justify-between text-[var(--atlas-text)]" },
                    h("span", { class: "capitalize" }, key.replace(/_/g, " ")),
                    h("strong", null, formatRefill(res.current, res.max))
                  )
                ),
                pactSlots &&
                  h(
                    "div",
                    { class: "flex items-center justify-between text-[var(--atlas-text)]" },
                    h("span", null, t("rest.pactMagic")),
                    h("strong", null, formatRefill(pactSlots.current, pactSlots.max))
                  )
              ),
            ]
          : [
              // Long Rest Recovery Read-Only Summary
              h(
                "div",
                { class: "space-y-3 p-4 bg-[var(--atlas-surface-raised)] rounded-lg border border-[var(--atlas-border)] text-xs" },
                h("h3", { class: "text-sm font-semibold text-[var(--atlas-action)] uppercase tracking-wider" }, t("rest.long.effectsTitle")),
                h(
                  "ul",
                  { class: "space-y-2 text-[var(--atlas-text)]" },
                  // 1. Full HP restoration
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, t("rest.long.hpRestore")),
                    h("strong", { class: "text-[var(--atlas-action)]" }, t("rest.hpTransition", { from: currentHp, to: maxHp, max: maxHp, gain: maxHp - currentHp }))
                  ),
                  // 2. Temp HP wipe
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, t("rest.long.tempReset")),
                    h("strong", null, `${tempHp} → 0`)
                  ),
                  // 3. Hit Dice recovery
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, t("rest.long.hitDiceRecovery", { max: maxHitDice })),
                    h(
                      "strong",
                      { class: "text-[var(--atlas-action)]" },
                      t("rest.long.hitDiceRecoveryValue", { count: longRestRecoveredDice, from: currentHitDice, to: projectedLongRestHitDice, max: maxHitDice })
                    )
                  ),
                  // 4. Exhaustion reduction
                  h(
                    "li",
                    { class: "flex items-center justify-between" },
                    h("span", null, t("rest.long.exhaustion")),
                    h(
                      "strong",
                      null,
                      currentExhaustion > 0
                        ? t("rest.long.exhaustionValue", { from: currentExhaustion, to: projectedLongRestExhaustion })
                        : t("rest.long.noExhaustion")
                    )
                  ),
                  // 5. Death saves reset
                  (actor.attributes.deathSaves?.successes > 0 || actor.attributes.deathSaves?.failures > 0) &&
                    h(
                      "li",
                      { class: "flex items-center justify-between" },
                      h("span", null, t("rest.long.deathSaves")),
                      h("strong", null, t("rest.long.deathSavesReset"))
                    )
                )
              ),

              // Long Rest Spell Slots Breakdown
              h(
                "div",
                { class: "space-y-2 p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs" },
                h("div", { class: "font-semibold text-[var(--atlas-action)]" }, t("rest.long.slotsTitle")),
                activeSpellSlots.length === 0
                  ? h("p", { class: "text-[var(--atlas-text-muted)]" }, t("rest.long.noSlots"))
                  : h(
                      "div",
                      { class: "grid grid-cols-2 gap-2" },
                      activeSpellSlots.map(({ tier, slot }) => {
                        const tierLabel =
                          tier === "pact"
                            ? t("rest.slot.pact")
                            : t("rest.slot.level", { level: tier.replace("level", "") });
                        return h(
                          "div",
                          { key: tier, class: "p-2 bg-[var(--atlas-surface)] rounded border border-[var(--atlas-border)] flex items-center justify-between" },
                          h("span", { class: "text-[var(--atlas-text-muted)]" }, tierLabel),
                          h("strong", null, formatRefill(slot.current, slot.max))
                        );
                      })
                    )
              ),

              // Long Rest Resources Breakdown
              h(
                "div",
                { class: "space-y-2 p-3 bg-[var(--atlas-surface-raised)] rounded border border-[var(--atlas-border)] text-xs" },
                h("div", { class: "font-semibold text-[var(--atlas-action)]" }, t("rest.long.resourcesTitle")),
                longRestResourceList.length === 0
                  ? h("p", { class: "text-[var(--atlas-text-muted)]" }, t("rest.long.noResources"))
                  : longRestResourceList.map(([key, res]) =>
                      h(
                        "div",
                        { key, class: "flex items-center justify-between text-[var(--atlas-text)]" },
                        h("span", { class: "capitalize" }, key.replace(/_/g, " ")),
                        h("strong", null, formatRefill(res.current, res.max))
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
          t("action.cancel")
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
              isSubmitting ? t("action.applying") : t("rest.short.confirm")
            )
          : h(
              "button",
              {
                type: "button",
                class: "min-h-[40px] px-5 py-2 bg-[var(--atlas-action)] hover:opacity-90 disabled:opacity-40 text-[var(--atlas-on-action)] rounded text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--atlas-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--atlas-surface)] inline-flex items-center justify-center",
                onClick: handleConfirmLongRest,
                disabled: isSubmitting,
              },
              isSubmitting ? t("action.applying") : t("rest.long.confirm")
            )
      )
    )
  );
}
