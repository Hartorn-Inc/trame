import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import * as api from "../src/index.ts";
import {
  CONDITION_UNCONSCIOUS,
  SRD_CLASS_PROGRESSION,
  SYSTEM_SRD,
  applyLevelUp,
  applyLongRest,
  calculateProficiencyBonus,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  getCastableSpellLevels,
  getLevelUpSpellChoices,
  getMaxSpellSlotLevel,
  getSpellsByLevel,
  getSubclassUnlockLevel,
  referenceEvaluateDerivedDag,
  resolveDamagePipeline,
  setDerivedDagEvaluator,
  type ArmorCalculationKind,
  type CompendiumEntityType,
  type Dnd5eActorData,
  type Dnd5eActorSheet,
  type SrdClassId,
} from "../src/index.ts";

const CLASS_IDS = Object.keys(SRD_CLASS_PROGRESSION) as SrdClassId[];

function createClassActor(classId: SrdClassId): Dnd5eActorData {
  const actor = createDefaultActorData(`hero-${classId}`, classId);
  actor.classId = classId;
  actor.attributes.hitDieSize = SRD_CLASS_PROGRESSION[classId].hitDie;
  return actor;
}

function levelTo(classId: SrdClassId, targetLevel: number): Dnd5eActorData {
  let actor = createClassActor(classId);
  while (actor.attributes.level < targetLevel) {
    const next = actor.attributes.level + 1;
    actor = applyLevelUp(actor, {
      targetLevel: next,
      subclassId: next === getSubclassUnlockLevel(classId) ? `srd:subclass:${classId}-test` : undefined,
    });
  }
  return actor;
}

function createSheet(overrides: Partial<Dnd5eActorSheet> = {}): Dnd5eActorSheet {
  return {
    id: "sheet-derived",
    name: "Derived Hero",
    level: 5,
    spellcastingAbility: "int",
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saveProficiencies: {},
    skillProficiencies: {},
    armorKind: "unarmored",
    armorBaseAc: 10,
    hasShield: false,
    hpCurrent: 30,
    hpMax: 30,
    tempHp: 0,
    hitDiceCurrent: 5,
    hitDiceMax: 5,
    hitDieSides: 8,
    exhaustionLevel: 0,
    conditions: [],
    resources: {},
    deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
    ...overrides,
  };
}

