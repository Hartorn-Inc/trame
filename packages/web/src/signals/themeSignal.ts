/**
 * ============================================================================
 * TRAME ATLAS v1.1 REACTIVE THEME SIGNALS (themeSignal.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Governs reactive theme state (`dark`, `light`, `system`) across the TRAME
 * client via `@preact/signals`:
 *   - `themeModeSignal`: Active user preference ('dark' | 'light' | 'system').
 *   - `resolvedThemeSignal`: Evaluated effective theme ('dark' | 'light').
 *   - Synchronizes `document.documentElement` attribute `data-theme` and
 *     `data-resolved-theme`.
 *   - Persists user preference in `localStorage`.
 *   - Listens to host OS `prefers-color-scheme` media query changes.
 *
 * INVARIANTS (DESIGN.md & ADR-0011):
 * ---------------------------------
 *   1. Zero raw color literals: all visual rendering delegates to `tokens.css`
 *      and `CanvasThemePalette.ts`.
 *   2. Fail-safe execution: never throws in SSR, Node.js test runners,
 *      or storage-restricted private browsing contexts.
 *   3. Synchronous reactive consistency between signals, DOM attributes,
 *      and storage.
 * ============================================================================
 */

import { computed, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { AtlasThemeMode, ResolvedAtlasTheme } from "../canvas/CanvasThemePalette.ts";

export type { AtlasThemeMode, ResolvedAtlasTheme };

export const THEME_STORAGE_KEY = "trame_theme_mode";

/**
 * Evaluates whether the host OS currently prefers dark mode.
 * Safe fallback to false in non-browser or unsupported environments.
 */
export function getSystemPrefersDark(): boolean {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Safely reads the persisted theme mode from local storage.
 * Fallback to 'dark' (default tactical slate).
 */
export function readPersistedThemeMode(): AtlasThemeMode {
  if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light" || stored === "system") {
        return stored;
      }
    } catch {
      // Storage access may be blocked in restricted sandbox or private mode
    }
  }
  return "dark";
}

/**
 * Reactive signal reflecting the host OS dark mode preference.
 */
export const systemPrefersDarkSignal: Signal<boolean> = signal<boolean>(getSystemPrefersDark());

/**
 * Primary reactive signal governing the user-configured theme mode.
 */
export const themeModeSignal: Signal<AtlasThemeMode> = signal<AtlasThemeMode>(
  readPersistedThemeMode(),
);

/**
 * Computed reactive signal evaluating the effective theme ('dark' | 'light').
 */
export const resolvedThemeSignal: ReadonlySignal<ResolvedAtlasTheme> = computed<ResolvedAtlasTheme>(
  () => {
    const mode = themeModeSignal.value;
    if (mode === "dark") {
      return "dark";
    }
    if (mode === "light") {
      return "light";
    }
    return systemPrefersDarkSignal.value ? "dark" : "light";
  },
);

/**
 * Synchronizes the active theme mode and resolved theme to documentElement attributes
 * and local storage.
 */
export function syncThemeWithDom(): void {
  const mode = themeModeSignal.value;
  if (mode === "system") {
    systemPrefersDarkSignal.value = getSystemPrefersDark();
  }
  const resolved = resolvedThemeSignal.value;

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-theme", mode);
    document.documentElement.setAttribute("data-resolved-theme", resolved);
  }

  if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Storage access may fail silently in private browsing / sandboxes
    }
  }
}

/**
 * Imperatively updates the theme mode, syncing signals, DOM, and storage.
 */
export function setThemeMode(mode: AtlasThemeMode): void {
  themeModeSignal.value = mode;
  syncThemeWithDom();
}

/**
 * Updates the system preference signal from the current host matchMedia query.
 */
export function updateSystemThemePreference(): boolean {
  const isDark = getSystemPrefersDark();
  systemPrefersDarkSignal.value = isDark;
  return isDark;
}

// Auto-synchronize reactive state changes to DOM and storage
effect(() => {
  const mode = themeModeSignal.value;
  const resolved = resolvedThemeSignal.value;

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-theme", mode);
    document.documentElement.setAttribute("data-resolved-theme", resolved);
  }

  if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Storage failure safety
    }
  }
});

let mediaQueryCleanup: (() => void) | null = null;

/**
 * Initializes theme synchronization and attaches host media query listeners.
 * Returns a teardown function for deterministic test and unmount isolation.
 */
export function initThemeSignal(): () => void {
  syncThemeWithDom();

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent | MediaQueryList) => {
        systemPrefersDarkSignal.value = Boolean(e.matches);
        syncThemeWithDom();
      };

      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handler);
        mediaQueryCleanup = () => {
          mediaQuery.removeEventListener("change", handler);
          mediaQueryCleanup = null;
        };
      } else if (
        typeof (mediaQuery as { addListener?: (h: typeof handler) => void }).addListener ===
        "function"
      ) {
        (mediaQuery as { addListener: (h: typeof handler) => void }).addListener(handler);
        mediaQueryCleanup = () => {
          (mediaQuery as { removeListener?: (h: typeof handler) => void }).removeListener?.(
            handler,
          );
          mediaQueryCleanup = null;
        };
      }
    } catch {
      // Safe fallback
    }
  }

  return () => {
    if (mediaQueryCleanup) {
      mediaQueryCleanup();
    }
  };
}

// Automatically bind in browser contexts
if (typeof window !== "undefined") {
  initThemeSignal();
}
