import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function ArmorInitiativeSpeedWidget(props: WidgetProps): VNode<any> {
  const armorClass = Number(props.boundValues?.armorClass ?? props.boundValues?.effectiveAc ?? 10);
  const initiative = Number(props.boundValues?.initiative ?? props.boundValues?.initiativeBonus ?? 0);
  const speed = props.boundValues?.speed ?? props.boundValues?.effectiveSpeedFeet ?? 30;

  const handleInitiativeClick = () => {
    const sign = initiative >= 0 ? `+ ${initiative}` : `- ${Math.abs(initiative)}`;
    const formula = `1d20 ${sign}`;
    const expression = initiative >= 0 ? `1d20+${initiative}` : `1d20${initiative}`;
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        initiative,
        visibility: 'PUBLIC',
        reason: 'Initiative check',
      }),
    );
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleInitiativeClick();
    }
  };

  return h(
    'div',
    { class: 'ds-ais-widget', 'data-testid': 'armor-initiative-speed-widget' },
    h(
      'div',
      { class: 'ds-ais-tile', 'data-testid': 'armor-class-tile' },
      h('span', { class: 'ds-tile-title' }, 'Armor Class'),
      h('span', { class: 'ds-tile-val atlas-tabular-nums', 'data-testid': 'armor-class-val' }, armorClass),
    ),
    h(
      'div',
      {
        class: 'ds-ais-tile is-clickable',
        'data-testid': 'initiative-tile',
        role: 'button',
        tabIndex: 0,
        'aria-label': 'Roll initiative check',
        onClick: handleInitiativeClick,
        onKeyDown: handleKeyDown,
      },
      h('span', { class: 'ds-tile-title' }, 'Initiative'),
      h(
        'span',
        { class: 'ds-tile-val atlas-tabular-nums', 'data-testid': 'initiative-val' },
        initiative >= 0 ? `+${initiative}` : initiative,
      ),
    ),
    h(
      'div',
      { class: 'ds-ais-tile', 'data-testid': 'speed-tile' },
      h('span', { class: 'ds-tile-title' }, 'Speed'),
      h('span', { class: 'ds-tile-val atlas-tabular-nums', 'data-testid': 'speed-val' }, `${speed} ft`),
    ),
  );
}
