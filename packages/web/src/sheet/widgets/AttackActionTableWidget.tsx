/**
 * ============================================================================
 * ATTACKS TABLE WIDGET (sheet/widgets/AttackActionTableWidget.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lists `derived.attacks` (equipped weapons and damaging spells) with their
 * to-hit bonus or saving throw DC and their damage, and starts either a quick
 * roll or, on the live table, the semi-automated resolution (D6): the
 * "Target" button opens the table's resolution card for the attack.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Save Attacks Have No Attack Roll`:
 *    - An attack with `attackBonus: null` (a saving throw spell) shows
 *      "DC n ABILITY" and offers no attack-roll button.
 * 2. `Damage Text Matches The Roll`:
 *    - The damage column is the same expression the damage roll sends
 *      (`damageExpression(dice, modifier)`), so the sheet never shows one
 *      number and rolls another.
 * 3. `Resolution Only On The Table`:
 *    - "Target" renders only while the table is mounted; it closes the drawer
 *      so targets can be picked on the board.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import { damageExpression } from '../../../../game-systems/dnd5e/src/index.ts';
import { t } from '../../i18n/index.ts';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

interface AttackRow {
  id: string;
  name: string;
  /** `null` for saving throw attacks. */
  attackBonus: number | null;
  save?: { ability: string; dc: number };
  damageFormula: string;
  damageType?: string;
  ammunitionItemId?: string;
  ammunitionQuantity?: number;
}

function toRow(item: any): AttackRow {
  const damageFormula =
    item.damageFormula ?? item.damage ?? (typeof item.damageDice === 'string' ? damageExpression(item.damageDice, Number(item.damageModifier ?? 0), false) : '1d6');
  return {
    id: String(item.id ?? ''),
    name: String(item.name ?? 'Attack'),
    attackBonus: item.attackBonus === null ? null : Number(item.attackBonus ?? item.bonus ?? 0),
    ...(item.save ? { save: { ability: String(item.save.ability), dc: Number(item.save.dc) } } : {}),
    damageFormula: String(damageFormula),
    damageType: item.damageType ? String(item.damageType) : undefined,
    ammunitionItemId: item.ammunitionItemId ? String(item.ammunitionItemId) : undefined,
    ammunitionQuantity: item.ammunitionQuantity !== undefined ? Number(item.ammunitionQuantity) : undefined,
  };
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function AttackActionTableWidget(props: WidgetProps): VNode<any> {
  const rawAttacks = Array.isArray(props.boundValues?.attacks) ? props.boundValues.attacks : [];
  const attacks = rawAttacks.map(toRow);
  const onTable = props.isTableCanvasMounted === true;

  const handleAttackRoll = (atk: AttackRow) => {
    if (atk.attackBonus === null) return;
    if (atk.ammunitionItemId && atk.ammunitionQuantity !== undefined && atk.ammunitionQuantity <= 0) return;
    const bonus = atk.attackBonus;
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula: bonus >= 0 ? `1d20 + ${bonus}` : `1d20 - ${Math.abs(bonus)}`,
        expression: `1d20${signed(bonus)}`,
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

  const handleDamageRoll = (atk: AttackRow) => {
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

  const handleResolve = (atk: AttackRow) => {
    props.dispatchCommand?.(TrameCommand.ResolveAttack({ attackId: atk.id }));
    props.onCloseDrawer?.();
  };

  const button = (testId: string, label: string, aria: string, onClick: () => void, disabled = false) =>
    h('button', { type: 'button', class: 'ds-btn ds-btn-secondary ds-btn-sm', 'data-testid': testId, 'aria-label': aria, disabled, onClick }, label);

  return h(
    'div',
    { class: 'ds-attack-table-widget', 'data-testid': 'attack-action-table-widget' },
    h('h4', { class: 'ds-widget-title' }, t('sheet.attacks.title')),
    attacks.length === 0
      ? h('p', { class: 'ds-empty-state', 'data-testid': 'attacks-empty-state' }, t('sheet.attacks.empty'))
      : h(
          'table',
          { class: 'ds-attack-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col' }, t('sheet.attacks.name')),
              h('th', { scope: 'col' }, t('sheet.attacks.toHit')),
              h('th', { scope: 'col' }, t('sheet.attacks.damage')),
              h('th', { scope: 'col' }, t('sheet.attacks.action')),
            ),
          ),
          h(
            'tbody',
            null,
            attacks.map((atk) => {
              const isDepleted = atk.ammunitionItemId !== undefined && atk.ammunitionQuantity !== undefined && atk.ammunitionQuantity <= 0;
              const toHit =
                atk.attackBonus !== null
                  ? signed(atk.attackBonus)
                  : atk.save
                    ? t('sheet.attacks.saveDc', { dc: atk.save.dc, ability: atk.save.ability.toUpperCase() })
                    : '—';
              return h(
                'tr',
                { key: atk.id, class: 'ds-attack-row', 'data-testid': `attack-row-${atk.id}` },
                h(
                  'td',
                  null,
                  h('span', { class: 'ds-atk-name' }, atk.name),
                  isDepleted ? h('span', { class: 'ds-depleted-badge', 'data-testid': `depleted-badge-${atk.id}` }, t('sheet.attacks.depleted')) : null,
                ),
                h('td', { class: 'atlas-tabular-nums', 'data-testid': `attack-tohit-${atk.id}` }, toHit),
                h('td', { class: 'atlas-tabular-nums', 'data-testid': `attack-damage-${atk.id}` }, `${atk.damageFormula} ${atk.damageType ?? ''}`.trim()),
                h(
                  'td',
                  { class: 'ds-cluster' },
                  onTable
                    ? button(`btn-atk-resolve-${atk.id}`, t('sheet.attacks.target'), t('sheet.attacks.targetAria', { name: atk.name }), () => handleResolve(atk), isDepleted)
                    : null,
                  atk.attackBonus !== null
                    ? button(`btn-atk-roll-${atk.id}`, t('sheet.attacks.rollAttack'), t('sheet.attacks.rollAttackAria', { name: atk.name }), () => handleAttackRoll(atk), isDepleted)
                    : null,
                  button(`btn-dmg-roll-${atk.id}`, t('sheet.attacks.rollDamage'), t('sheet.attacks.rollDamageAria', { name: atk.name }), () => handleDamageRoll(atk)),
                ),
              );
            }),
          ),
        ),
  );
}
