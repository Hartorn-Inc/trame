/**
 * D&D 5e (SRD 5.1 / SRD 5.2) Declarative Character Sheet Layout Manifest.
 *
 * Conforms to the SheetLayoutTree AST schema and exclusively utilizes
 * canonical container nodes (section, column, row, tabs) and the 12 atomic widgets
 * with zero hardcoded presentation JSX.
 */

export interface LayoutNodeBase {
  id: string;
  kind: "section" | "column" | "row" | "tabs" | "widget";
  visibilityTier?: "PUBLIC" | "OWNER_ONLY" | "GM_ONLY";
  cssClass?: string;
}

export interface ContainerLayoutNode extends LayoutNodeBase {
  kind: "section" | "column" | "row";
  title?: string;
  children: SheetLayoutNode[];
}

export interface TabsLayoutNode extends LayoutNodeBase {
  kind: "tabs";
  defaultTabId: string;
  tabs: Array<{
    id: string;
    label: string;
    icon?: string;
    visibilityTier?: "PUBLIC" | "OWNER_ONLY" | "GM_ONLY";
    children: SheetLayoutNode[];
  }>;
}

export interface WidgetLayoutNode extends LayoutNodeBase {
  kind: "widget";
  widgetType:
    | "StatBlock6"
    | "ResourceBar"
    | "SavingThrowList"
    | "SkillCheckList"
    | "ArmorInitiativeSpeed"
    | "HitDiceAndDeathSaves"
    | "AttackActionTable"
    | "SpellbookAccordion"
    | "InventoryContainerTree"
    | "FeatureTraitList"
    | "ConditionBadgeStrip"
    | "NotesMarkdownPane";
  bindings: Record<string, string>;
  options?: Record<string, unknown>;
}

export type SheetLayoutNode = ContainerLayoutNode | TabsLayoutNode | WidgetLayoutNode;

export interface SheetLayoutTree {
  systemId: string;
  version: string;
  root: SheetLayoutNode;
}

export const DND5E_SHEET_LAYOUT: SheetLayoutTree = {
  systemId: "dnd5e",
  version: "1.0.0",
  root: {
    id: "dnd5e-sheet-root",
    kind: "section",
    title: "D&D 5e Character Sheet",
    visibilityTier: "PUBLIC",
    children: [
      {
        id: "dnd5e-header-row",
        kind: "row",
        visibilityTier: "PUBLIC",
        children: [
          {
            id: "dnd5e-hp-bar",
            kind: "widget",
            widgetType: "ResourceBar",
            visibilityTier: "PUBLIC",
            bindings: {
              current: "sheet.attributes.hp.current",
              max: "sheet.attributes.hp.max",
              temp: "sheet.attributes.hp.temp",
            },
            options: {
              label: "Hit Points",
              color: "#e53e3e",
            },
          },
          {
            id: "dnd5e-combat-stats",
            kind: "widget",
            widgetType: "ArmorInitiativeSpeed",
            visibilityTier: "PUBLIC",
            bindings: {
              armorClass: "derived.armorClass",
              initiative: "derived.initiativeBonus",
              speed: "derived.speed",
            },
          },
          {
            id: "dnd5e-hitdice-deathsaves",
            kind: "widget",
            widgetType: "HitDiceAndDeathSaves",
            visibilityTier: "PUBLIC",
            bindings: {
              hitDiceCurrent: "sheet.attributes.hitDiceCurrent",
              hitDiceMax: "sheet.attributes.hitDiceMax",
              hitDieSides: "sheet.attributes.hitDieSize",
              conModifier: "derived.abilityMods.con",
              deathSuccesses: "sheet.attributes.deathSaves.successes",
              deathFailures: "sheet.attributes.deathSaves.failures",
              hpCurrent: "sheet.attributes.hp.current",
            },
          },
          {
            id: "dnd5e-active-conditions",
            kind: "widget",
            widgetType: "ConditionBadgeStrip",
            visibilityTier: "PUBLIC",
            bindings: {
              conditions: "sheet.conditions",
            },
          },
        ],
      },
      {
        id: "dnd5e-main-columns",
        kind: "row",
        visibilityTier: "PUBLIC",
        children: [
          {
            id: "dnd5e-left-column",
            kind: "column",
            visibilityTier: "PUBLIC",
            children: [
              {
                id: "dnd5e-statblock-abilities",
                kind: "widget",
                widgetType: "StatBlock6",
                visibilityTier: "PUBLIC",
                bindings: {
                  abilities: "sheet.abilities",
                },
                options: {
                  displayOrder: ["str", "dex", "con", "int", "wis", "cha"],
                },
              },
              {
                id: "dnd5e-saving-throws",
                kind: "widget",
                widgetType: "SavingThrowList",
                visibilityTier: "PUBLIC",
                bindings: {
                  saves: "derived.savingThrows",
                },
              },
              {
                id: "dnd5e-skill-checks",
                kind: "widget",
                widgetType: "SkillCheckList",
                visibilityTier: "PUBLIC",
                bindings: {
                  skills: "derived.skills",
                },
              },
            ],
          },
          {
            id: "dnd5e-right-tabs-column",
            kind: "column",
            visibilityTier: "PUBLIC",
            children: [
              {
                id: "dnd5e-tabs-container",
                kind: "tabs",
                defaultTabId: "tab-combat",
                visibilityTier: "PUBLIC",
                tabs: [
                  {
                    id: "tab-combat",
                    label: "Combat",
                    visibilityTier: "PUBLIC",
                    children: [
                      {
                        id: "dnd5e-actions-attacks",
                        kind: "widget",
                        widgetType: "AttackActionTable",
                        visibilityTier: "PUBLIC",
                        bindings: {
                          attacks: "derived.attacks",
                        },
                      },
                    ],
                  },
                  {
                    id: "tab-spells",
                    label: "Spellbook",
                    visibilityTier: "PUBLIC",
                    children: [
                      {
                        id: "dnd5e-spellbook-accordion",
                        kind: "widget",
                        widgetType: "SpellbookAccordion",
                        visibilityTier: "PUBLIC",
                        bindings: {
                          slots: "sheet.spellSlots",
                          spells: "derived.spells",
                          spellSaveDc: "derived.spellSaveDc",
                          spellAttackBonus: "derived.spellAttackBonus",
                        },
                        options: {
                          autoDeductSlots: true,
                        },
                      },
                    ],
                  },
                  {
                    id: "tab-inventory",
                    label: "Inventory",
                    visibilityTier: "PUBLIC",
                    children: [
                      {
                        id: "dnd5e-inventory-tree",
                        kind: "widget",
                        widgetType: "InventoryContainerTree",
                        visibilityTier: "PUBLIC",
                        bindings: {
                          items: "sheet.items",
                          currency: "sheet.currency",
                        },
                      },
                    ],
                  },
                  {
                    id: "tab-features",
                    label: "Features & Traits",
                    visibilityTier: "PUBLIC",
                    children: [
                      {
                        id: "dnd5e-feature-traits",
                        kind: "widget",
                        widgetType: "FeatureTraitList",
                        visibilityTier: "PUBLIC",
                        bindings: {
                          features: "derived.features",
                        },
                      },
                    ],
                  },
                  {
                    id: "tab-bio",
                    label: "Biography & Notes",
                    visibilityTier: "OWNER_ONLY",
                    children: [
                      {
                        id: "dnd5e-notes-pane",
                        kind: "widget",
                        widgetType: "NotesMarkdownPane",
                        visibilityTier: "OWNER_ONLY",
                        bindings: {
                          bio: "sheet.bio",
                          notes: "sheet.notes",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};
