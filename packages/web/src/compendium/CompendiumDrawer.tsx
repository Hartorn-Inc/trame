/**
 * ============================================================================
 * COMPENDIUM DRAWER: SEARCH, ADD, STAT BLOCKS & MONSTER SPAWN (CompendiumDrawer.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Searchable list of compendium entries (the full SRD 5.2.1 catalog once
 * `installFullSystemSrd()` resolved, plus instance and campaign tiers). Items,
 * spells and feats are added to the open sheet; monsters show their real
 * stat block and, for the GM, a "Spawn on table" button.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Bounded Result List`:
 *    - At most `MAX_VISIBLE_ENTRIES` (50) cards render; the full SRD holds
 *      about a thousand entries, so the rest is reached by searching.
 * 2. `Server-Owned Monster Numbers`:
 *    - A spawned SRD monster sends only its reference (`srd:monster:<slug>`)
 *      in `stat_block`; the server copies its own pack stat block onto the
 *      token and derives HP, AC, speed, senses, size and affinities from it.
 *      Non-SRD monsters send their stat block object, which the server
 *      validates against the same bounds before accepting it.
 * 3. `GM-Only Spawn`:
 *    - The spawn button renders only when the host passes `onSpawnMonster`
 *      (GM with a loaded table); the server rejects `SPAWN_TOKEN` from
 *      players regardless.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import type { WirePoint2D, WireTrameCommand } from '../api/wire.ts';
import type { MonsterStatBlock } from '../../../game-systems/dnd5e/src/index.ts';
import { useSafeState } from '../sheet/safeHooks.ts';
import type { CommandDispatcher } from '../sheet/types.ts';
import { spawnToken } from '../table/commands.ts';
import { CompendiumDragDropManager } from './CompendiumDragDropManager.ts';
import { isMonsterStatBlock, MonsterStatBlockView } from './MonsterStatBlockView.tsx';
import { t, type MessageKey } from '../i18n/index.ts';

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
  /** GM spawn of a monster entry on the live table; the button is hidden when absent. */
  onSpawnMonster?: (entry: CompendiumEntry) => void;
}

/** Cards rendered at once; narrower searches reach the rest (banner invariant 1). */
export const MAX_VISIBLE_ENTRIES = 50;

/** The entry's `MonsterStatBlock`, or `null` for non-monsters and stat-less monsters. */
export function monsterStatBlockOf(entry: CompendiumEntry): MonsterStatBlock | null {
  const block = entry.entityType === 'monster' ? entry.data?.statBlock : undefined;
  return isMonsterStatBlock(block) ? block : null;
}

/**
 * `SPAWN_TOKEN` for a monster entry (banner invariant 2): SRD entries send
 * their reference, other tiers the stat block object. The vitals are the
 * stat block's own numbers; the server overwrites them from its copy anyway.
 * The token arrives hidden from players so the GM can stage an encounter and
 * reveal it from the token menu.
 */
export function monsterSpawnCommand(
  entry: CompendiumEntry,
  statBlock: MonsterStatBlock,
  name: string,
  topLeft: WirePoint2D,
  tokenId: string,
): WireTrameCommand {
  return spawnToken({
    tokenId,
    actorId: null,
    name,
    ownerUserId: null,
    topLeft,
    hp: statBlock.hitPoints.average,
    maxHp: statBlock.hitPoints.average,
    ac: statBlock.armorClass.value,
    dexMod: Math.floor((statBlock.abilities.dex - 10) / 2),
    speedFt: statBlock.speed.walk,
    statBlock: entry.tier === 'SYSTEM_SRD' ? entry.id : (statBlock as unknown as Record<string, unknown>),
    gmHidden: true,
  });
}

const CATEGORIES = ['all', 'item', 'spell', 'feat', 'monster'] as const;

const CATEGORY_LABEL_KEYS: Record<(typeof CATEGORIES)[number], MessageKey> = {
  all: 'compendium.category.all',
  item: 'compendium.category.item',
  spell: 'compendium.category.spell',
  feat: 'compendium.category.feat',
  monster: 'compendium.category.monster',
};

