import { h, type VNode } from 'preact';
import { signal } from '@preact/signals';
import { DeclarativeSheetView } from '../sheet/DeclarativeSheetView.tsx';
import { CompendiumDrawer } from '../compendium/CompendiumDrawer.tsx';
import type { CompendiumEntry } from '../../../game-systems/dnd5e/src/compendium.ts';

export const isSheetDrawerOpenSignal = signal<boolean>(false);
export const isCompendiumDrawerOpenSignal = signal<boolean>(false);

export interface HudDrawersProps {
  actorState?: unknown;
  gm_core_locked?: boolean;
  coreStatsLocked?: boolean;
  dispatchCommand?: (cmd: any) => void;
  compendiumEntries?: CompendiumEntry[];
  systemId?: string;
  isTableCanvasMounted?: boolean;
}

export function HudDrawers(props: HudDrawersProps): VNode {
  const closeSheet = () => {
    isSheetDrawerOpenSignal.value = false;
  };

  const closeCompendium = () => {
    isCompendiumDrawerOpenSignal.value = false;
  };

  return h(
    'div',
    { class: 'ds-hud-drawers-container', 'data-testid': 'hud-drawers-container' },
    isSheetDrawerOpenSignal.value
      ? h(
          'aside',
          { class: 'ds-hud-sheet-drawer', 'data-testid': 'hud-sheet-drawer' },
          h(
            'header',
            { class: 'ds-drawer-header' },
            h('h2', null, 'Character Sheet'),
            h('button', { type: 'button', 'data-testid': 'btn-close-sheet-drawer', 'aria-label': 'Close character sheet drawer', onClick: closeSheet }, '×'),
          ),
          h(DeclarativeSheetView, {
            actorState: props.actorState ?? {},
            gm_core_locked: props.gm_core_locked,
            coreStatsLocked: props.coreStatsLocked,
            dispatchCommand: props.dispatchCommand,
            onCloseDrawer: closeSheet,
            isTableCanvasMounted: props.isTableCanvasMounted,
          }),
        )
      : null,
    h(CompendiumDrawer, {
      isOpen: isCompendiumDrawerOpenSignal.value,
      onClose: closeCompendium,
      entries: props.compendiumEntries,
      systemId: props.systemId,
    }),
  );
}
