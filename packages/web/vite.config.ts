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
 * `/api` and `/ws` routes to `trame-server` (`http://localhost:3000`).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Single-Origin Production Parity`:
 *      - Emits production static assets to `packages/web/dist` so `trame-server`
 *        can serve the SPA directly from `TRAME_STATIC_DIR`.
 *   2. `Zero-Config Preact JSX`:
 *      - Uses esbuild's native `jsx: 'automatic'` with `jsxImportSource: 'preact'`
 *        so no external Babel/SWC plugins are required.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. `npm run dev` starts Vite on port 5173 and proxies `/api`, `/ws`, `/assets`.
 *   2. `npm run build` runs `tsc --noEmit && vite build` into `dist/`.
 * ============================================================================
 */

import { defineConfig } from 'vite';
import path from 'node:path';

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
        target: process.env.TRAME_API_ORIGIN ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: (process.env.TRAME_API_ORIGIN ?? 'http://localhost:3000').replace(/^http/, 'ws'),
        ws: true,
      },
      '/assets': {
        target: process.env.TRAME_API_ORIGIN ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@trame/game-system-dnd5e': path.resolve(__dirname, '../game-systems/dnd5e'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
