import { h, type VNode } from 'preact';
import { PadlockLockedIcon, PadlockUnlockedIcon } from './PadlockIcons.tsx';
import { isNodeAuthorized } from './DeclarativeSheetRenderer.ts';
import { BindingResolver } from './binding.ts';
import { WidgetRegistry } from './WidgetRegistry.ts';
import { useSafeState } from './safeHooks.ts';
import type { CommandDispatcher, SheetLayoutNode, SheetLayoutTree, ViewerContext } from './types.ts';
import {
  StatBlock6Widget,
  ResourceBarWidget,
  ArmorInitiativeSpeedWidget,
  SavingThrowListWidget,
  SkillCheckListWidget,
  HitDiceAndDeathSavesWidget,
  ConditionBadgeStripWidget,
  AttackActionTableWidget,
  SpellbookAccordionWidget,
  InventoryContainerTreeWidget,
  FeatureTraitListWidget,
  NotesMarkdownPaneWidget,
} from './widgets/index.ts';

const DEFAULT_DND5E_SHEET_LAYOUT: SheetLayoutTree = {
  systemId: 'dnd5e',
  version: '1.0.0',
  root: {
    id: 'dnd5e-sheet-root',
    kind: 'section',
    title: 'D&D 5e Character Sheet',
    visibilityTier: 'PUBLIC',
    children: [
      {
        id: 'dnd5e-header-row',
        kind: 'row',
        visibilityTier: 'PUBLIC',
        children: [
          {
            id: 'dnd5e-hp-bar',
            kind: 'widget',
            widgetType: 'ResourceBar',
            visibilityTier: 'PUBLIC',
            bindings: {
              current: 'sheet.attributes.hp.current',
              max: 'sheet.attributes.hp.max',
              temp: 'sheet.attributes.hp.temp',
            },
            options: { label: 'Hit Points', color: 'var(--atlas-action)' },
          },
          {
            id: 'dnd5e-combat-stats',
            kind: 'widget',
            widgetType: 'ArmorInitiativeSpeed',
            visibilityTier: 'PUBLIC',
            bindings: {
              armorClass: 'derived.armorClass',
              initiative: 'derived.initiativeBonus',
              speed: 'derived.speed',
            },
          },
          {
            id: 'dnd5e-hitdice-deathsaves',
            kind: 'widget',
            widgetType: 'HitDiceAndDeathSaves',
            visibilityTier: 'PUBLIC',
            bindings: {
              hitDiceCurrent: 'sheet.attributes.hitDiceCurrent',
              hitDiceMax: 'sheet.attributes.hitDiceMax',
              hitDieSides: 'sheet.attributes.hitDieSize',
              conModifier: 'derived.abilityMods.con',
              deathSuccesses: 'sheet.attributes.deathSaves.successes',
              deathFailures: 'sheet.attributes.deathSaves.failures',
              hpCurrent: 'sheet.attributes.hp.current',
            },
          },
          {
            id: 'dnd5e-active-conditions',
            kind: 'widget',
            widgetType: 'ConditionBadgeStrip',
            visibilityTier: 'PUBLIC',
            bindings: { conditions: 'sheet.conditions' },
          },
        ],
      },
      {
        id: 'dnd5e-main-columns',
        kind: 'row',
        visibilityTier: 'PUBLIC',
        children: [
          {
            id: 'dnd5e-left-column',
            kind: 'column',
            visibilityTier: 'PUBLIC',
            children: [
              {
                id: 'dnd5e-statblock-abilities',
                kind: 'widget',
                widgetType: 'StatBlock6',
                visibilityTier: 'PUBLIC',
                bindings: { abilities: 'sheet.abilities' },
                options: { displayOrder: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
              },
              {
                id: 'dnd5e-saving-throws',
                kind: 'widget',
                widgetType: 'SavingThrowList',
                visibilityTier: 'PUBLIC',
                bindings: { saves: 'derived.savingThrows' },
              },
              {
                id: 'dnd5e-skill-checks',
                kind: 'widget',
                widgetType: 'SkillCheckList',
                visibilityTier: 'PUBLIC',
                bindings: { skills: 'derived.skills' },
              },
            ],
          },
          {
            id: 'dnd5e-right-tabs-column',
            kind: 'column',
            visibilityTier: 'PUBLIC',
            children: [
              {
                id: 'dnd5e-tabs-container',
                kind: 'tabs',
                defaultTabId: 'tab-combat',
                visibilityTier: 'PUBLIC',
                tabs: [
                  {
                    id: 'tab-combat',
                    label: 'Combat',
                    visibilityTier: 'PUBLIC',
                    children: [
                      {
                        id: 'dnd5e-actions-attacks',
                        kind: 'widget',
                        widgetType: 'AttackActionTable',
                        visibilityTier: 'PUBLIC',
                        bindings: { attacks: 'derived.attacks' },
                      },
                    ],
                  },
                  {
                    id: 'tab-spells',
                    label: 'Spellbook',
                    visibilityTier: 'PUBLIC',
                    children: [
                      {
                        id: 'dnd5e-spellbook-accordion',
                        kind: 'widget',
                        widgetType: 'SpellbookAccordion',
                        visibilityTier: 'PUBLIC',
                        bindings: {
                          slots: 'sheet.spellSlots',
                          spells: 'derived.spells',
                          spellSaveDc: 'derived.spellSaveDc',
                          spellAttackBonus: 'derived.spellAttackBonus',
                        },
                        options: { autoDeductSlots: true },
                      },
                    ],
                  },
                  {
                    id: 'tab-inventory',
                    label: 'Inventory',
                    visibilityTier: 'PUBLIC',
                    children: [
                      {
                        id: 'dnd5e-inventory-tree',
                        kind: 'widget',
                        widgetType: 'InventoryContainerTree',
                        visibilityTier: 'PUBLIC',
                        bindings: {
                          items: 'sheet.items',
                          currency: 'sheet.currency',
                          strength: 'sheet.abilities.str',
                        },
                      },
                    ],
                  },
                  {
                    id: 'tab-features',
                    label: 'Features & Traits',
                    visibilityTier: 'PUBLIC',
                    children: [
                      {
                        id: 'dnd5e-feature-traits',
                        kind: 'widget',
                        widgetType: 'FeatureTraitList',
                        visibilityTier: 'PUBLIC',
                        bindings: { features: 'derived.features' },
                      },
                    ],
                  },
                  {
                    id: 'tab-bio',
                    label: 'Biography & Notes',
                    visibilityTier: 'OWNER_ONLY',
                    children: [
                      {
                        id: 'dnd5e-notes-pane',
                        kind: 'widget',
                        widgetType: 'NotesMarkdownPane',
                        visibilityTier: 'OWNER_ONLY',
                        bindings: { bio: 'sheet.bio', notes: 'sheet.notes' },
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

const WIDGET_COMPONENT_MAP: Record<string, any> = {
  StatBlock6: StatBlock6Widget,
  StatBlock6Widget: StatBlock6Widget,
  ResourceBar: ResourceBarWidget,
  ResourceBarWidget: ResourceBarWidget,
  ArmorInitiativeSpeed: ArmorInitiativeSpeedWidget,
  ArmorInitiativeSpeedWidget: ArmorInitiativeSpeedWidget,
  SavingThrowList: SavingThrowListWidget,
  SavingThrowListWidget: SavingThrowListWidget,
  SkillCheckList: SkillCheckListWidget,
  SkillCheckListWidget: SkillCheckListWidget,
  HitDiceAndDeathSaves: HitDiceAndDeathSavesWidget,
  HitDiceAndDeathSavesWidget: HitDiceAndDeathSavesWidget,
  ConditionBadgeStrip: ConditionBadgeStripWidget,
  ConditionBadgeStripWidget: ConditionBadgeStripWidget,
  AttackActionTable: AttackActionTableWidget,
  AttackActionTableWidget: AttackActionTableWidget,
  SpellbookAccordion: SpellbookAccordionWidget,
  SpellbookAccordionWidget: SpellbookAccordionWidget,
  InventoryContainerTree: InventoryContainerTreeWidget,
  InventoryContainerTreeWidget: InventoryContainerTreeWidget,
  FeatureTraitList: FeatureTraitListWidget,
  FeatureTraitListWidget: FeatureTraitListWidget,
  NotesMarkdownPane: NotesMarkdownPaneWidget,
  NotesMarkdownPaneWidget: NotesMarkdownPaneWidget,
};

export interface DeclarativeSheetViewProps {
  sheetLayout?: SheetLayoutTree;
  actorState: unknown;
  actorId?: string;
  gm_core_locked?: boolean;
  coreStatsLocked?: boolean;
  dispatchCommand?: CommandDispatcher;
  viewer?: ViewerContext;
  onCloseDrawer?: () => void;
  isTableCanvasMounted?: boolean;
  onToggleCoreStatsLocked?: () => void;
}

export function DeclarativeSheetView(props: DeclarativeSheetViewProps): VNode<any> {
  const layout: SheetLayoutTree = props.sheetLayout ?? DEFAULT_DND5E_SHEET_LAYOUT;
  const [localLocked, setLocalLocked] = useSafeState<boolean>(props.coreStatsLocked ?? true);
  const [activeTabId, setActiveTabId] = useSafeState<string>('tab-combat');

  const isGmLocked = Boolean(props.gm_core_locked);
  const effectiveLocked = isGmLocked
    ? true
    : props.onToggleCoreStatsLocked
    ? (props.coreStatsLocked ?? true)
    : localLocked;

  const toggleLock = () => {
    if (isGmLocked) return;
    if (props.onToggleCoreStatsLocked) {
      props.onToggleCoreStatsLocked();
    } else {
      setLocalLocked((prev) => !prev);
    }
  };

  const renderNode = (node: SheetLayoutNode): VNode<any> | null => {
    if (!isNodeAuthorized(node.visibilityTier, props.viewer)) {
      return null;
    }

    if (node.kind === 'section' || node.kind === 'column' || node.kind === 'row') {
      const children = (node.children || []).map((child) => renderNode(child)).filter(Boolean);
      return h(
        'div',
        {
          key: node.id,
          id: node.id,
          class: `ds-layout-${node.kind} ${node.cssClass ?? ''}`,
        },
        node.title ? h('h3', { class: 'ds-section-title' }, node.title) : null,
        children,
      );
    }

    if (node.kind === 'tabs') {
      const tabs = (node.tabs || []).filter((tab) => isNodeAuthorized(tab.visibilityTier, props.viewer));
      const currentTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
      return h(
        'div',
        { key: node.id, id: node.id, class: 'ds-layout-tabs' },
        h(
          'div',
          { class: 'ds-tabs-header', role: 'tablist', 'aria-label': 'Character Sheet Sections' },
          tabs.map((tab) =>
            h(
              'button',
              {
                key: tab.id,
                id: `tab-btn-${tab.id}`,
                type: 'button',
                role: 'tab',
                class: `ds-tab-button ${tab.id === currentTab?.id ? 'is-active' : ''}`,
                'data-testid': `tab-btn-${tab.id}`,
                'aria-selected': tab.id === currentTab?.id ? 'true' : 'false',
                'aria-controls': `tab-body-${tab.id}`,
                onClick: () => setActiveTabId(tab.id),
              },
              tab.label,
            ),
          ),
        ),
        h(
          'div',
          {
            class: 'ds-tabs-body',
            role: 'tabpanel',
            id: `tab-body-${currentTab?.id}`,
            'aria-labelledby': `tab-btn-${currentTab?.id}`,
            'data-testid': `tab-body-${currentTab?.id}`,
          },
          (currentTab?.children || []).map((child) => renderNode(child)),
        ),
      );
    }

    if (node.kind === 'widget') {
      const boundValues = BindingResolver.resolveBindings(props.actorState, node.bindings || {});
      const Component = WIDGET_COMPONENT_MAP[node.widgetType] ?? WidgetRegistry.get(node.widgetType);

      if (typeof Component === 'function') {
        return h(Component, {
          key: node.id,
          id: node.id,
          boundValues,
          bindings: node.bindings,
          options: node.options,
          isLocked: effectiveLocked,
          dispatchCommand: props.dispatchCommand,
          actorId: props.actorId,
          onCloseDrawer: props.onCloseDrawer,
          isTableCanvasMounted: props.isTableCanvasMounted,
        });
      }
    }

    return null;
  };

  const lockLabel = isGmLocked
    ? 'GM Locked'
    : effectiveLocked
    ? 'Play Mode'
    : 'Edit Mode';

  return h(
    'div',
    { class: 'ds-declarative-sheet-view', 'data-testid': 'declarative-sheet-view' },
    h(
      'header',
      { class: 'ds-sheet-view-toolbar' },
      h(
        'button',
        {
          type: 'button',
          class: `ds-lock-toggle ${effectiveLocked ? 'is-locked' : 'is-unlocked'}`,
          'data-testid': 'sheet-padlock-toggle',
          'aria-pressed': effectiveLocked ? 'false' : 'true',
          'aria-label': isGmLocked
            ? 'GM Locked — Character sheet locked by GM'
            : effectiveLocked
            ? 'Play Mode — Character sheet locked in roll mode. Activate to enter edit mode.'
            : 'Edit Mode — Character sheet unlocked in edit mode. Activate to enter roll mode.',
          disabled: isGmLocked,
          title: isGmLocked ? 'Locked by GM' : (effectiveLocked ? 'Unlock Build Mode' : 'Lock Play Mode'),
          onClick: toggleLock,
        },
        effectiveLocked ? h(PadlockLockedIcon, { size: 20 }) : h(PadlockUnlockedIcon, { size: 20 }),
        h('span', { class: 'ds-lock-toggle-label' }, lockLabel),
      ),
    ),
    layout && layout.root ? renderNode(layout.root) : null,
  );
}
