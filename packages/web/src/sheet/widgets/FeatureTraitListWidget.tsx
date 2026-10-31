import { h, type VNode } from 'preact';
import { useSafeState } from '../safeHooks.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { CompendiumDragDropManager } from '../../compendium/CompendiumDragDropManager.ts';

export function FeatureTraitListWidget(props: WidgetProps): VNode<any> {
  const rawFeatures = Array.isArray(props.boundValues?.features) ? props.boundValues.features : [];
  const [expandedIds, setExpandedIds] = useSafeState<string[]>([]);
  const [isDragOver, setIsDragOver] = useSafeState(false);
  const dragManager = new CompendiumDragDropManager(props.options?.systemId as string ?? 'dnd5e', props.dispatchCommand, props.actorId);

  const toggle = (id: string) => {
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const handleKeyDown = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(id);
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
      class: `ds-features-widget ${isDragOver ? 'is-drag-over' : ''}`,
      'data-testid': 'feature-trait-list-widget',
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    h('h4', { class: 'ds-widget-title' }, 'Features & Traits'),
    h(
      'ul',
      { class: 'ds-features-list' },
      rawFeatures.map((feat: any) => {
        const id = String(feat.id ?? '');
        const isExpanded = expandedIds.includes(id);
        return h(
          'li',
          { key: id, class: 'ds-feature-item', 'data-testid': `feature-item-${id}` },
          h(
            'div',
            {
              class: 'ds-feature-header',
              'data-testid': `feature-header-${id}`,
              role: 'button',
              tabIndex: 0,
              'aria-expanded': isExpanded,
              'aria-label': `Toggle details for ${feat.name ?? 'Feature'}`,
              onClick: () => toggle(id),
              onKeyDown: (e: KeyboardEvent) => handleKeyDown(e, id),
            },
            h('strong', null, feat.name ?? 'Feature'),
            h('span', { class: 'ds-feature-source' }, ` (${feat.source ?? 'General'})`),
          ),
          isExpanded
            ? h(
                'p',
                { class: 'ds-feature-desc', 'data-testid': `feature-desc-${id}` },
                feat.description ?? feat.summary ?? '',
              )
            : null,
        );
      }),
    ),
  );
}
