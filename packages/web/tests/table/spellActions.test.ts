import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeDnd5eSheetDerived, createDefaultActorData, type Dnd5eDerivedStats } from "../../../game-systems/dnd5e/src/index.ts";
import {
  buildActionRequests,
  repeatDamage,
  resolvableFor,
  type AttackerContext,
  type ResolvableAction,
  type TargetContext,
} from "../../src/table/actionResolution.ts";
import { GOBLIN, HERO } from "../helpers/liveTable.ts";

/** Derived sheet of a `classId` caster of `level` knowing `spellId`, its casting ability at 16. */
function casterKnowing(classId: string, level: number, spellId: string): Dnd5eDerivedStats {
  const actor = createDefaultActorData("caster", "Caster");
  actor.classId = classId;
  actor.attributes.level = level;
  for (const ab of ["int", "wis", "cha"] as const) actor.abilities[ab].score = 16;
  actor.spellIds = [spellId];
  return computeDnd5eSheetDerived(actor);
}

function actionOf(classId: string, level: number, spellId: string, castLevel?: number): ResolvableAction | null {
  return resolvableFor({ kind: "attack", actorId: "caster", attackId: spellId, castLevel }, casterKnowing(classId, level, spellId));
}

const attacker: AttackerContext = { tokenId: HERO, conditions: { conditions: [] }, featureRolls: [] };
const target: TargetContext = { tokenId: GOBLIN, name: "Goblin", conditions: { conditions: [] }, featureRolls: [], distanceFt: 5, cover: "NONE" };

let nextId = 0;
const newId = () => `res-${(nextId += 1)}`;

describe("Spells without an attack roll or a save never become attack rolls", () => {
  const cases: Array<{ id: string; classId: string; level: number; spell: string; resolvable: "none" | "automatic" | "rider" }> = [
    { id: "Magic Missile hits automatically", classId: "wizard", level: 1, spell: "srd:spell:magic_missile", resolvable: "automatic" },
    { id: "Hex is a rider on a weapon hit", classId: "warlock", level: 1, spell: "srd:spell:hex", resolvable: "rider" },
    { id: "Hunter's Mark is a rider on a weapon hit", classId: "ranger", level: 1, spell: "srd:spell:hunters_mark", resolvable: "rider" },
    { id: "Divine Favor is a rider on a weapon hit", classId: "paladin", level: 1, spell: "srd:spell:divine_favor", resolvable: "rider" },
    { id: "Divine Smite is a rider on a weapon hit", classId: "paladin", level: 2, spell: "srd:spell:divine_smite", resolvable: "rider" },
    { id: "Shining Smite is a rider on a weapon hit", classId: "paladin", level: 5, spell: "srd:spell:shining_smite", resolvable: "rider" },
    { id: "Power Word Kill rolls nothing", classId: "wizard", level: 17, spell: "srd:spell:power_word_kill", resolvable: "none" },
    { id: "Spike Growth damages on later movement", classId: "druid", level: 3, spell: "srd:spell:spike_growth", resolvable: "none" },
    { id: "Fire Shield damages attackers later", classId: "wizard", level: 7, spell: "srd:spell:fire_shield", resolvable: "none" },
    { id: "Dimension Door damage is self-damage", classId: "wizard", level: 7, spell: "srd:spell:dimension_door", resolvable: "none" },
    { id: "Meld into Stone damage is self-damage", classId: "cleric", level: 5, spell: "srd:spell:meld_into_stone", resolvable: "none" },
    { id: "Teleport's mishap is self-damage", classId: "wizard", level: 13, spell: "srd:spell:teleport", resolvable: "none" },
    { id: "Wish's stress is self-damage", classId: "wizard", level: 17, spell: "srd:spell:wish", resolvable: "none" },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const action = actionOf(c.classId, c.level, c.spell);
      if (c.resolvable === "none") {
        assert.equal(action, null);
        return;
      }
      assert.ok(action);
      assert.deepEqual([action.attackBonus, action.save, action.rider === true], [null, null, c.resolvable === "rider"]);
      const requests = buildActionRequests(action, attacker, [{ target, count: action.instances?.count ?? 1 }], newId);
      assert.deepEqual(
        requests.map((r) => r.check.kind),
        requests.map(() => "AUTOMATIC")
      );
    });
  }

  const dartCases = [
    { id: "Magic Missile with a level 1 slot has three darts", castLevel: undefined, darts: 3 },
    { id: "Magic Missile with a level 2 slot has four darts", castLevel: 2, darts: 4 },
    { id: "Magic Missile with a level 4 slot has six darts", castLevel: 4, darts: 6 },
  ];
  for (const c of dartCases) {
    it(c.id, () => {
      const action = actionOf("wizard", 7, "srd:spell:magic_missile", c.castLevel);
      assert.deepEqual([action?.instances, action?.damageDice], [{ unit: "dart", count: c.darts }, "1d4 + 1"]);
    });
  }
});

