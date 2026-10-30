import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface InventoryItemNode {
  id: string;
  name: string;
  quantity: number;
  unitWeight: number;
  containerId: string | null;
  isContainer?: boolean;
  weightMultiplier?: number;
}

export interface CurrencyMap {
  cp: number;
  sp: number;
  ep: number;
  gp: number;
  pp: number;
}

export interface InventoryContainerTreeOutput {
  id: string;
  items: InventoryItemNode[];
  currency: CurrencyMap;
  moveItem: (itemId: string, targetContainerId: string | null) => void;
  removeItem: (itemId: string) => void;
  deleteItem: (itemId: string) => void;
}

export function InventoryContainerTree(context: WidgetRenderContext): InventoryContainerTreeOutput {
  const rawItems = Array.isArray(context.boundValues.items) ? context.boundValues.items : [];
  const items: InventoryItemNode[] = rawItems.map((it: any) => ({
    id: String(it.id ?? ""),
    name: String(it.name ?? "Item"),
    quantity: Number(it.quantity ?? 1),
    unitWeight: Number(it.unitWeight ?? 0),
    containerId: it.containerId !== undefined ? it.containerId : null,
    isContainer: Boolean(it.isContainer),
    weightMultiplier: it.weightMultiplier !== undefined ? Number(it.weightMultiplier) : 1.0,
  }));

  const rawCurrency = (context.boundValues.currency as Record<string, unknown>) ?? {};
  const currency: CurrencyMap = {
    cp: Number(rawCurrency.cp ?? 0),
    sp: Number(rawCurrency.sp ?? 0),
    ep: Number(rawCurrency.ep ?? 0),
    gp: Number(rawCurrency.gp ?? 0),
    pp: Number(rawCurrency.pp ?? 0),
  };

  const moveItem = (itemId: string, targetContainerId: string | null) => {
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `items.${itemId}.containerId`,
        itemId,
        containerId: targetContainerId,
        targetContainerId,
        value: targetContainerId,
      }),
    );
  };

  const removeItem = (itemId: string) => {
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "items",
        itemId,
        removeItemId: itemId,
        action: "delete",
      }),
    );
  };

  return {
    id: context.id,
    items,
    currency,
    moveItem,
    removeItem,
    deleteItem: removeItem,
  };
}