describe("SystemSRD curated catalog (S5)", () => {
  const minimumCounts: [CompendiumEntityType[], number][] = [
    [["class"], 12],
    [["species"], 9],
    [["background"], 6],
    [["condition"], 15],
    [["spell"], 60],
    [["item", "weapon", "armor"], 40],
    [["monster"], 35],
  ];
  for (const [types, minimum] of minimumCounts) {
    it(`catalog-has-at-least-${minimum}-${types.join("-")}-entries`, () => {
      const count = SYSTEM_SRD.filter((e) => types.includes(e.entityType)).length;
      assert.ok(count >= minimum, `${types.join("/")}: ${count} < ${minimum}`);
    });
  }

  for (let level = 0; level <= 9; level += 1) {
    it(`catalog-has-spells-of-level-${level}`, () => {
      assert.ok(getSpellsByLevel(level).length > 0);
    });
  }

  for (const [label, cr] of [["cr-0", 0], ["cr-20", 20]] as const) {
    it(`catalog-has-monster-${label}`, () => {
      assert.ok(SYSTEM_SRD.some((e) => e.entityType === "monster" && e.data.cr === cr));
    });
  }

  it("catalog-ids-are-unique", () => {
    const ids = SYSTEM_SRD.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("catalog-entries-are-bilingual-with-english-canonical-name", () => {
    for (const entry of SYSTEM_SRD) {
      assert.ok(entry.i18n?.fr.name, `${entry.id} lacks French metadata`);
      assert.equal(entry.i18n?.en.name, entry.name, `${entry.id} English name is not canonical`);
    }
  });

  it("catalog-includes-the-tough-feat", () => {
    assert.ok(SYSTEM_SRD.some((e) => e.id === "srd:feat:tough" && e.entityType === "feat"));
  });
});

describe("Class progression levels 1-20 (S5, A34)", () => {
  const expectedSubclassLevels: [SrdClassId, number][] = [
    ["barbarian", 3],
    ["bard", 3],
    ["cleric", 1],
    ["druid", 2],
    ["fighter", 3],
    ["monk", 3],
    ["paladin", 3],
    ["ranger", 3],
    ["rogue", 3],
    ["sorcerer", 1],
    ["warlock", 1],
    ["wizard", 2],
  ];

  for (const [classId, subclassLevel] of expectedSubclassLevels) {
    it(`${classId}-chooses-subclass-at-level-${subclassLevel}`, () => {
      assert.equal(getSubclassUnlockLevel(classId), subclassLevel);
      assert.equal(getSubclassUnlockLevel(`srd:class:${classId}`), subclassLevel);
    });

    it(`${classId}-reaches-level-20-with-proficiency-6-and-20-hit-dice`, () => {
      const actor = levelTo(classId, 20);
      assert.equal(actor.attributes.level, 20);
      assert.equal(actor.attributes.proficiencyBonus, 6);
      assert.equal(actor.attributes.hitDiceMax, 20);
      if (subclassLevel > 1) assert.equal(actor.subclassId, `srd:subclass:${classId}-test`);
      assert.throws(() => applyLevelUp(actor, {}), /Max level is 20/);
    });

    if (subclassLevel > 1) {
      it(`${classId}-level-up-to-${subclassLevel}-requires-subclass`, () => {
        const actor = levelTo(classId, subclassLevel - 1);
        assert.throws(
          () => applyLevelUp(actor, { targetLevel: subclassLevel }),
          /Subclass selection required at this level/
        );
      });
    }
  }

  it("A34-warlock-subclass-is-not-required-at-level-3", () => {
    const actor = levelTo("warlock", 2);
    assert.doesNotThrow(() => applyLevelUp(actor, { targetLevel: 3 }));
  });

  const maxSlotAt20: [SrdClassId, number][] = [
    ["barbarian", 0],
    ["bard", 9],
    ["cleric", 9],
    ["druid", 9],
    ["fighter", 0],
    ["monk", 0],
    ["paladin", 5],
    ["ranger", 5],
    ["rogue", 0],
    ["sorcerer", 9],
    ["warlock", 5],
    ["wizard", 9],
  ];
  for (const [classId, maxSlot] of maxSlotAt20) {
    it(`${classId}-max-spell-slot-level-at-20-is-${maxSlot}`, () => {
      assert.equal(getMaxSpellSlotLevel(SRD_CLASS_PROGRESSION[classId].casterType, 20), maxSlot);
    });
  }

  const thirdCasterCases: [number, number][] = [
    [2, 0],
    [3, 1],
    [7, 2],
    [13, 3],
    [19, 4],
    [20, 4],
  ];
  for (const [level, maxSlot] of thirdCasterCases) {
    it(`third-caster-level-${level}-max-slot-${maxSlot}`, () => {
      assert.equal(getMaxSpellSlotLevel("third", level), maxSlot);
    });
  }
});

describe("Casters at level 11+ always have spells to choose (S5)", () => {
  const casters = CLASS_IDS.filter((id) => SRD_CLASS_PROGRESSION[id].casterType !== "none");
  for (const classId of casters) {
    for (let level = 11; level <= 20; level += 1) {
      it(`${classId}-level-${level}-has-learnable-spells-for-every-castable-level`, () => {
        const castable = getCastableSpellLevels(classId, level);
        assert.ok(castable.length > 0);
        for (const spellLevel of castable) {
          assert.ok(
            getSpellsByLevel(spellLevel, classId).length > 0,
            `${classId} level ${level}: no level-${spellLevel} spell`
          );
        }
        assert.ok(getLevelUpSpellChoices(classId, level).length > 0);
      });
    }
  }

  const arcanumCases: [number, number[]][] = [
    [10, []],
    [11, [6]],
    [13, [6, 7]],
    [15, [6, 7, 8]],
    [17, [6, 7, 8, 9]],
  ];
  for (const [level, arcanum] of arcanumCases) {
    it(`warlock-level-${level}-mystic-arcanum-${arcanum.join("-") || "none"}`, () => {
      assert.deepEqual(getCastableSpellLevels("warlock", level).filter((l) => l > 5), arcanum);
    });
  }

  it("level-up-spell-choices-exclude-known-spells", () => {
    const all = getLevelUpSpellChoices("wizard", 11);
    const known = [all[0].id];
    assert.equal(getLevelUpSpellChoices("wizard", 11, known).length, all.length - 1);
  });
});

describe("Regression: A35 long rest never revives the dead", () => {
  it("A35-dead-actor-data-stays-dead-at-0-hp", () => {
    const actor = createDefaultActorData("dead-hero", "Fallen");
    actor.attributes.hp.current = 0;
    actor.attributes.deathSaves.failures = 3;
    actor.isDead = true;
    const rested = applyLongRest(actor);
    assert.equal(rested.isDead, true);
    assert.equal(rested.attributes.hp.current, 0);
    assert.equal(rested.attributes.deathSaves.failures, 3);
  });

  it("A35-dead-sheet-stays-dead-at-0-hp", () => {
    const sheet = createSheet({
      hpCurrent: 0,
      deathSaves: { successes: 0, failures: 3, isStable: false, isDead: true },
    });
    const result = applyLongRest(sheet);
    assert.equal(result.hpRecovered, 0);
    assert.equal(sheet.hpCurrent, 0);
    assert.equal(sheet.deathSaves.isDead, true);
  });

  it("A35-unconscious-but-alive-actor-recovers", () => {
    const actor = createDefaultActorData("down-hero", "Downed");
    actor.attributes.hp.current = 0;
    assert.equal(applyLongRest(actor).attributes.hp.current, actor.attributes.hp.max);
  });
});

describe("Regression: A36 retroactive HP from CON and Tough", () => {
  const cases: [string, Dnd5eActorData["features"], Parameters<typeof applyLevelUp>[1]["asiOrFeat"], number][] = [
    ["A36-con-asi-14-to-16-adds-1-hp-per-earlier-level", [], { mode: "asi", bonuses: { con: 2 } }, 6 + 3 + 3],
    ["A36-str-asi-adds-no-retroactive-hp", [], { mode: "asi", bonuses: { str: 2 } }, 6 + 2],
    ["tough-feat-on-acquisition-adds-2-hp-per-level", [], { mode: "feat", featId: "srd:feat:tough" }, 6 + 2 + 8],
  ];
  for (const [id, features, asiOrFeat, expectedGain] of cases) {
    it(id, () => {
      const actor = levelTo("fighter", 3);
      actor.abilities.con.score = 14;
      actor.features = features;
      const before = actor.attributes.hp.max;
      const after = applyLevelUp(actor, { targetLevel: 4, asiOrFeat });
      assert.equal(after.attributes.hp.max - before, expectedGain);
    });
  }

  it("tough-feat-adds-2-hp-on-each-later-level", () => {
    const actor = levelTo("fighter", 4);
    actor.abilities.con.score = 10;
    actor.features = ["srd:feat:tough"];
    const after = applyLevelUp(actor, { targetLevel: 5 });
    assert.equal(after.attributes.hp.max - actor.attributes.hp.max, 6 + 2);
  });
});

describe("Regression: A37 English condition ids in the damage pipeline", () => {
  it("A37-dropping-to-0-hp-adds-srd-unconscious-condition", () => {
    const actor = createDefaultActorData("victim", "Victim");
    actor.attributes.hp.current = 5;
    const { actor: hit } = resolveDamagePipeline(actor, [{ amount: 6, type: "slashing" }]);
    assert.equal(CONDITION_UNCONSCIOUS, "srd:condition:unconscious");
    assert.deepEqual(
      hit.conditions.map((c) => [c.id, c.name]),
      [[CONDITION_UNCONSCIOUS, "Unconscious"]]
    );
    assert.ok(SYSTEM_SRD.some((e) => e.id === CONDITION_UNCONSCIOUS));
  });
});

describe("Regression: A38 single derived-stat path", () => {
  const acCases: [string, ArmorCalculationKind, number, Partial<Dnd5eActorSheet["abilities"]>, boolean, number][] = [
    ["unarmored-dex-14", "unarmored", 10, { dex: 14 }, false, 12],
    ["light-armor-dex-uncapped", "light", 11, { dex: 18 }, false, 15],
    ["medium-armor-dex-capped-at-2", "medium", 14, { dex: 18 }, false, 16],
    ["heavy-armor-ignores-dex", "heavy", 18, { dex: 14 }, false, 18],
    ["natural-armor-is-stat-block-ac", "natural", 17, { dex: 18 }, false, 17],
    ["barbarian-unarmored-defense-adds-con", "unarmored_barbarian", 10, { dex: 14, con: 16 }, false, 15],
    ["barbarian-unarmored-defense-with-shield", "unarmored_barbarian", 10, { dex: 14, con: 16 }, true, 17],
    ["barbarian-negative-con-best-wins-plain-unarmored", "unarmored_barbarian", 10, { dex: 14, con: 8 }, false, 12],
    ["monk-unarmored-defense-adds-wis", "unarmored_monk", 10, { dex: 16, wis: 16 }, false, 16],
    ["heavy-armor-with-shield", "heavy", 18, { dex: 10 }, true, 20],
  ];
  for (const [id, armorKind, armorBaseAc, abilities, hasShield, expectedAc] of acCases) {
    it(`A38-ac-${id}`, () => {
      const sheet = createSheet({
        armorKind,
        armorBaseAc,
        hasShield,
        abilities: { ...createSheet().abilities, ...abilities },
      });
      assert.equal(computeDnd5eSheetDerived(sheet).armorClass, expectedAc);
    });
  }

  const exhaustionCases: [number, number, number][] = [
    [0, 14, 6],
    [2, 14, 2],
  ];
  for (const [exhaustionLevel, expectedDc, expectedAttack] of exhaustionCases) {
    it(`A38-exhaustion-${exhaustionLevel}-spell-dc-${expectedDc}-attack-${expectedAttack}`, () => {
      const sheet = createSheet({ exhaustionLevel, abilities: { ...createSheet().abilities, int: 16 } });
      const derived = computeDnd5eSheetDerived(sheet);
      assert.equal(derived.spellSaveDc, expectedDc);
      assert.equal(derived.spellAttackBonus, expectedAttack);
    });
  }

  it("A38-actor-data-and-sheet-agree-on-derived-stats", () => {
    const actor = createDefaultActorData("parity", "Parity");
    actor.attributes.level = 5;
    actor.attributes.armorType = "medium";
    actor.attributes.baseArmorAC = 14;
    actor.abilities.dex.score = 18;
    const sheet = createSheet({ armorKind: "medium", armorBaseAc: 14, abilities: { ...createSheet().abilities, dex: 18 } });
    const fromActor = computeDnd5eSheetDerived(actor);
    const fromSheet = computeDnd5eSheetDerived(sheet);
    assert.equal(fromActor.armorClass, fromSheet.armorClass);
    assert.deepEqual(fromActor.skills, fromSheet.skills);
  });

  it("A38-all-derived-evaluation-routes-through-the-evaluator-seam", () => {
    const calls: string[][] = [];
    setDerivedDagEvaluator((base, formulas) => {
      calls.push(Object.keys(formulas));
      return referenceEvaluateDerivedDag(base, formulas);
    });
    try {
      computeDnd5eSheetDerived(createSheet());
      calculateProficiencyBonus(5);
    } finally {
      setDerivedDagEvaluator(null);
    }
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("ac"));
    assert.deepEqual(calls[1], ["prof_bonus"]);
  });
});

describe("Regression: A41 and A43 duplicate definitions removed", () => {
  it("A41-root-sheetLayout-duplicate-is-deleted", () => {
    assert.equal(existsSync(new URL("../sheetLayout.ts", import.meta.url)), false);
    assert.equal(existsSync(new URL("../src/sheetLayout.ts", import.meta.url)), true);
  });

  it("A43-no-second-proficiency-bonus-export", () => {
    assert.equal("proficiencyBonusForLevel" in api, false);
  });

  const profCases: [number, number][] = [
    [1, 2], [4, 2], [5, 3], [8, 3], [9, 4], [12, 4], [13, 5], [16, 5], [17, 6], [20, 6],
  ];
  for (const [level, expected] of profCases) {
    it(`A43-proficiency-bonus-level-${level}-is-${expected}`, () => {
      assert.equal(calculateProficiencyBonus(level), expected);
      assert.equal(computeDnd5eSheetDerived(createSheet({ level })).proficiencyBonus, expected);
    });
  }
});
