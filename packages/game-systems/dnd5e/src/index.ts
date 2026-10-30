/**
 * ============================================================================
 * D&D 5E GAME SYSTEM PACKAGE PUBLIC BARREL (index.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Aggregates and re-exports the complete public surface of `@trame/game-system-dnd5e`
 * (`types`, `manifest`, `pipeline`, `progression`, and `compendium`) behind a
 * single deterministic entry point for both the server authority and web client.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Side-Effect-Free Barrel`:
 *      - Contains strictly declarative module re-exports with zero top-level
 *        mutable state or runtime I/O, preserving tree-shaking and deterministic
 *        bundle initialization.
 * ============================================================================
 */

export * from "./types.ts";
export * from "./manifest.ts";
export * from "./pipeline.ts";
export * from "./progression.ts";
export * from "./compendium.ts";
export * from "./sheetLayout.ts";
export { computeDnd5eSheetDerived } from "./manifest.ts";
export { decrementConditionDurations } from "./progression.ts";
