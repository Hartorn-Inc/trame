/**
 * ============================================================================
 * STORED ACTOR SHEET PANEL (sheet/ActorSheetPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Renders one stored actor sheet: `CharacterSheetHeader` (save with version
 * conflict handling, level-up, rest) above the declarative widget sheet.
 * Shared by the table HUD drawer and the mobile companion so both edit the
 * same record through the same persistence path.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Stored Sheets Only`:
 *    - Reads `client.state.actors[actorId]`; players only receive their own
 *      sheets, so another player's actor renders the "no sheet" hint.
 * 2. `REST Persistence`:
 *    - Widget edits go through `createSheetCommandDispatcher` (versioned PUT)
 *      and rolls through REST `POST .../dice/roll`. A `409 VERSION_CONFLICT`
 *      re-syncs the stored actor sheet from the server and surfaces an
 *      accessible `role="alert"` banner; network errors surface in the same
 *      dismissible banner and clear on the next successful save.
 * 3. `Shared Padlock`:
 *    - The core-stats padlock is one signal, so the header and the widgets
 *      always agree on whether core stats are editable.
 * ============================================================================
 */
import { signal } from '@preact/signals';
import type { Dnd5eActorData } from '../../../game-systems/dnd5e/src/index.ts';
import type { ApiClient } from '../api/client.ts';
import { CharacterSheetHeader } from '../components/character-sheet/CharacterSheetHeader.tsx';
import { t } from '../i18n/index.ts';
import { DeclarativeSheetView } from './DeclarativeSheetView.tsx';
import { useSafeState } from './safeHooks.ts';
import {
  createSheetCommandDispatcher,
  restDiceRollService,
  syncConflictedActorSheet,
} from './sheetPersistence.ts';
import { sheetViewState } from './sheetViewState.ts';
import type { SheetLayoutTree } from './types.ts';

/** Padlock state of the sheet's core stats (`true` = play mode). */
export const coreStatsLockedSignal = signal<boolean>(true);

/** Single-widget layout showing only the inventory tree (mobile inventory tab). */
export const INVENTORY_SHEET_LAYOUT: SheetLayoutTree = {
  systemId: 'dnd5e',
  version: '1.0.0',
  root: {
    id: 'inventory-only',
    kind: 'widget',
    widgetType: 'InventoryContainerTree',
    visibilityTier: 'PUBLIC',
    bindings: { items: 'sheet.items', currency: 'sheet.currency', strength: 'sheet.abilities.str' },
  },
};

export interface ActorSheetPanelProps {
  campaignId: string;
  client: ApiClient;
  actorId: string | null;
  /** Header context: `hud_drawer` / `live_table` render the compact level-up label. */
  context: 'campaign_workspace' | 'live_table' | 'hud_drawer';
  /** Widget layout; defaults to the full 12-widget sheet. */
  layout?: SheetLayoutTree;
  /** GM forced lock of core stats for players. */
  gmCoreLocked?: boolean;
  isTableCanvasMounted?: boolean;
  onClose?: () => void;
}

export function ActorSheetPanel(props: ActorSheetPanelProps) {
  const { client, actorId, campaignId } = props;
  const [alertState, setAlertState] = useSafeState<{ actorId: string; message: string } | null>(null);
  const record = actorId ? client.state.actors.value[actorId] : undefined;
  const actor = record?.data as Dnd5eActorData | undefined;
  if (!actor || !actorId) {
    return <p class="ds-hint" data-testid="hud-no-sheet">{t('hud.noSheet')}</p>;
  }
  const activeAlert = alertState?.actorId === actorId ? alertState.message : null;
  const dispatchCommand = createSheetCommandDispatcher({
    client,
    campaignId,
    actorId,
    onConflict: (currentVersion) => {
      setAlertState({
        actorId,
        message: syncConflictedActorSheet(client, campaignId, actorId, currentVersion),
      });
    },
    onError: (message) => {
      setAlertState({
        actorId,
        message: message || t('sheet.persistence.saveFailed'),
      });
    },
    onSaved: () => {
      setAlertState(null);
    },
  });
  return (
    <div class="ds-stack" data-testid="actor-sheet-panel">
      {props.layout ? null : (
        <CharacterSheetHeader
          actor={actor}
          actorId={actorId}
          client={client}
          campaignId={campaignId}
          context={props.context}
          diceRollService={restDiceRollService(client, campaignId)}
          coreStatsLocked={coreStatsLockedSignal.value}
          onToggleCoreStatsLocked={(locked: boolean) => {
            coreStatsLockedSignal.value = locked;
          }}
        />
      )}
      {activeAlert ? (
        <div class="ds-panel ds-cluster" role="alert" data-testid="sheet-persistence-alert">
          <span>{activeAlert}</span>
          <button
            type="button"
            class="ds-btn ds-btn-sm ds-btn-secondary"
            data-testid="btn-dismiss-sheet-alert"
            aria-label={t('sheet.persistence.dismissAlert')}
            onClick={() => setAlertState(null)}
          >
            {t('action.close')}
          </button>
        </div>
      ) : null}
      <DeclarativeSheetView
        sheetLayout={props.layout}
        actorState={sheetViewState(actor)}
        actorId={actorId}
        gm_core_locked={props.gmCoreLocked}
        coreStatsLocked={coreStatsLockedSignal.value}
        onToggleCoreStatsLocked={() => {
          coreStatsLockedSignal.value = !coreStatsLockedSignal.value;
        }}
        dispatchCommand={dispatchCommand}
        onCloseDrawer={props.onClose}
        isTableCanvasMounted={props.isTableCanvasMounted}
      />
    </div>
  );
}
