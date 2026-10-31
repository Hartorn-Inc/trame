import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import { DND5E_SHEET_LAYOUT } from '../../../game-systems/dnd5e/src/sheetLayout.ts';
import { BindingResolver } from './binding.ts';
import { WidgetRegistry } from './WidgetRegistry.ts';
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
  gm_core_locked?: boolean;
  coreStatsLocked?: boolean;
  dispatchCommand?: CommandDispatcher;
  viewer?: ViewerContext;
  onCloseDrawer?: () => void;
  isTableCanvasMounted?: boolean;
  onToggleCoreStatsLocked?: () => void;
}

export function DeclarativeSheetView(props: DeclarativeSheetViewProps): VNode<any> {
  const layout = props.sheetLayout ?? DND5E_SHEET_LAYOUT;
  const [localLocked, setLocalLocked] = useState(props.coreStatsLocked ?? true);
  const [activeTabId, setActiveTabId] = useState<string>('tab-combat');

  const isGmLocked = Boolean(props.gm_core_locked);
  const effectiveLocked = isGmLocked ? true : (props.coreStatsLocked !== undefined ? props.coreStatsLocked : localLocked);

  const toggleLock = () => {
    if (isGmLocked) return;
    if (props.onToggleCoreStatsLocked) {
      props.onToggleCoreStatsLocked();
    } else {
      setLocalLocked(!localLocked);
    }
  };

  const renderNode = (node: SheetLayoutNode): VNode<any> | null => {
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
      const tabs = node.tabs || [];
      const currentTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
      return h(
        'div',
        {\n          key: node.id,\n          id: node.id,\n          class: 'ds-layout-tabs',\n        },
        h(
          'div',
          { class: 'ds-tabs-header' },
          tabs.map((tab) =>
            h(
              'button',
              {
                key: tab.id,
                type: 'button',
                class: `ds-tab-button ${tab.id === currentTab?.id ? 'is-active' : ''}`,
                'data-testid': `tab-btn-${tab.id}`,
                onClick: () => setActiveTabId(tab.id),
              },
              tab.label,
            ),
          ),
        ),
        h(
          'div',
          { class: 'ds-tabs-body', 'data-testid': `tab-body-${currentTab?.id}` },
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
          options: node.options,
          isLocked: effectiveLocked,
          dispatchCommand: props.dispatchCommand,
          onCloseDrawer: props.onCloseDrawer,
          isTableCanvasMounted: props.isTableCanvasMounted,
        });
      }
    }

    return null;
  };

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
          'aria-pressed': String(!effectiveLocked),
          'aria-label': isGmLocked
            ? 'Character sheet locked by GM'
            : (effectiveLocked ? 'Unlock character build mode' : 'Lock character build mode'),
          disabled: isGmLocked,
          title: isGmLocked ? 'Locked by GM' : (effectiveLocked ? 'Unlock Build Mode' : 'Lock Play Mode'),
          onClick: toggleLock,
        },
        isGmLocked ? '🔒 GM Locked' : (effectiveLocked ? '🔒 Play Mode' : '🔓 Edit Mode'),
      ),
    ),
    layout.root ? renderNode(layout.root) : null,
  );
}
