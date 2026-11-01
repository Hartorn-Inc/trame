import { h, type VNode } from 'preact';
import { t } from '../../i18n/index.ts';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { CompendiumDragDropManager, calculateTotalInventoryWeight } from '../../compendium/CompendiumDragDropManager.ts';

const CURRENCY_DENOMINATIONS = [
  { key: 'pp', labelKey: 'sheet.currency.pp' },
  { key: 'gp', labelKey: 'sheet.currency.gp' },
  { key: 'ep', labelKey: 'sheet.currency.ep' },
  { key: 'sp', labelKey: 'sheet.currency.sp' },
  { key: 'cp', labelKey: 'sheet.currency.cp' },
] as const;

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

  const dragManager = new CompendiumDragDropManager({
    systemId: (props as any).systemId ?? 'dnd5e',
    dispatchCommand: props.dispatchCommand,
    actorId: props.actorId,
    items,
  });
  const totalCarriedWeight = calculateTotalInventoryWeight(items);
  const attunedCount = items.filter((it) => it.isAttuned).length;
  const rawStr = props.boundValues?.strength ?? props.boundValues?.str ?? (props.boundValues?.abilities as any)?.str;
  const hasResolvedStr = typeof rawStr === 'number' || typeof rawStr?.score === 'number' || typeof props.boundValues?.strengthScore === 'number';
  const strScore = typeof rawStr === 'number' ? rawStr : typeof rawStr?.score === 'number' ? rawStr.score : Number(props.boundValues?.strengthScore ?? 10);
  const regularEncumbrance = strScore * 5;
  const heavyEncumbrance = strScore * 10;
  const maxCapacity = strScore * 15;

  const handleCurrencyChange = (denomination: string, val: number) => {
    const cleanVal = Math.max(0, Math.floor(Number.isNaN(val) ? 0 : val));
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `currency.${denomination}`,
        currency: {
          ...rawCurrency,
          [denomination]: cleanVal,
        },
        value: cleanVal,
      }),
    );
  };

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
        message: t('sheet.inventory.attuneLimit'),
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

  const handleItemDragStart = (item: (typeof items)[0], e: DragEvent) => {
    const payload = {
      type: 'item_move',
      sourceItemId: item.id,
      id: item.id,
      sourceContainerId: item.containerId,
      systemId: (props as any).systemId ?? 'dnd5e',
    };
    if (e.dataTransfer) {
      e.dataTransfer.setData('application/json', JSON.stringify(payload));
    }
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
          message: t('sheet.inventory.invalidMove'),
        });
        return;
      }
      handleMoveItem(sourceItemId, targetContainerId);
    } else {
      dragManager.handleDrop(payload, targetContainerId, props.actorId);
    }
  };

  const containerIds = new Set(items.filter((it) => it.isContainer).map((it) => it.id));
  const rootItems = items.filter((it) => !it.containerId || !containerIds.has(it.containerId));

  const renderItemRow = (item: (typeof items)[0], depth: number): VNode<any> => {
    const isContainer = Boolean(item.isContainer);
    const childItems = isContainer ? items.filter((child) => child.containerId === item.id) : [];
    const dropTargetContainerId = isContainer ? item.id : item.containerId;

    return h(
      'li',
      {
        key: item.id,
        class: `ds-inv-item-row ${isContainer ? 'is-container' : ''} ${depth > 0 ? 'is-nested' : ''}`,
        'data-testid': `inv-item-${item.id}`,
        'data-container-id': item.containerId ?? 'root',
        'data-depth': String(depth),
        draggable: true,
        onDragStart: (e: DragEvent) => handleItemDragStart(item, e),
        onDragOver: (e: DragEvent) => e.preventDefault(),
        onDrop: (e: DragEvent) => handleDropItem(e, dropTargetContainerId),
      },
      h(
        'span',
        { class: 'ds-item-name atlas-tabular-nums' },
        t('sheet.inventory.itemLabel', {
          prefix: depth > 0 ? '↳ ' : '',
          name: item.name,
          quantity: item.quantity,
          weight: item.unitWeight,
        }),
      ),
      item.containerId
        ? h(
            'button',
            {
              type: 'button',
              class: 'ds-btn-unpack-item',
              'data-testid': `btn-unpack-${item.id}`,
              'aria-label': t('sheet.inventory.unpackAria', { name: item.name }),
              onClick: () => handleMoveItem(item.id, null),
            },
            t('sheet.inventory.unpack'),
          )
        : null,
      (item.requiresAttunement || item.isAttuned)
        ? h(
            'button',
            {
              type: 'button',
              class: `ds-btn-attune ${item.isAttuned ? 'is-attuned' : ''}`,
              'data-testid': `btn-attune-${item.id}`,
              'aria-label': t('sheet.inventory.attuneAria', { name: item.name }),
              'aria-pressed': item.isAttuned ? 'true' : 'false',
              onClick: () => handleToggleAttunement(item),
            },
            t(item.isAttuned ? 'sheet.inventory.attuned' : 'sheet.inventory.attune'),
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'ds-btn-del-item',
          'data-testid': `btn-del-item-${item.id}`,
          'aria-label': t('sheet.inventory.deleteAria', { name: item.name }),
          onClick: () => handleDeleteItem(item.id),
        },
        t('sheet.inventory.delete'),
      ),
      isContainer && childItems.length > 0
        ? h(
            'ul',
            {
              class: 'ds-container-children-list',
              'data-testid': `container-children-${item.id}`,
            },
            childItems.map((child) => renderItemRow(child, depth + 1)),
          )
        : null,
    );
  };

  return h(
    'div',
    { class: 'ds-inventory-widget', 'data-testid': 'inventory-container-tree-widget' },
    h('h4', { class: 'ds-widget-title' }, t('sheet.inventory.title')),
    h(
      'div',
      { class: 'ds-currency-strip atlas-tabular-nums', 'data-testid': 'currency-strip' },
      CURRENCY_DENOMINATIONS.map(({ key, labelKey }) => {
        const label = t(labelKey);
        return h(
          'label',
          { key, class: 'ds-currency-item atlas-tabular-nums' },
          h('span', { class: 'ds-currency-label' }, `${label}: `),
          h('input', {
            type: 'number',
            min: 0,
            class: 'ds-currency-input atlas-tabular-nums',
            'data-testid': `currency-input-${key}`,
            'aria-label': t('sheet.inventory.currencyAria', { label }),
            value: Number(rawCurrency[key] ?? 0),
            onChange: (e: Event) =>
              handleCurrencyChange(key, Number((e.target as HTMLInputElement).value)),
          }),
        );
      }),
    ),
    h(
      'div',
      { class: 'ds-encumbrance-bar-container', 'data-testid': 'encumbrance-bar' },
      h(
        'div',
        { class: 'ds-encumbrance-labels atlas-tabular-nums' },
        h('span', { class: 'atlas-tabular-nums' }, t('sheet.inventory.weight', { carried: totalCarriedWeight.toFixed(1), max: maxCapacity })),
        h(
          'span',
          { class: 'atlas-tabular-nums' },
          t('sheet.inventory.encumbrance', {
            regular: regularEncumbrance,
            heavy: heavyEncumbrance,
            suffix: hasResolvedStr ? '' : t('sheet.inventory.defaultStr'),
          }),
        ),
        h('span', { class: 'ds-attunement-label atlas-tabular-nums' }, t('sheet.inventory.attunedCount', { count: attunedCount })),
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
        rootItems.map((item) => renderItemRow(item, 0)),
      ),
    ),
  );
}
