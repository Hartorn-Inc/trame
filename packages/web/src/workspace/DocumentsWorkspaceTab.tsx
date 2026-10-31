import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { type PartyJournalEntry } from "../mobile/companionMode.ts";
import { parseWikiMarkdown } from "../notes/wikiParser.ts";

export interface SessionTimelineEventItem {
  id: string;
  campaignId: string;
  sessionNum: number;
  seqId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface NoteHierarchyNode {
  id: string;
  title: string;
  folder: string;
  visibility: "PRIVATE" | "PARTY" | "DM_ONLY";
  ownerUserId: string;
  content?: string;
}

export type NoteScopeFilter = "ALL" | "PRIVATE" | "PARTY" | "DM_ONLY";

export const documentsNotesSignal = signal<NoteHierarchyNode[]>([]);
export const documentsHandoutsSignal = signal<PartyJournalEntry[]>([]);
export const revealedHandoutsSignal = documentsHandoutsSignal;
export const documentsTimelineSignal = signal<SessionTimelineEventItem[]>([]);
export const activeHandoutModalSignal = signal<PartyJournalEntry | null>(null);
export const activeRevealedHandoutSignal = activeHandoutModalSignal;
export const selectedNoteIdSignal = signal<string | null>(null);
export const noteScopeFilterSignal = signal<NoteScopeFilter>("ALL");

export interface HandoutRevealedFrame {
  type?: "HandoutRevealed" | "handout.revealed";
  event?: "handout.revealed" | "HandoutRevealed";
  handout_id?: string;
  handoutId?: string;
  title: string;
  content: string;
  revealed_by?: string;
  revealedBy?: string;
  revealed_at?: number;
  timestamp?: number;
}

/**
 * Dispatches an incoming ServerEnvelope::HandoutRevealed / handout.revealed WebSocket frame
 * into activeHandoutModalSignal and documentsHandoutsSignal (newest-first, deduplicated by handoutId).
 */
export function dispatchHandoutRevealedFrame(frame: HandoutRevealedFrame): PartyJournalEntry {
  const handoutId = frame.handout_id ?? frame.handoutId ?? `handout-${Date.now()}`;
  const entry: PartyJournalEntry = {
    handoutId,
    title: frame.title,
    content: frame.content,
    revealedBy: frame.revealed_by ?? frame.revealedBy ?? "gm",
    timestamp: frame.revealed_at ?? frame.timestamp ?? Date.now(),
  };
  activeHandoutModalSignal.value = entry;
  const existing = documentsHandoutsSignal.value.filter((h) => h.handoutId !== handoutId);
  documentsHandoutsSignal.value = [entry, ...existing];
  return entry;
}

function tryExtractHandoutFrame(raw: unknown): HandoutRevealedFrame | null {
  try {
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!payload || typeof payload !== "object") return null;
    const rec = payload as Record<string, unknown>;
    if (
      rec.type === "HandoutRevealed" ||
      rec.event === "handout.revealed" ||
      rec.event === "HandoutRevealed" ||
      "HandoutRevealed" in rec
    ) {
      const inner =
        "HandoutRevealed" in rec && typeof rec.HandoutRevealed === "object" && rec.HandoutRevealed !== null
          ? (rec.HandoutRevealed as Record<string, unknown>)
          : rec;
      if (typeof inner.title === "string" && typeof inner.content === "string") {
        return inner as unknown as HandoutRevealedFrame;
      }
    }
  } catch {
    // Ignore non-JSON or unrelated frames
  }
  return null;
}

/**
 * Binds a WebSocket-compatible message emitter so ServerEnvelope::HandoutRevealed frames
 * automatically update activeHandoutModalSignal and documentsHandoutsSignal.
 */
export function attachHandoutRevealedSocket(socket: {
  addEventListener: (type: "message", listener: (ev: { data: unknown }) => void) => void;
  removeEventListener?: (type: "message", listener: (ev: { data: unknown }) => void) => void;
}): () => void {
  const onMessage = (ev: { data: unknown }) => {
    const frame = tryExtractHandoutFrame(ev.data);
    if (frame) {
      dispatchHandoutRevealedFrame(frame);
    }
  };
  socket.addEventListener("message", onMessage);
  return () => {
    socket.removeEventListener?.("message", onMessage);
  };
}

