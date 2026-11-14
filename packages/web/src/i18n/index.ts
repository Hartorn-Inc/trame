/**
 * ============================================================================
 * UI LOCALIZATION, LOCALE SIGNAL & TACTICAL UNITS (i18n/index.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Single entry point for every user-visible UI string (grill decision G3).
 * Components call `t(key)` / `tn(key, count)`; English (`en.ts`) is the
 * canonical dictionary and French (`fr.ts`) must translate every key.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Compile-Time Key Parity`:
 *    - `MessageKey` is derived from the English dictionary and `FR` is typed
 *      `Record<MessageKey, string>`, so a missing or extra French key fails
 *      `tsc`. A runtime parity test guards the same contract.
 * 2. `English Fallback`:
 *    - A key absent from the active locale falls back to English, then to the
 *      key itself, so a bad lookup is visible but never crashes rendering.
 * 3. `Locale-Aware Plurals & Numbers`:
 *    - `tn()` selects `<key>.one` / `<key>.other` through `Intl.PluralRules`
 *      (French treats 0 as singular), and distances format decimals with the
 *      active locale (`1.5 m` vs `1,5 m`).
 * 4. `Document Language`:
 *    - `<html lang>` follows `localeSignal` from startup onward, so assistive
 *      technology never reads French UI with an English voice.
 * ============================================================================
 */
import { signal } from "@preact/signals";
import { EN, type MessageKey } from "./en.ts";
import { FR } from "./fr.ts";

export type { MessageKey } from "./en.ts";

/** Supported UI locales. English is canonical. */
export type LocaleCode = "en" | "fr";
/** Grid distance display: imperial feet or metric meters (1 square = 5 ft = 1.5 m). */
export type UnitSystem = "imperial_ft" | "metric_m";

/** `localStorage` key holding the user's explicit locale choice. */
export const STORAGE_KEY_LOCALE = "trame_locale";

/** Resolves the startup locale: stored choice, then browser language, then English. */
export function getInitialLocale(): LocaleCode {
  try {
    const storage =
      typeof window !== "undefined"
        ? window.localStorage
        : typeof localStorage !== "undefined"
          ? localStorage
          : null;
    const stored = storage?.getItem(STORAGE_KEY_LOCALE);
    if (stored === "en" || stored === "fr") {
      return stored;
    }
  } catch {
    // Fall back to navigator language when localStorage is restricted
  }

  try {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav?.language && nav.language.toLowerCase().startsWith("fr")) {
      return "fr";
    }
  } catch {
    // Fall back to default English when navigator is unavailable
  }

  return "en";
}

export const localeSignal = signal<LocaleCode>(getInitialLocale());
export const unitSystemSignal = signal<UnitSystem>("imperial_ft");
export const mobileCompanionOverrideSignal = signal<boolean>(false);

/**
 * Mirrors the active locale onto `<html lang>` (WCAG 3.1.1) so screen readers
 * pick the right voice and hyphenation. No-op outside a browser document.
 */
export function applyDocumentLang(locale: LocaleCode): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = locale;
  }
}

// `subscribe` runs immediately with the startup locale, then on every change.
localeSignal.subscribe(applyDocumentLang);

localeSignal.subscribe((val) => {
  try {
    const storage =
      typeof window !== "undefined"
        ? window.localStorage
        : typeof localStorage !== "undefined"
          ? localStorage
          : null;
    storage?.setItem(STORAGE_KEY_LOCALE, val);
  } catch {
    // Silently ignore storage errors in environments without write access
  }
});

/** Every UI dictionary, keyed by locale. English is the source of truth. */
export const I18N_DICTIONARY: Record<LocaleCode, Record<MessageKey, string>> = {
  en: EN,
  fr: FR,
};

export const COMPENDIUM_LEXICON_FR_TO_EN: Record<string, string> = {
  "furtivité": "stealth",
  "force": "strength",
  "boule de feu": "fireball",
  "repos court": "short_rest",
  "immobilisation de personne": "hold_person",
};

/** Interpolation values substituted into `{{name}}` placeholders. */
export type MessageVars = Record<string, string | number>;

function interpolate(text: string, vars?: MessageVars): string {
  if (!vars) return text;
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

/** Translates `key` in the active locale, substituting `{{var}}` placeholders. */
export function t(key: MessageKey, vars?: MessageVars): string {
  const text = I18N_DICTIONARY[localeSignal.value]?.[key] ?? EN[key] ?? key;
  return interpolate(text, vars);
}

/**
 * Translates a layout-authored string (sheet layout titles, tab labels,
 * widget option labels). Known message keys are translated; literals supplied
 * by third-party system layouts pass through unchanged.
 */
export function translateLayoutText(text: string): string {
  return hasMessage(text) ? t(text) : text;
}

/** True when `key` exists in the canonical English dictionary. */
export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(EN, key);
}

/**
 * Translates a counted message. Looks up `<key>.one` or `<key>.other` using
 * the active locale's CLDR plural category and exposes `{{count}}`.
 */
export function tn(key: string, count: number, vars?: MessageVars): string {
  const category = new Intl.PluralRules(localeSignal.value).select(count) === "one" ? "one" : "other";
  return t(`${key}.${category}` as MessageKey, { count, ...vars });
}

/** Formats a number with the active locale's decimal separator. */
export function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(localeSignal.value, { maximumFractionDigits }).format(value);
}

/** Formats a UNIX epoch time in seconds as a medium date + short time in the active locale. */
export function formatEpochSeconds(seconds: number): string {
  return new Intl.DateTimeFormat(localeSignal.value, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seconds * 1000),
  );
}

/**
 * Formats a grid distance given in feet for the active unit system.
 * Metric uses the D&D 5e convention 5 ft = 1.5 m and appends the square count.
 */
export function formatDistanceFt(feet: number): string {
  if (unitSystemSignal.value === "imperial_ft") {
    return t("distance.feet", { value: formatNumber(feet) });
  }
  const squares = Math.round(feet / 5);
  return t("distance.meters", {
    value: formatNumber(feet * 0.3),
    squares: tn("distance.squares", squares),
  });
}

/** Size of one grid square in the active unit system: `5 ft`, or `1.5 m` / `1,5 m`. */
export function formatGridUnit(): string {
  return unitSystemSignal.value === "imperial_ft"
    ? t("distance.feet", { value: formatNumber(5) })
    : t("distance.metersShort", { value: formatNumber(1.5) });
}

/** Compendium entry carrying an English name and optional localized names. */
export type LocalizedEntry = {
  name: string;
  i18n?: Partial<Record<LocaleCode, { name?: string }>>;
};

/** Returns the entry name in the active locale, falling back to English. */
export function localizedName(entry: LocalizedEntry): string {
  return entry.i18n?.[localeSignal.value]?.name ?? entry.name;
}

export function resolveCompendiumSearchQuery(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = [normalized];
  if (localeSignal.value === "fr" && COMPENDIUM_LEXICON_FR_TO_EN[normalized]) {
    terms.push(COMPENDIUM_LEXICON_FR_TO_EN[normalized]);
  }
  return terms;
}
