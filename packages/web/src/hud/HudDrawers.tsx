import { h, type VNode } from 'preact';
import { signal } from '@preact/signals';
import { DeclarativeSheetView } from '../sheet/DeclarativeSheetView.tsx';
import { CompendiumDrawer } from '../compendium/CompendiumDrawer.tsx';
import type { CompendiumEntry } from '../../../../packages/game-systems/dnd5e/src/compendium.ts';

export const isSheetDrawerOpenSignal = signal<boolean>(false);
export const isCompendiumDrawerOpenSignal = signal<boolean>(false);
export const coreStatsLockedSignal = signal<boolean>(true);

export interface HudDrawersProps {
  actorState?: unknown;
  actorId?: string;
  gm_core_locked?: boolean;
  coreStatsLocked?: boolean;
  dispatchCommand?: (cmd: any) => void;
  compendiumEntries?: CompendiumEntry[];
  systemId?: string;
  isTableCanvasMounted?: boolean;
}

export function HudDrawers(props: HudDrawersProps): VNode<any> {
  const closeSheet = () => {
    isSheetDrawerOpenSignal.value = false;
  };

  const closeCompendium = () => {
    isCompendiumDrawerOpenSignal.value = false;
  };

  const actorId = props.actorId ?? (props.actorState as any)?.id ?? (props.actorState as any)?.sheet?.id;

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
            actorId,
            gm_core_locked: props.gm_core_locked,
            coreStatsLocked: props.coreStatsLocked ?? coreStatsLockedSignal.value,
            onToggleCoreStatsLocked: () => {
              coreStatsLockedSignal.value = !coreStatsLockedSignal.value;
            },
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
      dispatchCommand: props.dispatchCommand,
      actorId,
    }),
  );
}
