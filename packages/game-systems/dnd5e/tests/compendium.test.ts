import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  CompendiumResolver,
  SRD_521_ATTRIBUTION,
  SYSTEM_SRD,
  SystemSRD,
  getFeats,
  getSpellsByLevel,
  getSubclasses,
  type CompendiumEntry,
} from "../src/index.ts";

describe("[Ticket #84] D&D 5e SystemSRD Compendium Specification Suite", () => {
  describe("AC1 & AC2: Containers (Backpack & Bag of Holding)", () => {
    it("WHEN CompendiumResolver.get receives 'srd:item:backpack', CompendiumResolver returns an item entry with weight 5, capacity 30, and contentWeightMultiplier 1.", () => {
      const resolver = new CompendiumResolver();
      const backpack = resolver.get("srd:item:backpack");

      assert.ok(backpack, "Backpack entry must exist in compendium");
      assert.equal(backpack?.name, "Backpack");
      assert.equal(backpack?.weight, 5);
      assert.equal(backpack?.capacity, 30);
      assert.equal(backpack?.contentWeightMultiplier, 1);
      assert.equal(backpack?.data.weight, 5);
      assert.equal(backpack?.data.capacity, 30);
      assert.equal(backpack?.data.contentWeightMultiplier, 1);
      assert.equal(backpack?.tier, "SYSTEM_SRD");
    });

    it("WHEN CompendiumResolver.get receives 'srd:item:bag_of_holding', CompendiumResolver returns a container entry with weight 5, capacity 500, and contentWeightMultiplier 0.", () => {
      const bag = CompendiumResolver.get("srd:item:bag_of_holding");

      assert.ok(bag, "Bag of Holding entry must exist in compendium");
      assert.equal(bag?.name, "Bag of Holding");
      assert.equal(bag?.weight, 5);
      assert.equal(bag?.capacity, 500);
      assert.equal(bag?.contentWeightMultiplier, 0);
      assert.equal(bag?.data.weight, 5);
      assert.equal(bag?.data.capacity, 500);
      assert.equal(bag?.data.contentWeightMultiplier, 0);
      assert.equal(bag?.data.isContainer, true);
      assert.equal(bag?.tier, "SYSTEM_SRD");
    });
  });

  describe("AC3: Weapons with Bilingual Metadata (en & fr)", () => {
    it("WHEN CompendiumResolver.list is queried for entityType 'weapon', CompendiumResolver returns Dagger, Longsword, Greatsword, Shortbow, Longbow, and Light Crossbow with bilingual metadata in en and fr.", () => {
      const resolver = new CompendiumResolver();
      const weapons = resolver.list({ entityType: "weapon" });

      const requiredWeapons: [string, string][] = [
        ["Dagger", "nick"],
        ["Longsword", "sap"],
        ["Greatsword", "graze"],
        ["Shortbow", "vex"],
        ["Longbow", "slow"],
        ["Light Crossbow", "slow"],
      ];

      for (const [weaponName, mastery] of requiredWeapons) {
        const entry = weapons.find((w) => w.name === weaponName);
        assert.equal(entry?.data.mastery, mastery, `Weapon '${weaponName}' must carry its SRD 5.2.1 mastery`);
        assert.ok(entry, `Weapon '${weaponName}' must be present in query results`);
        assert.ok(entry?.i18n, `Weapon '${weaponName}' must contain bilingual i18n object`);
        assert.ok(entry?.i18n?.en?.name, `Weapon '${weaponName}' must have en.name`);
        assert.ok(entry?.i18n?.en?.description, `Weapon '${weaponName}' must have en.description`);
        assert.ok(entry?.i18n?.fr?.name, `Weapon '${weaponName}' must have fr.name`);
        assert.ok(entry?.i18n?.fr?.description, `Weapon '${weaponName}' must have fr.description`);
      }
    });
  });

  describe("AC4: Armor with Bilingual Metadata (en & fr)", () => {
    it("WHEN CompendiumResolver.list is queried for entityType 'armor', CompendiumResolver returns Leather Armor, Scale Mail, Chain Mail, Plate Armor, and Shield with bilingual metadata in en and fr.", () => {
      const resolver = new CompendiumResolver();
      const armors = resolver.list({ entityType: "armor" });

      const requiredArmorNames = [
        "Leather Armor",
        "Scale Mail",
        "Chain Mail",
        "Plate Armor",
        "Shield",
      ];

      for (const armorName of requiredArmorNames) {
        const entry = armors.find((a) => a.name === armorName);
        assert.ok(entry, `Armor '${armorName}' must be present in query results`);
        assert.ok(entry?.i18n, `Armor '${armorName}' must contain bilingual i18n object`);
        assert.ok(entry?.i18n?.en?.name, `Armor '${armorName}' must have en.name`);
        assert.ok(entry?.i18n?.en?.description, `Armor '${armorName}' must have en.description`);
        assert.ok(entry?.i18n?.fr?.name, `Armor '${armorName}' must have fr.name`);
        assert.ok(entry?.i18n?.fr?.description, `Armor '${armorName}' must have fr.description`);
      }
    });
  });

  describe("AC5: Spells from Level 0 to 5", () => {
    it("WHEN CompendiumResolver.list is queried for entityType 'spell', CompendiumResolver returns iconic spells from level 0 to 5 including Fire Bolt, Magic Missile, Hold Person, Fireball, Polymorph, and Cone of Cold.", () => {
      const resolver = new CompendiumResolver();
      const spells = resolver.list({ entityType: "spell" });

      const requiredSpells = [
        { name: "Fire Bolt", expectedLevel: 0 },
        { name: "Magic Missile", expectedLevel: 1 },
        { name: "Hold Person", expectedLevel: 2 },
        { name: "Fireball", expectedLevel: 3 },
        { name: "Polymorph", expectedLevel: 4 },
        { name: "Cone of Cold", expectedLevel: 5 },
      ];

      for (const target of requiredSpells) {
        const spell = spells.find((s) => s.name === target.name);
        assert.ok(spell, `Spell '${target.name}' must be present in compendium`);
        assert.equal(spell?.data.level, target.expectedLevel, `Spell '${target.name}' must have level ${target.expectedLevel}`);
        assert.ok(spell?.i18n?.en?.name, `Spell '${target.name}' must have English name`);
        assert.ok(spell?.i18n?.fr?.name, `Spell '${target.name}' must have French name`);
      }
    });
  });

  describe("AC6: Feats with Bilingual Metadata (en & fr)", () => {
    const srdFeats = [
      "Alert", "Magic Initiate", "Savage Attacker", "Skilled",
      "Ability Score Improvement", "Grappler",
      "Archery", "Defense", "Great Weapon Fighting", "Two-Weapon Fighting",
      "Boon of Combat Prowess", "Boon of Dimensional Travel", "Boon of Fate",
      "Boon of Irresistible Offense", "Boon of Spell Recall", "Boon of the Night Spirit", "Boon of Truesight",
    ];
    const feats = new CompendiumResolver().list({ entityType: "feat" });

    it("srd-521-feat-catalog-has-exactly-17-feats", () => {
      assert.deepEqual(feats.map((f) => f.name).sort(), [...srdFeats].sort());
    });

    for (const featName of srdFeats) {
      it(`srd-521-feat-${featName}-has-bilingual-metadata`, () => {
        const entry = feats.find((f) => f.name === featName);
        assert.ok(entry?.i18n?.en?.description, `Feat '${featName}' must have en.description`);
        assert.ok(entry?.i18n?.fr?.name, `Feat '${featName}' must have fr.name`);
        assert.ok(entry?.i18n?.fr?.description, `Feat '${featName}' must have fr.description`);
      });
    }

    for (const removed of ["Sharpshooter", "Great Weapon Master", "Tough", "Sentinel", "Dual Wielder", "War Caster"]) {
      it(`non-srd-521-feat-${removed}-is-absent`, () => {
        assert.equal(feats.some((f) => f.name === removed), false);
      });
    }
  });

  describe("AC7: 1-Click GM Monster Templates", () => {
    it("WHEN CompendiumResolver.list is queried for entityType 'monster', CompendiumResolver returns ready-to-use monster templates for Goblin Warrior, Bandit, Guard, Skeleton, Wolf, Ogre, and Adult Red Dragon.", () => {
      const resolver = new CompendiumResolver();
      const monsters = resolver.list({ entityType: "monster" });

      const requiredMonsters = [
        { name: "Goblin Warrior", minHp: 10, expectedAc: 15 },
        { name: "Bandit", minHp: 8, expectedAc: 12 },
        { name: "Guard", minHp: 8, expectedAc: 16 },
        { name: "Skeleton", minHp: 13, expectedAc: 14 },
        { name: "Wolf", minHp: 11, expectedAc: 12 },
        { name: "Ogre", minHp: 40, expectedAc: 11 },
        { name: "Adult Red Dragon", minHp: 200, expectedAc: 19 },
      ];

      for (const target of requiredMonsters) {
        const monster = monsters.find((m) => m.name === target.name);
        assert.ok(monster, `Monster '${target.name}' must be present in compendium`);
        assert.ok(Number(monster?.data.hpMax) >= target.minHp, `Monster '${target.name}' hpMax must be >= ${target.minHp}`);
        assert.equal(monster?.data.armorBaseAc, target.expectedAc, `Monster '${target.name}' armorBaseAc must match`);
        assert.ok(monster?.data.abilities, `Monster '${target.name}' must include ability scores`);
        assert.ok(monster?.i18n?.en?.name, `Monster '${target.name}' must include English display name`);
        assert.ok(monster?.i18n?.fr?.name, `Monster '${target.name}' must include French display name`);
      }
    });
  });

  describe("AC8: Verbatim SRD 5.2.1 CC-BY-4.0 Notice", () => {
    it("WHEN getAttribution is invoked on CompendiumResolver, CompendiumResolver returns the SRD 5.2.1 CC-BY-4.0 notice (with the SRD 5.1 gap-fill credit).", () => {
      const resolver = new CompendiumResolver();
      const instanceNotice = resolver.getAttribution();
      const staticNotice = CompendiumResolver.getAttribution();

      assert.equal(instanceNotice, SRD_521_ATTRIBUTION);
      assert.equal(staticNotice, SRD_521_ATTRIBUTION);
      assert.ok(staticNotice.includes("Creative Commons Attribution 4.0 International License"));
      assert.ok(staticNotice.startsWith('This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1")'));
    });
  });

  describe("Helper Queries (getSubclasses, getFeats, getSpellsByLevel)", () => {
    it("WHEN getSubclasses is queried with or without classId, getSubclasses returns matching archetype entries.", () => {
      const resolver = new CompendiumResolver();

      const allSubclasses = resolver.getSubclasses();
      assert.ok(allSubclasses.length >= 12, "Must provide SRD subclasses for all core classes");

      const wizardSubclasses = resolver.getSubclasses("wizard");
      assert.equal(wizardSubclasses.length, 1);
      assert.equal(wizardSubclasses[0].name, "Evoker");

      const clericSubclasses = getSubclasses("srd:class:cleric");
      assert.equal(clericSubclasses.length, 1);
      assert.equal(clericSubclasses[0].name, "Life Domain");
    });

    it("WHEN getFeats is invoked, getFeats returns the 17 SRD 5.2.1 feats.", () => {
      const resolver = new CompendiumResolver();
      const featsFromInstance = resolver.getFeats();
      const featsFromHelper = getFeats();

      assert.equal(featsFromInstance.length, featsFromHelper.length);
      assert.equal(featsFromHelper.length, 17);
      assert.ok(featsFromHelper.some((f) => f.slug === "srd:feat:alert"));
      assert.ok(featsFromHelper.some((f) => f.slug === "srd:feat:grappler"));
    });

    it("WHEN getSpellsByLevel is invoked, getSpellsByLevel filters spells by circle and optional class identifier.", () => {
      const cantrips = getSpellsByLevel(0);
      assert.ok(cantrips.some((s) => s.name === "Fire Bolt"));
      assert.ok(cantrips.every((s) => s.data.level === 0));

      const level3Spells = getSpellsByLevel(3);
      assert.ok(level3Spells.some((s) => s.name === "Fireball"));
      assert.ok(level3Spells.every((s) => s.data.level === 3));

      const wizardLvl3 = getSpellsByLevel(3, "wizard");
      assert.ok(wizardLvl3.some((s) => s.name === "Fireball"));
    });
  });

  describe("Aliases and Canonical Slugs", () => {
    it("verifies SystemSRD alias exports SYSTEM_SRD and universal slugs can be resolved by short or full slug.", () => {
      assert.equal(SystemSRD, SYSTEM_SRD);

      const resolver = new CompendiumResolver();
      const byFullSlug = resolver.get("srd:item:bag_of_holding");
      const byShortSlug = resolver.get("bag_of_holding");

      assert.ok(byFullSlug);
      assert.equal(byFullSlug?.id, byShortSlug?.id);
    });
  });
});
