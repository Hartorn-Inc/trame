import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function FeatureTraitListWidget(props: WidgetProps): VNode<any> {
  const rawFeatures = Array.isArray(props.boundValues?.features) ? props.boundValues.features : [];
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const toggle = (id: string) => {
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  return h(
    'div',
    { class: 'ds-features-widget', 'data-testid': 'feature-trait-list-widget' },
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
              'aria-expanded': isExpanded ? 'true' : 'false',
              'aria-label': `Toggle details for ${feat.name ?? 'Feature'}`,
              onClick: () => toggle(id),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(id);
                }
              },
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
