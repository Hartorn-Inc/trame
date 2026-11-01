/**
 * ============================================================================
 * CURATED BILINGUAL SRD 5.1 CONTENT (srdContent.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Declares the curated SystemSRD catalog that lets a table run a campaign
 * without homebrew: the 12 classes, 9 species, 6 backgrounds, 15 conditions,
 * spells from cantrips to 9th level, weapons, armor, adventuring gear, and
 * monsters from CR 0 to CR 20. `compendium.ts` merges these entries with its
 * hand-written starter entries into `SYSTEM_SRD`.
 *
 * Open Game Content Attribution:
 * This work includes material taken from the System Reference Document 5.1
 * ("SRD 5.1") by Wizards of the Coast LLC, licensed under CC-BY-4.0.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `English Canonical, French Metadata`:
 *      - `name`, `data` and `i18n.en` are English; French appears only in
 *        `i18n.fr` (grill decision G3). Descriptions are short paraphrases.
 *   2. `Stable Namespaced Ids`:
 *      - Every id is `srd:<kind>:<snake_key>` and doubles as the slug, so
 *        campaign homebrew can shadow it through `CompendiumResolver`.
 *   3. `Class Spell Coverage`:
 *      - Each caster class has at least one spell at every spell level it can
 *        cast (slots plus Warlock Mystic Arcanum), so level-up never offers an
 *        empty spell list.
 *   4. `Monster Sheets Are Derivable`:
 *      - Monsters use `armorKind: "natural"` with the stat-block AC, and a
 *        proficiency-equivalent `level` derived from CR, so
 *        `computeDnd5eSheetDerived` reproduces the stat block.
 *   5. `Backgrounds`:
 *      - SRD 5.1 ships one background (Acolyte). The other five are built
 *        with the SRD 5.1 "Customizing a Background" rule (two skills, two
 *        tools or languages, starting equipment) and carry no feature text.
 * ============================================================================
 */

import type { CompendiumEntityType, CompendiumEntry } from "./compendium.ts";
import { SRD_CLASS_PROGRESSION, type SrdClassId } from "./progression.ts";
import type { AbilityId, DamageType, SkillId } from "./types.ts";

/** English and French `[name, description]` pairs for one entry. */
interface Bilingual {
  en: [string, string];
  fr: [string, string];
}

function srdEntry(
  entityType: CompendiumEntityType,
  idKind: string,
  key: string,
  data: Record<string, unknown>,
  text: Bilingual
): CompendiumEntry {
  const id = `srd:${idKind}:${key}`;
  return {
    id,
    slug: id,
    name: text.en[0],
    entityType,
    tier: "SYSTEM_SRD",
    data,
    i18n: {
      en: { name: text.en[0], description: text.en[1] },
      fr: { name: text.fr[0], description: text.fr[1] },
    },
    ...(typeof data.weight === "number" ? { weight: data.weight } : {}),
  };
}

// ============================================================================
// CLASSES
// ============================================================================

const CLASS_TEXT: Record<SrdClassId, Bilingual> = {
  barbarian: {
    en: ["Barbarian", "A fierce warrior who channels primal rage to shrug off blows and hit harder."],
    fr: ["Barbare", "Un guerrier farouche qui canalise une rage primitive pour encaisser les coups et frapper plus fort."],
  },
  bard: {
    en: ["Bard", "A versatile performer whose music and words weave magic and inspire allies."],
    fr: ["Barde", "Un artiste polyvalent dont la musique et les mots tissent la magie et inspirent ses alliés."],
  },
  cleric: {
    en: ["Cleric", "A priestly champion who wields divine magic in service of a deity."],
    fr: ["Clerc", "Un champion sacerdotal qui manie la magie divine au service d'une divinité."],
  },
  druid: {
    en: ["Druid", "A priest of the Old Faith who wields the powers of nature and takes animal shapes."],
    fr: ["Druide", "Un prêtre de l'Ancienne Foi qui manie les forces de la nature et adopte des formes animales."],
  },
  fighter: {
    en: ["Fighter", "A master of martial combat, skilled with every weapon and armor."],
    fr: ["Guerrier", "Un maître du combat martial, habile avec toutes les armes et armures."],
  },
  monk: {
    en: ["Monk", "A master of martial arts who harnesses ki to perform extraordinary feats."],
    fr: ["Moine", "Un maître des arts martiaux qui canalise le ki pour accomplir des prouesses extraordinaires."],
  },
  paladin: {
    en: ["Paladin", "A holy warrior bound to a sacred oath, smiting foes with divine power."],
    fr: ["Paladin", "Un guerrier saint lié par un serment sacré, qui châtie ses ennemis par la puissance divine."],
  },
  ranger: {
    en: ["Ranger", "A warrior of the wilds who hunts the monsters threatening civilization."],
    fr: ["Rôdeur", "Un guerrier des terres sauvages qui traque les monstres menaçant la civilisation."],
  },
  rogue: {
    en: ["Rogue", "A scoundrel who relies on stealth, precision and cunning."],
    fr: ["Roublard", "Un vaurien qui compte sur la discrétion, la précision et la ruse."],
  },
  sorcerer: {
    en: ["Sorcerer", "A spellcaster whose magic flows from an innate gift or bloodline."],
    fr: ["Ensorceleur", "Un lanceur de sorts dont la magie provient d'un don inné ou d'une lignée."],
  },
  warlock: {
    en: ["Warlock", "A wielder of magic granted by a pact with an otherworldly patron."],
    fr: ["Occultiste", "Un manieur de magie obtenue par un pacte avec un protecteur d'outre-monde."],
  },
  wizard: {
    en: ["Wizard", "A scholarly magic-user who masters spells through study and a spellbook."],
    fr: ["Magicien", "Un érudit de la magie qui maîtrise les sorts par l'étude et un grimoire."],
  },
};

const CLASSES: CompendiumEntry[] = (Object.keys(SRD_CLASS_PROGRESSION) as SrdClassId[]).map((classId) =>
  srdEntry("class", "class", classId, { classId, ...SRD_CLASS_PROGRESSION[classId] }, CLASS_TEXT[classId])
);

// ============================================================================
// SPECIES
// ============================================================================

interface SpeciesData {
  abilityScoreIncrease: Partial<Record<AbilityId, number>>;
  /** Number of extra `+1` increases the player assigns freely. */
  choiceIncreases?: number;
  size: "Small" | "Medium";
  /** Walking speed in feet. */
  speedFt: number;
  /** Darkvision range in feet (`0` when none). */
  darkvisionFt: number;
  traits: string[];
  languages: string[];
}

function species(key: string, data: SpeciesData, text: Bilingual): CompendiumEntry {
  return srdEntry("species", "species", key, { ...data }, text);
}

const SPECIES: CompendiumEntry[] = [
  species(
    "hill_dwarf",
    {
      abilityScoreIncrease: { con: 2, wis: 1 },
      size: "Medium",
      speedFt: 25,
      darkvisionFt: 60,
      traits: ["Dwarven Resilience", "Dwarven Combat Training", "Tool Proficiency", "Stonecunning", "Dwarven Toughness"],
      languages: ["Common", "Dwarvish"],
    },
    {
      en: ["Hill Dwarf", "Bold and hardy dwarves with keen senses and remarkable resilience."],
      fr: ["Nain des collines", "Des nains hardis et robustes, aux sens aiguisés et d'une résistance remarquable."],
    }
  ),
  species(
    "high_elf",
    {
      abilityScoreIncrease: { dex: 2, int: 1 },
      size: "Medium",
      speedFt: 30,
      darkvisionFt: 60,
      traits: ["Keen Senses", "Fey Ancestry", "Trance", "Elf Weapon Training", "Cantrip", "Extra Language"],
      languages: ["Common", "Elvish"],
    },
    {
      en: ["High Elf", "Graceful elves with a keen mind and a mastery of at least a little magic."],
      fr: ["Haut-elfe", "Des elfes gracieux à l'esprit vif, qui maîtrisent au moins un peu de magie."],
    }
  ),
  species(
    "lightfoot_halfling",
    {
      abilityScoreIncrease: { dex: 2, cha: 1 },
      size: "Small",
      speedFt: 25,
      darkvisionFt: 0,
      traits: ["Lucky", "Brave", "Halfling Nimbleness", "Naturally Stealthy"],
      languages: ["Common", "Halfling"],
    },
    {
      en: ["Lightfoot Halfling", "Small, affable folk who easily hide and slip past danger."],
      fr: ["Halfelin pied-léger", "Un petit peuple affable qui se cache aisément et esquive le danger."],
    }
  ),
  species(
    "human",
    {
      abilityScoreIncrease: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
      size: "Medium",
      speedFt: 30,
      darkvisionFt: 0,
      traits: ["Extra Language"],
      languages: ["Common"],
    },
    {
      en: ["Human", "Ambitious and adaptable people found in every corner of the world."],
      fr: ["Humain", "Un peuple ambitieux et adaptable, présent dans tous les recoins du monde."],
    }
  ),
  species(
    "dragonborn",
    {
      abilityScoreIncrease: { str: 2, cha: 1 },
      size: "Medium",
      speedFt: 30,
      darkvisionFt: 0,
      traits: ["Draconic Ancestry", "Breath Weapon", "Damage Resistance"],
      languages: ["Common", "Draconic"],
    },
    {
      en: ["Dragonborn", "Proud dragon-blooded humanoids who breathe destructive energy."],
      fr: ["Drakéide", "De fiers humanoïdes au sang de dragon qui soufflent une énergie destructrice."],
    }
  ),
  species(
    "rock_gnome",
    {
      abilityScoreIncrease: { int: 2, con: 1 },
      size: "Small",
      speedFt: 25,
      darkvisionFt: 60,
      traits: ["Gnome Cunning", "Artificer's Lore", "Tinker"],
      languages: ["Common", "Gnomish"],
    },
    {
      en: ["Rock Gnome", "Inventive, curious gnomes with a knack for tinkering."],
      fr: ["Gnome des roches", "Des gnomes inventifs et curieux, doués pour le bricolage."],
    }
  ),
  species(
    "half_elf",
    {
      abilityScoreIncrease: { cha: 2 },
      choiceIncreases: 2,
      size: "Medium",
      speedFt: 30,
      darkvisionFt: 60,
      traits: ["Fey Ancestry", "Skill Versatility", "Extra Language"],
      languages: ["Common", "Elvish"],
    },
    {
      en: ["Half-Elf", "Charismatic wanderers who combine human drive with elven grace."],
      fr: ["Demi-elfe", "Des vagabonds charismatiques qui unissent l'ardeur humaine et la grâce elfique."],
    }
  ),
  species(
    "half_orc",
    {
      abilityScoreIncrease: { str: 2, con: 1 },
      size: "Medium",
      speedFt: 30,
      darkvisionFt: 60,
      traits: ["Menacing", "Relentless Endurance", "Savage Attacks"],
      languages: ["Common", "Orc"],
    },
    {
      en: ["Half-Orc", "Strong, enduring people who refuse to fall when struck down."],
      fr: ["Demi-orc", "Un peuple fort et endurant qui refuse de tomber lorsqu'il est terrassé."],
    }
  ),
  species(
    "tiefling",
    {
      abilityScoreIncrease: { int: 1, cha: 2 },
      size: "Medium",
      speedFt: 30,
      darkvisionFt: 60,
      traits: ["Hellish Resistance", "Infernal Legacy"],
      languages: ["Common", "Infernal"],
    },
    {
      en: ["Tiefling", "Descendants of an infernal bloodline who resist fire and wield innate magic."],
      fr: ["Tieffelin", "Descendants d'une lignée infernale qui résistent au feu et manient une magie innée."],
    }
  ),
];