export function groupNotesByFolder(notes: NoteHierarchyNode[]): Map<string, NoteHierarchyNode[]> {
  const groups = new Map<string, NoteHierarchyNode[]>();
  for (const note of notes) {
    const folder = note.folder?.trim() ? note.folder.trim() : "Root";
    let list = groups.get(folder);
    if (!list) {
      list = [];
      groups.set(folder, list);
    }
    list.push(note);
  }
  return groups;
}

export function HandoutRevealModal() {
  const activeModal = activeHandoutModalSignal.value;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleWindowMessage = (ev: MessageEvent) => {
      const frame = tryExtractHandoutFrame(ev.data);
      if (frame) {
        dispatchHandoutRevealedFrame(frame);
      }
    };
    const handleCustomEvent = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      const frame = tryExtractHandoutFrame(detail) ?? (
        detail && typeof detail === "object" && typeof detail.title === "string" && typeof detail.content === "string"
          ? (detail as HandoutRevealedFrame)
          : null
      );
      if (frame) {
        dispatchHandoutRevealedFrame(frame);
      }
    };
    window.addEventListener("message", handleWindowMessage);
    window.addEventListener("trame:handout-revealed", handleCustomEvent);
    return () => {
      window.removeEventListener("message", handleWindowMessage);
      window.removeEventListener("trame:handout-revealed", handleCustomEvent);
    };
  }, []);

  useEffect(() => {
    if (!activeModal || typeof window === "undefined") return;
    const previousActiveElement =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        activeHandoutModalSignal.value = null;
        return;
      }
      if (e.key === "Tab" && typeof document !== "undefined") {
        const modalEl = document.querySelector?.('[data-testid="handout-reveal-modal"]');
        const focusable = modalEl?.querySelectorAll?.(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable && focusable.length > 0) {
          const first = focusable[0] as HTMLElement;
          const last = focusable[focusable.length - 1] as HTMLElement;
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus?.();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus?.();
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus?.();
    };
  }, [activeModal]);

  if (!activeModal) return null;

  return (
    <div
      data-testid="handout-reveal-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="handout-title"
      class="modal-backdrop fullscreen"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--atlas-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        class="modal-card ds-overlay-modal"
        style={{
          background: "var(--atlas-surface)",
          padding: "1.5rem",
          maxWidth: "600px",
          width: "90%",
          borderRadius: "var(--atlas-radius-lg, 8px)",
          border: "1px solid var(--atlas-border)",
        }}
      >
        <h3 id="handout-title" data-testid="handout-title">{activeModal.title}</h3>
        <div
          data-testid="handout-content"
          style={{ marginTop: "0.5rem", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        >
          {activeModal.content}
        </div>
        <button
          type="button"
          autoFocus
          data-testid="close-handout-modal"
          class="ds-btn ds-btn-secondary"
          onClick={() => {
            activeHandoutModalSignal.value = null;
          }}
          style={{ marginTop: "1rem" }}
        >
          {t("action.close")}
        </button>
      </div>
    </div>
  );
}

export const isGmSignal = signal<boolean>(false);
export const currentUserIdSignal = signal<string>("");

export interface DocumentsWorkspaceTabProps {
  isGm?: boolean;
  currentUserId?: string;
}

export function updateHandoutDirectiveRevealed(
  content: string,
  handoutId: string,
  handoutTitle?: string,
): string {
  return content.replace(/:::handout\{([^}]*)\}/g, (match, attrsStr) => {
    const idMatch = attrsStr.match(/\bid=["']([^"']*)["']/);
    const titleMatch = attrsStr.match(/\btitle=["']([^"']*)["']/);
    const matchesId = Boolean(handoutId && idMatch && idMatch[1] === handoutId);
    const matchesTitle = Boolean(!handoutId && handoutTitle && titleMatch && titleMatch[1] === handoutTitle);
    if (matchesId || matchesTitle || (!handoutId && !handoutTitle && !idMatch && !titleMatch)) {
      if (/\brevealed=["'][^"']*["']/.test(attrsStr)) {
        const updatedAttrs = attrsStr.replace(/\brevealed=["'][^"']*["']/, 'revealed="true"');
        return `:::handout{${updatedAttrs}}`;
      }
      return `:::handout{${attrsStr.trim()} revealed="true"}`;
    }
    return match;
  });
}

