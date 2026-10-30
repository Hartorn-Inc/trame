import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CompendiumResolver,
  DND5E_SKILLS,
  DND5E_SRD51_MANIFEST,
  FULL_CASTER_SPELL_SLOTS,
  HALF_CASTER_SPELL_SLOTS,
  PACT_MAGIC_SPELL_SLOTS,
  SRD_51_ATTRIBUTION,
  applyLevelUp,
  applyLongRest,
  applyShortRest,
  calculateProficiencyBonus,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  decrementConditionDurations,
  resolveDamagePipeline,
  rollDeathSavingThrow,
  type CompendiumEntry,
  type DamageInstance,
  type Dnd5eActorData,
} from "../../game-systems/dnd5e/src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("[E1-T1] D&D 5e GameSystemPack (SRD 5.1) Specification Suite", () => {
  it("T-DND-01: computes derived attributes, ability modifiers, and passive perception correctly", () => {
    const actor = createDefaultActorData("hero-1", "Valeros");
    actor.attributes.level = 1;
    actor.abilities.wis = { score: 16, saveProficiency: false };
    actor.skills.perception = { ability: "wis", proficiencyRank: 1 };

    const derived = computeDnd5eSheetDerived(actor);
    assert.equal(derived.abilityMods.wis, 3);
    assert.equal(derived.proficiencyBonus, 2);
    assert.equal(derived.passivePerception, 15);

    // Ability modifier progression verification across standard score range
    const abilityCases = [
      { score: 8, expectedMod: -1 },
      { score: 10, expectedMod: 0 },
      { score: 12, expectedMod: 1 },
      { score: 14, expectedMod: 2 },
      { score: 16, expectedMod: 3 },
      { score: 18, expectedMod: 4 },
      { score: 20, expectedMod: 5 },
    ];
    for (const ac of abilityCases) {
      actor.abilities.str = { score: ac.score, saveProficiency: false };
      const res = computeDnd5eSheetDerived(actor);
      assert.equal(res.abilityMods.str, ac.expectedMod);
    }

    // Armor Class calculation across armor types
    actor.abilities.dex = { score: 14, saveProficiency: false }; // mod +2
    actor.attributes.armorType = "none";
    assert.equal(computeDnd5eSheetDerived(actor).armorClass, 12);

    actor.attributes.shieldBonus = 2;
    assert.equal(computeDnd5eSheetDerived(actor).armorClass, 14);

    actor.attributes.armorType = "medium";
    actor.attributes.baseArmorAC = 14;
    assert.equal(computeDnd5eSheetDerived(actor).armorClass, 18); // 14 + min(2,2) + 2

    actor.attributes.armorType = "heavy";
    actor.attributes.baseArmorAC = 18;
    assert.equal(computeDnd5eSheetDerived(actor).armorClass, 20); // 18 + 0 + 2

    // Encumbrance rules
    actor.abilities.str.score = 15;
    const encDerived = computeDnd5eSheetDerived(actor);
    assert.equal(encDerived.encumbrance?.carryingCapacity, 225);
    assert.equal(encDerived.encumbrance?.heavilyEncumbered, 150);
    assert.equal(encDerived.encumbrance?.encumbered, 75);
  });

  it("T-DND-02: validates structural integrity and DAG acyclicity of packages/game-systems/dnd5e/system.json", () => {
    const manifestPath = resolve(__dirname, "../../game-systems/dnd5e/system.json");
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    assert.equal(manifest.id, "dnd5e");
    assert.equal(manifest.name, "Dungeons & Dragons 5th Edition (SRD 5.1)");
    assert.equal(manifest.license, "CC-BY-4.0");
    assert.ok(manifest.attribution.includes("System Reference Document 5.1"));

    assert.deepEqual(manifest.abilities, ["str", "dex", "con", "int", "wis", "cha"]);
    assert.equal(manifest.skills.length, 18);
    assert.equal(DND5E_SKILLS.length, 18);
    assert.equal(DND5E_SRD51_MANIFEST.skills.length, 18);

    // Topological sort acyclicity check on derivedDAG formulas
    const dag = manifest.derivedDAG as Record<string, string>;
    const keys = Object.keys(dag);
    assert.ok(keys.length >= 10);

    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};
    for (const key of keys) {
      inDegree[key] = 0;
      adjacency[key] = [];
    }

    for (const [target, expr] of Object.entries(dag)) {
      for (const depKey of keys) {
        if (depKey !== target && expr.includes(depKey)) {
          adjacency[depKey].push(target);
          inDegree[target] = (inDegree[target] || 0) + 1;
        }
      }
    }

    const queue: string[] = keys.filter((k) => inDegree[k] === 0);
    let visitedCount = 0;
    while (queue.length > 0) {
      const curr = queue.shift()!;
      visitedCount++;
      for (const neighbor of adjacency[curr]) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
    }
    assert.equal(visitedCount, keys.length, "derivedDAG must be completely acyclic");
  });

  it("T-DND-03: resolves simultaneous multi-type damage with resistance, immunity, and vulnerability", () => {
    const actor = createDefaultActorData("target-1", "Ogre");
    actor.attributes.hp.current = 40;
    actor.attributes.hp.max = 40;
    actor.damageMitigations.slashing = "RESISTANT";
    actor.damageMitigations.fire = "IMMUNE";
    actor.damageMitigations.cold = "VULNERABLE";
    actor.damageMitigations.radiant = "NONE";

    const instances: DamageInstance[] = [
      { amount: 10, type: "slashing" }, // floor(10 * 0.5) = 5
      { amount: 15, type: "fire" },     // 0
      { amount: 4, type: "cold" },      // 4 * 2 = 8
      { amount: 6, type: "radiant" },   // 6
    ];

    const res = resolveDamagePipeline(actor, instances);
    assert.equal(res.totalMitigatedDamage, 19); // 5 + 0 + 8 + 6 = 19
    assert.equal(res.damageAppliedToCurrentHp, 19);
    assert.equal(res.actor.attributes.hp.current, 21);
    assert.equal(res.instantDeath, false);
    assert.equal(res.deathSavesModified, false);
  });

  it("T-DND-04: absorbs damage with Temporary HP prior to reducing current HP", () => {
    const actor = createDefaultActorData("hero-thp", "Barbarian");
    actor.attributes.hp.current = 20;
    actor.attributes.hp.max = 20;
    actor.attributes.hp.temp = 5;

    const res = resolveDamagePipeline(actor, [{ amount: 8, type: "bludgeoning" }]);
    assert.equal(res.totalMitigatedDamage, 8);
    assert.equal(res.damageAppliedToTempHp, 5);
    assert.equal(res.damageAppliedToCurrentHp, 3);
    assert.equal(res.actor.attributes.hp.temp, 0);
    assert.equal(res.actor.attributes.hp.current, 17);
  });

  it("T-DND-05: increments 1 death save failure when taking non-critical damage at 0 HP", () => {
    const actor = createDefaultActorData("dying-1", "Dying Cleric");
    actor.attributes.hp.current = 0;
    actor.attributes.hp.max = 20;
    actor.attributes.deathSaves = { successes: 0, failures: 0 };

    const res = resolveDamagePipeline(actor, [{ amount: 6, type: "piercing" }]);
    assert.equal(res.deathSavesModified, true);
    assert.equal(res.actor.attributes.deathSaves.failures, 1);
    assert.equal(res.actor.attributes.hp.current, 0);
    assert.equal(res.actor.isDead, false);
  });

  it("T-DND-06: increments 2 death save failures on critical damage at 0 HP and kills at 3 failures", () => {
    const actor = createDefaultActorData("dying-2", "Dying Rogue");
    actor.attributes.hp.current = 0;
    actor.attributes.hp.max = 20;
    actor.attributes.deathSaves = { successes: 1, failures: 1 };

    const res = resolveDamagePipeline(actor, [{ amount: 6, type: "slashing" }], {
      isCritical: true,
    });
    assert.equal(res.deathSavesModified, true);
    assert.equal(res.actor.attributes.deathSaves.failures, 3);
    assert.equal(res.actor.isDead, true);
  });

  it("T-DND-07: triggers instant death when overflow damage equals or exceeds max HP", () => {
    const actor = createDefaultActorData("squishy-1", "Wizard");
    actor.attributes.hp.current = 2;
    actor.attributes.hp.max = 10;
    actor.attributes.deathSaves = { successes: 0, failures: 0 };

    // 24 damage: 2 absorbs to 0, excess 22 >= 10 (max HP)
    const res = resolveDamagePipeline(actor, [{ amount: 24, type: "force" }]);
    assert.equal(res.instantDeath, true);
    assert.equal(res.actor.isDead, true);
    assert.equal(res.actor.attributes.deathSaves.failures, 3);
    assert.equal(res.actor.attributes.hp.current, 0);
  });

  it("T-DND-08: generates concentration prompt with DC = max(10, floor(damage / 2)) for moderate damage", () => {
    const actor = createDefaultActorData("caster-1", "Sorcerer");
    actor.attributes.hp.current = 25;
    actor.attributes.hp.max = 25;
    actor.concentratingOnSpellId = "spell-haste";

    const res = resolveDamagePipeline(actor, [{ amount: 14, type: "lightning" }]);
    assert.ok(res.concentrationPrompt);
    assert.equal(res.concentrationPrompt?.spellId, "spell-haste");
    assert.equal(res.concentrationPrompt?.dc, 10); // max(10, floor(14 / 2)) = 10
    assert.equal(res.concentrationCheckPrompt?.dc, 10);
  });

  it("T-DND-09: generates higher DC for massive damage and automatically breaks concentration at 0 HP", () => {
    const actor = createDefaultActorData("caster-2", "Druid");
    actor.attributes.hp.current = 50;
    actor.attributes.hp.max = 50;
    actor.concentratingOnSpellId = "spell-call-lightning";

    const res1 = resolveDamagePipeline(actor, [{ amount: 26, type: "thunder" }]);
    assert.equal(res1.concentrationPrompt?.dc, 13); // max(10, floor(26 / 2)) = 13

    // Damage reducing caster to 0 HP breaks concentration immediately without a prompt
    const res2 = resolveDamagePipeline(res1.actor, [{ amount: 40, type: "thunder" }]);
    assert.equal(res2.actor.attributes.hp.current, 0);
    assert.equal(res2.actor.concentratingOnSpellId, undefined);
    assert.equal(res2.concentrationPrompt, undefined);
  });

  it("T-DND-10: death save natural 1 adds 2 failures and kills if total reaches 3", () => {
    const actor = createDefaultActorData("dying-nat1", "Paladin");
    actor.attributes.hp.current = 0;
    actor.attributes.deathSaves = { successes: 0, failures: 1 };

    const res1 = rollDeathSavingThrow(actor, 1);
    assert.equal(res1.actor.attributes.deathSaves.failures, 3);
    assert.equal(res1.outcome, "dead");
    assert.equal(res1.actor.isDead, true);
  });

  it("T-DND-11: death save natural 20 revives actor with 1 HP and clears unconsciousness", () => {
    const actor = createDefaultActorData("dying-nat20", "Fighter");
    actor.attributes.hp.current = 0;
    actor.attributes.deathSaves = { successes: 2, failures: 2 };
    actor.conditions.push({
      id: "unconscious",
      name: "Inconscient",
      durationRounds: 999,
      trigger: "ROUNDS",
    });

    const res = rollDeathSavingThrow(actor, 20);
    assert.equal(res.outcome, "revived");
    assert.equal(res.actor.attributes.hp.current, 1);
    assert.equal(res.actor.attributes.deathSaves.successes, 0);
    assert.equal(res.actor.attributes.deathSaves.failures, 0);
    assert.equal(res.actor.conditions.some((c) => c.id === "unconscious"), false);

    // Normal success and stabilization at 3 successes
    let stActor = createDefaultActorData("stable-actor", "Ranger");
    stActor.attributes.hp.current = 0;
    stActor.attributes.deathSaves = { successes: 2, failures: 0 };
    const resStable = rollDeathSavingThrow(stActor, 12);
    assert.equal(resStable.outcome, "stabilized");
    assert.equal(resStable.actor.attributes.deathSaves.successes, 0);
    assert.equal(resStable.actor.attributes.deathSaves.failures, 0);
  });

  it("T-DND-12: applies Short Rest spending hit dice with CON modifier and restoring SHORT_REST resources", () => {
    const actor = createDefaultActorData("rest-1", "Warlock");
    actor.attributes.hp.current = 10;
    actor.attributes.hp.max = 30;
    actor.abilities.con.score = 14; // conMod +2
    actor.attributes.hitDiceCurrent = 3;
    actor.attributes.hitDiceMax = 3;
    actor.resources = {
      second_wind: {
        current: 0,
        max: 1,
        resetOn: "SHORT_REST",
      },
      long_feat: {
        current: 0,
        max: 1,
        resetOn: "LONG_REST",
      },
    };
    actor.spellSlots = {
      pact: { current: 0, max: 2 },
    };

    // Spend 2 hit dice rolling 6 and 4: (6+2) + (4+2) = 14 HP gained
    const afterRest = applyShortRest(actor, { hitDiceSpent: 2, diceRolls: [6, 4] });
    assert.equal(afterRest.attributes.hp.current, 24);
    assert.equal(afterRest.attributes.hitDiceCurrent, 1);
    assert.equal(afterRest.resources?.second_wind.current, 1);
    assert.equal(afterRest.resources?.long_feat.current, 0);
    assert.equal(afterRest.spellSlots?.pact?.current, 2);

    // Validates invalid spent counts
    assert.throws(() => applyShortRest(actor, { hitDiceSpent: 5, diceRolls: [1, 2, 3, 4, 5] }));
    assert.throws(() => applyShortRest(actor, { hitDiceSpent: 2, diceRolls: [6] }));
  });

  it("T-DND-13: applies Long Rest restoring full HP, half hit dice, and resetting exhaustion and all pools", () => {
    const actor = createDefaultActorData("rest-2", "Paladin");
    actor.attributes.hp.current = 4;
    actor.attributes.hp.max = 40;
    actor.attributes.hp.temp = 8;
    actor.attributes.hitDiceCurrent = 1;
    actor.attributes.hitDiceMax = 6;
    actor.attributes.exhaustion = 2;
    actor.attributes.deathSaves = { successes: 2, failures: 1 };
    actor.resources = {
      lay_on_hands: { current: 5, max: 30, resetOn: "LONG_REST" },
      channel_divinity: { current: 0, max: 1, resetOn: "SHORT_REST" },
    };
    actor.spellSlots = {
      level1: { current: 1, max: 4 },
      level2: { current: 0, max: 2 },
    };

    const afterLongRest = applyLongRest(actor);
    assert.equal(afterLongRest.attributes.hp.current, 40);
    assert.equal(afterLongRest.attributes.hp.temp, 0);
    assert.equal(afterLongRest.attributes.hitDiceCurrent, 4); // 1 + floor(6 / 2) = 4
    assert.equal(afterLongRest.attributes.exhaustion, 1);
    assert.equal(afterLongRest.attributes.deathSaves.successes, 0);
    assert.equal(afterLongRest.attributes.deathSaves.failures, 0);
    assert.equal(afterLongRest.resources?.lay_on_hands.current, 30);
    assert.equal(afterLongRest.resources?.channel_divinity.current, 1);
    assert.equal(afterLongRest.spellSlots?.level1?.current, 4);
    assert.equal(afterLongRest.spellSlots?.level2?.current, 2);
  });

  it("T-DND-14: decrements condition durations according to turn triggers (TURNS_START, TURNS_END, ROUNDS)", () => {
    const conditions = [
      {
        id: "stunned",
        name: "Stunned",
        durationRounds: 1,
        appliedTurnActorId: "actor-a",
        trigger: "TURNS_START" as const,
      },
      {
        id: "frightened",
        name: "Frightened",
        durationRounds: 2,
        appliedTurnActorId: "actor-b",
        trigger: "TURNS_START" as const,
      },
      {
        id: "shield",
        name: "Shield",
        durationRounds: 1,
        appliedTurnActorId: "actor-a",
        trigger: "TURNS_END" as const,
      },
      {
        id: "bless",
        name: "Bless",
        durationRounds: 10,
        trigger: "ROUNDS" as const,
      },
    ];

    // Ticking TURNS_START for actor-a: stunned decrements to 0 and is removed; frightened stays 2
    const afterTurnA = decrementConditionDurations(conditions, "TURNS_START", "actor-a");
    assert.equal(afterTurnA.length, 3);
    assert.equal(afterTurnA.some((c) => c.id === "stunned"), false);
    assert.equal(afterTurnA.find((c) => c.id === "frightened")?.durationRounds, 2);
    assert.equal(afterTurnA.find((c) => c.id === "shield")?.durationRounds, 1);

    // Ticking TURNS_END for actor-a: shield decrements to 0
    const afterTurnEnd = decrementConditionDurations(afterTurnA, "TURNS_END", "actor-a");
    assert.equal(afterTurnEnd.some((c) => c.id === "shield"), false);

    // Ticking ROUNDS: bless decrements from 10 to 9
    const afterRound = decrementConditionDurations(afterTurnEnd, "ROUNDS");
    assert.equal(afterRound.find((c) => c.id === "bless")?.durationRounds, 9);
  });

  it("T-DND-15: validates progression tables from level 1 to 20 and applyLevelUp rules", () => {
    // Proficiency bonus table checks
    const pbCases = [
      { level: 1, pb: 2 },
      { level: 4, pb: 2 },
      { level: 5, pb: 3 },
      { level: 8, pb: 3 },
      { level: 9, pb: 4 },
      { level: 12, pb: 4 },
      { level: 13, pb: 5 },
      { level: 16, pb: 5 },
      { level: 17, pb: 6 },
      { level: 20, pb: 6 },
    ];
    for (const c of pbCases) {
      assert.equal(calculateProficiencyBonus(c.level), c.pb);
    }

    // Progression matrices structure
    assert.deepEqual(FULL_CASTER_SPELL_SLOTS[1], [2, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(FULL_CASTER_SPELL_SLOTS[5], [4, 3, 2, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(FULL_CASTER_SPELL_SLOTS[20], [4, 3, 3, 3, 3, 2, 2, 1, 1]);

    assert.deepEqual(HALF_CASTER_SPELL_SLOTS[1], [0, 0, 0, 0, 0]);
    assert.deepEqual(HALF_CASTER_SPELL_SLOTS[5], [4, 2, 0, 0, 0]);
    assert.deepEqual(HALF_CASTER_SPELL_SLOTS[20], [4, 3, 3, 3, 2]);

    assert.deepEqual(PACT_MAGIC_SPELL_SLOTS[1], { slots: 1, slotLevel: 1 });
    assert.deepEqual(PACT_MAGIC_SPELL_SLOTS[5], { slots: 2, slotLevel: 3 });
    assert.deepEqual(PACT_MAGIC_SPELL_SLOTS[11], { slots: 3, slotLevel: 5 });
    assert.deepEqual(PACT_MAGIC_SPELL_SLOTS[17], { slots: 4, slotLevel: 5 });

    // Level-up execution with fixed HP
    const wizard = createDefaultActorData("wiz-1", "Mage");
    wizard.attributes.level = 4;
    wizard.attributes.hitDieSize = 6;
    wizard.abilities.con.score = 12; // conMod +1
    wizard.attributes.hp.max = 22;
    wizard.attributes.hp.current = 22;

    const leveledWizard = applyLevelUp(wizard, {
      hpIncreaseMode: "fixed",
      casterType: "full",
    });
    assert.equal(leveledWizard.attributes.level, 5);
    // HP gain = floor(6 / 2) + 1 + 1 = 5
    assert.equal(leveledWizard.attributes.hp.max, 27);
    assert.equal(leveledWizard.attributes.hp.current, 27);
    assert.equal(leveledWizard.attributes.hitDiceMax, 2);
    assert.equal(leveledWizard.spellSlots?.level3?.max, 2);

    // Leveling up past 20 throws
    leveledWizard.attributes.level = 20;
    assert.throws(() => applyLevelUp(leveledWizard, { hpIncreaseMode: "fixed" }), /level 20/);
  });

  it("T-DND-16: executes 3-tier CompendiumResolver cascade with CAMPAIGN_HOMEBREW priority and search", () => {
    const srdEntries: CompendiumEntry[] = [
      {
        id: "spell-fireball-srd",
        slug: "fireball",
        name: "Fireball",
        entityType: "spell",
        tier: "SYSTEM_SRD",
        data: { damageDice: "8d6", damageType: "fire" },
      },
      {
        id: "spell-cure-wounds-srd",
        slug: "cure-wounds",
        name: "Cure Wounds",
        entityType: "spell",
        tier: "SYSTEM_SRD",
        data: { healDice: "1d8" },
      },
    ];

    const instanceEntries: CompendiumEntry[] = [
      {
        id: "item-flame-tongue-lib",
        slug: "flame-tongue",
        name: "Flame Tongue",
        entityType: "item",
        tier: "INSTANCE_LIBRARY",
        data: { rarity: "rare" },
      },
    ];

    const homebrewEntries: CompendiumEntry[] = [
      {
        id: "spell-fireball-hb",
        slug: "fireball",
        name: "Fireball (Campaign Custom)",
        entityType: "spell",
        tier: "CAMPAIGN_HOMEBREW",
        data: { damageDice: "10d6", damageType: "fire" },
      },
    ];

    const resolver = new CompendiumResolver(srdEntries, instanceEntries, homebrewEntries);

    // Campaign Homebrew overrides System SRD by slug
    const resolvedFireball = resolver.get("fireball");
    assert.equal(resolvedFireball?.id, "spell-fireball-hb");
    assert.equal(resolvedFireball?.name, "Fireball (Campaign Custom)");
    assert.equal(resolvedFireball?.tier, "CAMPAIGN_HOMEBREW");

    // Library and non-overridden SRD lookups work
    assert.equal(resolver.get("flame-tongue")?.tier, "INSTANCE_LIBRARY");
    assert.equal(resolver.get("cure-wounds")?.tier, "SYSTEM_SRD");

    // List query filtering and deduplication
    const allSpells = resolver.list({ entityType: "spell" });
    assert.equal(allSpells.length, 2);
    assert.ok(allSpells.some((s) => s.id === "spell-fireball-hb"));
    assert.ok(allSpells.every((s) => s.id !== "spell-fireball-srd"));

    const searchResults = resolver.list({ searchTerm: "flame" });
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0].slug, "flame-tongue");
  });

  it("T-DND-17: provides verbatim SRD 5.1 CC-BY-4.0 attribution notice", () => {
    const resolver = new CompendiumResolver([]);
    const notice = resolver.getAttribution();

    assert.equal(notice, SRD_51_ATTRIBUTION);
    assert.ok(notice.includes("System Reference Document 5.1"));
    assert.ok(notice.includes("Wizards of the Coast LLC"));
    assert.ok(notice.includes("Creative Commons Attribution 4.0 International License"));
    assert.ok(notice.includes("https://creativecommons.org/licenses/by/4.0/legalcode"));
  });
});
