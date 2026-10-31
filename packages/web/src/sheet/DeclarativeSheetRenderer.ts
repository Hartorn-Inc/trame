import { BindingResolver } from "./binding.ts";
import { WidgetRegistry } from "./WidgetRegistry.ts";
import {
  DuplicateNodeIdError,
  type CommandDispatcher,
  type RenderedLayoutNode,
  type RenderedSheetTree,
  type SheetLayoutNode,
  type SheetLayoutTree,
  type TabItem,
  type ViewerContext,
  type VisibilityTier,
} from "./types.ts";

function collectAndValidateNodeIds(node: SheetLayoutNode | null, seen: Set<string>): void {
  if (!node) {
    return;
  }

  if (seen.has(node.id)) {
    throw new DuplicateNodeIdError(node.id);
  }
  seen.add(node.id);

  if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        collectAndValidateNodeIds(child, seen);
      }
    }
  } else if (node.kind === "tabs") {
    if (Array.isArray(node.tabs)) {
      for (const tab of node.tabs) {
        if (seen.has(tab.id)) {
          throw new DuplicateNodeIdError(tab.id);
        }
        seen.add(tab.id);
        if (Array.isArray(tab.children)) {
          for (const child of tab.children) {
            collectAndValidateNodeIds(child, seen);
          }
        }
      }
    }
  }
}

export function isNodeAuthorized(
  visibilityTier: VisibilityTier | undefined,
  viewer?: ViewerContext,
): boolean {
  const tier = visibilityTier ?? "PUBLIC";
  if (tier === "PUBLIC") {
    return true;
  }

  if (!viewer) {
    return true;
  }

  const isGm = Boolean(
    viewer.isGm ||
      (typeof viewer.role === "string" && viewer.role.toUpperCase() === "GM"),
  );

  if (tier === "GM_ONLY") {
    return isGm;
  }

  if (tier === "OWNER_ONLY") {
    if (isGm) {
      return true;
    }
    if (viewer.isOwner) {
      return true;
    }
    if (viewer.userId && viewer.actorOwnerId && viewer.userId === viewer.actorOwnerId) {
      return true;
    }
    return false;
  }

  return true;
}

function filterNode(
  node: SheetLayoutNode,
  viewer?: ViewerContext,
): SheetLayoutNode | null {
  if (!isNodeAuthorized(node.visibilityTier, viewer)) {
    return null;
  }

  if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
    const filteredChildren: SheetLayoutNode[] = [];
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const filteredChild = filterNode(child, viewer);
        if (filteredChild !== null) {
          filteredChildren.push(filteredChild);
        }
      }
    }
    return {
      ...node,
      children: filteredChildren,
    };
  }

  if (node.kind === "tabs") {
    const filteredTabs: TabItem[] = [];
    if (Array.isArray(node.tabs)) {
      for (const tab of node.tabs) {
        if (!isNodeAuthorized(tab.visibilityTier, viewer)) {
          continue;
        }
        const filteredTabChildren: SheetLayoutNode[] = [];
        if (Array.isArray(tab.children)) {
          for (const child of tab.children) {
            const filteredChild = filterNode(child, viewer);
            if (filteredChild !== null) {
              filteredTabChildren.push(filteredChild);
            }
          }
        }
        filteredTabs.push({
          ...tab,
          children: filteredTabChildren,
        });
      }
    }
    return {
      ...node,
      tabs: filteredTabs,
    };
  }

  if (node.kind === "widget") {
    return {
      ...node,
      bindings: { ...node.bindings },
      options: node.options ? { ...node.options } : undefined,
    };
  }

  return null;
}

/**
 * Declarative character sheet renderer.
 * Parses SheetLayoutTree AST structures, validates node identity uniqueness,
 * filters unauthorized nodes based on VisibilityTier, and evaluates reactive bindings.
 */
export class DeclarativeSheetRenderer {
  public static parse(tree: SheetLayoutTree, viewer?: ViewerContext): SheetLayoutTree {
    if (!tree || typeof tree !== "object") {
      throw new Error("Invalid SheetLayoutTree: expected an object");
    }

    const seenIds = new Set<string>();
    if (tree.root) {
      collectAndValidateNodeIds(tree.root, seenIds);
    }

    const filteredRoot = tree.root ? filterNode(tree.root, viewer) : null;

    return {
      systemId: tree.systemId,
      version: tree.version,
      root: filteredRoot,
    };
  }

