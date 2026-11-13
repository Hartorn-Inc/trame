/**
 * ============================================================================
 * DECLARATIVE CHARACTER SHEET VIEW (sheet/DeclarativeSheetView.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Renders a declarative `SheetLayoutTree` (defaulting to the 12-widget D&D 5e
 * layout) by resolving `sheet.*` and `derived.*` bindings against `actorState`,
 * enforcing node-level `VisibilityTier` authorization, and managing the
 * play/edit padlock and accessible section tabs.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `GM Lock Precedence`:
 *    - When `gm_core_locked` is `true`, `effectiveLocked` is forced to `true`
 *      and the padlock toggle is disabled regardless of local edit state.
 * 2. `Complete Feature Toggle State`:
 *    - `FeatureTraitList` binds both `derived.features` and
 *      `sheet.activeFeatureIds` so activating a second toggle preserves all
 *      currently active class features (such as `Rage`).
 * 3. `WAI-ARIA Roving Tablist`:
 *    - Section tabs expose `role="tablist"` / `role="tab"` / `role="tabpanel"`
 *      with ATLAS `.ds-tablist` / `.ds-tab` primitives, single-stop roving
 *      `tabIndex` (`0` active, `-1` inactive), and wrapping `ArrowLeft`,
 *      `ArrowRight`, `Home`, and `End` keyboard navigation.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import { t, translateLayoutText } from '../i18n/index.ts';
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
    title: 'sheet.layout.title',
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
            options: { label: 'sheet.resource.hitPoints', color: 'var(--atlas-action)' },
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
                    label: 'sheet.tab.combat',
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
                    label: 'sheet.tab.spells',
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
                    label: 'sheet.tab.inventory',
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
                    label: 'sheet.tab.features',
                    visibilityTier: 'PUBLIC',
                    children: [
                      {
                        id: 'dnd5e-feature-traits',
                        kind: 'widget',
                        widgetType: 'FeatureTraitList',
                        visibilityTier: 'PUBLIC',
                        bindings: {
                          features: 'derived.features',
                          activeFeatureIds: 'sheet.activeFeatureIds',
                        },
                      },
                    ],
                  },
                  {
                    id: 'tab-bio',
                    label: 'sheet.tab.bio',
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

/**
 * Computes the next tab index for WAI-ARIA horizontal `tablist` keyboard
 * navigation (`ArrowRight`, `ArrowLeft`, `Home`, `End`) with wraparound, or
 * returns `null` for unrelated keys or empty tab lists.
 */
export function nextSheetTabIndex(index: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
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
      const layoutClass =
        node.kind === 'section'
          ? 'ds-layout-section'
          : node.kind === 'column'
            ? 'ds-layout-column'
            : 'ds-layout-row';
      const children = (node.children || []).map((child) => renderNode(child)).filter(Boolean);
      return h(
        'div',
        {
          key: node.id,
          id: node.id,
          class: `${layoutClass} ${node.cssClass ?? ''}`.trim(),
        },
        node.title ? h('h3', { class: 'ds-section-title' }, translateLayoutText(node.title)) : null,
        children,
      );
    }

    if (node.kind === 'tabs') {
      const tabs = (node.tabs || []).filter((tab) => isNodeAuthorized(tab.visibilityTier, props.viewer));
      const currentTab =
        tabs.find((tab) => tab.id === activeTabId) ??
        (node.defaultTabId ? tabs.find((tab) => tab.id === node.defaultTabId) : undefined) ??
        tabs[0];
      const currentIndex = currentTab ? tabs.indexOf(currentTab) : 0;
      const onTabKeyDown = (e: KeyboardEvent) => {
        const next = nextSheetTabIndex(currentIndex, e.key, tabs.length);
        if (next === null) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        const nextTab = tabs[next];
        if (!nextTab) return;
        setActiveTabId(nextTab.id);
        const tabEl =
          (e.currentTarget as HTMLElement | null | undefined)?.querySelector?.(`#tab-btn-${nextTab.id}`) ??
          (typeof document !== 'undefined' && typeof document.getElementById === 'function'
            ? document.getElementById(`tab-btn-${nextTab.id}`)
            : null);
        (tabEl as HTMLElement | null | undefined)?.focus?.();
      };
      return h(
        'div',
        { key: node.id, id: node.id, class: 'ds-layout-tabs' },
        h(
          'div',
          {
            class: 'ds-tablist',
            role: 'tablist',
            'aria-label': t('sheet.tabsAria'),
            'data-testid': 'sheet-tablist',
            onKeyDown: onTabKeyDown,
          },
          tabs.map((tab) => {
            const isActive = tab.id === currentTab?.id;
            return h(
              'button',
              {
                key: tab.id,
                id: `tab-btn-${tab.id}`,
                type: 'button',
                role: 'tab',
                class: `ds-btn-reset ds-tab${isActive ? ' is-active' : ''}`,
                'data-testid': `tab-btn-${tab.id}`,
                'aria-selected': isActive ? 'true' : 'false',
                'aria-controls': `tab-body-${tab.id}`,
                tabIndex: isActive ? 0 : -1,
                onClick: () => setActiveTabId(tab.id),
              },
              translateLayoutText(tab.label),
            );
          }),
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
          'aria-describedby': isGmLocked ? 'sheet-gm-locked-hint' : undefined,
          disabled: isGmLocked,
          title: t(isGmLocked ? 'sheet.lock.gmLockedTitle' : (effectiveLocked ? 'sheet.lock.unlockTitle' : 'sheet.lock.lockTitle')),
          onClick: toggleLock,
        },
        effectiveLocked ? h(PadlockLockedIcon, { size: 20 }) : h(PadlockUnlockedIcon, { size: 20 }),
        h('span', { class: 'ds-lock-toggle-label' }, t('sheet.lock.editMode')),
      ),
      isGmLocked
        ? h('span', { id: 'sheet-gm-locked-hint', class: 'ds-meta', 'data-testid': 'sheet-gm-locked' }, t('sheet.lock.gmLocked'))
        : null,
    ),
    layout && layout.root ? renderNode(layout.root) : null,
  );
}
