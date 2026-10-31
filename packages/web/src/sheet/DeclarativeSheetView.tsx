import { h, type VNode } from 'preact';
import { DND5E_SHEET_LAYOUT } from '../../../game-systems/dnd5e/sheetLayout.ts';
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

const DEFAULT_FALLBACK_LAYOUT: SheetLayoutTree = {
  systemId: 'dnd5e',
  version: '1.0.0',
  root: null,
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
  const layout: SheetLayoutTree = props.sheetLayout ?? (DND5E_SHEET_LAYOUT as unknown as SheetLayoutTree) ?? DEFAULT_FALLBACK_LAYOUT;
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
