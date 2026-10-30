import type {
  CommandDispatcher,
  DropCompendiumEntryCommand,
  UpdateActorSheetCommand,
} from "../sheet/types.ts";

export type CompendiumEntryType =
  | "item"
  | "spell"
  | "feat"
  | "feature"
  | "action"
  | "equipment"
  | "weapon"
  | "armor"
  | "consumable"
  | "tool"
  | "loot"
  | string;

export interface CompendiumDragPayload {
  systemId: string;
  entryRef: string;
  entryType?: CompendiumEntryType;
  type?: string;
  kind?: string;
  name?: string;
  data?: unknown;
  actorId?: string;
  targetContainerId?: string | null;
  [key: string]: unknown;
}

export interface InventoryContainerItem {
  id: string;
  name?: string;
  quantity?: number;
  qty?: number;
  unitWeight?: number;
  weight?: number;
  containerId?: string | null;
  parentId?: string | null;
  isContainer?: boolean;
  weightMultiplier?: number;
  capacity?: number;
  children?: InventoryContainerItem[];
  items?: InventoryContainerItem[];
  [key: string]: unknown;
}

export interface CompendiumDragDropManagerOptions {
  systemId: string;
  dispatchCommand?: CommandDispatcher;
  actorId?: string;
  items?: InventoryContainerItem[];
}

export interface DropOptions {
  actorId?: string;
  targetContainerId?: string | null;
  dispatchCommand?: CommandDispatcher;
}

export interface MoveItemOptions {
  sourceItemId: string;
  targetContainerId: string | null;
  items?: InventoryContainerItem[];
  actorId?: string;
  dispatchCommand?: CommandDispatcher;
}

export interface ContainerWeightOptions {
  includeSelf?: boolean;
  applyMultiplier?: boolean;
}

export type {
  DropCompendiumEntryCommand,
  UpdateActorSheetCommand,
  CommandDispatcher,
};
