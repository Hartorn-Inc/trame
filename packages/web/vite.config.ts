/**
 * ============================================================================
 * VITE BUNDLER CONFIGURATION (vite.config.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Configures the Vite build and development server for `@trame/web`, enabling
 * Preact automatic JSX transformation (`jsxImportSource: 'preact'`), top-level
 * WebAssembly loading (`trame-engine`), and local development proxying of
 * `/api`, `/ws` and `/assets/download` routes to `trame-server`.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Single-Origin Production Parity`:
 *      - Emits production static assets to `packages/web/dist` so `trame-server`
 *        can serve the SPA directly from `TRAME_STATIC_DIR`.
 *   2. `Single Proxy Variable`:
 *      - `TRAME_API_ORIGIN` is the only proxy input; `docker-compose.dev.yml`
 *        sets it to `http://rust-dev:8080`. Outside Docker it falls back to
 *        `http://localhost:8080`, the `trame-server` default port. It has no
 *        `VITE_` prefix, so it never leaks into the client bundle.
 *   3. `Zero-Config Preact JSX`:
 *      - Uses esbuild's native `jsx: 'automatic'` with `jsxImportSource: 'preact'`
 *        so no external Babel/SWC plugins are required.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. `npm run dev` starts Vite on port 5173 and proxies `/api`, `/ws`, `/assets/download`.
 *   2. `npm run build` runs `tsc --noEmit && vite build` into `dist/`.
 * ============================================================================
 */

import { defineConfig } from 'vite';

const apiOrigin = process.env.TRAME_API_ORIGIN ?? 'http://localhost:8080';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        // The live table socket lives under `/api/v1/campaigns/{id}/ws`.
        ws: true,
      },
      '/ws': {
        target: apiOrigin.replace(/^http/, 'ws'),
        ws: true,
      },
      // Only signed downloads are API routes; the rest of `/assets` is Vite's own bundle.
      '/assets/download': {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
