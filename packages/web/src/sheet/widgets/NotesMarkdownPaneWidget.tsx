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

function resolveFieldPath(bindingPath: string | undefined, fallbackPath: string): string {
  if (!bindingPath || typeof bindingPath !== 'string') {
    return fallbackPath;
  }
  return bindingPath.startsWith('sheet.') ? bindingPath.slice(6) : bindingPath;
}

export function NotesMarkdownPaneWidget(props: WidgetProps): VNode<any> {
  const initialNotes = String(props.boundValues?.notes ?? props.boundValues?.markdownContent ?? '');
  const initialBio = String(props.boundValues?.bio ?? props.boundValues?.biography ?? '');
  const [text, setText] = useSafeState(initialNotes);
  const [bio, setBio] = useSafeState(initialBio);
  const timerRef = useSafeRef<any>(null);
  const bioTimerRef = useSafeRef<any>(null);
  const pendingValueRef = useSafeRef<string | null>(null);
  const pendingBioRef = useSafeRef<string | null>(null);

  const notesPath = resolveFieldPath(props.bindings?.notes, 'notes');
  const bioPath = resolveFieldPath(props.bindings?.bio, 'bio');

  const flushPendingNotes = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingValueRef.current !== null) {
      const sanitized = sanitizeHtml(pendingValueRef.current);
      pendingValueRef.current = null;
      props.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: notesPath,
          notes: sanitized,
          text: sanitized,
          value: sanitized,
        }),
      );
    }
  };

  const flushPendingBio = () => {
    if (bioTimerRef.current) {
      clearTimeout(bioTimerRef.current);
      bioTimerRef.current = null;
    }
    if (pendingBioRef.current !== null) {
      const sanitized = sanitizeHtml(pendingBioRef.current);
      pendingBioRef.current = null;
      props.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: bioPath,
          bio: sanitized,
          text: sanitized,
          value: sanitized,
        }),
      );
    }
  };

  const handleChange = (newVal: string) => {
    setText(newVal);
    pendingValueRef.current = newVal;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      flushPendingNotes();
    }, 500);
  };

  const handleBioChange = (newVal: string) => {
    setBio(newVal);
    pendingBioRef.current = newVal;
    if (bioTimerRef.current) clearTimeout(bioTimerRef.current);
    bioTimerRef.current = setTimeout(() => {
      flushPendingBio();
    }, 500);
  };

  useSafeEffect(() => {
    return () => {
      flushPendingNotes();
      flushPendingBio();
    };
  }, []);

  return h(
    'div',
    { class: 'ds-notes-widget', 'data-testid': 'notes-markdown-pane-widget' },
    h('h4', { class: 'ds-widget-title' }, 'Notes & Biography'),
    h(
      'div',
      { class: 'ds-bio-section' },
      h('label', { class: 'ds-field-label', for: 'bio-textarea' }, 'Character Biography'),
      h('textarea', {
        id: 'bio-textarea',
        class: 'ds-bio-textarea',
        'data-testid': 'bio-textarea',
        'aria-label': 'Character biography',
        rows: 4,
        value: bio,
        onInput: (e: Event) => handleBioChange((e.target as HTMLTextAreaElement).value),
        onBlur: () => flushPendingBio(),
      }),
    ),
    h(
      'div',
      { class: 'ds-notes-section' },
      h('label', { class: 'ds-field-label', for: 'notes-textarea' }, 'Session & Character Notes'),
      h('textarea', {
        id: 'notes-textarea',
        class: 'ds-notes-textarea',
        'data-testid': 'notes-textarea',
        'aria-label': 'Notes and biography',
        rows: 8,
        value: text,
        onInput: (e: Event) => handleChange((e.target as HTMLTextAreaElement).value),
        onBlur: () => flushPendingNotes(),
      }),
    ),
  );
}
