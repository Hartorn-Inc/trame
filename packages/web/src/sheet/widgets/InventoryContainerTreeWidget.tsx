import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

import { CompendiumDragDropManager, calculateTotalInventoryWeight } from '../../compendium/CompendiumDragDropManager.ts';

export function InventoryContainerTreeWidget(props: WidgetProps): VNode<any> {
  const rawItems = Array.isArray(props.boundValues?.items)
    ? props.boundValues.items
    : Object.values((props.boundValues?.items as Record<string, any>) ?? {});
  const rawCurrency = (props.boundValues?.currency as Record<string, any>) ?? {};

  const items = rawItems.map((it: any) => ({
    isAttuned: Boolean(it.isAttuned),
    requiresAttunement: Boolean(it.requiresAttunement),
    id: String(it.id ?? ''),
    name: String(it.name ?? 'Item'),
    quantity: Number(it.quantity ?? 1),
    unitWeight: Number(it.unitWeight ?? it.weightPounds ?? 0),
    containerId: it.containerId ?? null,
    isContainer: Boolean(it.isContainer),
    weightMultiplier: it.weightMultiplier ?? it.contentWeightMultiplier ?? 1.0,
  }));

  const dragManager = new CompendiumDragDropManager((props as any).systemId ?? 'dnd5e');
  const totalCarriedWeight = calculateTotalInventoryWeight(items);
  const attunedCount = items.filter((it) => it.isAttuned).length;
  const rawStr = props.boundValues?.strength ?? props.boundValues?.str ?? (props.boundValues?.abilities as any)?.str;
  const strScore = typeof rawStr === 'number' ? rawStr : typeof rawStr?.score === 'number' ? rawStr.score : Number(props.boundValues?.strengthScore ?? 10);
  const regularEncumbrance = strScore * 5;
  const heavyEncumbrance = strScore * 10;
  const maxCapacity = strScore * 15;

  const handleMoveItem = (itemId: string, targetContainerId: string | null) => {
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `items.${itemId}.containerId`,
        itemId,
        containerId: targetContainerId,
        targetContainerId,
        value: targetContainerId,
      }),
    );
  };

  const handleDeleteItem = (itemId: string) => {
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: 'items',
        itemId,
        removeItemId: itemId,
        action: 'delete',
      }),
    );
  };

  const handleToggleAttunement = (item: (typeof items)[0]) => {
    if (!item.isAttuned && attunedCount >= 3) {
      props.dispatchCommand?.({
        cmd: 'NOTIFICATION',
        type: 'warning',
        message: 'Cannot attune more than 3 items.',
      });
      return;
    }
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `items.${item.id}.isAttuned`,
        itemId: item.id,
        isAttuned: !item.isAttuned,
        value: !item.isAttuned,
      }),
    );
  };

  const handleDropItem = (e: DragEvent, targetContainerId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const payload = dragManager.parseDragEvent(e);
    if (!payload) return;

    if (payload.type === 'item_move' || payload.sourceItemId) {
      const sourceItemId = String(payload.sourceItemId ?? payload.id ?? '');
      const valid = CompendiumDragDropManager.validateMove(sourceItemId, targetContainerId, items);
      if (!valid) {
        props.dispatchCommand?.({
          cmd: 'NOTIFICATION',
          type: 'error',
          message: 'Cannot move container into itself or its descendant.',
        });
        return;
      }
      handleMoveItem(sourceItemId, targetContainerId);
    } else {
      dragManager.handleDrop(payload, targetContainerId, props.actorId);
    }
  };

  return h(
    'div',
    { class: 'ds-inventory-widget', 'data-testid': 'inventory-container-tree-widget' },
    h('h4', { class: 'ds-widget-title' }, 'Inventory & Containers'),
    h(
      'div',
      { class: 'ds-currency-strip', 'data-testid': 'currency-strip' },
      h('span', null, `PP: ${rawCurrency.pp ?? 0} `),
      h('span', null, `GP: ${rawCurrency.gp ?? 0} `),
      h('span', null, `EP: ${rawCurrency.ep ?? 0} `),
      h('span', null, `SP: ${rawCurrency.sp ?? 0} `),
      h('span', null, `CP: ${rawCurrency.cp ?? 0}`),
    ),
    h(
      'div',
      { class: 'ds-encumbrance-bar-container', 'data-testid': 'encumbrance-bar' },
      h(
        'div',
        { class: 'ds-encumbrance-labels' },
        h('span', null, `Weight: ${totalCarriedWeight.toFixed(1)} / ${maxCapacity} lb `),
        h('span', null, `(Enc: ${regularEncumbrance} lb, Heavy: ${heavyEncumbrance} lb)`),
        h('span', { class: 'ds-attunement-label' }, ` | Attuned: ${attunedCount}/3`),
      ),
      h(
        'div',
        { class: 'ds-encumbrance-track' },
        h('div', {
          class: 'ds-encumbrance-fill',
          'data-testid': 'encumbrance-fill',
          style: {
            width: `${Math.min(100, Math.round((totalCarriedWeight / maxCapacity) * 100))}%`,
            backgroundColor: totalCarriedWeight > heavyEncumbrance ? 'var(--atlas-danger)' : totalCarriedWeight > regularEncumbrance ? 'var(--atlas-action)' : 'var(--atlas-border)',
          },
        }),
      ),
    ),
    h(
      'div',
      {
        class: 'ds-inventory-root-dropzone',
        'data-testid': 'inventory-root-dropzone',
        onDragOver: (e: DragEvent) => e.preventDefault(),
        onDrop: (e: DragEvent) => handleDropItem(e, null),
      },
      h(
        'ul',
        { class: 'ds-inventory-list' },
        items.map((item) => {
          const isContainer = Boolean(item.isContainer);
          return h(
            'li',
            {
              key: item.id,
              class: `ds-inv-item-row ${isContainer ? 'is-container' : ''}`,
              'data-testid': `inv-item-${item.id}`,
              onDragOver: isContainer ? (e: DragEvent) => e.preventDefault() : undefined,
              onDrop: isContainer ? (e: DragEvent) => handleDropItem(e, item.id) : undefined,
            },
            h('span', { class: 'ds-item-name' }, `${item.name} (x${item.quantity}) - ${item.unitWeight} lb`),
            (item.requiresAttunement || item.isAttuned)
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: `ds-btn-attune ${item.isAttuned ? 'is-attuned' : ''}`,
                    'data-testid': `btn-attune-${item.id}`,
                    'aria-label': `Toggle attunement for ${item.name}`,
                    'aria-pressed': item.isAttuned ? 'true' : 'false',
                    onClick: () => handleToggleAttunement(item),
                  },
                  item.isAttuned ? 'Attuned' : 'Attune',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                class: 'ds-btn-del-item',
                'data-testid': `btn-del-item-${item.id}`,
                'aria-label': `Delete ${item.name}`,
                onClick: () => handleDeleteItem(item.id),
              },
              'Del',
            ),
          );
        }),
      ),
    ),
  );
}
