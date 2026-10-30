import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export function sanitizeHtml(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, "");
}

export interface NotesMarkdownPaneOutput {
  id: string;
  bio: string;
  notes: string;
  sanitizedBio: string;
  sanitizedNotes: string;
  editNotes: (text: string) => void;
  editBio: (text: string) => void;
  sanitize: (text: string) => string;
}

export function NotesMarkdownPane(context: WidgetRenderContext): NotesMarkdownPaneOutput {
  const rawBio = String(context.boundValues.bio ?? "");
  const rawNotes = String(context.boundValues.notes ?? "");

  const handleEditNotes = (text: string) => {
    const sanitized = sanitizeHtml(text);
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "notes",
        text: sanitized,
        notes: sanitized,
        value: sanitized,
      }),
    );
  };

  const handleEditBio = (text: string) => {
    const sanitized = sanitizeHtml(text);
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "bio",
        text: sanitized,
        bio: sanitized,
        value: sanitized,
      }),
    );
  };

  return {
    id: context.id,
    bio: rawBio,
    notes: rawNotes,
    sanitizedBio: sanitizeHtml(rawBio),
    sanitizedNotes: sanitizeHtml(rawNotes),
    editNotes: handleEditNotes,
    editBio: handleEditBio,
    sanitize: sanitizeHtml,
  };
}
