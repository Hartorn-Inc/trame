import { TrameCommand } from "../sheet/types.ts";
import type {
  CommandDispatcher,
  CompendiumDragDropManagerOptions,
  CompendiumDragPayload,
  DropOptions,
  InventoryContainerItem,
  MoveItemOptions,
} from "./types.ts";

const ALLOWED_COMPENDIUM_TYPES = new Set([
  "item",
  "items",
  "spell",
  "spells",
  "feat",
  "feats",
  "feature",
  "features",
  "action",
  "actions",
  "equipment",
  "weapon",
  "armor",
  "consumable",
  "tool",
  "loot",
  "compendium",
  "compendium_entry",
]);

function checkIsDescendant(
  sourceItemId: string,
  targetContainerId: string,
  items?: InventoryContainerItem[],
): boolean {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return false;
  }

  const itemMap = new Map<string, InventoryContainerItem>();
  const indexTree = (list: InventoryContainerItem[]): void => {
    for (const item of list) {
      if (item && item.id) {
        const idStr = String(item.id);
        if (!itemMap.has(idStr)) {
          itemMap.set(idStr, item);
          if (Array.isArray(item.children)) {
            indexTree(item.children);
          }
          if (Array.isArray(item.items)) {
            indexTree(item.items);
          }
        }
      }
    }
  };
  indexTree(items);

  let currentId: string | null = targetContainerId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const currentItem = itemMap.get(currentId);
    if (!currentItem) {
      break;
    }
    const parentId = currentItem.containerId ?? currentItem.parentId ?? null;
    if (parentId === sourceItemId) {
      return true;
    }
    currentId = parentId;
  }

  const sourceItem = itemMap.get(sourceItemId);
  if (sourceItem) {
    const queue: InventoryContainerItem[] = [
      ...(Array.isArray(sourceItem.children) ? sourceItem.children : []),
      ...(Array.isArray(sourceItem.items) ? sourceItem.items : []),
    ];
    const treeVisited = new Set<string>();

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;
      const nodeId = String(node.id ?? "");
      if (nodeId === targetContainerId) {
        return true;
      }
      if (nodeId && !treeVisited.has(nodeId)) {
        treeVisited.add(nodeId);
        if (Array.isArray(node.children)) {
          queue.push(...node.children);
        }
        if (Array.isArray(node.items)) {
          queue.push(...node.items);
        }
      }
    }
  }

  return false;
}

/**
 * Manages drag-and-drop validation and CQRS command dispatching for compendium entities
 * and nested inventory container hierarchies.
 */
export class CompendiumDragDropManager {
  private activeSystemId: string;
  private dispatchCommand?: CommandDispatcher;
  private actorId?: string;
  private items?: InventoryContainerItem[];

  public constructor(
    configOrSystemId: CompendiumDragDropManagerOptions | string,
    dispatchCommand?: CommandDispatcher,
    actorId?: string,
    items?: InventoryContainerItem[],
  ) {
    if (typeof configOrSystemId === "string") {
      this.activeSystemId = configOrSystemId;
      this.dispatchCommand = dispatchCommand;
      this.actorId = actorId;
      this.items = items;
    } else {
      this.activeSystemId = configOrSystemId.systemId;
      this.dispatchCommand = configOrSystemId.dispatchCommand;
      this.actorId = configOrSystemId.actorId;
      this.items = configOrSystemId.items;
    }
  }

  public get systemId(): string {
    return this.activeSystemId;
  }

  public set systemId(systemId: string) {
    this.activeSystemId = systemId;
  }

  public getSystemId(): string {
    return this.activeSystemId;
  }

  public setSystemId(systemId: string): void {
    this.activeSystemId = systemId;
  }

  public setItems(items: InventoryContainerItem[]): void {
    this.items = items;
  }

  public getItems(): InventoryContainerItem[] | undefined {
    return this.items;
  }

  public setActorId(actorId: string): void {
    this.actorId = actorId;
  }

  public getActorId(): string | undefined {
    return this.actorId;
  }

