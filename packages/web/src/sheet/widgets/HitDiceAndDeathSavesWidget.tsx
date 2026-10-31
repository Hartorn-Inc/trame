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

  const handleToggleDeathSuccess = (idx: number) => {
    const nextVal = idx < deathSuccesses ? idx : idx + 1;
    const isStable = nextVal >= 3;
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: 'deathSaves.successes',
        deathSuccesses: nextVal,
        value: nextVal,
        ...(isStable ? { condition: 'stable', status: 'stable' } : {}),
      }),
    );
  };

  const handleToggleDeathFailure = (idx: number) => {
    const nextVal = idx < deathFailures ? idx : idx + 1;
    const isDeceased = nextVal >= 3;
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: 'deathSaves.failures',
        deathFailures: nextVal,
        value: nextVal,
        ...(isDeceased ? { condition: 'deceased', status: 'deceased' } : {}),
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
            {
              class: 'ds-deathsave-row',
              role: 'group',
              'aria-label': `Death save successes: ${deathSuccesses} of 3`,
            },
            h('span', { class: 'ds-label-success' }, 'Successes: '),
            [0, 1, 2].map((idx) => {
              const isFilled = idx < deathSuccesses;
              return h(
                'button',
                {
                  key: `succ-${idx}`,
                  type: 'button',
                  class: `ds-pip ds-pip-btn ${isFilled ? 'is-filled' : ''}`,
                  'data-testid': `death-success-pip-${idx}`,
                  'aria-label': `Death save success ${idx + 1}, currently ${isFilled ? 'marked' : 'empty'}`,
                  'aria-pressed': isFilled ? 'true' : 'false',
                  onClick: () => handleToggleDeathSuccess(idx),
                },
                isFilled ? '●' : '○',
              );
            }),
          ),
          h(
            'div',
            {
              class: 'ds-deathsave-row',
              role: 'group',
              'aria-label': `Death save failures: ${deathFailures} of 3`,
            },
            h('span', { class: 'ds-label-failure' }, 'Failures: '),
            [0, 1, 2].map((idx) => {
              const isFilled = idx < deathFailures;
              return h(
                'button',
                {
                  key: `fail-${idx}`,
                  type: 'button',
                  class: `ds-pip ds-pip-btn ${isFilled ? 'is-filled' : ''}`,
                  'data-testid': `death-failure-pip-${idx}`,
                  'aria-label': `Death save failure ${idx + 1}, currently ${isFilled ? 'marked' : 'empty'}`,
                  'aria-pressed': isFilled ? 'true' : 'false',
                  onClick: () => handleToggleDeathFailure(idx),
                },
                isFilled ? '●' : '○',
              );
            }),
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
