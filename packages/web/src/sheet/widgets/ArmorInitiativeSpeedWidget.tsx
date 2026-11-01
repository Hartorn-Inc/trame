import { h, type VNode } from 'preact';
import { formatDistanceFt, t } from '../../i18n/index.ts';
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

  return h(
    'div',
    { class: 'ds-ais-widget', 'data-testid': 'armor-initiative-speed-widget' },
    h(
      'div',
      { class: 'ds-ais-tile', 'data-testid': 'armor-class-tile' },
      h('span', { class: 'ds-tile-title' }, t('sheet.ais.armorClass')),
      h('span', { class: 'ds-tile-val atlas-tabular-nums', 'data-testid': 'armor-class-val' }, armorClass),
    ),
    h(
      'div',
      {
        class: 'ds-ais-tile is-clickable',
        'data-testid': 'initiative-tile',
        role: 'button',
        tabIndex: 0,
        'aria-label': t('sheet.ais.initiativeAria', { modifier: `${initiative >= 0 ? '+' : ''}${initiative}` }),
        onClick: handleInitiativeClick,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleInitiativeClick();
          }
        },
      },
      h('span', { class: 'ds-tile-title' }, t('sheet.ais.initiative')),
      h(
        'span',
        { class: 'ds-tile-val atlas-tabular-nums', 'data-testid': 'initiative-val' },
        initiative >= 0 ? `+${initiative}` : initiative,
      ),
    ),
    h(
      'div',
      { class: 'ds-ais-tile', 'data-testid': 'speed-tile' },
      h('span', { class: 'ds-tile-title' }, t('sheet.ais.speed')),
      h('span', { class: 'ds-tile-val atlas-tabular-nums', 'data-testid': 'speed-val' }, Number.isFinite(Number(speed)) ? formatDistanceFt(Number(speed)) : String(speed)),
    ),
  );
}
