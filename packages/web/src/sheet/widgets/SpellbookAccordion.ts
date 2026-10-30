import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface SpellItem {
  id: string;
  name: string;
  level: number;
  school?: string;
  range?: string;
  castingTime?: string;
  requiresAoE?: boolean;
  isAoE?: boolean;
  aoeShape?: unknown;
}

export interface SpellSlotCounter {
  current: number;
  max: number;
}

export interface SpellbookAccordionOptions {
  autoDeductSlots?: boolean;
  [key: string]: unknown;
}

export interface SpellbookAccordionOutput {
  id: string;
  slots: Record<string, SpellSlotCounter>;
  spells: SpellItem[];
  spellSaveDc: number;
  spellAttackBonus: number;
  autoDeductSlots: boolean;
  castSpell: (spellId: string) => void;
  clickCast: (spellId: string) => void;
  toggleSlotPip: (slotLevel: number | string) => void;
}

export function SpellbookAccordion(
  context: WidgetRenderContext<SpellbookAccordionOptions>,
): SpellbookAccordionOutput {
  const autoDeductSlots = context.options?.autoDeductSlots !== false;
  const rawSlots = (context.boundValues.slots as Record<string, unknown>) ?? {};
  const slots: Record<string, SpellSlotCounter> = {};

  for (const [key, val] of Object.entries(rawSlots)) {
    if (typeof val === "number") {
      slots[key] = { current: val, max: val };
    } else if (val && typeof val === "object") {
      const rec = val as Record<string, unknown>;
      slots[key] = {
        current: Number(rec.current ?? 0),
        max: Number(rec.max ?? 0),
      };
    }
  }

  const rawSpells = Array.isArray(context.boundValues.spells) ? context.boundValues.spells : [];
  const spells: SpellItem[] = rawSpells.map((s: any) => ({
    id: String(s.id ?? ""),
    name: String(s.name ?? "Spell"),
    level: Number(s.level ?? 0),
    school: s.school ? String(s.school) : undefined,
    range: s.range ? String(s.range) : undefined,
    castingTime: s.castingTime ? String(s.castingTime) : undefined,
    requiresAoE: Boolean(s.requiresAoE || s.isAoE),
    isAoE: Boolean(s.isAoE || s.requiresAoE),
    aoeShape: s.aoeShape,
  }));

  const spellSaveDc = Number(context.boundValues.spellSaveDc ?? 10);
  const spellAttackBonus = Number(context.boundValues.spellAttackBonus ?? 0);

  const resolveSlotKey = (slotsRecord: Record<string, unknown>, slotLevel: number | string): string => {
    if (typeof slotLevel === "string" && slotsRecord[slotLevel] !== undefined) {
      return slotLevel;
    }
    const cleanLvl = typeof slotLevel === "number" ? slotLevel : String(slotLevel).replace(/^(level_?|slot_?)/i, "");
    const candidates = [
      `level${cleanLvl}`,
      `level_${cleanLvl}`,
      `slot_${cleanLvl}`,
      `slot${cleanLvl}`,
      String(cleanLvl),
    ];
    for (const cand of candidates) {
      if (slotsRecord[cand] !== undefined) {
        return cand;
      }
    }
    return `level${cleanLvl}`;
  };

  const handleCast = (spellId: string) => {
    const spell = spells.find((s) => s.id === spellId) ?? spells[0];
    if (!spell) return;

    const isAoE = Boolean(spell.requiresAoE || spell.isAoE || spell.aoeShape);
    if (isAoE) {
      context.dispatchCommand?.(
        TrameCommand.ProjectAoE({
          spellId: spell.id,
          name: spell.name,
          level: spell.level,
          aoeShape: spell.aoeShape ?? { type: "sphere", radiusFt: 20 },
          template: spell.aoeShape ?? { type: "sphere", radiusFt: 20 },
        }),
      );
    } else {
      context.dispatchCommand?.(
        TrameCommand.RollDice({
          formula: "1d20",
          expression: "1d20",
          spellId: spell.id,
          name: spell.name,
          visibility: "PUBLIC",
          reason: `Cast spell: ${spell.name}`,
        }),
      );
    }

    if (autoDeductSlots && spell.level > 0) {
      const chosenKey = resolveSlotKey(rawSlots, spell.level);
      const currentVal = slots[chosenKey]?.current ?? 1;
      const updatedCount = Math.max(0, currentVal - 1);
      context.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: `slots.${chosenKey}.current`,
          slotLevel: spell.level,
          current: updatedCount,
          value: updatedCount,
          delta: -1,
        }),
      );
    }
  };

  const toggleSlotPip = (slotLevel: number | string) => {
    const chosenKey = resolveSlotKey(slots, slotLevel);
    const slot = slots[chosenKey];
    const currentVal = slot ? slot.current : 0;
    const newVal = Math.max(0, currentVal - 1);
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `slots.${chosenKey}.current`,
        slotLevel,
        current: newVal,
        value: newVal,
      }),
    );
  };

  return {
    id: context.id,
    slots,
    spells,
    spellSaveDc,
    spellAttackBonus,
    autoDeductSlots,
    castSpell: handleCast,
    clickCast: handleCast,
    toggleSlotPip,
  };
}
