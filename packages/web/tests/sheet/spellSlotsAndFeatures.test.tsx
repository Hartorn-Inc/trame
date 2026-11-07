import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h, options, render } from "preact";
import {
  CompendiumResolver,
  applyClassChoices,
  createDefaultActorData,
  getClassChoices,
  type Dnd5eActorData,
  type Dnd5eDerivedStats,
} from "../../../game-systems/dnd5e/src/index.ts";
import { ApiClient } from "../../src/api/client.ts";
import { createSessionState } from "../../src/api/session.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { ActorSheetPanel } from "../../src/sheet/ActorSheetPanel.tsx";
import { castSlotOptions, pickCastSlot, type SlotTierView } from "../../src/sheet/widgets/SpellbookAccordionWidget.tsx";
import { resolvableFor } from "../../src/table/actionResolution.ts";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
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
  const cases: Array<{
    id: string;
    level: number;
    slots: Record<string, SlotTierView>;
    pact: SlotTierView | null;
    preferred?: string;
    key: string | null;
    current?: number;
    castLevel?: number;
  }> = [
    { id: "a level-1 slot is spent first", level: 1, slots: { level1: { current: 2, max: 2 } }, pact: pact(1), key: "level1", current: 1, castLevel: 1 },
    { id: "Pact Magic is spent when no slot of the level is left", level: 1, slots: { level1: { current: 0, max: 2 } }, pact: pact(1), key: "pact", current: 0, castLevel: 1 },
    { id: "a Pact Magic slot casts lower-level spells at its own level", level: 1, slots: {}, pact: pact(1, 2), key: "pact", current: 0, castLevel: 2 },
    { id: "a Pact Magic slot below the spell level is not usable", level: 2, slots: {}, pact: pact(1, 1), key: null },
    { id: "no slot left means no cast", level: 1, slots: { level1: { current: 0, max: 2 } }, pact: null, key: null },
    {
      id: "a spent base level falls back to the next available level",
      level: 1,
      slots: { level1: { current: 0, max: 4 }, level2: { current: 0, max: 3 }, level3: { current: 2, max: 2 } },
      pact: null,
      key: "level3",
      current: 1,
      castLevel: 3,
    },
    {
      id: "the slot picked in the selector is spent (upcast)",
      level: 1,
      slots: { level1: { current: 4, max: 4 }, level2: { current: 3, max: 3 } },
      pact: null,
      preferred: "level2",
      key: "level2",
      current: 2,
      castLevel: 2,
    },
    {
      id: "a picked slot with no use left falls back to the lowest available",
      level: 1,
      slots: { level1: { current: 4, max: 4 }, level2: { current: 0, max: 3 } },
      pact: null,
      preferred: "level2",
      key: "level1",
      current: 3,
      castLevel: 1,
    },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const slot = pickCastSlot(c.level, c.slots, c.pact, c.preferred);
      assert.equal(slot?.key ?? null, c.key);
      if (c.current !== undefined) assert.equal(slot?.tier.current, c.current);
      if (c.castLevel !== undefined) assert.equal(slot?.castLevel, c.castLevel);
    });
  }
});

describe("castSlotOptions: slots offered by the slot level selector", () => {
  const cases: Array<{ id: string; level: number; slots: Record<string, SlotTierView>; pact: SlotTierView | null; expected: string[] }> = [
    { id: "lower-level slots are never offered", level: 2, slots: { level1: { current: 2, max: 2 }, level2: { current: 1, max: 1 }, level3: { current: 1, max: 1 } }, pact: null, expected: ["level2:2", "level3:3"] },
    { id: "spent tiers are skipped", level: 1, slots: { level1: { current: 0, max: 2 }, level2: { current: 1, max: 1 } }, pact: null, expected: ["level2:2"] },
    { id: "Pact Magic sorts by its slot level after an equal regular slot", level: 1, slots: { level2: { current: 1, max: 1 }, level3: { current: 1, max: 1 } }, pact: { current: 1, max: 2, slotLevel: 2 }, expected: ["level2:2", "pact:2", "level3:3"] },
  ];
  for (const c of cases) {
    it(c.id, () => {
      assert.deepEqual(castSlotOptions(c.level, c.slots, c.pact).map((o) => `${o.key}:${o.castLevel}`), c.expected);
    });
  }
});

describe("resolvableFor scales an upcast spell's damage dice", () => {
  const derived = { attacks: [], spellSaveDc: 13 } as unknown as Dnd5eDerivedStats;
  const cases = [
    { id: "burning hands without a cast level rolls its base dice", castLevel: undefined, expected: "3d6" },
    { id: "burning hands at its own level rolls its base dice", castLevel: 1, expected: "3d6" },
    { id: "burning hands with a level 3 slot rolls 5d6", castLevel: 3, expected: "5d6" },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const action = resolvableFor({ kind: "area", actorId: ACTOR_ID, spellId: "srd:spell:burning_hands", castLevel: c.castLevel }, derived);
      assert.equal(action?.damageDice, c.expected);
    });
  }
});

describe("the spellbook offers higher-level slots and explains a missing one", () => {
  /** Level-3 Wizard with only Magic Missile prepared and the given level-1 / level-2 slots left. */
  function wizard(level1: number, level2: number): Dnd5eActorData {
    const { actor } = levelOne("wizard");
    return {
      ...actor,
      attributes: { ...actor.attributes, level: 3 },
      spellIds: ["srd:spell:magic_missile"],
      spellSlots: { level1: { current: level1, max: 4 }, level2: { current: level2, max: 2 } },
    } as Dnd5eActorData;
  }

  it("picking a level-2 slot spends it on cast", async () => {
    const sheet = await mountSheet(wizard(4, 2));
    await sheet.click("tab-btn-tab-spells");
    const picker = sheet.byTestId("spell-slot-srd:spell:magic_missile");
    assertPresent(picker, "slot level selector");
    picker.value = "level2";
    picker.dispatchEvent(new (globalThis as any).Event("change"));
    await flush(4);
    assert.equal(sheet.byTestId("btn-cast-spell-srd:spell:magic_missile")?.getAttribute("aria-label"), "Cast Magic Missile with a level 2 slot");
    await sheet.click("btn-cast-spell-srd:spell:magic_missile");
    const [body] = sheet.puts();
    assert.deepEqual(body.data.spellSlots.level2, { current: 1, max: 2 });
    sheet.unmount();
  });

  it("no slot left disables the cast and says why", async () => {
    const sheet = await mountSheet(wizard(0, 0));
    await sheet.click("tab-btn-tab-spells");
    assertAbsent(sheet.byTestId("spell-slot-srd:spell:magic_missile"), "slot level selector");
    const cast = sheet.byTestId("btn-cast-spell-srd:spell:magic_missile");
    assert.equal(cast?.disabled, true);
    assert.equal(cast?.getAttribute("aria-label"), "Cannot cast Magic Missile: no spell slot of level 1 or higher is left");
    sheet.unmount();
  });
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
