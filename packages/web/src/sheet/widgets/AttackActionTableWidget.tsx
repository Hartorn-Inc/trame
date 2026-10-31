import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function AttackActionTableWidget(props: WidgetProps): VNode<any> {
  const rawAttacks = Array.isArray(props.boundValues?.attacks) ? props.boundValues.attacks : [];
  const attacks = rawAttacks.map((item: any) => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? 'Attack'),
    attackBonus: Number(item.attackBonus ?? item.bonus ?? 0),
    damageFormula: String(item.damageFormula ?? item.damage ?? '1d6'),
    damageType: item.damageType ? String(item.damageType) : undefined,
    ammunitionItemId: item.ammunitionItemId ? String(item.ammunitionItemId) : undefined,
    ammunitionQuantity: item.ammunitionQuantity !== undefined ? Number(item.ammunitionQuantity) : undefined,
  }));

  const handleAttackRoll = (atk: (typeof attacks)[0]) => {
    if (atk.ammunitionItemId && atk.ammunitionQuantity !== undefined && atk.ammunitionQuantity <= 0) {
      return;
    }
    const bonus = atk.attackBonus;
    const formula = bonus >= 0 ? `1d20 + ${bonus}` : `1d20 - ${Math.abs(bonus)}`;
    const expression = bonus >= 0 ? `1d20+${bonus}` : `1d20${bonus}`;
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        attackId: atk.id,
        attackBonus: bonus,
        name: atk.name,
        visibility: 'PUBLIC',
        reason: `Attack roll: ${atk.name}`,
      }),
    );
    if (atk.ammunitionItemId) {
      const newQty = Math.max(0, (atk.ammunitionQuantity ?? 1) - 1);
      props.dispatchCommand?.(
        TrameCommand.UpdateActorField({
          path: `inventory.${atk.ammunitionItemId}.quantity`,
          itemId: atk.ammunitionItemId,
          quantity: newQty,
          value: newQty,
        }),
      );
    }
  };

  const handleDamageRoll = (atk: (typeof attacks)[0]) => {
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula: atk.damageFormula,
        expression: atk.damageFormula,
        attackId: atk.id,
        damageFormula: atk.damageFormula,
        name: atk.name,
        visibility: 'PUBLIC',
        reason: `Damage roll: ${atk.name}`,
      }),
    );
  };

  return h(
    'div',
    { class: 'ds-attack-table-widget', 'data-testid': 'attack-action-table-widget' },
    h('h4', { class: 'ds-widget-title' }, 'Attacks & Spellcasting'),
    h(
      'table',
      { class: 'ds-attack-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Name'),
          h('th', null, 'To Hit'),
          h('th', null, 'Damage/Type'),
          h('th', null, 'Action'),
        ),
      ),
      h(
        'tbody',
        null,
        attacks.map((atk) => {
          const isDepleted = atk.ammunitionItemId !== undefined && atk.ammunitionQuantity !== undefined && atk.ammunitionQuantity <= 0;
          const bonusDisplay = atk.attackBonus >= 0 ? `+${atk.attackBonus}` : `${atk.attackBonus}`;

          return h(
            'tr',
            { key: atk.id, class: 'ds-attack-row', 'data-testid': `attack-row-${atk.id}` },
            h(
              'td',
              null,
              h('span', { class: 'ds-atk-name' }, atk.name),
              isDepleted
                ? h('span', { class: 'ds-depleted-badge', 'data-testid': `depleted-badge-${atk.id}` }, ' [Depleted]')
                : null,
            ),
            h('td', null, bonusDisplay),
            h('td', null, `${atk.damageFormula} ${atk.damageType ?? ''}`),
            h(
              'td',
              null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'ds-btn-atk-roll',
                  'data-testid': `btn-atk-roll-${atk.id}`,
                  'aria-label': `Roll attack with ${atk.name}`,
                  disabled: isDepleted,
                  onClick: () => handleAttackRoll(atk),
                },
                'Atk',
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'ds-btn-dmg-roll',
                  'data-testid': `btn-dmg-roll-${atk.id}`,
                  'aria-label': `Roll damage for ${atk.name}`,
                  onClick: () => handleDamageRoll(atk),
                },
                'Dmg',
              ),
            ),
          );
        }),
      ),
    ),
  );
}
