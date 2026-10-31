import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import type { CompendiumEntry } from '../../../../packages/game-systems/dnd5e/src/compendium.ts';
import type { CommandDispatcher } from '../sheet/types.ts';
import { CompendiumDragDropManager } from './CompendiumDragDropManager.ts';

export interface CompendiumDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  entries?: CompendiumEntry[];
  systemId?: string;
  dispatchCommand?: CommandDispatcher;
  actorId?: string;
  onDragStart?: (entry: CompendiumEntry, event: DragEvent) => void;
}

const CATEGORIES = ['all', 'item', 'spell', 'feat', 'monster'] as const;

export function CompendiumDrawer(props: CompendiumDrawerProps): VNode<any> | null {
  if (!props.isOpen) return null;

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
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
    dragManager.handleDrop({
      systemId: props.systemId ?? 'dnd5e',
      entryRef: entry.id || entry.slug,
      entryType: entry.entityType,
      data: entry.data,
      actorId: props.actorId,
    }, null, props.actorId);
  };

  const handleDragStart = (entry: CompendiumEntry, e: DragEvent) => {
    const payload = {
      systemId: props.systemId ?? 'dnd5e',
      entryRef: entry.id || entry.slug,
      entryType: entry.entityType,
      data: entry.data,
      actorId: props.actorId,
    };
    if (e.dataTransfer) {
      e.dataTransfer.setData('application/json', dragManager.createDragData(payload));
    }
    props.onDragStart?.(entry, e);
  };

  return h(
    'aside',
    { class: 'ds-compendium-drawer', 'data-testid': 'compendium-drawer', 'aria-label': 'Compendium Drawer' },
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
            type: 'button',
            role: 'tab',
            class: `ds-tab-btn ${category === cat ? 'is-active' : ''}`,
            'data-testid': `compendium-tab-${cat}`,
            'aria-selected': category === cat ? 'true' : 'false',
            'aria-pressed': category === cat ? 'true' : 'false',
            onClick: () => setCategory(cat),
          },
          cat.toUpperCase(),
        ),
      ),
    ),
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
  );
}
