/**
 * ============================================================================
 * LANGUAGE & GRID-UNIT TOGGLES (components/ShellToggles.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * One implementation of the language and grid-unit switches shared by the
 * desktop shell header, the mobile companion header, and the sign-in screen,
 * so their labels and accessible names cannot drift apart.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Target-Language Label`:
 *    - The language button names the language it switches TO, in that
 *      language ("Français" with `lang="fr"`), so a user who cannot read the
 *      current UI language can still find the way back (WCAG 3.1.2).
 * 2. `Label In Name`:
 *    - The units button's accessible name starts with its visible text
 *      (WCAG 2.5.3) and both go through `t()` / `formatGridUnit()`, so
 *      French shows `1,5 m`.
 * ============================================================================
 */
import { formatGridUnit, localeSignal, t, unitSystemSignal, type LocaleCode } from "../i18n/index.ts";

/** Extra props forwarded to both toggles (layout-specific inline style). */
export interface ShellToggleProps {
  style?: Record<string, string>;
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
