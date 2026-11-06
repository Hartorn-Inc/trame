/**
 * ============================================================================
 * D&D 5E GAME SYSTEM PACKAGE PUBLIC BARREL (index.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Aggregates and re-exports the complete public surface of `@trame/game-system-dnd5e`
 * (`types`, `formulaEvaluator`, `manifest`, `pipeline`, `progression`, `origins`,
 * `classRules`, `classFeatures`, `derivations`, `builderChoices`, `compendium`, `monsterStatBlock`,
 * `srdPacks`, `sheetLayout`, `rest`, and `conditions`) behind a
 * single deterministic entry point for both the server authority and web client.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Side-Effect-Free Barrel`:
 *      - Contains strictly declarative module re-exports with zero top-level
 *        mutable state or runtime I/O, preserving tree-shaking and deterministic
 *        bundle initialization. The generated SRD packs are only fetched when
 *        `loadSrdPacks()` is called (dynamic `import()`).
 * ============================================================================
 */

export * from "./types.ts";
export * from "./formulaEvaluator.ts";
export * from "./manifest.ts";
export * from "./pipeline.ts";
export * from "./progression.ts";
export * from "./origins.ts";
export * from "./classRules.ts";
export * from "./classFeatures.ts";
export * from "./derivations.ts";
export * from "./builderChoices.ts";
export * from "./compendium.ts";
export * from "./monsterStatBlock.ts";
export * from "./srdPacks.ts";
export * from "./sheetLayout.ts";
export * from "./rest.ts";
export * from "./conditions.ts";
export { computeDnd5eSheetDerived } from "./manifest.ts";
export { decrementConditionDurations } from "./progression.ts";
