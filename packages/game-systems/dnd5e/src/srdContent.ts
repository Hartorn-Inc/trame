/**
 * ============================================================================
 * CURATED BILINGUAL SRD 5.2.1 CONTENT (srdContent.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Declares the curated SystemSRD catalog that lets a table run a campaign
 * without homebrew: the 12 classes, 11 species (9 SRD + 2 TRAME originals),
 * 9 backgrounds (4 SRD + 5 TRAME originals), 17 feats, 15 conditions, spells
 * from cantrips to level 9, weapons with their Weapon Mastery property, armor,
 * adventuring gear, and monsters from CR 0 to CR 20. `compendium.ts` merges
 * these entries with its hand-written starter entries into `SYSTEM_SRD`.
 *
 * Open Game Content Attribution:
 * This work includes material from the System Reference Document 5.2.1
 * ("SRD 5.2.1") by Wizards of the Coast LLC, available at
 * https://www.dndbeyond.com/srd, licensed under CC-BY-4.0. Entries marked
 * `source: "srd-5.1"` come from the System Reference Document 5.1, also
 * licensed under CC-BY-4.0, where SRD 5.2.1 has no equivalent. Entries marked
 * `source: "trame-original"` are original TRAME content (ADR-0038).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `English Canonical, French Metadata`:
 *      - `name`, `data` and `i18n.en` are English; French appears only in
 *        `i18n.fr` (grill decision G3). Descriptions are short paraphrases.
 *   2. `Stable Namespaced Ids`:
 *      - Every id is `srd:<kind>:<snake_key>` and doubles as the slug, so
 *        campaign homebrew can shadow it through `CompendiumResolver`.
 *        Renamed SRD 5.2.1 monsters (Kobold Warrior, Hobgoblin Warrior, ...)
 *        keep their earlier ids.
 *   3. `Class Spell Coverage`:
 *      - Each caster class has at least one spell at every spell level it can
 *        cast (slots plus Warlock Mystic Arcanum), so level-up never offers an
 *        empty spell list.
 *   4. `Monster Sheets Are Derivable`:
 *      - Monsters use `armorKind: "natural"` with the stat-block AC, and a
 *        proficiency-equivalent `level` derived from CR, so
 *        `computeDnd5eSheetDerived` reproduces the stat block.
 *   5. `Unqualified Damage Resistances`:
 *      - SRD 5.2.1 dropped "nonmagical bludgeoning, piercing and slashing"
 *        qualifiers. Resistances and immunities are plain damage types; a
 *        stat block that only had qualified physical resistances (the SRD 5.1
 *        Archmage, Balor, Gargoyle) now has none.
 *   6. `Origins Come From origins.ts`:
 *      - Species, backgrounds and feats render `SRD_SPECIES`, `BACKGROUNDS`
 *        and `SRD_FEATS`, so the compendium and level-up rules cannot drift.
 * ============================================================================
 */

import type { CompendiumEntityType, CompendiumEntry } from "./compendium.ts";
import { SRD_CLASS_PROGRESSION, type SrdClassId } from "./progression.ts";
import {
  BACKGROUNDS,
  SRD_FEATS,
  SRD_SPECIES,
  type BackgroundId,
  type SrdFeatId,
  type SrdSpeciesId,
} from "./origins.ts";
import type { AbilityId, DamageType } from "./types.ts";

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

const SPECIES_TEXT: Record<SrdSpeciesId, Bilingual> = {
  dragonborn: {
    en: ["Dragonborn", "Draconic humanoids who breathe destructive energy and later sprout spectral wings."],
    fr: ["Drakéide", "Des humanoïdes draconiques qui soufflent une énergie destructrice et se dotent plus tard d'ailes spectrales."],
  },
  dwarf: {
    en: ["Dwarf", "Hardy folk of stone with deep darkvision, poison resilience and extra hit points."],
    fr: ["Nain", "Un peuple robuste de la pierre, doté d'une vision dans le noir étendue, d'une résistance au poison et de points de vie supplémentaires."],
  },
  elf: {
    en: ["Elf", "Long-lived people of the Feywild whose lineage grants innate magic."],
    fr: ["Elfe", "Un peuple longévif issu de la Féerie, dont la lignée confère une magie innée."],
  },
  gnome: {
    en: ["Gnome", "Small, clever people with magical cunning against mind-affecting spells."],
    fr: ["Gnome", "Un petit peuple astucieux, protégé par sa ruse contre la magie qui affecte l'esprit."],
  },
  goliath: {
    en: ["Goliath", "Towering descendants of giants who can briefly grow to Large size."],
    fr: ["Goliath", "D'imposants descendants des géants, capables de prendre brièvement une taille G."],
  },
  half_elf: {
    en: [
      "Half-Elf",
      "Bridge-walkers of two worlds whose Dual Heritage adaptability and Fey Resilience steady them against beguiling magic.",
    ],
    fr: [
      "Demi-Elfe",
      "Héritiers de deux mondes dont le Double héritage adaptable et la Résilience féerique protègent l'esprit des enchantements.",
    ],
  },
  halfling: {
    en: ["Halfling", "Small, brave and lucky folk who slip past larger creatures."],
    fr: ["Halfelin", "Un petit peuple courageux et chanceux qui se faufile entre les créatures plus grandes."],
  },
  human: {
    en: ["Human", "Resourceful and versatile people who gain an extra skill and an Origin feat."],
    fr: ["Humain", "Un peuple plein de ressources et polyvalent, qui gagne une compétence et un don d'origine supplémentaires."],
  },
  orc: {
    en: ["Orc", "Tireless people with adrenaline rushes who refuse to fall when struck down."],
    fr: ["Orc", "Un peuple infatigable, porté par des poussées d'adrénaline, qui refuse de tomber lorsqu'il est terrassé."],
  },
  radiant_scion: {
    en: [
      "Radiant Scion",
      "Mortals touched by upper-planar light who kindle a Celestial Spark in darkness and mend allies with a Guiding Touch.",
    ],
    fr: [
      "Héritier radieux",
      "Mortels marqués par une clarté céleste, capables d'éveiller une Étincelle céleste dans l'ombre et d'apaiser les blessures d'un Toucher bienveillant.",
    ],
  },
  tiefling: {
    en: ["Tiefling", "People touched by the Lower Planes who resist harm and wield a fiendish legacy."],
    fr: ["Tieffelin", "Un peuple marqué par les plans inférieurs, résistant et dépositaire d'un héritage fiélon."],
  },
};

const SPECIES: CompendiumEntry[] = (Object.keys(SRD_SPECIES) as SrdSpeciesId[]).map((key) =>
  srdEntry("species", "species", key, { ...SRD_SPECIES[key] }, SPECIES_TEXT[key])
);

// ============================================================================
// BACKGROUNDS
// ============================================================================

