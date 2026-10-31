import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { appSignals } from "../state/appSignals.ts";
import { HandoutPopupModal } from "./HandoutPopupModal.tsx";
import type { NoteDto } from "../types/index.ts";

export interface WikiNotesDrawerProps {
  children?: ComponentChildren;
  client?: ApiClient;
  campaignId?: string;
  isGm?: boolean;
  onClose?: () => void;
}

export function WikiNotesDrawer(props: WikiNotesDrawerProps): JSX.Element {
  const activeClient = props.client || defaultClient;
  const user = appSignals.authUserSignal.value;
  const activeCampaign = appSignals.activeCampaignSignal.value;
  const campaignId = props.campaignId || activeCampaign?.id || "";
  const isGm = Boolean(props.isGm || user?.role === "GM" || activeCampaign?.role === "GM");

  const notes = appSignals.notesSignal.value;
  const [selectedNote, setSelectedNote] = useState<NoteDto | null>(notes[0] || null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (campaignId && notes.length === 0) {
      activeClient.listNotes(campaignId).catch(() => {});
    }
  }, [campaignId]);

  useEffect(() => {
    if (!selectedNote && notes.length > 0) {
      setSelectedNote(notes[0]);
    }
  }, [notes]);

  const handleRevealHandout = async (handoutId: string, title: string, content: string) => {
    if (!campaignId) return;
    try {
      const broadcast = await activeClient.revealHandout(campaignId, {
        handoutId,
        title,
        content,
      });
      appSignals.revealedHandoutSignal.value = broadcast;
      setStatusMessage(`Handout "${title}" revealed to party.`);
    } catch (err: unknown) {
      setStatusMessage(err instanceof Error ? err.message : "Failed to reveal handout");
    }
  };

  return (
    <aside
      role="complementary"
      aria-label="Campaign Wiki and Handouts"
      data-testid="wiki-notes-drawer"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "440px",
        maxWidth: "100vw",
        backgroundColor: "#0b0f19",
        borderLeft: "1px solid #1e293b",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        color: "#f8fafc",
      }}
    >
      <HandoutPopupModal />

      <header style={{ padding: "1rem", borderBottom: "1px solid #1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.125rem", color: "#f59e0b" }}>Wiki Notes & Handouts</h2>
          <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Role-Filtered Markdown</span>
        </div>
        <button
          type="button"
          data-testid="close-wiki-btn"
          onClick={() => {
            appSignals.activeDrawerSignal.value = null;
            props.onClose?.();
          }}
          style={{ padding: "0.375rem 0.625rem", backgroundColor: "#334155", color: "#f8fafc", border: "none", borderRadius: "4px", cursor: "pointer" }}
        >
          Close
        </button>
      </header>

      {statusMessage && (
        <div role="status" style={{ backgroundColor: "#064e3b", color: "#6ee7b7", padding: "0.5rem 1rem", fontSize: "0.75rem" }}>
          {statusMessage}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ width: "140px", borderRight: "1px solid #1e293b", overflowY: "auto", padding: "0.5rem" }}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {notes.map((note) => (
              <li key={note.slug}>
                <button
                  type="button"
                  data-testid={`note-tab-${note.slug}`}
                  onClick={() => setSelectedNote(note)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "0.5rem",
                    backgroundColor: selectedNote?.slug === note.slug ? "#1e293b" : "transparent",
                    color: selectedNote?.slug === note.slug ? "#38bdf8" : "#94a3b8",
                    border: "none",
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    cursor: "pointer",
                  }}
                >
                  {note.title}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
          {selectedNote ? (
            <div>
              <h3 style={{ margin: "0 0 0.5rem 0", color: "#f59e0b" }}>{selectedNote.title}</h3>
              <div
                data-testid="note-content-display"
                style={{ backgroundColor: "#0f172a", padding: "0.75rem", borderRadius: "4px", border: "1px solid #1e293b", marginBottom: "1rem", whiteSpace: "pre-wrap", fontSize: "0.875rem" }}
              >
                {selectedNote.contentMarkdown}
              </div>

              {isGm && (
                <button
                  type="button"
                  data-testid="reveal-handout-btn"
                  onClick={() => handleRevealHandout(`handout-${selectedNote.slug}`, selectedNote.title, selectedNote.contentMarkdown)}
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#7c3aed",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "4px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Reveal Handout
                </button>
              )}
            </div>
          ) : (
            <p style={{ color: "#94a3b8", fontSize: "0.875rem" }}>No note selected.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
