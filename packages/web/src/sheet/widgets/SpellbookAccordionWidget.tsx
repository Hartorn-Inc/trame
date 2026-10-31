import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function SpellbookAccordionWidget(props: WidgetProps): VNode {
  const rawSlots = (props.boundValues?.slots as Record<string, any>) ?? {};
  const rawSpells = Array.isArray(props.boundValues?.spells) ? props.boundValues.spells : [];
  const autoDeductSlots = props.options?.autoDeductSlots !== false;

  const spells = rawSpells.map((s: any) => ({
    id: String(s.id ?? ''),
    name: String(s.name ?? 'Spell'),
    level: Number(s.level ?? 0),
    isAoE: Boolean(s.requiresAoE || s.isAoE || s.aoeTemplate),
    aoeTemplate: s.aoeTemplate ?? (s.requiresAoE ? { shape: 'circle', radiusFeet: 20 } : undefined),
  }));

  const handleCast = (spell: (typeof spells)[0]) => {
    if (spell.isAoE) {
      if (props.isTableCanvasMounted === false) {
        // Canvas not mounted
        props.dispatchCommand?.({
          cmd: 'NOTIFICATION',
          type: 'warning',
          message: 'TableCanvas is not mounted; unable to project AoE template.',
        });
        return;
      }
      props.dispatchCommand?.(
        TrameCommand.ProjectAoE({
          spellId: spell.id,
          name: spell.name,
          level: spell.level,
          aoeShape: spell.aoeTemplate,
          template: spell.aoeTemplate,
        }),
      );
      props.onCloseDrawer?.();
    } else {
      props.dispatchCommand?.(
        TrameCommand.RollDice({
          formula: '1d20',
          expression: '1d20',
          spellId: spell.id,
          name: spell.name,
          visibility: 'PUBLIC',
          reason: `Cast spell: ${spell.name}`,
        }),
      );
    }

    if (autoDeductSlots && spell.level > 0) {
      const slotKey = `level${spell.level}`;
      const currentSlot = rawSlots[slotKey]?.current ?? 1;
      const nextVal = Math.max(0, currentSlot - 1);
      props.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: `slots.${slotKey}.current`,
          slotLevel: spell.level,
          current: nextVal,
          value: nextVal,
          delta: -1,
        }),
      );
    }
  };

  return h(
    'div',
    { class: 'ds-spellbook-widget', 'data-testid': 'spellbook-accordion-widget' },
    h('h4', { class: 'ds-widget-title' }, 'Spellbook'),
    h(
      'div',
      { class: 'ds-spell-list' },
      spells.map((spell) =>
        h(
          'div',
          { key: spell.id, class: 'ds-spell-item', 'data-testid': `spell-item-${spell.id}` },
          h('span', { class: 'ds-spell-title' }, `${spell.name} (Lvl ${spell.level})`),
          h(
            'button',
            {
              type: 'button',
              class: 'ds-btn-cast-spell',
              'data-testid': `btn-cast-spell-${spell.id}`,
              onClick: () => handleCast(spell),
            },
            spell.isAoE ? 'Cast / Project AoE' : 'Cast',
          ),
        ),
      ),
    ),
  );
}
