import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EN } from "../src/i18n/en.ts";
import { FR } from "../src/i18n/fr.ts";
import { localeSignal, t, tn, type LocaleCode } from "../src/i18n/index.ts";

const placeholders = (text: string): string[] => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe("i18n dictionary parity (G3, A39, A40)", () => {
  const dictionaries: Array<{ id: string; dict: Record<string, string> }> = [{ id: "fr", dict: FR }];

  for (const { id, dict } of dictionaries) {
    it(`[${id}-has-every-english-key] ${id} translates every canonical English key and nothing else`, () => {
      assert.deepEqual(Object.keys(dict).sort(), Object.keys(EN).sort());
    });

    it(`[${id}-placeholder-parity] ${id} entries use the same {{placeholders}} as English`, () => {
      const mismatched = Object.entries(EN)
        .filter(([key, text]) => placeholders(text).join() !== placeholders(dict[key] ?? "").join())
        .map(([key]) => key);
      assert.deepEqual(mismatched, []);
    });

    it(`[${id}-no-empty-values] ${id} has no empty translations`, () => {
      assert.deepEqual(Object.keys(dict).filter((key) => dict[key].trim() === ""), []);
    });
  }

  it("[plural-pairs-complete] every '.one' key has a matching '.other' key", () => {
    const keys = new Set(Object.keys(EN));
    const missing = [...keys].filter((k) => k.endsWith(".one") && !keys.has(k.replace(/\.one$/, ".other")));
    assert.deepEqual(missing, []);
  });

  const pluralCases: Array<{ id: string; locale: LocaleCode; count: number; expected: string }> = [
    { id: "en-one", locale: "en", count: 1, expected: "1 square" },
    { id: "en-zero-is-other", locale: "en", count: 0, expected: "0 squares" },
    { id: "en-many", locale: "en", count: 3, expected: "3 squares" },
    { id: "fr-one", locale: "fr", count: 1, expected: "1 case" },
    { id: "fr-zero-is-one", locale: "fr", count: 0, expected: "0 case" },
    { id: "fr-many", locale: "fr", count: 3, expected: "3 cases" },
  ];

  for (const tc of pluralCases) {
    it(`[${tc.id}] tn('distance.squares', ${tc.count}) in ${tc.locale} -> '${tc.expected}'`, () => {
      localeSignal.value = tc.locale;
      assert.equal(tn("distance.squares", tc.count), tc.expected);
      localeSignal.value = "en";
    });
  }

  it("[interpolation] t() substitutes every {{placeholder}} occurrence", () => {
    localeSignal.value = "en";
    assert.equal(t("rest.refill", { current: 1, max: 4 }), "1 / 4 → 4 / 4");
  });
});

describe("no hard-coded user-facing attribute text in components", () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const components = fs
    .readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => ({ file, source: fs.readFileSync(path.join(srcRoot, file), "utf8") }));
  const attributes = ["aria-label", "aria-description", "title", "placeholder", "alt"];
  for (const attribute of attributes) {
    it(`[${attribute}-goes-through-t] no ${attribute} is a literal or template string with words`, () => {
      const literal = new RegExp(`\\s${attribute}=(?:"[^"$]*[A-Za-z]{2}[^"$]*"|\\{\\s*['"\`][^'"\`$]*[A-Za-z]{2})`);
      assert.deepEqual(components.filter((c) => literal.test(c.source)).map((c) => c.file), []);
    });
  }
});

describe("platform-neutral copy instructions", () => {
  const cases: Array<{ id: string; dict: Record<string, string> }> = [
    { id: "en-copy-manual-names-no-shortcut", dict: EN },
    { id: "fr-copy-manual-names-no-shortcut", dict: FR },
  ];
  for (const c of cases) {
    it(`[${c.id}] invites.copyManual names no platform keyboard shortcut`, () => {
      assert.doesNotMatch(c.dict["invites.copyManual"], /ctrl|cmd|⌘|command\+/i);
    });
  }
});
