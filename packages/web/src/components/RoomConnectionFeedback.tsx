/**
 * ============================================================================
 * ROOM CONNECTION BANNER & ACTION FEEDBACK TOASTS (components/RoomConnectionFeedback.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Tells players whether their actions reach the table (user stories 26-28):
 * `ConnectionBanner` shows the room connection state under the top bar, and
 * `CommandFeedbackToasts` shows every refused or unsent table action, named
 * after what the player did. Without them a dropped socket or a
 * `CommandRejected` is invisible and actions silently do nothing.
 * `WalQuarantineBanner` tells the Game Master which table actions the room
 * set aside while recovering from a crash (ADR-0040, spec US23 / D4).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Persistent Live Regions`:
 *    - Both live regions are always mounted, even when empty or connected,
 *      because screen readers ignore regions inserted together with their
 *      first message.
 * 2. `Calm Announcements`:
 *    - The banner message is `role="status"` (polite). The per-second retry
 *      countdown and the action buttons sit outside it, so the screen reader
 *      hears one sentence per state change, not a tick every second.
 *    - Toasts are `aria-live="assertive"` with `aria-relevant="additions"`:
 *      a refused action interrupts, and older toasts are not re-read.
 * 3. `Not Color Alone`:
 *    - Every state is a full sentence ("Connection lost. Reconnecting,
 *      attempt 2."); the danger border on access errors and toasts only
 *      reinforces the text.
 * 4. `No Timed Disappearance`:
 *    - Toasts stay until dismissed or pushed out by newer ones
 *      (`COMMAND_FEEDBACK_LIMIT`), so slow readers never lose a message.
 *    - Each dismiss button's accessible name repeats the action it closes
 *      ("Dismiss Move token notice"), so a stack of toasts is not a list of
 *      identical "Dismiss" buttons.
 * 5. `Canvas Primacy`:
 *    - When connected, the banner collapses to visually hidden text; the top
 *      bar badge already shows "Connected".
 * 6. `Quarantine Is GM-Only`:
 *    - The server unicasts `WalEntriesQuarantined` to Game Masters only; the
 *      banner also renders nothing unless the active campaign role is `GM`.
 * ============================================================================
 */
import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import type { CommandFeedback, ConnectionStatus } from '../api/session.ts';
import { hasMessage, t, tn, type MessageKey } from '../i18n/index.ts';

export interface RoomConnectionFeedbackProps {
  client: ApiClient;
}

/** States that render a visible banner. */
const VISIBLE_STATES: ReadonlySet<ConnectionStatus> = new Set(['reconnecting', 'offline', 'signedOut', 'forbidden']);

/**
 * Re-renders once per second while a retry is scheduled, so the countdown
 * stays current. Each tick is a one-shot timer re-armed by the next render,
 * so nothing keeps ticking once the banner stops asking for it.
 */
function useSecondTicks(active: boolean): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), 1000);
    return () => clearTimeout(timer);
  }, [active, tick]);
}

function bannerMessage(status: ConnectionStatus, attempt: number): string {
  switch (status) {
    case 'open':
      return t('connection.banner.connected');
    case 'reconnecting':
      return t('connection.banner.reconnecting', { attempt: Math.max(1, attempt) });
    case 'offline':
      return t('connection.banner.offline');
    case 'signedOut':
      return t('connection.banner.signedOut');
    case 'forbidden':
      return t('connection.banner.forbidden');
    default:
      return '';
  }
}

