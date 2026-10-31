import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function HitDiceAndDeathSavesWidget(props: WidgetProps): VNode<any> {
  const hitDiceCurrent = Number(props.boundValues?.hitDiceCurrent ?? 0);
  const hitDiceMax = Number(props.boundValues?.hitDiceMax ?? 0);
  const hitDieSides = Number(props.boundValues?.hitDieSides ?? 8);
  const conModifier = Number(props.boundValues?.conModifier ?? 0);
  const deathSuccesses = Number(props.boundValues?.deathSuccesses ?? 0);
  const deathFailures = Number(props.boundValues?.deathFailures ?? 0);
  const hpCurrent = Number(props.boundValues?.hpCurrent ?? 0);

  const handleSpendHitDie = () => {
    if (hitDiceCurrent <= 0) return;
    const sign = conModifier >= 0 ? `+ ${conModifier}` : `- ${Math.abs(conModifier)}`;
    const formula = `1d${hitDieSides} ${sign}`;
    const expression = conModifier >= 0 ? `1d${hitDieSides}+${conModifier}` : `1d${hitDieSides}${conModifier}`;
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        hitDieSides,
        conModifier,
        visibility: 'PUBLIC',
        reason: 'Spend Hit Die',
      }),
    );
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: 'hitDiceCurrent',
        hitDiceCurrent: hitDiceCurrent - 1,
        value: hitDiceCurrent - 1,
      }),
    );
  };

  const handleRollDeathSave = () => {
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula: '1d20',
        expression: '1d20',
        visibility: 'PUBLIC',
        reason: 'Death Saving Throw',
      }),
    );
  };

  return h(
    'div',
    { class: 'ds-hdds-widget', 'data-testid': 'hitdice-deathsaves-widget' },
    h(
      'div',
      { class: 'ds-hitdice-pane', 'data-testid': 'hitdice-pane' },
      h('span', { class: 'ds-pane-label' }, 'Hit Dice'),
      h('span', { class: 'ds-hitdice-val', 'data-testid': 'hitdice-count' }, `${hitDiceCurrent} / ${hitDiceMax} (d${hitDieSides})`),
      h(
        'button',
        {
          type: 'button',
          class: 'ds-btn-spend-hitdie',
          'data-testid': 'btn-spend-hitdie',
          disabled: hitDiceCurrent <= 0,
          onClick: handleSpendHitDie,
        },
        'Spend Die',
      ),
    ),
    hpCurrent === 0
      ? h(
          'div',
          { class: 'ds-deathsaves-pane', 'data-testid': 'deathsaves-pane' },
          h('span', { class: 'ds-pane-label' }, 'Death Saves'),
          h(
            'div',
            { class: 'ds-deathsave-row' },
            h('span', { class: 'ds-label-success' }, 'Successes: '),
            [0, 1, 2].map((idx) =>
              h('span', {
                key: `succ-${idx}`,
                class: `ds-pip ${idx < deathSuccesses ? 'is-filled' : ''}`,
                'data-testid': `death-success-pip-${idx}`,
              }),
            ),
          ),
          h(
            'div',
            { class: 'ds-deathsave-row' },
            h('span', { class: 'ds-label-failure' }, 'Failures: '),
            [0, 1, 2].map((idx) =>
              h('span', {
                key: `fail-${idx}`,
                class: `ds-pip ${idx < deathFailures ? 'is-filled' : ''}`,
                'data-testid': `death-failure-pip-${idx}`,
              }),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'ds-btn-death-save',
              'data-testid': 'btn-death-save',
              onClick: handleRollDeathSave,
            },
            'Roll DeathSavingThrow',
          ),
        )
      : null,
  );
}
