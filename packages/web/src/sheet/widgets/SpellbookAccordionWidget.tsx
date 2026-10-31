import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { CompendiumDragDropManager } from '../../compendium/CompendiumDragDropManager.ts';

export function SpellbookAccordionWidget(props: WidgetProps): VNode<any> {
  const rawSlots = (props.boundValues?.slots as Record<string, any>) ?? {};
  const rawSpells = Array.isArray(props.boundValues?.spells) ? props.boundValues.spells : [];
  const autoDeductSlots = props.options?.autoDeductSlots !== false;
  const [isDragOver, setIsDragOver] = useState(false);
  const dragManager = new CompendiumDragDropManager(props.options?.systemId as string ?? 'dnd5e', props.dispatchCommand, props.actorId);

  const spells = rawSpells.map((s: any) => ({
    id: String(s.id ?? ''),
    name: String(s.name ?? 'Spell'),
    level: Number(s.level ?? 0),
    isAoE: Boolean(s.requiresAoE || s.isAoE || s.aoeTemplate),
    aoeTemplate: s.aoeTemplate ?? (s.requiresAoE ? { shape: 'circle', radiusFeet: 20 } : undefined),
  }));

  const handleToggleSlotPip = (slotKey: string, currentVal: number, maxVal: number) => {
    const nextVal = currentVal > 0 ? currentVal - 1 : maxVal;
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `slots.${slotKey}.current`,
        slotLevel: slotKey,
        current: nextVal,
        value: nextVal,
      }),
    );
  };

  const handleCast = (spell: (typeof spells)[0]) => {
    if (spell.isAoE) {
      if (props.isTableCanvasMounted === false) {
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

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const payload = dragManager.parseDragEvent(e);
    if (payload) {
      dragManager.handleDrop(payload, null, props.actorId);
    }
  };

  return h(
    'div',
    {
      class: `ds-spellbook-widget ${isDragOver ? 'is-drag-over' : ''}`,
      'data-testid': 'spellbook-accordion-widget',
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    h('h4', { class: 'ds-widget-title' }, 'Spellbook'),
    h(
      'div',
      { class: 'ds-spell-slots-container', 'data-testid': 'spell-slots-container' },
      Object.entries(rawSlots).map(([slotKey, slotData]: [string, any]) => {
        const current = Number(slotData?.current ?? slotData ?? 0);
        const max = Number(slotData?.max ?? slotData ?? current);
        return h(
          'div',
          { key: slotKey, class: 'ds-spell-slot-row', 'data-testid': `slot-row-${slotKey}` },
          h('span', { class: 'ds-slot-label' }, `${slotKey}: `),
          Array.from({ length: max }).map((_, pipIdx) =>
            h(
              'button',
              {
                key: `${slotKey}-pip-${pipIdx}`,
                type: 'button',
                class: `ds-slot-pip ${pipIdx < current ? 'is-available' : 'is-expended'}`,
                'data-testid': `slot-pip-${slotKey}-${pipIdx}`,
                'aria-label': `${slotKey} slot pip ${pipIdx + 1}`,
                'aria-pressed': pipIdx < current,
                onClick: () => handleToggleSlotPip(slotKey, current, max),
              },
            ),
          ),
          h('span', { class: 'ds-slot-count atlas-tabular-nums' }, `(${current}/${max})`),
        );
      }),
    ),
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
