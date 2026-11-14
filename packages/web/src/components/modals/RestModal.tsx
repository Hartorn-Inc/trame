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

/** `aria-disabled` keeps a refusing button focusable; handlers must still guard. */
function ariaDisabled(disabled: boolean): "true" | undefined {
  return disabled ? "true" : undefined;
}

export function RestModal(props: RestModalProps): VNode<any> | null {
  return props.isOpen ? h(RestDialog, props) : null;
}

function RestDialog(props: RestModalProps): VNode<any> {
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

  const busy = isRolling || isSubmitting;

  useModalFocusTrap(dialogRef, {
    onEscape: () => {
      if (!isSubmitting) onClose();
    },
  });

  const handleClose = () => {
    if (!isSubmitting) onClose();
  };

  const handleSpentDiceChange = (newCount: number) => {
    if (busy) return;
    const clamped = Math.max(0, Math.min(currentHitDice, newCount));
    setSpentDice(clamped);
    if (clamped !== diceRolls.length) {
      setDiceRolls([]);
      setRollError(null);
    }
  };

  const handleRollDice = async () => {
    if (spentDice <= 0 || busy) return;
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
    if (busy) return;
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
    if (isSubmitting) return;
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
  const rollsMissing = spentDice > 0 && diceRolls.length !== spentDice;

  const resourceRow = (key: string, label: string, value: string) =>
    h("div", { key, class: "ds-row" }, h("span", null, label), h("strong", null, value));

  return h(
    "div",
    {
      ref: dialogRef,
      "data-testid": "rest-modal",
      class: "ds-modal-backdrop",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      "aria-describedby": descId,
      tabIndex: -1,
    },
    h(
      "div",
      { class: "ds-modal ds-modal-narrow" },
      // Modal Header
      h(
        "header",
        { class: "ds-modal-header" },
        h(
          "div",
          null,
          h("h2", { id: titleId, class: "ds-modal-title" }, isShort ? t("rest.short.title") : t("rest.long.title")),
          h("p", { id: descId, class: "ds-modal-subtitle" }, isShort ? t("rest.short.description") : t("rest.long.description"))
        ),
        h(
          "button",
          {
            type: "button",
            class: "ds-btn-reset ds-icon-btn",
            onClick: handleClose,
            "aria-label": isShort ? t("rest.short.close") : t("rest.long.close"),
            "aria-disabled": ariaDisabled(isSubmitting),
          },
          "✕"
        )
      ),

      // Modal Body
      h(
        "div",
        { class: "ds-modal-body" },
        isShort
          ? [
              // Current Actor Vitality Overview
              h(
                "div",
                { key: "vitals", class: "ds-inset" },
                h(
                "div",
                { class: "ds-grid-3" },
                h(
                  "div",
                  null,
                  h("span", { class: "ds-meta" }, t("rest.hitPoints")),
                  h("strong", { class: "ds-value atlas-tabular-nums" }, `${currentHp} / ${maxHp}`),
                  tempHp > 0 && h("span", { class: "ds-meta" }, t("rest.tempHp", { value: tempHp }))
                ),
                h(
                  "div",
                  null,
                  h("span", { class: "ds-meta" }, t("rest.hitDiceAvailable")),
                  h("strong", { class: "ds-value atlas-tabular-nums" }, `${currentHitDice} / ${maxHitDice} (d${hitDieSize})`)
                ),
                h(
                  "div",
                  null,
                  h("span", { class: "ds-meta" }, t("rest.conModifier")),
                  h("strong", { class: "ds-value atlas-tabular-nums" }, formatModifier(conMod))
                )
                )
              ),

              // Guardrails
              currentHitDice === 0 && h("div", { key: "no-dice", role: "status", class: "ds-inset ds-hint" }, t("rest.noHitDice")),
              currentHp >= maxHp && currentHitDice > 0 &&
                h("div", { key: "hp-max", role: "status", class: "ds-inset ds-hint" }, t("rest.hpAlreadyMax")),

              // Hit Dice Spending Selector
              h(
                "div",
                { key: "spend", class: "ds-inset" },
                h(
                  "div",
                  { class: "ds-row" },
                  h("label", { id: "spent-dice-label", class: "ds-field-label" }, t("rest.spendLabel")),
                  h(
                    "div",
                    { class: "ds-cluster", role: "group", "aria-labelledby": "spent-dice-label" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "ds-btn ds-btn-secondary",
                        onClick: () => handleSpentDiceChange(spentDice - 1),
                        "aria-disabled": ariaDisabled(spentDice <= 0 || busy),
                        "aria-label": t("rest.decrease"),
                      },
                      "-"
                    ),
                    h(
                      "span",
                      { class: "ds-counter atlas-tabular-nums", "aria-live": "polite", "data-testid": "spent-dice-count" },
                      spentDice
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "ds-btn ds-btn-secondary",
                        onClick: () => handleSpentDiceChange(spentDice + 1),
                        "aria-disabled": ariaDisabled(spentDice >= currentHitDice || busy),
                        "aria-label": t("rest.increase"),
                      },
                      "+"
                    )
                  )
                ),
                h("p", { class: "ds-hint" }, t("rest.diceHint", { current: currentHitDice, max: maxHitDice, die: hitDieSize, mod: formatModifier(conMod) })),
                spentDice > 0 &&
                  h(
                    "div",
                    { class: "ds-row" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "ds-btn ds-btn-secondary",
                        onClick: handleRollDice,
                        "aria-disabled": ariaDisabled(busy),
                        "aria-busy": isRolling ? "true" : undefined,
                      },
                      isRolling
                        ? t("dice.rolling")
                        : diceRolls.length === spentDice
                        ? t("rest.reroll", { count: spentDice, die: hitDieSize })
                        : t("rest.roll", { count: spentDice, die: hitDieSize })
                    ),
                    diceRolls.length === spentDice &&
                      h("span", { class: "ds-value atlas-tabular-nums" }, t("rest.hpGenerated", { value: totalShortRestHpGained }))
                  )
              ),

              // Roll Results & Preview Breakdown
              diceRolls.length > 0 &&
                h(
                  "div",
                  { key: "breakdown", class: "ds-inset" },
                  h("h3", { class: "ds-subheading" }, t("rest.rollBreakdown")),
                  h(
                    "ul",
                    { class: "ds-list-plain ds-stack-sm", role: "list" },
                    diceRolls.map((roll, idx) => {
                      const gain = Math.max(1, roll + conMod);
                      const isFloored = roll + conMod < 1;
                      return h(
                        "li",
                        { key: idx, class: "ds-row" },
                        h("span", null, t("rest.rollLine", { index: idx + 1, die: hitDieSize, roll, mod: formatModifier(conMod) })),
                        h("strong", { class: "atlas-tabular-nums" }, isFloored ? t("rest.rollGainFloored", { value: gain }) : t("hp.gain", { value: gain }))
                      );
                    })
                  ),
                  h(
                    "div",
                    { class: "ds-row ds-value" },
                    h("span", null, t("rest.hpPreview")),
                    h("span", { class: "atlas-tabular-nums" }, t("rest.hpTransition", { from: currentHp, to: projectedShortRestHp, max: maxHp, gain: actualShortRestGain }))
                  ),
                  h(
                    "div",
                    { class: "ds-row ds-meta" },
                    h("span", null, t("rest.hitDiceRemaining")),
                    h("span", { class: "atlas-tabular-nums" }, `${currentHitDice - spentDice} / ${maxHitDice}`)
                  )
                ),

              // Error Displays
              rollError && h("p", { key: "roll-error", role: "alert", class: "ds-field-error" }, rollError),
              saveError && h("p", { key: "save-error", role: "alert", class: "ds-field-error" }, saveError),

              // SHORT_REST Resources Preview
              h(
                "div",
                { key: "resources", class: "ds-inset" },
                h("h3", { class: "ds-subheading" }, t("rest.short.resourcesTitle")),
                shortRestResourceList.length === 0 && !pactSlots && h("p", { class: "ds-hint" }, t("rest.short.noResources")),
                shortRestResourceList.map(([key, res]) => resourceRow(key, key.replace(/_/g, " "), formatRefill(res.current, res.max))),
                pactSlots && resourceRow("pact", t("rest.pactMagic"), formatRefill(pactSlots.current, pactSlots.max))
              ),
            ]
          : [
              // Long Rest Recovery Read-Only Summary
              h(
                "div",
                { key: "effects", class: "ds-inset" },
                h("h3", { class: "ds-subheading" }, t("rest.long.effectsTitle")),
                h(
                  "ul",
                  { class: "ds-list-plain ds-stack-sm", role: "list" },
                  h(
                    "li",
                    { class: "ds-row" },
                    h("span", null, t("rest.long.hpRestore")),
                    h("strong", { class: "atlas-tabular-nums" }, t("rest.hpTransition", { from: currentHp, to: maxHp, max: maxHp, gain: maxHp - currentHp }))
                  ),
                  h("li", { class: "ds-row" }, h("span", null, t("rest.long.tempReset")), h("strong", { class: "atlas-tabular-nums" }, `${tempHp} → 0`)),
                  h(
                    "li",
                    { class: "ds-row" },
                    h("span", null, t("rest.long.hitDiceRecovery", { max: maxHitDice })),
                    h(
                      "strong",
                      { class: "atlas-tabular-nums" },
                      t("rest.long.hitDiceRecoveryValue", { count: projectedLongRestHitDice - currentHitDice, from: currentHitDice, to: projectedLongRestHitDice, max: maxHitDice })
                    )
                  ),
                  h(
                    "li",
                    { class: "ds-row" },
                    h("span", null, t("rest.long.exhaustion")),
                    h(
                      "strong",
                      null,
                      currentExhaustion > 0
                        ? t("rest.long.exhaustionValue", { from: currentExhaustion, to: projectedLongRestExhaustion })
                        : t("rest.long.noExhaustion")
                    )
                  ),
                  (actor.attributes.deathSaves?.successes > 0 || actor.attributes.deathSaves?.failures > 0) &&
                    h("li", { class: "ds-row" }, h("span", null, t("rest.long.deathSaves")), h("strong", null, t("rest.long.deathSavesReset")))
                )
              ),

              // Long Rest Spell Slots Breakdown
              h(
                "div",
                { key: "slots", class: "ds-inset" },
                h("h3", { class: "ds-subheading" }, t("rest.long.slotsTitle")),
                activeSpellSlots.length === 0
                  ? h("p", { class: "ds-hint" }, t("rest.long.noSlots"))
                  : h(
                      "div",
                      { class: "ds-grid-2" },
                      activeSpellSlots.map(({ tier, slot }) =>
                        resourceRow(
                          tier,
                          tier === "pact" ? t("rest.slot.pact") : t("rest.slot.level", { level: tier.replace("level", "") }),
                          formatRefill(slot.current, slot.max)
                        )
                      )
                    )
              ),

              // Long Rest Resources Breakdown
              h(
                "div",
                { key: "long-resources", class: "ds-inset" },
                h("h3", { class: "ds-subheading" }, t("rest.long.resourcesTitle")),
                longRestResourceList.length === 0
                  ? h("p", { class: "ds-hint" }, t("rest.long.noResources"))
                  : longRestResourceList.map(([key, res]) => resourceRow(key, key.replace(/_/g, " "), formatRefill(res.current, res.max)))
              ),

              // Error Displays
              saveError && h("p", { key: "save-error", role: "alert", class: "ds-field-error" }, saveError),
            ]
      ),

      // Modal Footer
      h(
        "footer",
        { class: "ds-modal-footer" },
        h(
          "button",
          { type: "button", class: "ds-btn ds-btn-ghost", onClick: handleClose, "aria-disabled": ariaDisabled(isSubmitting) },
          t("action.cancel")
        ),
        isShort
          ? h(
              "button",
              {
                key: "confirm-short",
                type: "button",
                class: "ds-btn ds-btn-primary",
                onClick: handleConfirmShortRest,
                "aria-disabled": ariaDisabled(busy || rollsMissing),
                "aria-busy": isSubmitting ? "true" : undefined,
              },
              isSubmitting ? t("action.applying") : t("rest.short.confirm")
            )
          : h(
              "button",
              {
                key: "confirm-long",
                type: "button",
                class: "ds-btn ds-btn-primary",
                onClick: handleConfirmLongRest,
                "aria-disabled": ariaDisabled(isSubmitting),
                "aria-busy": isSubmitting ? "true" : undefined,
              },
              isSubmitting ? t("action.applying") : t("rest.long.confirm")
            )
      )
    )
  );
}
