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
 *      (versioned PUT); rolls use REST `POST .../dice/roll`.
 * 3. `Escape Closes`:
 *    - Escape inside the sheet drawer closes it without bubbling to the
 *      canvas shortcuts.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import { signal } from '@preact/signals';
import { apiClient, type ApiClient } from '../api/client.ts';
import { selectedActorIdSignal } from '../api/session.ts';
import { ActorSheetPanel } from '../sheet/ActorSheetPanel.tsx';
import { createSheetCommandDispatcher } from '../sheet/sheetPersistence.ts';
import { CompendiumDrawer, type CompendiumEntry } from '../compendium/CompendiumDrawer.tsx';
import { t } from '../i18n/index.ts';

export { coreStatsLockedSignal } from '../sheet/ActorSheetPanel.tsx';

/** `true` while the sheet drawer is open. */
export const isSheetDrawerOpenSignal = signal<boolean>(false);
/** `true` while the compendium drawer is open. */
export const isCompendiumDrawerOpenSignal = signal<boolean>(false);

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
}

export function HudDrawers(props: HudDrawersProps): VNode<any> {
  const client = props.client ?? apiClient;
  const actorId = props.actorId === undefined ? selectedActorIdSignal.value : props.actorId;

  const closeSheet = () => {
    isSheetDrawerOpenSignal.value = false;
  };

  const handleSheetKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation?.();
      closeSheet();
    }
  };

  const dispatchCommand = actorId
    ? createSheetCommandDispatcher({ client, campaignId: props.campaignId, actorId })
    : undefined;

  return h(
    'div',
    { class: 'ds-hud-drawers-container', 'data-testid': 'hud-drawers-container' },
    isSheetDrawerOpenSignal.value
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
                onClick: closeSheet,
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
            onClose: closeSheet,
          }),
        )
      : null,
    h(CompendiumDrawer, {
      isOpen: isCompendiumDrawerOpenSignal.value,
      onClose: () => {
        isCompendiumDrawerOpenSignal.value = false;
      },
      entries: props.compendiumEntries,
      systemId: props.systemId,
      dispatchCommand,
      actorId: actorId ?? undefined,
      targetContainerId: props.targetContainerId,
    }),
  );
}
