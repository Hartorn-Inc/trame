import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function ConditionBadgeStripWidget(props: WidgetProps): VNode<any> {
  const rawConditions = Array.isArray(props.boundValues?.conditions)
    ? props.boundValues.conditions
    : [];

  const conditions = rawConditions.map((c: any) => {
    if (typeof c === 'string') return { id: c, name: c };
    return { id: String(c.id ?? ''), name: String(c.name ?? c.id ?? '') };
  });

  const handleRemove = (condId: string) => {
    const remaining = conditions.filter((c) => c.id !== condId);
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: 'conditions',
        removedConditionId: condId,
        conditionId: condId,
        conditions: remaining.map((c) => c.id),
        value: remaining.map((c) => c.id),
      }),
    );
  };

  return h(
    'div',
    { class: 'ds-condition-strip', 'data-testid': 'condition-badge-strip-widget' },
    conditions.length === 0
      ? h('span', { class: 'ds-no-conditions' }, 'No active conditions')
      : conditions.map((cond) =>
          h(
            'span',
            { key: cond.id, class: 'ds-condition-badge', 'data-testid': `condition-badge-${cond.id}` },
            h('span', { class: 'ds-condition-text' }, cond.name),
            h(
              'button',
              {
                type: 'button',
                class: 'ds-btn-remove-cond',
                'data-testid': `btn-remove-condition-${cond.id}`,
                'aria-label': `Remove condition ${cond.name}`,
                onClick: () => handleRemove(cond.id),
              },
              '×',
            ),
          ),
        ),
  );
}
