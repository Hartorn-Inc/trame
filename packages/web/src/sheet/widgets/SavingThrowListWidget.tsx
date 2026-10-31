import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function SavingThrowListWidget(props: WidgetProps): VNode {
  const rawSaves = (props.boundValues?.saves as Record<string, any>) ?? {};
  const isLocked = props.isLocked !== false;

  const handleSaveClick = (key: string, mod: number) => {
    if (!isLocked) return;
    const sign = mod >= 0 ? `+ ${mod}` : `- ${Math.abs(mod)}`;
    const formula = `1d20 ${sign}`;
    const expression = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        ability: key,
        modifier: mod,
        visibility: 'PUBLIC',
        reason: `Saving throw: ${key}`,
      }),
    );
  };

  const handleToggleProficiency = (key: string, currentProf: boolean) => {
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `saveProficiencies.${key}`,
        ability: key,
        proficient: !currentProf,
        value: !currentProf,
      }),
    );
  };

  return h(
    'div',
    { class: 'ds-saves-widget', 'data-testid': 'saving-throw-list-widget', 'data-locked': String(isLocked) },
    h('h4', { class: 'ds-widget-title' }, 'Saving Throws'),
    h(
      'ul',
      { class: 'ds-saves-list' },
      Object.entries(rawSaves).map(([key, val]) => {
        let mod = 0;
        let proficient = false;
        if (typeof val === 'number') {
          mod = val;
        } else if (val && typeof val === 'object') {
          mod = typeof val.modifier === 'number' ? val.modifier : Number(val.mod ?? 0);
          proficient = Boolean(val.proficient);
        }
        const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;

        return h(
          'li',
          {
            key,
            class: `ds-save-row ${isLocked ? 'is-rollable' : 'is-editable'}`,
            'data-testid': `save-row-${key}`,
            onClick: () => isLocked && handleSaveClick(key, mod),
          },
          h('button', {
            type: 'button',
            class: `ds-prof-pip ${proficient ? 'is-proficient' : ''}`,
            'data-testid': `save-prof-toggle-${key}`,
            disabled: isLocked,
            onClick: (e: Event) => {
              e.stopPropagation();
              if (!isLocked) handleToggleProficiency(key, proficient);
            },
          }),
          h('span', { class: 'ds-save-name' }, key.toUpperCase()),
          h('span', { class: 'ds-save-mod', 'data-testid': `save-mod-${key}` }, modDisplay),
        );
      }),
    ),
  );
}
