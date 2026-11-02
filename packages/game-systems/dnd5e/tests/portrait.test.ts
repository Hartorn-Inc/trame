import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  applyBackground,
  applyExhaustion,
  applyLevelUp,
  applyLongRest,
  applyShortRest,
  createDefaultActorData,
  resolveDamagePipeline,
  type Dnd5eActorData,
} from "../src/index.ts";

const ASSET_KEY = "campaigns/c-1/assets/3f1a9c0e5b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f.webp";

const PORTRAIT_CASES: Array<[id: string, portraitAssetKey: string | undefined]> = [
  ["present-asset-key-is-kept-verbatim", ASSET_KEY],
  ["absent-key-stays-absent", undefined],
  ["empty-string-is-kept-and-means-no-portrait", ""],
];

const TRANSFORMS: Array<[id: string, run: (actor: Dnd5eActorData) => Dnd5eActorData]> = [
  ["applyLevelUp", (actor) => applyLevelUp(actor, { targetLevel: 2 })],
  ["applyBackground", (actor) => applyBackground(actor, "sage", { mode: "plus1_each" })],
  ["applyShortRest", (actor) => applyShortRest(actor, { hitDieSpend: { count: 0, rollResults: [] } })],
  ["applyLongRest", (actor) => applyLongRest(actor)],
  ["applyExhaustion", (actor) => applyExhaustion(actor, 1)],
  ["resolveDamagePipeline", (actor) => resolveDamagePipeline(actor, [{ type: "fire", amount: 3 }]).actor],
];

function actorWithPortrait(portraitAssetKey: string | undefined): Dnd5eActorData {
  const actor = createDefaultActorData("hero-portrait", "Portrait Hero");
  if (portraitAssetKey !== undefined) {
    actor.portraitAssetKey = portraitAssetKey;
  }
  return actor;
}

describe("Dnd5eActorData.portraitAssetKey survives every pack transform", () => {
  for (const [caseId, portraitAssetKey] of PORTRAIT_CASES) {
    for (const [transformId, run] of TRANSFORMS) {
      it(`${transformId}: ${caseId}`, () => {
        const result = run(actorWithPortrait(portraitAssetKey));
        assert.equal(result.portraitAssetKey, portraitAssetKey);
        assert.equal("portraitAssetKey" in result, portraitAssetKey !== undefined);
      });
    }
  }
});
