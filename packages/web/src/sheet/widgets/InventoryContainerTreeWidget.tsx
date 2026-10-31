import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { CompendiumDragDropManager, calculateTotalInventoryWeight } from '../../compendium/CompendiumDragDropManager.ts';

export function InventoryContainerTreeWidget(props: WidgetProps): VNode<any> {
  const rawItems = Array.isArray(props.boundValues?.items)
    ? props.boundValues.items
    : Object.values((props.boundValues?.items as Record<string, any>) ?? {});
  const rawCurrency = (props.boundValues?.currency as Record<string, any>) ?? {};
  const strScore = Number(props.boundValues?.strScore ?? props.boundValues?.strength ?? 10);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragManager = new CompendiumDragDropManager(props.options?.systemId as string ?? 'dnd5e', props.dispatchCommand, props.actorId);

  const items = rawItems.map((it: any) => ({
    id: String(it.id ?? ''),
    name: String(it.name ?? 'Item'),
    quantity: Number(it.quantity ?? 1),
    unitWeight: Number(it.unitWeight ?? it.weightPounds ?? 0),
    containerId: it.containerId ?? null,
    isContainer: Boolean(it.isContainer),
    weightMultiplier: it.weightMultiplier ?? it.contentWeightMultiplier ?? 1.0,
  }));

  const totalWeight = calculateTotalInventoryWeight(items);
  const regLimit = strScore * 5;
  const heavyLimit = strScore * 10;
  const maxLimit = strScore * 15;
  const pct = maxLimit > 0 ? Math.min(100, Math.round((totalWeight / maxLimit) * 100)) : 0;

  const handleCurrencyChange = (currKey: string, val: number) => {
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `currency.${currKey}`,
        currency: currKey,
        value: Math.max(0, val),
      }),
    );
  };

  const handleQuantityChange = (itemId: string, delta: number, currentQty: number) => {
    const nextQty = Math.max(0, currentQty + delta);
    if (nextQty === 0) {
      handleDeleteItem(itemId);
    } else {
      props.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: `items.${itemId}.quantity`,
          itemId,
          quantity: nextQty,
          value: nextQty,
        }),
      );
    }
  };

  const handleMoveItem = (itemId: string, targetContainerId: string | null) => {
    dragManager.moveItem(itemId, targetContainerId, items);
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

  const handleDragStart = (e: DragEvent, itemId: string) => {
    const payload = {
      type: 'item_move',
      sourceItemId: itemId,
      systemId: props.options?.systemId as string ?? 'dnd5e',
      actorId: props.actorId,
    };
    if (e.dataTransfer) {
      e.dataTransfer.setData('application/json', JSON.stringify(payload));
    }
  };

  const handleContainerDrop = (e: DragEvent, targetContainerId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const payload = dragManager.parseDragEvent(e);
    if (payload) {
      dragManager.handleDrop(payload, targetContainerId, props.actorId);
    }
  };

  return h(
    'div',
    {
      class: `ds-inventory-widget ${isDragOver ? 'is-drag-over' : ''}`,
      'data-testid': 'inventory-container-tree-widget',
      onDragOver: (e: DragEvent) => { e.preventDefault(); setIsDragOver(true); },
      onDragLeave: () => setIsDragOver(false),
      onDrop: (e: DragEvent) => handleContainerDrop(e, null),
    },
    h('h4', { class: 'ds-widget-title' }, 'Inventory & Containers'),
    h(
      'div',
      { class: 'ds-currency-strip', 'data-testid': 'currency-strip' },
      ['cp', 'sp', 'ep', 'gp', 'pp'].map((den) =>
        h(
          'label',
          { key: den, class: 'ds-currency-label' },
          h('span', null, `${den.toUpperCase()}: `),
          h('input', {
            type: 'number',
            class: 'ds-currency-input atlas-tabular-nums',
            'data-testid': `currency-input-${den}`,
            'aria-label': `${den.toUpperCase()} currency`,
            value: Number(rawCurrency[den] ?? 0),
            onChange: (e: Event) => handleCurrencyChange(den, Number((e.target as HTMLInputElement).value)),
          }),
        ),
      ),
    ),
    h(
      'div',
      { class: 'ds-encumbrance-bar-container', 'data-testid': 'encumbrance-bar' },
      h(
        'span',
        { class: 'ds-encumbrance-label atlas-tabular-nums' },
        `Weight: ${totalWeight} / ${maxLimit} lb (Heavy: ${heavyLimit} lb)`,
      ),
      h(
        'div',
        { class: 'ds-encumbrance-track' },
        h('div', {
          class: 'ds-encumbrance-fill',
          style: { width: `${pct}%` },
        }),
      ),
    ),
    h(
      'ul',
      { class: 'ds-inventory-list' },
      items.map((item) =>
        h(
          'li',
          {
            key: item.id,
            class: `ds-inv-item-row ${item.isContainer ? 'is-container-node' : ''}`,
            'data-testid': `inv-item-${item.id}`,
            draggable: true,
            onDragStart: (e: DragEvent) => handleDragStart(e, item.id),
            onDragOver: (e: DragEvent) => { if (item.isContainer) e.preventDefault(); },
            onDrop: (e: DragEvent) => { if (item.isContainer) handleContainerDrop(e, item.id); },
          },
          h('span', { class: 'ds-item-name' }, item.name),
          h(
            'div',
            { class: 'ds-item-qty-controls' },
            h(
              'button',
              {
                type: 'button',
                class: 'ds-btn-qty-dec',
                'data-testid': `btn-qty-dec-${item.id}`,
                'aria-label': `Decrease ${item.name} quantity`,
                onClick: () => handleQuantityChange(item.id, -1, item.quantity),
              },
              '-',
            ),
            h('span', { class: 'ds-item-quantity atlas-tabular-nums' }, `x${item.quantity}`),
            h(
              'button',
              {
                type: 'button',
                class: 'ds-btn-qty-inc',
                'data-testid': `btn-qty-inc-${item.id}`,
                'aria-label': `Increase ${item.name} quantity`,
                onClick: () => handleQuantityChange(item.id, 1, item.quantity),
              },
              '+',
            ),
          ),
          h(
            'span',
            { class: 'ds-item-weight atlas-tabular-nums' },
            `${(item.unitWeight * item.quantity).toFixed(1)} lb`,
          ),
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
        ),
      ),
    ),
  );
}
