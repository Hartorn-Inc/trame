import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CompendiumResolver, SYSTEM_SRD, computeDnd5eSheetDerived, createDefaultActorData } from "../../game-systems/dnd5e/src/index.ts";

describe("Full SRD is installed before any test derives a sheet (engine-setup preload)", () => {
  const cases: [string, string][] = [
    ["pack_only_monster_resolves", "srd:monster:aboleth"],
    ["pack_only_spell_resolves", "srd:spell:conjure_celestial"],
  ];
  for (const [id, entryId] of cases) {
    it(id, () => {
      assert.equal(SYSTEM_SRD.some((entry) => entry.id === entryId), false, `${entryId} must be pack-only for this test`);
      assert.equal(CompendiumResolver.getDefault().get(entryId)?.id, entryId);
    });
  }

  it("sheet_derivation_lists_a_pack_only_spell_with_its_level", () => {
    const actor = createDefaultActorData("wiz", "Wizard");
    actor.classId = "wizard";
    actor.spellIds = ["srd:spell:conjure_celestial"];
    const ref = computeDnd5eSheetDerived(actor).spells?.prepared.find((spell) => spell.id === "srd:spell:conjure_celestial");
    assert.deepEqual([ref?.name, ref?.level], ["Conjure Celestial", 7]);
  });
});
