import { signal } from "@preact/signals";
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

export function DocumentsWorkspaceTab() {
  return (
    <section data-testid="tab-documents" style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Documents & Handouts</h2>
      </header>

      <div data-testid="notes-hierarchy-tree" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h3>Notes</h3>
        {documentsNotesSignal.value.length === 0 ? (
          <p data-testid="empty-notes-hint">No notes available</p>
        ) : (
          documentsNotesSignal.value.map((note) => (
            <div key={note.id} data-testid={`note-item-${note.id}`} style={{ padding: "0.5rem", border: "1px solid var(--atlas-border)" }}>
              <strong>{note.title}</strong>
              <span style={{ marginLeft: "0.5rem", fontSize: "0.8rem", color: "var(--atlas-text-muted)" }}>[{note.visibility}]</span>
            </div>
          ))
        )}
      </div>

      <div data-testid="past-handouts-gallery" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h3>Past Handouts</h3>
        {documentsHandoutsSignal.value.length === 0 ? (
          <p data-testid="empty-handouts-hint">No revealed handouts</p>
        ) : (
          documentsHandoutsSignal.value.map((handout) => (
            <div key={handout.handoutId} data-testid={`handout-card-${handout.handoutId}`} style={{ padding: "0.5rem", border: "1px solid var(--atlas-border)" }}>
              <h4>{handout.title}</h4>
              <p>{handout.content}</p>
            </div>
          ))
        )}
      </div>

      <div data-testid="session-timeline-feed" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h3>Session Timeline</h3>
        {documentsTimelineSignal.value.length === 0 ? (
          <p data-testid="empty-timeline-hint">No events recorded</p>
        ) : (
          documentsTimelineSignal.value.map((event) => (
            <div key={event.id} data-testid={`timeline-event-${event.seqId}`} style={{ padding: "0.5rem", border: "1px solid var(--atlas-border)" }}>
              <span>#{event.seqId} {event.eventType}</span>
            </div>
          ))
        )}
      </div>

      {activeHandoutModalSignal.value && (
        <div data-testid="handout-reveal-modal" style={{ position: "fixed", inset: 0, background: "var(--atlas-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--atlas-surface)", padding: "1.5rem", maxWidth: "600px", width: "90%", borderRadius: "8px" }}>
            <h3 data-testid="handout-title">{activeHandoutModalSignal.value.title}</h3>
            <div data-testid="handout-content">{activeHandoutModalSignal.value.content}</div>
            <button data-testid="modal-close-button" onClick={() => { activeHandoutModalSignal.value = null; }} style={{ marginTop: "1rem" }}>Close</button>
          </div>
        </div>
      )}
    </section>
  );
}
