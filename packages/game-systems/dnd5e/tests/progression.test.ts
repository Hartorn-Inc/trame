import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLevelUp,
  calculateProficiencyBonus,
  createDefaultActorData,
  FULL_CASTER_SPELL_SLOTS,
  getCasterTypeForClass,
  getSubclassUnlockLevel,
  HALF_CASTER_SPELL_SLOTS,
  isAsiLevel,
  PACT_MAGIC_SPELL_SLOTS,
  reconcileSlots,
  type Dnd5eActorData,
  type LevelUpOptions,
} from "../src/index.ts";

describe("[Ticket #82] D&D 5e applyLevelUp & Progression System Specification", () => {
  describe("AC1 & AC2: Level Increment Boundaries & Max Level Cap", () => {
    it("WHEN options.targetLevel does not equal actor.attributes.level + 1, applyLevelUp throws an Error with message 'Invalid level increment'.", () => {
      const actor = createDefaultActorData("hero-1", "Valeros");
      actor.attributes.level = 1;

      // Skipping a level (1 -> 3)
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 3, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Invalid level increment"
      );

      // Decrementing level (1 -> 0)
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 0, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Invalid level increment"
      );

      // Same level (1 -> 1)
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 1, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Invalid level increment"
      );
    });

    it("WHEN options.targetLevel exceeds 20, applyLevelUp throws an Error with message 'Max level is 20'.", () => {
      const actor = createDefaultActorData("hero-cap", "Ancient One");
      actor.attributes.level = 20;

      // Advancing past level 20 with explicit targetLevel
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 21, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Max level is 20"
      );

      // Advancing past level 20 with targetLevel exceeding 20 on lower level character
      const actorLow = createDefaultActorData("hero-low", "Novice");
      actorLow.attributes.level = 1;
      assert.throws(
        () => applyLevelUp(actorLow, { targetLevel: 22, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Max level is 20"
      );

      // Advancing level 20 without targetLevel
      assert.throws(
        () => applyLevelUp(actor, { hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Max level is 20"
      );
    });
  });

  describe("AC3, AC4, & AC5: Hit Points Modes (Fixed vs Rolled)", () => {
    it("WHEN options.hitPointsMode equals 'fixed', applyLevelUp increases actor max and current hit points by Math.max(1, Math.floor(actor.attributes.hitDieSize / 2) + 1 + conModifier).", () => {
      const actor = createDefaultActorData("fighter-hp", "Fighter");
      actor.attributes.level = 1;
      actor.attributes.hitDieSize = 10; // d10 -> floor(10 / 2) + 1 = 6
      actor.abilities.con.score = 14; // conModifier = +2
      actor.attributes.hp.max = 12;
      actor.attributes.hp.current = 10;

      const result = applyLevelUp(actor, {
        targetLevel: 2,
        hitPointsMode: "fixed",
      });

      // Expected gain: Math.max(1, floor(10 / 2) + 1 + 2) = 6 + 2 = 8
      assert.equal(result.attributes.hp.max, 12 + 8);
      assert.equal(result.attributes.hp.current, 10 + 8);
    });

    it("WHEN options.hitPointsMode equals 'fixed' with severe negative CON modifier, HP gain is clamped to 1.", () => {
      const wizard = createDefaultActorData("fragile-wiz", "Frail Mage");
      wizard.attributes.level = 1;
      wizard.attributes.hitDieSize = 6; // d6 -> floor(6 / 2) + 1 = 4
      wizard.abilities.con.score = 3; // conModifier = -4
      wizard.attributes.hp.max = 5;
      wizard.attributes.hp.current = 5;

      const result = applyLevelUp(wizard, {
        targetLevel: 2,
        hitPointsMode: "fixed",
      });

      // Gain: Math.max(1, 4 + (-4)) = Math.max(1, 0) = 1
      assert.equal(result.attributes.hp.max, 6);
      assert.equal(result.attributes.hp.current, 6);
    });

    it("WHEN options.hitPointsMode equals 'rolled' and options.rolledHp is absent, less than 1, or greater than hitDieSize, applyLevelUp throws an Error with message 'Invalid rolledHp value'.", () => {
      const actor = createDefaultActorData("barbarian-roll", "Conan");
      actor.attributes.level = 1;
      actor.attributes.hitDieSize = 12;

      // Absent rolledHp
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 2, hitPointsMode: "rolled" }),
        (err: Error) => err.message === "Invalid rolledHp value"
      );

      // rolledHp less than 1
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 2, hitPointsMode: "rolled", rolledHp: 0 }),
        (err: Error) => err.message === "Invalid rolledHp value"
      );
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 2, hitPointsMode: "rolled", rolledHp: -3 }),
        (err: Error) => err.message === "Invalid rolledHp value"
      );

      // rolledHp greater than hitDieSize (13 on a d12)
      assert.throws(
        () => applyLevelUp(actor, { targetLevel: 2, hitPointsMode: "rolled", rolledHp: 13 }),
        (err: Error) => err.message === "Invalid rolledHp value"
      );
    });

    it("WHEN options.hitPointsMode equals 'rolled' and options.rolledHp is valid, applyLevelUp increases actor max and current hit points by Math.max(1, options.rolledHp + conModifier).", () => {
      const actor = createDefaultActorData("ranger-roll", "Strider");
      actor.attributes.level = 1;
      actor.attributes.hitDieSize = 10;
      actor.abilities.con.score = 16; // conModifier = +3
      actor.attributes.hp.max = 13;
      actor.attributes.hp.current = 13;

      const result = applyLevelUp(actor, {
        targetLevel: 2,
        hitPointsMode: "rolled",
        rolledHp: 7,
      });

      // Expected gain: Math.max(1, 7 + 3) = 10
      assert.equal(result.attributes.hp.max, 23);
      assert.equal(result.attributes.hp.current, 23);
    });

    it("WHEN options.hitPointsMode equals 'rolled' and rolledHp + conModifier is non-positive, HP gain clamps to 1.", () => {
      const actor = createDefaultActorData("weak-roll", "Sickly");
      actor.attributes.level = 1;
      actor.attributes.hitDieSize = 8;
      actor.abilities.con.score = 4; // conModifier = -3
      actor.attributes.hp.max = 5;
      actor.attributes.hp.current = 5;

      const result = applyLevelUp(actor, {
        targetLevel: 2,
        hitPointsMode: "rolled",
        rolledHp: 2, // 2 + (-3) = -1 -> clamped to 1
      });

      assert.equal(result.attributes.hp.max, 6);
      assert.equal(result.attributes.hp.current, 6);
    });
  });

  describe("AC6: Subclass Archetype Tiers Gate", () => {
    it("WHEN targetLevel corresponds to Cleric/Sorcerer subclass tier (level 1) and subclassId is missing, applyLevelUp throws an Error.", () => {
      const cleric = createDefaultActorData("cleric-1", "Healer");
      cleric.attributes.level = 0;
      cleric.classId = "cleric";

      assert.throws(
        () => applyLevelUp(cleric, { targetLevel: 1, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Subclass selection required at this level"
      );

      const sorcerer = createDefaultActorData("sorc-1", "Wild Mage");
      sorcerer.attributes.level = 0;
      sorcerer.classId = "sorcerer";

      assert.throws(
        () => applyLevelUp(sorcerer, { targetLevel: 1, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Subclass selection required at this level"
      );
    });

    it("WHEN targetLevel corresponds to Druid/Wizard subclass tier (level 2) and subclassId is missing, applyLevelUp throws an Error.", () => {
      const wizard = createDefaultActorData("wiz-sub", "Mage");
      wizard.attributes.level = 1;
      wizard.classId = "wizard";

      assert.throws(
        () => applyLevelUp(wizard, { targetLevel: 2, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Subclass selection required at this level"
      );

      const druid = createDefaultActorData("druid-sub", "Nature Friend");
      druid.attributes.level = 1;
      druid.classId = "druid";

      assert.throws(
        () => applyLevelUp(druid, { targetLevel: 2, hitPointsMode: "fixed" }),
        (err: Error) => err.message === "Subclass selection required at this level"
      );
    });

    it("WHEN targetLevel corresponds to other classes subclass tier (level 3) and subclassId is missing, applyLevelUp throws an Error.", () => {
      const martialClasses = ["fighter", "rogue", "paladin", "barbarian", "monk", "bard", "ranger", "warlock"];
      for (const cls of martialClasses) {
        const actor = createDefaultActorData(`actor-${cls}`, cls);
        actor.attributes.level = 2;
        actor.classId = cls;

        assert.throws(
          () => applyLevelUp(actor, { targetLevel: 3, hitPointsMode: "fixed" }),
          (err: Error) => err.message === "Subclass selection required at this level",
          `Failed subclass check for ${cls}`
        );
      }
    });

    it("WHEN subclassId is provided at unlock level, applyLevelUp records subclassId on actor.", () => {
      const wizard = createDefaultActorData("wiz-ok", "Evoker");
      wizard.attributes.level = 1;
      wizard.classId = "wizard";

      const leveled = applyLevelUp(wizard, {
        targetLevel: 2,
        hitPointsMode: "fixed",
        subclassId: "school-of-evocation",
      });

      assert.equal(leveled.subclassId, "school-of-evocation");
    });

    it("WHEN targetLevel does not match the class subclass unlock level, subclassId is not required.", () => {
      const wizard = createDefaultActorData("wiz-lvl3", "Mage");
      wizard.attributes.level = 2;
      wizard.classId = "wizard";
      wizard.subclassId = "school-of-evocation";

      // Leveling up to 3 does not throw for wizard (unlock is 2)
      const result = applyLevelUp(wizard, { targetLevel: 3, hitPointsMode: "fixed" });
      assert.equal(result.attributes.level, 3);
      assert.equal(result.subclassId, "school-of-evocation");
    });
  });

  describe("AC7 & AC8: Ability Score Improvement (ASI) vs Feat Selection", () => {
    it("WHEN targetLevel corresponds to an ASI level and options.asiOrFeat.mode equals 'asi' with total bonus not equal to 2, throws 'Invalid ASI bonus sum'.", () => {
      const actor = createDefaultActorData("asi-actor", "Hero");
      actor.attributes.level = 3;
      actor.classId = "fighter";

      // Bonus sum = 3
      assert.throws(
        () =>
          applyLevelUp(actor, {
            targetLevel: 4,
            hitPointsMode: "fixed",
            asiOrFeat: { mode: "asi", bonuses: { str: 3 } },
          }),
        (err: Error) => err.message === "Invalid ASI bonus sum"
      );

      // Bonus sum = 1
      assert.throws(
        () =>
          applyLevelUp(actor, {
            targetLevel: 4,
            hitPointsMode: "fixed",
            asiOrFeat: { mode: "asi", bonuses: { str: 1 } },
          }),
        (err: Error) => err.message === "Invalid ASI bonus sum"
      );

      // Empty bonus
      assert.throws(
        () =>
          applyLevelUp(actor, {
            targetLevel: 4,
            hitPointsMode: "fixed",
            asiOrFeat: { mode: "asi", bonuses: {} },
          }),
        (err: Error) => err.message === "Invalid ASI bonus sum"
      );

      // Negative bonus
      assert.throws(
        () =>
          applyLevelUp(actor, {
            targetLevel: 4,
            hitPointsMode: "fixed",
            asiOrFeat: { mode: "asi", bonuses: { str: 3, dex: -1 } },
          }),
        (err: Error) => err.message === "Invalid ASI bonus sum"
      );
    });

    it("WHEN targetLevel corresponds to an ASI level and options.asiOrFeat.mode equals 'asi' with any targeted score exceeding 20, throws 'Ability score cannot exceed 20'.", () => {
      const actor = createDefaultActorData("asi-cap", "Maxed Hero");
      actor.attributes.level = 3;
      actor.abilities.str.score = 19;
      actor.abilities.dex.score = 20;

      // 19 + 2 = 21 > 20
      assert.throws(
        () =>
          applyLevelUp(actor, {
            targetLevel: 4,
            hitPointsMode: "fixed",
            asiOrFeat: { mode: "asi", bonuses: { str: 2 } },
          }),
        (err: Error) => err.message === "Ability score cannot exceed 20"
      );

      // 20 + 1 = 21 > 20 in split mode
      assert.throws(
        () =>
          applyLevelUp(actor, {
            targetLevel: 4,
            hitPointsMode: "fixed",
            asiOrFeat: { mode: "asi", bonuses: { dex: 1, wis: 1 } },
          }),
        (err: Error) => err.message === "Ability score cannot exceed 20"
      );
    });

    it("WHEN options.asiOrFeat.mode equals 'asi' with valid +2 or +1/+1 bonuses, applyLevelUp updates ability scores.", () => {
      const actor = createDefaultActorData("asi-valid", "Growing Hero");
      actor.attributes.level = 3;
      actor.abilities.str.score = 16;
      actor.abilities.dex.score = 14;

      // +2 STR
      const leveled1 = applyLevelUp(actor, {
        targetLevel: 4,
        hitPointsMode: "fixed",
        asiOrFeat: { mode: "asi", bonuses: { str: 2 } },
      });
      assert.equal(leveled1.abilities.str.score, 18);
      assert.equal(leveled1.abilities.dex.score, 14);

      // +1 STR, +1 DEX
      const leveled2 = applyLevelUp(actor, {
        targetLevel: 4,
        hitPointsMode: "fixed",
        asiOrFeat: { mode: "asi", bonuses: { str: 1, dex: 1 } },
      });
      assert.equal(leveled2.abilities.str.score, 17);
      assert.equal(leveled2.abilities.dex.score, 15);
    });

    it("WHEN options.asiOrFeat.mode equals 'asi' and increases Constitution, hpGain uses the updated Constitution modifier.", () => {
      const actor = createDefaultActorData("asi-con-boost", "Tough Hero");
      actor.attributes.level = 3;
      actor.attributes.hitDieSize = 10;
      actor.abilities.con.score = 13;
      actor.attributes.hp.max = 25;
      actor.attributes.hp.current = 25;

      const result = applyLevelUp(actor, {
        targetLevel: 4,
        hitPointsMode: "fixed",
        asiOrFeat: { mode: "asi", bonuses: { con: 1, str: 1 } },
      });

      assert.equal(result.abilities.con.score, 14);
      assert.equal(result.attributes.hp.max, 33);
      assert.equal(result.attributes.hp.current, 33);
    });

    it("WHEN options.asiOrFeat.mode equals 'asi' and increases Constitution, hpGain uses the updated Constitution modifier.", () => {
      const actor = createDefaultActorData("asi-con-boost", "Tough Hero");
      actor.attributes.level = 3;
      actor.attributes.hitDieSize = 10;
      actor.abilities.con.score = 13;
      actor.attributes.hp.max = 25;
      actor.attributes.hp.current = 25;

      const result = applyLevelUp(actor, {
        targetLevel: 4,
        hitPointsMode: "fixed",
        asiOrFeat: { mode: "asi", bonuses: { con: 1, str: 1 } },
      });

      assert.equal(result.abilities.con.score, 14);
      assert.equal(result.attributes.hp.max, 33);
      assert.equal(result.attributes.hp.current, 33);
    });

    it("WHEN targetLevel corresponds to an ASI level and options.asiOrFeat.mode equals 'feat' with an existing featId, applyLevelUp appends featId to actor features.", () => {
      const actor = createDefaultActorData("feat-actor", "Caster");
      actor.attributes.level = 3;
      actor.features = ["srd:feature:darkvision"];

      const result = applyLevelUp(actor, {
        targetLevel: 4,
        hitPointsMode: "fixed",
        asiOrFeat: { mode: "feat", featId: "srd:feat:war-caster" },
      });

      assert.ok(result.features);
      assert.deepEqual(result.features, [
        "srd:feature:darkvision",
        "srd:feat:war-caster",
      ]);
    });

    it("verifies class-specific ASI levels for Fighter (4, 6, 8, 12, 14, 16, 19) and Rogue (4, 8, 10, 12, 16, 19).", () => {
      assert.equal(isAsiLevel(6, "fighter"), true);
      assert.equal(isAsiLevel(14, "fighter"), true);
      assert.equal(isAsiLevel(6, "wizard"), false);

      assert.equal(isAsiLevel(10, "rogue"), true);
      assert.equal(isAsiLevel(10, "fighter"), false);
      assert.equal(isAsiLevel(10, "cleric"), false);
    });
  });

  describe("AC9: Spell Slot Reconciliation (Full, Half, Pact Casters)", () => {
    it("WHEN applyLevelUp executes on a Full Caster, reconcileSlots updates slot capacities according to canonical SRD 5.1 tables.", () => {
      const bard = createDefaultActorData("bard-1", "Minstrel");
      bard.attributes.level = 2;
      bard.classId = "bard";
      bard.spellSlots = {
        level1: { current: 1, max: 3 }, // 2 slots spent
      };

      // Level up 2 -> 3: Full caster gains level1: 4 slots and level2: 2 slots
      const leveled = applyLevelUp(bard, {
        targetLevel: 3,
        hitPointsMode: "fixed",
        subclassId: "college-of-lore",
        casterType: "full",
      });

      // Level 1: delta = max(0, 4 - 3) = 1. Current = 1 + 1 = 2, max = 4
      assert.equal(leveled.spellSlots?.level1?.current, 2);
      assert.equal(leveled.spellSlots?.level1?.max, 4);
      // Level 2: newly unlocked -> current = 2, max = 2
      assert.equal(leveled.spellSlots?.level2?.current, 2);
      assert.equal(leveled.spellSlots?.level2?.max, 2);
    });

    it("WHEN applyLevelUp executes on a Half Caster, reconcileSlots updates slot capacities starting at level 2.", () => {
      const paladin = createDefaultActorData("pally-1", "Holy Warrior");
      paladin.attributes.level = 1;
      paladin.classId = "paladin";

      // Level 1: 0 slots
      const atLvl1Slots = reconcileSlots(undefined, "half", 1);
      assert.equal(atLvl1Slots.level1, undefined);

      // Level 2: 2 1st-level slots
      const leveled = applyLevelUp(paladin, {
        targetLevel: 2,
        hitPointsMode: "fixed",
        casterType: "half",
      });

      assert.equal(leveled.spellSlots?.level1?.current, 2);
      assert.equal(leveled.spellSlots?.level1?.max, 2);
    });

    it("WHEN applyLevelUp executes on a Pact Magic caster, reconcileSlots updates uniform pact slots and slot level.", () => {
      const warlock = createDefaultActorData("lock-1", "Occultist");
      warlock.attributes.level = 2;
      warlock.classId = "warlock";
      warlock.spellSlots = {
        pact: { current: 0, max: 2 }, // Both spent
      };

      // Level 3: 2 slots of 2nd level (same 2 max, delta = 0)
      const leveledLvl3 = applyLevelUp(warlock, {
        targetLevel: 3,
        hitPointsMode: "fixed",
        subclassId: "the-fiend",
        casterType: "pact",
      });
      assert.equal(leveledLvl3.spellSlots?.pact?.current, 0);
      assert.equal(leveledLvl3.spellSlots?.pact?.max, 2);
      assert.equal(leveledLvl3.spellSlots?.pact?.slotLevel, 2);

      // Level 11: 3 slots of 5th level (max increases from 2 to 3, delta = 1)
      const lock10 = createDefaultActorData("lock-10", "High Warlock");
      lock10.attributes.level = 10;
      lock10.spellSlots = { pact: { current: 1, max: 2, slotLevel: 5 } };
      const leveledLvl11 = applyLevelUp(lock10, {
        targetLevel: 11,
        hitPointsMode: "fixed",
        casterType: "pact",
      });
      assert.equal(leveledLvl11.spellSlots?.pact?.max, 3);
      assert.equal(leveledLvl11.spellSlots?.pact?.current, 2); // 1 + delta(1) = 2
      assert.equal(leveledLvl11.spellSlots?.pact?.slotLevel, 5);
    });

    it("WHEN newSpellIds are provided, applyLevelUp registers them on the actor without duplicates.", () => {
      const wizard = createDefaultActorData("spell-wiz", "Scholar");
      wizard.attributes.level = 4;
      wizard.spellIds = ["srd:spell:magic-missile"];

      const result = applyLevelUp(wizard, {
        targetLevel: 5,
        hitPointsMode: "fixed",
        casterType: "full",
        newSpellIds: ["srd:spell:fireball", "srd:spell:magic-missile"],
      });

      assert.deepEqual(result.spellIds, [
        "srd:spell:magic-missile",
        "srd:spell:fireball",
      ]);
    });
  });

  describe("AC10: Final State Verification & Derived Recalculations", () => {
    it("WHEN applyLevelUp succeeds, applyLevelUp updates level, increments hitDiceMax & hitDiceCurrent, and recalculates proficiency bonus.", () => {
      const actor = createDefaultActorData("hero-final", "Protagonist");
      actor.attributes.level = 4;
      actor.attributes.hitDiceMax = 4;
      actor.attributes.hitDiceCurrent = 2;

      // 4 -> 5: PB increases from +2 to +3
      const result = applyLevelUp(actor, {
        targetLevel: 5,
        hitPointsMode: "fixed",
      });

      assert.equal(result.attributes.level, 5);
      assert.equal(result.attributes.hitDiceMax, 5);
      assert.equal(result.attributes.hitDiceCurrent, 3);
      assert.equal(result.attributes.proficiencyBonus, 3);
      assert.equal(result.proficiencyBonus, 3);
    });

    it("preserves actor immutability: returns a cloned instance without mutating the source actor.", () => {
      const original = createDefaultActorData("immutable-1", "Original");
      original.attributes.level = 1;
      original.attributes.hp.max = 10;
      original.attributes.hp.current = 10;

      const modified = applyLevelUp(original, {
        targetLevel: 2,
        hitPointsMode: "fixed",
      });

      assert.notEqual(original, modified);
      assert.equal(original.attributes.level, 1);
      assert.equal(original.attributes.hp.max, 10);
      assert.equal(modified.attributes.level, 2);
    });
  });

  describe("Comprehensive 1 to 20 Progression Matrix Verification", () => {
    it("simulates complete Level 1 to 20 advancement for a Full Caster (Wizard).", () => {
      let wiz = createDefaultActorData("wiz-prog", "Progression Wizard");
      wiz.attributes.level = 1;
      wiz.attributes.hitDieSize = 6;
      wiz.classId = "wizard";
      wiz.attributes.hp.max = 10;
      wiz.attributes.hp.current = 10;

      for (let lvl = 2; lvl <= 20; lvl++) {
        const options: LevelUpOptions = {
          targetLevel: lvl,
          hitPointsMode: "fixed",
          casterType: "full",
        };
        if (lvl === 2) {
          options.subclassId = "school-of-evocation";
        }
        if ([4, 8, 12, 16, 19].includes(lvl)) {
          options.asiOrFeat = { mode: "asi", bonuses: { int: 2 } };
        }

        wiz = applyLevelUp(wiz, options);
        assert.equal(wiz.attributes.level, lvl);
        assert.equal(wiz.attributes.hitDiceMax, lvl);
        assert.equal(wiz.attributes.proficiencyBonus, calculateProficiencyBonus(lvl));

        const expectedSlots = FULL_CASTER_SPELL_SLOTS[lvl];
        const slotKeys = [
          "level1", "level2", "level3", "level4", "level5",
          "level6", "level7", "level8", "level9",
        ] as const;
        for (let i = 0; i < slotKeys.length; i++) {
          const key = slotKeys[i];
          const exp = expectedSlots[i];
          if (exp > 0) {
            assert.equal(wiz.spellSlots?.[key]?.max, exp, `Lvl ${lvl} ${key} mismatch`);
          }
        }
      }

      assert.equal(wiz.attributes.level, 20);
      assert.equal(wiz.attributes.proficiencyBonus, 6);
      assert.equal(wiz.subclassId, "school-of-evocation");
      assert.equal(wiz.spellSlots?.level9?.max, 1);
    });

    it("simulates complete Level 1 to 20 advancement for a Half Caster (Paladin).", () => {
      let pal = createDefaultActorData("pal-prog", "Progression Paladin");
      pal.attributes.level = 1;
      pal.attributes.hitDieSize = 10;
      pal.classId = "paladin";
      pal.attributes.hp.max = 12;
      pal.attributes.hp.current = 12;

      for (let lvl = 2; lvl <= 20; lvl++) {
        const options: LevelUpOptions = {
          targetLevel: lvl,
          hitPointsMode: "fixed",
          casterType: "half",
        };
        if (lvl === 3) {
          options.subclassId = "oath-of-devotion";
        }
        if ([4, 8, 12, 16, 19].includes(lvl)) {
          options.asiOrFeat = { mode: "asi", bonuses: { str: 2 } };
        }

        pal = applyLevelUp(pal, options);
        assert.equal(pal.attributes.level, lvl);
        assert.equal(pal.attributes.hitDiceMax, lvl);

        const expectedSlots = HALF_CASTER_SPELL_SLOTS[lvl];
        const slotKeys = ["level1", "level2", "level3", "level4", "level5"] as const;
        for (let i = 0; i < slotKeys.length; i++) {
          const key = slotKeys[i];
          const exp = expectedSlots[i];
          if (exp > 0) {
            assert.equal(pal.spellSlots?.[key]?.max, exp, `Paladin lvl ${lvl} ${key} mismatch`);
          }
        }
      }

      assert.equal(pal.attributes.level, 20);
      assert.equal(pal.spellSlots?.level5?.max, 2);
      assert.equal(pal.spellSlots?.level6, undefined);
    });

    it("simulates complete Level 1 to 20 advancement for a Martial Class (Fighter) with 7 ASIs.", () => {
      let fighter = createDefaultActorData("ftr-prog", "Progression Fighter");
      fighter.attributes.level = 1;
      fighter.attributes.hitDieSize = 10;
      fighter.classId = "fighter";
      fighter.abilities.str.score = 10;
      fighter.abilities.con.score = 10;
      fighter.attributes.hp.max = 12;
      fighter.attributes.hp.current = 12;

      const fighterAsiLevels = [4, 6, 8, 12, 14, 16, 19];
      for (let lvl = 2; lvl <= 20; lvl++) {
        const options: LevelUpOptions = {
          targetLevel: lvl,
          hitPointsMode: "fixed",
          casterType: "none",
        };
        if (lvl === 3) {
          options.subclassId = "champion";
        }
        if (fighterAsiLevels.includes(lvl)) {
          if (lvl <= 8) {
            options.asiOrFeat = { mode: "asi", bonuses: { str: 2 } };
          } else {
            options.asiOrFeat = { mode: "feat", featId: `srd:feat:feat-tier-${lvl}` };
          }
        }

        fighter = applyLevelUp(fighter, options);
        assert.equal(fighter.attributes.level, lvl);
      }

      assert.equal(fighter.attributes.level, 20);
      assert.equal(fighter.abilities.str.score, 16); // 10 + 2*3 = 16
      assert.equal(fighter.features?.length, 4); // Feats at 12, 14, 16, 19
      assert.equal(fighter.subclassId, "champion");
      assert.equal(fighter.spellSlots, undefined);
    });
  });
});
