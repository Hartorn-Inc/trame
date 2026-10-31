import { h, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { sanitizeHtml } from './NotesMarkdownPane.ts';

export function NotesMarkdownPaneWidget(props: WidgetProps): VNode<any> {
  const initialNotes = String(props.boundValues?.notes ?? props.boundValues?.markdownContent ?? '');
  const [text, setText] = useState(initialNotes);
  const timerRef = useRef<any>(null);

  const handleChange = (newVal: string) => {
    setText(newVal);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const sanitized = sanitizeHtml(newVal);
      props.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: 'notes',
          notes: sanitized,
          text: sanitized,
          value: sanitized,
        }),
      );
    }, 500);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return h(
    'div',
    { class: 'ds-notes-widget', 'data-testid': 'notes-markdown-pane-widget' },
    h('h4', { class: 'ds-widget-title' }, 'Notes & Biography'),
    h('textarea', {
      class: 'ds-notes-textarea',
      'data-testid': 'notes-textarea',
      'aria-label': 'Character Notes and Biography',
      rows: 8,
      value: text,
      onInput: (e: Event) => handleChange((e.target as HTMLTextAreaElement).value),
    }),
  );
}
