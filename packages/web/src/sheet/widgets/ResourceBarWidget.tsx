import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

function resolveMutationPath(bindingPath: string | undefined, fallbackPath: string): string {
  if (!bindingPath || typeof bindingPath !== 'string') {
    return fallbackPath;
  }
  return bindingPath.startsWith('sheet.') ? bindingPath.slice(6) : bindingPath;
}

export function ResourceBarWidget(props: WidgetProps): VNode<any> {
  const current = Number(props.boundValues?.current ?? props.boundValues?.hpCurrent ?? 0);
  const max = Number(props.boundValues?.max ?? props.boundValues?.hpMax ?? 0);
  const temp = Number(props.boundValues?.temp ?? props.boundValues?.hpTemp ?? 0);
  const label = (props.options?.label as string) ?? 'Hit Points';
  const color = (props.options?.color as string) ?? 'var(--atlas-action)';
  const isLocked = props.isLocked !== false;

  const currentPath = resolveMutationPath(props.bindings?.current, 'attributes.hp.current');
  const maxPath = resolveMutationPath(props.bindings?.max, 'attributes.hp.max');
  const tempPath = resolveMutationPath(props.bindings?.temp, 'attributes.hp.temp');

  const handleHpChange = (path: string, val: number) => {
    const cleanVal = Math.max(0, val);
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path,
        value: cleanVal,
        current: path.includes('current') ? cleanVal : current,
        attributes: {
          hp: {
            current: path.includes('current') ? cleanVal : current,
            max: path.includes('max') ? cleanVal : max,
            temp: path.includes('temp') ? cleanVal : temp,
          },
        },
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
        { class: 'ds-resource-values atlas-tabular-nums' },
        h('input', {
          type: 'number',
          class: 'ds-resource-input-current atlas-tabular-nums',
          'data-testid': 'resource-input-current',
          'aria-label': `Current ${label}`,
          value: current,
          onChange: (e: Event) => handleHpChange(currentPath, Number((e.target as HTMLInputElement).value)),
        }),
        h('span', { class: 'ds-resource-separator' }, '/'),
        isLocked
          ? h('span', { class: 'ds-resource-max-locked atlas-tabular-nums', 'data-testid': 'resource-max-val' }, max)
          : h('input', {
              type: 'number',
              class: 'ds-resource-input-max atlas-tabular-nums',
              'data-testid': 'resource-input-max',
              'aria-label': `Maximum ${label}`,
              value: max,
              onChange: (e: Event) => handleHpChange(maxPath, Number((e.target as HTMLInputElement).value)),
            }),
        h('span', { class: 'ds-resource-separator' }, '+'),
        h('input', {
          type: 'number',
          class: 'ds-resource-input-temp atlas-tabular-nums',
          'data-testid': 'resource-input-temp',
          'aria-label': `Temporary ${label}`,
          value: temp,
          onChange: (e: Event) => handleHpChange(tempPath, Number((e.target as HTMLInputElement).value)),
        }),
        temp > 0
          ? h('span', { class: 'ds-resource-temp atlas-tabular-nums', 'data-testid': 'resource-temp-val' }, ` (${temp} Temp)`)
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