const BACKGROUND_TEXT: Record<BackgroundId, Bilingual> = {
  acolyte: {
    en: ["Acolyte", "You served in a temple, learning sacred rites and a little divine magic."],
    fr: ["Acolyte", "Vous avez servi dans un temple, où vous avez appris les rites sacrés et un peu de magie divine."],
  },
  criminal: {
    en: ["Criminal", "You made ends meet in dark alleys as a pickpocket or burglar."],
    fr: ["Criminel", "Vous avez survécu dans les ruelles sombres comme pickpocket ou cambrioleur."],
  },
  sage: {
    en: ["Sage", "You spent your formative years among manuscripts, learning lore and a little arcane magic."],
    fr: ["Sage", "Vous avez passé vos jeunes années parmi les manuscrits, à étudier le savoir et un peu de magie profane."],
  },
  soldier: {
    en: ["Soldier", "You trained for war and learned to strike hard before the enemy strikes first."],
    fr: ["Soldat", "Vous avez été formé à la guerre et appris à frapper fort avant que l'ennemi ne le fasse."],
  },
  artisan: {
    en: ["Artisan", "You honed a craft at forge or workbench, judging materials keenly and bargaining fairly with patrons."],
    fr: ["Artisan", "Vous avez exercé un métier à la forge ou à l'établi, jaugeant les matériaux d'un œil sûr et négociant avec vos commanditaires."],
  },
  caravan_guide: {
    en: ["Caravan Guide", "You led merchant caravans across wild roads, reading the land and tending pack animals."],
    fr: ["Guide de caravane", "Vous avez mené des caravanes marchandes sur des routes sauvages, en lisant le terrain et en soignant les bêtes de somme."],
  },
  house_guardian: {
    en: ["House Guardian", "You stood watch over a sworn household, trained to hold the line and tend the wounded after a clash."],
    fr: ["Gardien de lignée", "Vous avez veillé sur une maisonnée jurée, formé à tenir la ligne et à panser les blessés après l'affrontement."],
  },
  lamplighter: {
    en: ["Lamplighter", "You kept a city's lamps burning through the night and learned to notice what moves in the dark."],
    fr: ["Allumeur de réverbères", "Vous avez entretenu les lanternes d'une cité toute la nuit et appris à repérer ce qui bouge dans l'ombre."],
  },
  merchant: {
    en: ["Merchant", "You traded goods between market towns and ports, reading buyers at a glance and charting profitable routes."],
    fr: ["Marchand", "Vous avez négocié des marchandises de bourg en port, lisant vos interlocuteurs au premier coup d'œil et traçant des routes rentables."],
  },
};

const BACKGROUND_ENTRIES: CompendiumEntry[] = (Object.keys(BACKGROUNDS) as BackgroundId[]).map((key) =>
  srdEntry("background", "background", key, { ...BACKGROUNDS[key] }, BACKGROUND_TEXT[key])
);

// ============================================================================
// FEATS
// ============================================================================

const FEAT_TEXT: Record<SrdFeatId, Bilingual> = {
  alert: {
    en: ["Alert", "Add your Proficiency Bonus to Initiative and swap Initiative with a willing ally."],
    fr: ["Vigilant", "Ajoutez votre bonus de maîtrise à l'Initiative et échangez votre Initiative avec un allié consentant."],
  },
  magic_initiate: {
    en: ["Magic Initiate", "Learn two cantrips and a level 1 spell from the Cleric, Druid or Wizard list."],
    fr: ["Initié à la magie", "Apprenez deux sorts mineurs et un sort de niveau 1 de la liste du clerc, du druide ou du magicien."],
  },
  savage_attacker: {
    en: ["Savage Attacker", "Once per turn, roll a weapon's damage dice twice and use either roll."],
    fr: ["Agresseur sauvage", "Une fois par tour, lancez deux fois les dés de dégâts d'une arme et gardez le résultat de votre choix."],
  },
  skilled: {
    en: ["Skilled", "Gain proficiency in any combination of three skills or tools."],
    fr: ["Doué", "Gagnez la maîtrise de trois compétences ou outils de votre choix."],
  },
  ability_score_improvement: {
    en: ["Ability Score Improvement", "Increase one ability score by 2, or two ability scores by 1 (maximum 20)."],
    fr: ["Amélioration de caractéristique", "Augmentez une valeur de caractéristique de 2, ou deux valeurs de 1 (maximum 20)."],
  },
  grappler: {
    en: ["Grappler", "Increase Strength or Dexterity by 1; punch and grab in one strike and drag grappled foes."],
    fr: ["Lutteur", "Augmentez la Force ou la Dextérité de 1 ; frappez et agrippez d'un même coup et déplacez les créatures agrippées."],
  },
  archery: {
    en: ["Archery", "Fighting Style: +2 bonus to attack rolls with Ranged weapons."],
    fr: ["Archerie", "Style de combat : bonus de +2 aux jets d'attaque avec les armes à distance."],
  },
  defense: {
    en: ["Defense", "Fighting Style: +1 bonus to AC while wearing Light, Medium or Heavy armor."],
    fr: ["Défense", "Style de combat : bonus de +1 à la CA en portant une armure légère, intermédiaire ou lourde."],
  },
  great_weapon_fighting: {
    en: ["Great Weapon Fighting", "Fighting Style: treat a 1 or 2 on a two-handed weapon's damage die as a 3."],
    fr: ["Combat avec une arme à deux mains", "Style de combat : traitez un 1 ou un 2 sur un dé de dégâts d'une arme à deux mains comme un 3."],
  },
  two_weapon_fighting: {
    en: ["Two-Weapon Fighting", "Fighting Style: add your ability modifier to the extra Light weapon attack's damage."],
    fr: ["Combat à deux armes", "Style de combat : ajoutez votre modificateur de caractéristique aux dégâts de l'attaque supplémentaire avec une arme légère."],
  },
  boon_of_combat_prowess: {
    en: ["Boon of Combat Prowess", "Epic Boon: +1 to an ability (max 30); once per turn, turn a miss into a hit."],
    fr: ["Faveur de prouesse martiale", "Faveur épique : +1 à une caractéristique (max 30) ; une fois par tour, transformez un échec en réussite."],
  },
  boon_of_dimensional_travel: {
    en: ["Boon of Dimensional Travel", "Epic Boon: +1 to an ability (max 30); teleport 30 feet after attacking or casting."],
    fr: ["Faveur de voyage dimensionnel", "Faveur épique : +1 à une caractéristique (max 30) ; téléportez-vous de 9 mètres après avoir attaqué ou lancé un sort."],
  },
  boon_of_fate: {
    en: ["Boon of Fate", "Epic Boon: +1 to an ability (max 30); add or subtract 2d4 from a nearby D20 Test."],
    fr: ["Faveur du destin", "Faveur épique : +1 à une caractéristique (max 30) ; ajoutez ou retirez 2d4 à un test de d20 proche."],
  },
  boon_of_irresistible_offense: {
    en: ["Boon of Irresistible Offense", "Epic Boon: +1 Strength or Dexterity (max 30); your physical damage ignores Resistance."],
    fr: ["Faveur d'offensive irrésistible", "Faveur épique : +1 en Force ou Dextérité (max 30) ; vos dégâts physiques ignorent la résistance."],
  },
  boon_of_spell_recall: {
    en: ["Boon of Spell Recall", "Epic Boon: +1 Intelligence, Wisdom or Charisma (max 30); cast a low-level spell without expending the slot."],
    fr: ["Faveur de rappel de sort", "Faveur épique : +1 en Intelligence, Sagesse ou Charisme (max 30) ; lancez un sort de bas niveau sans dépenser l'emplacement."],
  },
  boon_of_the_night_spirit: {
    en: ["Boon of the Night Spirit", "Epic Boon: +1 to an ability (max 30); become Invisible in Dim Light or Darkness."],
    fr: ["Faveur de l'esprit nocturne", "Faveur épique : +1 à une caractéristique (max 30) ; devenez invisible dans la pénombre ou les ténèbres."],
  },
  boon_of_truesight: {
    en: ["Boon of Truesight", "Epic Boon: +1 to an ability (max 30); gain Truesight with a range of 60 feet."],
    fr: ["Faveur de vision véritable", "Faveur épique : +1 à une caractéristique (max 30) ; gagnez la vision véritable sur 18 mètres."],
  },
};

const FEATS: CompendiumEntry[] = (Object.keys(SRD_FEATS) as SrdFeatId[]).map((key) =>
  srdEntry("feat", "feat", key, { ...SRD_FEATS[key] }, FEAT_TEXT[key])
);

// ============================================================================
// CONDITIONS
// ============================================================================

