import { signal } from "@preact/signals";

export type LocaleCode = "en" | "fr";
export type UnitSystem = "imperial_ft" | "metric_m";

export const localeSignal = signal<LocaleCode>("en");
export const unitSystemSignal = signal<UnitSystem>("imperial_ft");
export const mobileCompanionOverrideSignal = signal<boolean>(false);

export const I18N_DICTIONARY: Record<LocaleCode, Record<string, string>> = {
  en: {
    "nav.sheet": "Character Sheet",
    "nav.dice": "Dice Roller",
    "nav.inventory": "Inventory",
    "nav.tracker": "Initiative Tracker",
    "nav.journal": "Party Journal",
    "note.scope.private": "Personal Note",
    "note.scope.party": "Party Wiki",
    "note.scope.dm_only": "GM Secret",
    "action.reveal": "Reveal to Players",
    "distance.squares.singular": "case",
    "distance.squares.plural": "cases",
  },
  fr: {
    "nav.sheet": "Fiche de personnage",
    "nav.dice": "Lanceur de dés",
    "nav.inventory": "Inventaire",
    "nav.tracker": "Piste d'initiative",
    "nav.journal": "Journal de groupe",
    "note.scope.private": "Note personnelle",
    "note.scope.party": "Wiki de groupe",
    "note.scope.dm_only": "Secret MJ",
    "action.reveal": "Révéler aux joueurs",
    "distance.squares.singular": "case",
    "distance.squares.plural": "cases",
  },
};

export const COMPENDIUM_LEXICON_FR_TO_EN: Record<string, string> = {
  "furtivité": "stealth",
  "force": "strength",
  "boule de feu": "fireball",
  "repos court": "short_rest",
  "immobilisation de personne": "hold_person",
};

export function t(key: string, vars?: Record<string, string | number>): string {
  const currentLocale = localeSignal.value;
  let text = I18N_DICTIONARY[currentLocale]?.[key] ?? I18N_DICTIONARY.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars))
      text = text.replaceAll(`{{${k}}}`, String(v));
  }
  return text;
}

export function formatDistanceFt(feet: number): string {
  if (unitSystemSignal.value === "imperial_ft") {
    return `${feet} ft`;
  }
  const meters = (feet * 0.3).toFixed(1).replace(/\.0$/, "");
  const squares = Math.round(feet / 5);
  const squareUnit = squares <= 1 ? "case" : "cases";
  return `${meters} m (${squares} ${squareUnit})`;
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
