import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function InventoryContainerTreeWidget(props: WidgetProps): VNode {
  const rawItems = Array.isArray(props.boundValues?.items)
    ? props.boundValues.items
    : Object.values((props.boundValues?.items as Record<string, any>) ?? {});
  const rawCurrency = (props.boundValues?.currency as Record<string, any>) ?? {};

  const items = rawItems.map((it: any) => ({
    id: String(it.id ?? ''),
    name: String(it.name ?? 'Item'),
    quantity: Number(it.quantity ?? 1),
    unitWeight: Number(it.unitWeight ?? it.weightPounds ?? 0),
    containerId: it.containerId ?? null,
    isContainer: Boolean(it.isContainer),
    weightMultiplier: it.weightMultiplier ?? it.contentWeightMultiplier ?? 1.0,
  }));

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

  return h(
    'div',
    { class: 'ds-inventory-widget', 'data-testid': 'inventory-container-tree-widget' },
    h('h4', { class: 'ds-widget-title' }, 'Inventory & Containers'),
    h(
      'div',
      { class: 'ds-currency-strip', 'data-testid': 'currency-strip' },
      h('span', null, `GP: ${rawCurrency.gp ?? 0} `),
      h('span', null, `SP: ${rawCurrency.sp ?? 0} `),
      h('span', null, `CP: ${rawCurrency.cp ?? 0}`),
    ),
    h(
      'ul',
      { class: 'ds-inventory-list' },
      items.map((item) =>
        h(
          'li',
          { key: item.id, class: 'ds-inv-item-row', 'data-testid': `inv-item-${item.id}` },
          h('span', { class: 'ds-item-name' }, `${item.name} (x${item.quantity})`),
          h(
            'button',
            {
              type: 'button',
              class: 'ds-btn-del-item',
              'data-testid': `btn-del-item-${item.id}`,
              onClick: () => handleDeleteItem(item.id),
            },
            'Del',
          ),
        ),
      ),
    ),
  );
}