  /**
   * Enforces container hierarchy rules and rejects moves where a container
   * is dropped into itself or any of its descendant containers.
   */
  public static validateMove(
    sourceItemIdOrOptions: string | MoveItemOptions,
    targetContainerId?: string | null,
    items?: InventoryContainerItem[],
  ): boolean {
    let sourceItemId: string;
    let targetId: string | null;
    let resolvedItems: InventoryContainerItem[] | undefined;

    if (typeof sourceItemIdOrOptions === "object" && sourceItemIdOrOptions !== null) {
      sourceItemId = String(sourceItemIdOrOptions.sourceItemId ?? "");
      targetId = sourceItemIdOrOptions.targetContainerId ?? null;
      resolvedItems = sourceItemIdOrOptions.items;
    } else {
      sourceItemId = String(sourceItemIdOrOptions ?? "");
      targetId = targetContainerId !== undefined ? targetContainerId : null;
      resolvedItems = items;
    }

    if (!sourceItemId) {
      return false;
    }

    if (targetId === null) {
      return true;
    }

    if (targetId === sourceItemId) {
      return false;
    }

    if (checkIsDescendant(sourceItemId, targetId, resolvedItems)) {
      return false;
    }

    return true;
  }

  public validateMove(
    sourceItemIdOrOptions: string | MoveItemOptions,
    targetContainerId?: string | null,
    items?: InventoryContainerItem[],
  ): boolean {
    if (typeof sourceItemIdOrOptions === "object" && sourceItemIdOrOptions !== null) {
      const resolvedItems = sourceItemIdOrOptions.items ?? this.items;
      return CompendiumDragDropManager.validateMove({
        ...sourceItemIdOrOptions,
        items: resolvedItems,
      });
    }
    const resolvedItems = items ?? this.items;
    return CompendiumDragDropManager.validateMove(
      sourceItemIdOrOptions,
      targetContainerId,
      resolvedItems,
    );
  }

  /**
   * Validates compendium transfer payloads against the expected systemId
   * and allowed compendium entry types.
   */
  public static validateAttunement(items?: InventoryContainerItem[]): {
    allowed: boolean;
    warning?: string;
  } {
    const attunedCount = (items ?? []).filter((i) => Boolean(i?.isAttuned)).length;
    if (attunedCount >= 3) {
      return {
        allowed: false,
        warning: "Character has reached the maximum of 3 attuned items.",
      };
    }
    return { allowed: true };
  }

  public validateAttunement(items?: InventoryContainerItem[]): {
    allowed: boolean;
    warning?: string;
  } {
    return CompendiumDragDropManager.validateAttunement(items ?? this.items);
  }

  public static validatePayload(
    payload: unknown,
    expectedSystemId: string,
  ): boolean {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const rec = payload as Record<string, unknown>;
    const systemId = typeof rec.systemId === "string" ? rec.systemId.trim() : "";
    if (!systemId || systemId !== expectedSystemId) {
      return false;
    }

    const entryRef = rec.entryRef ?? rec.ref ?? rec.id;
    if (!entryRef || typeof entryRef !== "string" || entryRef.trim() === "") {
      return false;
    }

    const rawType = rec.entryType ?? rec.kind ?? rec.type;
    if (rawType !== undefined && typeof rawType === "string") {
      const normalized = rawType.toLowerCase().trim();
      if (!ALLOWED_COMPENDIUM_TYPES.has(normalized)) {
        return false;
      }
    }

    return true;
  }

  public validatePayload(payload: unknown): boolean {
    return CompendiumDragDropManager.validatePayload(
      payload,
      this.activeSystemId,
    );
  }

