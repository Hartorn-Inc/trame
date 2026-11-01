/**
 * ============================================================================
 * PLAYWRIGHT CONFIGURATION FOR THE TWO-BROWSER E2E SUITE (playwright.config.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Runs `tests/` serially against a running TRAME server (`E2E_BASE_URL`,
 * default `http://localhost:8080`, the address seen from inside the server's
 * network namespace in `docker-compose.e2e.yml`) and writes the HTML report,
 * the JSON results, and both recordings under `E2E_ARTIFACTS_DIR`.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `One Worker, No Retries`:
 *    - The journey shares one campaign across its phases; a retry would
 *      start a second campaign and duplicate the videos.
 * 2. `Video Owned By The Spec`:
 *    - The spec creates its own recorded contexts, so the fixture-level
 *      `video` option stays off.
 * 3. `Watchable Recordings`:
 *    - `E2E_SLOW_MO` (ms per browser action, default 250, `0` disables)
 *      slows the journey so the side-by-side video can be followed by eye.
 * ============================================================================
 */
import { defineConfig, devices } from '@playwright/test';

const artifacts = process.env.E2E_ARTIFACTS_DIR ?? 'artifacts';

export default defineConfig({
  testDir: 'tests',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: `${artifacts}/report`, open: 'never' }],
    ['json', { outputFile: `${artifacts}/results.json` }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    actionTimeout: 15_000,
    trace: 'off',
    video: 'off',
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO ?? 250) },
  },
});
