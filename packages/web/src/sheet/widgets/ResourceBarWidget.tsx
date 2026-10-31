import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function ResourceBarWidget(props: WidgetProps): VNode {
  const current = Number(props.boundValues?.current ?? props.boundValues?.hpCurrent ?? 0);
  const max = Number(props.boundValues?.max ?? props.boundValues?.hpMax ?? 0);
  const temp = Number(props.boundValues?.temp ?? props.boundValues?.hpTemp ?? 0);
  const label = (props.options?.label as string) ?? 'Hit Points';
  const color = (props.options?.color as string) ?? 'var(--atlas-primary)';
  const isLocked = props.isLocked !== false;

  const handleHpChange = (path: string, val: number) => {
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path,
        value: Math.max(0, val),
        current: path.includes('current') ? Math.max(0, val) : current,
      }),
    );
  };

  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((current / max) * 100))) : 0;

  return h(
    'div',
    { class: 'ds-resource-bar-widget', 'data-testid': 'resource-bar-widget' },
    h(
      'div',
      { class: 'ds-resource-header' },
      h('span', { class: 'ds-resource-label' }, label),
      h(
        'div',
        { class: 'ds-resource-values' },
        h('input', {
          type: 'number',
          class: 'ds-resource-input-current',
          'data-testid': 'resource-input-current',
          value: current,
          onChange: (e: Event) => handleHpChange('hp.current', Number((e.target as HTMLInputElement).value)),
        }),
        h('span', { class: 'ds-resource-separator' }, '/'),
        isLocked
          ? h('span', { class: 'ds-resource-max-locked', 'data-testid': 'resource-max-val' }, max)
          : h('input', {
              type: 'number',
              class: 'ds-resource-input-max',
              'data-testid': 'resource-input-max',
              value: max,
              onChange: (e: Event) => handleHpChange('hp.max', Number((e.target as HTMLInputElement).value)),
            }),
        temp > 0
          ? h('span', { class: 'ds-resource-temp', 'data-testid': 'resource-temp-val' }, ` (+${temp} Temp)`)
          : null,
      ),
    ),
    h(
      'div',
      { class: 'ds-resource-track' },
      h('div', {
        class: 'ds-resource-fill',
        'data-testid': 'resource-fill',
        style: { width: `${pct}%`, backgroundColor: color },
      }),
    ),
  );
}
