export type LayoutNodeKind = "section" | "column" | "row" | "tabs" | "widget";

export type VisibilityTier = "PUBLIC" | "OWNER_ONLY" | "GM_ONLY";

export interface BaseLayoutNode {
  id: string;
  kind: LayoutNodeKind;
  visibilityTier?: VisibilityTier;
  cssClass?: string;
}

export interface ContainerLayoutNode extends BaseLayoutNode {
  kind: "section" | "column" | "row";
  title?: string;
  children: SheetLayoutNode[];
}

export interface TabItem {
  id: string;
  label: string;
  icon?: string;
  visibilityTier?: VisibilityTier;
  children: SheetLayoutNode[];
}

export interface TabsLayoutNode extends BaseLayoutNode {
  kind: "tabs";
  defaultTabId: string;
  tabs: TabItem[];
}

export interface WidgetLayoutNode extends BaseLayoutNode {
  kind: "widget";
  widgetType: string;
  bindings: Record<string, string>;
  options?: Record<string, unknown>;
}

export type SheetLayoutNode = ContainerLayoutNode | TabsLayoutNode | WidgetLayoutNode;

export interface SheetLayoutTree {
  systemId: string;
  version: string;
  root: SheetLayoutNode | null;
}

export interface ViewerContext {
  isGm?: boolean;
  isOwner?: boolean;
  role?: string;
  userId?: string;
  actorOwnerId?: string;
  padlockUnlocked?: boolean;
  [key: string]: unknown;
}

export type CommandDispatcher = (command: unknown) => void;

export class DuplicateNodeIdError extends Error {
  public duplicateId: string;

  constructor(duplicateId: string) {
    super(`Duplicate layout node identifier detected: ${duplicateId}`);
    this.name = "DuplicateNodeIdError";
    this.duplicateId = duplicateId;
  }
}

export interface RenderedLayoutNode {
  id: string;
  kind: LayoutNodeKind;
  title?: string;
  visibilityTier?: VisibilityTier;
  cssClass?: string;
  children?: RenderedLayoutNode[];
  tabs?: Array<{
    id: string;
    label: string;
    icon?: string;
    visibilityTier?: VisibilityTier;
    children: RenderedLayoutNode[];
  }>;
  defaultTabId?: string;
  widgetType?: string;
  boundValues?: Record<string, unknown>;
  options?: Record<string, unknown>;
  renderedOutput?: unknown;
}

export interface PadlockEditModeState {
  testId: string;
  unlocked: boolean;
  ariaPressed: "true" | "false";
  iconName: "PadlockUnlockedIcon" | "PadlockLockedIcon";
  cssClass: string;
}

export interface RenderedSheetTree {
  systemId: string;
  version: string;
  root: RenderedLayoutNode | null;
  padlockEditMode?: PadlockEditModeState;
}
