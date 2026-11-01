import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { h, options, render } from "preact";
import { setupMockDom } from "./helpers/mockDom.ts";

options.debounceRendering = (cb: () => void) => cb();
const doc = setupMockDom() as any;
const stored = new Map<string, string>([["trame_locale", "fr"]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
    removeItem: (k: string) => stored.delete(k),
  },
});
const startupLang = (doc.documentElement as any).lang;

const { localeSignal, unitSystemSignal } = await import("../src/i18n/index.ts");
const { LocaleToggle, UnitsToggle } = await import("../src/components/ShellToggles.tsx");

describe("document.documentElement.lang follows localeSignal", () => {
  it("is set from the stored locale at startup, before any component renders", () => {
    assert.equal(startupLang, undefined, "precondition: the mock starts without lang");
    assert.equal(doc.documentElement.lang, "fr");
  });

  const cases = [
    { id: "switching to English sets lang=en", locale: "en" as const },
    { id: "switching back to French sets lang=fr", locale: "fr" as const },
  ];

  for (const c of cases) {
    it(c.id, () => {
      localeSignal.value = c.locale;
      assert.equal(doc.documentElement.lang, c.locale);
    });
  }
});

describe("shell toggles are localized and labelled for assistive tech", () => {
  let host: any = null;

  afterEach(() => {
    render(null, host);
    doc.body.removeChild(host);
    localeSignal.value = "en";
    unitSystemSignal.value = "imperial_ft";
  });

  function mount(component: any) {
    host = doc.createElement("div");
    doc.body.appendChild(host);
    render(h(component, {}), host);
    return host.querySelector("button");
  }

  const unitCases = [
    { id: "English imperial shows '5 ft'", locale: "en" as const, units: "imperial_ft" as const, text: "5 ft", name: "5 ft, switch grid units" },
    { id: "English metric shows '1.5 m'", locale: "en" as const, units: "metric_m" as const, text: "1.5 m", name: "1.5 m, switch grid units" },
    { id: "French metric shows '1,5 m' with a French name", locale: "fr" as const, units: "metric_m" as const, text: "1,5 m", name: "1,5 m, changer les unités de grille" },
  ];

  for (const c of unitCases) {
    it(c.id, () => {
      localeSignal.value = c.locale;
      unitSystemSignal.value = c.units;
      const button = mount(UnitsToggle);
      assert.equal(button.textContent, c.text);
      assert.equal(button.getAttribute("aria-label"), c.name);
    });
  }

  const localeCases = [
    { id: "English UI offers 'Français' marked lang=fr", locale: "en" as const, text: "Français", lang: "fr" },
    { id: "French UI offers 'English' marked lang=en", locale: "fr" as const, text: "English", lang: "en" },
  ];

  for (const c of localeCases) {
    it(c.id, () => {
      localeSignal.value = c.locale;
      const button = mount(LocaleToggle);
      assert.equal(button.textContent, c.text);
      assert.equal(button.getAttribute("lang"), c.lang);
    });
  }
});
