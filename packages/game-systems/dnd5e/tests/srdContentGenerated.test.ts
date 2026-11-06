import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import "../src/node.ts";
import {
  CompendiumResolver,
  SRD_521_ATTRIBUTION,
  SYSTEM_SRD,
  createFullSrdResolver,
  loadFullSystemSrd,
  loadSrdPacks,
  type CompendiumEntry,
  type MonsterStatBlock,
  type SrdPacks,
} from "../src/index.ts";
import { buildSrdPacks, halvesDamageOnSave, serializePack, type Open5eSnapshot } from "../scripts/open5eTransform.ts";
import { validateAgainstSchema } from "./support/jsonSchemaSubset.ts";

const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

const SCHEMAS = {
  monster: readJson("../schemas/monster-stat-block.schema.json") as Record<string, unknown>,
  spell: readJson("../schemas/spell.schema.json") as Record<string, unknown>,
  magicItem: readJson("../schemas/magic-item.schema.json") as Record<string, unknown>,
};

const packs: SrdPacks = await loadSrdPacks();
const byId = new Map([...packs.spells, ...packs.monsters, ...packs.magicItems].map((e) => [e.id, e]));
const statBlockOf = (id: string): MonsterStatBlock => byId.get(id)?.data.statBlock as MonsterStatBlock;