// ============================================================================
// BACKGROUNDS
// ============================================================================

interface BackgroundData {
  skillProficiencies: [SkillId, SkillId];
  toolProficiencies: string[];
  /** Number of extra languages chosen by the player. */
  languages: number;
  equipment: string[];
  /** Background feature name; only the SRD Acolyte has one. */
  feature?: string;
  /** `"srd"` for SRD 5.1 text, `"srd-custom"` for the customization rule. */
  source: "srd" | "srd-custom";
}

function background(key: string, data: BackgroundData, text: Bilingual): CompendiumEntry {
  return srdEntry("background", "background", key, { ...data }, text);
}

const BACKGROUNDS: CompendiumEntry[] = [
  background(
    "acolyte",
    {
      skillProficiencies: ["insight", "religion"],
      toolProficiencies: [],
      languages: 2,
      equipment: ["Holy symbol", "Prayer book", "5 sticks of incense", "Vestments", "Common clothes", "15 gp"],
      feature: "Shelter of the Faithful",
      source: "srd",
    },
    {
      en: ["Acolyte", "You spent your life in service to a temple, acting as an intermediary with the divine."],
      fr: ["Acolyte", "Vous avez passé votre vie au service d'un temple, intermédiaire entre les fidèles et le divin."],
    }
  ),
  background(
    "criminal",
    {
      skillProficiencies: ["deception", "stealth"],
      toolProficiencies: ["Thieves' tools", "Gaming set"],
      languages: 0,
      equipment: ["Crowbar", "Dark common clothes with a hood", "15 gp"],
      source: "srd-custom",
    },
    {
      en: ["Criminal", "You lived outside the law, relying on lies and shadows."],
      fr: ["Criminel", "Vous avez vécu en marge de la loi, en comptant sur le mensonge et l'ombre."],
    }
  ),
  background(
    "sage",
    {
      skillProficiencies: ["arcana", "history"],
      toolProficiencies: [],
      languages: 2,
      equipment: ["Bottle of ink", "Quill", "Small knife", "Common clothes", "10 gp"],
      source: "srd-custom",
    },
    {
      en: ["Sage", "You spent years studying lore in libraries and with learned masters."],
      fr: ["Sage", "Vous avez passé des années à étudier le savoir dans les bibliothèques et auprès de maîtres."],
    }
  ),
  background(
    "soldier",
    {
      skillProficiencies: ["athletics", "intimidation"],
      toolProficiencies: ["Gaming set", "Vehicles (land)"],
      languages: 0,
      equipment: ["Insignia of rank", "Set of bone dice", "Common clothes", "10 gp"],
      source: "srd-custom",
    },
    {
      en: ["Soldier", "You trained and fought as part of an army or mercenary company."],
      fr: ["Soldat", "Vous vous êtes entraîné et avez combattu au sein d'une armée ou d'une compagnie de mercenaires."],
    }
  ),
  background(
    "folk_hero",
    {
      skillProficiencies: ["animal_handling", "survival"],
      toolProficiencies: ["Artisan's tools", "Vehicles (land)"],
      languages: 0,
      equipment: ["Artisan's tools", "Shovel", "Iron pot", "Common clothes", "10 gp"],
      source: "srd-custom",
    },
    {
      en: ["Folk Hero", "You come from humble roots and once stood up for your community."],
      fr: ["Héros du peuple", "Vous êtes d'origine modeste et avez un jour défendu votre communauté."],
    }
  ),
  background(
    "noble",
    {
      skillProficiencies: ["history", "persuasion"],
      toolProficiencies: ["Gaming set"],
      languages: 1,
      equipment: ["Fine clothes", "Signet ring", "Scroll of pedigree", "25 gp"],
      source: "srd-custom",
    },
    {
      en: ["Noble", "You were raised among wealth, privilege and the duties of rank."],
      fr: ["Noble", "Vous avez grandi dans la richesse, les privilèges et les devoirs du rang."],
    }
  ),
];

// ============================================================================
// CONDITIONS
// ============================================================================

function condition(key: string, text: Bilingual): CompendiumEntry {
  return srdEntry("condition", "condition", key, {}, text);
}

const CONDITIONS: CompendiumEntry[] = [
  condition("blinded", {
    en: ["Blinded", "Can't see; attacks against it have advantage and its attacks have disadvantage."],
    fr: ["Aveuglé", "Ne voit rien ; les attaques contre lui ont l'avantage et ses attaques ont le désavantage."],
  }),
  condition("charmed", {
    en: ["Charmed", "Can't attack the charmer, who has advantage on social checks against it."],
    fr: ["Charmé", "Ne peut pas attaquer celui qui l'a charmé, qui a l'avantage aux tests sociaux contre lui."],
  }),
  condition("deafened", {
    en: ["Deafened", "Can't hear and automatically fails checks that require hearing."],
    fr: ["Assourdi", "N'entend rien et échoue automatiquement aux tests nécessitant l'ouïe."],
  }),
  condition("exhaustion", {
    en: ["Exhaustion", "Cumulative levels of fatigue that hinder checks, speed and hit points."],
    fr: ["Épuisement", "Niveaux de fatigue cumulatifs qui pénalisent les tests, la vitesse et les points de vie."],
  }),
  condition("frightened", {
    en: ["Frightened", "Disadvantage while the source of fear is in sight; can't move closer to it."],
    fr: ["Effrayé", "Désavantage tant que la source de sa peur est visible ; ne peut pas s'en approcher."],
  }),
  condition("grappled", {
    en: ["Grappled", "Speed becomes 0 until the grapple ends."],
    fr: ["Agrippé", "Sa vitesse tombe à 0 jusqu'à la fin de l'empoignade."],
  }),
  condition("incapacitated", {
    en: ["Incapacitated", "Can't take actions or reactions."],
    fr: ["Neutralisé", "Ne peut entreprendre ni action ni réaction."],
  }),
  condition("invisible", {
    en: ["Invisible", "Can't be seen without magic; its attacks have advantage, attacks against it disadvantage."],
    fr: ["Invisible", "Impossible à voir sans magie ; ses attaques ont l'avantage, celles contre lui le désavantage."],
  }),
  condition("paralyzed", {
    en: ["Paralyzed", "Incapacitated and can't move or speak; nearby hits are critical."],
    fr: ["Paralysé", "Neutralisé, ne peut ni bouger ni parler ; les coups portés au contact sont critiques."],
  }),
  condition("petrified", {
    en: ["Petrified", "Turned to stone, incapacitated and resistant to all damage."],
    fr: ["Pétrifié", "Changé en pierre, neutralisé et résistant à tous les dégâts."],
  }),
  condition("poisoned", {
    en: ["Poisoned", "Disadvantage on attack rolls and ability checks."],
    fr: ["Empoisonné", "Désavantage aux jets d'attaque et aux tests de caractéristique."],
  }),
  condition("prone", {
    en: ["Prone", "Lying on the ground; melee attacks against it have advantage."],
    fr: ["À terre", "Allongé au sol ; les attaques au corps à corps contre lui ont l'avantage."],
  }),
  condition("restrained", {
    en: ["Restrained", "Speed 0, disadvantage on attacks and Dexterity saves."],
    fr: ["Entravé", "Vitesse 0, désavantage aux attaques et aux jets de sauvegarde de Dextérité."],
  }),
  condition("stunned", {
    en: ["Stunned", "Incapacitated, can't move, and fails Strength and Dexterity saves."],
    fr: ["Étourdi", "Neutralisé, ne peut pas bouger et échoue aux sauvegardes de Force et de Dextérité."],
  }),
  condition("unconscious", {
    en: ["Unconscious", "Incapacitated, unaware and prone; nearby hits are critical."],
    fr: ["Inconscient", "Neutralisé, inconscient de son environnement et à terre ; les coups au contact sont critiques."],
  }),
];

// ============================================================================
// SPELLS (levels 0-9, complementing the starter spells in compendium.ts)
// ============================================================================

