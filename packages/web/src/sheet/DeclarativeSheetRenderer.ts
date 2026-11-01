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
export interface DeclarativeSheetMountOptions {
  container?: any;
  sheetLayout?: SheetLayoutTree;
  actorState?: unknown;
  viewer?: ViewerContext;
  dispatchCommand?: CommandDispatcher;
  isLocked?: boolean;
  unlocked?: boolean;
}

export class DeclarativeSheetRenderer {
  public container: any;
  public sheetLayout?: SheetLayoutTree;
  public actorState: unknown;
  public viewer?: ViewerContext;
  public dispatchCommand?: CommandDispatcher;
  private padlockUnlocked: boolean;
  public rootElement: any = null;

  constructor(options?: DeclarativeSheetMountOptions | SheetLayoutTree) {
    if (options && typeof options === "object" && ("systemId" in options || "root" in options)) {
      this.sheetLayout = options as SheetLayoutTree;
      this.padlockUnlocked = false;
    } else {
      const opts = (options as DeclarativeSheetMountOptions) || {};
      this.container = opts.container;
      this.sheetLayout = opts.sheetLayout;
      this.actorState = opts.actorState;
      this.viewer = opts.viewer;
      this.dispatchCommand = opts.dispatchCommand;
      this.padlockUnlocked = Boolean(opts.unlocked ?? (opts.isLocked !== undefined ? !opts.isLocked : opts.viewer?.padlockUnlocked));
    }
  }

  public static mount(options: DeclarativeSheetMountOptions): DeclarativeSheetRenderer {
    const instance = new DeclarativeSheetRenderer(options);
    instance.mount();
    return instance;
  }

  public mount(targetContainer?: any): void {
    if (targetContainer) {
      this.container = targetContainer;
    }
    if (!this.container) {
      return;
    }

    this.renderToContainer();
  }

  public isLocked(): boolean {
    return !this.padlockUnlocked;
  }

  public setUnlocked(unlocked: boolean): void {
    this.padlockUnlocked = unlocked;
    this.renderToContainer();
  }

  public togglePadlock(): void {
    this.padlockUnlocked = !this.padlockUnlocked;
    this.renderToContainer();
  }

  private renderToContainer(): void {
    if (!this.container) return;
    this.container.children = [];

    const isUnlocked = this.padlockUnlocked;
    const isLocked = !isUnlocked;

    const rootEl = new (this.container.constructor)("div");
    rootEl.setAttribute("class", "ds-declarative-sheet-view ds-panel");
    rootEl.setAttribute("data-testid", "declarative-sheet-view");

    const header = new (this.container.constructor)("header");
    header.setAttribute("class", "ds-sheet-view-toolbar ds-sheet-header");

    const toggleBtn = new (this.container.constructor)("button");
    toggleBtn.setAttribute("type", "button");
    toggleBtn.setAttribute("data-testid", "sheet-padlock-toggle");
    toggleBtn.setAttribute("class", `ds-btn ds-btn-secondary ds-lock-toggle ${isUnlocked ? "is-unlocked" : "is-locked"}`);
    toggleBtn.setAttribute("aria-pressed", isUnlocked ? "true" : "false");
    toggleBtn.setAttribute("data-locked", isLocked ? "true" : "false");
    toggleBtn.setAttribute("aria-label", isLocked ? "Padlock locked — Play Mode" : "Padlock unlocked — Edit Mode");
    toggleBtn.textContent = isLocked ? "Locked (Play Mode)" : "Unlocked (Edit Mode)";
    toggleBtn.addEventListener("click", () => {
      this.togglePadlock();
      toggleBtn.setAttribute("aria-pressed", this.padlockUnlocked ? "true" : "false");
      toggleBtn.setAttribute("data-locked", this.padlockUnlocked ? "false" : "true");
    });
    header.appendChild(toggleBtn);
    rootEl.appendChild(header);

    if (this.sheetLayout) {
      const renderedTree = DeclarativeSheetRenderer.render(
        this.sheetLayout,
        this.actorState,
        { ...this.viewer, padlockUnlocked: isUnlocked },
        this.dispatchCommand,
      );
      this.renderAstToContainer(rootEl, renderedTree.root, isLocked);
    }

    this.rootElement = rootEl;
    this.container.appendChild(rootEl);
  }

