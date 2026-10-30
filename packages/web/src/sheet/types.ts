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

export type SheetLayoutNode =
  | ContainerLayoutNode
  | TabsLayoutNode
  | WidgetLayoutNode;

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
  actorOwnerId?: string | null;
}

export class DuplicateNodeIdError extends Error {
  public readonly duplicateId: string;

  constructor(duplicateId: string) {
    super(`Duplicate layout node identifier detected: "${duplicateId}"`);
    this.name = "DuplicateNodeIdError";
    this.duplicateId = duplicateId;
    Object.setPrototypeOf(this, DuplicateNodeIdError.prototype);
  }
}

export const CANONICAL_WIDGET_TYPES = [
  "StatBlock6",
  "ResourceBar",
  "SavingThrowList",
  "SkillCheckList",
  "ArmorInitiativeSpeed",
  "HitDiceAndDeathSaves",
  "AttackActionTable",
  "SpellbookAccordion",
  "InventoryContainerTree",
  "FeatureTraitList",
  "ConditionBadgeStrip",
  "NotesMarkdownPane",
] as const;

export type CanonicalWidgetType = (typeof CANONICAL_WIDGET_TYPES)[number];

export type CommandDispatcher = (command: unknown) => void;

export interface RenderedWidgetNode {
  id: string;
  kind: "widget";
  widgetType: string;
  boundValues: Record<string, unknown>;
  options: Record<string, unknown>;
  visibilityTier?: VisibilityTier;
  cssClass?: string;
  renderedOutput?: unknown;
}

export interface RenderedContainerNode {
  id: string;
  kind: "section" | "column" | "row";
  title?: string;
  visibilityTier?: VisibilityTier;
  cssClass?: string;
  children: RenderedLayoutNode[];
}

export interface RenderedTabItem {
  id: string;
  label: string;
  icon?: string;
  visibilityTier?: VisibilityTier;
  children: RenderedLayoutNode[];
}

export interface RenderedTabsNode {
  id: string;
  kind: "tabs";
  defaultTabId: string;
  visibilityTier?: VisibilityTier;
  cssClass?: string;
  tabs: RenderedTabItem[];
}

export type RenderedLayoutNode =
  | RenderedContainerNode
  | RenderedTabsNode
  | RenderedWidgetNode;

export interface RenderedSheetTree {
  systemId: string;
  version: string;
  root: RenderedLayoutNode | null;
}