interface SpellData {
  level: number;
  school: string;
  classes: SrdClassId[];
  castingTime: string;
  range: string;
  components: ("V" | "S" | "M")[];
  duration: string;
  concentration?: boolean;
  ritual?: boolean;
  damageDice?: string;
  damageType?: DamageType;
  healDice?: string;
  saveAbility?: AbilityId;
}

function spell(key: string, data: SpellData, text: Bilingual): CompendiumEntry {
  return srdEntry("spell", "spell", key, { ...data }, text);
}

const SPELLS: CompendiumEntry[] = [
  // Cantrips
  spell(
    "sacred_flame",
    { level: 0, school: "evocation", classes: ["cleric"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Instantaneous", damageDice: "1d8", damageType: "radiant", saveAbility: "dex" },
    {
      en: ["Sacred Flame", "Radiant flame descends on a creature that fails a Dexterity save, dealing 1d8 radiant damage."],
      fr: ["Flamme sacrée", "Une flamme radieuse frappe une créature qui rate un jet de Dextérité et lui inflige 1d8 dégâts radiants."],
    }
  ),
  spell(
    "eldritch_blast",
    { level: 0, school: "evocation", classes: ["warlock"], castingTime: "1 action", range: "120 feet", components: ["V", "S"], duration: "Instantaneous", damageDice: "1d10", damageType: "force" },
    {
      en: ["Eldritch Blast", "A beam of crackling energy; on a ranged spell attack hit it deals 1d10 force damage."],
      fr: ["Décharge occulte", "Un rayon d'énergie crépitante qui inflige 1d10 dégâts de force sur une attaque de sort réussie."],
    }
  ),
  spell(
    "vicious_mockery",
    { level: 0, school: "enchantment", classes: ["bard"], castingTime: "1 action", range: "60 feet", components: ["V"], duration: "Instantaneous", damageDice: "1d4", damageType: "psychic", saveAbility: "wis" },
    {
      en: ["Vicious Mockery", "Insults laced with magic deal 1d4 psychic damage and hinder the target's next attack."],
      fr: ["Moquerie cruelle", "Des insultes chargées de magie infligent 1d4 dégâts psychiques et gênent la prochaine attaque de la cible."],
    }
  ),
  spell(
    "produce_flame",
    { level: 0, school: "conjuration", classes: ["druid"], castingTime: "1 action", range: "Self", components: ["V", "S"], duration: "10 minutes", damageDice: "1d8", damageType: "fire" },
    {
      en: ["Produce Flame", "A flame in your hand sheds light and can be hurled for 1d8 fire damage."],
      fr: ["Production de flamme", "Une flamme dans votre main éclaire et peut être lancée pour 1d8 dégâts de feu."],
    }
  ),
  spell(
    "mage_hand",
    { level: 0, school: "conjuration", classes: ["bard", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "30 feet", components: ["V", "S"], duration: "1 minute" },
    {
      en: ["Mage Hand", "A spectral hand manipulates objects within range."],
      fr: ["Main de mage", "Une main spectrale manipule des objets à portée."],
    }
  ),
  spell(
    "light",
    { level: 0, school: "evocation", classes: ["bard", "cleric", "sorcerer", "wizard"], castingTime: "1 action", range: "Touch", components: ["V", "M"], duration: "1 hour" },
    {
      en: ["Light", "An object sheds bright light in a 20-foot radius for an hour."],
      fr: ["Lumière", "Un objet diffuse une vive lumière dans un rayon de 6 mètres pendant une heure."],
    }
  ),
  spell(
    "guidance",
    { level: 0, school: "divination", classes: ["cleric", "druid"], castingTime: "1 action", range: "Touch", components: ["V", "S"], duration: "Concentration, up to 1 minute", concentration: true },
    {
      en: ["Guidance", "A willing creature adds 1d4 to one ability check."],
      fr: ["Assistance", "Une créature consentante ajoute 1d4 à un test de caractéristique."],
    }
  ),
  spell(
    "ray_of_frost",
    { level: 0, school: "evocation", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Instantaneous", damageDice: "1d8", damageType: "cold" },
    {
      en: ["Ray of Frost", "A frigid beam deals 1d8 cold damage and slows the target by 10 feet."],
      fr: ["Rayon de givre", "Un rayon glacial inflige 1d8 dégâts de froid et réduit la vitesse de la cible de 3 mètres."],
    }
  ),
  // 1st level
  spell(
    "bless",
    { level: 1, school: "enchantment", classes: ["cleric", "paladin"], castingTime: "1 action", range: "30 feet", components: ["V", "S", "M"], duration: "Concentration, up to 1 minute", concentration: true },
    {
      en: ["Bless", "Up to three creatures add 1d4 to attack rolls and saving throws."],
      fr: ["Bénédiction", "Jusqu'à trois créatures ajoutent 1d4 à leurs jets d'attaque et de sauvegarde."],
    }
  ),
  spell(
    "healing_word",
    { level: 1, school: "evocation", classes: ["bard", "cleric", "druid"], castingTime: "1 bonus action", range: "60 feet", components: ["V"], duration: "Instantaneous", healDice: "1d4" },
    {
      en: ["Healing Word", "A creature you can see regains 1d4 + your spellcasting modifier hit points."],
      fr: ["Mot de guérison", "Une créature visible récupère 1d4 + votre modificateur d'incantation points de vie."],
    }
  ),
  spell(
    "thunderwave",
    { level: 1, school: "evocation", classes: ["bard", "druid", "sorcerer", "wizard"], castingTime: "1 action", range: "Self (15-foot cube)", components: ["V", "S"], duration: "Instantaneous", damageDice: "2d8", damageType: "thunder", saveAbility: "con" },
    {
      en: ["Thunderwave", "A wave of thunderous force deals 2d8 thunder damage and pushes creatures 10 feet."],
      fr: ["Vague tonnante", "Une onde de force tonitruante inflige 2d8 dégâts de tonnerre et repousse les créatures de 3 mètres."],
    }
  ),
  spell(
    "charm_person",
    { level: 1, school: "enchantment", classes: ["bard", "druid", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "30 feet", components: ["V", "S"], duration: "1 hour", saveAbility: "wis" },
    {
      en: ["Charm Person", "A humanoid that fails a Wisdom save regards you as a friendly acquaintance."],
      fr: ["Charme-personne", "Un humanoïde qui rate un jet de Sagesse vous considère comme une connaissance amicale."],
    }
  ),
  spell(
    "sleep",
    { level: 1, school: "enchantment", classes: ["bard", "sorcerer", "wizard"], castingTime: "1 action", range: "90 feet", components: ["V", "S", "M"], duration: "1 minute" },
    {
      en: ["Sleep", "Creatures totaling 5d8 hit points fall unconscious, weakest first."],
      fr: ["Sommeil", "Des créatures totalisant 5d8 points de vie sombrent dans l'inconscience, les plus faibles d'abord."],
    }
  ),
  spell(
    "burning_hands",
    { level: 1, school: "evocation", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "Self (15-foot cone)", components: ["V", "S"], duration: "Instantaneous", damageDice: "3d6", damageType: "fire", saveAbility: "dex" },
    {
      en: ["Burning Hands", "A sheet of flame deals 3d6 fire damage in a 15-foot cone."],
      fr: ["Mains brûlantes", "Une nappe de flammes inflige 3d6 dégâts de feu dans un cône de 4,5 mètres."],
    }
  ),
  spell(
    "goodberry",
    { level: 1, school: "transmutation", classes: ["druid", "ranger"], castingTime: "1 action", range: "Touch", components: ["V", "S", "M"], duration: "Instantaneous" },
    {
      en: ["Goodberry", "Ten magic berries each restore 1 hit point and a day's nourishment."],
      fr: ["Baies nourricières", "Dix baies magiques rendent chacune 1 point de vie et nourrissent pour la journée."],
    }
  ),
  spell(
    "detect_magic",
    { level: 1, school: "divination", classes: ["bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "wizard"], castingTime: "1 action", range: "Self", components: ["V", "S"], duration: "Concentration, up to 10 minutes", concentration: true, ritual: true },
    {
      en: ["Detect Magic", "You sense the presence of magic within 30 feet."],
      fr: ["Détection de la magie", "Vous percevez la présence de magie à 9 mètres ou moins."],
    }
  ),
  // 2nd level
  spell(
    "spiritual_weapon",
    { level: 2, school: "evocation", classes: ["cleric"], castingTime: "1 bonus action", range: "60 feet", components: ["V", "S"], duration: "1 minute", damageDice: "1d8", damageType: "force" },
    {
      en: ["Spiritual Weapon", "A floating spectral weapon strikes for 1d8 + your spellcasting modifier force damage."],
      fr: ["Arme spirituelle", "Une arme spectrale flottante frappe pour 1d8 + votre modificateur d'incantation dégâts de force."],
    }
  ),
  spell(
    "lesser_restoration",
    { level: 2, school: "abjuration", classes: ["bard", "cleric", "druid", "paladin", "ranger"], castingTime: "1 action", range: "Touch", components: ["V", "S"], duration: "Instantaneous" },
    {
      en: ["Lesser Restoration", "Ends one disease or the blinded, deafened, paralyzed or poisoned condition."],
      fr: ["Restauration partielle", "Met fin à une maladie ou à l'état aveuglé, assourdi, paralysé ou empoisonné."],
    }
  ),
  spell(
    "invisibility",
    { level: 2, school: "illusion", classes: ["bard", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "Touch", components: ["V", "S", "M"], duration: "Concentration, up to 1 hour", concentration: true },
    {
      en: ["Invisibility", "A creature becomes invisible until it attacks or casts a spell."],
      fr: ["Invisibilité", "Une créature devient invisible jusqu'à ce qu'elle attaque ou lance un sort."],
    }
  ),
  spell(
    "scorching_ray",
    { level: 2, school: "evocation", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "120 feet", components: ["V", "S"], duration: "Instantaneous", damageDice: "2d6", damageType: "fire" },
    {
      en: ["Scorching Ray", "Three rays of fire each deal 2d6 fire damage on a hit."],
      fr: ["Rayon ardent", "Trois rayons de feu infligent chacun 2d6 dégâts de feu s'ils touchent."],
    }
  ),
  spell(
    "pass_without_trace",
    { level: 2, school: "abjuration", classes: ["druid", "ranger"], castingTime: "1 action", range: "Self", components: ["V", "S", "M"], duration: "Concentration, up to 1 hour", concentration: true },
    {
      en: ["Pass without Trace", "You and nearby allies gain +10 to Stealth and leave no tracks."],
      fr: ["Passage sans trace", "Vous et vos alliés proches gagnez +10 en Discrétion et ne laissez aucune trace."],
    }
  ),
  spell(
    "aid",
    { level: 2, school: "abjuration", classes: ["cleric", "paladin"], castingTime: "1 action", range: "30 feet", components: ["V", "S", "M"], duration: "8 hours" },
    {
      en: ["Aid", "Up to three creatures gain 5 to their current and maximum hit points."],
      fr: ["Aide", "Jusqu'à trois créatures gagnent 5 points de vie actuels et maximum."],
    }
  ),
  // 3rd level
  spell(
    "dispel_magic",
    { level: 3, school: "abjuration", classes: ["bard", "cleric", "druid", "paladin", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "120 feet", components: ["V", "S"], duration: "Instantaneous" },
    {
      en: ["Dispel Magic", "Ends spells of 3rd level or lower on a target; higher spells need a check."],
      fr: ["Dissipation de la magie", "Met fin aux sorts de niveau 3 ou moins sur une cible ; les sorts supérieurs exigent un test."],
    }
  ),
  spell(
    "revivify",
    { level: 3, school: "necromancy", classes: ["cleric", "paladin"], castingTime: "1 action", range: "Touch", components: ["V", "S", "M"], duration: "Instantaneous" },
    {
      en: ["Revivify", "A creature that died within the last minute returns to life with 1 hit point."],
      fr: ["Retour à la vie", "Une créature morte depuis moins d'une minute revient à la vie avec 1 point de vie."],
    }
  ),
  spell(
    "spirit_guardians",
    { level: 3, school: "conjuration", classes: ["cleric"], castingTime: "1 action", range: "Self (15-foot radius)", components: ["V", "S", "M"], duration: "Concentration, up to 10 minutes", concentration: true, damageDice: "3d8", damageType: "radiant", saveAbility: "wis" },
    {
      en: ["Spirit Guardians", "Protective spirits slow enemies near you and deal 3d8 damage to them."],
      fr: ["Esprits gardiens", "Des esprits protecteurs ralentissent les ennemis proches et leur infligent 3d8 dégâts."],
    }
  ),
  spell(
    "lightning_bolt",
    { level: 3, school: "evocation", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "Self (100-foot line)", components: ["V", "S", "M"], duration: "Instantaneous", damageDice: "8d6", damageType: "lightning", saveAbility: "dex" },
    {
      en: ["Lightning Bolt", "A 100-foot line of lightning deals 8d6 lightning damage."],
      fr: ["Éclair", "Une ligne de foudre de 30 mètres inflige 8d6 dégâts de foudre."],
    }
  ),
  spell(
    "conjure_animals",
    { level: 3, school: "conjuration", classes: ["druid", "ranger"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Concentration, up to 1 hour", concentration: true },
    {
      en: ["Conjure Animals", "Fey spirits take the shape of beasts that fight at your side."],
      fr: ["Invocation d'animaux", "Des esprits féeriques prennent la forme de bêtes qui combattent à vos côtés."],
    }
  ),
  // 4th level
  spell(
    "banishment",
    { level: 4, school: "abjuration", classes: ["cleric", "paladin", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V", "S", "M"], duration: "Concentration, up to 1 minute", concentration: true, saveAbility: "cha" },
    {
      en: ["Banishment", "A creature that fails a Charisma save is sent to a harmless demiplane."],
      fr: ["Bannissement", "Une créature qui rate un jet de Charisme est envoyée dans un demi-plan inoffensif."],
    }
  ),
  spell(
    "freedom_of_movement",
    { level: 4, school: "abjuration", classes: ["bard", "cleric", "druid", "ranger"], castingTime: "1 action", range: "Touch", components: ["V", "S", "M"], duration: "1 hour" },
    {
      en: ["Freedom of Movement", "Difficult terrain, paralysis and restraints can't slow the target."],
      fr: ["Liberté de mouvement", "Ni terrain difficile, ni paralysie, ni entraves ne ralentissent la cible."],
    }
  ),
  spell(
    "greater_invisibility",
    { level: 4, school: "illusion", classes: ["bard", "sorcerer", "wizard"], castingTime: "1 action", range: "Touch", components: ["V", "S"], duration: "Concentration, up to 1 minute", concentration: true },
    {
      en: ["Greater Invisibility", "A creature stays invisible even while attacking or casting."],
      fr: ["Invisibilité supérieure", "Une créature reste invisible même lorsqu'elle attaque ou lance des sorts."],
    }
  ),
  // 5th level
  spell(
    "mass_cure_wounds",
    { level: 5, school: "conjuration", classes: ["bard", "cleric", "druid"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Instantaneous", healDice: "3d8" },
    {
      en: ["Mass Cure Wounds", "Up to six creatures each regain 3d8 + your spellcasting modifier hit points."],
      fr: ["Soins de groupe", "Jusqu'à six créatures récupèrent chacune 3d8 + votre modificateur d'incantation points de vie."],
    }
  ),
  spell(
    "hold_monster",
    { level: 5, school: "enchantment", classes: ["bard", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "90 feet", components: ["V", "S", "M"], duration: "Concentration, up to 1 minute", concentration: true, saveAbility: "wis" },
    {
      en: ["Hold Monster", "A creature that fails a Wisdom save is paralyzed."],
      fr: ["Immobilisation de monstre", "Une créature qui rate un jet de Sagesse est paralysée."],
    }
  ),
  spell(
    "raise_dead",
    { level: 5, school: "necromancy", classes: ["bard", "cleric", "paladin"], castingTime: "1 hour", range: "Touch", components: ["V", "S", "M"], duration: "Instantaneous" },
    {
      en: ["Raise Dead", "A creature dead for no more than 10 days returns to life with 1 hit point."],
      fr: ["Rappel à la vie", "Une créature morte depuis 10 jours au plus revient à la vie avec 1 point de vie."],
    }
  ),
  spell(
    "commune_with_nature",
    { level: 5, school: "divination", classes: ["druid", "ranger"], castingTime: "1 minute", range: "Self", components: ["V", "S"], duration: "Instantaneous", ritual: true },
    {
      en: ["Commune with Nature", "You learn facts about the surrounding land within 3 miles."],
      fr: ["Communion avec la nature", "Vous apprenez des faits sur la région environnante dans un rayon de 5 km."],
    }
  ),
  // 6th level
  spell(
    "chain_lightning",
    { level: 6, school: "evocation", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "150 feet", components: ["V", "S", "M"], duration: "Instantaneous", damageDice: "10d8", damageType: "lightning", saveAbility: "dex" },
    {
      en: ["Chain Lightning", "A bolt arcs to up to four targets, dealing 10d8 lightning damage each."],
      fr: ["Chaîne d'éclairs", "Un éclair bondit sur jusqu'à quatre cibles et inflige 10d8 dégâts de foudre à chacune."],
    }
  ),
  spell(
    "heal",
    { level: 6, school: "evocation", classes: ["cleric", "druid"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Instantaneous" },
    {
      en: ["Heal", "A creature regains 70 hit points and is cured of blindness, deafness and disease."],
      fr: ["Guérison", "Une créature récupère 70 points de vie et est guérie de la cécité, de la surdité et des maladies."],
    }
  ),
  spell(
    "mass_suggestion",
    { level: 6, school: "enchantment", classes: ["bard", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V", "M"], duration: "24 hours", saveAbility: "wis" },
    {
      en: ["Mass Suggestion", "Up to twelve creatures follow a reasonable suggested course of action."],
      fr: ["Suggestion de groupe", "Jusqu'à douze créatures suivent une ligne de conduite raisonnable que vous suggérez."],
    }
  ),
  // 7th level
  spell(
    "finger_of_death",
    { level: 7, school: "necromancy", classes: ["sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Instantaneous", damageDice: "7d8+30", damageType: "necrotic", saveAbility: "con" },
    {
      en: ["Finger of Death", "Negative energy deals 7d8 + 30 necrotic damage; slain humanoids rise as zombies."],
      fr: ["Doigt de mort", "Une énergie négative inflige 7d8 + 30 dégâts nécrotiques ; les humanoïdes tués se relèvent en zombis."],
    }
  ),
  spell(
    "teleport",
    { level: 7, school: "conjuration", classes: ["bard", "sorcerer", "wizard"], castingTime: "1 action", range: "10 feet", components: ["V"], duration: "Instantaneous" },
    {
      en: ["Teleport", "You and up to eight willing creatures travel instantly to a known destination."],
      fr: ["Téléportation", "Vous et jusqu'à huit créatures consentantes voyagez instantanément vers une destination connue."],
    }
  ),
  spell(
    "resurrection",
    { level: 7, school: "necromancy", classes: ["bard", "cleric"], castingTime: "1 hour", range: "Touch", components: ["V", "S", "M"], duration: "Instantaneous" },
    {
      en: ["Resurrection", "A creature dead for up to a century returns to life with all its hit points."],
      fr: ["Résurrection", "Une créature morte depuis un siècle au plus revient à la vie avec tous ses points de vie."],
    }
  ),
  spell(
    "fire_storm",
    { level: 7, school: "evocation", classes: ["cleric", "druid", "sorcerer"], castingTime: "1 action", range: "150 feet", components: ["V", "S"], duration: "Instantaneous", damageDice: "7d10", damageType: "fire", saveAbility: "dex" },
    {
      en: ["Fire Storm", "Sheets of roaring flame deal 7d10 fire damage across a wide area."],
      fr: ["Tempête de feu", "Des murs de flammes rugissantes infligent 7d10 dégâts de feu sur une vaste zone."],
    }
  ),
  // 8th level
  spell(
    "sunburst",
    { level: 8, school: "evocation", classes: ["druid", "sorcerer", "wizard"], castingTime: "1 action", range: "150 feet", components: ["V", "S", "M"], duration: "Instantaneous", damageDice: "12d6", damageType: "radiant", saveAbility: "con" },
    {
      en: ["Sunburst", "Brilliant sunlight deals 12d6 radiant damage and blinds creatures in a 60-foot radius."],
      fr: ["Explosion solaire", "Une lumière solaire éclatante inflige 12d6 dégâts radiants et aveugle dans un rayon de 18 mètres."],
    }
  ),
  spell(
    "power_word_stun",
    { level: 8, school: "enchantment", classes: ["bard", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V"], duration: "Instantaneous" },
    {
      en: ["Power Word Stun", "A creature with 150 hit points or fewer is stunned."],
      fr: ["Mot de pouvoir étourdissant", "Une créature ayant 150 points de vie ou moins est étourdie."],
    }
  ),
  spell(
    "earthquake",
    { level: 8, school: "evocation", classes: ["cleric", "druid", "sorcerer"], castingTime: "1 action", range: "500 feet", components: ["V", "S", "M"], duration: "Concentration, up to 1 minute", concentration: true },
    {
      en: ["Earthquake", "A violent tremor opens fissures, topples structures and knocks creatures prone."],
      fr: ["Tremblement de terre", "Une violente secousse ouvre des failles, abat les structures et renverse les créatures."],
    }
  ),
  // 9th level
  spell(
    "wish",
    { level: 9, school: "conjuration", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "Self", components: ["V"], duration: "Instantaneous" },
    {
      en: ["Wish", "The mightiest spell: duplicate any spell of 8th level or lower, or alter reality."],
      fr: ["Souhait", "Le plus puissant des sorts : reproduit tout sort de niveau 8 ou moins, ou altère la réalité."],
    }
  ),
  spell(
    "meteor_swarm",
    { level: 9, school: "evocation", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "1 mile", components: ["V", "S"], duration: "Instantaneous", damageDice: "20d6+20d6", damageType: "fire", saveAbility: "dex" },
    {
      en: ["Meteor Swarm", "Four blazing orbs deal 20d6 fire and 20d6 bludgeoning damage each."],
      fr: ["Nuée de météores", "Quatre orbes enflammés infligent chacun 20d6 dégâts de feu et 20d6 dégâts contondants."],
    }
  ),
  spell(
    "power_word_kill",
    { level: 9, school: "enchantment", classes: ["bard", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V"], duration: "Instantaneous" },
    {
      en: ["Power Word Kill", "A creature with 100 hit points or fewer dies instantly."],
      fr: ["Mot de pouvoir mortel", "Une créature ayant 100 points de vie ou moins meurt instantanément."],
    }
  ),
  spell(
    "true_resurrection",
    { level: 9, school: "necromancy", classes: ["cleric", "druid"], castingTime: "1 hour", range: "Touch", components: ["V", "S", "M"], duration: "Instantaneous" },
    {
      en: ["True Resurrection", "A creature dead for up to 200 years returns to life, even without a body."],
      fr: ["Résurrection suprême", "Une créature morte depuis 200 ans au plus revient à la vie, même sans corps."],
    }
  ),
  spell(
    "shapechange",
    { level: 9, school: "transmutation", classes: ["druid", "wizard"], castingTime: "1 action", range: "Self", components: ["V", "S", "M"], duration: "Concentration, up to 1 hour", concentration: true },
    {
      en: ["Shapechange", "You assume the form of a creature of a challenge rating up to your level."],
      fr: ["Changement de forme", "Vous prenez la forme d'une créature d'un facteur de puissance au plus égal à votre niveau."],
    }
  ),
];

// ============================================================================
// ITEMS (weapons, armor, adventuring gear)
// ============================================================================

interface WeaponData {
  category: "simple" | "martial";
  damage: string;
  damageType: DamageType;
  properties: string[];
  versatileDamage?: string;
  range?: string;
  weight: number;
  cost: string;
}

function weapon(key: string, data: WeaponData, text: Bilingual): CompendiumEntry {
  return srdEntry("weapon", "item", key, { itemType: "weapon", ...data }, text);
}

interface ArmorData {
  category: "light" | "medium" | "heavy";
  armorClass: number;
  strengthRequirement?: number;
  stealthDisadvantage: boolean;
  weight: number;
  cost: string;
}

function armor(key: string, data: ArmorData, text: Bilingual): CompendiumEntry {
  return srdEntry(
    "armor",
    "item",
    key,
    {
      itemType: "armor",
      ...data,
      dexBonus: data.category !== "heavy",
      maxDexBonus: data.category === "medium" ? 2 : null,
    },
    text
  );
}

function gear(key: string, data: Record<string, unknown>, text: Bilingual): CompendiumEntry {
  return srdEntry("item", "item", key, { itemType: "equipment", ...data }, text);
}

const ITEMS: CompendiumEntry[] = [
  weapon(
    "club",
    { category: "simple", damage: "1d4", damageType: "bludgeoning", properties: ["light"], weight: 2, cost: "1 sp" },
    { en: ["Club", "A simple melee weapon dealing 1d4 bludgeoning damage."], fr: ["Gourdin", "Une arme courante de corps à corps infligeant 1d4 dégâts contondants."] }
  ),
  weapon(
    "quarterstaff",
    { category: "simple", damage: "1d6", versatileDamage: "1d8", damageType: "bludgeoning", properties: ["versatile"], weight: 4, cost: "2 sp" },
    { en: ["Quarterstaff", "A versatile staff dealing 1d6 bludgeoning damage (1d8 two-handed)."], fr: ["Bâton", "Un bâton polyvalent infligeant 1d6 dégâts contondants (1d8 à deux mains)."] }
  ),
  weapon(
    "mace",
    { category: "simple", damage: "1d6", damageType: "bludgeoning", properties: [], weight: 4, cost: "5 gp" },
    { en: ["Mace", "A simple melee weapon dealing 1d6 bludgeoning damage."], fr: ["Masse d'armes", "Une arme courante de corps à corps infligeant 1d6 dégâts contondants."] }
  ),
  weapon(
    "handaxe",
    { category: "simple", damage: "1d6", damageType: "slashing", properties: ["light", "thrown"], range: "20/60", weight: 2, cost: "5 gp" },
    { en: ["Handaxe", "A light throwing axe dealing 1d6 slashing damage (range 20/60)."], fr: ["Hachette", "Une hache légère de lancer infligeant 1d6 dégâts tranchants (portée 6/18 m)."] }
  ),
  weapon(
    "javelin",
    { category: "simple", damage: "1d6", damageType: "piercing", properties: ["thrown"], range: "30/120", weight: 2, cost: "5 sp" },
    { en: ["Javelin", "A thrown spear dealing 1d6 piercing damage (range 30/120)."], fr: ["Javeline", "Une lance de jet infligeant 1d6 dégâts perforants (portée 9/36 m)."] }
  ),
  weapon(
    "spear",
    { category: "simple", damage: "1d6", versatileDamage: "1d8", damageType: "piercing", properties: ["thrown", "versatile"], range: "20/60", weight: 3, cost: "1 gp" },
    { en: ["Spear", "A versatile spear dealing 1d6 piercing damage (1d8 two-handed)."], fr: ["Lance", "Une lance polyvalente infligeant 1d6 dégâts perforants (1d8 à deux mains)."] }
  ),
  weapon(
    "rapier",
    { category: "martial", damage: "1d8", damageType: "piercing", properties: ["finesse"], weight: 2, cost: "25 gp" },
    { en: ["Rapier", "A finesse blade dealing 1d8 piercing damage."], fr: ["Rapière", "Une lame de finesse infligeant 1d8 dégâts perforants."] }
  ),
  weapon(
    "shortsword",
    { category: "martial", damage: "1d6", damageType: "piercing", properties: ["finesse", "light"], weight: 2, cost: "10 gp" },
    { en: ["Shortsword", "A light finesse blade dealing 1d6 piercing damage."], fr: ["Épée courte", "Une lame légère de finesse infligeant 1d6 dégâts perforants."] }
  ),
  weapon(
    "scimitar",
    { category: "martial", damage: "1d6", damageType: "slashing", properties: ["finesse", "light"], weight: 3, cost: "25 gp" },
    { en: ["Scimitar", "A curved light blade dealing 1d6 slashing damage."], fr: ["Cimeterre", "Une lame courbe et légère infligeant 1d6 dégâts tranchants."] }
  ),
  weapon(
    "battleaxe",
    { category: "martial", damage: "1d8", versatileDamage: "1d10", damageType: "slashing", properties: ["versatile"], weight: 4, cost: "10 gp" },
    { en: ["Battleaxe", "A versatile axe dealing 1d8 slashing damage (1d10 two-handed)."], fr: ["Hache d'armes", "Une hache polyvalente infligeant 1d8 dégâts tranchants (1d10 à deux mains)."] }
  ),
  weapon(
    "warhammer",
    { category: "martial", damage: "1d8", versatileDamage: "1d10", damageType: "bludgeoning", properties: ["versatile"], weight: 2, cost: "15 gp" },
    { en: ["Warhammer", "A versatile hammer dealing 1d8 bludgeoning damage (1d10 two-handed)."], fr: ["Marteau de guerre", "Un marteau polyvalent infligeant 1d8 dégâts contondants (1d10 à deux mains)."] }
  ),
  weapon(
    "greataxe",
    { category: "martial", damage: "1d12", damageType: "slashing", properties: ["heavy", "two-handed"], weight: 7, cost: "30 gp" },
    { en: ["Greataxe", "A heavy two-handed axe dealing 1d12 slashing damage."], fr: ["Grande hache", "Une lourde hache à deux mains infligeant 1d12 dégâts tranchants."] }
  ),
  weapon(
    "heavy_crossbow",
    { category: "martial", damage: "1d10", damageType: "piercing", properties: ["ammunition", "heavy", "loading", "two-handed"], range: "100/400", weight: 18, cost: "50 gp" },
    { en: ["Heavy Crossbow", "A heavy ranged weapon dealing 1d10 piercing damage (range 100/400)."], fr: ["Arbalète lourde", "Une arme à distance lourde infligeant 1d10 dégâts perforants (portée 30/120 m)."] }
  ),
  armor(
    "padded_armor",
    { category: "light", armorClass: 11, stealthDisadvantage: true, weight: 8, cost: "5 gp" },
    { en: ["Padded Armor", "Quilted layers of cloth. AC 11 + Dex modifier, disadvantage on Stealth."], fr: ["Armure matelassée", "Des couches de tissu matelassé. CA 11 + modificateur de Dex, désavantage en Discrétion."] }
  ),
  armor(
    "studded_leather_armor",
    { category: "light", armorClass: 12, stealthDisadvantage: false, weight: 13, cost: "45 gp" },
    { en: ["Studded Leather Armor", "Tough leather reinforced with rivets. AC 12 + Dex modifier."], fr: ["Armure de cuir clouté", "Un cuir robuste renforcé de rivets. CA 12 + modificateur de Dex."] }
  ),
  armor(
    "hide_armor",
    { category: "medium", armorClass: 12, stealthDisadvantage: false, weight: 12, cost: "10 gp" },
    { en: ["Hide Armor", "Thick furs and pelts. AC 12 + Dex modifier (max 2)."], fr: ["Armure de peau", "D'épaisses fourrures et peaux. CA 12 + modificateur de Dex (max 2)."] }
  ),
  armor(
    "chain_shirt",
    { category: "medium", armorClass: 13, stealthDisadvantage: false, weight: 20, cost: "50 gp" },
    { en: ["Chain Shirt", "Interlocking rings worn under clothing. AC 13 + Dex modifier (max 2)."], fr: ["Chemise de mailles", "Des anneaux entrelacés portés sous les vêtements. CA 13 + modificateur de Dex (max 2)."] }
  ),
  armor(
    "breastplate",
    { category: "medium", armorClass: 14, stealthDisadvantage: false, weight: 20, cost: "400 gp" },
    { en: ["Breastplate", "A fitted metal chest piece. AC 14 + Dex modifier (max 2)."], fr: ["Cuirasse", "Une pièce de métal ajustée protégeant le torse. CA 14 + modificateur de Dex (max 2)."] }
  ),
  armor(
    "half_plate",
    { category: "medium", armorClass: 15, stealthDisadvantage: true, weight: 40, cost: "750 gp" },
    { en: ["Half Plate", "Shaped metal plates covering most of the body. AC 15 + Dex modifier (max 2)."], fr: ["Demi-plate", "Des plaques de métal couvrant la majeure partie du corps. CA 15 + modificateur de Dex (max 2)."] }
  ),
  armor(
    "ring_mail",
    { category: "heavy", armorClass: 14, stealthDisadvantage: true, weight: 40, cost: "30 gp" },
    { en: ["Ring Mail", "Leather armor with heavy rings sewn into it. AC 14."], fr: ["Broigne", "Une armure de cuir sur laquelle sont cousus de lourds anneaux. CA 14."] }
  ),
  armor(
    "splint_armor",
    { category: "heavy", armorClass: 17, strengthRequirement: 15, stealthDisadvantage: true, weight: 60, cost: "200 gp" },
    { en: ["Splint Armor", "Vertical metal strips riveted to a leather backing. AC 17, requires Str 15."], fr: ["Clibanion", "Des bandes de métal verticales rivetées sur du cuir. CA 17, requiert For 15."] }
  ),
  gear(
    "potion_of_healing",
    { itemType: "consumable", healDice: "2d4+2", rarity: "common", magic: true, weight: 0.5, cost: "50 gp" },
    { en: ["Potion of Healing", "Drinking this red liquid restores 2d4 + 2 hit points."], fr: ["Potion de soins", "Boire ce liquide rouge rend 2d4 + 2 points de vie."] }
  ),
  gear(
    "hempen_rope",
    { lengthFt: 50, weight: 10, cost: "1 gp" },
    { en: ["Hempen Rope (50 feet)", "Fifty feet of rope with 2 hit points that can be burst with a DC 17 Strength check."], fr: ["Corde de chanvre (15 mètres)", "Quinze mètres de corde, 2 points de vie, rompue sur un test de Force DD 17."] }
  ),
  gear(
    "torch",
    { durationMinutes: 60, brightLightFt: 20, weight: 1, cost: "1 cp" },
    { en: ["Torch", "Burns for 1 hour, shedding bright light in a 20-foot radius."], fr: ["Torche", "Brûle pendant 1 heure et éclaire vivement dans un rayon de 6 mètres."] }
  ),
  gear(
    "rations",
    { itemType: "consumable", weight: 2, cost: "5 sp" },
    { en: ["Rations (1 day)", "Dry food suitable for extended travel."], fr: ["Rations (1 jour)", "De la nourriture sèche adaptée aux longs voyages."] }
  ),
  gear(
    "thieves_tools",
    { itemType: "tool", weight: 1, cost: "25 gp" },
    { en: ["Thieves' Tools", "Picks and files used to open locks and disarm traps."], fr: ["Outils de voleur", "Crochets et limes servant à ouvrir les serrures et désamorcer les pièges."] }
  ),
  gear(
    "healers_kit",
    { uses: 10, weight: 3, cost: "5 gp" },
    { en: ["Healer's Kit", "Ten uses; stabilizes a dying creature without a Medicine check."], fr: ["Trousse de soins", "Dix utilisations ; stabilise une créature mourante sans test de Médecine."] }
  ),
  gear(
    "component_pouch",
    { weight: 2, cost: "25 gp" },
    { en: ["Component Pouch", "A belt pouch holding the material components of spells."], fr: ["Sacoche à composantes", "Une bourse de ceinture contenant les composantes matérielles des sorts."] }
  ),
];

// ============================================================================
// MONSTERS (CR 0-20, complementing the starter monsters in compendium.ts)
// ============================================================================

interface MonsterAction {
  id: string;
  name: string;
  attackBonus?: number;
  damage: string;
  damageType: DamageType;
  range?: string;
  saveAbility?: AbilityId;
  dc?: number;
}

interface MonsterSpec {
  /** Challenge rating as a number (`0.125`, `0.25`, `0.5`, `1`..`20`). */
  cr: number;
  hp: number;
  /** Hit dice as `[count, sides]`. */
  hitDice: [number, number];
  /** Stat-block Armor Class (already includes armor, shield and Dexterity). */
  ac: number;
  /** Ability scores in `str, dex, con, int, wis, cha` order. */
  abilities: [number, number, number, number, number, number];
  actions: MonsterAction[];
  saves?: AbilityId[];
  damageResistances?: DamageType[];
  damageImmunities?: DamageType[];
  conditionImmunities?: string[];
  legendaryResistance?: number;
}

function crLabel(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

/** Level whose proficiency bonus equals the SRD proficiency bonus for `cr`. */
function proficiencyLevelForCr(cr: number): number {
  if (cr >= 17) return 17;
  if (cr >= 13) return 13;
  if (cr >= 9) return 9;
  if (cr >= 5) return 5;
  return 1;
}

function attack(
  id: string,
  name: string,
  attackBonus: number,
  damage: string,
  damageType: DamageType,
  range?: string
): MonsterAction {
  return { id, name, attackBonus, damage, damageType, ...(range ? { range } : {}) };
}

function saveAction(
  id: string,
  name: string,
  damage: string,
  damageType: DamageType,
  saveAbility: AbilityId,
  dc: number
): MonsterAction {
  return { id, name, damage, damageType, saveAbility, dc };
}

function monster(key: string, spec: MonsterSpec, text: Bilingual): CompendiumEntry {
  const [str, dex, con, int, wis, cha] = spec.abilities;
  const resources: Record<string, unknown> = {};
  if (spec.legendaryResistance) {
    resources.legendary_resistance = {
      id: "legendary_resistance",
      label: `Legendary Resistance (${spec.legendaryResistance}/Day)`,
      current: spec.legendaryResistance,
      max: spec.legendaryResistance,
      recovery: "long_rest",
    };
  }
  const id = `srd:monster:${key}`;
  return srdEntry(
    "monster",
    "monster",
    key,
    {
      id,
      name: text.en[0],
      level: proficiencyLevelForCr(spec.cr),
      challengeRating: crLabel(spec.cr),
      cr: spec.cr,
      hpCurrent: spec.hp,
      hpMax: spec.hp,
      tempHp: 0,
      hitDiceCurrent: spec.hitDice[0],
      hitDiceMax: spec.hitDice[0],
      hitDieSides: spec.hitDice[1],
      armorBaseAc: spec.ac,
      armorKind: "natural",
      hasShield: false,
      abilities: { str, dex, con, int, wis, cha },
      saveProficiencies: Object.fromEntries((spec.saves ?? []).map((ab) => [ab, true])),
      skillProficiencies: {},
      damageResistances: spec.damageResistances ?? [],
      damageImmunities: spec.damageImmunities ?? [],
      conditionImmunities: spec.conditionImmunities ?? [],
      exhaustionLevel: 0,
      conditions: [],
      resources,
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: spec.actions,
    },
    text
  );
}

const MONSTERS: CompendiumEntry[] = [
  monster(
    "rat",
    { cr: 0, hp: 1, hitDice: [1, 4], ac: 10, abilities: [2, 11, 9, 2, 10, 4], actions: [attack("bite", "Bite", 0, "1", "piercing")] },
    { en: ["Rat", "A tiny scavenger with keen smell, common in sewers and cellars."], fr: ["Rat", "Un minuscule charognard à l'odorat aiguisé, fréquent dans les égouts et les caves."] }
  ),
  monster(
    "commoner",
    { cr: 0, hp: 4, hitDice: [1, 8], ac: 10, abilities: [10, 10, 10, 10, 10, 10], actions: [attack("club", "Club", 2, "1d4", "bludgeoning")] },
    { en: ["Commoner", "Peasants, servants, pilgrims and townsfolk of every realm."], fr: ["Roturier", "Paysans, serviteurs, pèlerins et citadins de tous les royaumes."] }
  ),
  monster(
    "kobold",
    { cr: 0.125, hp: 5, hitDice: [2, 6], ac: 12, abilities: [7, 15, 9, 8, 7, 8], actions: [attack("dagger", "Dagger", 4, "1d4 + 2", "piercing"), attack("sling", "Sling", 4, "1d4 + 2", "bludgeoning", "30/120")] },
    { en: ["Kobold", "Small reptilian humanoids that fight in packs and set cunning traps."], fr: ["Kobold", "De petits humanoïdes reptiliens qui combattent en meute et posent des pièges retors."] }
  ),
  monster(
    "cultist",
    { cr: 0.125, hp: 9, hitDice: [2, 8], ac: 12, abilities: [11, 12, 10, 10, 11, 10], actions: [attack("scimitar", "Scimitar", 3, "1d6 + 1", "slashing")] },
    { en: ["Cultist", "Zealots sworn to dark powers, often serving a sinister leader."], fr: ["Cultiste", "Des fanatiques voués à des puissances obscures, souvent au service d'un chef sinistre."] }
  ),
  monster(
    "zombie",
    { cr: 0.25, hp: 22, hitDice: [3, 8], ac: 8, abilities: [13, 6, 16, 3, 6, 5], actions: [attack("slam", "Slam", 3, "1d6 + 1", "bludgeoning")], damageImmunities: ["poison"], conditionImmunities: ["poisoned"] },
    { en: ["Zombie", "A shambling corpse animated by necromancy that refuses to stay down."], fr: ["Zombi", "Un cadavre titubant animé par la nécromancie, qui refuse de rester à terre."] }
  ),
  monster(
    "orc",
    { cr: 0.5, hp: 15, hitDice: [2, 8], ac: 13, abilities: [16, 12, 16, 7, 11, 10], actions: [attack("greataxe", "Greataxe", 5, "1d12 + 3", "slashing"), attack("javelin", "Javelin", 5, "1d6 + 3", "piercing", "30/120")] },
    { en: ["Orc", "Savage raiders who charge relentlessly at their foes."], fr: ["Orque", "Des pillards sauvages qui chargent leurs ennemis sans relâche."] }
  ),
  monster(
    "hobgoblin",
    { cr: 0.5, hp: 11, hitDice: [2, 8], ac: 18, abilities: [13, 12, 12, 10, 10, 9], actions: [attack("longsword", "Longsword", 3, "1d8 + 1", "slashing"), attack("longbow", "Longbow", 3, "1d8 + 1", "piercing", "150/600")] },
    { en: ["Hobgoblin", "Disciplined goblinoid soldiers who fight in tight formations."], fr: ["Hobgobelin", "Des soldats gobelinoïdes disciplinés qui combattent en formations serrées."] }
  ),
  monster(
    "gnoll",
    { cr: 0.5, hp: 22, hitDice: [5, 8], ac: 15, abilities: [14, 12, 11, 6, 10, 7], actions: [attack("spear", "Spear", 4, "1d6 + 2", "piercing", "20/60"), attack("longbow", "Longbow", 3, "1d8 + 1", "piercing", "150/600")] },
    { en: ["Gnoll", "Hyena-headed marauders driven by an insatiable hunger."], fr: ["Gnoll", "Des maraudeurs à tête de hyène poussés par une faim insatiable."] }
  ),
  monster(
    "bugbear",
    { cr: 1, hp: 27, hitDice: [5, 8], ac: 16, abilities: [15, 14, 13, 8, 11, 9], actions: [attack("morningstar", "Morningstar", 4, "2d8 + 2", "piercing")] },
    { en: ["Bugbear", "Hairy goblinoid brutes that strike from ambush."], fr: ["Gobelours", "Des brutes gobelinoïdes velues qui frappent en embuscade."] }
  ),
  monster(
    "ghoul",
    { cr: 1, hp: 22, hitDice: [5, 8], ac: 12, abilities: [13, 15, 10, 7, 10, 6], actions: [attack("claws", "Claws", 4, "2d4 + 2", "slashing"), attack("bite", "Bite", 2, "2d6 + 2", "piercing")], damageImmunities: ["poison"], conditionImmunities: ["charmed", "exhaustion", "poisoned"] },
    { en: ["Ghoul", "Flesh-eating undead whose claws paralyze the living."], fr: ["Goule", "Des morts-vivants nécrophages dont les griffes paralysent les vivants."] }
  ),
  monster(
    "dire_wolf",
    { cr: 1, hp: 37, hitDice: [5, 10], ac: 14, abilities: [17, 15, 15, 3, 12, 7], actions: [attack("bite", "Bite", 5, "2d6 + 3", "piercing")] },
    { en: ["Dire Wolf", "A massive wolf that hunts in packs and drags prey to the ground."], fr: ["Loup sanguinaire", "Un loup massif qui chasse en meute et renverse ses proies."] }
  ),
  monster(
    "giant_spider",
    { cr: 1, hp: 26, hitDice: [4, 10], ac: 14, abilities: [14, 16, 12, 2, 11, 4], actions: [attack("bite", "Bite", 5, "1d8 + 3", "piercing")] },
    { en: ["Giant Spider", "A venomous spider that webs its prey from the shadows."], fr: ["Araignée géante", "Une araignée venimeuse qui piège ses proies dans ses toiles depuis l'ombre."] }
  ),
  monster(
    "ghast",
    { cr: 2, hp: 36, hitDice: [8, 8], ac: 13, abilities: [16, 17, 10, 11, 10, 8], actions: [attack("claws", "Claws", 5, "2d6 + 3", "slashing")], damageResistances: ["necrotic"], damageImmunities: ["poison"], conditionImmunities: ["charmed", "exhaustion", "poisoned"] },
    { en: ["Ghast", "A ghoul leader surrounded by a nauseating stench."], fr: ["Blême", "Un chef de goules entouré d'une puanteur écœurante."] }
  ),
  monster(
    "gargoyle",
    { cr: 2, hp: 52, hitDice: [7, 8], ac: 15, abilities: [15, 11, 16, 6, 11, 7], actions: [attack("bite", "Bite", 4, "1d6 + 2", "piercing"), attack("claws", "Claws", 4, "1d6 + 2", "slashing")], damageImmunities: ["poison"], conditionImmunities: ["exhaustion", "petrified", "poisoned"] },
    { en: ["Gargoyle", "A cruel elemental that poses as a statue until prey comes near."], fr: ["Gargouille", "Un élémentaire cruel qui se fait passer pour une statue jusqu'à l'arrivée d'une proie."] }
  ),
  monster(
    "owlbear",
    { cr: 3, hp: 59, hitDice: [7, 10], ac: 13, abilities: [20, 12, 17, 3, 12, 7], actions: [attack("beak", "Beak", 7, "1d10 + 5", "piercing"), attack("claws", "Claws", 7, "2d8 + 5", "slashing")] },
    { en: ["Owlbear", "A monstrous cross of owl and bear, ferocious and territorial."], fr: ["Ours-hibou", "Un croisement monstrueux d'ours et de hibou, féroce et territorial."] }
  ),
  monster(
    "minotaur",
    { cr: 3, hp: 76, hitDice: [9, 10], ac: 14, abilities: [18, 11, 16, 6, 16, 9], actions: [attack("greataxe", "Greataxe", 6, "2d12 + 4", "slashing"), attack("gore", "Gore", 6, "2d8 + 4", "piercing")] },
    { en: ["Minotaur", "A bull-headed labyrinth hunter that charges with its horns."], fr: ["Minotaure", "Un chasseur de labyrinthe à tête de taureau qui charge cornes baissées."] }
  ),
  monster(
    "banshee",
    { cr: 4, hp: 58, hitDice: [13, 8], ac: 12, abilities: [1, 14, 10, 12, 11, 17], actions: [attack("corrupting_touch", "Corrupting Touch", 4, "3d6 + 2", "necrotic"), saveAction("wail", "Wail", "3d6", "psychic", "con", 13)], damageImmunities: ["cold", "necrotic", "poison"], conditionImmunities: ["charmed", "exhaustion", "frightened", "grappled", "paralyzed", "petrified", "poisoned", "prone", "restrained"] },
    { en: ["Banshee", "The spirit of a vain elf whose wail can kill the living."], fr: ["Banshie", "L'esprit d'une elfe vaniteuse dont la plainte peut tuer les vivants."] }
  ),
  monster(
    "troll",
    { cr: 5, hp: 84, hitDice: [8, 10], ac: 15, abilities: [18, 13, 20, 7, 9, 7], actions: [attack("bite", "Bite", 7, "1d6 + 4", "piercing"), attack("claw", "Claw", 7, "2d6 + 4", "slashing")] },
    { en: ["Troll", "A ravenous giant that regenerates unless burned with fire or acid."], fr: ["Troll", "Un géant vorace qui se régénère à moins d'être brûlé par le feu ou l'acide."] }
  ),
  monster(
    "hill_giant",
    { cr: 5, hp: 105, hitDice: [10, 12], ac: 13, abilities: [21, 8, 19, 5, 9, 6], actions: [attack("greatclub", "Greatclub", 8, "3d8 + 5", "bludgeoning"), attack("rock", "Rock", 8, "3d10 + 5", "bludgeoning", "60/240")] },
    { en: ["Hill Giant", "A dim-witted, gluttonous giant that hurls boulders."], fr: ["Géant des collines", "Un géant glouton et peu futé qui lance des rochers."] }
  ),
  monster(
    "medusa",
    { cr: 6, hp: 127, hitDice: [17, 8], ac: 15, abilities: [10, 15, 16, 12, 13, 15], actions: [attack("snake_hair", "Snake Hair", 5, "1d4 + 2", "piercing"), attack("shortsword", "Shortsword", 5, "1d6 + 2", "piercing")] },
    { en: ["Medusa", "A cursed creature with serpent hair whose gaze turns flesh to stone."], fr: ["Méduse", "Une créature maudite à chevelure de serpents dont le regard change la chair en pierre."] }
  ),
  monster(
    "wyvern",
    { cr: 6, hp: 110, hitDice: [13, 10], ac: 13, abilities: [19, 10, 16, 5, 12, 6], actions: [attack("bite", "Bite", 7, "2d6 + 4", "piercing"), attack("stinger", "Stinger", 7, "2d6 + 4", "piercing")] },
    { en: ["Wyvern", "A two-legged dragon cousin with a venomous tail stinger."], fr: ["Vouivre", "Un cousin des dragons à deux pattes doté d'un dard venimeux."] }
  ),
  monster(
    "stone_giant",
    { cr: 7, hp: 126, hitDice: [11, 12], ac: 17, abilities: [23, 15, 20, 10, 12, 9], actions: [attack("greatclub", "Greatclub", 9, "3d8 + 6", "bludgeoning"), attack("rock", "Rock", 9, "4d10 + 6", "bludgeoning", "60/240")], saves: ["dex", "con", "wis"] },
    { en: ["Stone Giant", "A reclusive, artistic giant of deep caverns who hurls rocks."], fr: ["Géant des pierres", "Un géant reclus et artiste des cavernes profondes qui lance des rochers."] }
  ),
  monster(
    "young_green_dragon",
    { cr: 8, hp: 136, hitDice: [16, 10], ac: 18, abilities: [19, 12, 17, 16, 13, 15], actions: [attack("bite", "Bite", 7, "2d10 + 4", "piercing"), saveAction("poison_breath", "Poison Breath (Recharge 5-6)", "12d6", "poison", "con", 14)], saves: ["dex", "con", "wis", "cha"], damageImmunities: ["poison"], conditionImmunities: ["poisoned"] },
    { en: ["Young Green Dragon", "A deceitful forest dragon that breathes clouds of poison."], fr: ["Jeune dragon vert", "Un dragon des forêts fourbe qui souffle des nuages de poison."] }
  ),
  monster(
    "fire_giant",
    { cr: 9, hp: 162, hitDice: [13, 12], ac: 18, abilities: [25, 9, 23, 10, 14, 13], actions: [attack("greatsword", "Greatsword", 11, "6d6 + 7", "slashing"), attack("rock", "Rock", 11, "4d10 + 7", "bludgeoning", "60/240")], saves: ["dex", "con", "cha"], damageImmunities: ["fire"] },
    { en: ["Fire Giant", "A master smith and warrior of volcanic fortresses."], fr: ["Géant du feu", "Un maître forgeron et guerrier des forteresses volcaniques."] }
  ),
  monster(
    "young_red_dragon",
    { cr: 10, hp: 178, hitDice: [17, 10], ac: 18, abilities: [23, 10, 21, 14, 11, 19], actions: [attack("bite", "Bite", 10, "2d10 + 6", "piercing"), saveAction("fire_breath", "Fire Breath (Recharge 5-6)", "16d6", "fire", "dex", 17)], saves: ["dex", "con", "wis", "cha"], damageImmunities: ["fire"] },
    { en: ["Young Red Dragon", "An arrogant young dragon whose breath is a cone of fire."], fr: ["Jeune dragon rouge", "Un jeune dragon arrogant dont le souffle est un cône de feu."] }
  ),
  monster(
    "behir",
    { cr: 11, hp: 168, hitDice: [16, 12], ac: 17, abilities: [23, 16, 18, 7, 14, 12], actions: [attack("bite", "Bite", 10, "3d10 + 6", "piercing"), saveAction("lightning_breath", "Lightning Breath (Recharge 5-6)", "12d10", "lightning", "dex", 16)], damageImmunities: ["lightning"] },
    { en: ["Behir", "A serpentine many-legged predator that spits lightning and swallows prey."], fr: ["Béhir", "Un prédateur serpentiforme à nombreuses pattes qui crache la foudre et avale ses proies."] }
  ),
  monster(
    "archmage",
    { cr: 12, hp: 99, hitDice: [18, 8], ac: 12, abilities: [10, 14, 12, 20, 15, 16], actions: [attack("dagger", "Dagger", 6, "1d4 + 2", "piercing", "20/60")], saves: ["int", "wis"], damageResistances: ["bludgeoning", "piercing", "slashing"] },
    { en: ["Archmage", "A powerful wizard who commands spells up to the 9th level."], fr: ["Archimage", "Un puissant magicien qui maîtrise des sorts jusqu'au niveau 9."] }
  ),
  monster(
    "vampire",
    { cr: 13, hp: 144, hitDice: [17, 8], ac: 16, abilities: [18, 18, 18, 17, 15, 18], actions: [attack("unarmed_strike", "Unarmed Strike", 9, "1d8 + 4", "bludgeoning"), attack("bite", "Bite", 9, "1d6 + 4", "piercing")], saves: ["dex", "wis", "cha"], damageResistances: ["necrotic"], legendaryResistance: 3 },
    { en: ["Vampire", "An undead noble who drinks the blood of the living."], fr: ["Vampire", "Un noble mort-vivant qui boit le sang des vivants."] }
  ),
  monster(
    "adult_black_dragon",
    { cr: 14, hp: 195, hitDice: [17, 12], ac: 19, abilities: [23, 14, 21, 14, 13, 17], actions: [attack("bite", "Bite", 11, "2d10 + 6", "piercing"), saveAction("acid_breath", "Acid Breath (Recharge 5-6)", "12d8", "acid", "dex", 18)], saves: ["dex", "con", "wis", "cha"], damageImmunities: ["acid"], legendaryResistance: 3 },
    { en: ["Adult Black Dragon", "A cruel swamp dragon whose breath is a line of acid."], fr: ["Dragon noir adulte", "Un cruel dragon des marais dont le souffle est une ligne d'acide."] }
  ),
  monster(
    "mummy_lord",
    { cr: 15, hp: 97, hitDice: [13, 8], ac: 17, abilities: [18, 10, 17, 11, 18, 16], actions: [attack("rotting_fist", "Rotting Fist", 9, "3d6 + 4", "bludgeoning")], saves: ["con", "int", "wis", "cha"], damageImmunities: ["necrotic", "poison"], legendaryResistance: 3 },
    { en: ["Mummy Lord", "An undead priest-king who spreads a withering curse."], fr: ["Seigneur momie", "Un prêtre-roi mort-vivant qui répand une malédiction desséchante."] }
  ),
  monster(
    "iron_golem",
    { cr: 16, hp: 210, hitDice: [20, 10], ac: 20, abilities: [24, 9, 20, 3, 11, 1], actions: [attack("slam", "Slam", 13, "3d8 + 7", "bludgeoning"), saveAction("poison_breath", "Poison Breath (Recharge 6)", "10d8", "poison", "con", 19)], damageImmunities: ["fire", "poison", "psychic"] },
    { en: ["Iron Golem", "A towering iron construct that heals when exposed to fire."], fr: ["Golem de fer", "Une imposante créature artificielle de fer que le feu guérit."] }
  ),
  monster(
    "balor",
    { cr: 19, hp: 262, hitDice: [21, 12], ac: 19, abilities: [26, 15, 22, 20, 16, 22], actions: [attack("longsword", "Longsword", 14, "3d8 + 8", "slashing"), attack("whip", "Whip", 14, "2d6 + 8", "slashing")], saves: ["str", "con", "wis", "cha"], damageResistances: ["cold", "lightning"], damageImmunities: ["fire", "poison"] },
    { en: ["Balor", "A towering demon of flame and shadow wielding a lightning sword and a fiery whip."], fr: ["Balor", "Un démon colossal de flammes et d'ombre armé d'une épée de foudre et d'un fouet ardent."] }
  ),
  monster(
    "pit_fiend",
    { cr: 20, hp: 300, hitDice: [24, 10], ac: 19, abilities: [26, 14, 24, 22, 18, 24], actions: [attack("mace", "Mace", 14, "2d6 + 8", "bludgeoning"), attack("bite", "Bite", 14, "4d6 + 8", "piercing")], saves: ["dex", "con", "wis"], damageResistances: ["cold"], damageImmunities: ["fire", "poison"] },
    { en: ["Pit Fiend", "A general of the Nine Hells with a venomous bite and a fearsome aura."], fr: ["Diantrefosse", "Un général des Neuf Enfers à la morsure venimeuse et à l'aura terrifiante."] }
  ),
];

/** Curated SRD 5.1 entries merged into `SYSTEM_SRD` by `compendium.ts`. */
export const SRD_CURATED_CONTENT: readonly CompendiumEntry[] = [
  ...CLASSES,
  ...SPECIES,
  ...BACKGROUNDS,
  ...CONDITIONS,
  ...SPELLS,
  ...ITEMS,
  ...MONSTERS,
];