describe("Eldritch Blast beams resolve one attack roll each", () => {
  const cases = [
    { id: "level 1 warlock fires one beam", level: 1, beams: 1 },
    { id: "level 5 warlock fires two beams", level: 5, beams: 2 },
    { id: "level 11 warlock fires three beams", level: 11, beams: 3 },
    { id: "level 17 warlock fires four beams", level: 17, beams: 4 },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const action = actionOf("warlock", c.level, "srd:spell:eldritch_blast");
      assert.ok(action);
      const requests = buildActionRequests(action, attacker, [{ target, count: c.beams }], newId);
      assert.deepEqual(
        requests.map((r) => [r.check.kind, r.damage_dice, r.damage_modifier, r.targets.length]),
        Array.from({ length: c.beams }, () => ["ATTACK", "1d10", 0, 1])
      );
    });
  }
});

describe("Spell damage parts dealt together travel as extra damage", () => {
  const cases = [
    { id: "Flame Strike sends Fire and Radiant", classId: "cleric", level: 9, spell: "srd:spell:flame_strike", castLevel: undefined, primary: ["5d6", "fire"], extra: [["5d6", "radiant"]] },
    { id: "Flame Strike upcast raises both parts", classId: "cleric", level: 11, spell: "srd:spell:flame_strike", castLevel: 6, primary: ["6d6", "fire"], extra: [["6d6", "radiant"]] },
    { id: "Ice Storm sends Bludgeoning and Cold", classId: "druid", level: 7, spell: "srd:spell:ice_storm", castLevel: undefined, primary: ["2d10", "bludgeoning"], extra: [["4d6", "cold"]] },
    { id: "Ice Storm upcast raises only the Bludgeoning part", classId: "druid", level: 9, spell: "srd:spell:ice_storm", castLevel: 5, primary: ["3d10", "bludgeoning"], extra: [["4d6", "cold"]] },
    { id: "Spirit Guardians sends one chosen type, no extra part", classId: "cleric", level: 5, spell: "srd:spell:spirit_guardians", castLevel: undefined, primary: ["3d8", "radiant"], extra: [] },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const action = actionOf(c.classId, c.level, c.spell, c.castLevel);
      assert.ok(action);
      const [request] = buildActionRequests(action, attacker, [{ target, count: 1 }], newId);
      assert.deepEqual(
        [request.damage_dice, request.damage_type, request.extra_damage.map((part) => [part.dice, part.damage_type])],
        [...c.primary, c.extra]
      );
    });
  }

  it("Spirit Guardians offers Radiant or Necrotic", () => {
    assert.deepEqual(actionOf("cleric", 5, "srd:spell:spirit_guardians")?.damageTypeOptions, ["radiant", "necrotic"]);
  });
});

describe("repeatDamage", () => {
  const cases: [string, string, number, string][] = [
    ["one dart keeps its dice and bonus", "1d4 + 1", 1, "1d4 + 1"],
    ["three darts triple dice and bonus", "1d4 + 1", 3, "3d4 + 3"],
    ["several dice terms all scale", "1d6+1d4", 2, "2d6 + 2d4"],
  ];
  for (const [id, expression, times, expected] of cases) {
    it(id, () => assert.equal(repeatDamage(expression, times), expected));
  }
});
