import { h, type VNode } from 'preact';
import { signal } from '@preact/signals';
import type { Dnd5eActorData } from '../../../game-systems/dnd5e/src/index.ts';
import { DeclarativeSheetView } from '../sheet/DeclarativeSheetView.tsx';
import { CompendiumDrawer, type CompendiumEntry } from '../compendium/CompendiumDrawer.tsx';
import { CharacterSheetHeader } from '../components/character-sheet/CharacterSheetHeader.tsx';

export const isSheetDrawerOpenSignal = signal<boolean>(false);
export const isCompendiumDrawerOpenSignal = signal<boolean>(false);
export const coreStatsLockedSignal = signal<boolean>(true);
export const activeHudActorSignal = signal<Dnd5eActorData | null>(null);

export interface HudDrawersProps {
  actor?: Dnd5eActorData | null;
  actorState?: unknown;
  actorId?: string;
  actorSignal?: { value: Dnd5eActorData | null };
  campaignId?: string;
  isLiveTable?: boolean;
  tableSessionActive?: boolean;
  gm_core_locked?: boolean;
  coreStatsLocked?: boolean;
  dispatchCommand?: (cmd: any) => void;
  compendiumEntries?: CompendiumEntry[];
  systemId?: string;
  isTableCanvasMounted?: boolean;
  targetContainerId?: string | null;
  onSaveActor?: (updatedActor: Dnd5eActorData) => void | Promise<void>;
}

export function HudDrawers(props: HudDrawersProps): VNode<any> {
  const closeSheet = () => {
    isSheetDrawerOpenSignal.value = false;
  };

  const closeCompendium = () => {
    isCompendiumDrawerOpenSignal.value = false;
  };

  const handleSheetKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (typeof e.stopPropagation === 'function') {
        e.stopPropagation();
      }
      closeSheet();
    }
  };

  const actorId = props.actorId ?? (props.actorState as any)?.id ?? (props.actorState as any)?.sheet?.id;
  const currentActor: Dnd5eActorData = (
    props.actor ??
    (props.actorState as any)?.sheet ??
    props.actorState ??
    {
      id: props.actorId ?? 'actor-live-default',
      name: 'Hero',
      classId: 'fighter',
      level: 1,
      attributes: {
        level: 1,
        hitDieSize: 10,
        hitDiceCurrent: 1,
        hitDiceMax: 1,
        hp: { current: 10, max: 10, temp: 0 },
      },
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    }
  ) as Dnd5eActorData;

  const handleLiveSave = async (updatedActor: Dnd5eActorData) => {
    activeHudActorSignal.value = updatedActor;
    if (props.onSaveActor) {
      await props.onSaveActor(updatedActor);
    }
  };

  return h(
    'div',
    { class: 'ds-hud-drawers-container', 'data-testid': 'hud-drawers-container' },
    isSheetDrawerOpenSignal.value
      ? h(
          'aside',
          {
            class: 'ds-hud-sheet-drawer',
            'data-testid': 'hud-sheet-drawer',
            'aria-label': 'Character Sheet Drawer',
            onKeyDown: handleSheetKeyDown,
          },
          h(
            'header',
            { class: 'ds-drawer-header' },
            h('h2', null, 'Character Sheet'),
            h(
              'button',
              {
                type: 'button',
                class: 'ds-btn ds-btn-sm ds-btn-close',
                'data-testid': 'btn-close-sheet-drawer',
                'aria-label': 'Close character sheet drawer',
                onClick: closeSheet,
              },
              'Close',
            ),
          ),
          h(CharacterSheetHeader, {
            actor: currentActor,
            actorSignal: (props.actorSignal ?? activeHudActorSignal) as { value: Dnd5eActorData },
            context: 'hud_drawer',
            isLiveTable: true,
            tableSessionActive: props.tableSessionActive ?? true,
            campaignId: props.campaignId,
            dispatchCommand: props.dispatchCommand,
            onSaveActor: handleLiveSave,
            coreStatsLocked: props.coreStatsLocked ?? coreStatsLockedSignal.value,
            onToggleCoreStatsLocked: (locked: boolean) => {
              coreStatsLockedSignal.value = locked;
            },
          }),
          h(DeclarativeSheetView, {
            actorState: props.actorState ?? currentActor,
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
      targetContainerId: props.targetContainerId,
    }),
  );
}
