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
  padlockUnlocked?: boolean;
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

export interface RollDiceCommand {
  cmd: "ROLL_DICE";
  type: "ROLL_DICE";
  formula: string;
  expression: string;
  reason?: string;
  visibility?: string;
  [key: string]: unknown;
}

export interface UpdateActorSheetCommand {
  cmd: "UPDATE_ACTOR_SHEET";
  type: "UPDATE_ACTOR_SHEET";
  path?: string;
  value?: unknown;
  changes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProjectAoECommand {
  cmd: "PROJECT_AOE";
  type: "PROJECT_AOE";
  template?: unknown;
  aoeShape?: unknown;
  spellId?: string;
  [key: string]: unknown;
}

export interface DropCompendiumEntryCommand {
  cmd: "DROP_COMPENDIUM_ENTRY";
  type: "DROP_COMPENDIUM_ENTRY";
  actorId?: string;
  entryRef?: string;
  targetContainerId?: string | null;
  [key: string]: unknown;
}

export interface CreateActorCommand {
  cmd: "CREATE_ACTOR";
  type: "CREATE_ACTOR";
  data?: unknown;
  [key: string]: unknown;
}

/** Spell slot a cast spends: `key` in `spellSlots` and the tier written back. */
export interface SpentSlot {
  /** `"level1"`..`"level9"` or `"pact"`. */
  key: string;
  /** Tier after the cast (`current` already decremented). */
  tier: { current: number; max: number; slotLevel?: number };
}

/**
 * Sheet cast of a known spell: spends `slot` (none for cantrips), then, when
 * `onTable`, opens the table resolution (attack, save or area) for it.
 */
export interface CastSpellCommand {
  cmd: "CAST_SPELL";
  type: "CAST_SPELL";
  spellId: string;
  slot: SpentSlot | null;
  /** The live table is mounted, so targets can be picked on it. */
  onTable: boolean;
  [key: string]: unknown;
}

/** Opens the table resolution card for `derived.attacks[attackId]` of the sheet's actor. */
export interface ResolveAttackCommand {
  cmd: "RESOLVE_ATTACK";
  type: "RESOLVE_ATTACK";
  attackId: string;
  [key: string]: unknown;
}

export type TrameCommandPayload =
  | RollDiceCommand
  | UpdateActorSheetCommand
  | ProjectAoECommand
  | DropCompendiumEntryCommand
  | CreateActorCommand
  | CastSpellCommand
  | ResolveAttackCommand;

export const TrameCommand = {
  RollDice(payload: { formula: string; expression?: string; reason?: string; visibility?: string; [key: string]: unknown }): RollDiceCommand {
    return {
      cmd: "ROLL_DICE",
      type: "ROLL_DICE",
      expression: payload.expression ?? payload.formula,
      ...payload,
    };
  },
  UpdateActorSheet(payload: Record<string, unknown>): UpdateActorSheetCommand {
    return {
      cmd: "UPDATE_ACTOR_SHEET",
      type: "UPDATE_ACTOR_SHEET",
      ...payload,
    };
  },
  UpdateActorField(payload: Record<string, unknown>): UpdateActorSheetCommand {
    return {
      cmd: "UPDATE_ACTOR_SHEET",
      type: "UPDATE_ACTOR_SHEET",
      ...payload,
    };
  },
  ProjectAoE(payload: Record<string, unknown>): ProjectAoECommand {
    return {
      cmd: "PROJECT_AOE",
      type: "PROJECT_AOE",
      ...payload,
    };
  },
  DropCompendiumEntry(payload: Record<string, unknown>): DropCompendiumEntryCommand {
    return {
      cmd: "DROP_COMPENDIUM_ENTRY",
      type: "DROP_COMPENDIUM_ENTRY",
      ...payload,
    };
  },
  CreateActor(payload: Record<string, unknown>): CreateActorCommand {
    return {
      cmd: "CREATE_ACTOR",
      type: "CREATE_ACTOR",
      ...payload,
    };
  },
  CastSpell(payload: { spellId: string; slot: SpentSlot | null; onTable: boolean }): CastSpellCommand {
    return { cmd: "CAST_SPELL", type: "CAST_SPELL", ...payload };
  },
  ResolveAttack(payload: { attackId: string }): ResolveAttackCommand {
    return { cmd: "RESOLVE_ATTACK", type: "RESOLVE_ATTACK", ...payload };
  },
};

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

export interface PadlockHeaderViewModel {
  testId: "sheet-padlock-toggle";
  unlocked: boolean;
  ariaPressed: "true" | "false";
  iconName: "PadlockUnlockedIcon" | "PadlockLockedIcon";
  cssClass: string;
}

export interface RenderedSheetTree {
  systemId: string;
  version: string;
  root: RenderedLayoutNode | null;
  padlockEditMode?: PadlockHeaderViewModel;
}
