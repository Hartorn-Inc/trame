/**
 * ============================================================================
 * DEATH SAVING THROW ANNOUNCEMENT (table/DeathSaveAnnouncement.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * When the room resolves `RECORD_DEATH_SAVE`, the only trace used to be the
 * vitals counters of the selected token, which a screen reader never hears
 * and other players never see. This status line announces the last
 * `DEATH_SAVE_RECORDED` event to everyone who sees the token.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server Redaction Respected`:
 *    - The controller (the token is in `tokens`) gets the d20, both counters,
 *      Stable, death and the regained hit point. Other recipients receive the
 *      event with zeroed counters (`sync.rs`), so they only hear the d20 and
 *      the Stable / dead flags; the counters are never shown to them.
 * 2. `No Client Rules`:
 *    - The sentence reads the server's outcome; the d20 is never classified
 *      as a success or failure here.
 * 3. `Kept Until Replaced`:
 *    - `lastEvents` only holds the latest batch; the last announcement stays
 *      until another death saving throw replaces it.
 * ============================================================================
 */
import { useRef } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { WireTrameEvent } from '../api/wire.ts';
import { t } from '../i18n/index.ts';
import { listTableTokens } from './tableView.ts';

interface DeathSaveOutcome {
  successes: number;
  failures: number;
  regains_hp: boolean;
  stable: boolean;
  dead: boolean;
}

/** Announcement sentence for one `DEATH_SAVE_RECORDED` event (invariants 1 and 2). */
export function deathSaveSentence(name: string, d20: number, outcome: DeathSaveOutcome, controlled: boolean): string {
  const rolled = t('deathSave.rolled', { name, d20 });
  const result = outcome.dead
    ? t('deathSave.dead', { name })
    : outcome.stable
      ? t('deathSave.stable', { name })
      : controlled && outcome.regains_hp
        ? t('deathSave.regains', { name })
        : controlled
          ? t('vitals.deathCounters', { successes: outcome.successes, failures: outcome.failures })
          : '';
  return result ? `${rolled} ${result}` : rolled;
}

export interface DeathSaveAnnouncementProps {
  client: ApiClient;
}

export function DeathSaveAnnouncement({ client }: DeathSaveAnnouncementProps) {
  const kept = useRef<WireTrameEvent | null>(null);
  const latest = [...client.state.lastEvents.value].reverse().find((ev) => ev.event === 'DEATH_SAVE_RECORDED');
  if (latest) kept.current = latest;
  const event = kept.current;
  const token = event ? listTableTokens(client.state.table.value).find((tok) => tok.id === event.token_id) : undefined;
  return (
    <p class="ds-hint" role="status" aria-live="polite" data-testid="death-save-result">
      {event && token ? deathSaveSentence(token.name, Number(event.d20), event.outcome as DeathSaveOutcome, token.controlled) : ''}
    </p>
  );
}
