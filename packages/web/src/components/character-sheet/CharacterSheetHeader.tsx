import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import type { Dnd5eActorData } from '../../../../game-systems/dnd5e/src/index.ts';
import { LevelUpModal, type DiceRollService } from '../modals/LevelUpModal.tsx';
import { RestModal } from '../modals/RestModal.tsx';

export interface CharacterSheetHeaderProps {
  actor: Dnd5eActorData;
  campaignId?: string;
  context?: 'campaign_workspace' | 'live_table' | 'hud_drawer';
  isLiveTable?: boolean;
  tableSessionActive?: boolean;
  dispatchCommand?: (cmd: any) => void;
  onSave?: (updatedActor: Dnd5eActorData) => void | Promise<void>;
  onSaveActor?: (updatedActor: Dnd5eActorData) => void | Promise<void>;
  actorSignal?: { value: Dnd5eActorData };
  diceRollService?: DiceRollService;
  coreStatsLocked?: boolean;
  onToggleCoreStatsLocked?: (locked: boolean) => void;
  className?: string;
}

export async function persistActorUpdate(
  updatedActor: Dnd5eActorData,
  options: {
    campaignId?: string;
    isLiveTable?: boolean;
    tableSessionActive?: boolean;
    dispatchCommand?: (cmd: any) => void;
    actorSignal?: { value: Dnd5eActorData };
    onSave?: (actor: Dnd5eActorData) => void | Promise<void>;
    onSaveActor?: (actor: Dnd5eActorData) => void | Promise<void>;
  },
): Promise<void> {
  const isLive = Boolean(options.isLiveTable || options.tableSessionActive);

  if (isLive && typeof options.dispatchCommand === 'function') {
    const cmd = {
      type: 'UpdateActorData',
      actorId: updatedActor.id,
      actor_id: updatedActor.id,
      actor: updatedActor,
      data: updatedActor,
    };
    options.dispatchCommand(cmd);
  } else if (options.campaignId && updatedActor.id) {
    await fetch(`/api/v1/campaigns/${options.campaignId}/actors/${updatedActor.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedActor),
    });
  }

  if (options.actorSignal) {
    options.actorSignal.value = updatedActor;
  }

  if (typeof options.onSave === 'function') {
    await options.onSave(updatedActor);
  }
  if (typeof options.onSaveActor === 'function') {
    await options.onSaveActor(updatedActor);
  }
}

export function handleUpdateActorDataEvent(event: any, actorSignal?: { value: any }): void {
  if (!event || !actorSignal) return;
  const eventType = event.type || event.event;
  if (
    eventType === 'UpdateActorData' ||
    eventType === 'ActorUpdated' ||
    eventType === 'update_actor_data' ||
    eventType === 'actor_updated'
  ) {
    const data = event.actor ?? event.data ?? event.payload;
    if (!data) return;

    const incomingActorId = event.actorId ?? event.actor_id ?? data.id;
    const currentActorId = actorSignal.value?.id;

    if (currentActorId) {
      if (incomingActorId && incomingActorId !== currentActorId) {
        return;
      }
      if (data.id && data.id !== currentActorId) {
        return;
      }
      if (!incomingActorId && !data.id) {
        return;
      }
    }

    actorSignal.value = data;
  }
}

export function CharacterSheetHeader(props: CharacterSheetHeaderProps): VNode<any> {
  const currentActor = props.actorSignal?.value ?? props.actor;
  const [isLevelUpOpen, setIsLevelUpOpen] = useState(false);
  const [restState, setRestState] = useState<{ isOpen: boolean; restType: 'short' | 'long' }>({
    isOpen: false,
    restType: 'short',
  });

  const isLive = Boolean(
    props.isLiveTable ||
      props.context === 'live_table' ||
      props.context === 'hud_drawer' ||
      (props.tableSessionActive && !props.campaignId),
  );

  const currentLevel = currentActor?.attributes?.level ?? (currentActor as any)?.level ?? 1;
  const isMaxLevel = currentLevel >= 20;

  const handleSave = async (updatedActor: Dnd5eActorData) => {
    await persistActorUpdate(updatedActor, {
      campaignId: props.campaignId,
      isLiveTable: isLive,
      tableSessionActive: props.tableSessionActive,
      dispatchCommand: props.dispatchCommand,
      actorSignal: props.actorSignal,
      onSave: props.onSave,
      onSaveActor: props.onSaveActor,
    });
  };

  const levelUpLabel = isLive
    ? 'Level Up'
    : `Level Up (Lvl ${currentLevel} -> ${currentLevel + 1})`;

  return h(
    'header',
    {
      class: `ds-character-sheet-header ${props.className ?? ''}`.trim(),
      'data-testid': 'character-sheet-header',
      role: 'region',
      'aria-label': 'Character Sheet Actions',
    },
    h(
      'div',
      { class: 'ds-sheet-header-info' },
      h('h2', { class: 'ds-sheet-character-name', 'data-testid': 'sheet-actor-name' }, currentActor?.name ?? 'Unnamed Character'),
      h(
        'span',
        { class: 'ds-sheet-character-summary', 'data-testid': 'sheet-actor-summary' },
        `Level ${currentLevel} ${currentActor?.classId ?? ''}`.trim(),
      ),
    ),
    h(
      'div',
      { class: 'ds-sheet-header-actions', role: 'toolbar', 'aria-label': 'Progression and Rest Actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'ds-btn ds-btn-sm ds-btn-level-up',
          'data-testid': 'btn-level-up',
          disabled: isMaxLevel,
          'aria-disabled': isMaxLevel ? 'true' : 'false',
          'aria-label': isMaxLevel ? 'Level Up disabled: Maximum Level 20 reached' : levelUpLabel,
          title: isMaxLevel ? 'Maximum level reached (20)' : levelUpLabel,
          onClick: () => {
            if (!isMaxLevel) setIsLevelUpOpen(true);
          },
        },
        levelUpLabel,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'ds-btn ds-btn-sm ds-btn-short-rest',
          'data-testid': 'btn-short-rest',
          'aria-label': 'Short Rest',
          onClick: () => setRestState({ isOpen: true, restType: 'short' }),
        },
        'Short Rest',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'ds-btn ds-btn-sm ds-btn-long-rest',
          'data-testid': 'btn-long-rest',
          'aria-label': 'Long Rest',
          onClick: () => setRestState({ isOpen: true, restType: 'long' }),
        },
        'Long Rest',
      ),
    ),
    isLevelUpOpen
      ? h(LevelUpModal, {
          isOpen: isLevelUpOpen,
          actor: currentActor,
          onClose: () => setIsLevelUpOpen(false),
          onSave: async (updated) => {
            await handleSave(updated);
            setIsLevelUpOpen(false);
          },
          diceRollService: props.diceRollService,
          coreStatsLocked: props.coreStatsLocked,
          onToggleCoreStatsLocked: props.onToggleCoreStatsLocked,
        })
      : null,
    restState.isOpen
      ? h(RestModal, {
          isOpen: restState.isOpen,
          restType: restState.restType,
          actor: currentActor,
          onClose: () => setRestState({ isOpen: false, restType: 'short' }),
          onSave: async (updated) => {
            await handleSave(updated);
            setRestState({ isOpen: false, restType: 'short' });
          },
          diceRollService: props.diceRollService,
        })
      : null,
  );
}
