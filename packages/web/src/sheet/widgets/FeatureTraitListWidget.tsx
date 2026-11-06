/**
 * ============================================================================
 * FEATURES & TRAITS WIDGET (sheet/widgets/FeatureTraitListWidget.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lists `derived.features` (class, subclass, species, background and feat
 * features) with the `ClassFeature` controls the rules need at the table:
 * use counters for pooled features (`pool`, written to
 * `resources[pool.id]`), toggles for features in force (`active`, written to
 * `activeFeatureIds`: Rage, Reckless Attack, Innate Sorcery, Sacred Weapon),
 * and an automation badge telling the player what TRAME applies by itself.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Counters Stay In Range`:
 *    - "Use" is disabled at `0` and "Regain" at `max`; the written pool is
 *      the full `{ current, max, resetOn }` record.
 * 2. `Activation Pays Its Own Use`:
 *    - Turning on a toggle feature that owns a pool (Rage, Innate Sorcery)
 *      spends one use in the same sheet save; with no use left it cannot be
 *      turned on. Turning it off never refunds.
 * 3. `Not Colour Alone`:
 *    - Badges and toggle states are words (`Automated`, `Counter`,
 *      `Described`, `Active`) with `aria-pressed` on toggles.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import { t, type MessageKey } from '../../i18n/index.ts';
import { useSafeState } from '../safeHooks.ts';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { CompendiumDragDropManager } from '../../compendium/CompendiumDragDropManager.ts';

interface FeaturePool {
  id: string;
  current: number;
  max: number;
  resetOn: string;
  shortRestRegain?: number;
}

/** Badge shown for a feature: pooled features are counters, others follow their D12 class. */
function badgeOf(feat: any): 'counter' | 'automated' | 'described' | null {
  if (feat.pool) return 'counter';
  return feat.automation === 'automated' || feat.automation === 'described' ? feat.automation : null;
}

function poolRecord(pool: FeaturePool, current: number) {
  return {
    current,
    max: pool.max,
    resetOn: pool.resetOn,
    ...(pool.shortRestRegain ? { shortRestRegain: pool.shortRestRegain } : {}),
  };
}

export function FeatureTraitListWidget(props: WidgetProps): VNode<any> {
  const rawFeatures = Array.isArray(props.boundValues?.features) ? props.boundValues.features : [];
  const activeIds: string[] = Array.isArray(props.boundValues?.activeFeatureIds) ? (props.boundValues.activeFeatureIds as string[]) : [];
  const [expandedIds, setExpandedIds] = useSafeState<string[]>([]);
  const [isDragOver, setIsDragOver] = useSafeState(false);
  const dragManager = new CompendiumDragDropManager(props.options?.systemId as string ?? 'dnd5e', props.dispatchCommand, props.actorId);

  const toggle = (id: string) => {
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const setPool = (pool: FeaturePool, current: number) => {
    props.dispatchCommand?.(TrameCommand.UpdateActorSheet({ path: `resources.${pool.id}`, value: poolRecord(pool, current) }));
  };

  const setActive = (featureId: string, active: boolean, pool: FeaturePool | undefined) => {
    const ids = active ? [...activeIds.filter((id) => id !== featureId), featureId] : activeIds.filter((id) => id !== featureId);
    const changes: Record<string, unknown> = { activeFeatureIds: ids };
    if (active && pool) changes[`resources.${pool.id}`] = poolRecord(pool, pool.current - 1);
    props.dispatchCommand?.(TrameCommand.UpdateActorSheet({ changes }));
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const payload = dragManager.parseDragEvent(e);
    if (payload) dragManager.handleDrop(payload, null, props.actorId);
  };

  const smallButton = (testId: string, label: string, aria: string, onClick: () => void, extra: Record<string, unknown> = {}) =>
    h('button', { type: 'button', class: 'ds-btn ds-btn-secondary ds-btn-sm', 'data-testid': testId, 'aria-label': aria, onClick, ...extra }, label);

  return h(
    'div',
    {
      class: `ds-features-widget ${isDragOver ? 'is-drag-over' : ''}`,
      'data-testid': 'feature-trait-list-widget',
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
      },
      onDragLeave: () => setIsDragOver(false),
      onDrop: handleDrop,
    },
    h('h4', { class: 'ds-widget-title' }, t('sheet.features.title')),
    h(
      'ul',
      { class: 'ds-features-list' },
      rawFeatures.map((feat: any, index: number) => {
        const id = String(feat.id ?? `feature-${index}`);
        const isExpanded = expandedIds.includes(id);
        const name = feat.name ?? t('sheet.features.defaultName');
        const badge = badgeOf(feat);
        const pool: FeaturePool | undefined = feat.pool;
        const isToggle = typeof feat.active === 'boolean';
        const description = feat.description ?? feat.summary;
        return h(
          'li',
          { key: id, class: 'ds-feature-item ds-stack-sm', 'data-testid': `feature-item-${id}` },
          h(
            'div',
            { class: 'ds-cluster' },
            h(
              'button',
              {
                type: 'button',
                class: 'ds-btn-reset ds-feature-header',
                'data-testid': `feature-header-${id}`,
                'aria-expanded': isExpanded ? 'true' : 'false',
                'aria-label': t('sheet.features.toggleAria', { name }),
                onClick: () => toggle(id),
              },
              h('strong', null, name),
              h(
                'span',
                { class: 'ds-feature-source ds-meta' },
                feat.level ? ` ${t('sheet.features.sourceLevel', { source: feat.source ?? t('sheet.features.defaultSource'), level: feat.level })}` : ` (${feat.source ?? t('sheet.features.defaultSource')})`,
              ),
            ),
            badge
              ? h('span', { class: 'ds-badge', 'data-testid': `feature-badge-${id}` }, t(`sheet.features.badge.${badge}` as MessageKey))
              : null,
            feat.scaling ? h('span', { class: 'ds-meta atlas-tabular-nums' }, `${feat.scaling.label} ${feat.scaling.value}`) : null,
          ),
          pool
            ? h(
                'div',
                { class: 'ds-cluster', role: 'group', 'aria-label': t('sheet.features.usesAria', { name }) },
                h(
                  'span',
                  { class: 'ds-value atlas-tabular-nums', 'data-testid': `feature-pool-${id}` },
                  t('sheet.features.uses', { current: pool.current, max: pool.max }),
                ),
                smallButton(`btn-feature-spend-${id}`, t('sheet.features.spend'), t('sheet.features.spendAria', { name }), () => setPool(pool, pool.current - 1), {
                  disabled: pool.current <= 0,
                }),
                smallButton(`btn-feature-regain-${id}`, t('sheet.features.regain'), t('sheet.features.regainAria', { name }), () => setPool(pool, pool.current + 1), {
                  disabled: pool.current >= pool.max,
                }),
              )
            : null,
          isToggle
            ? smallButton(
                `btn-feature-toggle-${id}`,
                t(feat.active ? 'sheet.features.active' : 'sheet.features.inactive'),
                t('sheet.features.activeAria', { name }),
                () => setActive(id, !feat.active, pool),
                { 'aria-pressed': feat.active ? 'true' : 'false', disabled: !feat.active && pool !== undefined && pool.current <= 0 },
              )
            : null,
          isExpanded && description
            ? h('p', { class: 'ds-feature-desc', 'data-testid': `feature-desc-${id}` }, description)
            : null,
        );
      }),
    ),
  );
}
