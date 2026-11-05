import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  CHALLENGE_RATINGS,
  MONSTER_STAT_BLOCK_BOUNDS,
  computeDnd5eSheetDerived,
  monsterSheetFromStatBlock,
  proficiencyBonusForChallengeRating,
  xpForChallengeRating,
  type MonsterStatBlock,
} from "../src/index.ts";
import { validateAgainstSchema } from "./support/jsonSchemaSubset.ts";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/monster-stat-block.schema.json", import.meta.url), "utf8")
) as Record<string, unknown>;

/** SRD 5.2.1 Goblin Warrior, written by hand to pin the schema shape. */
function goblinWarrior(): MonsterStatBlock {
  return {
    name: "Goblin Warrior",
    size: "small",
    creatureType: "fey",
    alignment: "chaotic neutral",
    armorClass: { value: 15 },
    hitPoints: { average: 10, formula: "3d6" },
    speed: { walk: 30 },
    abilities: { str: 8, dex: 15, con: 10, int: 10, wis: 8, cha: 8 },
    savingThrows: {},
    skills: { stealth: 6 },
    initiativeBonus: 2,
    senses: { darkvision: 60, passivePerception: 9 },
    languages: "Common, Goblin",
    challengeRating: 0.25,
    xp: 50,
    proficiencyBonus: 2,
    damageVulnerabilities: [],
    damageResistances: [],
    damageImmunities: [],
    conditionImmunities: [],
    traits: [],
    actions: [
      {
        id: "scimitar",
        name: "Scimitar",
        description:
          "Melee Attack Roll: +4, reach 5 ft. 5 (1d6 + 2) Slashing damage, plus 2 (1d4) Slashing damage if the attack roll had Advantage.",
        automation: "full",
        attack: { kind: "melee", toHit: 4, reachFt: 5 },
        damage: [{ dice: "1d6 + 2", average: 5, type: "slashing" }],
        riders: [
          {
            trigger: "onHit",
            when: "if the attack roll had Advantage",
            damage: { dice: "1d4", average: 2, type: "slashing" },
          },
        ],
      },
    ],
    bonusActions: [
      {
        id: "nimble_escape",
        name: "Nimble Escape",
        description: "The goblin takes the Disengage or Hide action.",
        automation: "text",
      },
    ],
    reactions: [],
    source: "srd-5.2.1",
  };
}

type Mutation = (block: MonsterStatBlock) => void;

/** Path inside the schema document holding the bounds of each `MONSTER_STAT_BLOCK_BOUNDS` key. */
const BOUND_PATHS: Record<keyof typeof MONSTER_STAT_BLOCK_BOUNDS, string[]> = {
  abilityScore: ["$defs", "abilityScore"],
  armorClass: ["properties", "armorClass", "properties", "value"],
  hitPoints: ["properties", "hitPoints", "properties", "average"],
  speedFt: ["$defs", "speedFt"],
  senseRangeFt: ["$defs", "senseRangeFt"],
  passivePerception: ["properties", "senses", "properties", "passivePerception"],
  challengeRating: ["properties", "challengeRating"],
  xp: ["properties", "xp"],
  proficiencyBonus: ["properties", "proficiencyBonus"],
  savingThrowBonus: ["$defs", "savingThrowBonus"],
  skillBonus: ["$defs", "skillBonus"],
  initiativeBonus: ["properties", "initiativeBonus"],
  toHit: ["$defs", "action", "properties", "attack", "properties", "toHit"],
  saveDc: ["$defs", "savingThrow", "properties", "dc"],
  damageAverage: ["$defs", "damagePart", "properties", "average"],
  reachFt: ["$defs", "action", "properties", "attack", "properties", "reachFt"],
  rangeFt: ["$defs", "action", "properties", "attack", "properties", "rangeFt"],
  areaSizeFt: ["$defs", "area", "properties", "sizeFt"],
  legendaryActionUses: ["properties", "legendaryActions", "properties", "uses"],
  legendaryActionLairUses: ["properties", "legendaryActions", "properties", "lairUses"],
  legendaryActionCost: ["$defs", "action", "properties", "legendaryCost"],
  legendaryResistanceUses: ["properties", "legendaryResistance", "properties", "uses"],
  rechargeMinRoll: ["$defs", "action", "properties", "usage", "properties", "minRoll"],
  usesPerDay: ["$defs", "action", "properties", "usage", "properties", "uses"],
  multiattackCount: ["$defs", "action", "properties", "multiattack", "items", "properties", "count"],
};

function schemaAt(path: string[]): Record<string, unknown> {
  return path.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, schema);
}