/** Connection state strip for the campaign workspace and table. */
export function ConnectionBanner({ client }: RoomConnectionFeedbackProps) {
  const status = client.state.connection.value;
  const { attempt, nextRetryAtMs } = client.state.reconnect.value;
  useSecondTicks(status === 'reconnecting' && nextRetryAtMs !== null);
  const visible = VISIBLE_STATES.has(status);
  const seconds = nextRetryAtMs === null ? 0 : Math.max(1, Math.ceil((nextRetryAtMs - Date.now()) / 1000));

  let action = null;
  if (status === 'reconnecting' || status === 'offline') {
    action = (
      <button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" data-testid="connection-reconnect-now" onClick={() => client.reconnectNow()}>
        {t('connection.reconnectNow')}
      </button>
    );
  } else if (status === 'signedOut') {
    action = (
      <button type="button" class="ds-btn ds-btn-primary ds-btn-sm" data-testid="connection-sign-in" onClick={() => client.signInAgain()}>
        {t('connection.signInAgain')}
      </button>
    );
  } else if (status === 'forbidden') {
    action = (
      <button
        type="button"
        class="ds-btn ds-btn-secondary ds-btn-sm"
        data-testid="connection-back-to-campaigns"
        onClick={() => {
          client.state.activeCampaignId.value = null;
        }}
      >
        {t('connection.backToCampaigns')}
      </button>
    );
  }

  return (
    <div class={visible ? 'ds-connection-banner' : 'ds-visually-hidden'} data-testid="connection-banner" data-state={status}>
      <div class="ds-connection-banner-body">
        <p class="ds-connection-banner-text" role="status" aria-live="polite" aria-atomic="true" data-testid="connection-banner-message">
          {bannerMessage(status, attempt)}
        </p>
        {status === 'reconnecting' && (
          <span class="ds-meta atlas-tabular-nums" data-testid="connection-banner-retry">
            {nextRetryAtMs === null ? t('connection.banner.retrying') : tn('connection.banner.nextRetry', seconds)}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * Game Master notice listing the WAL entries the room set aside while
 * recovering after a crash (ADR-0040 decision 3), so the GM knows which
 * table actions are missing instead of discovering it mid-scene. The live
 * region stays mounted (invariant 1); the list and the dismiss button sit
 * outside it, and only the campaign's GM ever sees the content.
 */
export function WalQuarantineBanner({ client }: RoomConnectionFeedbackProps) {
  const campaignId = client.state.activeCampaignId.value;
  const isGm = client.state.campaigns.value.some((c) => c.id === campaignId && c.role === 'GM');
  const entries = isGm ? client.state.walQuarantine.value : [];
  const visible = entries.length > 0;
  return (
    <div class={visible ? 'ds-connection-banner' : 'ds-visually-hidden'} data-testid="wal-quarantine-banner" data-state="quarantine">
      <div class="ds-stack-sm">
        <p class="ds-connection-banner-text" role="alert" aria-atomic="true" data-testid="wal-quarantine-message">
          {visible && (
            <>
              <strong>{t('quarantine.title')}</strong> {tn('quarantine.summary', entries.length)}
            </>
          )}
        </p>
        {visible && (
          <ul class="ds-list-plain ds-meta" aria-label={t('quarantine.listLabel')} data-testid="wal-quarantine-list">
            {entries.map((e) => (
              <li key={e.seq_id} class="atlas-tabular-nums" data-testid={`wal-quarantine-entry-${e.seq_id}`}>
                {t('quarantine.entry', { seq: e.seq_id, kind: e.command_kind, error: e.error })}
              </li>
            ))}
          </ul>
        )}
      </div>
      {visible && (
        <button
          type="button"
          class="ds-btn ds-btn-secondary ds-btn-sm"
          data-testid="wal-quarantine-dismiss"
          onClick={() => client.dismissWalQuarantine()}
        >
          {t('quarantine.dismiss')}
        </button>
      )}
    </div>
  );
}

/** Localized label of the action a feedback toast refers to. */
function actionLabel(action: string | null): string {
  const key = `command.action.${action ?? ''}`;
  return hasMessage(key) ? t(key) : t('command.action.generic');
}

/**
 * Engine rejections (`CommandError` display strings) that get a plain-language,
 * localized explanation instead of the raw English reason.
 */
const KNOWN_REASONS: readonly [RegExp, MessageKey][] = [
  [/^speed is 0\b/, 'feedback.reason.speedZero'],
  [/^door is locked\b/, 'feedback.reason.doorLocked'],
  [/^door is out of reach\b/, 'feedback.reason.doorOutOfReach'],
  [/^rate limited\b/, 'feedback.reason.rateLimited'],
  [/^condition immunity\b/, 'feedback.reason.conditionImmune'],
];

/** Localized explanation of a rejection reason, or the server text when unknown. */
export function rejectionReason(reason: string | null): string {
  const known = KNOWN_REASONS.find(([pattern]) => pattern.test(reason ?? ''));
  return known ? t(known[1]) : reason ?? '';
}

function feedbackMessage(item: CommandFeedback): string {
  const action = actionLabel(item.action);
  switch (item.kind) {
    case 'rejected':
      return t('feedback.rejected', { action, reason: rejectionReason(item.reason) });
    case 'maybeLost':
      return t('feedback.maybeLost', { action });
    default:
      return t('feedback.notConnected', { action });
  }
}

/** Toast stack for refused (`CommandRejected`) and unsent (not connected) table actions. */
export function CommandFeedbackToasts({ client }: RoomConnectionFeedbackProps) {
  const items = client.state.commandFeedback.value;
  return (
    <div
      class="ds-toast-region"
      role="log"
      aria-label={t('feedback.region')}
      aria-live="assertive"
      aria-relevant="additions"
      data-testid="command-feedback"
    >
      {items.map((item) => (
        <div key={item.id} class="ds-toast" data-testid="command-feedback-item" data-kind={item.kind}>
          <p class="ds-toast-message">{feedbackMessage(item)}</p>
          <button
            type="button"
            class="ds-btn ds-btn-close ds-btn-sm"
            data-testid="command-feedback-dismiss"
            aria-label={t('feedback.dismissAction', { action: actionLabel(item.action) })}
            onClick={() => client.dismissFeedback(item.id)}
          >
            {t('feedback.dismiss')}
          </button>
        </div>
      ))}
    </div>
  );
}