function condition(key: string, text: Bilingual, data: Record<string, unknown> = {}): CompendiumEntry {
  return srdEntry("condition", "condition", key, data, text);
}

const CONDITIONS: CompendiumEntry[] = [
  condition("blinded", {
    en: ["Blinded", "Can't see and fails checks that need sight; attacks against it have Advantage and its attacks have Disadvantage."],
    fr: ["Aveuglé", "Ne voit rien et échoue aux tests nécessitant la vue ; les attaques contre lui ont l'avantage et ses attaques le désavantage."],
  }),
  condition("charmed", {
    en: ["Charmed", "Can't attack or harm the charmer, who has Advantage on social checks against it."],
    fr: ["Charmé", "Ne peut ni attaquer ni nuire à celui qui l'a charmé, qui a l'avantage aux tests sociaux contre lui."],
  }),
  condition("deafened", {
    en: ["Deafened", "Can't hear and automatically fails checks that require hearing."],
    fr: ["Assourdi", "N'entend rien et échoue automatiquement aux tests nécessitant l'ouïe."],
  }),
  condition(
    "exhaustion",
    {
      en: [
        "Exhaustion",
        "Cumulative levels 1-6. Each D20 Test (attack roll, ability check, saving throw) is reduced by 2 × the level and Speed by 5 feet × the level; passive scores and spell save DCs are unaffected. Level 6 is death. A Long Rest removes 1 level.",
      ],
      fr: [
        "Épuisement",
        "Niveaux cumulatifs de 1 à 6. Chaque test de d20 (jet d'attaque, test de caractéristique, jet de sauvegarde) est réduit de 2 × le niveau et la vitesse de 1,5 mètre × le niveau ; les valeurs passives et le DD des sorts ne changent pas. Le niveau 6 entraîne la mort. Un repos long retire 1 niveau.",
      ],
    },
    { maxLevel: 6, d20PenaltyPerLevel: 2, speedPenaltyFtPerLevel: 5 }
  ),
  condition("frightened", {
    en: ["Frightened", "Disadvantage on ability checks and attack rolls while the source of fear is in sight; can't willingly move closer to it."],
    fr: ["Effrayé", "Désavantage aux tests de caractéristique et aux jets d'attaque tant que la source de sa peur est visible ; ne peut pas s'en approcher volontairement."],
  }),
  condition("grappled", {
    en: ["Grappled", "Speed 0; Disadvantage on attacks against anyone but the grappler, who can drag it along."],
    fr: ["Agrippé", "Vitesse 0 ; désavantage aux attaques contre toute autre cible que l'agrippeur, qui peut l'entraîner avec lui."],
  }),
  condition("incapacitated", {
    en: ["Incapacitated", "Can't take actions, Bonus Actions or Reactions, can't speak, and loses Concentration."],
    fr: ["Neutralisé", "Ne peut entreprendre ni action, ni action bonus, ni réaction, ne peut pas parler et perd sa concentration."],
  }),
  condition("invisible", {
    en: ["Invisible", "Can't be seen; Advantage on Initiative and attacks, attacks against it have Disadvantage."],
    fr: ["Invisible", "Impossible à voir ; avantage à l'Initiative et aux attaques, les attaques contre lui ont le désavantage."],
  }),
  condition("paralyzed", {
    en: ["Paralyzed", "Incapacitated with Speed 0, fails Strength and Dexterity saves; hits from within 5 feet are critical."],
    fr: ["Paralysé", "Neutralisé, vitesse 0, échoue aux sauvegardes de Force et de Dextérité ; les coups portés à 1,5 mètre sont critiques."],
  }),
  condition("petrified", {
    en: ["Petrified", "Turned to stone: Incapacitated, Speed 0, fails Strength and Dexterity saves and resists all damage."],
    fr: ["Pétrifié", "Changé en pierre : neutralisé, vitesse 0, échoue aux sauvegardes de Force et de Dextérité et résiste à tous les dégâts."],
  }),
  condition("poisoned", {
    en: ["Poisoned", "Disadvantage on attack rolls and ability checks."],
    fr: ["Empoisonné", "Désavantage aux jets d'attaque et aux tests de caractéristique."],
  }),
  condition("prone", {
    en: ["Prone", "Can only crawl or stand up; Disadvantage on attacks; attacks from within 5 feet have Advantage, others Disadvantage."],
    fr: ["À terre", "Ne peut que ramper ou se relever ; désavantage aux attaques ; les attaques à 1,5 mètre ont l'avantage, les autres le désavantage."],
  }),
  condition("restrained", {
    en: ["Restrained", "Speed 0; attacks against it have Advantage, its attacks and Dexterity saves have Disadvantage."],
    fr: ["Entravé", "Vitesse 0 ; les attaques contre lui ont l'avantage, ses attaques et ses sauvegardes de Dextérité le désavantage."],
  }),
  condition("stunned", {
    en: ["Stunned", "Incapacitated, fails Strength and Dexterity saves; attacks against it have Advantage."],
    fr: ["Étourdi", "Neutralisé, échoue aux sauvegardes de Force et de Dextérité ; les attaques contre lui ont l'avantage."],
  }),
  condition("unconscious", {
    en: ["Unconscious", "Incapacitated, Prone and unaware with Speed 0; fails Strength and Dexterity saves and hits from within 5 feet are critical."],
    fr: ["Inconscient", "Neutralisé, à terre et inconscient de son environnement, vitesse 0 ; échoue aux sauvegardes de Force et de Dextérité et les coups à 1,5 mètre sont critiques."],
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
  /** Separate damage components when a spell deals several types (Meteor Swarm). */
  damageComponents?: { dice: string; damageType: DamageType }[];
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
    { level: 0, school: "enchantment", classes: ["bard"], castingTime: "1 action", range: "60 feet", components: ["V"], duration: "Instantaneous", damageDice: "1d6", damageType: "psychic", saveAbility: "wis" },
    {
      en: ["Vicious Mockery", "Insults laced with magic deal 1d6 psychic damage and hinder the target's next attack."],
      fr: ["Moquerie cruelle", "Des insultes chargées de magie infligent 1d6 dégâts psychiques et gênent la prochaine attaque de la cible."],
    }
  ),
  spell(
    "produce_flame",
    { level: 0, school: "conjuration", classes: ["druid"], castingTime: "1 bonus action", range: "Self", components: ["V", "S"], duration: "10 minutes", damageDice: "1d8", damageType: "fire" },
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
      en: ["Guidance", "A willing creature adds 1d4 to ability checks using one chosen skill."],
      fr: ["Assistance", "Une créature consentante ajoute 1d4 aux tests de caractéristique utilisant une compétence choisie."],
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
    { level: 1, school: "abjuration", classes: ["bard", "cleric", "druid"], castingTime: "1 bonus action", range: "60 feet", components: ["V"], duration: "Instantaneous", healDice: "2d4" },
    {
      en: ["Healing Word", "A creature you can see regains 2d4 + your spellcasting modifier hit points."],
      fr: ["Mot de guérison", "Une créature visible récupère 2d4 + votre modificateur d'incantation points de vie."],
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
    { level: 1, school: "enchantment", classes: ["bard", "sorcerer", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V", "S", "M"], duration: "Concentration, up to 1 minute", concentration: true, saveAbility: "wis" },
    {
      en: ["Sleep", "Creatures in a 5-foot sphere that fail a Wisdom save are Incapacitated, then Unconscious if they fail again."],
      fr: ["Sommeil", "Les créatures d'une sphère de 1,5 mètre qui ratent un jet de Sagesse sont neutralisées, puis inconscientes si elles échouent à nouveau."],
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
    { level: 1, school: "conjuration", classes: ["druid", "ranger"], castingTime: "1 action", range: "Self", components: ["V", "S", "M"], duration: "24 hours" },
    {
      en: ["Goodberry", "Ten magic berries each restore 1 hit point and a day's nourishment."],
      fr: ["Baies nourricières", "Dix baies magiques rendent chacune 1 point de vie et nourrissent pour la journée."],
    }
  ),
  spell(
    "detect_magic",
    { level: 1, school: "divination", classes: ["bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "Self", components: ["V", "S"], duration: "Concentration, up to 10 minutes", concentration: true, ritual: true },
    {
      en: ["Detect Magic", "You sense the presence of magic within 30 feet."],
      fr: ["Détection de la magie", "Vous percevez la présence de magie à 9 mètres ou moins."],
    }
  ),
  // 2nd level
  spell(
    "spiritual_weapon",
    { level: 2, school: "evocation", classes: ["cleric"], castingTime: "1 bonus action", range: "60 feet", components: ["V", "S"], duration: "Concentration, up to 1 minute", concentration: true, damageDice: "1d8", damageType: "force" },
    {
      en: ["Spiritual Weapon", "A floating spectral weapon strikes for 1d8 + your spellcasting modifier force damage."],
      fr: ["Arme spirituelle", "Une arme spectrale flottante frappe pour 1d8 + votre modificateur d'incantation dégâts de force."],
    }
  ),
  spell(
    "lesser_restoration",
    { level: 2, school: "abjuration", classes: ["bard", "cleric", "druid", "paladin", "ranger"], castingTime: "1 bonus action", range: "Touch", components: ["V", "S"], duration: "Instantaneous" },
    {
      en: ["Lesser Restoration", "Ends the Blinded, Deafened, Paralyzed or Poisoned condition on a creature."],
      fr: ["Restauration partielle", "Met fin à l'état aveuglé, assourdi, paralysé ou empoisonné d'une créature."],
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
    { level: 2, school: "abjuration", classes: ["bard", "cleric", "druid", "paladin", "ranger"], castingTime: "1 action", range: "30 feet", components: ["V", "S", "M"], duration: "8 hours" },
    {
      en: ["Aid", "Up to three creatures gain 5 to their current and maximum hit points."],
      fr: ["Aide", "Jusqu'à trois créatures gagnent 5 points de vie actuels et maximum."],
    }
  ),
  // 3rd level
  spell(
    "dispel_magic",
    { level: 3, school: "abjuration", classes: ["bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "120 feet", components: ["V", "S"], duration: "Instantaneous" },
    {
      en: ["Dispel Magic", "Ends spells of level 3 or lower on a target; higher-level spells need a check."],
      fr: ["Dissipation de la magie", "Met fin aux sorts de niveau 3 ou moins sur une cible ; les sorts supérieurs exigent un test."],
    }
  ),
  spell(
    "revivify",
    { level: 3, school: "necromancy", classes: ["cleric", "druid", "paladin", "ranger"], castingTime: "1 action", range: "Touch", components: ["V", "S", "M"], duration: "Instantaneous" },
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
    { level: 3, school: "conjuration", classes: ["druid", "ranger"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Concentration, up to 10 minutes", concentration: true, damageDice: "3d10", damageType: "slashing", saveAbility: "dex" },
    {
      en: ["Conjure Animals", "A spectral pack of animal spirits moves with you and deals 3d10 slashing damage to nearby foes."],
      fr: ["Invocation d'animaux", "Une meute spectrale d'esprits animaux vous accompagne et inflige 3d10 dégâts tranchants aux ennemis proches."],
    }
  ),
  // 4th level
  spell(
    "banishment",
    { level: 4, school: "abjuration", classes: ["cleric", "paladin", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "30 feet", components: ["V", "S", "M"], duration: "Concentration, up to 1 minute", concentration: true, saveAbility: "cha" },
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
    { level: 5, school: "abjuration", classes: ["bard", "cleric", "druid"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Instantaneous", healDice: "5d8" },
    {
      en: ["Mass Cure Wounds", "Up to six creatures each regain 5d8 + your spellcasting modifier hit points."],
      fr: ["Soins de groupe", "Jusqu'à six créatures récupèrent chacune 5d8 + votre modificateur d'incantation points de vie."],
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
    "circle_of_death",
    { level: 6, school: "necromancy", classes: ["sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "150 feet", components: ["V", "S", "M"], duration: "Instantaneous", damageDice: "8d8", damageType: "necrotic", saveAbility: "con" },
    {
      en: ["Circle of Death", "Negative energy fills a 60-foot-radius sphere, dealing 8d8 necrotic damage on a failed Constitution save."],
      fr: ["Cercle de mort", "De l'énergie négative emplit une sphère de 18 mètres de rayon et inflige 8d8 dégâts nécrotiques en cas d'échec à un jet de Constitution."],
    }
  ),
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
    { level: 6, school: "abjuration", classes: ["cleric", "druid"], castingTime: "1 action", range: "60 feet", components: ["V", "S"], duration: "Instantaneous" },
    {
      en: ["Heal", "A creature regains 70 hit points and is cured of the Blinded, Deafened and Poisoned conditions."],
      fr: ["Guérison", "Une créature récupère 70 points de vie et est guérie des états aveuglé, assourdi et empoisonné."],
    }
  ),
  spell(
    "mass_suggestion",
    { level: 6, school: "enchantment", classes: ["bard", "sorcerer", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V", "M"], duration: "24 hours", saveAbility: "wis" },
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
    { level: 8, school: "evocation", classes: ["cleric", "druid", "sorcerer", "wizard"], castingTime: "1 action", range: "150 feet", components: ["V", "S", "M"], duration: "Instantaneous", damageDice: "12d6", damageType: "radiant", saveAbility: "con" },
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
    { level: 8, school: "transmutation", classes: ["cleric", "druid", "sorcerer"], castingTime: "1 action", range: "500 feet", components: ["V", "S", "M"], duration: "Concentration, up to 1 minute", concentration: true, saveAbility: "dex" },
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
    { level: 9, school: "evocation", classes: ["sorcerer", "wizard"], castingTime: "1 action", range: "1 mile", components: ["V", "S"], duration: "Instantaneous", damageComponents: [{ dice: "20d6", damageType: "fire" }, { dice: "20d6", damageType: "bludgeoning" }], saveAbility: "dex" },
    {
      en: ["Meteor Swarm", "Four blazing orbs: each creature in a 40-foot sphere takes 20d6 fire plus 20d6 bludgeoning damage (half on a Dexterity save)."],
      fr: ["Nuée de météores", "Quatre orbes enflammés : chaque créature dans une sphère de 12 mètres subit 20d6 dégâts de feu et 20d6 dégâts contondants (moitié sur une sauvegarde de Dextérité)."],
    }
  ),
  spell(
    "power_word_kill",
    { level: 9, school: "enchantment", classes: ["bard", "sorcerer", "warlock", "wizard"], castingTime: "1 action", range: "60 feet", components: ["V"], duration: "Instantaneous" },
    {
      en: ["Power Word Kill", "A creature with 100 hit points or fewer dies; otherwise it takes 12d12 psychic damage."],
      fr: ["Mot de pouvoir mortel", "Une créature ayant 100 points de vie ou moins meurt ; sinon, elle subit 12d12 dégâts psychiques."],
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
  /** SRD 5.2.1 Weapon Mastery property, usable by classes with Weapon Mastery. */
  mastery: "cleave" | "graze" | "nick" | "push" | "sap" | "slow" | "topple" | "vex";
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
    { category: "simple", damage: "1d4", damageType: "bludgeoning", properties: ["light"], mastery: "slow", weight: 2, cost: "1 sp" },
    { en: ["Club", "A simple melee weapon dealing 1d4 bludgeoning damage."], fr: ["Gourdin", "Une arme courante de corps à corps infligeant 1d4 dégâts contondants."] }
  ),
  weapon(
    "quarterstaff",
    { category: "simple", damage: "1d6", versatileDamage: "1d8", damageType: "bludgeoning", properties: ["versatile"], mastery: "topple", weight: 4, cost: "2 sp" },
    { en: ["Quarterstaff", "A versatile staff dealing 1d6 bludgeoning damage (1d8 two-handed)."], fr: ["Bâton", "Un bâton polyvalent infligeant 1d6 dégâts contondants (1d8 à deux mains)."] }
  ),
  weapon(
    "mace",
    { category: "simple", damage: "1d6", damageType: "bludgeoning", properties: [], mastery: "sap", weight: 4, cost: "5 gp" },
    { en: ["Mace", "A simple melee weapon dealing 1d6 bludgeoning damage."], fr: ["Masse d'armes", "Une arme courante de corps à corps infligeant 1d6 dégâts contondants."] }
  ),
  weapon(
    "handaxe",
    { category: "simple", damage: "1d6", damageType: "slashing", properties: ["light", "thrown"], mastery: "vex", range: "20/60", weight: 2, cost: "5 gp" },
    { en: ["Handaxe", "A light throwing axe dealing 1d6 slashing damage (range 20/60)."], fr: ["Hachette", "Une hache légère de lancer infligeant 1d6 dégâts tranchants (portée 6/18 m)."] }
  ),
  weapon(
    "javelin",
    { category: "simple", damage: "1d6", damageType: "piercing", properties: ["thrown"], mastery: "slow", range: "30/120", weight: 2, cost: "5 sp" },
    { en: ["Javelin", "A thrown spear dealing 1d6 piercing damage (range 30/120)."], fr: ["Javeline", "Une lance de jet infligeant 1d6 dégâts perforants (portée 9/36 m)."] }
  ),
  weapon(
    "spear",
    { category: "simple", damage: "1d6", versatileDamage: "1d8", damageType: "piercing", properties: ["thrown", "versatile"], mastery: "sap", range: "20/60", weight: 3, cost: "1 gp" },
    { en: ["Spear", "A versatile spear dealing 1d6 piercing damage (1d8 two-handed)."], fr: ["Lance", "Une lance polyvalente infligeant 1d6 dégâts perforants (1d8 à deux mains)."] }
  ),
  weapon(
    "rapier",
    { category: "martial", damage: "1d8", damageType: "piercing", properties: ["finesse"], mastery: "vex", weight: 2, cost: "25 gp" },
    { en: ["Rapier", "A finesse blade dealing 1d8 piercing damage."], fr: ["Rapière", "Une lame de finesse infligeant 1d8 dégâts perforants."] }
  ),
  weapon(
    "shortsword",
    { category: "martial", damage: "1d6", damageType: "piercing", properties: ["finesse", "light"], mastery: "vex", weight: 2, cost: "10 gp" },
    { en: ["Shortsword", "A light finesse blade dealing 1d6 piercing damage."], fr: ["Épée courte", "Une lame légère de finesse infligeant 1d6 dégâts perforants."] }
  ),
  weapon(
    "scimitar",
    { category: "martial", damage: "1d6", damageType: "slashing", properties: ["finesse", "light"], mastery: "nick", weight: 3, cost: "25 gp" },
    { en: ["Scimitar", "A curved light blade dealing 1d6 slashing damage."], fr: ["Cimeterre", "Une lame courbe et légère infligeant 1d6 dégâts tranchants."] }
  ),
  weapon(
    "battleaxe",
    { category: "martial", damage: "1d8", versatileDamage: "1d10", damageType: "slashing", properties: ["versatile"], mastery: "topple", weight: 4, cost: "10 gp" },
    { en: ["Battleaxe", "A versatile axe dealing 1d8 slashing damage (1d10 two-handed)."], fr: ["Hache d'armes", "Une hache polyvalente infligeant 1d8 dégâts tranchants (1d10 à deux mains)."] }
  ),
  weapon(
    "warhammer",
    { category: "martial", damage: "1d8", versatileDamage: "1d10", damageType: "bludgeoning", properties: ["versatile"], mastery: "push", weight: 5, cost: "15 gp" },
    { en: ["Warhammer", "A versatile hammer dealing 1d8 bludgeoning damage (1d10 two-handed)."], fr: ["Marteau de guerre", "Un marteau polyvalent infligeant 1d8 dégâts contondants (1d10 à deux mains)."] }
  ),
  weapon(
    "greataxe",
    { category: "martial", damage: "1d12", damageType: "slashing", properties: ["heavy", "two-handed"], mastery: "cleave", weight: 7, cost: "30 gp" },
    { en: ["Greataxe", "A heavy two-handed axe dealing 1d12 slashing damage."], fr: ["Grande hache", "Une lourde hache à deux mains infligeant 1d12 dégâts tranchants."] }
  ),
  weapon(
    "heavy_crossbow",
    { category: "martial", damage: "1d10", damageType: "piercing", properties: ["ammunition", "heavy", "loading", "two-handed"], mastery: "push", range: "100/400", weight: 18, cost: "50 gp" },
    { en: ["Heavy Crossbow", "A heavy ranged weapon dealing 1d10 piercing damage (range 100/400)."], fr: ["Arbalète lourde", "Une arme à distance lourde infligeant 1d10 dégâts perforants (portée 30/120 m)."] }
  ),
  weapon(
    "sling",
    { category: "simple", damage: "1d4", damageType: "bludgeoning", properties: ["ammunition"], mastery: "slow", range: "30/120", weight: 0, cost: "1 sp" },
    { en: ["Sling", "A simple ranged weapon hurling bullets for 1d4 bludgeoning damage (range 30/120)."], fr: ["Fronde", "Une arme à distance courante lançant des billes pour 1d4 dégâts contondants (portée 9/36 m)."] }
  ),
  weapon(
    "flail",
    { category: "martial", damage: "1d8", damageType: "bludgeoning", properties: [], mastery: "sap", weight: 2, cost: "10 gp" },
    { en: ["Flail", "A spiked ball on a chain dealing 1d8 bludgeoning damage."], fr: ["Fléau d'armes", "Une boule hérissée au bout d'une chaîne infligeant 1d8 dégâts contondants."] }
  ),
  weapon(
    "glaive",
    { category: "martial", damage: "1d10", damageType: "slashing", properties: ["heavy", "reach", "two-handed"], mastery: "graze", weight: 6, cost: "20 gp" },
    { en: ["Glaive", "A heavy polearm with reach dealing 1d10 slashing damage."], fr: ["Coutille", "Une lourde arme d'hast à allonge infligeant 1d10 dégâts tranchants."] }
  ),
  weapon(
    "halberd",
    { category: "martial", damage: "1d10", damageType: "slashing", properties: ["heavy", "reach", "two-handed"], mastery: "cleave", weight: 6, cost: "20 gp" },
    { en: ["Halberd", "A heavy axe-bladed polearm with reach dealing 1d10 slashing damage."], fr: ["Hallebarde", "Une lourde arme d'hast à lame de hache et à allonge infligeant 1d10 dégâts tranchants."] }
  ),
  weapon(
    "lance",
    { category: "martial", damage: "1d10", damageType: "piercing", properties: ["heavy", "reach", "two-handed"], mastery: "topple", weight: 6, cost: "10 gp" },
    { en: ["Lance", "A long cavalry spear with reach dealing 1d10 piercing damage (two-handed unless mounted)."], fr: ["Lance d'arçon", "Une longue lance de cavalerie à allonge infligeant 1d10 dégâts perforants (à deux mains sauf monté)."] }
  ),
  weapon(
    "pike",
    { category: "martial", damage: "1d10", damageType: "piercing", properties: ["heavy", "reach", "two-handed"], mastery: "push", weight: 18, cost: "5 gp" },
    { en: ["Pike", "A very long spear with reach dealing 1d10 piercing damage."], fr: ["Pique", "Une très longue lance à allonge infligeant 1d10 dégâts perforants."] }
  ),
  weapon(
    "whip",
    { category: "martial", damage: "1d4", damageType: "slashing", properties: ["finesse", "reach"], mastery: "slow", weight: 3, cost: "2 gp" },
    { en: ["Whip", "A finesse lash with reach dealing 1d4 slashing damage."], fr: ["Fouet", "Un fouet à allonge maniable en finesse infligeant 1d4 dégâts tranchants."] }
  ),
  weapon(
    "maul",
    { category: "martial", damage: "2d6", damageType: "bludgeoning", properties: ["heavy", "two-handed"], mastery: "topple", weight: 10, cost: "10 gp" },
    { en: ["Maul", "A heavy two-handed hammer dealing 2d6 bludgeoning damage."], fr: ["Maillet d'armes", "Un lourd marteau à deux mains infligeant 2d6 dégâts contondants."] }
  ),
  weapon(
    "morningstar",
    { category: "martial", damage: "1d8", damageType: "piercing", properties: [], mastery: "sap", weight: 4, cost: "15 gp" },
    { en: ["Morningstar", "A spiked mace dealing 1d8 piercing damage."], fr: ["Morgenstern", "Une masse hérissée de pointes infligeant 1d8 dégâts perforants."] }
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
    { lengthFt: 50, weight: 5, cost: "1 gp" },
    { en: ["Rope (50 feet)", "Fifty feet of rope; tying a knot takes a DC 10 Dexterity (Sleight of Hand) check and bursting it a DC 20 Strength (Athletics) check."], fr: ["Corde (15 mètres)", "Quinze mètres de corde ; faire un nœud exige un test de Dextérité (Escamotage) DD 10, la rompre un test de Force (Athlétisme) DD 20."] }
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
  damageVulnerabilities?: DamageType[];
  damageResistances?: DamageType[];
  damageImmunities?: DamageType[];
  conditionImmunities?: string[];
  /** Legendary Resistance uses per day (the lair bonus use is not modeled). */
  legendaryResistance?: number;
  /** `"srd-5.1"` for stat blocks taken from SRD 5.1 where SRD 5.2.1 has none. */
  source?: "srd-5.1";
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
      damageVulnerabilities: spec.damageVulnerabilities ?? [],
      damageResistances: spec.damageResistances ?? [],
      damageImmunities: spec.damageImmunities ?? [],
      conditionImmunities: spec.conditionImmunities ?? [],
      exhaustionLevel: 0,
      conditions: [],
      resources,
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: spec.actions,
      source: spec.source ?? "srd-5.2.1",
    },
    text
  );
}

const MONSTERS: CompendiumEntry[] = [
  monster(
    "rat",
    { cr: 0, hp: 1, hitDice: [1, 4], ac: 10, abilities: [2, 11, 9, 2, 10, 4], actions: [attack("bite", "Bite", 2, "1", "piercing")] },
    { en: ["Rat", "A tiny scavenger with keen smell, common in sewers and cellars."], fr: ["Rat", "Un minuscule charognard à l'odorat aiguisé, fréquent dans les égouts et les caves."] }
  ),
  monster(
    "commoner",
    { cr: 0, hp: 4, hitDice: [1, 8], ac: 10, abilities: [10, 10, 10, 10, 10, 10], actions: [attack("club", "Club", 2, "1d4", "bludgeoning")] },
    { en: ["Commoner", "Peasants, servants, pilgrims and townsfolk of every realm."], fr: ["Roturier", "Paysans, serviteurs, pèlerins et citadins de tous les royaumes."] }
  ),
  monster(
    "kobold",
    { cr: 0.125, hp: 7, hitDice: [3, 6], ac: 14, abilities: [7, 15, 9, 8, 7, 8], actions: [attack("dagger", "Dagger", 4, "1d4 + 2", "piercing", "20/60")] },
    { en: ["Kobold Warrior", "Small reptilian humanoids that fight in packs and set cunning traps."], fr: ["Guerrier kobold", "De petits humanoïdes reptiliens qui combattent en meute et posent des pièges retors."] }
  ),
  monster(
    "cultist",
    { cr: 0.125, hp: 9, hitDice: [2, 8], ac: 12, abilities: [11, 12, 10, 10, 11, 10], saves: ["wis"], actions: [attack("ritual_sickle", "Ritual Sickle", 3, "1d4 + 1", "slashing")] },
    { en: ["Cultist", "Zealots sworn to dark powers, often serving a sinister leader."], fr: ["Cultiste", "Des fanatiques voués à des puissances obscures, souvent au service d'un chef sinistre."] }
  ),
  monster(
    "zombie",
    { cr: 0.25, hp: 15, hitDice: [2, 8], ac: 8, abilities: [13, 6, 16, 3, 6, 5], saves: ["wis"], actions: [attack("slam", "Slam", 3, "1d8 + 1", "bludgeoning")], damageImmunities: ["poison"], conditionImmunities: ["exhaustion", "poisoned"] },
    { en: ["Zombie", "A shambling corpse animated by necromancy that refuses to stay down."], fr: ["Zombi", "Un cadavre titubant animé par la nécromancie, qui refuse de rester à terre."] }
  ),
  monster(
    "orc",
    { source: "srd-5.1", cr: 0.5, hp: 15, hitDice: [2, 8], ac: 13, abilities: [16, 12, 16, 7, 11, 10], actions: [attack("greataxe", "Greataxe", 5, "1d12 + 3", "slashing"), attack("javelin", "Javelin", 5, "1d6 + 3", "piercing", "30/120")] },
    { en: ["Orc", "Savage raiders who charge relentlessly at their foes."], fr: ["Orque", "Des pillards sauvages qui chargent leurs ennemis sans relâche."] }
  ),
  monster(
    "hobgoblin",
    { cr: 0.5, hp: 11, hitDice: [2, 8], ac: 18, abilities: [13, 12, 12, 10, 10, 9], actions: [attack("longsword", "Longsword", 3, "2d10 + 1", "slashing"), attack("longbow", "Longbow", 3, "1d8 + 1", "piercing", "150/600")] },
    { en: ["Hobgoblin Warrior", "Disciplined goblinoid soldiers who fight in tight formations."], fr: ["Guerrier hobgobelin", "Des soldats gobelinoïdes disciplinés qui combattent en formations serrées."] }
  ),
  monster(
    "gnoll",
    { cr: 0.5, hp: 27, hitDice: [6, 8], ac: 15, abilities: [14, 12, 11, 6, 10, 7], actions: [attack("rend", "Rend", 4, "1d6 + 2", "piercing"), attack("bone_bow", "Bone Bow", 3, "1d10 + 1", "piercing", "150/600")] },
    { en: ["Gnoll Warrior", "Hyena-headed marauders driven by an insatiable hunger."], fr: ["Guerrier gnoll", "Des maraudeurs à tête de hyène poussés par une faim insatiable."] }
  ),
  monster(
    "bugbear",
    { cr: 1, hp: 33, hitDice: [6, 8], ac: 14, abilities: [15, 14, 13, 8, 11, 9], actions: [attack("grab", "Grab", 4, "2d6 + 2", "bludgeoning")] },
    { en: ["Bugbear Warrior", "Hairy goblinoid brutes that strike from ambush."], fr: ["Guerrier gobelours", "Des brutes gobelinoïdes velues qui frappent en embuscade."] }
  ),
  monster(
    "ghoul",
    { cr: 1, hp: 22, hitDice: [5, 8], ac: 12, abilities: [13, 15, 10, 7, 10, 6], actions: [attack("bite", "Bite", 4, "1d6 + 2", "piercing"), attack("claw", "Claw", 4, "1d4 + 2", "slashing")], damageImmunities: ["poison"], conditionImmunities: ["charmed", "exhaustion", "poisoned"] },
    { en: ["Ghoul", "Flesh-eating undead whose claws paralyze the living."], fr: ["Goule", "Des morts-vivants nécrophages dont les griffes paralysent les vivants."] }
  ),
  monster(
    "dire_wolf",
    { cr: 1, hp: 22, hitDice: [3, 10], ac: 14, abilities: [17, 15, 15, 3, 12, 7], actions: [attack("bite", "Bite", 5, "1d10 + 3", "piercing")] },
    { en: ["Dire Wolf", "A massive wolf that hunts in packs and drags prey to the ground."], fr: ["Loup sanguinaire", "Un loup massif qui chasse en meute et renverse ses proies."] }
  ),
  monster(
    "giant_spider",
    { cr: 1, hp: 26, hitDice: [4, 10], ac: 14, abilities: [14, 16, 12, 2, 11, 4], actions: [attack("bite", "Bite", 5, "1d8 + 3", "piercing")] },
    { en: ["Giant Spider", "A venomous spider that webs its prey from the shadows."], fr: ["Araignée géante", "Une araignée venimeuse qui piège ses proies dans ses toiles depuis l'ombre."] }
  ),
  monster(
    "ghast",
    { cr: 2, hp: 36, hitDice: [8, 8], ac: 13, abilities: [16, 17, 10, 11, 10, 8], saves: ["wis"], actions: [attack("bite", "Bite", 5, "1d8 + 3", "piercing"), attack("claw", "Claw", 5, "2d6 + 3", "slashing")], damageResistances: ["necrotic"], damageImmunities: ["poison"], conditionImmunities: ["charmed", "exhaustion", "poisoned"] },
    { en: ["Ghast", "A ghoul leader surrounded by a nauseating stench."], fr: ["Blême", "Un chef de goules entouré d'une puanteur écœurante."] }
  ),
  monster(
    "gargoyle",
    { cr: 2, hp: 67, hitDice: [9, 8], ac: 15, abilities: [15, 11, 16, 6, 11, 7], actions: [attack("claw", "Claw", 4, "2d4 + 2", "slashing")], damageImmunities: ["poison"], conditionImmunities: ["exhaustion", "petrified", "poisoned"] },
    { en: ["Gargoyle", "A cruel elemental that poses as a statue until prey comes near."], fr: ["Gargouille", "Un élémentaire cruel qui se fait passer pour une statue jusqu'à l'arrivée d'une proie."] }
  ),
  monster(
    "owlbear",
    { cr: 3, hp: 59, hitDice: [7, 10], ac: 13, abilities: [20, 12, 17, 3, 12, 7], actions: [attack("rend", "Rend", 7, "2d8 + 5", "slashing")] },
    { en: ["Owlbear", "A monstrous cross of owl and bear, ferocious and territorial."], fr: ["Ours-hibou", "Un croisement monstrueux d'ours et de hibou, féroce et territorial."] }
  ),
  monster(
    "minotaur",
    { cr: 3, hp: 85, hitDice: [10, 10], ac: 14, abilities: [18, 11, 16, 6, 16, 9], actions: [attack("abyssal_glaive", "Abyssal Glaive", 6, "1d12 + 4", "slashing"), attack("gore", "Gore (Recharge 5-6)", 6, "4d6 + 4", "piercing")] },
    { en: ["Minotaur of Baphomet", "A bull-headed labyrinth hunter that charges with its horns."], fr: ["Minotaure de Baphomet", "Un chasseur de labyrinthe à tête de taureau qui charge cornes baissées."] }
  ),
  monster(
    "ghost",
    { cr: 4, hp: 45, hitDice: [10, 8], ac: 11, abilities: [7, 13, 10, 10, 12, 17], actions: [attack("withering_touch", "Withering Touch", 5, "3d10 + 3", "necrotic")], damageResistances: ["acid", "bludgeoning", "cold", "fire", "lightning", "piercing", "slashing", "thunder"], damageImmunities: ["necrotic", "poison"], conditionImmunities: ["charmed", "exhaustion", "frightened", "grappled", "paralyzed", "petrified", "poisoned", "prone", "restrained"] },
    { en: ["Ghost", "The restless soul of a once-living creature, bound to a place or unfinished task."], fr: ["Fantôme", "L'âme tourmentée d'une créature autrefois vivante, liée à un lieu ou à une tâche inachevée."] }
  ),
  monster(
    "troll",
    { cr: 5, hp: 94, hitDice: [9, 10], ac: 15, abilities: [18, 13, 20, 7, 9, 7], actions: [attack("rend", "Rend", 7, "2d6 + 4", "slashing")] },
    { en: ["Troll", "A ravenous giant that regenerates unless burned with fire or acid."], fr: ["Troll", "Un géant vorace qui se régénère à moins d'être brûlé par le feu ou l'acide."] }
  ),
  monster(
    "hill_giant",
    { cr: 5, hp: 105, hitDice: [10, 12], ac: 13, abilities: [21, 8, 19, 5, 9, 6], actions: [attack("tree_club", "Tree Club", 8, "3d8 + 5", "bludgeoning"), attack("trash_lob", "Trash Lob", 8, "2d10 + 5", "bludgeoning", "60/240")] },
    { en: ["Hill Giant", "A dim-witted, gluttonous giant that hurls refuse and boulders."], fr: ["Géant des collines", "Un géant glouton et peu futé qui lance détritus et rochers."] }
  ),
  monster(
    "medusa",
    { cr: 6, hp: 127, hitDice: [17, 8], ac: 15, abilities: [10, 17, 16, 12, 13, 15], saves: ["wis"], actions: [attack("claw", "Claw", 6, "2d6 + 3", "slashing"), attack("snake_hair", "Snake Hair", 6, "1d4 + 3", "piercing")] },
    { en: ["Medusa", "A cursed creature with serpent hair whose gaze turns flesh to stone."], fr: ["Méduse", "Une créature maudite à chevelure de serpents dont le regard change la chair en pierre."] }
  ),
  monster(
    "wyvern",
    { cr: 6, hp: 127, hitDice: [15, 10], ac: 14, abilities: [19, 10, 16, 5, 12, 6], actions: [attack("bite", "Bite", 7, "2d8 + 4", "piercing"), attack("sting", "Sting", 7, "2d6 + 4", "piercing")] },
    { en: ["Wyvern", "A two-legged dragon cousin with a venomous tail stinger."], fr: ["Vouivre", "Un cousin des dragons à deux pattes doté d'un dard venimeux."] }
  ),
  monster(
    "stone_giant",
    { cr: 7, hp: 126, hitDice: [11, 12], ac: 17, abilities: [23, 15, 20, 10, 12, 9], saves: ["dex", "con", "wis"], actions: [attack("stone_club", "Stone Club", 9, "3d10 + 6", "bludgeoning"), attack("boulder", "Boulder", 9, "2d8 + 6", "bludgeoning", "60/240")] },
    { en: ["Stone Giant", "A reclusive, artistic giant of deep caverns who hurls boulders."], fr: ["Géant des pierres", "Un géant reclus et artiste des cavernes profondes qui lance des rochers."] }
  ),
  monster(
    "young_green_dragon",
    { cr: 8, hp: 136, hitDice: [16, 10], ac: 18, abilities: [19, 12, 17, 16, 13, 15], saves: ["dex", "wis"], actions: [attack("rend", "Rend", 7, "2d6 + 4", "slashing"), saveAction("poison_breath", "Poison Breath (Recharge 5-6)", "12d6", "poison", "con", 14)], damageImmunities: ["poison"], conditionImmunities: ["poisoned"] },
    { en: ["Young Green Dragon", "A deceitful forest dragon that breathes clouds of poison."], fr: ["Jeune dragon vert", "Un dragon des forêts fourbe qui souffle des nuages de poison."] }
  ),
  monster(
    "fire_giant",
    { cr: 9, hp: 162, hitDice: [13, 12], ac: 18, abilities: [25, 9, 23, 10, 14, 13], saves: ["dex", "con", "cha"], actions: [attack("flame_sword", "Flame Sword", 11, "4d6 + 7", "slashing"), attack("hammer_throw", "Hammer Throw", 11, "3d10 + 7", "bludgeoning", "60/240")], damageImmunities: ["fire"] },
    { en: ["Fire Giant", "A master smith and warrior of volcanic fortresses."], fr: ["Géant du feu", "Un maître forgeron et guerrier des forteresses volcaniques."] }
  ),
  monster(
    "young_red_dragon",
    { cr: 10, hp: 178, hitDice: [17, 10], ac: 18, abilities: [23, 10, 21, 14, 11, 19], saves: ["dex", "wis"], actions: [attack("rend", "Rend", 10, "2d6 + 6", "slashing"), saveAction("fire_breath", "Fire Breath (Recharge 5-6)", "16d6", "fire", "dex", 17)], damageImmunities: ["fire"] },
    { en: ["Young Red Dragon", "An arrogant young dragon whose breath is a cone of fire."], fr: ["Jeune dragon rouge", "Un jeune dragon arrogant dont le souffle est un cône de feu."] }
  ),
  monster(
    "behir",
    { cr: 11, hp: 168, hitDice: [16, 12], ac: 17, abilities: [23, 16, 18, 7, 14, 12], actions: [attack("bite", "Bite", 10, "2d12 + 6", "piercing"), saveAction("lightning_breath", "Lightning Breath (Recharge 5-6)", "12d10", "lightning", "dex", 16)], damageImmunities: ["lightning"] },
    { en: ["Behir", "A serpentine many-legged predator that spits lightning and swallows prey."], fr: ["Béhir", "Un prédateur serpentiforme à nombreuses pattes qui crache la foudre et avale ses proies."] }
  ),
  monster(
    "archmage",
    { cr: 12, hp: 170, hitDice: [31, 8], ac: 17, abilities: [10, 14, 12, 20, 15, 16], saves: ["int", "wis"], actions: [attack("arcane_burst", "Arcane Burst", 9, "4d10 + 5", "force", "150")], damageImmunities: ["psychic"] },
    { en: ["Archmage", "A powerful wizard who commands spells up to the 9th level."], fr: ["Archimage", "Un puissant magicien qui maîtrise des sorts jusqu'au niveau 9."] }
  ),
  monster(
    "vampire",
    { cr: 13, hp: 195, hitDice: [23, 8], ac: 16, abilities: [18, 18, 18, 17, 15, 18], saves: ["dex", "con", "wis", "cha"], actions: [attack("grave_strike", "Grave Strike", 9, "1d8 + 4", "bludgeoning"), saveAction("bite", "Bite", "1d4 + 4", "piercing", "con", 17)], damageResistances: ["necrotic"], legendaryResistance: 3 },
    { en: ["Vampire", "An undead noble who drinks the blood of the living."], fr: ["Vampire", "Un noble mort-vivant qui boit le sang des vivants."] }
  ),
  monster(
    "adult_black_dragon",
    { cr: 14, hp: 195, hitDice: [17, 12], ac: 19, abilities: [23, 14, 21, 14, 13, 19], saves: ["dex", "wis"], actions: [attack("rend", "Rend", 11, "2d6 + 6", "slashing"), saveAction("acid_breath", "Acid Breath (Recharge 5-6)", "12d8", "acid", "dex", 18)], damageImmunities: ["acid"], legendaryResistance: 3 },
    { en: ["Adult Black Dragon", "A cruel swamp dragon whose breath is a line of acid."], fr: ["Dragon noir adulte", "Un cruel dragon des marais dont le souffle est une ligne d'acide."] }
  ),
  monster(
    "mummy_lord",
    { cr: 15, hp: 187, hitDice: [25, 8], ac: 17, abilities: [18, 10, 17, 11, 19, 16], saves: ["int", "wis"], actions: [attack("rotting_fist", "Rotting Fist", 9, "2d10 + 4", "bludgeoning"), attack("channel_negative_energy", "Channel Negative Energy", 9, "6d6 + 4", "necrotic", "60")], damageVulnerabilities: ["fire"], damageImmunities: ["necrotic", "poison"], conditionImmunities: ["charmed", "exhaustion", "frightened", "paralyzed", "poisoned"], legendaryResistance: 3 },
    { en: ["Mummy Lord", "An undead priest-king who spreads a withering curse."], fr: ["Seigneur momie", "Un prêtre-roi mort-vivant qui répand une malédiction desséchante."] }
  ),
  monster(
    "iron_golem",
    { cr: 16, hp: 252, hitDice: [24, 10], ac: 20, abilities: [24, 9, 20, 3, 11, 1], actions: [attack("bladed_arm", "Bladed Arm", 12, "3d8 + 7", "slashing"), attack("fiery_bolt", "Fiery Bolt", 10, "8d8", "fire", "120"), saveAction("poison_breath", "Poison Breath (Recharge 6)", "10d10", "poison", "con", 18)], damageImmunities: ["fire", "poison", "psychic"], conditionImmunities: ["charmed", "exhaustion", "frightened", "paralyzed", "petrified", "poisoned"] },
    { en: ["Iron Golem", "A towering iron construct that heals when exposed to fire."], fr: ["Golem de fer", "Une imposante créature artificielle de fer que le feu guérit."] }
  ),
  monster(
    "balor",
    { cr: 19, hp: 287, hitDice: [23, 12], ac: 19, abilities: [26, 15, 22, 20, 16, 22], saves: ["con", "wis"], actions: [attack("flame_whip", "Flame Whip", 14, "3d6 + 8", "force"), attack("lightning_blade", "Lightning Blade", 14, "3d8 + 8", "force")], damageResistances: ["cold", "lightning"], damageImmunities: ["fire", "poison"], conditionImmunities: ["charmed", "frightened", "poisoned"], legendaryResistance: 3 },
    { en: ["Balor", "A towering demon of flame and shadow wielding a lightning blade and a flaming whip."], fr: ["Balor", "Un démon colossal de flammes et d'ombre armé d'une lame de foudre et d'un fouet ardent."] }
  ),
  monster(
    "pit_fiend",
    { cr: 20, hp: 337, hitDice: [27, 10], ac: 21, abilities: [26, 14, 24, 22, 18, 24], saves: ["dex", "wis"], actions: [attack("bite", "Bite", 14, "3d6 + 8", "piercing"), attack("devilish_claw", "Devilish Claw", 14, "4d8 + 8", "necrotic"), attack("fiery_mace", "Fiery Mace", 14, "4d6 + 8", "force")], damageResistances: ["cold"], damageImmunities: ["fire", "poison"], conditionImmunities: ["poisoned"], legendaryResistance: 4 },
    { en: ["Pit Fiend", "A general of the Nine Hells with a venomous bite and a fearsome aura."], fr: ["Diantrefosse", "Un général des Neuf Enfers à la morsure venimeuse et à l'aura terrifiante."] }
  ),
];

/** Curated SRD 5.2.1 entries merged into `SYSTEM_SRD` by `compendium.ts`. */
export const SRD_CURATED_CONTENT: readonly CompendiumEntry[] = [
  ...CLASSES,
  ...SPECIES,
  ...BACKGROUND_ENTRIES,
  ...FEATS,
  ...CONDITIONS,
  ...SPELLS,
  ...ITEMS,
  ...MONSTERS,
];