  private renderAstToContainer(parentEl: any, node: any, isLocked: boolean): void {
    if (!node) return;
    const ElementCtor = this.container.constructor;

    if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
      const groupEl = new ElementCtor("div");
      groupEl.setAttribute("id", node.id);
      groupEl.setAttribute("class", `ds-layout-${node.kind} ${node.cssClass ?? ""}`.trim());
      if (node.title) {
        const titleEl = new ElementCtor("h3");
        titleEl.setAttribute("class", "ds-section-title");
        titleEl.textContent = node.title;
        groupEl.appendChild(titleEl);
      }
      for (const child of node.children || []) {
        this.renderAstToContainer(groupEl, child, isLocked);
      }
      parentEl.appendChild(groupEl);
      return;
    }

    if (node.kind === "widget") {
      const widgetEl = new ElementCtor("div");
      widgetEl.setAttribute("id", node.id);
      widgetEl.setAttribute("class", `ds-widget-container atlas-tabular-nums ${node.cssClass ?? ""}`.trim());
      this.renderWidgetDomFallback(widgetEl, node.widgetType, node.boundValues, isLocked);
      parentEl.appendChild(widgetEl);
    }
  }

  private renderWidgetDomFallback(widgetEl: any, widgetType: string, boundValues: Record<string, any>, isLocked: boolean): void {
    const ElementCtor = this.container.constructor;

    if (widgetType === "StatBlock6") {
      const abilities = boundValues?.abilities || {};
      const blockEl = new ElementCtor("div");
      blockEl.setAttribute("data-testid", "statblock-6-widget");
      blockEl.setAttribute("class", "ds-statblock-6 atlas-tabular-nums");
      for (const [key, val] of Object.entries(abilities)) {
        const score = typeof (val as any)?.score === "number" ? (val as any).score : Number(val || 10);
        const mod = typeof (val as any)?.modifier === "number" ? (val as any).modifier : Math.floor((score - 10) / 2);
        const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;

        const card = new ElementCtor("div");
        card.setAttribute("data-testid", `ability-card-${key}`);
        card.setAttribute("class", `ds-ability-card atlas-tabular-nums ${isLocked ? "is-rollable" : "is-editable"}`);
        if (isLocked) {
          card.setAttribute("role", "button");
          card.addEventListener("click", () => {
            this.dispatchCommand?.({
              cmd: "ROLL_DICE",
              expression: `1d20${modDisplay}`,
              ability: key,
              modifier: mod,
              visibility: "PUBLIC",
              reason: `Ability check: ${key}`,
            });
          });
        }

        const nameSpan = new ElementCtor("span");
        nameSpan.textContent = key.toUpperCase();
        card.appendChild(nameSpan);

        const modSpan = new ElementCtor("span");
        modSpan.setAttribute("class", "ds-ability-mod atlas-tabular-nums");
        modSpan.textContent = modDisplay;
        card.appendChild(modSpan);

        if (isLocked) {
          const scoreSpan = new ElementCtor("span");
          scoreSpan.setAttribute("class", "ds-ability-score atlas-tabular-nums");
          scoreSpan.setAttribute("data-testid", `ability-score-${key}`);
          scoreSpan.textContent = String(score);
          card.appendChild(scoreSpan);
        } else {
          const stepper = new ElementCtor("div");
          stepper.setAttribute("class", "ds-ability-stepper");
          const decBtn = new ElementCtor("button");
          decBtn.setAttribute("type", "button");
          decBtn.setAttribute("data-testid", `ability-dec-${key}`);
          decBtn.textContent = "-";
          const scoreVal = new ElementCtor("span");
          scoreVal.setAttribute("class", "ds-ability-score-val atlas-tabular-nums");
          scoreVal.textContent = String(score);
          const incBtn = new ElementCtor("button");
          incBtn.setAttribute("type", "button");
          incBtn.setAttribute("data-testid", `ability-inc-${key}`);
          incBtn.textContent = "+";
          stepper.appendChild(decBtn);
          stepper.appendChild(scoreVal);
          stepper.appendChild(incBtn);
          card.appendChild(stepper);
        }
        blockEl.appendChild(card);
      }
      widgetEl.appendChild(blockEl);
      return;
    }

    if (widgetType === "ResourceBar") {
      const current = Number(boundValues?.current ?? boundValues?.hpCurrent ?? 0);
      const max = Number(boundValues?.max ?? boundValues?.hpMax ?? 0);
      const temp = Number(boundValues?.temp ?? boundValues?.hpTemp ?? 0);

      const barEl = new ElementCtor("div");
      barEl.setAttribute("data-testid", "resource-bar-widget");
      barEl.setAttribute("class", "ds-resource-bar-widget atlas-tabular-nums");

      const currentInput = new ElementCtor("input");
      currentInput.setAttribute("type", "number");
      currentInput.setAttribute("data-testid", "resource-input-current");
      currentInput.setAttribute("class", "ds-resource-input-current atlas-tabular-nums");
      currentInput.setAttribute("value", String(current));
      barEl.appendChild(currentInput);

      if (isLocked) {
        const maxSpan = new ElementCtor("span");
        maxSpan.setAttribute("data-testid", "resource-max-val");
        maxSpan.setAttribute("class", "ds-resource-max-locked atlas-tabular-nums");
        maxSpan.textContent = String(max);
        barEl.appendChild(maxSpan);
      } else {
        const maxInput = new ElementCtor("input");
        maxInput.setAttribute("type", "number");
        maxInput.setAttribute("data-testid", "resource-input-max");
        maxInput.setAttribute("class", "ds-resource-input-max atlas-tabular-nums");
        maxInput.setAttribute("value", String(max));
        barEl.appendChild(maxInput);
      }

      const tempInput = new ElementCtor("input");
      tempInput.setAttribute("type", "number");
      tempInput.setAttribute("data-testid", "resource-input-temp");
      tempInput.setAttribute("class", "ds-resource-input-temp atlas-tabular-nums");
      tempInput.setAttribute("value", String(temp));
      barEl.appendChild(tempInput);

      widgetEl.appendChild(barEl);
      return;
    }

    if (widgetType === "SavingThrowList") {
      const saves = boundValues?.saves || {};
      const savesEl = new ElementCtor("div");
      savesEl.setAttribute("data-testid", "saving-throw-list-widget");
      for (const [key, val] of Object.entries(saves)) {
        const prof = Boolean((val as any)?.proficient);
        if (!isLocked) {
          const profToggle = new ElementCtor("button");
          profToggle.setAttribute("data-testid", `save-prof-toggle-${key}`);
          profToggle.setAttribute("aria-pressed", prof ? "true" : "false");
          savesEl.appendChild(profToggle);
        }
      }
      widgetEl.appendChild(savesEl);
      return;
    }

    if (widgetType === "SkillCheckList") {
      const skills = boundValues?.skills || {};
      const skillsEl = new ElementCtor("div");
      skillsEl.setAttribute("data-testid", "skill-check-list-widget");
      for (const [key] of Object.entries(skills)) {
        if (!isLocked) {
          const cycleBtn = new ElementCtor("button");
          cycleBtn.setAttribute("data-testid", `skill-prof-cycle-${key}`);
          skillsEl.appendChild(cycleBtn);
        }
      }
      widgetEl.appendChild(skillsEl);
      return;
    }
  }

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
    const unlocked = Boolean(viewer?.padlockUnlocked);
    const renderedRoot = parsed.root
      ? DeclarativeSheetRenderer.renderNode(parsed.root, actorState, dispatcher, unlocked)
      : null;

    return {
      systemId: parsed.systemId,
      version: parsed.version,
      root: renderedRoot,
      padlockEditMode: {
        testId: "sheet-padlock-toggle",
        unlocked,
        ariaPressed: unlocked ? "true" : "false",
        iconName: unlocked ? "PadlockUnlockedIcon" : "PadlockLockedIcon",
        cssClass: "ds-btn ds-btn-secondary",
      },
    };
  }

  public static renderNode(
    node: SheetLayoutNode,
    actorState: unknown,
    dispatcher?: CommandDispatcher,
    padlockUnlocked = false,
  ): RenderedLayoutNode {
    if (node.kind === "section" || node.kind === "column" || node.kind === "row") {
      const renderedChildren = (node.children || []).map((child) =>
        DeclarativeSheetRenderer.renderNode(child, actorState, dispatcher, padlockUnlocked),
      );
      const baseClass = node.kind === "section" ? "ds-panel" : "";
      const combinedClass = [node.cssClass, baseClass].filter(Boolean).join(" ") || undefined;
      return {
        id: node.id,
        kind: node.kind,
        title: node.title,
        visibilityTier: node.visibilityTier,
        cssClass: combinedClass,
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
          DeclarativeSheetRenderer.renderNode(child, actorState, dispatcher, padlockUnlocked),
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
    const options = {
      ...((widgetNode.options as Record<string, unknown>) || {}),
      padlockUnlocked,
    };

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

    const combinedWidgetClass =
      [widgetNode.cssClass, "atlas-tabular-nums"].filter(Boolean).join(" ") || undefined;

    return {
      id: widgetNode.id,
      kind: "widget",
      widgetType: widgetNode.widgetType,
      boundValues,
      options,
      visibilityTier: widgetNode.visibilityTier,
      cssClass: combinedWidgetClass,
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
