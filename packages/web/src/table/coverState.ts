/**
 * ============================================================================
 * TARGET & ACCEPTED COVER STATE (table/coverState.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Holds the attacker's chosen target and the cover level the user accepted
 * for it. `CoverSuggestionPanel` writes them; the action resolution reads
 * them. Keeping the signals out of the panel component lets the resolution
 * logic (`actionResolution.ts`) depend on plain state instead of a UI module.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Explicit Acceptance Only`:
 *    - `acceptedCoverSignal` changes only on an explicit "Use this cover" in
 *      the panel; a suggestion alone never changes AC or a saving throw.
 * 2. `Scoped To One Pair`:
 *    - An accepted cover names its attacker and target; the resolution
 *      ignores it for any other pair.
 * ============================================================================
 */
import { signal } from '@preact/signals';
import type { Uuid } from '../api/wire.ts';
import type { CoverLevel } from '../engine/wasmBridge.ts';

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
