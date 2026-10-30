import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface ConditionBadgeItem {
  id: string;
  name: string;
  icon?: string;
}

export interface ConditionBadgeStripOutput {
  id: string;
  conditions: ConditionBadgeItem[];
  removeCondition: (conditionId: string) => void;
  clickRemoveBadge: (conditionId: string) => void;
}

export function ConditionBadgeStrip(context: WidgetRenderContext): ConditionBadgeStripOutput {
  const rawConditions = Array.isArray(context.boundValues.conditions)
    ? context.boundValues.conditions
    : [];

  const conditions: ConditionBadgeItem[] = rawConditions.map((c: any) => {
    if (typeof c === "string") {
      return { id: c, name: c };
    }
    return {
      id: String(c.id ?? ""),
      name: String(c.name ?? c.id ?? ""),
      icon: c.icon ? String(c.icon) : undefined,
    };
  });

  const handleRemove = (conditionId: string) => {
    const remaining = conditions.filter((c) => c.id !== conditionId);
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "conditions",
        removedConditionId: conditionId,
        conditionId,
        conditions: remaining.map((c) => c.id),
        value: remaining.map((c) => c.id),
      }),
    );
  };

  return {
    id: context.id,
    conditions,
    removeCondition: handleRemove,
    clickRemoveBadge: handleRemove,
  };
}
