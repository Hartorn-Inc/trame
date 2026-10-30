import type { ContainerWeightOptions, InventoryContainerItem } from "./types.ts";

function sanitizeNumber(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

/**
 * Calculates total container weight recursively by summing child unit weights
 * multiplied by quantities, applying container weight multipliers such that
 * containers with weightMultiplier 0.0 contribute zero content weight to outer containers.
 *
 * Direct child items are evaluated and the sum is rounded to two decimal places.
 */
export function calculateContainerWeight(
  containerOrId: InventoryContainerItem | string,
  items?: InventoryContainerItem[],
  options?: ContainerWeightOptions,
  visited: Set<string> = new Set<string>(),
): number {
  const containerId =
    typeof containerOrId === "string" ? containerOrId : containerOrId.id;

  if (!containerId || visited.has(containerId)) {
    return 0;
  }
  visited.add(containerId);

  const containerObj =
    typeof containerOrId === "object" && containerOrId !== null
      ? containerOrId
      : items?.find((it) => it.id === containerId);

  let children: InventoryContainerItem[] = [];

  if (Array.isArray(items)) {
    children = items.filter(
      (it) =>
        (it.containerId === containerId || it.parentId === containerId) &&
        it.id !== containerId,
    );
  } else if (containerObj) {
    if (Array.isArray(containerObj.children)) {
      children = containerObj.children;
    } else if (Array.isArray(containerObj.items)) {
      children = containerObj.items;
    }
  }

  let childWeightsSum = 0;

  for (const child of children) {
    const qty = Math.max(0, sanitizeNumber(child.quantity ?? child.qty, 1));
    const unitWeight = Math.max(
      0,
      sanitizeNumber(child.unitWeight ?? child.weight, 0),
    );
    const isContainer = Boolean(
      child.isContainer ||
        child.weightMultiplier !== undefined ||
        (Array.isArray(child.children) && child.children.length > 0) ||
        (Array.isArray(child.items) && child.items.length > 0),
    );

    if (isContainer) {
      const childTareWeight = unitWeight * qty;
      const innerContentWeight = calculateContainerWeight(
        child,
        items,
        { includeSelf: false },
        new Set(visited),
      );
      const rawMultiplier =
        child.weightMultiplier !== undefined
          ? sanitizeNumber(child.weightMultiplier, 1.0)
          : 1.0;
      const multiplier = Math.max(0, rawMultiplier);
      const childEffectiveWeight =
        childTareWeight + innerContentWeight * multiplier;
      childWeightsSum += childEffectiveWeight;
    } else {
      childWeightsSum += unitWeight * qty;
    }
  }

  if (options?.includeSelf && containerObj) {
    const selfQty = Math.max(
      0,
      sanitizeNumber(containerObj.quantity ?? containerObj.qty, 1),
    );
    const selfUnitWeight = Math.max(
      0,
      sanitizeNumber(containerObj.unitWeight ?? containerObj.weight, 0),
    );
    childWeightsSum += selfUnitWeight * selfQty;
  }

  if (options?.applyMultiplier && containerObj?.weightMultiplier !== undefined) {
    const selfMultiplier = Math.max(
      0,
      sanitizeNumber(containerObj.weightMultiplier, 1.0),
    );
    childWeightsSum *= selfMultiplier;
  }

  return Math.round((childWeightsSum + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates the total weight of an actor's uncontained inventory and nested containers.
 */
export function calculateTotalInventoryWeight(
  items: InventoryContainerItem[],
): number {
  if (!Array.isArray(items) || items.length === 0) {
    return 0;
  }

  let total = 0;
  const rootItems = items.filter(
    (it) => it.containerId === null || it.containerId === undefined,
  );

  for (const item of rootItems) {
    const qty = Math.max(0, sanitizeNumber(item.quantity ?? item.qty, 1));
    const unitWeight = Math.max(
      0,
      sanitizeNumber(item.unitWeight ?? item.weight, 0),
    );
    const isContainer = Boolean(
      item.isContainer ||
        item.weightMultiplier !== undefined ||
        (Array.isArray(item.children) && item.children.length > 0),
    );

    if (isContainer) {
      const contentWeight = calculateContainerWeight(item, items, {
        includeSelf: false,
      });
      const multiplier =
        item.weightMultiplier !== undefined
          ? Math.max(0, sanitizeNumber(item.weightMultiplier, 1.0))
          : 1.0;
      total += unitWeight * qty + contentWeight * multiplier;
    } else {
      total += unitWeight * qty;
    }
  }

  return Math.round((total + Number.EPSILON) * 100) / 100;
}

export class ContainerWeightCalculator {
  public static calculate(
    containerOrId: InventoryContainerItem | string,
    items?: InventoryContainerItem[],
    options?: ContainerWeightOptions,
  ): number {
    return calculateContainerWeight(containerOrId, items, options);
  }

  public static calculateContainerWeight(
    containerOrId: InventoryContainerItem | string,
    items?: InventoryContainerItem[],
    options?: ContainerWeightOptions,
  ):
    number {
    return calculateContainerWeight(containerOrId, items, options);
  }

  public static calculateTotalInventoryWeight(
    items: InventoryContainerItem[],
  ): number {
    return calculateTotalInventoryWeight(items);
  }
}
