/**
 * ============================================================================
 * THEME, LANGUAGE & GRID-UNIT TOGGLES (components/ShellToggles.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * One implementation of the theme (`dark` / `light` / `system`), language, and
 * grid-unit switches shared by the desktop shell header, the mobile companion
 * header, and the pre-auth entry screens, so their labels and accessible names
 * cannot drift apart.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Target-Language Label`:
 *    - The language button names the language it switches TO, in that
 *      language ("Français" with `lang="fr"`), so a user who cannot read the
 *      current UI language can still find the way back (WCAG 3.1.2).
 * 2. `Label In Name`:
 *    - Both the theme button and the units button start their `aria-label`
 *      with their visible text (WCAG 2.5.3) and announce the target state via
 *      `t()`.
 * 3. `Reactive Theme Persistence`:
 *    - `ThemeToggle` delegates to `setThemeMode()` so `themeModeSignal`,
 *      `resolvedThemeSignal`, `document.documentElement[data-theme]`, and
 *      `localStorage` stay synchronized without raw color literals.
 * ============================================================================
 */
import { formatGridUnit, localeSignal, t, unitSystemSignal, type LocaleCode, type MessageKey } from "../i18n/index.ts";
import { setThemeMode, themeModeSignal, type AtlasThemeMode } from "../signals/themeSignal.ts";

/** Extra props forwarded to shell toggles (layout-specific inline style). */
export interface ShellToggleProps {
  style?: Record<string, string>;
}

/** Ordered cycle of ATLAS v1.1 theme modes exposed by `ThemeToggle`. */
export const THEME_MODES: readonly AtlasThemeMode[] = ["dark", "light", "system"];

const THEME_LABEL_KEYS: Record<AtlasThemeMode, MessageKey> = {
  dark: "shell.theme.dark",
  light: "shell.theme.light",
  system: "shell.theme.system",
};

/** Returns the next theme mode in the deterministic `dark -> light -> system -> dark` cycle. */
export function nextThemeMode(current: AtlasThemeMode): AtlasThemeMode {
  const idx = THEME_MODES.indexOf(current);
  return THEME_MODES[(idx + 1) % THEME_MODES.length] ?? "dark";
}

/** Cycles the ATLAS v1.1 theme across Dark, Light (Warm Parchment), and System. */
export function ThemeToggle({ style }: ShellToggleProps) {
  const current = themeModeSignal.value;
  const next = nextThemeMode(current);
  const currentLabel = t(THEME_LABEL_KEYS[current]);
  const nextLabel = t(THEME_LABEL_KEYS[next]);
  return (
    <button
      type="button"
      data-testid="header-theme-toggle"
      class="ds-btn ds-btn-secondary"
      aria-label={t("shell.toggleTheme", { current: currentLabel, next: nextLabel })}
      style={style}
      onClick={() => {
        setThemeMode(next);
      }}
    >
      {currentLabel}
    </button>
  );
}

/** Switches between English and French; labelled with the target language. */
export function LocaleToggle({ style }: ShellToggleProps) {
  const target: LocaleCode = localeSignal.value === "en" ? "fr" : "en";
  return (
    <button
      type="button"
      data-testid="header-locale-toggle"
      class="ds-btn ds-btn-secondary"
      lang={target}
      style={style}
      onClick={() => {
        localeSignal.value = target;
      }}
    >
      {t(target === "fr" ? "locale.name.fr" : "locale.name.en")}
    </button>
  );
}

/** Switches the grid between imperial feet and metric meters. */
export function UnitsToggle({ style }: ShellToggleProps) {
  const unit = formatGridUnit();
  return (
    <button
      type="button"
      data-testid="header-units-toggle"
      class="ds-btn ds-btn-secondary"
      aria-label={t("shell.toggleUnits", { unit })}
      style={style}
      onClick={() => {
        unitSystemSignal.value = unitSystemSignal.value === "imperial_ft" ? "metric_m" : "imperial_ft";
      }}
    >
      {unit}
    </button>
  );
}
