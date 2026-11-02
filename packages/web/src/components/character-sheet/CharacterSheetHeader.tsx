/**
 * ============================================================================
 * CHARACTER SHEET HEADER: LEVEL-UP, RESTS & VERSIONED SAVE (CharacterSheetHeader.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Title bar of every character sheet (workspace Actors tab and live-table HUD
 * drawer). It opens `LevelUpModal` / `RestModal` and persists their result
 * through `saveActorSheet` (REST `PUT .../actors/{id}` with
 * `expected_version`). Without the version check, two people editing the same
 * sheet would silently overwrite each other.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Store-Backed Rendering`:
 *    - The displayed sheet is `client.state.actors[actorId].data` when known,
 *      so an `ActorUpdated` broadcast re-renders the header immediately;
 *      `props.actor` is only the fallback before the first load.
 * 2. `Visible Conflicts`:
 *    - A `VERSION_CONFLICT` keeps the unsaved sheet and shows an alert with
 *      `[Reload latest]` (discard local change, re-read the sheet) and
 *      `[Overwrite]` (retry with the server's `current_version`).
 * 3. `No Table Command For Sheets`:
 *    - Sheets never travel over the table socket; the server syncs linked
 *      token vitals itself after a successful PUT.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import type { Dnd5eActorData } from '../../../../game-systems/dnd5e/src/index.ts';
import { apiClient, type ApiClient } from '../../api/client.ts';
import { LevelUpModal, type DiceRollService } from '../modals/LevelUpModal.tsx';
import { RestModal } from '../modals/RestModal.tsx';
import { saveActorSheet } from '../../sheet/sheetPersistence.ts';
import { t } from '../../i18n/index.ts';

export interface CharacterSheetHeaderProps {
  /** Fallback sheet rendered until the actor store knows `actorId`. */
  actor: Dnd5eActorData;
  /** Actor record UUID; defaults to `actor.id`. */
  actorId?: string;
  /** Campaign owning the actor; without it, saves only call `onSave` (no network). */
  campaignId?: string;
  /** REST gateway; defaults to the app-wide client. */
  client?: ApiClient;
  /** `live_table` / `hud_drawer` render the compact level-up label. */
  context?: 'campaign_workspace' | 'live_table' | 'hud_drawer';
  /** Forces the compact live-table label. */
  isLiveTable?: boolean;
  /** Called with the stored sheet after a successful save. */
  onSave?: (updatedActor: Dnd5eActorData) => void | Promise<void>;
  /** Dice backend for rest and level-up rolls (REST `POST .../dice/roll` in the app). */
  diceRollService?: DiceRollService;
  coreStatsLocked?: boolean;
  onToggleCoreStatsLocked?: (locked: boolean) => void;
  className?: string;
}

interface ConflictState {
  /** Unsaved sheet produced by the modal. */
  pending: Dnd5eActorData;
  /** Server version reported by the `409`; `null` when absent. */
  currentVersion: number | null;
}

