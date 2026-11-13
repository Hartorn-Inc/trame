import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { nodeWasmDerivedDagEvaluator } from "../src/node.ts";
import * as api from "../src/index.ts";
import {
  BACKGROUNDS,
  CONDITION_UNCONSCIOUS,
  EXHAUSTION_DEATH_LEVEL,
  SRD_CLASS_PROGRESSION,
  SRD_FEATS,
  SRD_SPECIES,
  SUBCLASS_UNLOCK_LEVEL,
  SYSTEM_SRD,
  applyBackground,
  applyExhaustion,
  applyLevelUp,
  applyLongRest,
  calculateProficiencyBonus,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  getCastableSpellLevels,
  getLevelUpSpellChoices,
  getMaxSpellSlotLevel,
  getSpeciesRules,
  getSpellsByLevel,
  getSubclassUnlockLevel,
  getWeaponMasteryCount,
  resolveDamagePipeline,
  setDerivedDagEvaluator,
  validateFeatSelection,
  type AbilityId,
  type ArmorCalculationKind,
  type BackgroundAbilityChoice,
  type BackgroundId,
  type CompendiumEntityType,
  type DamageType,
  type DeathSaveCounters,
  type Dnd5eActorData,
  type Dnd5eActorSheet,
  type Dnd5eDerivedStats,
  type FeatSelectionContext,
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

function monsterSheet(key: string): Dnd5eActorSheet {
  const entry = SYSTEM_SRD.find((e) => e.id === `srd:monster:${key}`);
  assert.ok(entry, `srd:monster:${key} must exist`);
  return structuredClone(entry.data) as unknown as Dnd5eActorSheet;
}

/** Equivalent `Dnd5eActorData` / `Dnd5eActorSheet` pair (level 5 INT caster with a shield). */
function parityPair(exhaustion: number): [Dnd5eActorData, Dnd5eActorSheet] {
  const actor = createDefaultActorData("parity", "Parity");
  actor.attributes.level = 5;
  actor.attributes.exhaustion = exhaustion;
  actor.attributes.spellcastingAbility = "int";
  actor.attributes.shieldBonus = 2;
  actor.abilities.dex = { score: 14, saveProficiency: true };
  actor.abilities.int = { score: 16, saveProficiency: true };
  actor.abilities.wis.score = 14;
  actor.skills.perception.proficiencyRank = 1;
  actor.skills.investigation.proficiencyRank = 2;
  const sheet = createSheet({
    exhaustionLevel: exhaustion,
    hasShield: true,
    abilities: { str: 10, dex: 14, con: 10, int: 16, wis: 14, cha: 10 },
    saveProficiencies: { dex: true, int: true },
    skillProficiencies: { perception: "proficient", investigation: "expertise" },
  });
  return [actor, sheet];
}

describe("SystemSRD curated catalog (SRD 5.2.1)", () => {
  const exactCounts: [CompendiumEntityType, number][] = [
    ["class", 12],
    ["species", 11],
    ["background", 9],
    ["feat", 17],
    ["condition", 15],
  ];
  for (const [type, expected] of exactCounts) {
    it(`catalog-has-exactly-${expected}-${type}-entries`, () => {
      assert.equal(SYSTEM_SRD.filter((e) => e.entityType === type).length, expected);
    });
  }

  const minimumCounts: [CompendiumEntityType[], number][] = [
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

  const removedIds = [
    "srd:feat:tough",
    "srd:feat:sharpshooter",
    "srd:feat:great_weapon_master",
    "srd:feat:sentinel",
    "srd:feat:dual_wielder",
    "srd:background:folk_hero",
    "srd:background:noble",
    "srd:monster:banshee",
  ];
  for (const id of removedIds) {
    it(`G10-non-srd-521-entry-${id}-is-absent`, () => {
      assert.equal(SYSTEM_SRD.some((e) => e.id === id || e.id === id.replace(/_/g, "-")), false);
    });
  }

  const masteryWeapons: [string, string][] = [
    ["Dagger", "nick"],
    ["Greataxe", "cleave"],
    ["Maul", "topple"],
    ["Longsword", "sap"],
    ["Longbow", "slow"],
  ];
  for (const [name, mastery] of masteryWeapons) {
    it(`G10-weapon-${name}-has-mastery-${mastery}`, () => {
      const weapon = SYSTEM_SRD.find((e) => e.entityType === "weapon" && e.name === name);
      assert.equal(weapon?.data.mastery, mastery);
    });
  }

  it("G10-every-weapon-has-a-mastery-property", () => {
    for (const weapon of SYSTEM_SRD.filter((e) => e.entityType === "weapon")) {
      assert.ok(weapon.data.mastery, `${weapon.id} lacks a mastery`);
    }
  });
});

describe("Class progression levels 1-20 (SRD 5.2.1, G10 supersedes A34)", () => {
  for (const classId of CLASS_IDS) {
    it(`G10-${classId}-chooses-subclass-at-level-3`, () => {
      assert.equal(getSubclassUnlockLevel(classId), SUBCLASS_UNLOCK_LEVEL);
      assert.equal(getSubclassUnlockLevel(`srd:class:${classId}`), 3);
    });

    it(`G10-${classId}-reaches-level-20-with-subclass-chosen-at-3`, () => {
      const atThree = levelTo(classId, 3);
      assert.equal(atThree.subclassId, `srd:subclass:${classId}-test`);
      const actor = levelTo(classId, 20);
      assert.equal(actor.attributes.level, 20);
      assert.equal(actor.attributes.proficiencyBonus, 6);
      assert.equal(actor.attributes.hitDiceMax, 20);
      assert.equal(actor.subclassId, `srd:subclass:${classId}-test`);
      assert.throws(() => applyLevelUp(actor, {}), /Max level is 20/);
    });

    it(`G10-${classId}-level-up-to-3-requires-subclass`, () => {
      assert.throws(
        () => applyLevelUp(levelTo(classId, 2), { targetLevel: 3 }),
        /Subclass selection required at this level/
      );
    });

    it(`review-${classId}-level-up-past-3-without-subclass-requires-one`, () => {
      const actor = levelTo(classId, 4);
      delete actor.subclassId;
      delete actor.attributes.subclassId;
      assert.throws(() => applyLevelUp(actor, { targetLevel: 5 }), /Subclass selection required at this level/);
    });
  }

  const weaponMasteryCases: [SrdClassId, number, number][] = [
    ["barbarian", 1, 2],
    ["barbarian", 10, 4],
    ["fighter", 1, 3],
    ["fighter", 16, 6],
    ["paladin", 1, 2],
    ["ranger", 1, 2],
    ["rogue", 1, 2],
    ["wizard", 20, 0],
    ["monk", 20, 0],
  ];
  for (const [classId, level, expected] of weaponMasteryCases) {
    it(`G10-${classId}-level-${level}-masters-${expected}-weapon-kinds`, () => {
      assert.equal(getWeaponMasteryCount(classId, level), expected);
    });
  }

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

  for (const classId of ["paladin", "ranger"] as const) {
    it(`G10-half-caster-${classId}-casts-from-level-1`, () => {
      assert.equal(getMaxSpellSlotLevel(SRD_CLASS_PROGRESSION[classId].casterType, 1), 1);
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

describe("Species (9 SRD 5.2.1 + 2 TRAME originals, ADR-0038)", () => {
  it("G10-species-are-9-srd-521-and-2-trame-originals", () => {
    const entries = Object.entries(SRD_SPECIES);
    assert.deepEqual(
      entries.filter(([, s]) => s.source === "srd").map(([k]) => k).sort(),
      ["dragonborn", "dwarf", "elf", "gnome", "goliath", "halfling", "human", "orc", "tiefling"]
    );
    assert.deepEqual(
      entries.filter(([, s]) => s.source === "trame-original").map(([k]) => k).sort(),
      ["half_elf", "radiant_scion"]
    );
  });

  const originalSpeciesCases: {
    id: string;
    key: "half_elf" | "radiant_scion";
    size: "Medium" | "Medium or Small";
    speedFt: number;
    darkvisionFt: number;
    traits: string[];
    enName: string;
    frName: string;
  }[] = [
    {
      id: "half_elf-medium-30ft-60ft-darkvision-dual-heritage-fey-resilience",
      key: "half_elf",
      size: "Medium",
      speedFt: 30,
      darkvisionFt: 60,
      traits: ["Dual Heritage", "Fey Resilience"],
      enName: "Half-Elf",
      frName: "Demi-Elfe",
    },
    {
      id: "radiant_scion-medium-or-small-30ft-60ft-darkvision-celestial-spark-guiding-touch",
      key: "radiant_scion",
      size: "Medium or Small",
      speedFt: 30,
      darkvisionFt: 60,
      traits: ["Celestial Spark", "Guiding Touch"],
      enName: "Radiant Scion",
      frName: "Héritier radieux",
    },
  ];
  for (const tc of originalSpeciesCases) {
    it(`ADR-0038-original-species-${tc.id}`, () => {
      const rules = getSpeciesRules(tc.key);
      assert.ok(rules);
      assert.equal(rules, getSpeciesRules(`srd:species:${tc.key}`));
      assert.equal(rules, getSpeciesRules(`trame:species:${tc.key}`));
      assert.equal(rules.size, tc.size);
      assert.equal(rules.speedFt, tc.speedFt);
      assert.equal(rules.darkvisionFt, tc.darkvisionFt);
      assert.equal(rules.hpBonusPerLevel, 0);
      assert.equal(rules.source, "trame-original");
      assert.deepEqual(rules.traits, tc.traits);
      for (const trait of tc.traits) {
        assert.ok(rules.traitDescriptions?.[trait]?.en.trim(), `${tc.key} ${trait} missing en description`);
        assert.ok(rules.traitDescriptions?.[trait]?.fr.trim(), `${tc.key} ${trait} missing fr description`);
      }
      const entry = SYSTEM_SRD.find((e) => e.id === `srd:species:${tc.key}`);
      assert.ok(entry);
      assert.equal(entry.data.source, "trame-original");
      assert.equal(entry.i18n?.en.name, tc.enName);
      assert.equal(entry.i18n?.fr.name, tc.frName);
    });
  }

  for (const key of Object.keys(SRD_SPECIES)) {
    it(`G10-species-${key}-grants-no-ability-score-increase`, () => {
      const entry = SYSTEM_SRD.find((e) => e.id === `srd:species:${key}`);
      assert.ok(entry);
      assert.equal("abilityScoreIncrease" in entry.data, false);
      assert.equal("abilityBonuses" in entry.data, false);
    });
  }

  const speedCases: [string, number][] = [["goliath", 35], ["dwarf", 30], ["halfling", 30]];
  for (const [key, speedFt] of speedCases) {
    it(`G10-species-${key}-speed-${speedFt}-ft`, () => {
      assert.equal(getSpeciesRules(`srd:species:${key}`)?.speedFt, speedFt);
    });
  }

  const hpCases: [string, number][] = [["dwarf", 1], ["human", 0]];
  for (const [speciesId, perLevel] of hpCases) {
    it(`G10-species-${speciesId}-adds-${perLevel}-hp-per-level-up`, () => {
      const actor = createClassActor("fighter");
      actor.speciesId = `srd:species:${speciesId}`;
      const leveled = applyLevelUp(actor, { targetLevel: 2 });
      assert.equal(leveled.attributes.hp.max - actor.attributes.hp.max, 6 + perLevel);
    });
  }
});

describe("Backgrounds (4 SRD 5.2.1 + 5 TRAME originals, ADR-0038)", () => {
  it("G10-backgrounds-are-4-srd-and-5-originals", () => {
    const entries = Object.entries(BACKGROUNDS);
    assert.deepEqual(entries.filter(([, b]) => b.source === "srd").map(([k]) => k).sort(), ["acolyte", "criminal", "sage", "soldier"]);
    assert.deepEqual(
      entries.filter(([, b]) => b.source === "trame-original").map(([k]) => k).sort(),
      ["artisan", "caravan_guide", "house_guardian", "lamplighter", "merchant"]
    );
  });

  const newBackgroundCases: {
    id: string;
    key: BackgroundId;
    abilities: [AbilityId, AbilityId, AbilityId];
    originFeat: string;
    skills: [string, string];
    tool: string;
    enName: string;
    frName: string;
  }[] = [
    {
      id: "artisan-str-con-int-skilled-smiths-tools",
      key: "artisan",
      abilities: ["str", "con", "int"],
      originFeat: "srd:feat:skilled",
      skills: ["investigation", "persuasion"],
      tool: "Smith's Tools",
      enName: "Artisan",
      frName: "Artisan",
    },
    {
      id: "merchant-con-int-cha-skilled-navigators-tools",
      key: "merchant",
      abilities: ["con", "int", "cha"],
      originFeat: "srd:feat:skilled",
      skills: ["persuasion", "insight"],
      tool: "Navigator's Tools",
      enName: "Merchant",
      frName: "Marchand",
    },
    {
      id: "house_guardian-str-con-cha-alert-herbalism-kit",
      key: "house_guardian",
      abilities: ["str", "con", "cha"],
      originFeat: "srd:feat:alert",
      skills: ["athletics", "medicine"],
      tool: "Herbalism Kit",
      enName: "House Guardian",
      frName: "Gardien de lignée",
    },
  ];
  for (const tc of newBackgroundCases) {
    it(`ADR-0038-original-background-${tc.id}`, () => {
      const bg = BACKGROUNDS[tc.key];
      assert.deepEqual(bg.abilities, tc.abilities);
      assert.equal(bg.originFeat, tc.originFeat);
      assert.deepEqual(bg.skillProficiencies, tc.skills);
      assert.equal(bg.toolProficiency, tc.tool);
      assert.equal(bg.source, "trame-original");
      const entry = SYSTEM_SRD.find((e) => e.id === `srd:background:${tc.key}`);
      assert.ok(entry);
      assert.equal(entry.data.source, "trame-original");
      assert.equal(entry.i18n?.en.name, tc.enName);
      assert.equal(entry.i18n?.fr.name, tc.frName);
    });
  }

  for (const [key, background] of Object.entries(BACKGROUNDS) as [BackgroundId, (typeof BACKGROUNDS)[BackgroundId]][]) {
    const [a, b, c] = background.abilities;
    const choices: [string, BackgroundAbilityChoice, Partial<Record<AbilityId, number>>][] = [
      [`plus2-${a}-plus1-${b}`, { mode: "plus2_plus1", plus2: a, plus1: b }, { [a]: 12, [b]: 11, [c]: 10 }],
      ["plus1-each", { mode: "plus1_each" }, { [a]: 11, [b]: 11, [c]: 11 }],
    ];
    for (const [label, choice, expectedScores] of choices) {
      it(`G10-background-${key}-${label}-applies-asi-skills-and-origin-feat`, () => {
        const result = applyBackground(createDefaultActorData(`bg-${key}`, key), key, choice);
        for (const [ab, score] of Object.entries(expectedScores)) {
          assert.equal(result.abilities[ab as AbilityId].score, score);
        }
        for (const skill of background.skillProficiencies) {
          assert.equal(result.skills[skill].proficiencyRank, 1);
        }
        assert.deepEqual(result.features, [background.originFeat]);
        assert.ok(SRD_FEATS[background.originFeat.replace("srd:feat:", "") as keyof typeof SRD_FEATS]);
        assert.equal(SRD_FEATS[background.originFeat.replace("srd:feat:", "") as keyof typeof SRD_FEATS].category, "origin");
        assert.equal(result.backgroundId, `srd:background:${key}`);
        assert.ok(result.derived);
      });
    }

    const outsider = (["str", "dex", "con", "int", "wis", "cha"] as AbilityId[]).find((ab) => !background.abilities.includes(ab))!;
    it(`G10-background-${key}-rejects-increase-outside-its-abilities`, () => {
      assert.throws(
        () => applyBackground(createDefaultActorData(), key, { mode: "plus2_plus1", plus2: outsider, plus1: a }),
        /Invalid background ability choice/
      );
    });
  }

  const rejectCases: [string, () => unknown, RegExp][] = [
    ["same-ability-twice", () => applyBackground(createDefaultActorData(), "sage", { mode: "plus2_plus1", plus2: "int", plus1: "int" }), /Invalid background ability choice/],
    ["unknown-background", () => applyBackground(createDefaultActorData(), "folk_hero", { mode: "plus1_each" }), /Unknown background/],
    ["second-background", () => applyBackground(applyBackground(createDefaultActorData(), "sage", { mode: "plus1_each" }), "soldier", { mode: "plus1_each" }), /Background already applied/],
    ["score-above-20", () => {
      const actor = createDefaultActorData();
      actor.abilities.int.score = 19;
      return applyBackground(actor, "sage", { mode: "plus2_plus1", plus2: "int", plus1: "wis" });
    }, /Ability score cannot exceed 20/],
  ];
  for (const [id, run, error] of rejectCases) {
    it(`G10-background-rejects-${id}`, () => {
      assert.throws(run, error);
    });
  }

  it("G10-background-con-increase-adds-retroactive-hp", () => {
    const actor = createDefaultActorData("bg-con", "Soldier");
    actor.abilities.con.score = 13;
    actor.attributes.level = 3;
    const result = applyBackground(actor, "soldier", { mode: "plus2_plus1", plus2: "con", plus1: "str" });
    // CON 13 -> 15 raises the modifier from +1 to +2: +1 HP for each of the 3 levels
    assert.equal(result.attributes.hp.max - actor.attributes.hp.max, 3);
  });
});

describe("Feats (exactly the 17 SRD 5.2.1 feats)", () => {
  const baseCtx: FeatSelectionContext = {
    targetLevel: 4,
    abilities: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    heldFeatIds: [],
    hasSpellcasting: false,
  };

  it("G10-exactly-17-srd-feats", () => {
    assert.equal(Object.keys(SRD_FEATS).length, 17);
  });

  const accepted: [string, string, Partial<FeatSelectionContext>, AbilityId | undefined][] = [
    ["origin-feat-alert-at-level-4", "srd:feat:alert", {}, undefined],
    ["repeatable-skilled-taken-twice", "srd:feat:skilled", { heldFeatIds: ["srd:feat:skilled"] }, undefined],
    ["grappler-raises-str", "srd:feat:grappler", { abilityIncrease: "str" }, "str"],
    ["epic-boon-at-19-raises-above-20", "srd:feat:boon_of_fate", { targetLevel: 19, abilities: { ...baseCtx.abilities, cha: 20 }, abilityIncrease: "cha" }, "cha"],
    ["spell-recall-for-caster", "srd:feat:boon_of_spell_recall", { targetLevel: 19, hasSpellcasting: true, abilityIncrease: "int" }, "int"],
    ["homebrew-feat-passes-unchecked", "campaign:feat:lucky-charm", {}, undefined],
    ["fighting-style-with-fighting-style-feature", "srd:feat:archery", { hasFightingStyle: true }, undefined],
  ];
  for (const [id, featId, ctx, expected] of accepted) {
    it(`G10-feat-accepts-${id}`, () => {
      assert.equal(validateFeatSelection(featId, { ...baseCtx, ...ctx }), expected);
    });
  }

  const rejected: [string, string, Partial<FeatSelectionContext>, RegExp][] = [
    ["fighting-style-without-fighting-style-feature", "srd:feat:archery", {}, /Fighting Style feats require the Fighting Style feature/],
    ["asi-as-feat", "srd:feat:ability_score_improvement", {}, /Use the ASI selection/],
    ["epic-boon-before-19", "srd:feat:boon_of_truesight", { abilityIncrease: "wis" }, /Feat prerequisite not met/],
    ["grappler-without-str-or-dex-13", "srd:feat:grappler", { abilities: { ...baseCtx.abilities, str: 12 }, abilityIncrease: "str" }, /Feat prerequisite not met/],
    ["spell-recall-without-spellcasting", "srd:feat:boon_of_spell_recall", { targetLevel: 19, abilityIncrease: "int" }, /Feat prerequisite not met/],
    ["non-repeatable-twice", "srd:feat:alert", { heldFeatIds: ["srd:feat:alert"] }, /Feat already taken/],
    ["missing-ability-increase", "srd:feat:grappler", {}, /Invalid feat ability increase/],
    ["disallowed-ability-increase", "srd:feat:grappler", { abilityIncrease: "con" }, /Invalid feat ability increase/],
    ["general-feat-above-20", "srd:feat:grappler", { abilities: { ...baseCtx.abilities, str: 20 }, abilityIncrease: "str" }, /cannot exceed 20/],
    ["epic-boon-above-30", "srd:feat:boon_of_fate", { targetLevel: 19, abilities: { ...baseCtx.abilities, cha: 30 }, abilityIncrease: "cha" }, /cannot exceed 30/],
  ];
  for (const [id, featId, ctx, error] of rejected) {
    it(`G10-feat-rejects-${id}`, () => {
      assert.throws(() => validateFeatSelection(featId, { ...baseCtx, ...ctx }), error);
    });
  }

  it("G10-level-up-feat-applies-its-ability-increase", () => {
    const actor = levelTo("fighter", 3);
    actor.abilities.str.score = 15;
    const result = applyLevelUp(actor, {
      targetLevel: 4,
      asiOrFeat: { mode: "feat", featId: "srd:feat:grappler", abilityIncrease: "str" },
    });
    assert.equal(result.abilities.str.score, 16);
    assert.ok(result.features?.includes("srd:feat:grappler"));
  });
});

describe("Exhaustion (SRD 5.2.1)", () => {
  it("G10-exhaustion-condition-text-is-2024-rule-in-en-and-fr", () => {
    const entry = SYSTEM_SRD.find((e) => e.id === "srd:condition:exhaustion");
    assert.match(entry?.i18n?.en.description ?? "", /2 × the level/);
    assert.match(entry?.i18n?.en.description ?? "", /Level 6 is death/);
    assert.match(entry?.i18n?.fr.description ?? "", /2 × le niveau/);
    assert.match(entry?.i18n?.fr.description ?? "", /niveau 6 entraîne la mort/);
    assert.deepEqual(
      [entry?.data.maxLevel, entry?.data.d20PenaltyPerLevel, entry?.data.speedPenaltyFtPerLevel],
      [6, 2, 5]
    );
  });

  const representations: [string, (level: number) => Dnd5eDerivedStats][] = [
    ["actor-data", (level) => computeDnd5eSheetDerived(parityPair(level)[0])],
    ["sheet", (level) => computeDnd5eSheetDerived(parityPair(level)[1])],
  ];
  for (const [repr, derive] of representations) {
    for (let level = 1; level <= 5; level += 1) {
      it(`G10-exhaustion-${level}-on-${repr}-shifts-every-output-correctly`, () => {
        const rested = derive(0);
        const tired = derive(level);
        const penalty = 2 * level;
        for (const ab of Object.keys(rested.savingThrows) as AbilityId[]) {
          assert.equal(tired.savingThrows[ab], rested.savingThrows[ab] - penalty, `save ${ab}`);
          assert.equal(tired.abilityMods[ab], rested.abilityMods[ab], `mod ${ab}`);
        }
        for (const skill of Object.keys(rested.skills) as (keyof typeof rested.skills)[]) {
          assert.equal(tired.skills[skill], rested.skills[skill] - penalty, `skill ${skill}`);
        }
        assert.equal(tired.initiativeBonus, rested.initiativeBonus - penalty);
        assert.equal(tired.spellAttackBonus, rested.spellAttackBonus - penalty);
        assert.equal(tired.speed, Math.max(0, 30 - 5 * level));
        assert.equal(tired.passivePerception, rested.passivePerception, "passives are not d20 tests");
        assert.equal(tired.passiveInvestigation, rested.passiveInvestigation);
        assert.equal(tired.passiveInsight, rested.passiveInsight);
        assert.equal(tired.spellSaveDc, rested.spellSaveDc, "spell save DC is never reduced");
        assert.equal(tired.armorClass, rested.armorClass);
        assert.equal(tired.proficiencyBonus, rested.proficiencyBonus);
        assert.deepEqual(tired.encumbrance, rested.encumbrance);
      });
    }
  }

  for (let level = 0; level <= 5; level += 1) {
    it(`G10-exhaustion-${level}-actor-data-and-sheet-derive-identical-objects`, () => {
      const [actor, sheet] = parityPair(level);
      assert.deepEqual(computeDnd5eSheetDerived(actor), computeDnd5eSheetDerived(sheet));
    });
  }

  const deathCases: [string, () => boolean][] = [
    ["actor-data-reaching-6-dies", () => {
      const actor = createDefaultActorData();
      actor.attributes.exhaustion = 5;
      const result = applyExhaustion(actor, 1);
      return result.attributes.exhaustion === EXHAUSTION_DEATH_LEVEL && result.isDead === true;
    }],
    ["sheet-reaching-6-dies", () => {
      const result = applyExhaustion(createSheet({ exhaustionLevel: 4 }), 3);
      return result.exhaustionLevel === 6 && result.deathSaves.isDead;
    }],
    ["actor-data-at-5-lives", () => applyExhaustion(createDefaultActorData(), 5).isDead === false],
    ["lowering-never-revives", () => {
      const dead = applyExhaustion(createSheet(), 6);
      const result = applyExhaustion(dead, -1);
      return result.exhaustionLevel === 5 && result.deathSaves.isDead;
    }],
    ["level-clamps-at-0", () => applyExhaustion(createSheet(), -2).exhaustionLevel === 0],
  ];
  for (const [id, check] of deathCases) {
    it(`G10-exhaustion-${id}`, () => {
      assert.equal(check(), true);
    });
  }

  const monsterSaves: [string, number, Partial<Record<AbilityId, number>>][] = [
    ["stone_giant", 0, { str: 6, dex: 5, con: 8, int: 0, wis: 4, cha: -1 }],
    ["stone_giant", 2, { str: 2, dex: 1, con: 4, int: -4, wis: 0, cha: -5 }],
    ["balor", 0, { str: 8, dex: 2, con: 12, int: 5, wis: 9, cha: 6 }],
    ["balor", 3, { con: 6, wis: 3 }],
    ["mummy_lord", 0, { int: 5, wis: 9, con: 3 }],
  ];
  for (const [key, exhaustionLevel, expected] of monsterSaves) {
    it(`review-monster-${key}-exhaustion-${exhaustionLevel}-saving-throws-match-stat-block`, () => {
      const sheet = monsterSheet(key);
      sheet.exhaustionLevel = exhaustionLevel;
      const saves = computeDnd5eSheetDerived(sheet).savingThrows;
      for (const [ab, value] of Object.entries(expected)) {
        assert.equal(saves[ab as AbilityId], value, `${key} ${ab}`);
      }
    });
  }
});

describe("Regression: game-systems review findings", () => {
  const legendaryCases: [string, number | undefined][] = [
    ["mummy_lord", 3],
    ["pit_fiend", 4],
    ["ghost", undefined],
  ];
  for (const [key, uses] of legendaryCases) {
    it(`review-${key}-legendary-resistance-per-srd-521-is-${uses ?? "none"}`, () => {
      const resources = monsterSheet(key).resources as Record<string, { max: number }>;
      assert.equal(resources.legendary_resistance?.max, uses);
    });
  }

  it("review-mummy-lord-uses-the-srd-521-stat-block", () => {
    const sheet = monsterSheet("mummy_lord");
    assert.deepEqual([sheet.armorBaseAc, sheet.hpMax], [17, 187]);
  });

  it("review-ghost-replaces-banshee-with-unqualified-resistances", () => {
    const ghost = monsterSheet("ghost") as unknown as { damageResistances: string[] };
    assert.ok(ghost.damageResistances.includes("bludgeoning"));
    assert.ok(ghost.damageResistances.includes("slashing"));
  });

  const DAMAGE_TYPES: readonly DamageType[] = [
    "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
    "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
  ];
  it("review-every-monster-mitigation-is-a-plain-damage-type", () => {
    for (const entry of SYSTEM_SRD.filter((e) => e.entityType === "monster")) {
      for (const field of ["damageResistances", "damageImmunities", "damageVulnerabilities"]) {
        for (const type of (entry.data[field] as string[] | undefined) ?? []) {
          assert.ok(DAMAGE_TYPES.includes(type as DamageType), `${entry.id} ${field}: ${type}`);
        }
      }
    }
  });

  it("review-meteor-swarm-deals-separate-fire-and-bludgeoning-components", () => {
    const meteor = SYSTEM_SRD.find((e) => e.id === "srd:spell:meteor_swarm");
    assert.deepEqual(meteor?.data.damageComponents, [
      { dice: "20d6", damageType: "fire" },
      { dice: "20d6", damageType: "bludgeoning" },
    ]);
    assert.equal(meteor?.data.damageType, undefined);
  });

  const mageArmor = {
    id: "00000000-0000-4000-8000-000000000001",
    source_name: "Spell:MageArmor",
    enabled: true,
    duration_rounds_remaining: null,
    concentration_caster_id: null,
    modifiers: [{ target: "ac_base", phase: "BASE", value: 13, formula: "13 + dex_mod" }],
  };
  const shieldCases: [string, boolean, number][] = [
    ["base-effect-without-shield", false, 15],
    ["base-effect-keeps-the-shield", true, 17],
  ];
  for (const [id, hasShield, expected] of shieldCases) {
    it(`review-ac-${id}`, () => {
      const sheet = createSheet({ hasShield, abilities: { ...createSheet().abilities, dex: 14 } });
      assert.equal(computeDnd5eSheetDerived(sheet, [mageArmor]).armorClass, expected);
    });
  }

  it("B03-death-save-counters-type-is-exported", () => {
    const counters: DeathSaveCounters = createDefaultActorData().attributes.deathSaves;
    assert.deepEqual(counters, { successes: 0, failures: 0 });
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

describe("Regression: A36 retroactive HP from CON", () => {
  const cases: [string, Parameters<typeof applyLevelUp>[1]["asiOrFeat"], number][] = [
    ["A36-con-asi-14-to-16-adds-1-hp-per-earlier-level", { mode: "asi", bonuses: { con: 2 } }, 6 + 3 + 3],
    ["A36-str-asi-adds-no-retroactive-hp", { mode: "asi", bonuses: { str: 2 } }, 6 + 2],
  ];
  for (const [id, asiOrFeat, expectedGain] of cases) {
    it(id, () => {
      const actor = levelTo("fighter", 3);
      actor.abilities.con.score = 14;
      const before = actor.attributes.hp.max;
      const after = applyLevelUp(actor, { targetLevel: 4, asiOrFeat });
      assert.equal(after.attributes.hp.max - before, expectedGain);
    });
  }
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

describe("Regression: A38 single derived-stat path through the WASM evaluator", () => {
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

  it("A38-all-derived-evaluation-routes-through-the-evaluator-seam", () => {
    const calls: string[][] = [];
    setDerivedDagEvaluator((base, formulas, effects) => {
      calls.push(Object.keys(formulas));
      return nodeWasmDerivedDagEvaluator(base, formulas, effects);
    });
    try {
      computeDnd5eSheetDerived(createSheet());
      calculateProficiencyBonus(5);
    } finally {
      setDerivedDagEvaluator(nodeWasmDerivedDagEvaluator);
    }
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("ac"));
    assert.deepEqual(calls[1], ["prof_bonus"]);
  });

  it("G1-evaluation-without-an-installed-evaluator-fails-closed", () => {
    setDerivedDagEvaluator(null);
    try {
      assert.throws(() => calculateProficiencyBonus(5), /No derivedDAG evaluator installed/);
    } finally {
      setDerivedDagEvaluator(nodeWasmDerivedDagEvaluator);
    }
  });

  const wasmErrors: [string, Record<string, string>][] = [
    ["unknown-variable", { x: "missing_input + 1" }],
    ["cycle", { a: "b + 1", b: "a + 1" }],
    ["syntax-error", { x: "1 +" }],
  ];
  for (const [id, formulas] of wasmErrors) {
    it(`G1-wasm-evaluator-throws-on-${id}`, () => {
      assert.throws(() => nodeWasmDerivedDagEvaluator({}, formulas));
    });
  }

  it("G1-reference-ts-evaluator-is-gone", () => {
    assert.equal("referenceEvaluateDerivedDag" in api, false);
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
