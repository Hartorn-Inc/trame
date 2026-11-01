/**
 * ============================================================================
 * SERVER-BACKED CAMPAIGN DOCUMENTS (workspace/CampaignDocumentsTab.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Loads the campaign notes and the party journal from the server, saves note
 * edits, and reveals handouts, rendering everything through the existing
 * `DocumentsWorkspaceTab` view (notes tree, editor, handout gallery).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server-Filtered Content`:
 *    - `GET .../notes` already drops GM notes and strips `:::dm` blocks for
 *      players, so the view never holds text the caller may not read.
 * 2. `Two Scopes Only`:
 *    - The server stores `min_role` `PLAYER` | `GM`, mapped to the view's
 *      `PARTY` | `DM_ONLY`. There is no per-user private note on the server,
 *      so `PRIVATE` is hidden (`serverBacked`). Only the GM can save `GM`.
 * 3. `Save Before Reveal`:
 *    - The server finds `:::handout{id=...}` in the stored notes, so the open
 *      note is saved first; an unsaved handout block would otherwise 404.
 * 4. `Journal From The Reveal Payload`:
 *    - The reveal response is the same payload players get as
 *      `HandoutRevealed`; it goes through `dispatchHandoutRevealedFrame`, which
 *      deduplicates by handout id when the socket echo arrives too.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * mount / retry -> `listNotes` + `listJournal` -> `loading` | `ready` | `error`
 * ├── save   -> `putNote(slug)` -> replace the note with the stored copy
 * └── reveal -> `putNote(open note)` -> `revealHandout(id)` -> journal + modal
 * ============================================================================
 */
import { useEffect, useState } from 'preact/hooks';
import type { ApiClient, CampaignNote, JournalEntry, PutNoteInput } from '../api/client.ts';
import type { PartyJournalEntry } from '../mobile/companionMode.ts';
import { t } from '../i18n/index.ts';
import {
  DocumentsWorkspaceTab,
  dispatchHandoutRevealedFrame,
  documentsHandoutsSignal,
  documentsNotesSignal,
  selectedNoteIdSignal,
  type NoteHierarchyNode,
} from './DocumentsWorkspaceTab.tsx';

/** Folder name the view uses for notes without a folder. */
const ROOT_FOLDER = 'Root';

/** Maps a server note to the view node; the slug is the node id (it keys the PUT). */
export function noteToNode(note: CampaignNote): NoteHierarchyNode {
  return {
    id: note.slug,
    title: note.title,
    folder: note.folder ?? '',
    visibility: note.minRole === 'GM' ? 'DM_ONLY' : 'PARTY',
    ownerUserId: '',
    content: note.contentMarkdown,
  };
}

/** Maps a view node to the `PUT .../notes/{slug}` body (invariant 2). */
export function nodeToPutNote(node: NoteHierarchyNode): PutNoteInput {
  const folder = node.folder.trim();
  return {
    title: node.title,
    contentMarkdown: node.content ?? '',
    folder: folder && folder !== ROOT_FOLDER ? folder : null,
    minRole: node.visibility === 'DM_ONLY' ? 'GM' : 'PLAYER',
  };
}

/** Maps a journal entry to the view's handout card shape. */
export function journalToHandout(entry: JournalEntry): PartyJournalEntry {
  return { handoutId: entry.handoutId, title: entry.title, content: entry.content, revealedBy: entry.revealedBy, timestamp: entry.revealedAt };
}

export interface CampaignDocumentsTabProps {
  campaignId: string;
  client: ApiClient;
  isGm: boolean;
}

type LoadStatus = 'loading' | 'ready' | 'error';

export function CampaignDocumentsTab({ campaignId, client, isGm }: CampaignDocumentsTabProps) {
  const [load, setLoad] = useState<LoadStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([client.listNotes(campaignId), client.listJournal(campaignId)])
      .then(([notes, entries]) => {
        if (!live) return;
        documentsNotesSignal.value = notes.map(noteToNode);
        documentsHandoutsSignal.value = entries.map(journalToHandout);
        setLoad('ready');
      })
      .catch(() => {
        if (live) setLoad('error');
      });
    return () => {
      live = false;
    };
  }, [client, campaignId, attempt]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (node: NoteHierarchyNode) => {
    const stored = noteToNode(await client.putNote(campaignId, node.id, nodeToPutNote(node)));
    documentsNotesSignal.value = documentsNotesSignal.value.map((n) => (n.id === node.id ? stored : n));
  };

  const onSaveNote = (node: NoteHierarchyNode) =>
    run(async () => {
      await save(node);
      return t('docs.notes.saved', { title: node.title });
    });

  const onRevealHandout = (handout: { id: string; title: string }) =>
    run(async () => {
      const open = documentsNotesSignal.value.find((n) => n.id === selectedNoteIdSignal.value);
      if (open) await save(open);
      const { handout_id, title, content, revealed_by, timestamp } = await client.revealHandout(campaignId, handout.id);
      dispatchHandoutRevealedFrame({ handout_id, title, content, revealed_by, timestamp });
      return t('docs.handouts.revealed', { title: handout.title });
    });

  if (load === 'loading') {
    return <p role="status" class="ds-hint" data-testid="documents-loading">{t('docs.loading')}</p>;
  }
  if (load === 'error') {
    return (
      <div role="alert" class="ds-panel ds-stack-sm" data-testid="documents-error">
        <p class="ds-field-error">{t('docs.loadFailed')}</p>
        <div class="ds-cluster">
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="documents-retry" onClick={() => {
              setLoad('loading');
              setAttempt((a) => a + 1);
            }}>
            {t('docs.retry')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="ds-stack-sm">
      <p role="status" class="ds-meta" data-testid="documents-status">{status ?? ''}</p>
      {error ? <p role="alert" class="ds-field-error" data-testid="documents-action-error">{error}</p> : null}
      <DocumentsWorkspaceTab
        isGm={isGm}
        currentUserId={client.state.user.value?.id ?? ''}
        serverBacked
        busy={busy}
        onSaveNote={(node) => void onSaveNote(node)}
        onRevealHandout={(handout) => void onRevealHandout(handout)}
      />
    </div>
  );
}
