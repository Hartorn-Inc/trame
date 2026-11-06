import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h, options, render } from "preact";
import {
  CompendiumResolver,
  applyClassChoices,
  createDefaultActorData,
  getClassChoices,
  type Dnd5eActorData,
} from "../../../game-systems/dnd5e/src/index.ts";
import { ApiClient } from "../../src/api/client.ts";
import { createSessionState } from "../../src/api/session.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { ActorSheetPanel } from "../../src/sheet/ActorSheetPanel.tsx";
import { pickCastSlot, type SlotTierView } from "../../src/sheet/widgets/SpellbookAccordionWidget.tsx";
import { assertPresent } from "../helpers/domAssert.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { actorDto, createMockTransport, flush } from "../helpers/mockTransport.ts";

setupMockDom();
localeSignal.value = "en";

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_URL = `/api/v1/campaigns/${CAMPAIGN_ID}/actors/${ACTOR_ID}`;

/** Level-1 character of `classId` built with the first options of every class choice. */
function levelOne(classId: string): { actor: Dnd5eActorData; spells: string[] } {
  const base = createDefaultActorData(ACTOR_ID, "Hero");
  const choices = getClassChoices(classId, { actor: base });
  const selections = Object.fromEntries(choices.map((c) => [c.id, c.options.slice(0, c.count).map((o) => o.id)]));
  const resolver = CompendiumResolver.getDefault();
  return {
    actor: applyClassChoices(base, classId, selections),
    spells: (selections.spells ?? []).filter((id) => !resolver.get(id)?.data.area),
  };
}

async function mountSheet(actor: Dnd5eActorData) {
  options.debounceRendering = (cb: () => void) => cb();
  const transport = createMockTransport({ [`PUT ${ACTOR_URL}`]: { status: 200, body: { actor: actorDto({ version: 2 }) } } });
  const state = createSessionState();
  state.actors.value = { [ACTOR_ID]: { version: 1, data: actor } as any };
  const client = new ApiClient({ transport, state });
  const doc = (globalThis as any).document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  render(h(ActorSheetPanel, { campaignId: CAMPAIGN_ID, client, actorId: ACTOR_ID, context: "hud_drawer" }), container);
  await flush();
  const byTestId = (id: string): any => container.querySelector(`[data-testid="${id}"]`);
  const click = async (id: string) => {
    const el = byTestId(id);
    assertPresent(el, id);
    el.dispatchEvent(new (globalThis as any).Event("click"));
    await flush(4);
  };
  const puts = () => transport.calls.filter((c) => c.method === "PUT").map((c) => c.body as Record<string, any>);
  return {
    state,
    byTestId,
    click,
    puts,
    unmount: () => {
      render(null, container);
      container.remove();
    },
  };
}

describe("pickCastSlot: which slot a leveled cast spends", () => {
  const pact = (current: number, slotLevel = 1): SlotTierView => ({ current, max: 1, slotLevel });
  const cases: Array<{ id: string; level: number; slots: Record<string, SlotTierView>; pact: SlotTierView | null; key: string | null; current?: number }> = [
    { id: "a level-1 slot is spent first", level: 1, slots: { level1: { current: 2, max: 2 } }, pact: pact(1), key: "level1", current: 1 },
    { id: "Pact Magic is spent when no slot of the level is left", level: 1, slots: { level1: { current: 0, max: 2 } }, pact: pact(1), key: "pact", current: 0 },
    { id: "a Pact Magic slot casts lower-level spells", level: 1, slots: {}, pact: pact(1, 2), key: "pact", current: 0 },
    { id: "a Pact Magic slot below the spell level is not usable", level: 2, slots: {}, pact: pact(1, 1), key: null },
    { id: "no slot left means no cast", level: 1, slots: { level1: { current: 0, max: 2 } }, pact: null, key: null },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const slot = pickCastSlot(c.level, c.slots, c.pact);
      assert.equal(slot?.key ?? null, c.key);
      if (c.current !== undefined) assert.equal(slot?.tier.current, c.current);
    });
  }
});

describe("level-1 casters show and spend their slots", () => {
  const cases = [
    {
      id: "Wizard spends one of its two level-1 slots",
      classId: "wizard",
      shown: ["slot-count-1", "2/2", "1/2"],
      path: "level1",
      tier: { current: 1, max: 2 },
      castAfter: "Cast",
    },
    {
      id: "Warlock spends its only Pact Magic slot and cannot cast again",
      classId: "warlock",
      shown: ["pact-magic-label", "Pact Magic (Slot Lvl 1): 1/1", "Pact Magic (Slot Lvl 1): 0/1"],
      path: "pact",
      tier: { current: 0, max: 1, slotLevel: 1 },
      castAfter: "No slot left",
    },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { actor, spells } = levelOne(c.classId);
      assert.ok(spells.length > 0, "the class prepares single-target level-1 spells");
      const sheet = await mountSheet(actor);
      await sheet.click("tab-btn-tab-spells");
      assert.equal(sheet.byTestId(c.shown[0])?.textContent, c.shown[1]);

      await sheet.click(`btn-cast-spell-${spells[0]}`);
      const [body] = sheet.puts();
      assert.equal(body.expected_version, 1);
      assert.deepEqual(body.data.spellSlots[c.path], c.tier);

      sheet.state.actors.value = { [ACTOR_ID]: { version: 2, data: body.data } as any };
      await flush(4);
      assert.equal(sheet.byTestId(c.shown[0])?.textContent, c.shown[2]);
      const cast = sheet.byTestId(`btn-cast-spell-${spells[0]}`);
      assert.equal(cast?.textContent, c.castAfter);
      assert.equal(cast?.disabled, c.castAfter !== "Cast");
      sheet.unmount();
    });
  }
});

describe("class feature controls write the actor's pools and toggles", () => {
  it("a level-1 Barbarian sees Rage as a counter with a toggle", async () => {
    const sheet = await mountSheet(levelOne("barbarian").actor);
    await sheet.click("tab-btn-tab-features");
    assert.equal(sheet.byTestId("feature-badge-barbarian:rage")?.textContent, "Counter");
    assert.equal(sheet.byTestId("feature-pool-barbarian:rage")?.textContent, "2 / 2 uses");
    assert.equal(sheet.byTestId("btn-feature-toggle-barbarian:rage")?.textContent, "Inactive");
    assert.equal(sheet.byTestId("btn-feature-toggle-barbarian:rage")?.getAttribute("aria-pressed"), "false");
    sheet.unmount();
  });

  const cases = [
    { id: "turning Rage on spends one use in the same save", button: "btn-feature-toggle-barbarian:rage", active: ["barbarian:rage"], current: 1 },
    { id: "Use spends one Rage without turning it on", button: "btn-feature-spend-barbarian:rage", active: undefined, current: 1 },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const sheet = await mountSheet(levelOne("barbarian").actor);
      await sheet.click("tab-btn-tab-features");
      await sheet.click(c.button);
      const puts = sheet.puts();
      assert.equal(puts.length, 1);
      assert.deepEqual(puts[0].data.activeFeatureIds, c.active);
      assert.equal(puts[0].data.resources.barbarian_rage.current, c.current);
      assert.equal(puts[0].data.resources.barbarian_rage.max, 2);
      sheet.unmount();
    });
  }
});
