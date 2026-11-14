import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { h } from "preact";
import { SrdLoadingNotice } from "../src/App.tsx";
import { localeSignal } from "../src/i18n/index.ts";
import { loadSrdInBackground, srdStatusSignal, type SrdStatus } from "../src/srdLoading.ts";
import { assertAbsent } from "./helpers/domAssert.ts";
import { mount } from "./helpers/liveTable.ts";
import { setupMockDom } from "./helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  srdStatusSignal.value = "ready";
});

describe("loadSrdInBackground: the packs never block, and their arrival is tracked", () => {
  const cases: Array<{ id: string; timeoutMs: number; fails: boolean; whilePending: SrdStatus; settled: SrdStatus }> = [
    { id: "packs that arrive in time switch loading to ready", timeoutMs: 1000, fails: false, whilePending: "loading", settled: "ready" },
    { id: "a failed load falls back to the core catalog", timeoutMs: 1000, fails: true, whilePending: "loading", settled: "fallback" },
    { id: "a slow load times out to fallback, then packs that arrive still switch to ready", timeoutMs: 1, fails: false, whilePending: "fallback", settled: "ready" },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      let settle: (ok: boolean) => void = () => undefined;
      const install = () => new Promise<void>((resolve, reject) => (settle = (ok) => (ok ? resolve() : reject(new Error("offline")))));
      const done = loadSrdInBackground(install, c.timeoutMs);
      assert.equal(srdStatusSignal.value, "loading");
      await later(10);
      assert.equal(srdStatusSignal.value, c.whilePending);
      settle(!c.fails);
      await done;
      assert.equal(srdStatusSignal.value, c.settled);
    });
  }
});

describe("SrdLoadingNotice: a non-blocking status line", () => {
  const cases: Array<{ id: string; status: SrdStatus; text: string | null; busy?: string }> = [
    { id: "loading says the sheets update later", status: "loading", text: "Loading the full SRD compendium. Sheets update when it arrives.", busy: "true" },
    { id: "fallback says the core catalog is in use", status: "fallback", text: "The full SRD compendium is not loaded yet. Sheets use the core catalog for now.", busy: "false" },
    { id: "ready shows nothing", status: "ready", text: null },
  ];
  for (const c of cases) {
    it(c.id, () => {
      srdStatusSignal.value = c.status;
      const ui = mount(h(SrdLoadingNotice, {}));
      const notice = ui.byTestId("srd-loading");
      if (c.text === null) assertAbsent(notice, "srd-loading");
      else {
        assert.equal(notice.textContent, c.text);
        assert.equal(notice.getAttribute("role"), "status");
        assert.equal(notice.getAttribute("aria-busy"), c.busy);
      }
      ui.unmount();
    });
  }

  it("the notice disappears when the packs arrive", () => {
    srdStatusSignal.value = "loading";
    const ui = mount(h(SrdLoadingNotice, {}));
    srdStatusSignal.value = "ready";
    assertAbsent(ui.byTestId("srd-loading"), "srd-loading");
    ui.unmount();
  });
});