describe("Generated SRD 5.2.1 packs (GS7, GS8, GS9, D8)", () => {
  describe("counts stay within the SRD 5.2.1 ranges", () => {
    const cases: { id: string; pack: keyof SrdPacks; min: number; max: number }[] = [
      { id: "spells-339", pack: "spells", min: 339, max: 339 },
      { id: "monsters-about-330", pack: "monsters", min: 320, max: 340 },
      { id: "magic-items-core-set", pack: "magicItems", min: 200, max: 300 },
    ];
    for (const { id, pack, min, max } of cases) {
      it(`[${id}] ${pack} holds between ${min} and ${max} entries`, () => {
        const count = packs[pack].length;
        assert.ok(count >= min && count <= max, `${pack}: ${count}`);
      });
    }
  });

  describe("every entry validates against its JSON Schema", () => {
    const cases: { id: string; entries: CompendiumEntry[]; schema: Record<string, unknown>; payload: (e: CompendiumEntry) => unknown }[] = [
      { id: "monster-stat-blocks", entries: packs.monsters, schema: SCHEMAS.monster, payload: (e) => e.data.statBlock },
      { id: "spell-data", entries: packs.spells, schema: SCHEMAS.spell, payload: (e) => e.data },
      { id: "magic-item-data", entries: packs.magicItems, schema: SCHEMAS.magicItem, payload: (e) => e.data },
    ];
    for (const { id, entries, schema, payload } of cases) {
      it(`[${id}] no entry reports a schema error`, () => {
        const failures = entries.flatMap((entry) =>
          validateAgainstSchema(schema, payload(entry)).map((error) => `${entry.id}: ${error}`)
        );
        assert.deepEqual(failures.slice(0, 10), []);
      });
    }
  });

  describe("ids are unique, prefixed and stable", () => {
    const cases: { id: string; pack: keyof SrdPacks; prefix: string; entityType: string }[] = [
      { id: "spell-ids", pack: "spells", prefix: "srd:spell:", entityType: "spell" },
      { id: "monster-ids", pack: "monsters", prefix: "srd:monster:", entityType: "monster" },
      { id: "magic-item-ids", pack: "magicItems", prefix: "srd:item:", entityType: "item" },
    ];
    for (const { id, pack, prefix, entityType } of cases) {
      it(`[${id}] ids are unique, sorted, '${prefix}' prefixed, equal to the slug, and typed '${entityType}'`, () => {
        const ids = packs[pack].map((e) => e.id);
        assert.equal(new Set(ids).size, ids.length);
        assert.deepEqual(ids, [...ids].sort());
        for (const entry of packs[pack]) {
          assert.match(entry.id, new RegExp(`^${prefix}[a-z0-9_]+$`));
          assert.equal(entry.slug, entry.id);
          assert.equal(entry.entityType, entityType);
          assert.equal(entry.tier, "SYSTEM_SRD");
        }
      });
    }

    it("[ids-unique-across-packs] no id appears in two packs", () => {
      const total = packs.spells.length + packs.monsters.length + packs.magicItems.length;
      assert.equal(byId.size, total);
    });

    const curated = SYSTEM_SRD.filter(
      (e) => (e.entityType === "spell" || e.entityType === "monster") && e.data.source !== "srd-5.1"
    );
    for (const entry of curated) {
      it(`[stable-${entry.id}] curated ${entry.entityType} keeps its id in the generated pack`, () => {
        assert.equal(byId.get(entry.id)?.entityType, entry.entityType);
      });
    }
    const curatedItemIds = SYSTEM_SRD.filter((e) => e.entityType === "item" && e.data.magic === true).map((e) => e.id);
    for (const id of curatedItemIds) {
      it(`[stable-${id}] curated magic item keeps its id in the generated pack`, () => {
        assert.equal(byId.get(id)?.entityType, "item");
      });
    }
  });

  describe("spot checks against SRD 5.2.1", () => {
    it("[goblin-warrior] keeps the curated id, CR 1/4, AC 15, HP 10 (3d6), scimitar with an advantage rider", () => {
      const goblin = statBlockOf("srd:monster:goblin");
      assert.equal(goblin.name, "Goblin Warrior");
      assert.equal(goblin.challengeRating, 0.25);
      assert.equal(goblin.xp, 50);
      assert.deepEqual(goblin.armorClass, { value: 15 });
      assert.deepEqual(goblin.hitPoints, { average: 10, formula: "3d6" });
      assert.equal(goblin.senses.darkvision, 60);
      const scimitar = goblin.actions.find((a) => a.id === "scimitar");
      assert.equal(scimitar?.automation, "full");
      assert.deepEqual(scimitar?.attack, { kind: "melee", toHit: 4, reachFt: 5 });
      assert.deepEqual(scimitar?.riders?.[0]?.damage, { dice: "1d4", average: 2, type: "slashing" });
      assert.equal(goblin.bonusActions?.[0]?.name, "Nimble Escape");
    });

    it("[adult-red-dragon-legendary] 3 legendary actions (4 in lair): Commanding Presence, Fiery Rays, Pounce", () => {
      const dragon = statBlockOf("srd:monster:adult_red_dragon");
      assert.equal(dragon.challengeRating, 17);
      assert.equal(dragon.legendaryActions?.uses, 3);
      assert.equal(dragon.legendaryActions?.lairUses, 4);
      assert.deepEqual(
        dragon.legendaryActions?.options.map((o) => o.name),
        ["Commanding Presence", "Fiery Rays", "Pounce"]
      );
      assert.deepEqual(dragon.damageImmunities, ["fire"]);
      assert.equal(dragon.speed.fly, 80);
    });

    it("[adult-red-dragon-fire-breath] DEX save DC 21, 60-ft cone, 59 (17d6) fire, half on success, recharge 5-6", () => {
      const breath = statBlockOf("srd:monster:adult_red_dragon").actions.find((a) => a.id === "fire_breath");
      assert.equal(breath?.automation, "full");
      assert.deepEqual(breath?.save, {
        ability: "dex",
        dc: 21,
        area: { shape: "cone", sizeFt: 60 },
        onSuccess: "half",
      });
      assert.deepEqual(breath?.damage, [{ dice: "17d6", average: 59, type: "fire" }]);
      assert.deepEqual(breath?.usage, { kind: "recharge", minRoll: 5 });
    });

    it("[fireball] level 3 evocation, 8d6 fire, DEX save half, 20-ft sphere, not concentration", () => {
      const fireball = byId.get("srd:spell:fireball")?.data;
      assert.equal(fireball?.level, 3);
      assert.equal(fireball?.school, "evocation");
      assert.equal(fireball?.damageDice, "8d6");
      assert.equal(fireball?.damageType, "fire");
      assert.equal(fireball?.saveAbility, "dex");
      assert.equal(fireball?.halfDamageOnSave, true);
      assert.deepEqual(fireball?.area, { shape: "sphere", sizeFt: 20 });
      assert.equal(fireball?.concentration, false);
    });

    const halfOnSaveTextCases: { id: string; text: string; half: boolean }[] = [
      { id: "on-a-successful-one", text: "taking 8d6 Fire damage on a failed save or half as much damage on a successful one.", half: true },
      { id: "successful-save-takes-half", text: "On a successful save, a creature takes half as much damage only.", half: true },
      { id: "successful-save-heading", text: "*Successful Save:* Half as much damage.", half: true },
      { id: "success-negates", text: "On a failed save, the target takes 3d6 Psychic damage. On a successful save, nothing happens.", half: false },
    ];
    for (const { id, text, half } of halfOnSaveTextCases) {
      it(`[half-on-save-text-${id}] halvesDamageOnSave is ${half}`, () => {
        assert.equal(halvesDamageOnSave(text), half);
      });
    }

    const halfOnSaveSpellCases: { id: string; spell: string }[] = [
      { id: "thunderwave", spell: "srd:spell:thunderwave" },
      { id: "moonbeam", spell: "srd:spell:moonbeam" },
      { id: "spirit-guardians", spell: "srd:spell:spirit_guardians" },
      { id: "prismatic-spray", spell: "srd:spell:prismatic_spray" },
      { id: "burning-hands", spell: "srd:spell:burning_hands" },
    ];
    for (const { id, spell } of halfOnSaveSpellCases) {
      it(`[half-on-save-pack-${id}] ${spell} halves its damage on a successful save`, () => {
        assert.equal(byId.get(spell)?.data.halfDamageOnSave, true);
      });
    }

    const flagCases: { id: string; spell: string; concentration: boolean; ritual: boolean }[] = [
      { id: "bless-concentration", spell: "srd:spell:bless", concentration: true, ritual: false },
      { id: "detect-magic-ritual", spell: "srd:spell:detect_magic", concentration: true, ritual: true },
      { id: "fireball-instant", spell: "srd:spell:fireball", concentration: false, ritual: false },
    ];
    for (const { id, spell, concentration, ritual } of flagCases) {
      it(`[${id}] ${spell} has concentration=${concentration}, ritual=${ritual}`, () => {
        assert.equal(byId.get(spell)?.data.concentration, concentration);
        assert.equal(byId.get(spell)?.data.ritual, ritual);
      });
    }

    it("[mass-suggestion-warlock] Mass Suggestion is on the Bard, Sorcerer, Warlock and Wizard lists", () => {
      assert.deepEqual(byId.get("srd:spell:mass_suggestion")?.data.classes, ["bard", "sorcerer", "warlock", "wizard"]);
    });

    const attackTypeCases: { id: string; spell: string; attackType: "melee" | "ranged" | undefined }[] = [
      { id: "fire-bolt-ranged", spell: "srd:spell:fire_bolt", attackType: "ranged" },
      { id: "shocking-grasp-melee", spell: "srd:spell:shocking_grasp", attackType: "melee" },
      { id: "fireball-save-no-attack", spell: "srd:spell:fireball", attackType: undefined },
      { id: "magic-missile-auto-hit-no-attack", spell: "srd:spell:magic_missile", attackType: undefined },
    ];
    for (const { id, spell, attackType } of attackTypeCases) {
      it(`[attack-type-${id}] ${spell} has attackType ${attackType ?? "absent"}`, () => {
        const data = byId.get(spell)?.data;
        assert.ok(data);
        assert.equal(data.attackType, attackType);
        assert.equal("attackType" in data, attackType !== undefined);
      });
    }

    it("[wizard-level-1-spells] the Wizard list offers at least 7 level 1 spells", () => {
      const wizardLevel1 = packs.spells.filter(
        (e) => e.data.level === 1 && (e.data.classes as string[]).includes("wizard")
      );
      assert.ok(wizardLevel1.length >= 7, `${wizardLevel1.length}`);
    });

    const potionCases: { id: string; item: string; rarity: string; healDice: string }[] = [
      { id: "healing-common", item: "srd:item:potion_of_healing", rarity: "common", healDice: "2d4 + 2" },
      { id: "healing-greater", item: "srd:item:potion_of_healing_greater", rarity: "uncommon", healDice: "4d4 + 4" },
      { id: "healing-superior", item: "srd:item:potion_of_healing_superior", rarity: "rare", healDice: "8d4 + 8" },
      { id: "healing-supreme", item: "srd:item:potion_of_healing_supreme", rarity: "very_rare", healDice: "10d4 + 20" },
    ];
    for (const { id, item, rarity, healDice } of potionCases) {
      it(`[potion-${id}] ${item} is ${rarity}, heals ${healDice}, no attunement`, () => {
        const data = byId.get(item)?.data;
        assert.equal(data?.rarity, rarity);
        assert.equal(data?.healDice, healDice);
        assert.equal(data?.requiresAttunement, false);
      });
    }

    const attunementCases: { id: string; item: string; rarity: string; requiresAttunement: boolean }[] = [
      { id: "ioun-stone-varies-attuned", item: "srd:item:ioun_stone", rarity: "varies", requiresAttunement: true },
      { id: "bag-of-holding-uncommon", item: "srd:item:bag_of_holding", rarity: "uncommon", requiresAttunement: false },
      { id: "holy-avenger-legendary-attuned", item: "srd:item:holy_avenger", rarity: "legendary", requiresAttunement: true },
      { id: "spell-scroll-common", item: "srd:item:spell_scroll", rarity: "common", requiresAttunement: false },
    ];
    for (const { id, item, rarity, requiresAttunement } of attunementCases) {
      it(`[item-${id}] ${item} is ${rarity} with requiresAttunement=${requiresAttunement}`, () => {
        assert.equal(byId.get(item)?.data.rarity, rarity);
        assert.equal(byId.get(item)?.data.requiresAttunement, requiresAttunement);
      });
    }

    it("[automation-levels] every monster action carries an automation level and most are structured", () => {
      const levels = packs.monsters.flatMap((e) => {
        const block = e.data.statBlock as MonsterStatBlock;
        return [
          ...block.actions,
          ...block.bonusActions,
          ...block.reactions,
          ...(block.legendaryActions?.options ?? []),
        ].map((a) => a.automation);
      });
      assert.ok(levels.every((l) => l === "full" || l === "partial" || l === "text"));
      assert.ok(levels.filter((l) => l === "full").length > levels.length / 3);
    });

    it("[automation-text-has-no-structure] text-only actions carry no attack, save or damage", () => {
      const structuredText = packs.monsters.flatMap((e) => {
        const block = e.data.statBlock as MonsterStatBlock;
        return [...block.actions, ...block.bonusActions, ...block.reactions, ...(block.legendaryActions?.options ?? [])]
          .filter((a) => a.automation === "text" && (a.attack || a.save || a.damage))
          .map((a) => `${e.id}/${a.id}`);
      });
      assert.deepEqual(structuredText, []);
    });
  });

  describe("pack integrity and attribution metadata", () => {
    const manifest = readJson("../packs/manifest.json") as {
      license: string;
      srdVersion: string;
      attribution: string;
      source: { commit: string; inputs: { file: string; sha256: string }[] };
      counts: Record<keyof SrdPacks, number>;
      packs: { file: string; sha256: string }[];
    };

    it("[manifest-license] manifest declares SRD 5.2.1 under CC-BY-4.0", () => {
      assert.equal(manifest.srdVersion, "5.2.1");
      assert.equal(manifest.license, "CC-BY-4.0");
    });

    it("[manifest-source-pinned] manifest pins the Open5e commit and the sha256 of every input", () => {
      assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
      assert.equal(manifest.source.inputs.length, 7);
      for (const input of manifest.source.inputs) assert.match(input.sha256, /^[0-9a-f]{64}$/, input.file);
    });

    const attributionCases: { id: string; text: () => string }[] = [
      { id: "manifest-json", text: () => manifest.attribution },
      { id: "system-json", text: () => (readJson("../system.json") as { attribution: string }).attribution },
      { id: "resolver", text: () => CompendiumResolver.getAttribution() },
    ];
    for (const { id, text } of attributionCases) {
      it(`[attribution-${id}] carries the verbatim SRD 5.2.1 CC-BY-4.0 notice`, () => {
        assert.equal(text(), SRD_521_ATTRIBUTION);
        assert.ok(text().startsWith('This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC'));
        assert.ok(text().includes("https://creativecommons.org/licenses/by/4.0/legalcode"));
      });
    }

    it("[attribution-markdown] ATTRIBUTION.md quotes the notice verbatim", () => {
      const markdown = readFileSync(new URL("../ATTRIBUTION.md", import.meta.url), "utf8");
      assert.ok(markdown.includes(`> ${SRD_521_ATTRIBUTION}\n`));
    });

    it("[manifest-counts] manifest counts match the packs", () => {
      assert.deepEqual(manifest.counts, {
        spells: packs.spells.length,
        monsters: packs.monsters.length,
        magicItems: packs.magicItems.length,
      });
    });

    for (const file of ["spells.json", "monsters.json", "magic-items.json"]) {
      it(`[manifest-sha256-${file}] manifest digest matches the committed ${file}`, () => {
        const digest = createHash("sha256").update(readFileSync(new URL(`../packs/${file}`, import.meta.url))).digest("hex");
        assert.equal(manifest.packs.find((p) => p.file === file)?.sha256, digest);
      });
    }
  });

  describe("generator determinism on a pinned Open5e sample", () => {
    const sample = readJson("./fixtures/open5e-srd-2024-sample.json") as Open5eSnapshot;
    const first = buildSrdPacks(structuredClone(sample));
    const second = buildSrdPacks(structuredClone(sample));
    const packNames: (keyof SrdPacks)[] = ["spells", "monsters", "magicItems"];

    for (const pack of packNames) {
      it(`[determinism-${pack}] two runs serialize ${pack} byte for byte identically`, () => {
        assert.ok(first[pack].length > 0);
        assert.equal(serializePack(first[pack]), serializePack(second[pack]));
      });

      it(`[reproducible-${pack}] sample output equals the committed ${pack} entries`, () => {
        for (const entry of first[pack]) {
          assert.deepEqual(entry, byId.get(entry.id), entry.id);
        }
      });
    }
  });

  describe("merge with the curated catalog", () => {
    it("[merge-keeps-fr] the generated Goblin Warrior keeps its curated French name and generated stat block", async () => {
      const goblin = (await loadFullSystemSrd()).find((e) => e.id === "srd:monster:goblin");
      assert.equal(goblin?.i18n?.fr?.name, "Guerrier gobelin");
      assert.equal((goblin?.data.statBlock as MonsterStatBlock).challengeRating, 0.25);
    });

    it("[merge-keeps-fr-potion] Potion of Healing keeps its French name and curated cost with the generated heal dice", async () => {
      const potion = (await loadFullSystemSrd()).find((e) => e.id === "srd:item:potion_of_healing");
      assert.equal(potion?.i18n?.fr?.name, "Potion de soins");
      assert.equal(potion?.data.cost, "50 gp");
      assert.equal(potion?.data.healDice, "2d4 + 2");
    });

    it("[merge-keeps-curated-only-keys] Bag of Holding keeps its curated container capacity", async () => {
      const bag = (await loadFullSystemSrd()).find((e) => e.id === "srd:item:bag_of_holding");
      assert.equal(bag?.data.capacity, 500);
      assert.equal(bag?.data.rarity, "uncommon");
    });

    it("[merge-no-duplicates] every curated id resolves exactly once", async () => {
      const ids = (await loadFullSystemSrd()).map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length);
      for (const entry of SYSTEM_SRD) assert.ok(ids.includes(entry.id), entry.id);
    });

    it("[full-resolver-tiers] homebrew still shadows the full SRD", async () => {
      const homebrew: CompendiumEntry = {
        id: "srd:spell:fireball",
        slug: "srd:spell:fireball",
        name: "Homebrew Fireball",
        entityType: "spell",
        tier: "CAMPAIGN_HOMEBREW",
        data: {},
      };
      const resolver = await createFullSrdResolver([], [homebrew]);
      assert.equal(resolver.get("srd:spell:fireball")?.name, "Homebrew Fireball");
      assert.equal(resolver.get("srd:spell:mass_suggestion")?.name, "Mass Suggestion");
    });
  });
});