export function DocumentsWorkspaceTab(props: DocumentsWorkspaceTabProps = {}) {
  const isGm = props.isGm ?? isGmSignal.value;
  const currentUserId = props.currentUserId ?? currentUserIdSignal.value;
  const activeFilter = noteScopeFilterSignal.value;
  const effectiveFilter = !isGm && activeFilter === "DM_ONLY" ? "ALL" : activeFilter;
  const allNotes = documentsNotesSignal.value;
  const visibleNotes = allNotes.filter((n) => {
    if (n.visibility === "DM_ONLY") return isGm;
    if (n.visibility === "PRIVATE") return n.ownerUserId === currentUserId;
    return true;
  });
  const filteredNotes = effectiveFilter === "ALL"
    ? visibleNotes
    : visibleNotes.filter((n) => n.visibility === effectiveFilter);
  const groupedNotes = groupNotesByFolder(filteredNotes);
  const selectedNote = visibleNotes.find((n) => n.id === selectedNoteIdSignal.value) ?? null;
  const parsedActiveNote = selectedNote ? parseWikiMarkdown(selectedNote.content ?? "") : null;

  const getLocalizedScope = (vis: NoteHierarchyNode["visibility"]) => {
    switch (vis) {
      case "PRIVATE":
        return t("note.scope.private");
      case "PARTY":
        return t("note.scope.party");
      case "DM_ONLY":
        return t("note.scope.dm_only");
      default:
        return vis;
    }
  };

  const handleCreateNote = () => {
    const newId = `note-${Date.now()}`;
    const defaultScope: NoteHierarchyNode["visibility"] =
      effectiveFilter === "ALL" || (effectiveFilter === "DM_ONLY" && !isGm)
        ? "PARTY"
        : effectiveFilter;
    const newNote: NoteHierarchyNode = {
      id: newId,
      title: `${t("action.create_note")} ${allNotes.length + 1}`,
      folder: "Root",
      visibility: defaultScope,
      ownerUserId: currentUserId,
      content: "",
    };
    documentsNotesSignal.value = [...allNotes, newNote];
    selectedNoteIdSignal.value = newId;
  };

  const handleRevealHandout = (handout: { id: string; title: string; content: string }) => {
    if (!isGm) return;
    const activeGm = currentUserId || "gm";
    const entry: PartyJournalEntry = {
      handoutId: handout.id,
      title: handout.title,
      content: handout.content,
      revealedBy: activeGm,
      timestamp: Date.now(),
    };
    activeHandoutModalSignal.value = entry;
    const existing = documentsHandoutsSignal.value.filter((h) => h.handoutId !== handout.id);
    documentsHandoutsSignal.value = [entry, ...existing];

    if (selectedNote) {
      const updatedContent = updateHandoutDirectiveRevealed(
        selectedNote.content ?? "",
        handout.id,
        handout.title,
      );
      documentsNotesSignal.value = documentsNotesSignal.value.map((n) =>
        n.id === selectedNote.id ? { ...n, content: updatedContent } : n,
      );
    }
  };

  const toggleFilter = (scope: NoteScopeFilter) => {
    noteScopeFilterSignal.value = noteScopeFilterSignal.value === scope ? "ALL" : scope;
  };

  return (
    <section
      data-testid="tab-documents"
      style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2>{t("docs.title")}</h2>
        <button
          type="button"
          data-testid="create-note-btn"
          class="ds-btn ds-btn-primary"
          onClick={handleCreateNote}
        >
          {t("action.create_note")}
        </button>
      </header>

      <div
        data-testid="notes-hierarchy-tree"
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h3>{t("docs.notes")}</h3>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              data-testid="filter-private"
              aria-pressed={effectiveFilter === "PRIVATE"}
              class={`ds-btn ${effectiveFilter === "PRIVATE" ? "ds-btn-primary" : "ds-btn-secondary"}`}
              onClick={() => toggleFilter("PRIVATE")}
            >
              {t("note.scope.private")}
            </button>
            <button
              type="button"
              data-testid="filter-party"
              aria-pressed={effectiveFilter === "PARTY"}
              class={`ds-btn ${effectiveFilter === "PARTY" ? "ds-btn-primary" : "ds-btn-secondary"}`}
              onClick={() => toggleFilter("PARTY")}
            >
              {t("note.scope.party")}
            </button>
            {isGm && (
              <button
                type="button"
                data-testid="filter-dm-only"
                aria-pressed={effectiveFilter === "DM_ONLY"}
                class={`ds-btn ${effectiveFilter === "DM_ONLY" ? "ds-btn-primary" : "ds-btn-secondary"}`}
                onClick={() => toggleFilter("DM_ONLY")}
              >
                {t("note.scope.dm_only")}
              </button>
            )}
          </div>
        </div>

        {filteredNotes.length === 0 ? (
          <p data-testid="empty-notes-hint">{t("docs.notes.empty")}</p>
        ) : (
          Array.from(groupedNotes.entries()).map(([folderName, folderNotes]) => (
            <div
              key={folderName}
              data-testid={`folder-section-${folderName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`}
              class="notes-folder-section"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                padding: "0.75rem",
                background: "var(--atlas-surface-raised)",
                borderRadius: "var(--atlas-radius-sm, 4px)",
                border: "1px solid var(--atlas-border)",
              }}
            >
              <div
                class="notes-folder-header"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  color: "var(--atlas-text)",
                  borderBottom: "1px solid var(--atlas-border)",
                  paddingBottom: "0.25rem",
                }}
              >
                <span
                  class="folder-breadcrumb"
                  data-testid={`folder-breadcrumb-${folderName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`}
                >
                  <span aria-hidden="true">📁</span> {folderName}
                </span>
                <span class="atlas-tabular-nums" style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>
                  {folderNotes.length} {folderNotes.length === 1 ? t("docs.notes.count.singular") : t("docs.notes.count.plural")}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                  paddingLeft: "0.5rem",
                }}
              >
                {folderNotes.map((note) => {
                  const isSelected = selectedNoteIdSignal.value === note.id;
                  return (
                    <div
                      key={note.id}
                      data-testid={`note-item-${note.id}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      class="note-item-row"
                      onClick={() => {
                        selectedNoteIdSignal.value = note.id;
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectedNoteIdSignal.value = note.id;
                        }
                      }}
                      style={{
                        minHeight: "44px",
                        padding: "0.5rem 0.75rem",
                        background: isSelected ? "var(--atlas-surface-raised)" : "var(--atlas-surface)",
                        border: isSelected ? "2px solid var(--atlas-action)" : "1px solid var(--atlas-border)",
                        borderRadius: "var(--atlas-radius-sm, 4px)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: "pointer",
                      }}
                    >
                      <strong>
                        {isSelected ? "› " : ""}
                        {note.title}
                      </strong>
                      <span
                        style={{
                          marginLeft: "0.5rem",
                          fontSize: "0.8rem",
                          color: "var(--atlas-text-muted)",
                        }}
                      >
                        [{getLocalizedScope(note.visibility)}]
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {selectedNote && (
        <div
          data-testid="note-editor-pane"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "1rem",
            background: "var(--atlas-surface)",
            border: "1px solid var(--atlas-border)",
            borderRadius: "var(--atlas-radius-md, 6px)",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
            <label htmlFor="note-title-input" style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flex: "1 1 200px" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--atlas-text-muted)" }}>Note Title</span>
              <input
                id="note-title-input"
                data-testid="note-title-input"
                aria-label="Note Title"
                class="ds-input"
                value={selectedNote.title}
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  documentsNotesSignal.value = documentsNotesSignal.value.map((n) =>
                    n.id === selectedNote.id ? { ...n, title: val } : n
                  );
                }}
                style={{ fontWeight: 600, fontSize: "1rem" }}
              />
            </label>

            <label htmlFor="note-folder-input" style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flex: "1 1 140px" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--atlas-text-muted)" }}>Folder</span>
              <input
                id="note-folder-input"
                data-testid="note-folder-input"
                aria-label="Note Folder"
                class="ds-input"
                value={selectedNote.folder}
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  documentsNotesSignal.value = documentsNotesSignal.value.map((n) =>
                    n.id === selectedNote.id ? { ...n, folder: val } : n
                  );
                }}
              />
            </label>

            <label htmlFor="note-scope-select" style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flex: "0 0 160px" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--atlas-text-muted)" }}>Scope</span>
              <select
                id="note-scope-select"
                data-testid="note-scope-select"
                aria-label="Note Scope"
                class="ds-input"
                value={selectedNote.visibility}
                onChange={(e) => {
                  const val = (e.target as HTMLSelectElement).value as NoteHierarchyNode["visibility"];
                  documentsNotesSignal.value = documentsNotesSignal.value.map((n) =>
                    n.id === selectedNote.id ? { ...n, visibility: val } : n
                  );
                }}
              >
                <option value="PRIVATE">{t("note.scope.private")}</option>
                <option value="PARTY">{t("note.scope.party")}</option>
                {isGm && <option value="DM_ONLY">{t("note.scope.dm_only")}</option>}
              </select>
            </label>
          </div>

          <label htmlFor="note-content-editor" style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--atlas-text-muted)" }}>{t("docs.notes")}</span>
            <textarea
              id="note-content-editor"
              data-testid="note-content-editor"
              aria-label={t("docs.notes")}
              class="ds-input"
              rows={6}
              value={selectedNote.content ?? ""}
              onInput={(e) => {
                const val = (e.target as HTMLTextAreaElement).value;
                documentsNotesSignal.value = documentsNotesSignal.value.map((n) =>
                  n.id === selectedNote.id ? { ...n, content: val } : n
                );
              }}
              placeholder={t("docs.notes")}
              style={{ width: "100%", resize: "vertical", fontFamily: "var(--atlas-font-sans, inherit)" }}
            />
          </label>

          {isGm && parsedActiveNote && parsedActiveNote.handouts.length > 0 && (
            <div data-testid="note-handout-directives" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {parsedActiveNote.handouts.map((handout) => (
                <button
                  key={handout.id}
                  type="button"
                  data-testid="btn-reveal-handout"
                  class="ds-btn ds-btn-primary"
                  onClick={() => handleRevealHandout(handout)}
                >
                  {t("action.reveal")}: {handout.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        data-testid="past-handouts-gallery"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <h3>{t("docs.handouts")}</h3>
        {documentsHandoutsSignal.value.length === 0 ? (
          <p data-testid="empty-handouts-hint">{t("docs.handouts.empty")}</p>
        ) : (
          documentsHandoutsSignal.value.map((handout) => (
            <div
              key={handout.handoutId}
              data-testid={`handout-card-${handout.handoutId}`}
              role="button"
              tabIndex={0}
              aria-label={`Open handout: ${handout.title}`}
              class="handout-card-item"
              onClick={() => {
                activeHandoutModalSignal.value = handout;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activeHandoutModalSignal.value = handout;
                }
              }}
              style={{ minHeight: "44px", padding: "0.5rem", border: "1px solid var(--atlas-border)", cursor: "pointer" }}
            >
              <h4>{handout.title}</h4>
              <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{handout.content}</p>
            </div>
          ))
        )}
      </div>

      <div
        data-testid="session-timeline-viewer"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <h3>{t("docs.timeline")}</h3>
        {documentsTimelineSignal.value.length === 0 ? (
          <p data-testid="empty-timeline-hint">{t("docs.timeline.empty")}</p>
        ) : (
          documentsTimelineSignal.value.map((event) => {
            const titleSuffix = typeof event.payload?.title === "string" ? `: ${event.payload.title}` : "";
            return (
              <div
                key={event.id}
                data-testid={`timeline-event-${event.seqId}`}
                style={{ padding: "0.5rem", border: "1px solid var(--atlas-border)" }}
              >
                <span>
                  #{event.seqId} {event.eventType}{titleSuffix}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
