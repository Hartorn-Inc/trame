import { computeDnd5eSheetDerived, type Dnd5eActorData } from '../../../game-systems/dnd5e/src/index.ts';

/**
 * Builds the `{ sheet, derived }` binding root for `DeclarativeSheetView`.
 * Derived stats come only from the WASM evaluator; a malformed stored sheet
 * renders without derived values instead of breaking the whole view.
 */
export function sheetViewState(actor: Dnd5eActorData): { sheet: Dnd5eActorData; derived: unknown } {
  try {
    return { sheet: actor, derived: computeDnd5eSheetDerived(actor) };
  } catch {
    return { sheet: actor, derived: {} };
  }
}
