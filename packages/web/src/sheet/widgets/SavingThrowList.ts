import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface SavingThrowItem {
  key: string;
  modifier: number;
  proficient: boolean;
}

export interface SavingThrowListOutput {
  id: string;
  saves: SavingThrowItem[];
  clickSave: (abilityKey: string) => void;
  triggerSaveClick: (abilityKey: string) => void;
}

export function SavingThrowList(context: WidgetRenderContext): SavingThrowListOutput {
  const rawSaves = (context.boundValues.saves as Record<string, unknown>) ?? {};
  const saves: SavingThrowItem[] = Object.entries(rawSaves).map(([key, val]) => {
    let modifier = 0;
    let proficient = false;
    if (typeof val === "number") {
      modifier = val;
    } else if (val && typeof val === "object") {
      const rec = val as Record<string, unknown>;
      modifier = typeof rec.modifier === "number" ? rec.modifier : Number(rec.mod ?? 0);
      proficient = Boolean(rec.proficient);
    }
    return { key, modifier, proficient };
  });

  const handleClick = (abilityKey: string) => {
    const save = saves.find((s) => s.key === abilityKey);
    const mod = save ? save.modifier : 0;
    const formula = mod >= 0 ? `1d20 + ${mod}` : `1d20 - ${Math.abs(mod)}`;
    const expression = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        ability: abilityKey,
        modifier: mod,
        visibility: "PUBLIC",
        reason: `Saving throw: ${abilityKey}`,
      }),
    );
  };

  return {
    id: context.id,
    saves,
    clickSave: handleClick,
    triggerSaveClick: handleClick,
  };
}
