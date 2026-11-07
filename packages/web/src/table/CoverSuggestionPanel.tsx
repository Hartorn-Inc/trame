/**
 * ============================================================================
 * TARGETING & COVER SUGGESTION (table/CoverSuggestionPanel.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lets the controller of the selected token pick a target and shows the cover
 * the walls between them suggest (WASM `suggestCover`, the same corner rule
 * the server would use). The user accepts the suggestion or picks another
 * level; only the accepted value (`acceptedCoverSignal`) feeds the attack
 * and saving throw resolution, so a wall misread never changes AC silently.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Suggestion, Never Applied`:
 *    - Changing the target or the selection clears nothing on the table;
 *      `acceptedCoverSignal` only changes on an explicit "Use this cover".
 * 2. `Engine Geometry Only`:
 *    - Cover comes from `suggestCover` over every projected wall with its
 *      kind (open doors and illusions never give cover). Without the engine
 *      no suggestion is shown, and the user can still choose a level.
 * 3. `Visible Targets Only`:
 *    - The target list holds the tokens of the projection, so a hidden
 *      creature can never be targeted or leak through this list.
 * 4. `Not Colour Alone`:
 *    - The suggestion is a sentence naming the level and its bonus.
 * 5. `Total Cover Is a GM Ruling`:
 *    - The engine never suggests Total Cover (four blocked lines are
 *      Three-Quarters); only the Game Master is offered it in the choice.
 * 6. `No State Across Tokens`:
 *    - The panel is keyed by the selected attacker and target, so a level
 *      picked but not accepted resets whenever either changes.
 * ============================================================================
 */
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import { selectedTokenIdSignal } from '../api/session.ts';
import type { ProjectedTableState, Uuid } from '../api/wire.ts';
import { isEngineReady, suggestCover, type CoverLevel, type CoverSuggestion } from '../engine/wasmBridge.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { boardMetrics, engineWalls } from './scene/tableScene.ts';
import { listTableTokens, type TableToken } from './tableView.ts';

/** Every cover level, weakest first. */
export const COVER_LEVELS: readonly CoverLevel[] = ['NONE', 'HALF', 'THREE_QUARTERS', 'TOTAL'];

/** AC and Dexterity saving throw bonus per level; `null` = cannot be targeted (SRD 5.2.1). */
export const COVER_BONUS: Readonly<Record<CoverLevel, number | null>> = { NONE: 0, HALF: 2, THREE_QUARTERS: 5, TOTAL: null };

/** Cover the user confirmed for an attacker against a target. */
export interface AcceptedCover {
  attackerId: Uuid;
  targetId: Uuid;
  cover: CoverLevel;
  /** `COVER_BONUS[cover]`. */
  bonus: number | null;
}

/** Token the selected attacker targets (`null` when none). */
export const targetTokenIdSignal = signal<Uuid | null>(null);

/** Last cover the user accepted (invariant 1). */
export const acceptedCoverSignal = signal<AcceptedCover | null>(null);

/** Engine cover suggestion between two tokens, `null` when the engine is not ready or fails. */
export function coverSuggestionFor(state: ProjectedTableState | null, attacker: TableToken, target: TableToken): CoverSuggestion | null {
  if (!state || !isEngineReady()) return null;
  const footprint = (token: TableToken) => ({
    topLeft: token.topLeft,
    gridW: token.gridW,
    gridH: token.gridH,
    elevationFt: token.elevationFt,
    heightFt: token.heightFt,
  });
  try {
    return suggestCover(footprint(attacker), footprint(target), engineWalls(state.walls ?? [], 'vision'), boardMetrics(state).cellPx);
  } catch {
    return null;
  }
}

function coverLabel(cover: CoverLevel): string {
  return t(`cover.level.${cover}` as MessageKey);
}

function coverEffect(cover: CoverLevel): string {
  const bonus = COVER_BONUS[cover];
  return bonus === null ? t('cover.untargetable') : t('cover.bonus', { bonus });
}

export interface CoverSuggestionPanelProps {
  client: ApiClient;
  /** Only the Game Master may rule Total Cover (invariant 5). */
  isGm?: boolean;
}

/** Remounts per attacker and target, so a cover level picked for one pair never carries over. */
export function CoverSuggestionPanel(props: CoverSuggestionPanelProps) {
  return <CoverSuggestionBody key={`${selectedTokenIdSignal.value ?? ''}|${targetTokenIdSignal.value ?? ''}`} {...props} />;
}

function CoverSuggestionBody({ client, isGm = false }: CoverSuggestionPanelProps) {
  const state = client.state.table.value;
  const tokens = listTableTokens(state);
  const attacker = tokens.find((tok) => tok.id === selectedTokenIdSignal.value && tok.controlled) ?? null;
  const [choice, setChoice] = useState<CoverLevel | null>(null);
  if (!attacker) return null;
  const candidates = tokens.filter((tok) => tok.id !== attacker.id);
  const target = candidates.find((tok) => tok.id === targetTokenIdSignal.value) ?? null;
  const suggestion = target ? coverSuggestionFor(state, attacker, target) : null;
  const selected = choice ?? suggestion?.cover ?? 'NONE';
  const accepted = acceptedCoverSignal.value;
  const acceptedHere = accepted && target && accepted.attackerId === attacker.id && accepted.targetId === target.id ? accepted : null;

  return (
    <section class="ds-panel ds-stack-sm" aria-label={t('cover.title')} data-testid="cover-panel">
      <h3 class="ds-panel-title">{t('cover.title')}</h3>
      <label class="ds-field-label" for="cover-target">{t('cover.target')}</label>
      <select
        id="cover-target"
        class="ds-input"
        data-testid="cover-target"
        value={target?.id ?? ''}
        onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value;
          targetTokenIdSignal.value = id || null;
          setChoice(null);
        }}
      >
        <option value="">{t('cover.noTarget')}</option>
        {candidates.map((tok) => (
          <option key={tok.id} value={tok.id}>{tok.name}</option>
        ))}
      </select>
      {target ? (
        <>
          <p class="ds-hint" data-testid="cover-suggestion" aria-live="polite">
            {suggestion
              ? t('cover.suggested', { level: coverLabel(suggestion.cover), effect: coverEffect(suggestion.cover) })
              : t('cover.noSuggestion')}
          </p>
          <div class="ds-cluster">
            <label class="ds-field-label" for="cover-choice">{t('cover.choice')}</label>
            <select
              id="cover-choice"
              class="ds-input"
              data-testid="cover-choice"
              value={selected}
              onChange={(e) => setChoice((e.target as HTMLSelectElement).value as CoverLevel)}
            >
              {COVER_LEVELS.filter((level) => isGm || level !== 'TOTAL').map((level) => (
                <option key={level} value={level}>{coverLabel(level)}</option>
              ))}
            </select>
            <button
              type="button"
              class="ds-btn ds-btn-secondary"
              data-testid="cover-accept"
              onClick={() => {
                acceptedCoverSignal.value = { attackerId: attacker.id, targetId: target.id, cover: selected, bonus: COVER_BONUS[selected] };
              }}
            >
              {t('cover.accept')}
            </button>
          </div>
          {acceptedHere ? (
            <p class="ds-value" data-testid="cover-accepted">
              {t('cover.accepted', { level: coverLabel(acceptedHere.cover), effect: coverEffect(acceptedHere.cover) })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
