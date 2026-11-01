import { h, type VNode } from 'preact';
import { t } from '../../i18n/index.ts';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function SavingThrowListWidget(props: WidgetProps): VNode<any> {
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
    h('h4', { class: 'ds-widget-title' }, t('sheet.saves.title')),
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
        const ability = key.toUpperCase();
        const pipGlyph = proficient ? '[P]' : '[ ]';
        const name = h('span', { class: 'ds-save-name' }, ability);
        const modifier = h('span', { class: 'ds-save-mod atlas-tabular-nums', 'data-testid': `save-mod-${key}` }, modDisplay);

        return h(
          'li',
          { key, class: `ds-save-row ${isLocked ? 'is-rollable' : 'is-editable'}`, 'data-testid': `save-row-${key}` },
          isLocked
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'ds-save-roll',
                  'data-testid': `save-roll-${key}`,
                  'aria-label': t('sheet.saves.rollAria', {
                    ability,
                    modifier: modDisplay,
                    proficiency: t(proficient ? 'sheet.proficiency.proficient' : 'sheet.proficiency.none'),
                  }),
                  onClick: () => handleSaveClick(key, mod),
                },
                h('span', { class: `ds-prof-pip ${proficient ? 'is-proficient' : ''}`, 'aria-hidden': 'true' }, pipGlyph),
                name,
                modifier,
              )
            : [
                h(
                  'button',
                  {
                    type: 'button',
                    class: `ds-prof-pip ${proficient ? 'is-proficient' : ''}`,
                    'data-testid': `save-prof-toggle-${key}`,
                    'aria-label': t('sheet.saves.toggleAria', { ability }),
                    'aria-pressed': proficient ? 'true' : 'false',
                    onClick: () => handleToggleProficiency(key, proficient),
                  },
                  pipGlyph,
                ),
                name,
                modifier,
              ],
        );
      }),
    ),
  );
}
