import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { type PartyJournalEntry } from "../mobile/companionMode.ts";

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
export const documentsTimelineSignal = signal<SessionTimelineEventItem[]>([]);
export const activeHandoutModalSignal = signal<PartyJournalEntry | null>(null);
export const selectedNoteIdSignal = signal<string | null>(null);
export const noteScopeFilterSignal = signal<NoteScopeFilter>("ALL");

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
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        activeHandoutModalSignal.value = null;
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

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
        <div data-testid="handout-content" style={{ marginTop: "0.5rem" }}>
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

export function DocumentsWorkspaceTab() {
  const activeFilter = noteScopeFilterSignal.value;
  const allNotes = documentsNotesSignal.value;
  const filteredNotes = activeFilter === "ALL"
    ? allNotes
    : allNotes.filter((n) => n.visibility === activeFilter);
  const groupedNotes = groupNotesByFolder(filteredNotes);
  const selectedNote = allNotes.find((n) => n.id === selectedNoteIdSignal.value) ?? null;

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
      activeFilter === "ALL" ? "PARTY" : activeFilter;
    const newNote: NoteHierarchyNode = {
      id: newId,
      title: `${t("action.create_note")} ${allNotes.length + 1}`,
      folder: "Root",
      visibility: defaultScope,
      ownerUserId: "",
      content: "",
    };
    documentsNotesSignal.value = [...allNotes, newNote];
    selectedNoteIdSignal.value = newId;
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
              aria-pressed={activeFilter === "PRIVATE"}
              class={`ds-btn ${activeFilter === "PRIVATE" ? "ds-btn-primary" : "ds-btn-secondary"}`}
              onClick={() => toggleFilter("PRIVATE")}
            >
              {t("note.scope.private")}
            </button>
            <button
              type="button"
              data-testid="filter-party"
              aria-pressed={activeFilter === "PARTY"}
              class={`ds-btn ${activeFilter === "PARTY" ? "ds-btn-primary" : "ds-btn-secondary"}`}
              onClick={() => toggleFilter("PARTY")}
            >
              {t("note.scope.party")}
            </button>
            <button
              type="button"
              data-testid="filter-dm-only"
              aria-pressed={activeFilter === "DM_ONLY"}
              class={`ds-btn ${activeFilter === "DM_ONLY" ? "ds-btn-primary" : "ds-btn-secondary"}`}
              onClick={() => toggleFilter("DM_ONLY")}
            >
              {t("note.scope.dm_only")}
            </button>
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
                  📁 {folderName}
                </span>
                <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>
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
                {folderNotes.map((note) => (
                  <div
                    key={note.id}
                    data-testid={`note-item-${note.id}`}
                    role="button"
                    tabIndex={0}
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
                      padding: "0.5rem",
                      background: selectedNoteIdSignal.value === note.id ? "var(--atlas-surface-raised)" : "var(--atlas-surface)",
                      border: selectedNoteIdSignal.value === note.id ? "1px solid var(--atlas-action)" : "1px solid var(--atlas-border)",
                      borderRadius: "var(--atlas-radius-sm, 4px)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      cursor: "pointer",
                    }}
                  >
                    <strong>{note.title}</strong>
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
                ))}
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
            gap: "0.5rem",
            padding: "1rem",
            background: "var(--atlas-surface)",
            border: "1px solid var(--atlas-border)",
            borderRadius: "var(--atlas-radius-md, 6px)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <input
              data-testid="note-title-input"
              class="ds-input"
              value={selectedNote.title}
              onInput={(e) => {
                const val = (e.target as HTMLInputElement).value;
                documentsNotesSignal.value = documentsNotesSignal.value.map((n) =>
                  n.id === selectedNote.id ? { ...n, title: val } : n
                );
              }}
              style={{ fontWeight: 600, fontSize: "1.1rem", flex: 1, marginRight: "1rem" }}
            />
            <span style={{ fontSize: "0.85rem", color: "var(--atlas-text-muted)" }}>
              [{getLocalizedScope(selectedNote.visibility)}]
            </span>
          </div>
          <textarea
            data-testid="note-content-editor"
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
              onClick={() => {
                activeHandoutModalSignal.value = handout;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activeHandoutModalSignal.value = handout;
                }
              }}
              style={{ padding: "0.5rem", border: "1px solid var(--atlas-border)", cursor: "pointer" }}
            >
              <h4>{handout.title}</h4>
              <p>{handout.content}</p>
            </div>
          ))
        )}
      </div>

      <div
        data-testid="session-timeline-feed"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <h3>{t("docs.timeline")}</h3>
        {documentsTimelineSignal.value.length === 0 ? (
          <p data-testid="empty-timeline-hint">{t("docs.timeline.empty")}</p>
        ) : (
          documentsTimelineSignal.value.map((event) => (
            <div
              key={event.id}
              data-testid={`timeline-event-${event.seqId}`}
              style={{ padding: "0.5rem", border: "1px solid var(--atlas-border)" }}
            >
              <span>
                #{event.seqId} {event.eventType}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