describe("GS8 monster stat block schema", () => {
  it("goblin-warrior-reference-stat-block-is-valid", () => {
    assert.deepEqual(validateAgainstSchema(schema, goblinWarrior()), []);
  });

  for (const [key, path] of Object.entries(BOUND_PATHS)) {
    it(`bounds-${key}-match-json-schema`, () => {
      const bounds = MONSTER_STAT_BLOCK_BOUNDS[key as keyof typeof MONSTER_STAT_BLOCK_BOUNDS];
      const node = schemaAt(path);
      assert.equal(node.minimum, bounds.min);
      assert.equal(node.maximum, bounds.max);
    });
  }

  const rejected: [string, Mutation, string][] = [
    ["ac-31-above-ceiling", (b) => { b.armorClass.value = 31; }, "$.armorClass.value: 31 > 30"],
    ["ac-0-below-floor", (b) => { b.armorClass.value = 0; }, "$.armorClass.value: 0 < 1"],
    ["hp-1001-above-ceiling", (b) => { b.hitPoints.average = 1001; }, "$.hitPoints.average: 1001 > 1000"],
    ["hp-formula-free-text", (b) => { b.hitPoints.formula = "lots"; }, "$.hitPoints.formula"],
    ["fly-speed-250-ft", (b) => { b.speed.fly = 250; }, "$.speed.fly: 250 > 200"],
    ["darkvision-negative", (b) => { b.senses.darkvision = -5; }, "$.senses.darkvision: -5 < 0"],
    ["cr-31-not-a-challenge-rating", (b) => { b.challengeRating = 31; }, "$.challengeRating"],
    ["cr-0.3-not-a-challenge-rating", (b) => { b.challengeRating = 0.3; }, "$.challengeRating"],
    ["ability-score-31", (b) => { b.abilities.str = 31; }, "$.abilities.str: 31 > 30"],
    ["unknown-damage-type", (b) => { (b.damageImmunities as string[]).push("sonic"); }, "$.damageImmunities[0]"],
    ["unknown-condition", (b) => { (b.conditionImmunities as string[]).push("confused"); }, "$.conditionImmunities[0]"],
    ["attack-to-hit-31", (b) => { b.actions[0].attack!.toHit = 31; }, "$.actions[0].attack.toHit: 31 > 30"],
    ["damage-dice-script", (b) => { b.actions[0].damage![0].dice = "1d6+<script>"; }, "$.actions[0].damage[0].dice"],
    ["rider-without-effect", (b) => { b.actions[0].riders = [{ trigger: "onHit" }]; }, "$.actions[0].riders[0]: fewer than 2 properties"],
    ["unknown-automation-level", (b) => { (b.actions[0] as { automation: string }).automation = "auto"; }, "$.actions[0].automation"],
    ["legendary-cost-4", (b) => { b.actions[0].legendaryCost = 4; }, "$.actions[0].legendaryCost: 4 > 3"],
    ["unexpected-root-property", (b) => { (b as unknown as Record<string, unknown>).hp = 999; }, "unexpected property 'hp'"],
    ["action-id-with-spaces", (b) => { b.actions[0].id = "Scimitar Attack"; }, "$.actions[0].id"],
  ];
  for (const [caseId, mutate, expected] of rejected) {
    it(`rejects-${caseId}`, () => {
      const block = goblinWarrior();
      mutate(block);
      const errors = validateAgainstSchema(schema, block);
      assert.ok(errors.some((e) => e.includes(expected)), `expected an error containing '${expected}', got ${JSON.stringify(errors)}`);
    });
  }
});

describe("GS8 challenge rating tables", () => {
  const cases: [number, number, number][] = [
    [0, 10, 2],
    [0.125, 25, 2],
    [0.25, 50, 2],
    [0.5, 100, 2],
    [4, 1100, 2],
    [5, 1800, 3],
    [9, 5000, 4],
    [13, 10000, 5],
    [17, 18000, 6],
    [21, 33000, 7],
    [25, 75000, 8],
    [30, 155000, 9],
  ];
  for (const [cr, xp, pb] of cases) {
    it(`cr-${cr}-is-worth-${xp}-xp-with-proficiency-${pb}`, () => {
      assert.equal(xpForChallengeRating(cr), xp);
      assert.equal(proficiencyBonusForChallengeRating(cr), pb);
    });
  }

  it("every-challenge-rating-has-an-xp-value", () => {
    assert.equal(CHALLENGE_RATINGS.length, 34);
    for (const cr of CHALLENGE_RATINGS) assert.ok(xpForChallengeRating(cr) > 0);
  });
});

describe("UA2 stat block projects onto a playable actor sheet", () => {
  const sheet = monsterSheetFromStatBlock("srd:monster:goblin", goblinWarrior());

  const cases: [string, unknown, unknown][] = [
    ["hp-max", sheet.hpMax, 10],
    ["armor-base-ac", sheet.armorBaseAc, 15],
    ["armor-kind-natural", sheet.armorKind, "natural"],
    ["hit-dice-count", sheet.hitDiceMax, 3],
    ["hit-die-sides", sheet.hitDieSides, 6],
    ["proficiency-level", sheet.level, 1],
    ["challenge-rating-label", sheet.challengeRating, "1/4"],
    ["stealth-expertise", sheet.skillProficiencies.stealth, "expertise"],
    ["walk-speed", sheet.speedFt, 30],
    ["legacy-scimitar-attack", sheet.actions[0], { id: "scimitar", name: "Scimitar", attackBonus: 4, damage: "1d6 + 2", damageType: "slashing" }],
  ];
  for (const [caseId, actual, expected] of cases) {
    it(`goblin-sheet-${caseId}`, () => assert.deepEqual(actual, expected));
  }

  it("goblin-sheet-derives-stat-block-ac-and-stealth", () => {
    const derived = computeDnd5eSheetDerived({ ...sheet, spellcastingAbility: "int" });
    assert.equal(derived.armorClass, 15);
    assert.equal(derived.skills.stealth, 6);
    assert.equal(derived.passivePerception, 9);
  });
});
