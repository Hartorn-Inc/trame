import { h, type VNode } from 'preact';
import { useSafeEffect, useSafeRef, useSafeState } from '../safeHooks.ts';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function sanitizeHtml(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, '');
}

export function NotesMarkdownPaneWidget(props: WidgetProps): VNode<any> {
  const initialNotes = String(props.boundValues?.notes ?? props.boundValues?.markdownContent ?? '');
  const [text, setText] = useSafeState(initialNotes);
  const timerRef = useSafeRef<any>(null);

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

  useSafeEffect(() => {
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
      'aria-label': 'Notes and biography',
      rows: 8,
      value: text,
      onInput: (e: Event) => handleChange((e.target as HTMLTextAreaElement).value),
    }),
  );
}
