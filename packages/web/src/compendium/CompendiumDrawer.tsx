import { h, type VNode } from 'preact';
import { useSafeState } from '../sheet/safeHooks.ts';
import type { CommandDispatcher } from '../sheet/types.ts';
import { CompendiumDragDropManager } from './CompendiumDragDropManager.ts';

export interface CompendiumEntry {
  id: string;
  slug: string;
  name: string;
  entityType: 'item' | 'spell' | 'feat' | 'monster' | string;
  tier?: string;
  data?: Record<string, unknown>;
}

export interface CompendiumDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  entries?: CompendiumEntry[];
  systemId?: string;
  dispatchCommand?: CommandDispatcher;
  actorId?: string;
  targetContainerId?: string | null;
  onDragStart?: (entry: CompendiumEntry, event: DragEvent) => void;
}

const CATEGORIES = ['all', 'item', 'spell', 'feat', 'monster'] as const;

export function CompendiumDrawer(props: CompendiumDrawerProps): VNode<any> | null {
  if (!props.isOpen) return null;

  const [query, setQuery] = useSafeState('');
  const [category, setCategory] = useSafeState<string>('all');
  const entries = props.entries ?? [];
  const dragManager = new CompendiumDragDropManager({
    systemId: props.systemId ?? 'dnd5e',
    dispatchCommand: props.dispatchCommand,
    actorId: props.actorId,
  });

  const filtered = entries.filter((entry) => {
    if (category !== 'all' && entry.entityType !== category) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return entry.name.toLowerCase().includes(q) || entry.slug.toLowerCase().includes(q);
  });

  const handleAddEntry = (entry: CompendiumEntry) => {
    const targetContainerId = props.targetContainerId ?? null;
    dragManager.handleDrop({
      systemId: props.systemId ?? 'dnd5e',
      entryRef: entry.id || entry.slug,
      entryType: entry.entityType,
      data: entry.data,
      actorId: props.actorId,
      targetContainerId,
    }, targetContainerId, props.actorId);
  };

  const handleDragStart = (entry: CompendiumEntry, e: DragEvent) => {
    const targetContainerId = props.targetContainerId ?? null;
    const payload = {
      systemId: props.systemId ?? 'dnd5e',
      entryRef: entry.id || entry.slug,
      entryType: entry.entityType,
      data: entry.data,
      actorId: props.actorId,
      targetContainerId,
    };
    if (e.dataTransfer) {
      e.dataTransfer.setData('application/json', dragManager.createDragData(payload));
    }
    props.onDragStart?.(entry, e);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
    }
  };

  return h(
    'aside',
    {
      class: 'ds-compendium-drawer',
      'data-testid': 'compendium-drawer',
      'aria-label': 'Compendium Drawer',
      onKeyDown: handleKeyDown,
    },
    h(
      'header',
      { class: 'ds-drawer-header' },
      h('h3', null, 'Compendium'),
      h('button', { type: 'button', class: 'ds-btn-close', 'data-testid': 'btn-close-compendium', 'aria-label': 'Close compendium', onClick: props.onClose }, 'Close'),
    ),
    h(
      'div',
      { class: 'ds-compendium-search-bar' },
      h('input', {
        type: 'text',
        class: 'ds-input-search',
        'data-testid': 'compendium-search-input',
        'aria-label': 'Search compendium entries',
        placeholder: 'Search items, spells, feats...',
        value: query,
        onInput: (e: Event) => setQuery((e.target as HTMLInputElement).value),
      }),
    ),
    h(
      'div',
      { class: 'ds-compendium-tabs', role: 'tablist', 'aria-label': 'Compendium categories' },
      CATEGORIES.map((cat) =>
        h(
          'button',
          {
            key: cat,
            id: `compendium-tab-btn-${cat}`,
            type: 'button',
            role: 'tab',
            class: `ds-tab-btn ${category === cat ? 'is-active' : ''}`,
            'data-testid': `compendium-tab-${cat}`,
            'aria-selected': category === cat ? 'true' : 'false',
            'aria-controls': 'compendium-tabpanel',
            onClick: () => setCategory(cat),
          },
          cat.toUpperCase(),
        ),
      ),
    ),
    h(
      'div',
      {
        id: 'compendium-tabpanel',
        role: 'tabpanel',
        'aria-labelledby': `compendium-tab-btn-${category}`,
        class: 'ds-compendium-tabpanel',
      },
      filtered.length === 0
        ? h('p', { class: 'ds-empty-state', 'data-testid': 'compendium-empty-state' }, 'No compendium entries found matching your query.')
        : h(
            'ul',
            { class: 'ds-compendium-entry-list', 'data-testid': 'compendium-entry-list' },
            filtered.map((entry) =>
              h(
                'li',
                {
                  key: entry.id,
                  class: 'ds-compendium-entry-card',
                  'data-testid': `compendium-entry-${entry.slug}`,
                  draggable: true,
                  onDragStart: (e: DragEvent) => handleDragStart(entry, e),
                },
                h('strong', { class: 'ds-entry-name' }, entry.name),
                h('span', { class: 'ds-entry-type' }, ` [${entry.entityType}] `),
                h('span', { class: 'ds-entry-tier' }, entry.tier),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'ds-btn-add-entry',
                    'data-testid': `btn-add-entry-${entry.slug}`,
                    'aria-label': `Add ${entry.name} to character sheet`,
                    onClick: (e: Event) => {
                      e.stopPropagation();
                      handleAddEntry(entry);
                    },
                  },
                  '[ Add ]',
                ),
              ),
            ),
          ),
    ),
  );
}
