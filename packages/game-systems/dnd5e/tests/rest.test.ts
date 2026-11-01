import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLongRest,
  applyShortRest,
  calculateHitDieRecovery,
  calculateShortRestHpGain,
  createDefaultActorData,
  type Dnd5eActorData,
  type Dnd5eActorSheet,
} from "../src/index.ts";

describe("[Ticket #83] D&D 5e ShortRest and LongRest Recovery Mechanics in rest.ts", () => {
  describe("AC1: ShortRest Hit Dice Validation", () => {
    it("WHEN applyShortRest is invoked with hitDieSpend.count greater than actor.attributes.hitDiceCurrent, applyShortRest throws an Error with message 'Insufficient hit dice'.", () => {
      const actor = createDefaultActorData("hero-hd-1", "Valeros");
      actor.attributes.hitDiceCurrent = 2;
      actor.attributes.hitDiceMax = 3;

      assert.throws(
        () =>
          applyShortRest(actor, {
            hitDieSpend: { count: 3, rollResults: [4, 5, 6] },
          }),
        (err: Error) => {
          assert.equal(err.message, "Insufficient hit dice");
          return true;
        }
      );
    });

    it("WHEN applyShortRest is invoked with negative hit dice spend, applyShortRest throws an Error with message 'Insufficient hit dice'.", () => {
      const actor = createDefaultActorData("hero-hd-neg", "Rogue");
      actor.attributes.hitDiceCurrent = 2;

      assert.throws(
        () =>
          applyShortRest(actor, {
            hitDieSpend: { count: -1, rollResults: [] },
          }),
        (err: Error) => {
          assert.equal(err.message, "Insufficient hit dice");
          return true;
        }
      );
    });

    it("WHEN applyShortRest is invoked with mismatched rollResults count, applyShortRest throws an Error with message 'Dice rolls count must match hit dice spent'.", () => {
      const actor = createDefaultActorData("hero-hd-mismatch", "Cleric");
      actor.attributes.hitDiceCurrent = 3;

      assert.throws(
        () =>
          applyShortRest(actor, {
            hitDieSpend: { count: 2, rollResults: [5] },
          }),
        (err: Error) => {
          assert.equal(err.message, "Dice rolls count must match hit dice spent");
          return true;
        }
      );
    });
  });

  describe("AC2: ShortRest Hit Dice HP Recovery & CON Modifier Floor", () => {
    it("WHEN applyShortRest is invoked with valid hitDieSpend, applyShortRest restores sum(max(1, roll + conMod)) HP to actor up to hp.max and decrements hitDiceCurrent by hitDieSpend.count.", () => {
      const actor = createDefaultActorData("hero-hd-heal", "Fighter");
      actor.attributes.hp.current = 10;
      actor.attributes.hp.max = 30;
      actor.abilities.con.score = 14; // conMod = +2
      actor.attributes.hitDiceCurrent = 3;
      actor.attributes.hitDiceMax = 3;

      // Rolls: 6 (+2) = 8, 4 (+2) = 6 -> Total gain = 14 HP. hp.current becomes 24, hitDiceCurrent becomes 1.
      const updated = applyShortRest(actor, {
        hitDieSpend: { count: 2, rollResults: [6, 4] },
      });

      assert.equal(updated.attributes.hp.current, 24);
      assert.equal(updated.attributes.hitDiceCurrent, 1);
      // Pure function invariant: original actor remains unmodified
      assert.equal(actor.attributes.hp.current, 10);
      assert.equal(actor.attributes.hitDiceCurrent, 3);
    });

    it("WHEN constitution modifier is negative, each spent hit die enforces a strict floor of 1 HP gained.", () => {
      const actor = createDefaultActorData("hero-hd-floor", "Feeble Wizard");
      actor.attributes.hp.current = 5;
      actor.attributes.hp.max = 20;
      actor.abilities.con.score = 6; // conMod = -2
      actor.attributes.hitDiceCurrent = 2;

      // Rolls: 2 (-2) = 0 -> floor 1; 1 (-2) = -1 -> floor 1 -> Total gain = 2 HP.
      const updated = applyShortRest(actor, {
        hitDieSpend: { count: 2, rollResults: [2, 1] },
      });

      assert.equal(updated.attributes.hp.current, 7);
      assert.equal(updated.attributes.hitDiceCurrent, 0);
    });

    it("WHEN HP recovery exceeds hp.max, actor.attributes.hp.current is clamped to hp.max.", () => {
      const actor = createDefaultActorData("hero-hd-cap", "Paladin");
      actor.attributes.hp.current = 28;
      actor.attributes.hp.max = 30;
      actor.abilities.con.score = 10; // conMod = 0
      actor.attributes.hitDiceCurrent = 2;

      const updated = applyShortRest(actor, {
        hitDieSpend: { count: 1, rollResults: [8] },
      });

      assert.equal(updated.attributes.hp.current, 30);
      assert.equal(updated.attributes.hitDiceCurrent, 1);
    });

    it("WHEN hitDieSpend.count is 0 or options omitted, HP and hit dice remain unchanged.", () => {
      const actor = createDefaultActorData("hero-hd-zero", "Monk");
      actor.attributes.hp.current = 12;
      actor.attributes.hp.max = 20;
      actor.attributes.hitDiceCurrent = 2;

      const updated1 = applyShortRest(actor);
      assert.equal(updated1.attributes.hp.current, 12);
      assert.equal(updated1.attributes.hitDiceCurrent, 2);

      const updated2 = applyShortRest(actor, {
        hitDieSpend: { count: 0, rollResults: [] },
      });
      assert.equal(updated2.attributes.hp.current, 12);
      assert.equal(updated2.attributes.hitDiceCurrent, 2);
    });

    it("supports backward-compatible ShortRestOptions with hitDiceSpent and diceRolls.", () => {
      const actor = createDefaultActorData("hero-hd-legacy", "Ranger");
      actor.attributes.hp.current = 10;
      actor.attributes.hp.max = 25;
      actor.abilities.con.score = 12; // conMod = +1
      actor.attributes.hitDiceCurrent = 2;

      const updated = applyShortRest(actor, {
        hitDiceSpent: 1,
        diceRolls: [5],
      });

      assert.equal(updated.attributes.hp.current, 16);
      assert.equal(updated.attributes.hitDiceCurrent, 1);
    });
  });

  describe("AC3: ShortRest Resource Pools & Warlock Pact Magic", () => {
    it("WHEN applyShortRest is invoked, applyShortRest resets all ResourcePool instances with resetOn 'SHORT_REST' and resets Warlock Pact Magic slots to their maximum capacity.", () => {
      const actor = createDefaultActorData("hero-warlock-sr", "Warlock");
      actor.resources = {
        action_surge: { current: 0, max: 1, resetOn: "SHORT_REST" },
        second_wind: { current: 0, max: 1, resetOn: "SHORT_REST" },
        indomitable: { current: 0, max: 1, resetOn: "LONG_REST" },
      };
      actor.spellSlots = {
        level1: { current: 1, max: 4 },
        pact: { current: 0, max: 2, slotLevel: 3 },
      };

      const updated = applyShortRest(actor);

      assert.equal(updated.resources?.action_surge.current, 1);
      assert.equal(updated.resources?.second_wind.current, 1);
      assert.equal(updated.resources?.indomitable.current, 0); // Unchanged
      assert.equal(updated.spellSlots?.pact?.current, 2); // Pact magic reset to max
      assert.equal(updated.spellSlots?.level1?.current, 1); // Standard spell slots unchanged
    });
  });

  describe("AC4: LongRest HP & TempHP Restoration", () => {
    it("WHEN applyLongRest is invoked, applyLongRest resets actor.attributes.hp.current to actor.attributes.hp.max and resets actor.attributes.hp.temp to 0.", () => {
      const actor = createDefaultActorData("hero-lr-hp", "Barbarian");
      actor.attributes.hp.current = 4;
      actor.attributes.hp.max = 48;
      actor.attributes.hp.temp = 12;

      const updated = applyLongRest(actor);

      assert.equal(updated.attributes.hp.current, 48);
      assert.equal(updated.attributes.hp.temp, 0);
      // Invariant: original actor remains unmodified
      assert.equal(actor.attributes.hp.current, 4);
      assert.equal(actor.attributes.hp.temp, 12);
    });
  });

  describe("AC5: LongRest Half-Max Hit Dice Recovery", () => {
    it("WHEN applyLongRest is invoked, applyLongRest increments actor.attributes.hitDiceCurrent by Math.max(1, Math.floor(actor.attributes.hitDiceMax / 2)) without exceeding hitDiceMax.", () => {
      // Even hitDiceMax: 6 -> recovers floor(6 / 2) = 3
      const actorEven = createDefaultActorData("hero-lr-hd-even", "Fighter");
      actorEven.attributes.hitDiceMax = 6;
      actorEven.attributes.hitDiceCurrent = 1;

      const updatedEven = applyLongRest(actorEven);
      assert.equal(updatedEven.attributes.hitDiceCurrent, 4); // 1 + 3 = 4

      // Odd hitDiceMax: 7 -> recovers floor(7 / 2) = 3
      const actorOdd = createDefaultActorData("hero-lr-hd-odd", "Druid");
      actorOdd.attributes.hitDiceMax = 7;
      actorOdd.attributes.hitDiceCurrent = 2;

      const updatedOdd = applyLongRest(actorOdd);
      assert.equal(updatedOdd.attributes.hitDiceCurrent, 5); // 2 + 3 = 5

      // Level 1 minimum recovery: 1 -> recovers max(1, floor(1 / 2)) = 1
      const actorLvl1 = createDefaultActorData("hero-lr-hd-lvl1", "Sorcerer");
      actorLvl1.attributes.hitDiceMax = 1;
      actorLvl1.attributes.hitDiceCurrent = 0;

      const updatedLvl1 = applyLongRest(actorLvl1);
      assert.equal(updatedLvl1.attributes.hitDiceCurrent, 1); // 0 + 1 = 1

      // Cap at hitDiceMax
      const actorCap = createDefaultActorData("hero-lr-hd-cap", "Monk");
      actorCap.attributes.hitDiceMax = 6;
      actorCap.attributes.hitDiceCurrent = 5;

      const updatedCap = applyLongRest(actorCap);
      assert.equal(updatedCap.attributes.hitDiceCurrent, 6); // 5 + 3 = 8 capped at 6
    });
  });

  describe("AC6: LongRest Spell Slot Restoration", () => {
    it("WHEN applyLongRest is invoked, applyLongRest restores all spell slots across tiers 1-9 and pact magic to maximum capacity.", () => {
      const actor = createDefaultActorData("hero-lr-spells", "Wizard");
      actor.spellSlots = {
        level1: { current: 0, max: 4 },
        level2: { current: 1, max: 3 },
        level3: { current: 0, max: 3 },
        level4: { current: 0, max: 3 },
        level5: { current: 0, max: 2 },
        level6: { current: 0, max: 1 },
        level7: { current: 0, max: 1 },
        level8: { current: 0, max: 1 },
        level9: { current: 0, max: 1 },
        pact: { current: 0, max: 2, slotLevel: 5 },
      };

      const updated = applyLongRest(actor);

      assert.equal(updated.spellSlots?.level1?.current, 4);
      assert.equal(updated.spellSlots?.level2?.current, 3);
      assert.equal(updated.spellSlots?.level3?.current, 3);
      assert.equal(updated.spellSlots?.level4?.current, 3);
      assert.equal(updated.spellSlots?.level5?.current, 2);
      assert.equal(updated.spellSlots?.level6?.current, 1);
      assert.equal(updated.spellSlots?.level7?.current, 1);
      assert.equal(updated.spellSlots?.level8?.current, 1);
      assert.equal(updated.spellSlots?.level9?.current, 1);
      assert.equal(updated.spellSlots?.pact?.current, 2);
    });
  });

  describe("AC7: LongRest Resource Pool Replenishment", () => {
    it("WHEN applyLongRest is invoked, applyLongRest resets all ResourcePool instances with resetOn 'SHORT_REST' or 'LONG_REST' to their maximum capacity.", () => {
      const actor = createDefaultActorData("hero-lr-res", "Paladin");
      actor.resources = {
        channel_divinity: { current: 0, max: 1, resetOn: "SHORT_REST" },
        action_surge: { current: 0, max: 1, resetOn: "SHORT_REST" },
        lay_on_hands: { current: 5, max: 40, resetOn: "LONG_REST" },
        cleansing_touch: { current: 0, max: 3, resetOn: "LONG_REST" },
      };

      const updated = applyLongRest(actor);

      assert.equal(updated.resources?.channel_divinity.current, 1);
      assert.equal(updated.resources?.action_surge.current, 1);
      assert.equal(updated.resources?.lay_on_hands.current, 40);
      assert.equal(updated.resources?.cleansing_touch.current, 3);
    });
  });

  describe("AC8: LongRest Exhaustion Decrement", () => {
    it("WHEN applyLongRest is invoked and actor.attributes.exhaustion is greater than 0, applyLongRest decrements actor.attributes.exhaustion by exactly 1.", () => {
      const actorExh2 = createDefaultActorData("hero-exh-2", "Exhausted Scout");
      actorExh2.attributes.exhaustion = 2;

      const updatedExh2 = applyLongRest(actorExh2);
      assert.equal(updatedExh2.attributes.exhaustion, 1);

      const actorExh1 = createDefaultActorData("hero-exh-1", "Tired Scout");
      actorExh1.attributes.exhaustion = 1;

      const updatedExh1 = applyLongRest(actorExh1);
      assert.equal(updatedExh1.attributes.exhaustion, 0);

      const actorExh0 = createDefaultActorData("hero-exh-0", "Rested Scout");
      actorExh0.attributes.exhaustion = 0;

      const updatedExh0 = applyLongRest(actorExh0);
      assert.equal(updatedExh0.attributes.exhaustion, 0); // Does not go negative
    });
  });

  describe("Invariants & Helper Calculations", () => {
    it("clears death saves and concentration upon completing a Long Rest", () => {
      const actor = createDefaultActorData("hero-death-saves", "Stabilized Hero");
      actor.attributes.deathSaves = { successes: 2, failures: 1 };
      actor.concentratingOnSpellId = "srd:spell:bless";

      const updated = applyLongRest(actor);
      assert.equal(updated.attributes.deathSaves.successes, 0);
      assert.equal(updated.attributes.deathSaves.failures, 0);
      assert.equal(updated.concentratingOnSpellId, undefined);
    });

    it("computes correct Hit Die recovery via calculateHitDieRecovery", () => {
      assert.equal(calculateHitDieRecovery(1), 1);
      assert.equal(calculateHitDieRecovery(2), 1);
      assert.equal(calculateHitDieRecovery(3), 1);
      assert.equal(calculateHitDieRecovery(4), 2);
      assert.equal(calculateHitDieRecovery(5), 2);
      assert.equal(calculateHitDieRecovery(20), 10);
    });

    it("computes correct single-die HP gain via calculateShortRestHpGain", () => {
      assert.equal(calculateShortRestHpGain(8, 14), 10); // 8 + 2
      assert.equal(calculateShortRestHpGain(1, 6), 1);   // 1 + (-2) = -1 clamped to 1
      assert.equal(calculateShortRestHpGain(4, 10), 4);  // 4 + 0
    });

    it("supports Dnd5eActorSheet overloads for short and long rest", () => {
      const sheet: Dnd5eActorSheet = {
        id: "sheet-1",
        name: "Sheet Hero",
        level: 5,
        spellcastingAbility: "int",
        abilities: { str: 10, dex: 12, con: 14, int: 16, wis: 10, cha: 8 },
        saveProficiencies: {},
        skillProficiencies: {},
        armorKind: "unarmored",
        armorBaseAc: 10,
        hasShield: false,
        hpCurrent: 10,
        hpMax: 30,
        tempHp: 5,
        hitDiceCurrent: 3,
        hitDiceMax: 5,
        hitDieSides: 8,
        exhaustionLevel: 1,
        conditions: [],
        resources: {
          second_wind: { id: "sw", label: "Second Wind", current: 0, max: 1, recovery: "short_rest" },
          action_surge: { id: "as", label: "Action Surge", current: 0, max: 1, recovery: "long_rest" },
        },
        deathSaves: { successes: 1, failures: 0, isStable: true, isDead: false },
      };

      const srResult = applyShortRest(sheet, [6]);
      assert.equal(srResult.hpRecovered, 8); // 6 + 2 = 8
      assert.equal(srResult.hitDiceSpent, 1);
      assert.equal(sheet.hpCurrent, 18);
      assert.equal(sheet.hitDiceCurrent, 2);
      assert.equal(sheet.resources.second_wind.current, 1);

      const lrResult = applyLongRest(sheet);
      assert.equal(lrResult.hpRecovered, 12); // 30 - 18 = 12
      assert.equal(sheet.hpCurrent, 30);
      assert.equal(sheet.tempHp, 0);
      assert.equal(sheet.exhaustionLevel, 0);
      assert.equal(sheet.resources.action_surge.current, 1);
    });
  });
});
