/**
 * ============================================================================
 * LAZY GENERATED SRD 5.2.1 PACKS & CURATED MERGE (srdPacks.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Loads the generated packs (`packs/spells.json`, `packs/monsters.json`,
 * `packs/magic-items.json`, about 1.6 MB of JSON) on demand and merges them
 * with the curated `SYSTEM_SRD` catalog. Importing them statically would put
 * the whole SRD in the web app's entry bundle; dynamic `import()` lets the
 * bundler emit them as separate chunks fetched only when a full compendium
 * is needed (audit GS7, decision D8).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `SYSTEM_SRD Stays Synchronous And Small`:
 *      - The curated catalog keeps working without the packs; the full
 *        catalog is an explicit async opt-in (`loadFullSystemSrd`).
 *   2. `Generated Rules, Curated Translations`:
 *      - When a generated entry shares its id with a curated one, the
 *        generated `data` wins key by key (SRD-verbatim stat blocks,
 *        concentration flags, class lists), curated-only `data` keys
 *        survive (container capacity, `halfDamageOnSave`), and the curated
 *        bilingual `i18n` block is kept.
 *   3. `Stable Ids`:
 *      - Every curated id stays resolvable; generated-only entries are
 *        appended after the curated ones.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `createFullSrdResolver(instanceLibrary, campaignHomebrew)`
 *     ├── 1. `loadSrdPacks()`: dynamic JSON imports, cached after the first call.
 *     ├── 2. `mergeSrdEntries(SYSTEM_SRD, generated)`.
 *     └── 3. `new CompendiumResolver(merged, instanceLibrary, campaignHomebrew)`.
 * ============================================================================
 */

import { CompendiumResolver, SYSTEM_SRD, type CompendiumEntry } from "./compendium.ts";

/** Generated SRD 5.2.1 packs, each sorted by id. */
export interface SrdPacks {
  spells: CompendiumEntry[];
  monsters: CompendiumEntry[];
  magicItems: CompendiumEntry[];
}

let packsPromise: Promise<SrdPacks> | undefined;
let fullSrdPromise: Promise<CompendiumEntry[]> | undefined;

/** Loads the generated packs once; later calls share the same promise. */
export function loadSrdPacks(): Promise<SrdPacks> {
  packsPromise ??= Promise.all([
    import("../packs/spells.json", { with: { type: "json" } }),
    import("../packs/monsters.json", { with: { type: "json" } }),
    import("../packs/magic-items.json", { with: { type: "json" } }),
  ]).then(([spells, monsters, magicItems]) => ({
    spells: spells.default as unknown as CompendiumEntry[],
    monsters: monsters.default as unknown as CompendiumEntry[],
    magicItems: magicItems.default as unknown as CompendiumEntry[],
  }));
  return packsPromise;
}

/**
 * Merges generated entries into a base catalog by id (see banner invariant 2).
 * Base order is preserved; generated-only entries follow in their pack order.
 */
export function mergeSrdEntries(
  base: readonly CompendiumEntry[],
  generated: readonly CompendiumEntry[]
): CompendiumEntry[] {
  const generatedById = new Map(generated.map((entry) => [entry.id, entry]));
  const merged = base.map((entry): CompendiumEntry => {
    const fresh = generatedById.get(entry.id);
    if (!fresh) return entry;
    generatedById.delete(entry.id);
    return {
      ...entry,
      ...fresh,
      data: { ...entry.data, ...fresh.data },
      ...(entry.i18n ? { i18n: entry.i18n } : {}),
    };
  });
  return [...merged, ...generatedById.values()];
}

/** Curated `SYSTEM_SRD` merged with every generated pack. Cached after the first call. */
export function loadFullSystemSrd(): Promise<CompendiumEntry[]> {
  fullSrdPromise ??= loadSrdPacks().then(({ spells, monsters, magicItems }) =>
    mergeSrdEntries(SYSTEM_SRD, [...spells, ...monsters, ...magicItems])
  );
  return fullSrdPromise;
}

/** Resolver over the full SRD 5.2.1 catalog with optional instance and campaign tiers. */
export async function createFullSrdResolver(
  instanceLibrary: CompendiumEntry[] = [],
  campaignHomebrew: CompendiumEntry[] = []
): Promise<CompendiumResolver> {
  return new CompendiumResolver(await loadFullSystemSrd(), instanceLibrary, campaignHomebrew);
}