  /**
   * Handles dropping compendium entities or internal item moves onto an actor sheet.
   * Dispatches TrameCommand.DropCompendiumEntry when valid, or rejects mismatched payloads with zero commands.
   */
  public handleDrop(
    payloadOrOptions: unknown,
    targetContainerId?: string | null | DropOptions,
    actorId?: string,
  ): boolean {
    let payload: CompendiumDragPayload;
    let targetId: string | null = null;
    let targetActorId = this.actorId;
    let dispatcher = this.dispatchCommand;

    if (
      typeof payloadOrOptions === "object" &&
      payloadOrOptions !== null &&
      "payload" in payloadOrOptions
    ) {
      const opts = payloadOrOptions as {
        payload: unknown;
        targetContainerId?: string | null;
        actorId?: string;
        dispatchCommand?: CommandDispatcher;
      };
      payload = opts.payload as CompendiumDragPayload;
      targetId = opts.targetContainerId ?? null;
      targetActorId = opts.actorId ?? this.actorId;
      if (opts.dispatchCommand) {
        dispatcher = opts.dispatchCommand;
      }
    } else {
      payload = payloadOrOptions as CompendiumDragPayload;
      if (typeof targetContainerId === "string" || targetContainerId === null) {
        targetId = targetContainerId;
      } else if (
        typeof targetContainerId === "object" &&
        targetContainerId !== null
      ) {
        const opts = targetContainerId as DropOptions;
        targetId = opts.targetContainerId ?? null;
        targetActorId = opts.actorId ?? this.actorId;
        if (opts.dispatchCommand) {
          dispatcher = opts.dispatchCommand;
        }
      }
      if (typeof actorId === "string") {
        targetActorId = actorId;
      }
    }

    if (!payload || typeof payload !== "object") {
      return false;
    }

    if (payload.type === "item_move" || payload.sourceItemId) {
      const sourceItemId = String(payload.sourceItemId ?? payload.id ?? "");
      return this.moveItem(
        sourceItemId,
        targetId ?? payload.targetContainerId ?? null,
      );
    }

    if (!this.validatePayload(payload)) {
      return false;
    }

    const entryRef = String(payload.entryRef ?? payload.ref ?? payload.id ?? "");
    const resolvedTargetContainerId =
      targetId !== undefined && targetId !== null
        ? targetId
        : (payload.targetContainerId ?? null);
    const resolvedActorId = targetActorId ?? payload.actorId ?? "";

    const command = TrameCommand.DropCompendiumEntry({
      actorId: resolvedActorId,
      entryRef,
      targetContainerId: resolvedTargetContainerId,
      entryType: payload.entryType ?? payload.kind ?? payload.type,
      data: payload.data,
    });

    if (dispatcher) {
      dispatcher(command);
    }

    return true;
  }

  public drop(
    payloadOrOptions: unknown,
    targetContainerId?: string | null | DropOptions,
    actorId?: string,
  ): boolean {
    return this.handleDrop(payloadOrOptions, targetContainerId, actorId);
  }

  /**
   * Moves items between containers, validating acyclic hierarchy and dispatching TrameCommand.UpdateActorSheet.
   */
  public moveItem(
    sourceItemId: string,
    targetContainerId: string | null,
    items?: InventoryContainerItem[],
  ): boolean {
    const resolvedItems = items ?? this.items;

    if (!this.validateMove(sourceItemId, targetContainerId, resolvedItems)) {
      return false;
    }

    const command = TrameCommand.UpdateActorSheet({
      path: `items.${sourceItemId}.containerId`,
      itemId: sourceItemId,
      containerId: targetContainerId,
      targetContainerId,
      value: targetContainerId,
      actorId: this.actorId,
    });

    if (this.dispatchCommand) {
      this.dispatchCommand(command);
    }

    if (this.items && Array.isArray(this.items)) {
      const item = this.items.find((i) => i.id === sourceItemId);
      if (item) {
        item.containerId = targetContainerId;
      }
    }

    return true;
  }

  public handleMoveItem(
    sourceItemId: string,
    targetContainerId: string | null,
    items?: InventoryContainerItem[],
  ): boolean {
    return this.moveItem(sourceItemId, targetContainerId, items);
  }

  public static handleDrop(
    payload: unknown,
    options: {
      systemId: string;
      dispatchCommand?: CommandDispatcher;
      actorId?: string;
      targetContainerId?: string | null;
      items?: InventoryContainerItem[];
    },
  ): boolean {
    const manager = new CompendiumDragDropManager({
      systemId: options.systemId,
      dispatchCommand: options.dispatchCommand,
      actorId: options.actorId,
      items: options.items,
    });
    return manager.handleDrop(
      payload,
      options.targetContainerId,
      options.actorId,
    );
  }

  public static moveItem(
    sourceItemId: string,
    targetContainerId: string | null,
    options: MoveItemOptions,
  ): boolean {
    const manager = new CompendiumDragDropManager({
      systemId: "",
      dispatchCommand: options.dispatchCommand,
      actorId: options.actorId,
      items: options.items,
    });
    return manager.moveItem(sourceItemId, targetContainerId, options.items);
  }

  public createDragData(payload: CompendiumDragPayload): string {
    return JSON.stringify(payload);
  }

  public parseDragEvent(
    event: { dataTransfer?: { getData: (format: string) => string } | null },
  ): CompendiumDragPayload | null {
    if (!event || !event.dataTransfer) {
      return null;
    }
    const raw =
      event.dataTransfer.getData("application/json") ||
      event.dataTransfer.getData("text/plain");
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as CompendiumDragPayload;
    } catch {
      return null;
    }
  }

  public handleDragOver(event: { preventDefault?: () => void }): void {
    event?.preventDefault?.();
  }
}