  public parse(tree: SheetLayoutTree, viewer?: ViewerContext): SheetLayoutTree {
    return DeclarativeSheetRenderer.parse(tree, viewer);
  }

  public static render(
    tree: SheetLayoutTree,
    actorState: unknown,
    viewer?: ViewerContext,
    dispatcher?: CommandDispatcher,
  ): RenderedSheetTree {
    const parsed = DeclarativeSheetRenderer.parse(tree, viewer);
    const renderedRoot = parsed.root
      ? DeclarativeSheetRenderer.renderNode(parsed.root, actorState, dispatcher)
      : null;

    return {
      systemId: parsed.systemId,
      version: parsed.version,
      root: renderedRoot,
    };
  }

  public static renderNode(
    node: SheetLayoutNode,
    actorState: unknown,
    dispatcher?: CommandDispatcher,
  ): RenderedLayoutNode {
    if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
      const renderedChildren = (node.children || []).map((child) =>
        DeclarativeSheetRenderer.renderNode(child, actorState, dispatcher),
      );
      return {
        id: node.id,
        kind: node.kind,
        title: node.title,
        visibilityTier: node.visibilityTier,
        cssClass: node.cssClass,
        children: renderedChildren,
      };
    }

    if (node.kind === "tabs") {
      const renderedTabs = (node.tabs || []).map((tab) => ({
        id: tab.id,
        label: tab.label,
        icon: tab.icon,
        visibilityTier: tab.visibilityTier,
        children: (tab.children || []).map((child) =>
          DeclarativeSheetRenderer.renderNode(child, actorState, dispatcher),
        ),
      }));
      return {
        id: node.id,
        kind: "tabs",
        defaultTabId: node.defaultTabId,
        visibilityTier: node.visibilityTier,
        cssClass: node.cssClass,
        tabs: renderedTabs,
      };
    }

    const widgetNode = node as import("./types.ts").WidgetLayoutNode;
    const boundValues = BindingResolver.resolveBindings(actorState, widgetNode.bindings || {});
    const options = (widgetNode.options as Record<string, unknown>) || {};

    const widgetImpl = WidgetRegistry.get(widgetNode.widgetType);
    let renderedOutput: unknown = undefined;

    if (typeof widgetImpl === "function") {
      renderedOutput = widgetImpl({
        id: widgetNode.id,
        boundValues,
        options,
        dispatchCommand: dispatcher,
      });
    } else if (
      widgetImpl &&
      typeof widgetImpl === "object" &&
      "render" in widgetImpl &&
      typeof (widgetImpl as { render: unknown }).render === "function"
    ) {
      renderedOutput = (widgetImpl as { render: Function }).render({
        id: widgetNode.id,
        boundValues,
        options,
        dispatchCommand: dispatcher,
      });
    }

    return {
      id: widgetNode.id,
      kind: "widget",
      widgetType: widgetNode.widgetType,
      boundValues,
      options,
      visibilityTier: widgetNode.visibilityTier,
      cssClass: widgetNode.cssClass,
      renderedOutput,
    };
  }

  public static findNodeById(
    target: SheetLayoutTree | SheetLayoutNode | null,
    id: string,
  ): SheetLayoutNode | null {
    if (!target) {
      return null;
    }
    const root = "root" in target ? target.root : target;
    if (!root) {
      return null;
    }
    if (root.id === id) {
      return root;
    }

    if (root.kind === "section" || root.kind === "column" || root.kind === "row") {
      for (const child of root.children || []) {
        const found = DeclarativeSheetRenderer.findNodeById(child, id);
        if (found) {
          return found;
        }
      }
    } else if (root.kind === "tabs") {
      for (const tab of root.tabs || []) {
        if (tab.id === id) {
          return null;
        }
        for (const child of tab.children || []) {
          const found = DeclarativeSheetRenderer.findNodeById(child, id);
          if (found) {
            return found;
          }
        }
      }
    }
    return null;
  }
}
