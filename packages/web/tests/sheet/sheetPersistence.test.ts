import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLongRest,
  applyShortRest,
  createDefaultActorData,
  type Dnd5eActorData,
} from "../../../game-systems/dnd5e/src/index.ts";
import { createSheetCommandDispatcher, saveActorSheet } from "../../src/sheet/sheetPersistence.ts";
import { CAMPAIGN, HERO_ACTOR, PLAYER_ID, liveTable } from "../helpers/liveTable.ts";
import { actorDto, flush } from "../helpers/mockTransport.ts";

const ACTOR_URL = `PUT /api/v1/campaigns/${CAMPAIGN}/actors/${HERO_ACTOR}`;

function client() {
  return liveTable(PLAYER_ID, null, { [ACTOR_URL]: { status: 200, body: { actor: actorDto({ id: HERO_ACTOR, version: 2 }) } } });
}

function putData(live: ReturnType<typeof client>): Record<string, any> {
  return (live.transport.calls.find((call) => call.method === "PUT")?.body as Record<string, any>).data;
}

function exhausted(level: number): Dnd5eActorData {
  const actor = createDefaultActorData(HERO_ACTOR, "Brakka");
  actor.attributes.exhaustion = level;
  return { ...actor, derived: { speed: 999 } };
}

function barbarian(activeFeatureIds: string[]): Dnd5eActorData {
  const actor = createDefaultActorData(HERO_ACTOR, "Brakka");
  actor.classId = "barbarian";
  actor.attributes.level = 2;
  actor.activeFeatureIds = activeFeatureIds;
  return actor;
}

describe("saveActorSheet recomputes derived before the PUT", () => {
  const cases = [
    { id: "long rest at exhaustion 2 saves a derived speed of 25 ft", sheet: applyLongRest(exhausted(2)), speed: 25 },
    { id: "short rest at exhaustion 2 keeps a derived speed of 20 ft", sheet: applyShortRest(exhausted(2)), speed: 20 },
    { id: "long rest at exhaustion 1 restores the full 30 ft", sheet: applyLongRest(exhausted(1)), speed: 30 },
  ];
  for (const c of cases) {
    it(`[rest] ${c.id}`, async () => {
      const live = client();
      await saveActorSheet(live.client, CAMPAIGN, HERO_ACTOR, c.sheet);
      assert.equal(putData(live).derived.speed, c.speed);
    });
  }

  it("[partial-sheet] a sheet without abilities is saved as given, without derived", async () => {
    const live = client();
    await saveActorSheet(live.client, CAMPAIGN, HERO_ACTOR, { attributes: { exhaustion: 2 } });
    assert.deepEqual(putData(live), { attributes: { exhaustion: 2 } });
  });
});

describe("feature toggles saved through the sheet dispatcher carry their resistances", () => {
  const cases = [
    { id: "toggling Rage on saves bludgeoning, piercing and slashing", before: [], after: ["barbarian:rage"], resistances: ["bludgeoning", "piercing", "slashing"] },
    { id: "ending Rage clears the feature resistances", before: ["barbarian:rage"], after: [], resistances: [] },
    { id: "Reckless Attack alone grants no resistance", before: [], after: ["barbarian:reckless_attack"], resistances: [] },
  ];
  for (const c of cases) {
    it(`[rage] ${c.id}`, async () => {
      const live = client();
      live.client.state.actors.value = { [HERO_ACTOR]: { id: HERO_ACTOR, version: 1, data: barbarian(c.before) } as any };
      createSheetCommandDispatcher({ client: live.client, campaignId: CAMPAIGN, actorId: HERO_ACTOR })({
        cmd: "UPDATE_ACTOR_SHEET",
        changes: { activeFeatureIds: c.after },
      });
      await flush(4);
      assert.deepEqual(putData(live).derived.featureRules.resistances, c.resistances);
    });
  }
});