export function CharacterSheetHeader(props: CharacterSheetHeaderProps): VNode<any> {
  const client = props.client ?? apiClient;
  const actorId = props.actorId ?? props.actor?.id;
  const stored = actorId ? client.state.actors.value[actorId] : undefined;
  const currentActor = (stored?.data as Dnd5eActorData | undefined) ?? props.actor;

  const [isLevelUpOpen, setIsLevelUpOpen] = useState(false);
  const [restState, setRestState] = useState<{ isOpen: boolean; restType: 'short' | 'long' }>({
    isOpen: false,
    restType: 'short',
  });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isLive = Boolean(props.isLiveTable || props.context === 'live_table' || props.context === 'hud_drawer');
  const currentLevel = currentActor?.attributes?.level ?? 1;
  const isMaxLevel = currentLevel >= 20;

  const persist = async (updated: Dnd5eActorData, expectedVersion?: number) => {
    setSaveError(null);
    if (!props.campaignId || !actorId) {
      await props.onSave?.(updated);
      return;
    }
    try {
      const outcome = await saveActorSheet(client, props.campaignId, actorId, updated, {
        name: updated.name,
        expectedVersion,
      });
      if (outcome.status === 'conflict') {
        setConflict({ pending: updated, currentVersion: outcome.currentVersion });
        return;
      }
      setConflict(null);
      await props.onSave?.(outcome.actor.data as Dnd5eActorData);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('sheetHeader.saveFailed'));
    }
  };

  const reloadLatest = async () => {
    if (!props.campaignId || !actorId) return;
    try {
      await client.getActor(props.campaignId, actorId);
      setConflict(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('sheetHeader.saveFailed'));
    }
  };

  const overwrite = async () => {
    if (!conflict) return;
    let version = conflict.currentVersion;
    if (version === null && props.campaignId && actorId) {
      version = (await client.getActor(props.campaignId, actorId)).version;
    }
    await persist(conflict.pending, version ?? undefined);
  };

  const levelUpLabel = isLive
    ? t('sheetHeader.levelUp')
    : t('sheetHeader.levelUpFromTo', { from: currentLevel, to: currentLevel + 1 });

  return h(
    'header',
    {
      class: `ds-character-sheet-header ${props.className ?? ''}`.trim(),
      'data-testid': 'character-sheet-header',
      role: 'region',
      'aria-label': t('sheetHeader.actionsLabel'),
    },
    h(
      'div',
      { class: 'ds-sheet-header-info' },
      h('h2', { class: 'ds-sheet-character-name', 'data-testid': 'sheet-actor-name' }, currentActor?.name ?? t('sheetHeader.unnamed')),
      h(
        'span',
        { class: 'ds-sheet-character-summary', 'data-testid': 'sheet-actor-summary' },
        t('sheetHeader.summary', { level: currentLevel, className: currentActor?.classId ?? '' }).trim(),
      ),
    ),
    h(
      'div',
      { class: 'ds-sheet-header-actions', role: 'toolbar', 'aria-label': t('sheetHeader.toolbarLabel') },
      h(
        'button',
        {
          type: 'button',
          class: 'ds-btn ds-btn-sm ds-btn-level-up',
          'data-testid': 'btn-level-up',
          disabled: isMaxLevel,
          'aria-disabled': isMaxLevel ? 'true' : 'false',
          'aria-label': isMaxLevel ? t('sheetHeader.levelUpDisabled') : levelUpLabel,
          title: isMaxLevel ? t('sheetHeader.maxLevel') : levelUpLabel,
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
          'aria-label': t('rest.short.title'),
          onClick: () => setRestState({ isOpen: true, restType: 'short' }),
        },
        t('rest.short.title'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'ds-btn ds-btn-sm ds-btn-long-rest',
          'data-testid': 'btn-long-rest',
          'aria-label': t('rest.long.title'),
          onClick: () => setRestState({ isOpen: true, restType: 'long' }),
        },
        t('rest.long.title'),
      ),
    ),
    conflict
      ? h(
          'div',
          { class: 'ds-panel ds-stack-sm', role: 'alert', 'data-testid': 'sheet-version-conflict' },
          h(
            'p',
            null,
            conflict.currentVersion === null
              ? t('sheetHeader.conflict.message')
              : t('sheetHeader.conflict.messageVersion', { version: conflict.currentVersion }),
          ),
          h(
            'div',
            { class: 'ds-cluster' },
            h(
              'button',
              { type: 'button', class: 'ds-btn ds-btn-sm ds-btn-secondary', 'data-testid': 'btn-conflict-reload', onClick: reloadLatest },
              t('sheetHeader.conflict.reload'),
            ),
            h(
              'button',
              { type: 'button', class: 'ds-btn ds-btn-sm ds-btn-danger', 'data-testid': 'btn-conflict-overwrite', onClick: overwrite },
              t('sheetHeader.conflict.overwrite'),
            ),
          ),
        )
      : null,
    saveError
      ? h('p', { class: 'ds-field-error', role: 'alert', 'data-testid': 'sheet-save-error' }, saveError)
      : null,
    isLevelUpOpen
      ? h(LevelUpModal, {
          isOpen: isLevelUpOpen,
          actor: currentActor,
          onClose: () => setIsLevelUpOpen(false),
          onSave: async (updated) => {
            setIsLevelUpOpen(false);
            await persist(updated);
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
            setRestState({ isOpen: false, restType: 'short' });
            await persist(updated);
          },
          diceRollService: props.diceRollService,
        })
      : null,
  );
}
