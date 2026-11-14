/**
 * ============================================================================
 * ACTIVATE-OVER-LIVE-PLAY CONFIRMATION (maps/ActivateSceneConfirmDialog.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * `ActivateScene` replaces the live table: unowned tokens are removed, player
 * characters jump to the new spawn points, and combat, pending rolls, area
 * effects, fog and terrain are reset to what the scene stores. One misclick
 * in the studio used to wipe a running fight. This module computes what an
 * activation would discard and asks the Game Master to confirm it first.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Confirm Only Over Live Play`:
 *    - `activationImpact` returns `null` (activate straight away) unless the
 *      table has combat running, rolls waiting for Apply, or monsters / NPCs
 *      that would be removed. Preparing an empty table never prompts.
 * 2. `Name Every Loss`:
 *    - The dialog lists each discarded thing with its count, and says that
 *      fog and terrain are replaced by the copy saved with the scene, so the
 *      GM can cancel and save the live rulings first.
 * 3. `Safe Default`:
 *    - Cancel is the first control and receives focus; `Escape` cancels; focus
 *      returns to the Activate button (`useModalFocusTrap`).
 * ============================================================================
 */
import { useRef } from 'preact/hooks';
import type { ProjectedTableState } from '../api/wire.ts';
import { useModalFocusTrap } from '../components/a11y/useModalFocusTrap.ts';
import { t, tn } from '../i18n/index.ts';
import type { CampaignMapScene } from './types.ts';

/** What activating a scene would discard on the live table (counts are `>= 0`). */
export interface ActivationImpact {
  /** Player-owned tokens moved to the scene's spawn points. */
  heroesMoved: number;
  /** Unowned tokens (spawned or previously staged monsters and NPCs) removed. */
  monstersRemoved: number;
  /** Combat round when combat is running, else `null`. */
  combatRound: number | null;
  /** Server-rolled actions still waiting for Apply. */
  pendingResolutions: number;
  /** Area-of-effect zones on the table. */
  areaEffects: number;
  /** Difficult-terrain cells on the table / saved with the scene. */
  terrain: { live: number; saved: number };
  /** Fog rulings on the table / saved with the scene. */
  fog: { live: number; saved: number };
}

/** The losses of activating `scene` over `table`, or `null` when no confirmation is needed (invariant 1). */
export function activationImpact(table: ProjectedTableState | null, scene: CampaignMapScene): ActivationImpact | null {
  if (!table) return null;
  const tokens = Object.values(table.tokens ?? {});
  const impact: ActivationImpact = {
    heroesMoved: tokens.filter((tok) => Boolean(tok.owner_user_id)).length,
    monstersRemoved: tokens.filter((tok) => !tok.owner_user_id).length,
    combatRound: table.mode === 'TURN_BY_TURN' ? table.round : null,
    pendingResolutions: Object.keys(table.pending_resolutions ?? {}).length,
    areaEffects: Object.keys(table.persistent_aoes ?? {}).length,
    terrain: { live: (table.difficult_terrain ?? []).length, saved: (scene.difficultTerrain ?? []).length },
    fog: { live: (table.fog_overrides ?? []).length, saved: (scene.fogOverrides ?? []).length },
  };
  const livePlay = impact.combatRound !== null || impact.pendingResolutions > 0 || impact.monstersRemoved > 0;
  return livePlay ? impact : null;
}

/** The dialog's loss sentences, in reading order (invariant 2). */
export function impactLines(impact: ActivationImpact): string[] {
  const lines: string[] = [];
  if (impact.combatRound !== null) lines.push(t('maps.activateConfirm.combat', { round: impact.combatRound }));
  if (impact.monstersRemoved > 0) lines.push(tn('maps.activateConfirm.monsters', impact.monstersRemoved));
  if (impact.heroesMoved > 0) lines.push(tn('maps.activateConfirm.heroes', impact.heroesMoved));
  if (impact.pendingResolutions > 0) lines.push(tn('maps.activateConfirm.pending', impact.pendingResolutions));
  if (impact.areaEffects > 0) lines.push(tn('maps.activateConfirm.aoes', impact.areaEffects));
  if (impact.terrain.live > 0 || impact.terrain.saved > 0) {
    lines.push(t('maps.activateConfirm.terrain', { live: impact.terrain.live, saved: impact.terrain.saved }));
  }
  if (impact.fog.live > 0 || impact.fog.saved > 0) {
    lines.push(t('maps.activateConfirm.fog', { live: impact.fog.live, saved: impact.fog.saved }));
  }
  return lines;
}

export interface ActivateSceneConfirmDialogProps {
  /** Scene the GM asked to activate. */
  scene: CampaignMapScene;
  /** Losses to list; from `activationImpact`. */
  impact: ActivationImpact;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ActivateSceneConfirmDialog({ scene, impact, onConfirm, onCancel }: ActivateSceneConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef, { onEscape: onCancel });
  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="activate-confirm-title"
      aria-describedby="activate-confirm-body"
      tabIndex={-1}
      class="ds-modal-backdrop"
      data-testid="activate-confirm"
    >
      <div class="ds-modal ds-modal-narrow">
        <header class="ds-modal-header">
          <h2 id="activate-confirm-title" class="ds-modal-title">{t('maps.activateConfirm.title', { name: scene.title })}</h2>
        </header>
        <div id="activate-confirm-body" class="ds-modal-body ds-stack-sm">
          <p>{t('maps.activateConfirm.intro')}</p>
          <ul data-testid="activate-confirm-losses">
            {impactLines(impact).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p class="ds-hint">{t('maps.activateConfirm.keepHint')}</p>
        </div>
        <footer class="ds-modal-footer ds-cluster">
          <button type="button" class="ds-btn ds-btn-secondary" data-testid="activate-confirm-cancel" onClick={onCancel}>
            {t('maps.activateConfirm.cancel')}
          </button>
          <button type="button" class="ds-btn ds-btn-danger" data-testid="activate-confirm-accept" onClick={onConfirm}>
            {t('maps.activateConfirm.accept')}
          </button>
        </footer>
      </div>
    </div>
  );
}
