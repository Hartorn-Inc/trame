/**
 * ============================================================================
 * LIVE-TABLE HUD DRAWERS: SHEET & COMPENDIUM (hud/HudDrawers.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Slide-in drawers over the workspace: the selected actor's sheet
 * (`ActorSheetPanel`: header + the 12-widget sheet) and the
 * `CompendiumDrawer`. A token click selects the actor; the drawer then shows
 * the stored sheet for that actor without leaving the current tab.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Selection Drives Content`:
 *    - The sheet shown is `client.state.actors[actorId]`, where `actorId`
 *      defaults to `selectedActorIdSignal`. Players only receive their own
 *      sheets from the server, so selecting another player's token shows the
 *      "no sheet" state instead of leaking data.
 * 2. `REST Persistence Only`:
 *    - Header saves and widget edits go through `sheetPersistence.ts`
 *      (versioned PUT); rolls use REST `POST .../dice/roll`. Version conflicts
 *      (`409 VERSION_CONFLICT`) re-sync the stored actor sheet from the server
 *      and surface an accessible `role="alert"` banner alongside save/roll
 *      errors.
 * 3. `Escape Closes`:
 *    - Escape inside the sheet drawer closes it without bubbling to the
 *      canvas shortcuts.
 * 4. `Single-Drawer Mutual Exclusion`:
 *    - Opening the sheet drawer closes the compendium drawer, and opening the
 *      compendium drawer closes the sheet drawer, preserving unobstructed
 *      table canvas visibility per ATLAS v1.1.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import { signal, untracked } from '@preact/signals';
import { apiClient, type ApiClient } from '../api/client.ts';
import { selectedActorIdSignal } from '../api/session.ts';
import { ActorSheetPanel } from '../sheet/ActorSheetPanel.tsx';
import { useSafeState } from '../sheet/safeHooks.ts';
import { createSheetCommandDispatcher, syncConflictedActorSheet } from '../sheet/sheetPersistence.ts';
import { CompendiumDrawer, type CompendiumEntry } from '../compendium/CompendiumDrawer.tsx';
import { t } from '../i18n/index.ts';

export { coreStatsLockedSignal } from '../sheet/ActorSheetPanel.tsx';

/** `true` while the sheet drawer is open. */
export const isSheetDrawerOpenSignal = signal<boolean>(false);
/** `true` while the compendium drawer is open. */
export const isCompendiumDrawerOpenSignal = signal<boolean>(false);

let wasSheetDrawerOpen = false;
let wasCompendiumDrawerOpen = false;

isSheetDrawerOpenSignal.subscribe((open) => {
  const transitionedOpen = open && !wasSheetDrawerOpen;
  wasSheetDrawerOpen = open;
  if (transitionedOpen && isCompendiumDrawerOpenSignal.peek()) {
    untracked(() => {
      isCompendiumDrawerOpenSignal.value = false;
    });
  }
});

isCompendiumDrawerOpenSignal.subscribe((open) => {
  const transitionedOpen = open && !wasCompendiumDrawerOpen;
  wasCompendiumDrawerOpen = open;
  if (transitionedOpen && isSheetDrawerOpenSignal.peek()) {
    untracked(() => {
      isSheetDrawerOpenSignal.value = false;
    });
  }
});

/** Opens the actor sheet drawer and closes the compendium drawer. */
export function openSheetDrawer(): void {
  isCompendiumDrawerOpenSignal.value = false;
  isSheetDrawerOpenSignal.value = true;
}

/** Closes the actor sheet drawer. */
export function closeSheetDrawer(): void {
  isSheetDrawerOpenSignal.value = false;
}

/** Opens the compendium drawer and closes the actor sheet drawer. */
export function openCompendiumDrawer(): void {
  isSheetDrawerOpenSignal.value = false;
  isCompendiumDrawerOpenSignal.value = true;
}

/** Closes the compendium drawer. */
export function closeCompendiumDrawer(): void {
  isCompendiumDrawerOpenSignal.value = false;
}

export interface HudDrawersProps {
  campaignId: string;
  /** REST gateway; defaults to the app-wide client. */
  client?: ApiClient;
  /** Actor to show; defaults to `selectedActorIdSignal`. */
  actorId?: string | null;
  /** GM forced lock of core stats for players. */
  gm_core_locked?: boolean;
  compendiumEntries?: CompendiumEntry[];
  systemId?: string;
  isTableCanvasMounted?: boolean;
  targetContainerId?: string | null;
  /** GM monster spawn forwarded to the compendium drawer; absent for players. */
  onSpawnMonster?: (entry: CompendiumEntry) => void;
}

export function HudDrawers(props: HudDrawersProps): VNode<any> {
  const client = props.client ?? apiClient;
  const actorId = props.actorId === undefined ? selectedActorIdSignal.value : props.actorId;
  const [alertState, setAlertState] = useSafeState<{ actorId: string; message: string } | null>(null);
  const activeAlert = actorId && alertState?.actorId === actorId ? alertState.message : null;
  const isCompendiumOpen = isCompendiumDrawerOpenSignal.value;
  const isSheetOpen = isSheetDrawerOpenSignal.value && !isCompendiumOpen;

  const handleSheetKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation?.();
      closeSheetDrawer();
    }
  };

  const dispatchCommand = actorId
    ? createSheetCommandDispatcher({
        client,
        campaignId: props.campaignId,
        actorId,
        onConflict: (currentVersion) => {
          setAlertState({
            actorId,
            message: syncConflictedActorSheet(client, props.campaignId, actorId, currentVersion),
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
      })
    : undefined;

  return h(
    'div',
    { class: 'ds-hud-drawers-container', 'data-testid': 'hud-drawers-container' },
    activeAlert
      ? h(
          'div',
          { class: 'ds-panel ds-cluster', role: 'alert', 'data-testid': 'hud-persistence-alert' },
          h('span', null, activeAlert),
          h(
            'button',
            {
              type: 'button',
              class: 'ds-btn ds-btn-sm ds-btn-secondary',
              'data-testid': 'btn-dismiss-hud-alert',
              'aria-label': t('sheet.persistence.dismissAlert'),
              onClick: () => setAlertState(null),
            },
            t('action.close'),
          ),
        )
      : null,
    isSheetOpen
      ? h(
          'aside',
          {
            class: 'ds-hud-sheet-drawer',
            'data-testid': 'hud-sheet-drawer',
            'aria-label': t('hud.sheetDrawer'),
            onKeyDown: handleSheetKeyDown,
          },
          h(
            'header',
            { class: 'ds-drawer-header' },
            h('h2', null, t('nav.sheet')),
            h(
              'button',
              {
                type: 'button',
                class: 'ds-btn ds-btn-sm ds-btn-close',
                'data-testid': 'btn-close-sheet-drawer',
                'aria-label': t('hud.closeSheetDrawer'),
                onClick: closeSheetDrawer,
              },
              t('action.close'),
            ),
          ),
          h(ActorSheetPanel, {
            campaignId: props.campaignId,
            client,
            actorId: actorId ?? null,
            context: 'hud_drawer',
            gmCoreLocked: props.gm_core_locked,
            isTableCanvasMounted: props.isTableCanvasMounted,
            onClose: closeSheetDrawer,
          }),
        )
      : null,
    h(CompendiumDrawer, {
      isOpen: isCompendiumOpen,
      onClose: closeCompendiumDrawer,
      entries: props.compendiumEntries,
      systemId: props.systemId,
      dispatchCommand,
      actorId: actorId ?? undefined,
      targetContainerId: props.targetContainerId,
      onSpawnMonster: props.onSpawnMonster,
    }),
  );
}
