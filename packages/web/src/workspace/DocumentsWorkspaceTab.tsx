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
}

export const documentsNotesSignal = signal<NoteHierarchyNode[]>([]);
export const documentsHandoutsSignal = signal<PartyJournalEntry[]>([]);
export const documentsTimelineSignal = signal<SessionTimelineEventItem[]>([]);
export const activeHandoutModalSignal = signal<PartyJournalEntry | null>(null);

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

function formatVisibilityLabel(visibility: NoteHierarchyNode["visibility"]): string {
  if (visibility === "PRIVATE") return t("note.scope.private");
  if (visibility === "PARTY") return t("note.scope.party");
  return t("note.scope.dm_only");
}

export function HandoutRevealModal() {
  const activeModal = activeHandoutModalSignal.value;

  try {
    useEffect(() => {
      if (!activeModal || typeof window === "undefined") return;
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          activeHandoutModalSignal.value = null;
        }
      };
      window.addEventListener("keydown", handleEscape);
      return () => {
        window.removeEventListener("keydown", handleEscape);
      };
    }, [activeModal]);
  } catch {
    // Fallback when invoked outside a Preact render cycle in headless unit tests
  }

  if (!activeModal) return null;

  return (
    <div
      data-testid="handout-reveal-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="handout-title"
      class="modal-backdrop fullscreen"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          activeHandoutModalSignal.value = null;
        }
      }}
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
          data-testid="modal-close-button"
          class="ds-btn ds-btn-secondary"
          onClick={() => {
            activeHandoutModalSignal.value = null;
          }}
          style={{ marginTop: "1rem", minHeight: "40px" }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function DocumentsWorkspaceTab() {
  const groupedNotes = groupNotesByFolder(documentsNotesSignal.value);

  return (
    <section
      data-testid="tab-documents"
      style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Documents & Handouts</h2>
      </header>

      <div
        data-testid="notes-hierarchy-tree"
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <h3>Notes</h3>
        {documentsNotesSignal.value.length === 0 ? (
          <p data-testid="empty-notes-hint">No notes available</p>
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
                  {folderNotes.length} {folderNotes.length === 1 ? "note" : "notes"}
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
                    style={{
                      padding: "0.5rem",
                      background: "var(--atlas-surface)",
                      border: "1px solid var(--atlas-border)",
                      borderRadius: "var(--atlas-radius-sm, 4px)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
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
                      [{formatVisibilityLabel(note.visibility)}]
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div
        data-testid="past-handouts-gallery"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <h3>Past Handouts</h3>
        {documentsHandoutsSignal.value.length === 0 ? (
          <p data-testid="empty-handouts-hint">No revealed handouts</p>
        ) : (
          documentsHandoutsSignal.value.map((handout) => (
            <div
              key={handout.handoutId}
              data-testid={`handout-card-${handout.handoutId}`}
              role="button"
              tabIndex={0}
              aria-label={`Open handout: ${handout.title}`}
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
              <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{handout.content}</p>
            </div>
          ))
        )}
      </div>

      <div
        data-testid="session-timeline-feed"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <h3>Session Timeline</h3>
        {documentsTimelineSignal.value.length === 0 ? (
          <p data-testid="empty-timeline-hint">No events recorded</p>
        ) : (
          documentsTimelineSignal.value.map((event) => {
            const titleText = typeof event.payload?.title === "string" ? `: ${event.payload.title}` : "";
            return (
              <div
                key={event.id}
                data-testid={`timeline-event-${event.seqId}`}
                style={{ padding: "0.5rem", border: "1px solid var(--atlas-border)" }}
              >
                <span>
                  #{event.seqId} {event.eventType}{titleText}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