export function CompendiumDrawer(props: CompendiumDrawerProps): VNode<any> | null {
  if (!props.isOpen) return null;

  const [query, setQuery] = useSafeState('');
  const [category, setCategory] = useSafeState<string>('all');
  const [openStatBlockId, setOpenStatBlockId] = useSafeState<string | null>(null);
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
  const visible = filtered.slice(0, MAX_VISIBLE_ENTRIES);

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
      if (typeof e.stopPropagation === 'function') {
        e.stopPropagation();
      }
      props.onClose();
    }
  };

  return h(
    'aside',
    {
      class: 'ds-compendium-drawer',
      'data-testid': 'compendium-drawer',
      'aria-label': t('compendium.drawer'),
      onKeyDown: handleKeyDown,
    },
    h(
      'header',
      { class: 'ds-drawer-header' },
      h('h3', null, t('compendium.title')),
      h('button', { type: 'button', class: 'ds-btn-close', 'data-testid': 'btn-close-compendium', 'aria-label': t('compendium.close'), onClick: props.onClose }, t('action.close')),
    ),
    h(
      'div',
      { class: 'ds-compendium-search-bar' },
      h('input', {
        type: 'text',
        class: 'ds-input-search',
        'data-testid': 'compendium-search-input',
        'aria-label': t('compendium.searchLabel'),
        placeholder: t('compendium.searchPlaceholder'),
        value: query,
        onInput: (e: Event) => setQuery((e.target as HTMLInputElement).value),
      }),
    ),
    h(
      'div',
      { class: 'ds-compendium-tabs', role: 'tablist', 'aria-label': t('compendium.categories') },
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
          t(CATEGORY_LABEL_KEYS[cat]),
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
        ? h('p', { class: 'ds-empty-state', 'data-testid': 'compendium-empty-state' }, t('compendium.empty'))
        : h(
            'ul',
            { class: 'ds-compendium-entry-list', 'data-testid': 'compendium-entry-list' },
            visible.map((entry) => {
              const statBlock = monsterStatBlockOf(entry);
              const statBlockOpen = statBlock !== null && openStatBlockId === entry.id;
              const statBlockDomId = `compendium-stat-block-${entry.slug.replace(/[^a-z0-9_-]/gi, '-')}`;
              return h(
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
                    'aria-label': t('compendium.addAria', { name: entry.name }),
                    onClick: (e: Event) => {
                      if (typeof e?.stopPropagation === 'function') {
                        e.stopPropagation();
                      }
                      handleAddEntry(entry);
                    },
                  },
                  t('compendium.add'),
                ),
                statBlock
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'ds-btn ds-btn-ghost ds-btn-sm',
                        'data-testid': `btn-stat-block-${entry.slug}`,
                        'aria-expanded': statBlockOpen ? 'true' : 'false',
                        'aria-controls': statBlockDomId,
                        onClick: () => setOpenStatBlockId(statBlockOpen ? null : entry.id),
                      },
                      t(statBlockOpen ? 'compendium.hideStatBlock' : 'compendium.showStatBlock'),
                    )
                  : null,
                statBlock && props.onSpawnMonster
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'ds-btn ds-btn-secondary ds-btn-sm',
                        'data-testid': `btn-spawn-${entry.slug}`,
                        'aria-label': t('compendium.spawnAria', { name: entry.name }),
                        onClick: () => props.onSpawnMonster?.(entry),
                      },
                      t('compendium.spawn'),
                    )
                  : null,
                statBlockOpen
                  ? h(MonsterStatBlockView, { statBlock, id: statBlockDomId, testId: `stat-block-${entry.slug}` })
                  : null,
              );
            }),
          ),
    ),
    filtered.length > visible.length
      ? h(
          'p',
          { class: 'ds-hint', role: 'status', 'data-testid': 'compendium-truncated' },
          t('compendium.truncated', { shown: visible.length, total: filtered.length }),
        )
      : null,
  );
}
