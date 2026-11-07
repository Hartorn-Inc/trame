/**
 * ============================================================================
 * BACKGROUND SRD PACK LOADING (srdLoading.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * The generated SRD 5.2.1 packs (about 1.6 MB of JSON) used to be awaited
 * before the first render, so a slow network kept the whole table blank.
 * The app now renders as soon as the engine is ready and loads the packs in
 * the background; this module tracks that load in `srdStatusSignal` so the
 * shell can show a non-blocking notice and sheets derive again once the
 * full catalog is installed.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Curated Catalog Until Ready`:
 *    - Until `installFullSystemSrd()` resolves, `CompendiumResolver.getDefault()`
 *      is the curated catalog; derivations skip pack-only spells instead of
 *      failing (`srdPacks.ts` invariant 4).
 * 2. `Derive Again On Change`:
 *    - `App` reads `srdStatusSignal`, so every status change re-renders the
 *      tree and sheet derivations run again against the new default resolver.
 * 3. `Bounded Notice`:
 *    - After `SRD_LOAD_TIMEOUT_MS` without an answer the status becomes
 *      `fallback` (the notice says the core catalog is in use); packs that
 *      arrive later still switch it to `ready`. A failed load stays `fallback`.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `main.tsx`
 * ├── 1. `loadSrdInBackground()` -> status `loading`.
 * ├── 2. `initEngine()` settles -> `render(<App />)` (packs may still load).
 * └── 3. install resolves -> `ready`; rejects or times out -> `fallback`.
 * ============================================================================
 */
import { signal } from '@preact/signals';
import { installFullSystemSrd } from '../../game-systems/dnd5e/src/srdPacks.ts';

/**
 * - `loading`: the packs are being fetched; the curated catalog is in use.
 * - `ready`: the full SRD catalog is the default resolver.
 * - `fallback`: the load failed or exceeded the timeout; the curated catalog is in use.
 */
export type SrdStatus = 'loading' | 'ready' | 'fallback';

/** Wait (`ms`) before a pending load is reported as `fallback` (invariant 3). */
export const SRD_LOAD_TIMEOUT_MS = 15_000;

/** Status of the background SRD pack load. */
export const srdStatusSignal = signal<SrdStatus>('ready');

/** Starts the background install; resolves once it settles (never rejects). */
export function loadSrdInBackground(install: () => Promise<unknown> = installFullSystemSrd, timeoutMs = SRD_LOAD_TIMEOUT_MS): Promise<void> {
  srdStatusSignal.value = 'loading';
  const timer = setTimeout(() => {
    if (srdStatusSignal.value === 'loading') srdStatusSignal.value = 'fallback';
  }, timeoutMs);
  return install().then(
    () => {
      clearTimeout(timer);
      srdStatusSignal.value = 'ready';
    },
    () => {
      clearTimeout(timer);
      srdStatusSignal.value = 'fallback';
    },
  );
}
